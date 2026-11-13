'use strict';

/*
 * Unified diagnosis, topology monitoring and roaming advice.
 *
 * The three modules are pure: they receive the JSON a read-only RPC returned
 * and classify it.  These tests feed the same shapes the backend produces, so
 * a rule change is caught without a router.
 */

const lib = require('./lib');
const { test, ok, equal, includes } = lib;

const UTILS = 'htdocs/luci-static/resources/wifimanager/utils/';

const advice = lib.loadModule(UTILS + 'roaming-advice.js');
const topology = lib.loadModule(UTILS + 'topology.js');
const diagnosis = lib.loadModule(UTILS + 'diagnosis.js');

function roaming(overrides) {
	const base = {
		capabilities: {
			kvr: true, wnm: true, ft: true, dawn: true,
			dawn_managed: true, dawn_running: true,
			dawn_params: { min_clients: 3 }
		},
		interfaces: [
			{ section: 'wifi_ap_5g', mobility_domain: '1a2b', k: true, v: true, r: true },
			{ section: 'wifi_ap_2g', mobility_domain: '1a2b', k: true, v: true, r: true }
		],
		thresholds: { good: -60, bad: -75 },
		bands: [
			{ band: '5g', signals: [ -55, -58, -60, -62, -65, -70 ] }
		]
	};

	return Object.assign(base, overrides || {});
}

function codes(result) {
	return result.findings.map(function(finding) { return finding.code; });
}

test('advice: a consistent configuration with a clean sample produces no finding', function() {
	const result = advice.advise(roaming());

	equal(result.findings, []);
	equal(result.bands.length, 1);
	equal(result.bands[0].clients, 6);
	equal(result.totalClients, 6);
});

test('advice: a crossing threshold pair is an error for the global and per-band values', function() {
	const result = advice.advise(roaming({
		thresholds: { good: -70, bad: -60, bad_2g: -65,
			bad_5g: -75, bad_6g: -75 }
	}));
	const texts = result.findings
		.filter(function(finding) { return finding.code === 'E-ROAM-02'; })
		.map(advice.adviceText);

	equal(texts.length, 2);
	ok(texts.some(function(text) { return text.indexOf('global') !== -1; }), 'global pair');
	ok(texts.some(function(text) { return text.indexOf('2.4 GHz') !== -1; }), '2.4 GHz pair');
});

test('advice: differing mobility domains and missing r/k/v flags are reported', function() {
	const result = advice.advise(roaming({
		interfaces: [
			{ section: 'wifi_ap_5g', mobility_domain: '1a2b', k: true, v: true, r: true },
			{ section: 'wifi_ap_2g', mobility_domain: '2b3c', k: false, v: false, r: false }
		]
	}));

	ok(codes(result).indexOf('E-ROAM-03') !== -1, 'domain mismatch');
	ok(codes(result).indexOf('W-ROAM-05') !== -1, 'missing r');
	ok(codes(result).indexOf('W-ROAM-06') !== -1, 'missing k');
	ok(codes(result).indexOf('W-ROAM-07') !== -1, 'missing v');
});

test('advice: an AP outside wifi_ap_* is not compared', function() {
	const result = advice.advise(roaming({
		interfaces: [
			{ section: 'wifi_ap_5g', mobility_domain: '1a2b', k: true, v: true, r: true },
			{ section: 'guest_ap', mobility_domain: '9z9z', k: false, v: false, r: false }
		]
	}));

	equal(result.findings, []);
	equal(result.managedInterfaces, 1);
});

test('advice: DAWN installation, watchdog and state are checked', function() {
	ok(codes(advice.advise(roaming({ capabilities: Object.assign({}, roaming().capabilities, { dawn: false }) })))
		.indexOf('W-ROAM-02') !== -1);
	ok(codes(advice.advise(roaming({ capabilities: Object.assign({}, roaming().capabilities, { dawn_running: false }) })))
		.indexOf('W-ROAM-03') !== -1);
	ok(codes(advice.advise(roaming({ capabilities: Object.assign({}, roaming().capabilities, { dawn_watchdog_failures: 2 }) })))
		.indexOf('E-ROAM-01') !== -1);
});

