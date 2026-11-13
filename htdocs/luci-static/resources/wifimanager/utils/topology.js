'use strict';
'require baseclass';

/*
 * Topology health analysis.
 *
 * The mesh view already draws the graph and compares the announced mesh
 * parameters.  This module looks at the runtime side of the same rows: how
 * long ago a device announced itself, how much memory it reports, whether its
 * wireless backhaul is still usable and whether the announcement is complete.
 * It only classifies what the backend reported; it never contacts a device.
 */

const STALE_WARN_SECONDS = 30;
const STALE_ERROR_SECONDS = 120;
const OFFLINE_SECONDS = STALE_ERROR_SECONDS;
const MEMORY_WARN_PERCENT = 85;
const MEMORY_ERROR_PERCENT = 95;
const WEAK_BACKHAUL_DBM = -75;

function parseSeconds(value) {
	const match = /^(-?\d+(?:\.\d+)?)\s*s?$/.exec(String(value == null ? '' : value).trim());

	return match ? Number(match[1]) : null;
}

function parseSignal(value) {
	const match = /^(-?\d+(?:\.\d+)?)/.exec(String(value == null ? '' : value).trim());

	if (!match)
		return null;

	const n = Number(match[1]);

	return Number.isFinite(n) && n <= 0 && n >= -120 ? n : null;
}

function macKey(value) {
	const hex = String(value == null ? '' : value).toLowerCase().replace(/[^0-9a-f]/g, '');

	return hex.length === 12 ? hex : '';
}

function colonMac(mac) {
	return /^[0-9a-f]{12}$/.test(mac) ? mac.match(/../g).join(':') : mac;
}

// Same identity order as mesh.deviceKey: the LAN address is stable, an IP or
// the neighbor MAC are fallbacks for older announcements.
function deviceKey(row) {
	if (!row)
		return '';

	const lan = macKey(row.lanMac);

	if (lan)
		return lan;
	if (row.ips && row.ips[0])
		return row.ips[0];
	if (row.neighbor)
		return row.neighbor;
	if (row.hostname)
		return 'name:' + row.hostname;

	return '';
}

/*
 * The three node states DESIGN §9 asks for.  A device still in the peer cache
 * but silent for two minutes is offline; the cache itself drops it after five
 * minutes, so this is the window in which the state can be shown at all.  A
 * weak signal only matters when the wireless link is the only path: a hybrid
 * node keeps working over Ethernet.
 */
function classifyState(lastSeenSeconds, mediums, signal) {
	if (lastSeenSeconds != null && lastSeenSeconds >= OFFLINE_SECONDS)
		return 'offline';

	const media = mediums || [];
	const wirelessOnly = media.length === 1 && media[0] === 'wlan';

	if (wirelessOnly && signal != null && signal < WEAK_BACKHAUL_DBM)
		return 'weak';

	return 'normal';
}

function stateName(state) {
	return state === 'offline' ? _('Offline') :
		(state === 'weak' ? _('Weak signal') : _('Normal'));
}

/*
 * One LAN MAC announced under two hostnames means the rows of two devices are
 * being merged, so one of them is invisible in the node table.  Compare the raw
 * rows: after devices() the two are already one entry.
 */
function macConflicts(rows) {
	const order = [];
	const byMac = {};

	for (const row of rows || []) {
		const mac = macKey(row.lanMac);
		const name = String(row.hostname == null ? '' : row.hostname).trim();

		if (!mac || !name)
			continue;

		if (!byMac[mac]) {
			byMac[mac] = { mac: mac, names: [], seen: {} };
			order.push(byMac[mac]);
		}

		const key = name.toLowerCase();

		if (!byMac[mac].seen[key]) {
			byMac[mac].seen[key] = true;
			byMac[mac].names.push(name);
		}
	}

	return order.filter(function(conflict) {
		return conflict.names.length > 1;
	}).map(function(conflict) {
		return { mac: conflict.mac, names: conflict.names };
	});
}

