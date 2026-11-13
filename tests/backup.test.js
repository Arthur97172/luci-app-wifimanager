'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, match, notMatch } = lib;

const BACKUP = 'root/usr/lib/wifimanager/backup.sh';
const RPC = 'htdocs/luci-static/resources/wifimanager/utils/rpc.js';
const RPDC = 'root/usr/libexec/rpcd/wifimanager';

test('backup: the UI and backend derive the same default scopes', function() {
	const backup = lib.loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js');
	const source = lib.read(BACKUP);

	equal(backup.defaultScope('full'),
		[ 'wireless', 'mlo', 'mesh', 'backhaul', 'roaming', 'dawn', 'network', 'dhcp', 'firewall', 'system', 'wifimanager' ]);
	equal(backup.defaultScope('wireless'), [ 'wireless', 'mlo' ]);
	equal(backup.defaultScope('mesh'), [ 'mesh', 'backhaul' ]);
	equal(backup.defaultScope('roaming'), [ 'roaming', 'dawn' ]);
	equal(backup.defaultScope('custom'), []);
	equal(backup.defaultScope('unknown'), []);

	includes(source, 'full) echo "wireless mlo mesh backhaul roaming dawn network dhcp firewall system wifimanager" ;;');
	includes(source, 'mesh) echo "mesh backhaul" ;;');
	includes(source, 'roaming) echo "roaming dawn" ;;');
});

test('backup: restore coverage names the real configuration files', function() {
	const backup = lib.loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js');

	equal(backup.affectedFiles(backup.defaultScope('full')),
		[ 'dawn', 'dhcp', 'firewall', 'meshassistant', 'network', 'system', 'wifimanager', 'wireless' ]);
	equal(backup.affectedFiles(backup.defaultScope('mesh')),
		[ 'dhcp', 'firewall', 'meshassistant', 'network', 'wireless' ]);
	ok(backup.touchesConnectivity([ 'mesh' ]));
	ok(!backup.touchesConnectivity([ 'wireless' ]));
	equal(backup.scopeList({ scope: 'wireless mlo' }), [ 'wireless', 'mlo' ]);
	equal(backup.scopeList({ scope: 'bogus' }), []);
});

test('backup: a DAWN-only custom selection restores the wireless file as well', function() {
	const backup = lib.loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js');

	equal(backup.affectedFiles([ 'dawn' ]), [ 'dawn', 'wireless' ]);
	equal(backup.affectedFiles([ 'roaming' ]), [ 'dawn', 'meshassistant', 'wireless' ]);
	equal(backup.scopeWarnings([ 'dawn' ]).length, 1);
	equal(backup.scopeWarnings([ 'dawn', 'roaming', 'wireless' ]), []);
	equal(backup.scopeWarnings([ 'dhcp' ]).length, 1);
	equal(backup.scopeWarnings([ 'firewall' ]).length, 1);
	equal(backup.scopeWarnings([ 'dhcp', 'network' ]), []);
	equal(backup.scopeWarnings([ 'wireless' ]), []);
});

test('backup: custom scope dependencies are enforced on both sides', function() {
	const source = lib.read(BACKUP);
	const validate = source.slice(source.indexOf('backup_validate_scope()'),
		source.indexOf('backup_scope_warnings()'));
	const warnings = source.slice(source.indexOf('backup_scope_warnings()'),
		source.indexOf('backup_physical_interfaces()'));
	const create = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/create.js');

	includes(validate, 'The MLO area requires the Wireless area.');
	includes(validate, 'Mesh/backhaul restore needs the Wireless and Network areas.');
	includes(validate, 'The Roaming area requires the Wireless area.');
	includes(warnings, 'DAWN is selected without Roaming');
	includes(warnings, 'DHCP/DNS or Firewall is selected without Network');
	includes(source, 'backup_scope_warnings "$type" "$scope"');
	includes(create, 'backup.scopeWarnings(currentScope())');
	includes(create, 'The Roaming area requires the Wireless area.');
});