test('advice: a small sample is informational and yields no threshold suggestion', function() {
	const result = advice.advise(roaming({
		bands: [ { band: '5g', signals: [ -55, -60, -65 ] } ]
	}));

	equal(codes(result), [ 'I-ROAM-01' ]);
	equal(result.bands[0].suggestedGood, null);
	equal(result.suggestions, []);
});

test('advice: a five-client sample suggests a rounded pair with a ten dB gap', function() {
	const result = advice.advise(roaming({
		thresholds: { good: -30, bad: -35 },
		bands: [ { band: '5g', signals: [ -52, -57, -61, -66, -72 ] } ]
	}));

	equal(result.bands[0].suggestedGood, -60);
	equal(result.bands[0].suggestedBad, -75);
	ok(result.bands[0].suggestedBad <= result.bands[0].suggestedGood - 10);
	ok(codes(result).indexOf('I-ROAM-02') !== -1, 'current values are 10 dB away');
});

test('advice: the DAWN client minimum is compared with the busiest band', function() {
	const result = advice.advise(roaming({
		capabilities: Object.assign({}, roaming().capabilities,
			{ dawn_params: { min_clients: 20 } })
	}));

	ok(codes(result).indexOf('I-ROAM-03') !== -1, 'min_clients above the sample');
});

test('advice: statistics use the documented percentile and ignore impossible signals', function() {
	const sample = advice.stats([ -50, -60, -70, -80, -90, 5, -200 ]);

	equal(sample.count, 5);
	equal(sample.median, -70);
	equal(sample.p10, -90);
	equal(sample.weakest, -90);
});

test('advice: a per-band threshold overrides the global value', function() {
	equal(advice.thresholdOf({ good: -60, good_6g: -52 }, 'good', '6g'), -52);
	equal(advice.thresholdOf({ good: -60 }, 'good', '6g'), -60);
	equal(advice.thresholdOf({}, 'good', '6g'), null);
});

function topoRows() {
	return [
		{ hostname: 'node-a', neighbor: '00:11:22:33:44:55', ips: [ '192.168.1.2' ],
		  lanMac: '00:11:22:33:44:55', backhaul: 'wired', signal: '', memory: 40,
		  clients: 3, lastSeen: '0.5s', meshId: 'wm', htmode: 'HE80',
		  routingAlgo: 'BATMAN_V' },
		{ hostname: 'node-b', neighbor: '00:11:22:33:44:66', ips: [ '192.168.1.3' ],
		  lanMac: '00:11:22:33:44:66', backhaul: 'wlan', signal: '-80 dBm', memory: 88,
		  clients: 1, lastSeen: '200s', meshId: '', htmode: '', routingAlgo: '' }
	];
}

test('topology: rows of one device are grouped and its values summarised', function() {
	const list = topology.devices(topoRows());

	equal(list.length, 2);
	equal(list[0].name, 'node-a');
	equal(list[0].mediums, [ 'wired' ]);
	equal(list[1].memory, 88);
	equal(list[1].lastSeenSeconds, 200);
	equal(list[1].signal, -80);
	equal(list[0].state, 'normal');
	equal(list[1].state, 'offline');
});

test('topology: node state separates weak signal, offline and normal', function() {
	equal(topology.classifyState(5, [ 'wlan' ], -80), 'weak');
	equal(topology.classifyState(5, [ 'wired', 'wlan' ], -80), 'normal');
	equal(topology.classifyState(5, [ 'wlan' ], -60), 'normal');
	equal(topology.classifyState(130, [ 'wired' ], null), 'offline');
	equal(topology.classifyState(5, [ 'wired' ], null), 'normal');
	equal(topology.classifyState(null, [ 'wlan' ], null), 'normal');
	equal(topology.stateName('weak'), 'Weak signal');
	equal(topology.stateName('offline'), 'Offline');
});