function unique(values) {
	const out = [];

	for (const value of values) {
		if (value != null && value !== '' && out.indexOf(value) === -1)
			out.push(value);
	}

	return out;
}

/*
 * Collapse the per-link rows into one entry per remote device.
 */
function devices(rows) {
	const order = [];
	const byKey = {};

	for (const row of rows || []) {
		const key = deviceKey(row);

		if (!key)
			continue;

		let entry = byKey[key];

		if (!entry) {
			entry = {
				key: key,
				names: [],
				ips: [],
				rows: [],
				backhauls: [],
				signals: [],
				memories: [],
				clients: [],
				lastSeen: [],
				announcements: []
			};
			byKey[key] = entry;
			order.push(entry);
		}

		entry.rows.push(row);
		entry.names = unique(entry.names.concat([ row.hostname ]));
		entry.ips = unique(entry.ips.concat(row.ips || []));
		entry.backhauls = unique(entry.backhauls.concat([ row.backhaul ]));
		entry.clients = unique(entry.clients.concat([ row.clients ]));
		entry.memories = unique(entry.memories.concat([ row.memory ]));

		const signal = parseSignal(row.signal);
		const seen = parseSeconds(row.lastSeen);

		if (signal != null)
			entry.signals.push(signal);
		if (seen != null)
			entry.lastSeen.push(seen);

		if (row.meshId || row.htmode || row.channel || row.routingAlgo)
			entry.announcements.push(true);
	}

	for (const entry of order) {
		entry.name = entry.names[0] || (entry.rows[0] && entry.rows[0].neighbor) || _('Unknown device');
		entry.hostname = entry.names[0] || '';
		entry.memory = entry.memories.length ? Math.max.apply(null, entry.memories) : null;
		entry.clients = entry.clients.length ? Math.max.apply(null, entry.clients) : null;
		entry.signal = entry.signals.length ? Math.max.apply(null, entry.signals) : null;
		entry.lastSeenSeconds = entry.lastSeen.length ? Math.min.apply(null, entry.lastSeen) : null;
		entry.mediums = entry.backhauls.filter(function(value) {
			return value === 'wired' || value === 'wlan';
		});
		entry.state = classifyState(entry.lastSeenSeconds, entry.mediums, entry.signal);
		entry.announced = entry.announcements.length > 0;
		delete entry.names;
		delete entry.ips;
		delete entry.rows;
		delete entry.backhauls;
		delete entry.signals;
		delete entry.clients;
		delete entry.memories;
		delete entry.lastSeen;
		delete entry.announcements;
	}

	return order;
}

