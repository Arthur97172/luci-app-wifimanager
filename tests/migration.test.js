'use strict';

const lib = require('./lib');
const { test, ok, includes, notIncludes, notMatch } = lib;

const BACKUP = 'root/usr/lib/wifimanager/backup.sh';
const MIGRATION = 'root/usr/lib/wifimanager/migration.sh';
const RPDC = 'root/usr/libexec/rpcd/wifimanager';
const DEFAULTS = 'root/etc/uci-defaults/90-luci-wifimanager';
const MAKEFILE = 'Makefile';
const OVERVIEW = 'htdocs/luci-static/resources/view/wifimanager/overview.js';
const WORKER = 'root/usr/lib/wifimanager/worker.sh';

test('migration: legacy Mesh Assistant backups are read from their own directory', function() {
	const source = lib.read(BACKUP);

	includes(source, 'WM_LEGACY_BACKUP_DIR="/etc/meshassistant/backup"');
	includes(source, 'validate_legacy_id()');
	includes(source, 'BACKUP_IS_LEGACY=1');
});

test('migration: a legacy archive is converted on read, never rewritten', function() {
	const source = lib.read(BACKUP);

	includes(source, '# Convert the legacy line manifest on read; never rewrite the archive.');
	includes(source, 'json_add_int backup_format_version 0');
	includes(source, 'json_add_string application "luci-app-meshassistant"');
	includes(source, 'json_add_string backup_type legacy');
	includes(source, 'json_add_boolean legacy 1');
});

test('migration: legacy archives are listed only when the operator asks and legacy support is on', function() {
	const source = lib.read(BACKUP);
	const list = source.slice(source.indexOf('backup_list_json()'), source.indexOf('backup_details_json'));

	includes(list, 'legacy_enabled=$(backup_conf legacy_enabled 1)');
	includes(list, 'if [ "$include_legacy" = 1 ] && [ "$legacy_enabled" = 1 ] && [ -d "$legacy_dir" ]; then');
	includes(list, 'json_add_string type legacy');
	includes(list, 'json_add_int format 0');
});

