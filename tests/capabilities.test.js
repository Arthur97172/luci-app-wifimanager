'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const { test, ok, equal, includes } = lib;

const CAPABILITIES = 'root/usr/lib/wifimanager/capabilities.sh';
const RADIO_SH = 'root/usr/lib/wifimanager/radio.sh';
const RADIO = 'htdocs/luci-static/resources/wifimanager/utils/radio.js';
const RADIOS_VIEW = 'htdocs/luci-static/resources/view/wifimanager/wifi/radios.js';
const WIRELESS_FORM = 'htdocs/luci-static/resources/wifimanager/utils/wireless-form.js';

/*
 * A phy matrix modelled on "iw phy info": three bands, one disabled channel
 * per band, DFS channels, VHT160/HE/EHT on 5 GHz, and two readable interface
 * combinations plus one that names no mode this package configures.
 */
const PHY_INFO = [
	'Wiphy phy0',
	'\tmax # scan SSIDs: 4',
	'\tBand 1:',
	'\t\tCapabilities: 0x19ef',
	'\t\t\tHT20/HT40',
	'\t\tFrequencies:',
	'\t\t\t* 2412 MHz [1] (20.0 dBm)',
	'\t\t\t* 2417 MHz [2] (20.0 dBm)',
	'\t\t\t* 2462 MHz [11] (20.0 dBm)',
	'\t\t\t* 2472 MHz [13] (20.0 dBm)',
	'\t\t\t* 2484 MHz [14] (disabled)',
	'\t\tSupported Channel Width: neither 160 nor 80+80',
	'\tBand 2:',
	'\t\tCapabilities: 0x19ef',
	'\t\t\tHT20/HT40',
	'\t\tVHT Capabilities (0x339b9bf6):',
	'\t\tSupported Channel Width: 160 MHz',
	'\t\tHE Iftypes: managed, AP',
	'\t\tEHT Iftypes: managed, AP',
	'\t\tFrequencies:',
	'\t\t\t* 5180 MHz [36] (23.0 dBm)',
	'\t\t\t* 5260 MHz [52] (23.0 dBm) (radar detection)',
	'\t\t\t* 5500 MHz [100] (23.0 dBm) (radar detection)',
	'\t\t\t* 5945 MHz [189] (disabled)',
	'\tBand 4:',
	'\t\tHE Iftypes: AP',
	'\t\tFrequencies:',
	'\t\t\t* 5955 MHz [1] (23.0 dBm)',
	'\t\t\t* 6115 MHz [37] (23.0 dBm)',
	'\t\t\t* 7115 MHz [233] (disabled)',
	'\tSupported interface modes:',
	'\t\t * IBSS',
	'\t\t * managed',
	'\t\t * AP',
	'\t\t * AP/VLAN',
	'\t\t * monitor',
	'\t\t * mesh point',
	'\t\t * P2P-client',
	'\t\t * P2P-GO',
	'\tvalid interface combinations:',
	'\t\t * #{ managed } <= 2, #{ AP, mesh point } <= 8,',
	'\t\t   total <= 8, #channels <= 1',
	'\t\t * #{ AP } <= 4, #{ managed } <= 1, total <= 4, #channels <= 2',
	'\t\t * #{ P2P-client } <= 2',
	''
].join('\n');

const PHY_NO_COMBOS = [
	'Wiphy phy1',
	'\tBand 1:',
	'\t\t\tHT20',
	'\t\tFrequencies:',
	'\t\t\t* 2412 MHz [1] (20.0 dBm)',
	'\tSupported interface modes:',
	'\t\t * managed',
	'\t\t * AP',
	''
].join('\n');

