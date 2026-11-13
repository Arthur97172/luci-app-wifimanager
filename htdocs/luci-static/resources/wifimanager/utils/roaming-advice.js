'use strict';
'require baseclass';

/*
 * Advisory analysis of the roaming configuration.
 *
 * The backend (roaming.sh, roaming_advice_json) reports the configured
 * thresholds and the signal of every currently associated station.  The rules
 * below only produce findings; nothing here changes a threshold.  A snapshot
 * of the stations connected at one moment cannot replace a roaming trace, so
 * the wording always names the sample size.
 */

const BANDS = [ '2g', '5g', '6g' ];

function finiteNumber(value) {
	const n = Number(value);

	return Number.isFinite(n) ? n : null;
}

function clamp(value, lo, hi) {
	return Math.max(lo, Math.min(hi, value));
}

function round5(value) {
	return Math.round(value / 5) * 5;
}

function normalizeSignals(signals) {
	const out = [];

	for (const value of signals || []) {
		const n = finiteNumber(value);

		// A signal outside the range hostapd reports is not a measurement the
		// recommendation can use; it is dropped instead of clamped.
		if (n != null && n <= 0 && n >= -100)
			out.push(n);
	}

	return out.sort(function(a, b) { return a - b; });
}

function percentile(sorted, fraction) {
	if (!sorted.length)
		return null;

	const rank = Math.ceil(fraction * sorted.length) - 1;

	return sorted[clamp(rank, 0, sorted.length - 1)];
}

function stats(signals) {
	const sorted = normalizeSignals(signals);
	const count = sorted.length;

	if (count === 0)
		return { count: 0, median: null, p10: null, weakest: null };

	return {
		count: count,
		median: percentile(sorted, 0.5),
		p10: percentile(sorted, 0.1),
		weakest: sorted[0]
	};
}

function thresholdOf(thresholds, kind, band) {
	const perBand = thresholds[kind + '_' + band];

	if (perBand != null && Number.isFinite(Number(perBand)))
		return Number(perBand);

	if (thresholds[kind] != null && Number.isFinite(Number(thresholds[kind])))
		return Number(thresholds[kind]);

	return null;
}

function unique(values) {
	const seen = [];

	for (const value of values) {
		if (seen.indexOf(value) === -1)
			seen.push(value);
	}

	return seen;
}

// Only sections the roaming engine manages are checked for consistency; an
// AP outside wifi_ap_* may deliberately be left untouched by this package.
function managedInterfaces(interfaces) {
	return (interfaces || []).filter(function(entry) {
		return entry && /^wifi_ap_/.test(String(entry.section || ''));
	});
}

function normalizeMac(value) {
	return String(value == null ? '' : value).trim().toLowerCase();
}

// A BSSID a neighbor report can carry is a unicast, non-zero MAC address.
function validBssid(value) {
	const mac = normalizeMac(value);

	if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac))
		return false;
	if (mac === '00:00:00:00:00:00')
		return false;
	if (parseInt(mac.slice(0, 2), 16) & 1)
		return false;

	return true;
}

// APs of the same SSID must agree on everything a fast transition depends on.
// key_group is an opaque index assigned by the backend, so equal keys compare
// equal without the key ever leaving the router.
function authSignature(entry) {
	const pmf = String(entry.ieee80211w == null ? '' : entry.ieee80211w).trim();

	return [
		String(entry.encryption || '').trim().toLowerCase(),
		pmf === '' ? '0' : pmf,
		String(entry.auth_server || '').trim(),
		String(entry.auth_port || '').trim(),
		String(entry.key_file || '').trim(),
		entry.key_group == null || entry.key_group === '' ? '' : String(entry.key_group)
	].join('|');
}

