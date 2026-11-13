'use strict';
'require baseclass';

/*
 * Analysis of a neighbouring access point scan (DESIGN §8.1).
 *
 * The backend runs the scan and reports the BSSIDs, SSIDs, channels, signals
 * and a security class for each.  This module only classifies what was seen:
 * it marks our own APs, compares foreign APs that use one of our SSIDs with
 * the configured security, and reports duplicate BSSIDs.  A scan is a
 * snapshot of one moment and never changes any configuration.
 */

const FAMILIES = {
	'open': [ 'open' ],
	'wep': [ 'wep' ],
	'wpa': [ 'wpa' ],
	'wpa/wpa2': [ 'wpa', 'wpa2' ],
	'wpa2': [ 'wpa2' ],
	'wpa2/wpa3': [ 'wpa2', 'wpa3' ],
	'wpa3': [ 'wpa3' ],
	'owe': [ 'owe' ],
	'enterprise': [ 'enterprise' ],
	'other': [ 'other' ]
};

function normalizeMac(value) {
	return String(value == null ? '' : value).trim().toLowerCase();
}

/*
 * UCI encryption values: psk* is personal WPA, wpa* is enterprise, sae is
 * WPA3 personal, owe is enhanced open.  A '+ccmp' style suffix only names the
 * cipher, so the base value decides the class.
 */
function securityOfUci(encryption) {
	const base = String(encryption == null ? '' : encryption)
		.trim().toLowerCase().split('+')[0].replace(/_/g, '-');

	switch (base) {
	case '':
	case 'none':
	case 'open':
		return 'open';
	case 'wep':
	case 'wep-open':
	case 'wep-shared':
		return 'wep';
	case 'psk':
		return 'wpa';
	case 'psk2':
		return 'wpa2';
	case 'psk-mixed':
		return 'wpa/wpa2';
	case 'sae':
		return 'wpa3';
	case 'sae-mixed':
		return 'wpa2/wpa3';
	case 'owe':
		return 'owe';
	case 'wpa':
	case 'wpa2':
	case 'wpa-mixed':
	case 'wpa3':
	case 'wpa3-mixed':
		return 'enterprise';
	default:
		return 'other';
	}
}

function securityOfInterface(entry) {
	if (entry && String(entry.auth_server || '').trim())
		return 'enterprise';

	return securityOfUci(entry && entry.encryption);
}

function securityFamily(cls) {
	return FAMILIES[cls] || [ String(cls || 'other') ];
}

// Two security classes match when they share a family: "wpa2/wpa3" matches
// both "wpa2" and "wpa3", but "wpa2" and "wpa3" do not match each other.
function securityMatches(a, b) {
	const left = securityFamily(a);
	const right = securityFamily(b);

	return left.some(function(value) { return right.indexOf(value) !== -1; });
}

function securityName(cls) {
	switch (cls) {
	case 'open':
		return _('Open');
	case 'wep':
		return _('WEP');
	case 'wpa':
		return _('WPA');
	case 'wpa/wpa2':
		return _('WPA/WPA2');
	case 'wpa2':
		return _('WPA2');
	case 'wpa2/wpa3':
		return _('WPA2/WPA3');
	case 'wpa3':
		return _('WPA3');
	case 'owe':
		return _('OWE');
	case 'enterprise':
		return _('WPA-Enterprise');
	default:
		return _('Unknown');
	}
}

function unique(values) {
	const out = [];

	for (const value of values || []) {
		if (value != null && out.indexOf(value) === -1)
			out.push(value);
	}

	return out;
}

function numeric(value) {
	const n = Number(value);

	return Number.isFinite(n) && value !== '' && value != null ? n : null;
}

function stateName(row) {
	if (row.self)
		return _('Yours');
	if (row.knownSsid === false)
		return _('Other network');
	if (row.securityMatches === false)
		return _('Same SSID, different security');

	return _('Same SSID');
}