const DRIVER = `#!/bin/sh
set -u
MOD="$1"
FIX="$2"
NOC="$3"
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

bands=$(cap_bands <"$FIX")
check "2.4 GHz band" "$(printf '%s\\n' "$bands" | grep '^2g|')" \\
	'2g|ht=1|ht40=1|vht=0|vht160=0|he=0|eht=0|dfs=0|channels=1,2,11,13'
check "5 GHz band" "$(printf '%s\\n' "$bands" | grep '^5g|')" \\
	'5g|ht=1|ht40=1|vht=1|vht160=1|he=1|eht=1|dfs=1|channels=36,52,100'
check "6 GHz band" "$(printf '%s\\n' "$bands" | grep '^6g|')" \\
	'6g|ht=0|ht40=0|vht=0|vht160=0|he=1|eht=0|dfs=0|channels=1,37'
check "three bands" "$(printf '%s\\n' "$bands" | wc -l | tr -d ' ')" 3

modes=$(cap_modes <"$FIX")
check "interface modes" "$(printf '%s\\n' "$modes" | tr '\\n' ',')" \\
	'IBSS,managed,AP,AP/VLAN,monitor,mesh point,P2P-client,P2P-GO,'

check "mode support AP" "$(cap_modes_support "$modes" ap && echo 1 || echo 0)" 1
check "mode support mesh" "$(cap_modes_support "$modes" mesh && echo 1 || echo 0)" 1
check "mode support adhoc" "$(cap_modes_support "$modes" adhoc && echo 1 || echo 0)" 1
check "unknown mode is never supported" \\
	"$(cap_modes_support "$modes" wds && echo 1 || echo 0)" 0

combos=$(cap_combinations <"$FIX")
check "combinations" "$(printf '%s\\n' "$combos" | tr '\\n' ',')" \\
	'G:sta=2;G:ap+mesh=8;T=8;C=1,G:ap=4;G:sta=1;T=4;C=2,'
check "combinations reported" "$(cap_combinations_reported <"$FIX")" 1
check "no combinations reported" "$(cap_combinations_reported <"$NOC")" 0
check "no combinations parsed" "$(cap_combinations <"$NOC")" ''

support() { cap_combinations_support "$combos" "$1" && echo 1 || echo 0; }

check "AP + STA is supported" "$(support 'ap=1;sta=1;mesh=0;adhoc=0')" 1
check "AP + mesh is supported" "$(support 'ap=1;sta=0;mesh=1;adhoc=0')" 1
check "two AP + one STA is supported" "$(support 'ap=2;sta=1;mesh=0;adhoc=0')" 1
check "three STA are refused" "$(support 'ap=1;sta=3;mesh=0;adhoc=0')" 0
check "nine AP are refused" "$(support 'ap=9;sta=0;mesh=0;adhoc=0')" 0
check "an unmentioned mode is refused" "$(support 'ap=0;sta=0;mesh=0;adhoc=1')" 0
check "empty combination list is refused" \\
	"$(cap_combinations_support '' 'ap=1;sta=0;mesh=0;adhoc=0' && echo 1 || echo 0)" 0

check "VHT160 field" "$(cap_band_field "$bands" 5g vht160)" 1
check "VHT field of 2.4 GHz" "$(cap_band_field "$bands" 2g vht)" 0
check "6 GHz channels" "$(cap_band_field "$bands" 6g channels)" '1,37'
check "missing band field" "$(cap_band_field "$bands" 900m he)" ''

check "HT htmode field" "$(cap_htmode_field HT40)" ht
check "VHT htmode field" "$(cap_htmode_field VHT80)" vht
check "HE htmode field" "$(cap_htmode_field HE20)" he
check "EHT htmode field" "$(cap_htmode_field EHT160)" eht
check "auto needs no field" "$(cap_htmode_field auto)" ''

if [ "$failures" != 0 ]; then
	echo "$failures capability check(s) failed"
	exit 1
fi
echo "capability simulation passed"
exit 0
`;

test('capabilities: the iw phy parsers report bands, modes and combinations', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-cap-'));
	const combined = lib.read(CAPABILITIES).split('\n').filter(function(line) {
		return line.indexOf('. /usr/') !== 0;
	}).join('\n');

	fs.writeFileSync(path.join(dir, 'modules.sh'), combined);
	fs.writeFileSync(path.join(dir, 'phy.txt'), PHY_INFO);
	fs.writeFileSync(path.join(dir, 'nocombos.txt'), PHY_NO_COMBOS);
	fs.writeFileSync(path.join(dir, 'driver.sh'), DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'),
			path.join(dir, 'modules.sh'), path.join(dir, 'phy.txt'), path.join(dir, 'nocombos.txt') ]);

		equal(result.status, 0, 'capability output:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'capability simulation passed');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const RADIO_FIXTURE = [
	'wireless.radio0=wifi-device',
	'wireless.radio0.band=2g',
	'wireless.radio0.channel=1',
	'wireless.radio1=wifi-device',
	'wireless.radio1.band=2g',
	'wireless.radio1.channel=3',
	'wireless.radio2=wifi-device',
	'wireless.radio2.band=5g',
	'wireless.radio2.channel=52',
	'wireless.default_radio0=wifi-iface',
	'wireless.default_radio0.mode=ap',
	'wireless.default_radio0.disabled=1',
	'wireless.mesh0=wifi-iface',
	'wireless.mesh0.mode=mesh',
	'wireless.default_radio1=wifi-iface',
	'wireless.default_radio1.mode=sta',
	'wireless.mlo0=wifi-iface',
	'wireless.mlo0.mode=ap',
	'meshassistant.config.spectrum_radio0_channel=6',
	''
].join('\n');

