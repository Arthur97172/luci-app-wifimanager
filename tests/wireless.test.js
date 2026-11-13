'use strict';

const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, match } = lib;

const UTIL = 'htdocs/luci-static/resources/wifimanager/utils/wireless.js';
const FORM = 'htdocs/luci-static/resources/wifimanager/utils/wireless-form.js';
const BACKEND = 'root/usr/lib/wifimanager/wireless.sh';
const INTERFACES = 'htdocs/luci-static/resources/view/wifimanager/wifi/interfaces.js';
const MLO = 'htdocs/luci-static/resources/view/wifimanager/wifi/mlo.js';

const wireless = lib.loadModule(UTIL);
const radios = [
	{ name: 'radio0', band: '2.4g' },
	{ name: 'radio1', band: '5g' }
];
const networks = [ 'lan', 'wan' ];

function draft(overrides) {
	return Object.assign(wireless.defaults(null), {
		mode: 'ap',
		device: [ 'radio0' ],
		network: 'lan',
		ssid: 'Test network',
		encryption: 'psk2',
		key: 'correct horse'
	}, overrides || {});
}

test('wireless: a normal AP draft passes the same rules as the backend', function() {
	equal(wireless.validate(draft(), { radios: radios, networks: networks }), []);
});

test('wireless: MLO needs two distinct radios and no ad-hoc mode', function() {
	const one = wireless.validate(draft({ mlo: true }), { radios: radios, networks: networks });
	ok(one.some(function(error) { return /two radios/.test(error); }), 'one radio refused');

	const two = wireless.validate(draft({ mlo: true, device: [ 'radio0', 'radio1' ] }),
		{ radios: radios, networks: networks });
	equal(two, []);

	const duplicate = wireless.validate(draft({ mlo: true, device: [ 'radio0', 'radio0' ] }),
		{ radios: radios, networks: networks });
	ok(duplicate.some(function(error) { return /more than once/.test(error); }), 'duplicate radio refused');

	const adhoc = wireless.validate(draft({ mlo: true, mode: 'adhoc', device: [ 'radio0', 'radio1' ] }),
		{ radios: radios, networks: networks });
	ok(adhoc.some(function(error) { return /MLO/.test(error); }), 'ad-hoc MLO refused');
});

test('wireless: a non-MLO draft must select exactly one radio', function() {
	const errors = wireless.validate(draft({ device: [ 'radio0', 'radio1' ] }),
		{ radios: radios, networks: networks });

	ok(errors.some(function(error) { return /exactly one radio/.test(error); }), 'two radios refused');
});

test('wireless: SSID length is measured in UTF-8 bytes', function() {
	const ten = wireless.validate(draft({ ssid: '中文名称中文名称中文' }),
		{ radios: radios, networks: networks });

	equal(ten, []);

	const tooLong = wireless.validate(draft({ ssid: '中'.repeat(17) }),
		{ radios: radios, networks: networks });

	ok(tooLong.some(function(error) { return /32 bytes/.test(error); }), 'long SSID refused');
});

test('wireless: a new WPA interface needs a valid passphrase, an existing one may keep it', function() {
	const missing = wireless.validate(draft({ key: '' }), { radios: radios, networks: networks });
	ok(missing.some(function(error) { return /passphrase is required/.test(error); }), 'empty key refused');

	const short = wireless.validate(draft({ key: 'short' }), { radios: radios, networks: networks });
	ok(short.some(function(error) { return /8 to 63/.test(error); }), 'short key refused');

	const newline = wireless.validate(draft({ key: 'abcd1234\n' }), { radios: radios, networks: networks });
	ok(newline.some(function(error) { return /8 to 63/.test(error); }), 'trailing newline refused');

	const existing = wireless.defaults({
		section: 'wifimanager_0',
		mode: 'ap',
		device: 'radio0',
		network: 'lan',
		ssid: 'Existing',
		encryption: 'psk2',
		has_key: true
	});

	equal(wireless.validate(existing, { radios: radios, networks: networks }), []);

	const open = wireless.validate(draft({ encryption: 'none', key: '' }),
		{ radios: radios, networks: networks });

	equal(open, []);
});

test('wireless: unknown radios, networks and interface-name collisions are refused', function() {
	const unknownRadio = wireless.validate(draft({ device: [ 'radio9' ] }),
		{ radios: radios, networks: networks });

	ok(unknownRadio.some(function(error) { return /radio9/.test(error); }), 'unknown radio');

	const unknownNetwork = wireless.validate(draft({ network: 'guest' }),
		{ radios: radios, networks: networks });

	ok(unknownNetwork.some(function(error) { return /guest/.test(error); }), 'unknown network');

	const collision = wireless.validate(draft({ ifname: 'wlan0' }), {
		radios: radios,
		networks: networks,
		interfaces: [ { section: 'wifimanager_1', ifname: 'wlan0' } ]
	});

	ok(collision.some(function(error) { return /already in use/.test(error); }), 'ifname collision');
});

test('wireless: defaults never copy a stored key into the browser', function() {
	const entry = {
		section: 'wifimanager_0',
		mode: 'ap',
		device: 'radio0',
		network: 'lan',
		ssid: 'Existing',
		encryption: 'psk2',
		key: 'not-for-the-browser',
		has_key: true,
		hidden: 1,
		ieee80211w: '2'
	};
	const value = wireless.defaults(entry);

	equal(value.key, '');
	equal(value.has_key, true);
	equal(value.hidden, true);
	equal(value.ieee80211w, '2');

	const payload = wireless.payload(value);

	ok(!Object.prototype.hasOwnProperty.call(payload, 'key'), 'blank key is not sent');
	equal(payload.has_key, undefined);
});