test('migration: deleting and pruning can never remove a legacy archive', function() {
	const source = lib.read(BACKUP);
	const del = source.slice(source.indexOf('backup_delete_json()'), source.indexOf('# Listing and details'));
	const prune = source.slice(source.indexOf('backup_prune()'), source.indexOf('backup_create_core()'));

	notIncludes(del, 'WM_LEGACY_BACKUP_DIR');
	notIncludes(del, 'legacy_dir');
	notIncludes(prune, 'WM_LEGACY_BACKUP_DIR');
	notIncludes(prune, 'legacy_dir');
	notMatch(source, /rm -[rf]+ [^\n]*\$\{?WM_LEGACY_BACKUP_DIR/);
	notMatch(source, /rm -[rf]+ [^\n]*\$legacy_dir/);
	includes(source, '# Age-based removal first (never touches legacy archives).');
});

test('migration: importing a legacy archive copies it and leaves the original in place', function() {
	const source = lib.read(BACKUP);
	const start = source.indexOf('backup_legacy_import()');
	const legacy = source.slice(start, source.indexOf('# ---', start));

	includes(legacy, 'src="$WM_LEGACY_BACKUP_DIR/$id"');
	includes(legacy, 'tmp=$(backup_extract "$src" "" 2>/dev/null)');
	includes(legacy, 'newid="wifimanager-$stamp.tar"');
	includes(legacy, 'backup_write_manifest "$tmp" "$newid" legacy "mesh" "Imported legacy Mesh Assistant backup"');
	includes(legacy, 'mv "$(backup_dir)/.tmp.$$" "$(backup_dir)/$newid"');
	includes(legacy, 'chmod 600 "$(backup_dir)/$newid"');
	notIncludes(legacy, 'rm -f "$src"');
	notIncludes(legacy, 'mv "$src"');
});

test('migration: uploading a legacy archive through the new import path is refused', function() {
	const source = lib.read(RPDC);
	const backup = lib.read(BACKUP);
	const imported = backup.slice(backup.indexOf('backup_import()'), backup.indexOf('backup_legacy_import()'));

	// A legacy archive carries no manifest.json and no checksums, so the new
	// import path refuses it; the copy action goes through legacy_import.
	includes(imported, 'The uploaded file is not a valid WiFi Manager backup.');
	includes(imported, 'The uploaded archive has no manifest.');
	includes(source, 'backup_legacy_import "$(jget "$args" \'@.id\')"');
});

test('migration: first install only writes missing options and keeps every config file', function() {
	const source = lib.read(DEFAULTS);

	includes(source, 'Nothing here deletes or rewrites a user\'s configuration.');
	includes(source, '[ -n "$(uci -q get "wifimanager.backup.$key")" ] ||');
	includes(source, 'require_pre_restore=1');
	includes(source, 'legacy_enabled=1');
	notIncludes(source, 'rm -f /etc/config/meshassistant');
	notIncludes(source, 'rm -rf /etc/config');
	notIncludes(source, 'uci -q delete');
});

test('migration: the Mesh Assistant daemon is stopped but its configuration stays', function() {
	const source = lib.read(DEFAULTS);

	includes(source, '/etc/init.d/meshassistant disable');
	includes(source, '/etc/init.d/meshassistant stop');
	includes(source, 'uci set wifimanager.settings.legacy_service_disabled=1');
	includes(source, 'keep its configuration and its backups');
	includes(source, 'uci set meshassistant.config=\'meshassistant\'');
});

test('migration: preparation validates, backs up and records a pending confirmation', function() {
	const source = lib.read(MIGRATION);
	const prepare = source.slice(source.indexOf('migration_prepare()'), source.indexOf('migration_status_json()'));
	const validate = prepare.indexOf('config_check_syntax "$WM_CONFIG_DIR" "The installed"');
	const backup = prepare.indexOf('backup_create_auto full "Before switching from Mesh Assistant"');
	const stop = prepare.indexOf('"$MIGRATION_LEGACY_INIT" stop');

	includes(source, 'migration_legacy_present() {');
	ok(validate !== -1 && backup !== -1 && stop !== -1);
	ok(validate < backup && backup < stop, 'order: validate < backup < stop');
	includes(prepare, 'uci set wifimanager.settings.migration_pending=1');
	includes(prepare, 'uci set wifimanager.settings.migration_legacy_was_enabled="$was_enabled"');
	includes(prepare, 'uci set wifimanager.settings.migration_detected_at=');
	includes(prepare, 'wm_event migration result pending backup');
	includes(prepare, 'the operator already decided; state left unchanged.');
});

test('migration: a reinstall keeps the state recorded when the switch was detected', function() {
	const source = lib.read(MIGRATION);
	const prepare = source.slice(source.indexOf('migration_prepare()'), source.indexOf('migration_status_json()'));

	// The legacy daemon is disabled by this package before a reinstall runs, so
	// re-deriving "was enabled" from its live state would forget a 1 and postrm
	// would never restore the service.
	includes(prepare, 'prev_pending=$(migration_conf migration_pending)');
	includes(prepare, 'prev_was=$(migration_conf migration_legacy_was_enabled)');
	includes(prepare, 'prev_backup=$(migration_conf migration_backup)');
	includes(prepare, 'if [ "$prev_pending" = 1 ] && [ -n "$prev_was" ]; then');
	includes(prepare, 'was_enabled=$prev_was');
	includes(prepare, 'if [ "$prev_pending" != 1 ] || [ -z "$prev_backup" ]; then');
	includes(prepare, 'backup_id=$prev_backup');
	includes(prepare, 'detected_at=$(migration_conf migration_detected_at)');
	includes(prepare, 'uci set wifimanager.settings.migration_detected_at="$detected_at"');
});

test('migration: confirmation is explicit, validates the current config and clears pending', function() {
	const source = lib.read(MIGRATION);
	const confirm = source.slice(source.indexOf('migration_confirm_json()'), source.indexOf('migration_restore_legacy_json()'));

	includes(confirm, 'if [ "$confirm" != true ] && [ "$confirm" != 1 ]; then');
	includes(confirm, 'E-CONFIRM');
	includes(confirm, 'config_check_syntax "$WM_CONFIG_DIR" "The current"');
	includes(confirm, 'E-CONFIG');
	includes(confirm, 'uci set wifimanager.settings.migration_pending=0');
	includes(confirm, 'uci set wifimanager.settings.migration_confirmed=1');
	includes(confirm, 'wm_event migration result confirmed');
});

test('migration: confirmation waits for the legacy daemon and records the mesh runtime', function() {
	const source = lib.read(MIGRATION);
	const confirm = source.slice(source.indexOf('migration_confirm_json()'), source.indexOf('migration_restore_legacy_json()'));
	const status = source.slice(source.indexOf('migration_status_json()'), source.indexOf('migration_confirm_json()'));

	includes(confirm, 'while [ "$i" -lt 5 ] && [ "$(migration_legacy_running)" = 1 ]; do');
	includes(confirm, 'E-STATE "The Mesh Assistant service is still running; confirm the migration once it has stopped."');
	includes(confirm, '[ -e /sys/class/net/bat0 ] && mesh_running=1');
	includes(confirm, 'uci set wifimanager.settings.migration_checked_at=');
	includes(confirm, 'uci set wifimanager.settings.migration_mesh_running="$mesh_running"');
	includes(confirm, 'wm_event migration result confirmed mesh_running "$mesh_running"');
	includes(confirm, 'migration_ok_json "Migration confirmed. WiFi Manager manages the configuration, but the mesh is enabled without bat0');

	includes(status, 'json_add_boolean mesh_running');
	includes(status, 'json_add_string checked_at');
});

test('migration: restoring the legacy service is refused while the mesh is applied', function() {
	const source = lib.read(MIGRATION);
	const restore = source.slice(source.indexOf('migration_restore_legacy_json()'));

	includes(restore, 'E-CONFIRM');
	includes(restore, 'E-STATE "Disable the WiFi Manager mesh first; two managers must not run at the same time."');
	includes(restore, '"$MIGRATION_LEGACY_INIT" enable');
	includes(restore, 'uci set wifimanager.settings.migration_declined=1');
	includes(restore, 'uci set wifimanager.settings.legacy_service_disabled=0');
});

test('migration: install runs the worker and keeps a conservative fallback', function() {
	const source = lib.read(DEFAULTS);
	const worker = lib.read(WORKER);

	includes(source, '/usr/lib/wifimanager/worker.sh migrate_prepare');
	includes(source, '[ "$(uci -q get wifimanager.settings.migration_pending)" != 1 ]');
	includes(source, '[ "$(uci -q get wifimanager.settings.migration_confirmed)" != 1 ]');
	includes(source, 'uci set wifimanager.settings.migration_pending=1');
	includes(worker, 'migrate_prepare)');
	includes(worker, 'migration_prepare');
});

test('migration: the RPC, ACL and UI expose the confirmation step', function() {
	const rpcd = lib.read(RPDC);
	const acl = lib.acl()['luci-app-wifimanager'];
	const rpc = lib.read('htdocs/luci-static/resources/wifimanager/utils/rpc.js');
	const view = lib.read(OVERVIEW);

	includes(rpcd, '"migration_status": {}');
	includes(rpcd, 'migration_status) migration_status_json ;;');
	includes(rpcd, 'migration_confirm_json "$args"');
	includes(rpcd, 'migration_restore_legacy_json "$args"');
	ok(acl.read.ubus.wifimanager.indexOf('migration_status') !== -1, 'read ACL');
	ok(acl.write.ubus.wifimanager.indexOf('migration_confirm') !== -1, 'confirm write ACL');
	ok(acl.write.ubus.wifimanager.indexOf('migration_restore_legacy') !== -1, 'restore write ACL');
	ok(acl.read.ubus.wifimanager.indexOf('migration_confirm') === -1, 'confirm is not readable only');
	includes(rpc, "migrationStatus: declare('migration_status')");
	includes(rpc, "migrationConfirm: declare('migration_confirm', [ 'confirm' ])");
	includes(rpc, "migrationRestoreLegacy: declare('migration_restore_legacy', [ 'confirm' ])");
	// The switch is handled by the installer and the backend; the overview no
	// longer offers it as a card.
	notIncludes(view, 'rpc.migrationStatus()');
	notIncludes(view, 'rpc.migrationConfirm(');
	notIncludes(view, 'rpc.migrationRestoreLegacy(');
	notIncludes(view, 'Migration from Mesh Assistant');
});

test('migration: removing WiFi Manager restores the legacy service it stopped', function() {
	const source = lib.read(MAKEFILE);

	includes(source, 'define Package/luci-app-wifimanager/postrm');
	includes(source, '[ "$${PKG_UPGRADE}" = "1" ] && exit 0');
	includes(source, 'legacy_disabled=$$(uci -q get wifimanager.settings.legacy_service_disabled)');
	includes(source, '/etc/init.d/meshassistant enable');
	includes(source, '/etc/init.d/meshassistant restart');
	notIncludes(source, 'rm -f /etc/config/meshassistant');
});

test('migration: the restore page offers a copy of legacy archives, not a conversion', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/restore.js');

	includes(view, 'rpc.backupLegacyImport(entry.id)');
	includes(view, "_('Copy legacy backup')");
	includes(view, 'This legacy Mesh Assistant archive is read in place.');
});

test('migration: the product is not named Mesh Assistant anywhere in the menu', function() {
	const menu = lib.menu();

	for (const key of Object.keys(menu)) {
		const entry = menu[key];
		const title = String(entry.title || '');
		const name = typeof title === 'string' ? title : (title[0] || '');

		notMatch(name, /mesh\s*assistant/i, key);
	}
});

test('migration: existing WiFi Manager settings survive the upgrade defaults', function() {
	const source = lib.read(DEFAULTS);

	includes(source, 'Defaults only where the option is absent; an operator value always wins.');
	includes(source, '[ -f /etc/config/wifimanager ] || touch /etc/config/wifimanager');
	notMatch(source, /^uci set wifimanager\.backup\./m);
	includes(source, 'uci set "wifimanager.backup.$key=$value"');
});