function analyse(scans, interfaces) {
	const managed = (interfaces || []).filter(function(entry) {
		return entry && normalizeMac(entry.bssid);
	});
	const selfBssids = {};
	const ssidSecurity = {};

	for (const entry of managed) {
		const mac = normalizeMac(entry.bssid);
		selfBssids[mac] = String(entry.section || '');
		const ssid = String(entry.ssid || '');
		if (ssid)
			(ssidSecurity[ssid] = ssidSecurity[ssid] || []).push(securityOfInterface(entry));
	}

	const rows = [];
	const byBssid = {};
	const failed = [];
	let scanned = 0;

	for (const scan of scans || []) {
		if (!scan || scan.ok === false || !Array.isArray(scan.access_points)) {
			if (scan && scan.radio)
				failed.push({
					radio: scan.radio,
					message: scan.message || scan.error || _('The scan failed.')
				});
			continue;
		}

		scanned++;

		for (const ap of scan.access_points) {
			const mac = normalizeMac(ap && ap.bssid);

			if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac))
				continue;

			const ssid = String((ap && ap.ssid) || '');
			const row = {
				bssid: mac,
				ssid: ssid,
				band: (ap && ap.band) || scan.band || '',
				channel: numeric(ap && ap.channel),
				frequency: numeric(ap && ap.freq),
				signal: numeric(ap && ap.signal),
				security: String((ap && ap.security) || 'other'),
				radio: scan.radio || '',
				self: !!selfBssids[mac],
				secSection: selfBssids[mac] || '',
				ssids: ssid ? [ ssid ] : []
			};

			if (byBssid[mac]) {
				const seen = byBssid[mac];

				if (ssid && seen.ssids.indexOf(ssid) === -1)
					seen.ssids.push(ssid);
				// Keep the strongest observation, but the SSID list is kept
				// from every sighting so a conflicting advertisement shows.
				if (row.signal != null && (seen.signal == null || row.signal > seen.signal)) {
					seen.signal = row.signal;
					seen.radio = row.radio;
					seen.band = row.band || seen.band;
					seen.channel = row.channel != null ? row.channel : seen.channel;
					seen.frequency = row.frequency != null ? row.frequency : seen.frequency;
				}
				continue;
			}

			byBssid[mac] = row;
			rows.push(row);
		}
	}

	const foreignSameSsid = [];

	for (const row of rows) {
		const expected = ssidSecurity[row.ssid];

		row.knownSsid = !!expected;
		row.securityMatches = expected
			? expected.some(function(cls) { return securityMatches(cls, row.security); })
			: null;

		if (!row.self && row.knownSsid)
			foreignSameSsid.push(row);
	}

	const findings = [];

	function add(level, code, values) {
		findings.push({ level: level, code: code, values: values || {} });
	}

	// An AP that broadcasts one of our SSIDs with a different security class
	// cannot take part in the same fast-transition group, even when a client
	// is willing to connect to it.
	const mismatched = {};

	for (const row of foreignSameSsid) {
		if (row.securityMatches !== false)
			continue;
		(mismatched[row.ssid] = mismatched[row.ssid] || []).push(row);
	}

	for (const ssid of Object.keys(mismatched)) {
		add('warn', 'W-ROAM-08', {
			ssid: ssid,
			found: unique(mismatched[ssid].map(function(row) { return row.security; })),
			expected: unique(ssidSecurity[ssid] || [])
		});
	}

	if (foreignSameSsid.length) {
		add('info', 'I-ROAM-04', {
			count: foreignSameSsid.length,
			ssids: unique(foreignSameSsid.map(function(row) { return row.ssid; })),
			strongest: foreignSameSsid.reduce(function(best, row) {
				return row.signal != null && (best == null || row.signal > best) ? row.signal : best;
			}, null)
		});
	}

	for (const row of rows) {
		const distinct = unique(row.ssids);

		if (distinct.length > 1)
			add('info', 'I-ROAM-05', { bssid: row.bssid, ssids: distinct });
	}

	const order = { 'error': 0, 'warn': 1, 'info': 2 };

	findings.sort(function(a, b) { return order[a.level] - order[b.level]; });

	// Ours first, then APs of our SSIDs, then the rest; within a group the
	// strongest signal leads, which is the one a client is most likely to see.
	const stateRank = function(row) {
		if (row.self)
			return 0;
		if (row.knownSsid)
			return 1;
		return 2;
	};

	rows.sort(function(a, b) {
		const rank = stateRank(a) - stateRank(b);

		if (rank !== 0)
			return rank;

		return (b.signal == null ? -999 : b.signal) - (a.signal == null ? -999 : a.signal);
	});

	return {
		rows: rows,
		findings: findings,
		scanned: scanned,
		failed: failed,
		hasData: rows.length > 0,
		selfCount: rows.filter(function(row) { return row.self; }).length,
		foreignSameSsid: foreignSameSsid.length
	};
}

function levelName(level) {
	return level === 'error' ? _('Error') :
		(level === 'warn' ? _('Warning') : _('Information'));
}

function findingText(finding) {
	const values = (finding && finding.values) || {};

	switch (finding && finding.code) {
	case 'I-ROAM-04':
		return _('%d neighbouring access point(s) broadcast %s, which this router also uses. Check whether they belong to your network; a client may otherwise connect to a foreign AP and lose this network.')
			.format(values.count || 0, (values.ssids || []).join(', ') || '?');
	case 'W-ROAM-08':
		return _('A neighbouring access point of SSID %s uses %s, while your access points use %s. A client cannot roam between them with the same security settings.')
			.format(values.ssid || '?',
				(values.found || []).map(securityName).join(', ') || _('unknown security'),
				(values.expected || []).map(securityName).join(', ') || _('unknown security'));
	case 'I-ROAM-05':
		return _('The BSSID %s was seen with different SSIDs in one scan (%s). Verify that this is not a spoofed or misconfigured access point.')
			.format(values.bssid || '?', (values.ssids || []).join(', ') || '?');
	default:
		return _('No additional information.');
	}
}

return baseclass.extend({
	normalizeMac: normalizeMac,
	securityOfUci: securityOfUci,
	securityOfInterface: securityOfInterface,
	securityMatches: securityMatches,
	securityName: securityName,
	stateName: stateName,
	analyse: analyse,
	levelName: levelName,
	findingText: findingText
});