test('topology: two devices announcing one LAN MAC are reported', function() {
	const rows = [
		{ hostname: 'node-a', lanMac: '00:11:22:33:44:aa', backhaul: 'wired', lastSeen: '0.1s' },
		{ hostname: 'node-b', lanMac: '00:11:22:33:44:aa', backhaul: 'wlan', lastSeen: '0.1s' }
	];
	const result = topology.monitor({ rows: rows, configured: true });
	const conflicts = result.findings.filter(function(f) { return f.code === 'T-MAC-01'; });

	equal(conflicts.length, 1);
	includes(topology.findingText(conflicts[0]), '00:11:22:33:44:aa');
	includes(topology.findingText(conflicts[0]), 'node-a');
	includes(topology.findingText(conflicts[0]), 'node-b');
});

test('topology: stale, memory, weak backhaul and incomplete announcements are reported', function() {
	const result = topology.monitor({ rows: topoRows(), localInfo: {}, configured: true });
	const found = result.findings.map(function(finding) { return finding.code; });

	ok(found.indexOf('T-STALE-01') !== -1, 'stale');
	ok(found.indexOf('T-MEMORY-01') !== -1, 'memory');
	ok(found.indexOf('T-WEAK-01') !== -1, 'weak wireless-only backhaul');
	ok(found.indexOf('T-OLD-01') !== -1, 'incomplete announcement');
	equal(result.summary.devices, 2);
	equal(result.summary.normal, 1);
	equal(result.summary.weak, 0);
	equal(result.summary.offline, 1);
	equal(result.summary.wired, 1);
	equal(result.summary.wireless, 1);
	equal(result.summary.weakestSignal, -80);
});

test('topology: a weak signal on a device with an Ethernet link is not a finding', function() {
	const rows = [ { hostname: 'node-c', lanMac: '00:11:22:33:44:77', ips: [],
		backhaul: 'wired', signal: '-82 dBm', memory: 20, clients: 0,
		lastSeen: '0.1s', meshId: 'wm', htmode: 'HE80', routingAlgo: 'BATMAN_V' },
		{ hostname: 'node-c', lanMac: '00:11:22:33:44:77', ips: [],
		backhaul: 'wlan', signal: '-82 dBm', memory: 20, clients: 0,
		lastSeen: '0.1s', meshId: 'wm', htmode: 'HE80', routingAlgo: 'BATMAN_V' } ];
	const result = topology.monitor({ rows: rows, configured: true });

	ok(result.findings.map(function(f) { return f.code; }).indexOf('T-WEAK-01') === -1);
});

test('topology: a repeated hostname on two devices is reported once', function() {
	const rows = [
		{ hostname: 'openwrt', lanMac: '00:11:22:33:44:88', backhaul: 'wired', lastSeen: '0.1s' },
		{ hostname: 'openwrt', lanMac: '00:11:22:33:44:99', backhaul: 'wired', lastSeen: '0.1s' }
	];
	const result = topology.monitor({ rows: rows, configured: true });
	const duplicates = result.findings.filter(function(f) { return f.code === 'T-DUP-01'; });

	equal(duplicates.length, 1);
	includes(topology.findingText(duplicates[0]), 'openwrt');
});

test('topology: an empty mesh with mesh enabled is reported as informational', function() {
	const result = topology.monitor({ rows: [], configured: true });

	equal(result.findings.length, 1);
	equal(result.findings[0].code, 'T-NO-PEERS-01');
	equal(result.findings[0].level, 'info');
});

function system(overrides) {
	return Object.assign({
		ok: true,
		cpus: 2,
		load: { m1: '0.4', m5: '0.3', m15: '0.2' },
		memory: { total_kb: 100000, available_kb: 60000, free_kb: 40000 },
		services: [
			{ name: 'network', installed: true, enabled: true, running: true },
			{ name: 'firewall', installed: true, enabled: true, running: true },
			{ name: 'dnsmasq', installed: true, enabled: true, running: true }
		]
	}, overrides || {});
}

