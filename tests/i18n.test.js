'use strict';

const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, notMatch } = lib;

const PO = 'po/zh_Hans/luci-app-wifimanager.po';
const POT = 'po/templates/luci-app-wifimanager.pot';

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function msgids(text) {
	return text.split('\n')
		.filter(function(line) { return line.indexOf('msgid ') === 0; })
		.map(function(line) { return line.slice(6); });
}

function translation(text, quotedId) {
	const re = new RegExp('(?:^|\\n)msgid ' + escapeRegExp(quotedId) + '\\nmsgstr "([^"]*)"');
	const match = text.match(re);

	return match ? match[1] : null;
}

test('i18n: the Simplified Chinese catalog carries the product name 管家', function() {
	const po = lib.read(PO);

	includes(po, 'Language: zh_Hans');
	includes(po, 'Project-Id-Version: luci-app-wifimanager 2.0.3');
	equal(translation(po, '"WiFi Manager"'), 'WiFi管家');
	includes(po, 'WiFi管家');
	notIncludes(po, 'WiFi管理');
});

test('i18n: every menu title is translatable', function() {
	const po = lib.read(PO);
	const pot = lib.read(POT);
	const ids = msgids(po);
	const potIds = msgids(pot);
	const menu = lib.menu();

	for (const key of Object.keys(menu)) {
		const title = menu[key].title;
		const quoted = '"' + title + '"';

		ok(typeof title === 'string', key + ' title');
		ok(ids.indexOf(quoted) !== -1, key + ' title ' + quoted + ' in po');
		ok(potIds.indexOf(quoted) !== -1, key + ' title ' + quoted + ' in pot');
	}
});

test('i18n: the pot and po cover the same message set without duplicates', function() {
	const pot = msgids(lib.read(POT));
	const po = msgids(lib.read(PO));

	equal(pot.length, po.length);
	equal(pot.length, 1266);
	equal(new Set(pot).size, pot.length, 'no duplicate msgids in pot');
	equal(new Set(po).size, po.length, 'no duplicate msgids in po');
	equal(pot.slice().sort(), po.slice().sort());
});

test('i18n: the catalog translates the main interface vocabulary', function() {
	const po = lib.read(PO);
	const translated = (po.match(/^msgstr "[^"]+"/gm) || []).length;
	const total = msgids(po).length - 1;

	ok(translated > 400, 'translated entries: ' + translated);
	ok(translated / total > 0.6, 'translation ratio ' + (translated / total).toFixed(2));
	for (const id of [ '"Overview"', '"Backup & Restore"', '"Diagnostics"',
		'"Wireless"', '"Mesh"', '"Settings"' ]) {
		const value = translation(po, id);

		ok(value && value.length > 0, id + ' translated');
	}
});

test('i18n: every string wrapped in _() is present in the catalog', function() {
	const pot = lib.read(POT);
	const ids = new Set(msgids(pot).map(function(id) {
		return id.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}));
	const files = lib.listFiles('htdocs/luci-static/resources').filter(function(file) {
		return /\.js$/.test(file);
	});

	ok(files.length > 0);

	for (const file of files) {
		const text = lib.read(file);
		const re = /_\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
		let match;

		while ((match = re.exec(text))) {
			const id = match[1].replace(/\\(['\\])/g, '$1');

			ok(ids.has(id), file + ': ' + id);
		}
	}
});

test('i18n: the old product name does not survive in translatable sources', function() {
	const sources = [ PO, POT, 'root/usr/share/luci/menu.d/luci-app-wifimanager.json' ];

	for (const file of sources)
		notIncludes(lib.read(file), 'WiFi管理', file);
});

test('i18n: the READMEs use the documented product names', function() {
	const zh = lib.read('README.md');
	const en = lib.read('README.en.md');
	const notes = lib.read('RELEASE-NOTES-2.0.0.md');

	includes(zh, 'WiFi管家');
	notIncludes(zh, 'WiFi管理');
	includes(en, 'WiFi Manager');
	includes(notes, 'WiFi Manager');
	includes(notes, 'WiFi管家');
});

test('i18n: internal namespaces stay ASCII and unchanged', function() {
	const makefile = lib.read('Makefile');
	const rpcd = lib.read('root/usr/libexec/rpcd/wifimanager');
	const acl = lib.acl();

	includes(makefile, 'PKG_NAME:=luci-app-wifimanager');
	includes(makefile, 'PKG_VERSION:=2.0.3');
	includes(makefile, 'PKG_RELEASE:=1');
	includes(rpcd, '. /usr/lib/wifimanager/common.sh');
	ok(acl['luci-app-wifimanager'], 'ACL namespace');
	ok(lib.menu()['admin/network/wifimanager'], 'menu namespace');

	notMatch(rpcd, /WiFi管家|WiFi管理/);
});

test('i18n: shell and JSON sources carry no Chinese literals', function() {
	const files = [ 'root/usr/lib/wifimanager/backup.sh',
		'root/usr/lib/wifimanager/restore.sh',
		'root/usr/lib/wifimanager/mesh.sh',
		'root/usr/lib/wifimanager/roaming.sh',
		'root/usr/lib/wifimanager/radio.sh',
		'root/usr/share/luci/menu.d/luci-app-wifimanager.json',
		'root/usr/share/rpcd/acl.d/luci-app-wifimanager.json',
		'root/usr/share/rpcd/acl.d/luci-app-wifimanager-backup.json' ];

	for (const file of files)
		notMatch(lib.read(file), /[一-鿿]/, file);
});