function advise(reply) {
	const caps = (reply && reply.capabilities) || {};
	const interfaces = managedInterfaces(reply && reply.interfaces);
	const thresholds = (reply && reply.thresholds) || {};
	const findings = [];

	function add(level, code, values) {
		findings.push({ level: level, code: code, values: values || {} });
	}

	if (caps.kvr && !caps.wnm)
		add('warn', 'W-ROAM-01');
	if (caps.kvr && !caps.dawn)
		add('warn', 'W-ROAM-02');
	if (caps.kvr && caps.dawn_managed && !caps.dawn_running)
		add('warn', 'W-ROAM-03');
	if (Number(caps.dawn_watchdog_failures) > 0)
		add('error', 'E-ROAM-01', { failures: Number(caps.dawn_watchdog_failures) });

	const globalGood = thresholdOf(thresholds, 'good');
	const globalBad = thresholdOf(thresholds, 'bad');

	if (globalGood != null && globalBad != null && globalBad >= globalGood)
		add('error', 'E-ROAM-02', { band: '', good: globalGood, bad: globalBad });

	for (const band of BANDS) {
		const good = thresholdOf(thresholds, 'good', band);
		const bad = thresholdOf(thresholds, 'bad', band);

		if (good != null && bad != null && bad >= good)
			add('error', 'E-ROAM-02', { band: band, good: good, bad: bad });
	}

	if (caps.ft) {
		const domains = unique(interfaces.map(function(entry) {
			return String(entry.mobility_domain || '').trim();
		}).filter(function(value) { return value; }));

		if (domains.length > 1)
			add('error', 'E-ROAM-03', { domains: domains });
		else if (interfaces.length && interfaces.some(function(entry) {
			return !String(entry.mobility_domain || '').trim();
		}))
			add('warn', 'W-ROAM-04');

		if (interfaces.length && interfaces.some(function(entry) { return !entry.r; }))
			add('warn', 'W-ROAM-05');
	}

	if (caps.kvr) {
		if (interfaces.length && interfaces.some(function(entry) { return !entry.k; }))
			add('warn', 'W-ROAM-06');
		if (caps.wnm && interfaces.length && interfaces.some(function(entry) { return !entry.v; }))
			add('warn', 'W-ROAM-07');

		// 802.11k neighbor reports are built from BSSIDs.  A multicast or
		// all-zero address cannot identify an AP, and a BSSID shared by two
		// APs makes the report ambiguous.
		const byBssid = {};

		for (const entry of interfaces) {
			const bssid = normalizeMac(entry.bssid);

			if (!bssid)
				continue;
			if (!validBssid(bssid)) {
				add('error', 'E-ROAM-04', {
					section: String(entry.section || '?'),
					bssid: bssid
				});
				continue;
			}

			(byBssid[bssid] = byBssid[bssid] || []).push(String(entry.section || '?'));
		}

		for (const bssid of Object.keys(byBssid)) {
			if (byBssid[bssid].length > 1)
				add('error', 'E-ROAM-05', { bssid: bssid, sections: byBssid[bssid].join(', ') });
		}
	}

	if (caps.ft) {
		// APs that share an SSID form one fast-transition group.  A different
		// encryption, PMF mode, RADIUS server or key breaks the transition
		// between them even when the mobility domain matches.
		const bySsid = {};

		for (const entry of interfaces) {
			if (!entry.r)
				continue;
			const ssid = String(entry.ssid || '');
			(bySsid[ssid] = bySsid[ssid] || []).push(entry);
		}

		for (const ssid of Object.keys(bySsid)) {
			const group = bySsid[ssid];

			if (group.length < 2)
				continue;
			if (unique(group.map(authSignature)).length > 1)
				add('error', 'E-ROAM-06', {
					ssid: ssid || '?',
					sections: group.map(function(entry) {
						return String(entry.section || '?');
					}).join(', ')
				});
		}
	}

	const bandStats = [];
	let totalClients = 0;
	let busiestBand = 0;

	for (const entry of (reply && reply.bands) || []) {
		const band = entry && entry.band;
		const sample = stats(entry && entry.signals);

		if (!sample.count)
			continue;

		totalClients += sample.count;
		busiestBand = Math.max(busiestBand, sample.count);

		const currentGood = thresholdOf(thresholds, 'good', band);
		const currentBad = thresholdOf(thresholds, 'bad', band);
		const item = {
			band: band,
			clients: sample.count,
			median: sample.median,
			p10: sample.p10,
			weakest: sample.weakest,
			currentGood: currentGood,
			currentBad: currentBad,
			suggestedGood: null,
			suggestedBad: null
		};

		if (sample.count < 5) {
			add('info', 'I-ROAM-01', { band: band, clients: sample.count });
		}
		else {
			// The median client should count as well connected, and the
			// weakest decile should become a steering candidate.  A 10 dB gap
			// keeps the two thresholds from crossing.
			let suggestedGood = clamp(round5(sample.median), -90, -20);
			let suggestedBad = clamp(round5(sample.p10 - 5), -95, -20);

			if (suggestedBad >= suggestedGood - 10)
				suggestedBad = suggestedGood - 10;
			suggestedBad = Math.max(-100, suggestedBad);

			item.suggestedGood = suggestedGood;
			item.suggestedBad = suggestedBad;

			if (currentGood != null && currentBad != null &&
				(Math.abs(currentGood - suggestedGood) >= 10 ||
				 Math.abs(currentBad - suggestedBad) >= 10))
				add('info', 'I-ROAM-02', {
					band: band,
					clients: sample.count,
					median: sample.median,
					good: currentGood,
					bad: currentBad,
					suggested_good: suggestedGood,
					suggested_bad: suggestedBad
				});
		}

		bandStats.push(item);
	}

	const dawn = caps.dawn_params || {};
	const minClients = finiteNumber(dawn.min_clients);

	if (caps.kvr && caps.dawn && minClients != null && busiestBand > 0 &&
		minClients > busiestBand)
		add('info', 'I-ROAM-03', { min_clients: minClients, clients: busiestBand });

	const order = { 'error': 0, 'warn': 1, 'info': 2 };

	findings.sort(function(a, b) { return order[a.level] - order[b.level]; });

	return {
		findings: findings,
		bands: bandStats,
		totalClients: totalClients,
		managedInterfaces: interfaces.length,
		suggestions: bandStats.filter(function(item) {
			return item.suggestedGood != null;
		})
	};
}