const RADIO_DRIVER = `#!/bin/sh
set -u
MOD="$1"
FIX="$2"
LOG="$3"
. "$MOD"

uci() {
	[ "$1" = "-q" ] && shift
	case "$1" in
		show) cat "$FIX" ;;
		get) awk -F= -v k="$2" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$FIX" ;;
	esac
}

# The real helper lives in common.sh, which the test does not load.
iface_names_of_radio() {
	case "$1" in
		radio0) echo "default_radio0 mesh0" ;;
		radio1) echo "default_radio1" ;;
		radio2) echo "mlo0" ;;
	esac
}

radio_conflict_emit() {
	printf '%s|%s\\n' "$1" "$3" >>"$LOG"
}

failures=0
check() {
	if [ "$2" != "$3" ]; then
		echo "FAIL $1"
		echo "  expected: [$3]"
		echo "  got:      [$2]"
		failures=$((failures + 1))
	fi
}

usage=$(radio_usage_collect)
check "disabled interface is not counted" \\
	"$(printf '%s\\n' "$usage" | grep -c '^radio0|ap|default_radio0$')" 0
check "enabled mesh is counted" \\
	"$(printf '%s\\n' "$usage" | grep -c '^radio0|mesh|mesh0$')" 1

: >"$LOG"
count=$(radio_channel_conflicts_json)
check "all-radio conflict count" "$count" 2
check "spectrum override" "$(grep -c '^W-CHAN-01|radio0 1 6$' "$LOG")" 1
check "overlapping pair" "$(grep -c '^W-CHAN-02|radio0 radio1 1 3$' "$LOG")" 1

: >"$LOG"
count=$(radio_channel_conflicts_json radio1)
check "selected-radio conflict count" "$count" 1
check "pair is reported when one radio is selected" "$(grep -c '^W-CHAN-02|' "$LOG")" 1
check "unselected spectrum override is skipped" "$(grep -c '^W-CHAN-01|' "$LOG")" 0

: >"$LOG"
count=$(radio_channel_conflicts_json radio2)
check "unrelated 5 GHz radio has no channel conflict" "$count" 0

: >"$LOG"
count=$(radio_mlo_dfs_conflicts_json radio2 radio0)
check "DFS link detected" "$count" 1
check "DFS detail names the radio and channel" "$(grep -c '^W-CHAN-03|radio2 52$' "$LOG")" 1

if [ "$failures" != 0 ]; then
	echo "$failures radio check(s) failed"
	exit 1
fi
echo "radio simulation passed"
exit 0
`;

test('capabilities: disabled interfaces and channel conflicts follow the save scope', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-radio-'));
	const combined = lib.read(RADIO_SH).split('\n').filter(function(line) {
		return line.indexOf('. /usr/') !== 0;
	}).join('\n');

	fs.writeFileSync(path.join(dir, 'modules.sh'), combined);
	fs.writeFileSync(path.join(dir, 'fixture.txt'), RADIO_FIXTURE);
	fs.writeFileSync(path.join(dir, 'driver.sh'), RADIO_DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'),
			path.join(dir, 'modules.sh'), path.join(dir, 'fixture.txt'),
			path.join(dir, 'conflicts.log') ]);

		equal(result.status, 0, 'radio output:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'radio simulation passed');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const SAVE_DRIVER = `#!/bin/sh
set -u
MOD="$1"
FIX="$2"
LOG="$3"
MODE="$4"
MLO="$5"
SECTION="$6"
DEVICES="$7"
. "$MOD"

uci() {
	[ "$1" = "-q" ] && shift
	case "$1" in
		show) cat "$FIX" ;;
		get) awk -F= -v k="$2" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$FIX" ;;
	esac
}

iface_names_of_radio() {
	case "$1" in
		radio0) echo "default_radio0 mesh0" ;;
		radio1) echo "default_radio1" ;;
		radio2) echo "mlo0" ;;
	esac
}