function monitor(input) {
	input = input || {};

	const list = devices(input.rows);
	const local = input.localInfo || {};
	const findings = [];

	function add(level, code, values) {
		findings.push({ level: level, code: code, values: values || {} });
	}

	if (!list.length && input.configured)
		add('info', 'T-NO-PEERS-01');

	for (const entry of list) {
		const seen = entry.lastSeenSeconds;

		if (seen != null && seen >= STALE_ERROR_SECONDS)
			add('error', 'T-STALE-01', { device: entry.name, seconds: Math.round(seen) });
		else if (seen != null && seen >= STALE_WARN_SECONDS)
			add('warn', 'T-STALE-01', { device: entry.name, seconds: Math.round(seen) });

		if (entry.memory != null && entry.memory >= MEMORY_ERROR_PERCENT)
			add('error', 'T-MEMORY-01', { device: entry.name, memory: entry.memory });
		else if (entry.memory != null && entry.memory >= MEMORY_WARN_PERCENT)
			add('warn', 'T-MEMORY-01', { device: entry.name, memory: entry.memory });

		// Only a wireless-only device can lose its only path here; a device
		// reached over Ethernet keeps working with a weak radio link.
		if (entry.mediums.length === 1 && entry.mediums[0] === 'wlan' &&
			entry.signal != null && entry.signal < WEAK_BACKHAUL_DBM)
			add('warn', 'T-WEAK-01', { device: entry.name, signal: entry.signal });

		if (!entry.announced)
			add('info', 'T-OLD-01', { device: entry.name });
	}

	const hostnames = {};

	for (const entry of list) {
		if (!entry.hostname)
			continue;

		if (!hostnames[entry.hostname])
			hostnames[entry.hostname] = [];

		hostnames[entry.hostname].push(entry);
	}

	for (const name of Object.keys(hostnames)) {
		if (hostnames[name].length > 1)
			add('warn', 'T-DUP-01', { hostname: name });
	}

	for (const conflict of macConflicts(input.rows))
		add('warn', 'T-MAC-01', { mac: colonMac(conflict.mac), names: conflict.names.join(', ') });

	const order = { error: 0, warn: 1, info: 2 };

	findings.sort(function(a, b) { return order[a.level] - order[b.level]; });

	const wired = list.filter(function(entry) {
		return entry.mediums.indexOf('wired') !== -1;
	}).length;
	const wireless = list.filter(function(entry) {
		return entry.mediums.indexOf('wlan') !== -1;
	}).length;
	const hybrid = list.filter(function(entry) {
		return entry.mediums.length > 1;
	}).length;
	const signals = list.map(function(entry) { return entry.signal; })
		.filter(function(value) { return value != null; });
	const memories = list.map(function(entry) { return entry.memory; })
		.filter(function(value) { return value != null; });
	const states = { normal: 0, weak: 0, offline: 0 };

	for (const entry of list)
		states[entry.state] = (states[entry.state] || 0) + 1;

	return {
		devices: list,
		findings: findings,
		summary: {
			devices: list.length,
			normal: states.normal,
			weak: states.weak,
			offline: states.offline,
			wired: wired,
			wireless: wireless,
			hybrid: hybrid,
			weakestSignal: signals.length ? Math.min.apply(null, signals) : null,
			maxMemory: memories.length ? Math.max.apply(null, memories) : null,
			localMemory: local.memory != null ? local.memory : null,
			localClients: local.clients != null ? local.clients : null
		}
	};
}

function levelName(level) {
	return level === 'error' ? _('Error') :
		(level === 'warn' ? _('Warning') : _('Information'));
}

function findingText(finding) {
	const values = (finding && finding.values) || {};

	switch (finding && finding.code) {
	case 'T-NO-PEERS-01':
		return _('Mesh is configured but no other mesh device is currently visible.');
	case 'T-STALE-01':
		return _('%s last announced itself %d seconds ago; the link may have dropped without the peer table noticing yet.')
			.format(values.device || _('A device'), values.seconds || 0);
	case 'T-MEMORY-01':
		return _('%s reports %d%% memory in use. A device under memory pressure can drop mesh frames or restart.')
			.format(values.device || _('A device'), values.memory || 0);
	case 'T-WEAK-01':
		return _('%s is reachable only over a weak wireless backhaul (best signal %d dBm). Move the device closer or add an Ethernet backhaul.')
			.format(values.device || _('A device'), values.signal || 0);
	case 'T-OLD-01':
		return _('%s announces no mesh parameters; it may run an older WiFi Manager release. It cannot be compared for configuration drift.')
			.format(values.device || _('A device'));
	case 'T-DUP-01':
		return _('More than one device announces the hostname "%s". Rename one of them so the topology and logs stay readable.')
			.format(values.hostname || '?');
	case 'T-MAC-01':
		return _('The LAN MAC address %s is announced by more than one device (%s). Their rows are merged into one device; one of them may have a cloned MAC or a stale announcement.')
			.format(values.mac || '?', values.names || '?');
	default:
		return finding && finding.code ? finding.code : _('No additional information.');
	}
}

return baseclass.extend({
	devices: devices,
	monitor: monitor,
	levelName: levelName,
	stateName: stateName,
	findingText: findingText,
	parseSeconds: parseSeconds,
	parseSignal: parseSignal,
	classifyState: classifyState,
	deviceKey: deviceKey
});