test('diagnosis: a healthy set of inputs has an ok verdict', function() {
	const result = diagnosis.diagnose({
		system: system(),
		network: { ok: true, checks: [] },
		mesh: { state: { active: false }, bat0: {}, counts: {}, service: {} },
		roaming: roaming()
	});

	equal(result.findings, []);
	equal(result.verdict, 'ok');
	equal(result.counts.total, 0);
});

test('diagnosis: load and memory pressure are ranked as errors and warnings', function() {
	const result = diagnosis.diagnose({
		system: system({
			load: { m1: '7.0', m5: '6.0', m15: '5.0' },
			memory: { total_kb: 100000, available_kb: 5000, free_kb: 2000 }
		}),
		network: { ok: true, checks: [] },
		mesh: {}, roaming: roaming()
	});
	const load = result.findings.filter(function(f) { return f.code === 'D-LOAD-01'; })[0];
	const memory = result.findings.filter(function(f) { return f.code === 'D-MEM-01'; })[0];

	equal(load.level, 'error');
	equal(memory.level, 'warn');
	equal(result.verdict, 'error');
});

test('diagnosis: a core service enabled at boot but stopped is an error', function() {
	const result = diagnosis.diagnose({
		system: system({ services: [
			{ name: 'network', installed: true, enabled: true, running: false },
			{ name: 'dawn', installed: true, enabled: true, running: false },
			{ name: 'dnsmasq', installed: false, enabled: false, running: false }
		] }),
		network: {}, mesh: {}, roaming: roaming()
	});
	const services = result.findings.filter(function(f) { return f.code === 'D-SVC-01'; });

	equal(services.length, 2);
	equal(services[0].level, 'error');
	equal(services[1].level, 'warn');
});

test('diagnosis: network findings keep their code and severity', function() {
	const result = diagnosis.diagnose({
		system: system(),
		network: { ok: true, checks: [
			{ code: 'N-IP-01', severity: 'error', message: 'Duplicate address', detail: '192.168.1.1' },
			{ code: 'N-DNS-02', severity: 'warning', message: 'No upstream resolver', detail: '' }
		] },
		mesh: {}, roaming: roaming()
	});

	equal(codes(result), [ 'N-IP-01', 'N-DNS-02' ]);
	equal(result.findings[0].level, 'error');
	equal(result.findings[1].level, 'warn');
	includes(result.findings[0].message, '192.168.1.1');
});

test('diagnosis: mesh runtime and legacy service conflicts are reported', function() {
	const result = diagnosis.diagnose({
		system: system(),
		network: { ok: true, checks: [] },
		mesh: {
			state: { active: true },
			bat0: { exists: false, up: false },
			counts: { peers: 0 },
			service: { legacy_enabled: true, legacy_running: true }
		},
		roaming: roaming()
	});
	const found = codes(result);

	ok(found.indexOf('D-MESH-01') !== -1, 'missing bat0');
	ok(found.indexOf('D-MESH-04') !== -1, 'legacy service conflict');
	equal(result.findings.filter(function(f) { return f.code === 'D-MESH-01'; })[0].level, 'error');
});

test('diagnosis: roaming findings are included with their advice wording', function() {
	const result = diagnosis.diagnose({
		system: system(),
		network: { ok: true, checks: [] },
		mesh: {},
		roaming: roaming({
			capabilities: Object.assign({}, roaming().capabilities,
				{ dawn_watchdog_failures: 1 })
		})
	});
	const finding = result.findings.filter(function(f) { return f.code === 'E-ROAM-01'; })[0];

	ok(finding, 'roaming finding');
	equal(finding.source, 'roaming');
	equal(finding.level, 'error');
	includes(finding.message, 'watchdog');
	equal(diagnosis.sourceName('roaming'), 'Roaming');
});

