'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const { test, ok, equal, includes, notIncludes } = lib;

const NEIGHBORS = 'htdocs/luci-static/resources/wifimanager/utils/neighbors.js';
const APSCAN = 'root/usr/lib/wifimanager/apscan.sh';
const RPC_PLUGIN = 'root/usr/libexec/rpcd/wifimanager';
const RPC_UTIL = 'htdocs/luci-static/resources/wifimanager/utils/rpc.js';
const ROAMING_VIEW = 'htdocs/luci-static/resources/view/wifimanager/roaming/settings.js';

const IW_SCAN = [
	'BSS aa:bb:cc:dd:ee:01(on wlan0)',
	'\tfreq: 2437',
	'\tsignal: -42.00 dBm',
	'\tcapability: ESS Privacy ShortSlotTime (0x0411)',
	'\tRSN:\t * Version: 1',
	'\t\t * Group cipher: CCMP',
	'\t\t * Pairwise ciphers: CCMP',
	'\t\t * Authentication suites: PSK SAE',
	'\tSSID: Home Net',
	'\t* channel 6',
	'BSS aa:bb:cc:dd:ee:02(on wlan0)',
	'\tfreq: 5180',
	'\tsignal: -61.50 dBm',
	'\tcapability: ESS (0x0401)',
	'\tSSID: Guest',
	'\t* channel 36',
	'BSS aa:bb:cc:dd:ee:03(on wlan0)',
	'\tfreq: 5955',
	'\tsignal: -55.00 dBm',
	'\tcapability: ESS Privacy (0x0411)',
	'\tRSN:\t * Version: 1',
	'\t\t * Authentication suites: OWE',
	'\tSSID: Open3',
	'\t* channel 1',
	''
].join('\n');

const IWINFO_SCAN = [
	'Cell 01 - Address: AA:BB:CC:DD:EE:04',
	'          ESSID: "Neighbour"',
	'          Mode: Master  Channel: 11',
	'          Signal: -72 dBm  Quality: 40/70',
	'          Encryption: WPA2 PSK (CCMP)',
	'Cell 02 - Address: AA:BB:CC:DD:EE:05',
	'          ESSID: "Home"',
	'          Mode: Master  Channel: 36',
	'          Signal: -58 dBm  Quality: 55/70',
	'          Encryption: WPA2 PSK (CCMP)',
	''
].join('\n');

const DRIVER = `#!/bin/sh
set -u
MOD="$1"
IW="$2"
IWINFO="$3"
. "$MOD"

failures=0
check() {
	if [ "$2" != "$3" ]; then
		echo "FAIL $1"
		echo "  expected: [$3]"
		echo "  got:      [$2]"
		failures=$((failures + 1))
	fi
}

iw_rows=$(ap_scan_parse_iw <"$IW" | tr '\\037' '|')
check "iw scan rows" "$iw_rows" 'aa:bb:cc:dd:ee:01|Home Net|2437|6|2g|-42|wpa2/wpa3
aa:bb:cc:dd:ee:02|Guest|5180|36|5g|-61|open
aa:bb:cc:dd:ee:03|Open3|5955|1|6g|-55|owe'

iwinfo_rows=$(ap_scan_parse_iwinfo <"$IWINFO" | tr '\\037' '|')
check "iwinfo scan rows" "$iwinfo_rows" 'aa:bb:cc:dd:ee:04|Neighbour||11|2g|-72|wpa2
aa:bb:cc:dd:ee:05|Home||36|5g|-58|wpa2'

if [ "$failures" != 0 ]; then
	echo "$failures scan parser check(s) failed"
	exit 1
fi
echo "scan parser simulation passed"
exit 0
`;