test('backup: manifests carry format, application and firmware identity', function() {
	const source = lib.read(BACKUP);

	includes(source, 'WM_BACKUP_FORMAT=1');
	includes(source, 'WM_BACKUP_APP="luci-app-wifimanager"');
	for (const field of [ 'backup_format_version', 'application', 'application_version',
		'created_at', 'backup_type', 'backup_scope', 'firmware', 'hostname',
		'description', 'radios', 'interfaces', 'encrypted', 'files' ]) {
		includes(source, field, 'manifest field ' + field);
	}
	includes(source, 'json_add_string path "$(uci -q get "wireless.$radio.path")"');
	includes(source, 'for fw in $(backup_physical_interfaces); do');
});

test('backup: the manifest records physical interface names only', function() {
	const source = lib.read(BACKUP);
	const list = source.slice(source.indexOf('backup_physical_interfaces()'),
		source.indexOf('backup_compat_warnings()'));

	includes(list, '/sys/class/net/*');
	includes(list, 'lo|bat*|br-*');
	includes(list, '*|wg*|ppp*|mlo*');
	includes(source, 'json_add_array interfaces');
});

test('backup: archives and checksums are written with owner-only permissions', function() {
	const source = lib.read(BACKUP);

	includes(source, 'chmod 700 "$dir"');
	includes(source, 'chmod 600 "$dir/$id"');
	includes(source, 'chmod 600 "$dir/$id.sha256"');
	includes(source, 'chmod 600 "$dir/.tmp.$$"');
	includes(source, 'chmod 600 "$(backup_dir)/$newid"');
});

test('backup: the list reports format and firmware version for every archive', function() {
	const source = lib.read(BACKUP);

	includes(source, 'json_add_int format "${fmt:-0}"');
	includes(source, 'json_add_string firmware_version "$fw_ver"');
	includes(source, 'json_add_int format 0');
	includes(source, 'json_add_boolean legacy 1');
});

test('backup: encrypted archives stay listed through a manifest sidecar', function() {
	const source = lib.read(BACKUP);
	const meta = source.slice(source.indexOf('backup_meta_json_fields()'),
		source.indexOf('backup_list_json()'));
	const list = source.slice(source.indexOf('backup_list_json()'),
		source.indexOf('backup_compare_config()'));
	const create = source.slice(source.indexOf('backup_create_core()'),
		source.indexOf('backup_record_auto_result()'));
	const remove = source.slice(source.indexOf('backup_delete_json()'),
		source.indexOf('backup_meta_json_fields()'));

	// Creation writes the manifest beside the ciphertext with owner-only mode.
	includes(create, 'cp "$tmp/manifest.json" "$dir/$id.meta.json"');
	includes(create, 'chmod 600 "$dir/$id.meta.json"');

	// The list falls back to the sidecar, then to a blank record with the file
	// time, so old encrypted archives are never silently dropped.
	includes(meta, 'cat "$archive.meta.json"');
	includes(list, 'manifest=$(backup_meta_json_fields "$file")');
	includes(list, "*.enc) manifest='{\"encrypted\":true}' ;;");
	includes(list, 'date -r "$file"');

	// Deleting removes the sidecar with the archive.
	includes(remove, '"$dir/$id.meta.json"');

	// Validation, restore and export already take the id; .enc ids must pass.
	includes(source, 'wifimanager-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9]*.tar.enc) ;;');
});

test('backup: importing an encrypted upload takes a passphrase and stores it as .enc', function() {
	const source = lib.read(BACKUP);
	const imported = source.slice(source.indexOf('backup_import()'), source.indexOf('backup_legacy_import()'));
	const rpcd = lib.read(RPDC);
	const rpc = lib.read(RPC);
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/restore.js');

	includes(imported, 'if ! tar -tf "$path" >/dev/null 2>&1; then');
	includes(imported, 'The uploaded archive is larger than 16 MiB.');
	includes(imported, 'wm_error E-PASS "This backup is encrypted; a passphrase is required."');
	includes(imported, 'backup_decrypt_file "$path" "$dec" "$password"');
	includes(imported, 'id="${id%.tar}.enc"');
	includes(imported, 'cp "$tmp/manifest.json" "$dir/$id.meta.json"');
	includes(rpcd, '"backup_import": { "path": "string", "password": "string" }');
	includes(rpcd, 'backup_import "$path" "@$passfile"');
	includes(rpc, "backupImport: declare('backup_import', [ 'path', 'password' ])");
	includes(view, "err.code !== 'E-PASS'");
	includes(view, 'rpc.backupImport(UPLOAD_PATH, password)');
});