function levelName(level) {
	return level === 'error' ? _('Error') :
		(level === 'warn' ? _('Warning') : _('Information'));
}

function adviceText(finding) {
	const values = (finding && finding.values) || {};

	function bandName(band) {
		return band === '2g' ? _('2.4 GHz') : (band === '5g' ? _('5 GHz') :
			(band === '6g' ? _('6 GHz') : _('unknown band')));
	}

	switch (finding && finding.code) {
	case 'W-ROAM-01':
		return _('This wpad build does not support 802.11v, so an access point cannot send a BSS transition request. The thresholds below then only affect the DAWN metrics.');
	case 'W-ROAM-02':
		return _('Client steering is enabled but DAWN is not installed. 802.11k and 802.11r still work, but no service steers clients.');
	case 'W-ROAM-03':
		return _('DAWN is managed by WiFi Manager but is not running. The watchdog restarts it at most once every five minutes.');
	case 'E-ROAM-01':
		return _('The DAWN watchdog failed %d time(s) in a row. Check the DAWN configuration and the system log.')
			.format(values.failures || 0);
	case 'E-ROAM-02':
		return _('The bad threshold is not lower than the good threshold in the %s band. DAWN would treat every client as both well and badly connected.')
			.format(values.band ? bandName(values.band) : _('global'));
	case 'E-ROAM-03':
		return _('The managed access points use different mobility domains (%s). Fast transition only works between APs with the same domain.')
			.format((values.domains || []).join(', '));
	case 'E-ROAM-04':
		return _('The BSSID %s of access point %s is not a valid unicast MAC address. A neighbor report built from it is invalid, so 802.11k cannot help clients find that AP.')
			.format(values.bssid || '?', values.section || '?');
	case 'E-ROAM-05':
		return _('The access points %s share the BSSID %s. A neighbor report cannot tell them apart; give each radio a unique MAC address.')
			.format(values.sections || '?', values.bssid || '?');
	case 'E-ROAM-06':
		return _('802.11r is enabled, but the access points of SSID %s do not share the same authentication configuration (%s). Fast transition fails between APs with different encryption, PMF or keys.')
			.format(values.ssid || '?', values.sections || '?');
	case 'W-ROAM-04':
		return _('802.11r is enabled but at least one managed access point has no mobility domain.');
	case 'W-ROAM-05':
		return _('802.11r is enabled but at least one managed access point does not carry the 802.11r option. Applying the roaming settings rewrites the managed APs.');
	case 'W-ROAM-06':
		return _('802.11k is enabled but at least one managed access point does not carry the 802.11k option. Applying the roaming settings rewrites the managed APs.');
	case 'W-ROAM-07':
		return _('At least one managed access point does not send 802.11v transition requests even though wpad supports them.');
	case 'I-ROAM-01':
		return _('Only %d client(s) are associated in the %s band; a threshold recommendation needs at least five.')
			.format(values.clients || 0, bandName(values.band));
	case 'I-ROAM-02':
		return _('In the %s band, %d client(s) report a median of %d dBm. The current thresholds (good %d dBm, bad %d dBm) differ from the suggested values (good %d dBm, bad %d dBm) by 10 dB or more.')
			.format(bandName(values.band), values.clients || 0, values.median != null ? values.median : 0,
				values.good, values.bad, values.suggested_good, values.suggested_bad);
	case 'I-ROAM-03':
		return _('DAWN starts steering only with at least %d clients per access point, but the busiest access point currently has %d. Steering cannot start until more clients join.')
			.format(values.min_clients || 0, values.clients || 0);
	default:
		return _('No additional information.');
	}
}

return baseclass.extend({
	advise: advise,
	stats: stats,
	thresholdOf: thresholdOf,
	validBssid: validBssid,
	levelName: levelName,
	adviceText: adviceText
});