test('neighbours: the scan parsers normalise iw and iwinfo output', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-scan-'));
	const combined = lib.read(APSCAN).split('\n').filter(function(line) {
		return line.indexOf('. /usr/') !== 0;
	}).join('\n');

	fs.writeFileSync(path.join(dir, 'modules.sh'), combined);
	fs.writeFileSync(path.join(dir, 'iw.txt'), IW_SCAN);
	fs.writeFileSync(path.join(dir, 'iwinfo.txt'), IWINFO_SCAN);
	fs.writeFileSync(path.join(dir, 'driver.sh'), DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'),
			path.join(dir, 'modules.sh'), path.join(dir, 'iw.txt'), path.join(dir, 'iwinfo.txt') ]);

		equal(result.status, 0, 'scan parser output:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'scan parser simulation passed');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('neighbours: security classes compare by family', function() {
	const neighbours = lib.loadModule(NEIGHBORS);

	equal(neighbours.normalizeMac(' AA:BB:CC:00:00:01 '), 'aa:bb:cc:00:00:01');
	equal(neighbours.securityOfUci(''), 'open');
	equal(neighbours.securityOfUci('none'), 'open');
	equal(neighbours.securityOfUci('psk2+ccmp'), 'wpa2');
	equal(neighbours.securityOfUci('psk-mixed+tkip+ccmp'), 'wpa/wpa2');
	equal(neighbours.securityOfUci('sae'), 'wpa3');
	equal(neighbours.securityOfUci('sae-mixed'), 'wpa2/wpa3');
	equal(neighbours.securityOfUci('owe'), 'owe');
	equal(neighbours.securityOfUci('wpa2'), 'enterprise');
	equal(neighbours.securityOfUci('wep-open'), 'wep');
	equal(neighbours.securityOfUci('nonsense'), 'other');

	equal(neighbours.securityOfInterface({ encryption: 'psk2' }), 'wpa2');
	equal(neighbours.securityOfInterface({ encryption: 'psk2', auth_server: '10.0.0.1' }), 'enterprise');

	ok(neighbours.securityMatches('wpa2/wpa3', 'wpa3'));
	ok(neighbours.securityMatches('wpa2/wpa3', 'wpa2'));
	ok(!neighbours.securityMatches('wpa2', 'wpa3'));
	ok(!neighbours.securityMatches('open', 'owe'));
	ok(!neighbours.securityMatches('wpa2', 'enterprise'));

	equal(neighbours.securityName('wpa2/wpa3'), 'WPA2/WPA3');
	equal(neighbours.securityName('owe'), 'OWE');
	equal(neighbours.securityName('something'), 'Unknown');

	equal(neighbours.stateName({ self: true }), 'Yours');
	equal(neighbours.stateName({ knownSsid: false }), 'Other network');
	equal(neighbours.stateName({ knownSsid: true, securityMatches: false }),
		'Same SSID, different security');
	equal(neighbours.stateName({ knownSsid: true, securityMatches: true }), 'Same SSID');
});