test('backup: age-based pruning treats encrypted archives like plain ones', function() {
	const source = lib.read(BACKUP);
	const prune = source.slice(source.indexOf('backup_prune()'), source.indexOf('backup_create_core()'));

	lib.notMatch(prune, /\*\.enc\) continue/);
	includes(prune, 'retention_days');
	includes(prune, 'backup_remove_file "$file"');
	includes(source, 'backup_remove_file() {');
	includes(source, 'rm -f "$1" "$1.sha256" "$1.meta.json"');
});

test('backup: uploads are accepted only from the upload directory', function() {
	const source = lib.read(BACKUP);
	const imported = source.slice(source.indexOf('backup_import()'), source.indexOf('backup_legacy_import()'));

	includes(source, '/tmp/wifimanager-upload/*');
	includes(source, 'Uploads are only accepted from the upload directory.');
	includes(source, 'Invalid upload path.');
	includes(imported, 'This backup is encrypted; a passphrase is required.');
	includes(imported, 'The passphrase is wrong or the archive is damaged.');
});

test('backup: download copies to a fixed directory and grants no storage read', function() {
	const source = lib.read(BACKUP);
	const acl = lib.acl();

	includes(source, 'backup_export_json()');
	includes(source, 'dir="/tmp/wifimanager-download"');
	includes(source, 'dest="$dir/$id"');
	includes(source, 'Legacy backups are not exported');
	includes(source, 'chmod 600 "$dir/.tmp.$$"');

	equal(Object.keys(acl['luci-app-wifimanager-backup'].read.file).sort(),
		[ '/etc/wifimanager/backup/*', '/tmp/wifimanager-download/*' ]);
	equal(Object.keys(acl['luci-app-wifimanager-backup'].write.file).sort(),
		[ '/tmp/wifimanager-upload', '/tmp/wifimanager-upload/*' ]);
	ok(!acl['luci-app-wifimanager'].read.file, 'the main scope gets no backup file access');
	ok(!acl['luci-app-wifimanager'].write.file, 'the main scope gets no upload directory');
});

test('backup: every backup RPC method is declared, dispatched and granted', function() {
	const rpc = lib.read(RPC);
	const rpcd = lib.read(RPDC);
	const acl = lib.acl();
	const methods = acl['luci-app-wifimanager'].read.ubus.wifimanager
		.concat(acl['luci-app-wifimanager'].write.ubus.wifimanager,
			acl['luci-app-wifimanager-backup'].read.ubus.wifimanager,
			acl['luci-app-wifimanager-backup'].write.ubus.wifimanager);

	for (const method of [ 'backup_list', 'backup_details', 'backup_validate', 'backup_status',
		'backup_settings_get', 'backup_storage', 'backup_settings_set', 'backup_create', 'backup_delete',
		'backup_restore', 'backup_import', 'backup_legacy_import', 'backup_export' ]) {
		includes(rpcd, '"' + method + '"', 'rpcd method ' + method);
		includes(rpcd, method + ')', 'rpcd dispatch ' + method);
		ok(methods.indexOf(method) !== -1, 'ACL method ' + method);
	}

	includes(rpc, 'backupExport');
	includes(rpc, 'backupLegacyImport');
	includes(rpc, 'backupSettingsSet');
});

test('backup: settings validate range and path before writing UCI', function() {
	const source = lib.read(BACKUP);

	includes(source, 'before_change|daily|weekly|manual');
	includes(source, 'max_count must be between 1 and 200.');
	includes(source, 'max_size_mb must be between 4 and 4096.');
	includes(source, '/etc/*|/mnt/*|/media/*|/tmp/*');
	includes(source, 'backup_path_is_valid');
	includes(source, 'case "$p" in');
});

test('backup: backup pages use the RPC-backed settings, not a form that commits blindly', function() {
	const settings = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/settings.js');
	const create = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/create.js');

	includes(settings, 'rpc.backupSettingsSet(');
	includes(settings, 'const field = widgets.field;');
	includes(create, 'rpc.backupCreate(');
	includes(create, 'rpc.backupStatus()');
	notIncludes(settings, 'form.Map');
	notIncludes(create, 'form.Map');
});

