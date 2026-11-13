'use strict';

const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, match, notMatch } = lib;

const MAKEFILE = 'Makefile';
const RPDC = 'root/usr/libexec/rpcd/wifimanager';
const RPC = 'htdocs/luci-static/resources/wifimanager/utils/rpc.js';

function declaredMethods() {
	const json = lib.read(RPDC);
	const block = json.slice(json.indexOf("cat <<'EOF'") + 11, json.indexOf('EOF\n}'));
	const methods = JSON.parse(block);

	return Object.keys(methods);
}

function rpcMethods() {
	const source = lib.read(RPC);
	const re = /declare\('([a-z_]+)'/g;
	const out = [];
	let match;

	while ((match = re.exec(source)))
		out.push(match[1]);

	return out;
}

test('package: the Makefile carries the 2.0.2 identity and its dependencies', function() {
	const source = lib.read(MAKEFILE);

	includes(source, 'PKG_NAME:=luci-app-wifimanager');
	includes(source, 'PKG_VERSION:=2.0.2');
	includes(source, 'PKG_RELEASE:=1');
	includes(source, 'PKG_LICENSE:=GPL-3.0-only');
	includes(source, 'LUCI_DEPENDS:=+luci-base');
	includes(source, '+kmod-batman-adv');
	includes(source, '+luci-proto-batman-adv');
	includes(source, '+batctl-default');
	includes(source, 'include $(TOPDIR)/feeds/luci/luci.mk');
	includes(source, 'define Package/luci-app-wifimanager/postrm');
});

test('package: the UCI config is a conffile so an upgrade keeps the operator settings', function() {
	const source = lib.read(MAKEFILE);

	includes(source, 'define Package/luci-app-wifimanager/conffiles');
	includes(source, '/etc/config/wifimanager');
	ok(lib.exists('root/etc/config/wifimanager'), 'packaged defaults exist');
});

test('package: the menu has five sections and exactly twenty-one leaves', function() {
	const menu = lib.menu();
	const keys = Object.keys(menu);
	const groups = keys.filter(function(key) { return menu[key].action.type === 'firstchild'; });
	const leaves = keys.filter(function(key) { return menu[key].action.type === 'view'; });

	equal(groups.sort(), [
		'admin/network/wifimanager',
		'admin/network/wifimanager/backup',
		'admin/network/wifimanager/diagnostics',
		'admin/network/wifimanager/mesh',
		'admin/network/wifimanager/roaming',
		'admin/network/wifimanager/wireless'
	]);
	equal(leaves.length, 21);

	const paths = leaves.map(function(key) { return menu[key].action.path; });

	equal(new Set(paths).size, paths.length, 'no duplicate view path');
	for (const path of paths)
		ok(lib.exists('htdocs/luci-static/resources/view/' + path + '.js'), path);
	ok(!menu['admin/network/wifimanager/mesh/backup'], 'no Backup under Mesh');
	equal(menu['admin/network/wifimanager'].title, 'WiFi Manager');
});

test('package: every view file is reachable from the menu', function() {
	const menu = lib.menu();
	const used = new Set();

	for (const key of Object.keys(menu)) {
		if (menu[key].action.path)
			used.add(menu[key].action.path);
	}

	for (const file of lib.listFiles('htdocs/luci-static/resources/view/wifimanager', '.js')) {
		const path = file.replace(/^htdocs\/luci-static\/resources\/view\//, '').replace(/\.js$/, '');

		ok(used.has(path), 'unreachable view: ' + path);
	}
	equal(used.size, 21);
});

test('package: the rpcd plugin, ACL and RPC utils declare the same methods', function() {
	const declared = declaredMethods().sort();
	const scopes = lib.acl();
	const granted = Array.from(new Set([].concat(
		scopes['luci-app-wifimanager'].read.ubus.wifimanager,
		scopes['luci-app-wifimanager'].write.ubus.wifimanager,
		scopes['luci-app-wifimanager-backup'].read.ubus.wifimanager,
		scopes['luci-app-wifimanager-backup'].write.ubus.wifimanager))).sort();
	const used = rpcMethods().sort();
	const rpcd = lib.read(RPDC);

	equal(granted, declared);
	equal(used, declared);
	for (const method of declared)
		includes(rpcd, method + ')', 'dispatch for ' + method);
});

test('package: read and write permissions stay separate', function() {
	const acl = lib.acl();
	const read = acl['luci-app-wifimanager'].read;
	const write = acl['luci-app-wifimanager'].write;
	const backup = acl['luci-app-wifimanager-backup'];

	for (const method of [ 'wireless_iface_save', 'wireless_iface_delete',
		'mesh_apply', 'mesh_disable', 'mesh_dumbap', 'mesh_undumbap', 'roaming_apply' ])
		ok(write.ubus.wifimanager.indexOf(method) !== -1, method + ' is write');

	for (const method of [ 'backup_create', 'backup_delete', 'backup_restore',
		'backup_settings_set', 'backup_import', 'backup_legacy_import', 'backup_export' ]) {
		ok(backup.write.ubus.wifimanager.indexOf(method) !== -1, method + ' is a backup write');
		ok(write.ubus.wifimanager.indexOf(method) === -1, method + ' is not in the main write scope');
	}

	for (const method of [ 'status', 'radio_inventory', 'radio_check', 'network_check',
		'mesh_status', 'mesh_events', 'diagnostics', 'logs', 'op_status' ]) {
		ok(read.ubus.wifimanager.indexOf(method) !== -1, method + ' is readable');
		ok(write.ubus.wifimanager.indexOf(method) === -1, method + ' is not writable');
	}

	for (const method of [ 'backup_list', 'backup_details', 'backup_validate',
		'backup_status', 'backup_settings_get' ]) {
		ok(backup.read.ubus.wifimanager.indexOf(method) !== -1, method + ' is backup-readable');
		ok(backup.write.ubus.wifimanager.indexOf(method) === -1, method + ' is not backup-writable');
	}
});

test('package: the ACL grants no command execution and no broad file access', function() {
	const scopes = lib.acl();
	const acl = scopes['luci-app-wifimanager'];
	const backup = scopes['luci-app-wifimanager-backup'];

	ok(!acl.read.file && !acl.write.file, 'the main scope touches no file directly');
	equal(Object.keys(backup.read.file).sort(),
		[ '/etc/wifimanager/backup/*', '/tmp/wifimanager-download/*' ]);
	equal(Object.keys(backup.write.file).sort(),
		[ '/tmp/wifimanager-upload', '/tmp/wifimanager-upload/*' ]);

	for (const scope of Object.values(scopes)) {
		notIncludes(JSON.stringify(scope), '"exec"');
		notIncludes(JSON.stringify(scope), '/etc/config');
		notIncludes(JSON.stringify(scope), 'file.exec');
		notIncludes(JSON.stringify(scope), 'shell');
	}
});

test('package: views never execute shell commands or write files directly', function() {
	for (const file of lib.listFiles('htdocs/luci-static/resources', '.js')) {
		const source = lib.read(file);

		notMatch(source, /fs\.exec\s*\(/, file);
		notMatch(source, /fs\.write\s*\(/, file);
		notMatch(source, /fs\.remove\s*\(/, file);
		notMatch(source, /child_process/, file);
		notMatch(source, /L\.execute\b/, file);
		notMatch(source, /\beval\s*\(/, file);
		notMatch(source, /new Function/, file);
	}
});

test('package: only the wifimanager and iwinfo ubus objects are called', function() {
	const objects = new Set();
	const re = /object:\s*'([^']+)'/g;
	let match;

	for (const file of lib.listFiles('htdocs/luci-static/resources', '.js')) {
		const source = lib.read(file);

		while ((match = re.exec(source)))
			objects.add(match[1]);
	}

	equal(Array.from(objects).sort(), [ 'iwinfo', 'wifimanager' ]);
});

test('package: the rpcd plugin has no eval and falls back to a refused method', function() {
	const source = lib.read(RPDC);

	notMatch(source, /\beval\b/);
	notMatch(source, /\bsh -c\b/);
	includes(source, 'wm_error E-METHOD "Unknown method."');
	includes(source, 'read_only=1');
	includes(source, 'jget "$args"');
});

test('package: JSON sources are valid and every JS file parses', function() {
	for (const file of [ 'root/usr/share/luci/menu.d/luci-app-wifimanager.json',
		'root/usr/share/rpcd/acl.d/luci-app-wifimanager.json',
		'root/usr/share/rpcd/acl.d/luci-app-wifimanager-backup.json' ])
		lib.json(file);

	for (const file of lib.listFiles('htdocs/luci-static/resources', '.js')) {
		const result = lib.command('node', [ '--check', '-' ], { input: lib.read(file) });

		equal(result.status, 0, file + ': ' + (result.stderr || '').split('\n')[0]);
	}
});

test('package: every LuCI module factory returns a class', function() {
	// require() rejects a factory that returns a plain object ("factory yields
	// invalid constructor"), so each module must return a Class subclass.
	for (const file of lib.listFiles('htdocs/luci-static/resources', '.js')) {
		const source = lib.read(file);

		if (source.indexOf('return baseclass.extend({') !== -1) {
			includes(source, "'require baseclass';", file + ' declares baseclass');
		}
		else if (source.indexOf('return view.extend({') !== -1) {
			includes(source, "'require view';", file + ' declares view');
		}
		else {
			ok(false, file + ' does not return a LuCI class');
		}
	}
});

test('package: every shell script passes sh -n', function() {
	const scripts = lib.listFiles('root', '.sh').concat([
		'root/etc/init.d/wifimanager',
		'root/etc/uci-defaults/90-luci-wifimanager',
		RPDC
	]);

	ok(scripts.length >= 10);

	for (const file of scripts) {
		const result = lib.command('sh', [ '-n', file ]);

		equal(result.status, 0, file + ': ' + (result.stderr || '').split('\n')[0]);
	}
});

test('package: no single file holds the whole application', function() {
	const views = lib.listFiles('htdocs/luci-static/resources/view/wifimanager', '.js');
	const libs = lib.listFiles('htdocs/luci-static/resources/wifimanager/utils', '.js');
	const shells = lib.listFiles('root/usr/lib/wifimanager', '.sh');

	ok(views.length >= 20, 'views are split per page');
	ok(libs.length >= 8, 'JS helpers are split per concern');
	ok(shells.length >= 7, 'shell backends are split per concern');

	for (const file of views.concat(libs, shells)) {
		const lines = lib.read(file).split('\n').length;

		ok(lines < 2000, file + ' has ' + lines + ' lines');
	}
});

test('package: the state directory layout is created with owner-only permissions', function() {
	const defaults = lib.read('root/etc/uci-defaults/90-luci-wifimanager');

	includes(defaults, 'mkdir -p /etc/wifimanager/backup /etc/wifimanager/logs');
	includes(defaults, '/etc/wifimanager/runtime /etc/wifimanager/config');
	includes(defaults, 'chmod 700 /etc/wifimanager /etc/wifimanager/config');
	includes(defaults, 'chmod 600 /etc/wifimanager/logs/wifimanager.log');
});

test('package: passwords never reach the log', function() {
	for (const file of lib.listFiles('root', '.sh')
		.concat([ RPDC, 'root/etc/init.d/wifimanager' ])) {
		const source = lib.read(file);

		notMatch(source, /wm_log[^\n]*\$(?:pass|password|passphrase)\b/, file);
		notMatch(source, /logger[^\n]*\$(?:pass|password|passphrase)\b/, file);
	}
});