test('wireless: the backend validates, backs up, commits and rolls back', function() {
	const source = lib.read(BACKEND);

	includes(source, 'wireless_iface_save_json');
	includes(source, 'wireless_iface_delete_json');
	includes(source, 'radio_check_json');
	includes(source, 'backup_create_auto wireless');
	includes(source, 'wireless_restore_snapshot');
	includes(source, 'wireless_rollback_message');
	includes(source, 'uci -q commit wireless');
	includes(source, 'wireless_wait_iface');
	includes(source, 'wireless_wait_iface() { # section ifname baseline');
	includes(source, 'iface_runtime_forget');
	includes(source, 'wireless_wait_iface "$section"');
	includes(source, 'iw dev 2>/dev/null | awk');
	notIncludes(source, "grep -c '^Interface'");
	includes(source, 'wireless_enable_eht');
	includes(source, 'E-MESH-OWNED');
	includes(source, 'E-CONFIRM');
	includes(source, 'MLO needs at least two radios.');
	includes(source, 'uci set "wireless.$section.mlo=1"');

	notIncludes(source, 'eval ');
	notIncludes(source, 'sh -c');
	lib.notMatch(source, /wm_log[^\n]*\$key/);
	lib.notMatch(source, /wm_log[^\n]*passphrase/);
});

test('wireless: delete verification requires the section to leave both netifd and UCI', function() {
	const source = lib.read(BACKEND);

	includes(source, 'elif ! ip link show "$ifname" >/dev/null 2>&1 &&');
	includes(source, '[ -z "$(uci -q get "wireless.$section")" ]');
});

test('wireless: the interface name is optional and a passphrase rejects control characters', function() {
	const source = lib.read(BACKEND);
	const slice = source.slice(source.indexOf('wireless_valid_key()'),
		source.indexOf('wireless_new_section_name()'));

	includes(slice, '*[[:cntrl:]]*');
	includes(slice, "LC_ALL=C grep -q '[^ -~]'");
	includes(source, 'if [ -n "$ifname" ]; then\n\t\twireless_valid_ifname "$ifname"');
});

test('wireless: the form keeps extra network attachments and reports config-only saves', function() {
	const form = lib.read(FORM);

	includes(form, 'originalNetworks.slice(1)');
	includes(form, "reply.verified === 'config-only'");
	includes(form, 'reply.warnings');
});

test('wireless: mesh-owned and 802.11s sections stay with the Mesh engine', function() {
	const source = lib.read(BACKEND);

	includes(source, 'iface_is_mesh_owned');
	includes(source, '802.11s interfaces are configured in Mesh Settings');
	includes(source, 'this page does not create network sections');

	const form = lib.read(FORM);

	includes(form, 'entry.mesh_owned');
	includes(form, 'A Wireless backup is created before the change.');
});

test('wireless: the interfaces page edits only its own sections', function() {
	const source = lib.read(INTERFACES);

	includes(source, 'wirelessForm.open');
	includes(source, 'wirelessForm.remove');
	includes(source, "'Managed by Mesh'");
	includes(source, 'handleSaveApply: null');
	includes(source, 'handleSave: null');
	includes(source, 'runtime');
});

test('wireless: the MLO page creates standalone links without Mesh', function() {
	const source = lib.read(MLO);

	includes(source, 'wirelessForm.open');
	includes(source, "rpc.radioCheck({");
	includes(source, "mode: entry.mode || 'ap'");
	includes(source, 'mlo: true');
	includes(source, 'entry.mlo');
	includes(source, "'E-ALLOC-02'");
	includes(source, 'Create MLO interface');
	includes(source, 'without using Mesh');
	includes(source, 'entry.mesh_owned');
	includes(source, "'Managed by Mesh'");
	notIncludes(source, 'Enable MLO in Mesh Settings');
});

test('wireless: the editor runs the radio allocation check before saving', function() {
	const form = lib.read(FORM);

	includes(form, 'rpc.radioCheck({');
	includes(form, 'mode: next.mode');
	includes(form, 'device: next.device || []');
	includes(form, 'mlo: !!next.mlo');
	includes(form, 'conflict.severity === \'error\'');
	includes(form, "widgets.confirm(_('Radio concurrency warning')");
	includes(form, "widgets.confirm(_('Radio allocation check')");
	includes(form, 'The interface was not saved. Select different radios or another mode.');
});

test('wireless: diagnostics report signal and station rates', function() {
	const radio = lib.read('root/usr/lib/wifimanager/radio.sh');
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/diagnostics/wireless.js');

	includes(radio, 'iface_station_summary()');
	includes(radio, "printf -- '- - -\\n'");
	includes(radio, 'json_add_string signal');
	includes(radio, 'json_add_string tx_rate');
	includes(radio, 'json_add_string rx_rate');
	includes(view, "label: _('Signal')");
	includes(view, "label: _('TX rate')");
	includes(view, "label: _('RX rate')");
	includes(view, 'format.rate(entry.tx_rate)');
});