test('advice: the BSSID validator accepts only unicast non-zero addresses', function() {
	ok(advice.validBssid('aa:bb:cc:dd:ee:ff'));
	ok(advice.validBssid('AA:BB:CC:DD:EE:FF'));
	ok(!advice.validBssid('01:00:5e:00:00:01'), 'multicast');
	ok(!advice.validBssid('00:00:00:00:00:00'), 'all zero');
	ok(!advice.validBssid('ff:ff:ff:ff:ff:ff'), 'broadcast');
	ok(!advice.validBssid('aa-bb-cc-dd-ee-ff'), 'wrong separator');
	ok(!advice.validBssid(''));
});

test('advice: invalid and duplicated BSSIDs are reported for 802.11k', function() {
	const result = advice.advise(roaming({
		interfaces: [
			{ section: 'wifi_ap_5g', ssid: 'home', bssid: 'aa:bb:cc:dd:ee:01',
			  k: true, v: true, r: true, mobility_domain: '1a2b', encryption: 'sae' },
			{ section: 'wifi_ap_2g', ssid: 'home', bssid: 'aa:bb:cc:dd:ee:01',
			  k: true, v: true, r: true, mobility_domain: '1a2b', encryption: 'sae' },
			{ section: 'wifi_ap_6g', ssid: 'home', bssid: '01:00:5e:00:00:01',
			  k: true, v: true, r: true, mobility_domain: '1a2b', encryption: 'sae' }
		]
	}));
	const texts = result.findings.map(function(finding) { return advice.adviceText(finding); });

	ok(codes(result).indexOf('E-ROAM-04') !== -1, 'invalid BSSID');
	ok(codes(result).indexOf('E-ROAM-05') !== -1, 'duplicate BSSID');
	ok(codes(result).indexOf('E-ROAM-06') === -1, 'authentication is consistent');
	ok(texts.some(function(text) { return text.indexOf('not a valid unicast') !== -1; }));
	ok(texts.some(function(text) { return text.indexOf('share the BSSID') !== -1; }));
});

test('advice: APs of one SSID must agree on authentication before 802.11r', function() {
	const result = advice.advise(roaming({
		interfaces: [
			{ section: 'wifi_ap_5g', ssid: 'home', r: true, k: true, v: true,
			  mobility_domain: '1a2b', encryption: 'sae-mixed', ieee80211w: '2', key_group: 1 },
			{ section: 'wifi_ap_2g', ssid: 'home', r: true, k: true, v: true,
			  mobility_domain: '1a2b', encryption: 'sae-mixed', ieee80211w: '1', key_group: 1 }
		]
	}));
	const finding = result.findings.filter(function(entry) { return entry.code === 'E-ROAM-06'; })[0];

	ok(finding, 'PMF mismatch is reported');
	includes(advice.adviceText(finding), 'wifi_ap_5g, wifi_ap_2g');
	includes(advice.adviceText(finding), 'home');

	// Different SSIDs are separate groups and do not need the same key.
	const separate = advice.advise(roaming({
		interfaces: [
			{ section: 'wifi_ap_5g', ssid: 'home-5g', r: true, encryption: 'sae', key_group: 1 },
			{ section: 'wifi_ap_2g', ssid: 'home-2g', r: true, encryption: 'psk2', key_group: 2 }
		]
	}));

	ok(codes(separate).indexOf('E-ROAM-06') === -1, 'per-SSID groups are compared separately');
});

test('advice: the key is compared by an opaque group, never by its value', function() {
	const result = advice.advise(roaming({
		interfaces: [
			{ section: 'wifi_ap_5g', ssid: 'home', r: true, encryption: 'psk2', key_group: 1 },
			{ section: 'wifi_ap_2g', ssid: 'home', r: true, encryption: 'psk2', key_group: 2 }
		]
	}));

	ok(codes(result).indexOf('E-ROAM-06') !== -1, 'different keys are reported');
	includes(lib.read('root/usr/lib/wifimanager/diagnostics.sh'), 'roaming_key_group() {');
	includes(lib.read('root/usr/lib/wifimanager/diagnostics.sh'), 'json_add_int key_group');
});
