'use strict';

const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, match } = lib;

const RPC = 'htdocs/luci-static/resources/wifimanager/utils/rpc.js';
const MLO_VIEW = 'htdocs/luci-static/resources/view/wifimanager/wifi/mlo.js';
const RADIO_BACKEND = 'root/usr/lib/wifimanager/radio.sh';
const BACKUP_BACKEND = 'root/usr/lib/wifimanager/backup.sh';

test('mlo: RPC exposes the allocation check with an MLO flag', function() {
	const source = lib.read(RPC);

	match(source, /radioCheck:\s*declare\('radio_check',\s*\[[^\]]*'mlo'/,
		'radio_check must accept the mlo flag');
	includes(source, "'mode'");
	includes(source, "'device'");
});

test('mlo: backend rejects an MLO link with fewer than two radios', function() {
	const source = lib.read(RADIO_BACKEND);

	includes(source, 'E-ALLOC-02');
	includes(source, 'MLO needs at least two radios.');
	match(source, /if \[ "\$mlo" = 1 \].*?E-ALLOC-02/s,
		'radio_check must gate E-ALLOC-02 on the mlo flag');
});

test('mlo: MLO and mesh sharing a radio is reported as a warning', function() {
	const source = lib.read(RADIO_BACKEND);

	includes(source, 'W-CONC-03');
	includes(source, 'MLO and mesh');
});

test('mlo: conflict messages interpolate their detail instead of showing %s', function() {
	const source = lib.read(RADIO_BACKEND);

	includes(source, 'json_add_string message "$(printf "$message" $detail)"');
});

test('mlo: the MLO view validates each link through radio_check', function() {
	const source = lib.read(MLO_VIEW);

	includes(source, 'rpc.radioCheck({');
	includes(source, "mode: entry.mode || 'ap'");
	includes(source, 'mlo: true');
	includes(source, "entry.mlo");
	includes(source, "'E-ALLOC-02'");
	notIncludes(source, "mode: 'mlo'");
});

test('mlo: the MLO menu leaf exists and uses the MLO view', function() {
	const entry = lib.menu()['admin/network/wifimanager/wireless/mlo'];

	ok(entry, 'Wireless > MLO menu entry');
	equal(entry.action.type, 'view');
	equal(entry.action.path, 'wifimanager/wifi/mlo');
	ok(lib.exists(MLO_VIEW));
});

test('mlo: wireless backups always include the MLO area', function() {
	const backup = lib.loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js');

	ok(backup.defaultScope('wireless').indexOf('mlo') !== -1);
	ok(backup.defaultScope('full').indexOf('mlo') !== -1);
	equal(backup.affectedFiles([ 'mlo' ]), [ 'wireless' ]);

	includes(lib.read(BACKUP_BACKEND), 'wireless) echo "wireless mlo" ;;');
	includes(lib.read(BACKUP_BACKEND), 'The MLO area requires the Wireless area.');
});