test('backup: a Wireless-scope archive needs only the wireless file', function() {
	const source = lib.read(BACKUP);

	includes(source, 'archived=0');
	includes(source, '&& archived=1');
	includes(source, '[ "$archived" = 1 ] || {');
	includes(source, 'wireless mlo');
	lib.notMatch(source, /\[ -f "\$WM_CONFIG_DIR\/etc\/config\/network" \]/);
	lib.notMatch(source, /\[ ! -f [^\n]*etc\/config\/network/);
});

test('backup: encrypted archives are never silently dropped or logged with a passphrase', function() {
	const source = lib.read(BACKUP);

	match(source, /openssl/);
	notMatch(source, /wm_log[^\n]*\$password/);
	notMatch(source, /wm_log[^\n]*passphrase/);
	includes(source, 'The passphrase is wrong or the archive is damaged.');
});

test('backup: the backup scope is independent and least-privilege', function() {
	const acl = lib.acl()['luci-app-wifimanager-backup'];
	const main = lib.acl()['luci-app-wifimanager'];
	const menu = lib.menu();
	const backupMethods = [ 'backup_list', 'backup_details', 'backup_validate', 'backup_status',
		'backup_settings_get', 'backup_storage', 'backup_settings_set', 'backup_create', 'backup_delete',
		'backup_restore', 'backup_import', 'backup_legacy_import', 'backup_export' ];
	const read = acl.read.ubus.wifimanager;
	const write = acl.write.ubus.wifimanager;

	for (const method of read.concat(write))
		ok(backupMethods.indexOf(method) !== -1 || method === 'status' || method === 'op_status',
			method + ' is a backup or status method');

	for (const method of write)
		ok(method.indexOf('backup_') === 0, method + ' is a backup write');

	ok(!main.read.ubus.wifimanager.concat(main.write.ubus.wifimanager).some(function(method) {
		return method.indexOf('backup_') === 0;
	}), 'the main scope holds no backup method');

	ok(!menu['admin/network/wifimanager'].depends.acl,
		'the section root is visible to either scope');
	for (const key of [ 'admin/network/wifimanager/backup',
		'admin/network/wifimanager/backup/overview', 'admin/network/wifimanager/backup/create',
		'admin/network/wifimanager/backup/restore', 'admin/network/wifimanager/backup/settings' ]) {
		equal(JSON.stringify(menu[key].depends.acl), JSON.stringify([ 'luci-app-wifimanager-backup' ]),
			key + ' depends on the backup scope alone');
	}
	ok(!JSON.stringify(menu['admin/network/wifimanager/overview'].depends.acl).includes('luci-app-wifimanager-backup'),
		'the main pages do not require the backup scope');

	ok(!acl.write.uci, 'no direct UCI write through the backup scope');
	equal(acl.read.uci, [ 'wifimanager' ]);
});

test('backup: external storage is discovered from the mount table', function() {
	const source = lib.read(BACKUP);
	const settings = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/settings.js');

	includes(source, 'backup_storage_json() {');
	includes(source, 'backup_mount_of() {');
	includes(source, 'backup_fstype() {');
	includes(source, '</proc/mounts');
	includes(source, 'json_add_array candidates');
	includes(source, 'json_add_boolean volatile');
	includes(source, 'No external storage is mounted at this path');
	includes(settings, 'rpc.backupStorage()');
	includes(settings, 'No external storage is mounted at this location');
	includes(settings, 'pathHasMount');
});

test('backup: the backup status names the filesystem and the external flag', function() {
	const source = lib.read(BACKUP);
	const status = source.slice(source.indexOf('backup_status_json()'),
		source.indexOf('backup_validate_json'));

	for (const field of [ 'mount', 'external', 'writable' ])
		includes(status, 'json_add_' + (field === 'mount' ? 'string' : 'boolean') + ' ' + field);
});

test('backup: encryption uses PBKDF2-SHA256 with a high iteration count', function() {
	const source = lib.read(BACKUP);

	includes(source, 'WM_BACKUP_ENC_ITER=200000');
	includes(source, 'backup_encrypt_file() {');
	includes(source, 'backup_decrypt_file() {');
	match(source, /openssl enc -aes-256-cbc -pbkdf2 -iter "\$WM_BACKUP_ENC_ITER" -md sha256/);
	// The fallback keeps archives written by an earlier release restorable.
	match(source, /openssl enc -d -aes-256-cbc -pbkdf2 -pass stdin/);
	includes(source, 'encryption round-trip verification failed');
});

test('backup: a new passphrase needs at least twelve characters on both sides', function() {
	const source = lib.read(BACKUP);
	const create = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/create.js');

	includes(source, '[ "${#password}" -ge 12 ]');
	includes(source, 'Use a passphrase of at least 12 characters.');
	includes(create, 'values.password.length < 12');
	includes(create, 'At least 12 characters.');
});

test('backup: the encrypt default is stored, returned and preselected', function() {
	const source = lib.read(BACKUP);
	const settings = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/settings.js');
	const create = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/create.js');
	const rpc = lib.read(RPC);

	includes(source, 'encrypt_default');
	includes(source, 'json_add_boolean encrypt_default');
	includes(rpc, "'encrypt_default'");
	includes(settings, 'encrypt_default: encryptBox.input.checked');
	includes(create, 'settings.encrypt_default');
});

test('backup: the lists show the archive description', function() {
	const overview = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/overview.js');
	const create = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/create.js');

	includes(overview, "{ label: _('Description') }");
	includes(overview, 'entry.description');
	// The hint on the create form has to match what the lists really render.
	includes(create, 'Stored in the archive manifest and shown in the list.');
});

test('backup: the overview and create pages separate this backup from Sysupgrade', function() {
	const overview = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/overview.js');
	const create = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/create.js');

	for (const [ name, view ] of [ [ 'overview', overview ], [ 'create', create ] ]) {
		includes(view, "card(_('WiFi Manager Backup or OpenWrt Sysupgrade Backup?')", name);
		includes(view, 'OpenWrt Sysupgrade Backup is a separate mechanism', name);
		includes(view, 'can make this page unreachable', name);
		includes(view, 'it is not a system image', name);
	}
});

test('backup: the last automatic backup result is recorded and shown', function() {
	const source = lib.read(BACKUP);
	const overview = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/overview.js');
	const status = source.slice(source.indexOf('backup_status_json()'),
		source.indexOf('backup_validate_json'));

	includes(source, 'backup_record_auto_result() {');
	includes(source, 'last-auto-result');
	includes(source, 'backup_record_auto_result success');
	includes(source, 'backup_record_auto_result failure');
	includes(source, 'chmod 600 "$tmp"');
	for (const field of [ 'auto_result', 'auto_result_time', 'auto_result_description' ])
		includes(status, 'json_add_' + (field === 'auto_result_time' ? 'int' : 'string') + ' ' + field);

	includes(overview, "_('Last automatic backup result'), autoResultText(status)");
	includes(overview, 'status.auto_result');
	includes(overview, "badge(_('Succeeded'), 'ok')");
	includes(overview, "badge(_('Failed'), 'error')");
	includes(overview, 'The last automatic backup failed');
});

test('backup: MLO is part of the wireless type, not a separate type', function() {
	const backup = lib.loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js');
	const source = lib.read(BACKUP);

	equal(backup.typeName('wireless'), 'Wireless (includes MLO)');
	ok(backup.defaultScope('wireless').indexOf('mlo') !== -1, 'wireless includes MLO');
	equal(backup.defaultScope('mlo').length, 0, 'there is no MLO backup type');
	includes(source, 'full|wireless|mesh|roaming|custom');
});

/*
 * The three simulations below cover the DESIGN §17.5 behaviours that can be
 * run on a development machine: a damaged archive is refused before a
 * restore, a full filesystem fails the creation without touching the existing
 * archives, and pruning enforces the retention limits without orphaning
 * checksum files.  They source the real modules and run them with sh, so the
 * shell code itself is exercised, not only its text.
 */

function shellModules(dir) {
	const files = [ 'root/usr/lib/wifimanager/common.sh',
		'root/usr/lib/wifimanager/capabilities.sh',
		'root/usr/lib/wifimanager/radio.sh',
		'root/usr/lib/wifimanager/restore.sh',
		BACKUP ];
	const combined = files.map(function(rel) {
		return lib.read(rel).split('\n').filter(function(line) {
			return line.indexOf('. /usr/') !== 0;
		}).join('\n');
	}).join('\n');
	const file = path.join(dir, 'modules.sh');

	fs.writeFileSync(file, combined);
	return file;
}

function archiveNames(dir) {
	return fs.readdirSync(dir).filter(function(name) {
		return /\.tar(\.enc)?$/.test(name);
	}).sort();
}

function checkNoOrphans(dir) {
	for (const name of archiveNames(dir))
		ok(fs.existsSync(path.join(dir, name + '.sha256')), 'checksum for ' + name);
	for (const name of fs.readdirSync(dir).filter(function(name) {
		return name.endsWith('.sha256');
	}))
		ok(fs.existsSync(path.join(dir, name.replace(/\.sha256$/, ''))), 'archive for ' + name);
}

const DAMAGE_DRIVER = `#!/bin/sh
set -u
MODULES="$1"
WORK="$2"
. "$MODULES"

failures=0
check() {
	if [ "$2" = "$3" ]; then
		echo "ok: $1"
	else
		echo "FAIL: $1: expected [$2], got [$3]"
		failures=$((failures + 1))
	fi
}
fail() {
	echo "FAIL: $1"
	failures=$((failures + 1))
}

mkdir -p "$WORK/good/etc/config" "$WORK/bad/etc/config" "$WORK/evil/etc/config"
printf 'config wifi-device radio0\\n' > "$WORK/good/etc/config/wireless"
printf '{"backup_format_version":1,"application":"luci-app-wifimanager"}\\n' > "$WORK/good/manifest.json"
sha256sum "$WORK/good/etc/config/wireless" |
	sed "s#  $WORK/good/#  #" > "$WORK/good/checksums.txt"
tar -cf "$WORK/good.tar" -C "$WORK/good" manifest.json checksums.txt etc/config

cp "$WORK/good/manifest.json" "$WORK/bad/"
cp "$WORK/good/checksums.txt" "$WORK/bad/"
printf 'config wifi-device radio0\\n\\toption disabled 1\\n' > "$WORK/bad/etc/config/wireless"
tar -cf "$WORK/bad.tar" -C "$WORK/bad" manifest.json checksums.txt etc/config

cp "$WORK/good/manifest.json" "$WORK/evil/"
cp "$WORK/good/checksums.txt" "$WORK/evil/"
printf 'config x\\n' > "$WORK/evil/etc/config/not-a-known-file"
tar -cf "$WORK/evil.tar" -C "$WORK/evil" manifest.json checksums.txt etc/config

before=$(ls -d /tmp/wifimanager-verify.* 2>/dev/null | wc -l)

out=$(backup_extract "$WORK/good.tar" 2>"$WORK/good.err")
check "a valid archive extracts" 1 "$([ -n "$out" ] && [ -f "$out/etc/config/wireless" ] && echo 1 || echo 0)"
[ -n "$out" ] && rm -rf "$out"

out=$(backup_extract "$WORK/bad.tar" 2>"$WORK/bad.err")
check "a checksum mismatch is refused" 1 "$([ -z "$out" ] && echo 1 || echo 0)"
grep -q "Checksum verification failed." "$WORK/bad.err" &&
	echo "ok: the failure names the checksum" ||
	fail "the failure names the checksum"

out=$(backup_extract "$WORK/evil.tar" 2>"$WORK/evil.err")
check "an unknown archive entry is refused" 1 "$([ -z "$out" ] && echo 1 || echo 0)"
grep -q "unexpected or unsafe entries" "$WORK/evil.err" &&
	echo "ok: the failure names the unsafe entry" ||
	fail "the failure names the unsafe entry"

after=$(ls -d /tmp/wifimanager-verify.* 2>/dev/null | wc -l)
check "failed extractions leave no temp directory" "$before" "$after"

if [ "$failures" != 0 ]; then
	echo "$failures extraction check(s) failed"
	exit 1
fi
echo "damaged archive simulation passed"
exit 0
`;

test('backup: a damaged archive is refused before anything is restored', function() {
	const source = lib.read(BACKUP);
	const validate = source.slice(source.indexOf('backup_validate_json()'),
		source.indexOf('backup_details_json()'));
	const restore = source.slice(source.indexOf('backup_restore_worker()'),
		source.indexOf('backup_import()'));

	// The same extraction (and checksum verification) runs in validation and in
	// the restore worker, and both stop before a configuration file is touched.
	includes(validate, 'extracted=$(backup_extract "$archive" "$password" 2>/dev/null)');
	includes(validate, 'The archive failed validation');
	includes(restore, 'extracted=$(backup_extract "$BACKUP_FILE" "$password" 2>&1)');
	includes(restore, 'wm_op_finish failed "$extracted"; return 1');
	includes(source, 'backup_verify_checksums "$tmp"');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-damage-'));
	const modules = shellModules(dir);
	const work = path.join(dir, 'work');

	fs.mkdirSync(work);
	fs.writeFileSync(path.join(dir, 'driver.sh'), DAMAGE_DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'), modules, work ]);

		equal(result.status, 0, 'damage simulation:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'damaged archive simulation passed');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const SPACE_DRIVER = `#!/bin/sh
set -u
MODULES="$1"
STORE="$2"
CFG="$3"
LOG="$4"
. "$MODULES"

WM_CONFIG_DIR="$CFG"
backup_dir() { printf '%s\\n' "$STORE"; }
wm_free_kb() { echo 100; }
wm_log() { printf '%s\\n' "$*" >> "$LOG"; }

mkdir -p "$STORE"
printf 'existing\\n' > "$STORE/wifimanager-20260101-000000.tar"
printf 'existing\\n' > "$STORE/wifimanager-20260101-000000.tar.sha256"

backup_create_core full 'wireless mesh' "Before a change"
rc=$?
echo "rc=$rc"
echo "files=$(find "$STORE" -maxdepth 1 -type f | wc -l)"
echo "temps=$(find "$STORE" -maxdepth 1 -name '.tmp.*' | wc -l)"
exit 0
`;

test('backup: a full filesystem fails the creation without touching existing backups', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-space-'));
	const modules = shellModules(dir);
	const store = path.join(dir, 'store');
	const cfg = path.join(dir, 'config');
	const log = path.join(dir, 'wm.log');

	fs.mkdirSync(cfg);
	fs.writeFileSync(path.join(cfg, 'wireless'), 'config wifi-device radio0\n');
	fs.writeFileSync(path.join(dir, 'driver.sh'), SPACE_DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'),
			modules, store, cfg, log ]);

		equal(result.status, 0, 'space simulation:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'rc=1', 'the creation reports failure');
		includes(result.stdout, 'files=2', 'only the pre-existing archive remains');
		includes(result.stdout, 'temps=0', 'no temporary archive was left behind');
		includes(fs.readFileSync(log, 'utf8'), 'not enough free space');
		equal(archiveNames(store), [ 'wifimanager-20260101-000000.tar' ]);
		checkNoOrphans(store);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const PRUNE_DRIVER = `#!/bin/sh
set -u
MODULES="$1"
STORE="$2"
MAX_COUNT="$3"
MAX_SIZE="$4"
RETENTION="$5"
. "$MODULES"

backup_conf() {
	case "$1" in
		max_count) echo "$MAX_COUNT" ;;
		max_size_mb) echo "$MAX_SIZE" ;;
		retention_days) echo "$RETENTION" ;;
		*) echo "$2" ;;
	esac
}

backup_prune "$STORE"
exit 0
`;

function writeArchive(dir, name, bytes) {
	const file = path.join(dir, name);

	fs.writeFileSync(file, Buffer.alloc(bytes, 'x'));
	fs.writeFileSync(file + '.sha256', 'hash  ' + name + '\n');
	return file;
}

test('backup: pruning enforces every limit without orphaning checksums', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-prune-'));
	const modules = shellModules(dir);
	const driver = path.join(dir, 'driver.sh');

	fs.writeFileSync(driver, PRUNE_DRIVER);

	const runPrune = function(store, count, size, retention) {
		return lib.command('sh', [ driver, modules, store, count, size, retention ]);
	};

	try {
		// Count limit: the oldest archives and their checksums go.
		const countDir = path.join(dir, 'count');
		const names = [ 'wifimanager-20260101-000000.tar', 'wifimanager-20260102-000000.tar',
			'wifimanager-20260103-000000.tar', 'wifimanager-20260104-000000.tar',
			'wifimanager-20260105-000000.tar' ];

		fs.mkdirSync(countDir);
		for (const name of names)
			writeArchive(countDir, name, 32);

		let result = runPrune(countDir, '3', '64', '0');

		equal(result.status, 0, 'count prune:\n' + result.stdout + result.stderr);
		equal(archiveNames(countDir), names.slice(2));
		for (const name of names.slice(0, 2)) {
			ok(!fs.existsSync(path.join(countDir, name)), name + ' was removed');
			ok(!fs.existsSync(path.join(countDir, name + '.sha256')), name + '.sha256 was removed');
		}
		checkNoOrphans(countDir);

		// Running it again is a no-op: repeated pruning neither loses nor keeps
		// a stale archive.
		result = runPrune(countDir, '3', '64', '0');
		equal(result.status, 0, 'second count prune:\n' + result.stdout + result.stderr);
		equal(archiveNames(countDir), names.slice(2));
		checkNoOrphans(countDir);

		// Size limit: with 600 KiB archives and a 1 MiB budget only the newest
		// one can stay.
		const sizeDir = path.join(dir, 'size');
		const sizeNames = [ 'wifimanager-20260201-000000.tar',
			'wifimanager-20260202-000000.tar', 'wifimanager-20260203-000000.tar' ];

		fs.mkdirSync(sizeDir);
		for (const name of sizeNames)
			writeArchive(sizeDir, name, 600 * 1024);

		result = runPrune(sizeDir, '10', '1', '0');
		equal(result.status, 0, 'size prune:\n' + result.stdout + result.stderr);
		equal(archiveNames(sizeDir), [ sizeNames[2] ]);
		checkNoOrphans(sizeDir);

		// Age limit: old archives expire.  An encrypted archive ages by its
		// modification time like any other, and its manifest sidecar goes with it.
		const ageDir = path.join(dir, 'age');

		fs.mkdirSync(ageDir);
		const oldTar = writeArchive(ageDir, 'wifimanager-20200101-000000.tar', 32);
		const oldEnc = writeArchive(ageDir, 'wifimanager-20200101-000000.tar.enc', 32);
		const newTar = writeArchive(ageDir, 'wifimanager-20260101-000000.tar', 32);
		const old = new Date('2020-01-01T00:00:00Z');

		fs.writeFileSync(oldEnc + '.meta.json', '{}');
		fs.utimesSync(oldTar, old, old);
		fs.utimesSync(oldTar + '.sha256', old, old);
		fs.utimesSync(oldEnc, old, old);
		fs.utimesSync(oldEnc + '.sha256', old, old);
		fs.utimesSync(oldEnc + '.meta.json', old, old);

		result = runPrune(ageDir, '10', '100', '30');
		equal(result.status, 0, 'age prune:\n' + result.stdout + result.stderr);
		equal(archiveNames(ageDir), [ 'wifimanager-20260101-000000.tar' ]);
		ok(!fs.existsSync(oldTar), 'the expired archive was removed');
		ok(!fs.existsSync(oldTar + '.sha256'), 'its checksum was removed');
		ok(!fs.existsSync(oldEnc), 'the expired encrypted archive was removed');
		ok(!fs.existsSync(oldEnc + '.meta.json'), 'its manifest sidecar was removed');
		ok(fs.existsSync(newTar), 'the new archive stays');
		checkNoOrphans(ageDir);
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('backup: the worker ticker samples roaming every 15 s and runs the backup timer every fourth pass', function() {
	const worker = lib.read('root/usr/lib/wifimanager/worker.sh');
	const ticker = worker.slice(worker.indexOf('ticker)'),
		worker.indexOf('mesh_apply|mesh_disable|dumbap_enable'));

	includes(ticker, 'roaming_events_sample');
	includes(ticker, 'if [ "$tick" -eq 0 ]; then');
	includes(ticker, 'dawn_watchdog_once');
	includes(ticker, 'backup_tick');
	includes(ticker, '[ "$tick" -ge 4 ] && tick=0');
	includes(ticker, 'sleep 15');
	includes(worker, 'events)');
	includes(worker, 'backup_tick)');
});