# Force the capability path onto its unconfirmed branch: this test is about
# the configuration checks, not about parsing iw output.
radio_phy() { echo ""; }
radio_conflict_emit() { printf '%s|%s\\n' "$1" "$3" >>"$LOG"; }

jget() {
	case "$2" in
		'@.mode') echo "$MODE" ;;
		'@.device[*]') printf '%s\\n' $DEVICES ;;
		'@.mlo') echo "$MLO" ;;
		'@.section') echo "$SECTION" ;;
	esac
}

json_init() { :; }
json_add_boolean() { :; }
json_add_array() { :; }
json_add_object() { :; }
json_add_string() { :; }
json_close_object() { :; }
json_close_array() { :; }
json_add_int() { :; }
json_dump() { :; }

radio_check_json '{}' >/dev/null
`;

test('capabilities: radio_check reports the same channel and MLO conflicts before a save', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-save-'));
	const combined = lib.read(RADIO_SH).split('\n').filter(function(line) {
		return line.indexOf('. /usr/') !== 0;
	}).join('\n');
	const driver = path.join(dir, 'driver.sh');
	const fixture = path.join(dir, 'fixture.txt');

	fs.writeFileSync(path.join(dir, 'modules.sh'), combined);
	fs.writeFileSync(fixture, RADIO_FIXTURE);
	fs.writeFileSync(driver, SAVE_DRIVER);

	const run = function(log, mode, mlo, section, devices) {
		fs.writeFileSync(log, '');
		const result = lib.command('sh', [ driver, path.join(dir, 'modules.sh'),
			fixture, log, mode, mlo, section, devices ]);

		equal(result.status, 0, 'save check output:\n' + result.stderr);
		return fs.readFileSync(log, 'utf8');
	};

	try {
		const plain = run(path.join(dir, 'plain.log'), 'ap', '0', '', 'radio0');

		includes(plain, 'W-CHAN-01|radio0 1 6');
		includes(plain, 'W-CHAN-02|radio0 radio1 1 3');
		includes(plain, 'W-CONC-02');
		lib.notIncludes(plain, 'W-CONC-03');
		lib.notIncludes(plain, 'W-CHAN-03');
		lib.notIncludes(plain, 'E-ALLOC-02');

		const mlo = run(path.join(dir, 'mlo.log'), 'ap', '1', '', 'radio0 radio2');

		includes(mlo, 'W-CONC-03|radio0');
		includes(mlo, 'W-CHAN-03|radio2 52');
		includes(mlo, 'W-CHAN-01|radio0 1 6');
		lib.notIncludes(mlo, 'E-ALLOC-02');

		// An older caller sent mode=mlo with no mlo flag.  The section's stored
		// AP mode must be recovered, while the link still gets MLO checks.
		const legacy = run(path.join(dir, 'legacy.log'), 'mlo', '0', 'mlo0', 'radio0 radio2');

		includes(legacy, 'W-CONC-03|radio0');
		includes(legacy, 'W-CHAN-03|radio2 52');
		lib.notIncludes(legacy, 'E-ALLOC-02');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('capabilities: the save check runs the same channel and MLO rules as the inventory', function() {
	const source = lib.read(RADIO_SH);
	const view = lib.read(RADIOS_VIEW);

	includes(source, '# A disabled section is not carried by the radio at runtime');
	includes(source, 'count=$(radio_channel_conflicts_json $devices)');
	includes(source, 'count=$(radio_mlo_dfs_conflicts_json $devices)');
	includes(source, 'count=$(radio_mlo_dfs_conflicts_json $(uci -q get "wireless.$section.device"))');
	includes(source, 'mode=${stored_mode:-ap}');
	includes(source, '"Radio \'%s\' is used by both MLO and mesh; the driver may reject this."');

	includes(view, 'interfaceCell(entry.interfaces)');
	includes(view, 'radio.modeName(info.mode)');
	includes(view, "badge(_('MLO'), 'info')");
	includes(view, "badge(_('Mesh-owned'), 'info')");
});

test('capabilities: the radio module formats driver capability data', function() {
	const radio = lib.loadModule(RADIO);
	const caps = {
		available: true,
		modes: [ 'IBSS', 'managed', 'AP', 'AP/VLAN', 'monitor', 'mesh point' ],
		bands: [
			{ band: '2g', ht: 1, ht40: 1, vht: 0, vht160: 0, he: 0, eht: 0, dfs: 0,
				channels: [ 1, 6, 11 ] },
			{ band: '5g', ht: 1, ht40: 0, vht: 1, vht160: 1, he: 1, eht: 1, dfs: 1,
				channels: [ 36, 52, 100 ] }
		],
		combinations: [
			{ groups: [ { modes: [ 'sta' ], limit: 2 },
				{ modes: [ 'ap', 'mesh' ], limit: 8 } ], total: 8, channels: 1 },
			{ groups: [ { modes: [ 'ap' ], limit: 4 },
				{ modes: [ 'sta' ], limit: 1 } ], total: 4, channels: 2 }
		],
		combinations_reported: true
	};

	ok(radio.capabilityAvailable({ capabilities: caps }));
	ok(!radio.capabilityAvailable({}));
	ok(!radio.capabilityAvailable({ capabilities: { available: false } }));

	equal(radio.capabilityModeName('AP'), 'Access Point (AP)');
	equal(radio.capabilityModeName('managed'), 'Client (STA)');
	equal(radio.capabilityModeName('mesh point'), '802.11s mesh point');
	equal(radio.capabilityModeName('IBSS'), 'Ad-Hoc (IBSS)');
	equal(radio.capabilityModeName('P2P-GO'), 'P2P-GO');

	equal(radio.bandSummary(caps.bands[0]), 'HT20/HT40');
	equal(radio.bandSummary(caps.bands[1]), 'HT20, VHT 20–160 MHz, HE, EHT');
	equal(radio.bandSummary({}), 'No PHY mode reported');

	ok(radio.comboFits(caps.combinations[0], { ap: 1, sta: 1 }));
	ok(!radio.comboFits(caps.combinations[0], { ap: 1, sta: 3 }));
	ok(!radio.comboFits(caps.combinations[0], { adhoc: 1 }),
		'a combination that never mentions a mode does not permit it');
	ok(radio.comboFits(caps.combinations[1], { ap: 2, sta: 1 }));
	ok(!radio.comboFits(caps.combinations[1], { ap: 2, sta: 2 }));

	equal(radio.concurrentSummary(caps), 'supported');
	equal(radio.concurrentSummary({ available: true, combinations: [] }), 'unknown');
	equal(radio.concurrentSummary({ available: false }), 'unknown');
	equal(radio.concurrentSummary({
		available: true,
		combinations: [ { groups: [ { modes: [ 'ap' ], limit: 1 } ], total: 1 } ]
	}), 'unsupported');

	equal(radio.concurrencyLabel('supported'), 'Supported');
	equal(radio.concurrencyLabel('unsupported'), 'Not supported');
	equal(radio.concurrencyLabel('unknown'), 'Not reported');

	equal(radio.capabilityHint(caps), 'Driver reports AP + STA: Supported.');
	equal(radio.capabilityHint(null), '');

	equal(radio.combinationText(caps.combinations[0]),
		'Client (STA) ≤ 2; Access Point (AP) + 802.11s mesh point ≤ 8;' +
		' total ≤ 8; channels ≤ 1');
});

test('capabilities: radio_check refuses what the driver states and confirms the rest', function() {
	const source = lib.read(RADIO_SH);

	includes(source, '. /usr/lib/wifimanager/capabilities.sh');
	includes(source, 'capability_json_add "$phy"');
	includes(source, 'iw phy "$phy" info');

	for (const code of [ 'E-CAP-01', 'E-CAP-02', 'E-CAP-03', 'E-CAP-04', 'E-CAP-05',
		'W-CAP-01' ])
		includes(source, code);

	// An error is only raised from a parsed capability; missing data produces
	// the confirmation warning instead of an invented limit.
	includes(source, 'cap_modes_support "$modes" "$mode"');
	includes(source, 'cap_combinations_support "$combos" "$counts"');
	includes(source, 'cap_htmode_field "$htmode"');
});

test('capabilities: the UI shows what the driver reported and nothing more', function() {
	const view = lib.read(RADIOS_VIEW);
	const form = lib.read(WIRELESS_FORM);

	includes(view, "card(_('Hardware capability')");
	includes(view, 'entry.capabilities');
	includes(view, 'radio.capabilityAvailable(entry)');
	includes(view, 'radio.bandSummary(band)');
	includes(view, 'radio.combinationText');
	includes(view, '_(\'The driver did not report its capabilities for this radio');
	includes(view, 'capabilityBlock');

	includes(form, 'radio.capabilityHint(entryRadio.capabilities)');
});