test('neighbours: a scan is classified into rows and findings', function() {
	const neighbours = lib.loadModule(NEIGHBORS);
	const interfaces = [
		{ section: 'default_radio0', ssid: 'Home', bssid: 'AA:BB:CC:00:00:01',
			encryption: 'sae-mixed' },
		{ section: 'default_radio1', ssid: 'Home', bssid: 'AA:BB:CC:00:00:02',
			encryption: 'sae-mixed' }
	];
	const scans = [
		{
			radio: 'radio0', ok: true, band: '2g', access_points: [
				{ bssid: 'aa:bb:cc:00:00:01', ssid: 'Home', freq: 2437, channel: 6,
					band: '2g', signal: -40, security: 'wpa2/wpa3' },
				{ bssid: 'AA:BB:CC:00:00:01', ssid: 'Home', freq: 2437, channel: 6,
					band: '2g', signal: -55, security: 'wpa2/wpa3' },
				{ bssid: '11:22:33:44:55:66', ssid: 'Home', freq: 5180, channel: 36,
					band: '5g', signal: -70, security: 'wpa' },
				{ bssid: '11:22:33:44:55:66', ssid: 'Guest', freq: 5180, channel: 36,
					band: '5g', signal: -74, security: 'wpa' },
				{ bssid: '11:22:33:44:55:77', ssid: 'Neighbour', freq: 2412, channel: 1,
					band: '2g', signal: -80, security: 'open' },
				{ bssid: 'not-a-mac', ssid: 'Broken', signal: -60, security: 'open' }
			]
		},
		{ radio: 'radio1', ok: false, message: 'The scan failed.' }
	];

	const result = neighbours.analyse(scans, interfaces);

	equal(result.scanned, 1);
	equal(result.failed.length, 1);
	equal(result.failed[0].radio, 'radio1');
	equal(result.hasData, true);
	equal(result.rows.length, 3, 'one row per BSSID; the invalid MAC is dropped');
	equal(result.selfCount, 1);
	equal(result.foreignSameSsid, 1);

	const own = result.rows[0];

	equal(own.bssid, 'aa:bb:cc:00:00:01');
	equal(own.self, true);
	equal(own.signal, -40, 'the strongest observation wins');
	equal(own.ssids, [ 'Home' ]);

	const foreign = result.rows[1];

	equal(foreign.bssid, '11:22:33:44:55:66');
	equal(foreign.knownSsid, true);
	equal(foreign.securityMatches, false);
	equal(foreign.ssids, [ 'Home', 'Guest' ]);
	equal(result.rows[2].bssid, '11:22:33:44:55:77');
	equal(result.rows[2].knownSsid, false);

	equal(result.findings.map(function(finding) { return finding.code; }),
		[ 'W-ROAM-08', 'I-ROAM-04', 'I-ROAM-05' ]);
	equal(result.findings[0].values.ssid, 'Home');
	equal(result.findings[0].values.found, [ 'wpa' ]);
	equal(result.findings[0].values.expected, [ 'wpa2/wpa3' ]);
	equal(result.findings[1].values.count, 1);
	equal(result.findings[2].values.ssids, [ 'Home', 'Guest' ]);

	includes(neighbours.findingText(result.findings[0]), 'Home');
	includes(neighbours.findingText(result.findings[1]), 'Home');
	includes(neighbours.findingText(result.findings[2]), '11:22:33:44:55:66');
	equal(neighbours.levelName('warn'), 'Warning');
});

test('neighbours: an empty or failed scan claims nothing', function() {
	const neighbours = lib.loadModule(NEIGHBORS);

	const empty = neighbours.analyse([
		{ radio: 'radio0', ok: true, access_points: [] }
	], []);

	equal(empty.hasData, false);
	equal(empty.scanned, 1);
	equal(empty.rows.length, 0);
	equal(empty.findings.length, 0);

	const failed = neighbours.analyse([
		{ radio: 'radio0', ok: false, message: 'The scan failed.' }
	], []);

	equal(failed.scanned, 0);
	equal(failed.failed.length, 1);
	equal(failed.hasData, false);
});

test('neighbours: the RPC, ACL and view expose a read-only scan per radio', function() {
	const plugin = lib.read(RPC_PLUGIN);
	const acl = lib.acl();
	const rpc = lib.read(RPC_UTIL);
	const apscan = lib.read(APSCAN);
	const view = lib.read(ROAMING_VIEW);

	includes(plugin, '"roaming_neighbor_scan": { "radio": "string" }');
	includes(plugin, 'roaming_neighbor_scan) roaming_neighbor_scan_json "$(jget "$args" \'@.radio\')"');
	includes(plugin, '. /usr/lib/wifimanager/apscan.sh');
	includes(plugin, '|roaming_neighbor_scan|');

	ok(acl['luci-app-wifimanager'].read.ubus.wifimanager.indexOf('roaming_neighbor_scan') !== -1);
	ok(acl['luci-app-wifimanager'].write.ubus.wifimanager.indexOf('roaming_neighbor_scan') === -1,
		'the scan must stay read-only');

	includes(rpc, "roamingNeighborScan: declare('roaming_neighbor_scan', [ 'radio' ])");

	includes(apscan, 'iw dev "$ifname" scan');
	includes(apscan, 'iwinfo "$ifname" scan');
	includes(apscan, 'E-INPUT');
	includes(apscan, 'E-NORADIO');
	includes(apscan, 'E-NOIFACE');
	includes(apscan, 'E-SCAN');
	notIncludes(apscan, 'eval ');

	includes(view, "card(_('Neighbouring access points')");
	includes(view, 'rpc.roamingNeighborScan(entry.name)');
	includes(view, 'neighbours.analyse(scans, interfaces)');
	includes(view, 'takes the radio off its channel');
	includes(view, 'A scan is a snapshot of one moment');
});
