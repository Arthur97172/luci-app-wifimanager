'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, match, notMatch } = lib;

const BACKUP = 'root/usr/lib/wifimanager/backup.sh';
const POLICIES = 'root/usr/lib/wifimanager/restore.sh';
const RPDC = 'root/usr/libexec/rpcd/wifimanager';
const VIEW = 'htdocs/luci-static/resources/view/wifimanager/backup/restore.js';

test('restore: the backend refuses to restore without explicit confirmation', function() {
	const source = lib.read(RPDC);
	const dispatch = source.slice(source.indexOf('backup_restore)'));

	includes(dispatch, 'if [ "$confirm" != true ] && [ "$confirm" != 1 ]; then');
	includes(dispatch, 'wm_error E-CONFIRM "Restore requires explicit confirmation."');
	includes(dispatch, 'spawn backup_restore restore "$id"');
});

test('restore: the restore password travels through a 0600 file that is deleted by the worker', function() {
	const source = lib.read(RPDC);
	const worker = lib.read(BACKUP);

	includes(source, '( umask 077; printf \'%s\' "$pw" >"$file" )');
	includes(source, 'chmod 600 "$file" 2>/dev/null');
	includes(source, 'password_file "$pass"');
	includes(worker, 'password=$(cat "$password_file")');
	includes(worker, 'rm -f "$password_file"');
	notIncludes(worker, 'wm_log "restore: pass');
});

test('restore: a snapshot is taken before any change and a pre-restore backup precedes the apply', function() {
	const source = lib.read(BACKUP);
	const worker = source.slice(source.indexOf('backup_restore_worker()'), source.indexOf('backup_import()'));

	const snap = worker.indexOf('restore_snapshot "$snap"');
	const preBackup = worker.indexOf('backup_create_auto full');
	const apply = worker.indexOf('restore_apply "$extracted"');

	ok(snap !== -1, 'snapshot taken');
	ok(preBackup !== -1, 'pre-restore backup taken');
	ok(apply !== -1, 'restore applied');
	ok(snap < preBackup && preBackup < apply, 'order: snapshot < pre-restore backup < apply');
	includes(worker, 'backup_id=$(backup_create_auto full "Before restoring $id")');
	notIncludes(worker, 'backup_conf require_pre_restore');
	includes(worker, 'The pre-restore backup failed; nothing was changed.');
});

test('restore: a failed verification restores the snapshot and finishes as failed', function() {
	const source = lib.read(BACKUP);
	const worker = source.slice(source.indexOf('backup_restore_worker()'), source.indexOf('backup_import()'));
	const fail = worker.slice(worker.indexOf('wm_log "restore: verification failed'));

	includes(fail, 'restore_rollback "$snap"');
	includes(fail, 'wm_reload_network');
	includes(fail, 'wm_reload_wifi');
	includes(fail, 'wm_op_finish failed "$verify_msg The previous configuration was restored." 0');
	includes(fail, 'wm_event restore id "$id" result rolled-back');
	includes(worker, 'wm_op_finish done "Backup $id restored and verified." 1');
});

test('restore: verification waits for the LAN address and a wireless interface', function() {
	const source = lib.read(BACKUP);
	const verify = source.slice(source.indexOf('restore_verify()'), source.indexOf('restore_apply()'));

	includes(verify, 'The LAN interface did not come back within 90 seconds.');
	includes(verify, 'No wireless interface came up after the restore.');
	includes(verify, 'lan_ipv4');
	includes(verify, 'iw dev');
});

test('restore: a full restore touches only the known configuration files', function() {
	const source = lib.read(BACKUP);
	const apply = source.slice(source.indexOf('restore_apply()'), source.indexOf('backup_restore_worker()'));

	includes(lib.read('root/usr/lib/wifimanager/common.sh'),
		'WM_CONFIG_FILES="network wireless dhcp firewall system meshassistant dawn wifimanager"');
	includes(source, 'WM_BACKUP_KNOWN_FILES="$WM_CONFIG_FILES"');
	includes(apply, 'for area in $WM_BACKUP_KNOWN_FILES; do');
	notMatch(apply, /\/etc\/config\/\*/);
	notMatch(apply, /cp -a [^\n]*\/etc\/config/);
	notMatch(apply, /rm -rf [^\n]*\/etc\/config/);
});

test('restore: the archive configuration syntax is checked before anything changes', function() {
	const common = lib.read('root/usr/lib/wifimanager/common.sh');
	const source = lib.read(BACKUP);
	const worker = source.slice(source.indexOf('backup_restore_worker()'), source.indexOf('backup_import()'));
	const check = worker.indexOf('config_check_syntax "$extracted/etc/config" "The archive"');
	const snap = worker.indexOf('restore_snapshot "$snap"');
	const apply = worker.indexOf('restore_apply "$extracted"');

	includes(common, 'config_check_syntax() {');
	includes(common, 'uci -c "$dir" export "$cfg"');
	ok(check !== -1, 'archive syntax check present');
	ok(snap !== -1 && apply !== -1);
	ok(check < snap && snap < apply, 'order: syntax check < snapshot < apply');
	includes(worker.slice(check), 'Nothing was changed.');
});

test('restore: a merged result that does not parse is rolled back', function() {
	const source = lib.read(BACKUP);
	const worker = source.slice(source.indexOf('backup_restore_worker()'), source.indexOf('backup_import()'));
	const post = worker.slice(worker.indexOf('config_check_syntax "$WM_CONFIG_DIR" "The restored configuration"'));

	includes(worker, 'config_check_syntax "$WM_CONFIG_DIR" "The restored configuration"');
	includes(post, 'restore_rollback "$snap"');
	includes(post, 'The previous configuration was restored.');
	includes(post, 'wm_event restore id "$id" result rolled-back');
});

test('restore: validation reports an archive syntax error before a restore is attempted', function() {
	const source = lib.read(BACKUP);
	const validate = source.slice(source.indexOf('backup_validate_json()'), source.indexOf('backup_details_json()'));

	includes(validate, 'syntax_msg=$(config_check_syntax "$extracted/etc/config" "The archive")');
	includes(validate, 'errors=$((errors + 1))');
});

test('restore: a custom DAWN selection restores the DAWN file with the roaming options', function() {
	const source = lib.read(BACKUP);
	const apply = source.slice(source.indexOf('restore_apply()'),
		source.indexOf('backup_restore_worker()'));
	const custom = apply.slice(apply.indexOf('custom)'));

	includes(custom, 'if has_scope roaming || has_scope dawn; then');
	includes(custom, 'merge_wireless_roaming "$src"');
	includes(custom, 'replace_config_file "$src" dawn');
	includes(custom, 'has_scope roaming && merge_meshassistant_scope "$src" roaming');
	notIncludes(custom, 'replace_config_file "$src" meshassistant');
});

test('restore: scoped Mesh Assistant merges never replace the whole file', function() {
	const source = lib.read(BACKUP);

	notIncludes(source, 'replace_config_file "$src" meshassistant');
	includes(source, 'merge_meshassistant_scope "$src" mesh backhaul roaming');
	includes(source, 'merge_meshassistant_scope "$src" mesh backhaul');
	includes(source, 'has_scope mesh && merge_meshassistant_scope "$src" mesh');
	includes(source, 'has_scope backhaul && merge_meshassistant_scope "$src" backhaul');
	includes(source, 'merge_meshassistant_scope "$src" roaming');
});

test('restore: scopes merge instead of overwriting unrelated sections', function() {
	const source = lib.read(BACKUP);
	const policies = lib.read('root/usr/lib/wifimanager/restore.sh');

	includes(policies, 'merge_wireless_radios()');
	includes(policies, 'merge_wireless_nonmesh()');
	includes(policies, 'merge_wireless_mesh()');
	includes(policies, 'merge_wireless_roaming()');
	includes(policies, 'merge_meshassistant_scope()');
	includes(policies, 'merge_network_mesh()');
	includes(policies, 'merge_dhcp_mesh()');
	includes(policies, 'merge_firewall_mesh()');
	includes(policies, 'Every mesh-owned');
	includes(source, 'case " $scope " in *" $1 "*) return 0 ;; esac');
	includes(source, 'has_scope network && { replace_config_file "$src" network;');
});

test('restore: rollback restores every snapshot file and commits configuration', function() {
	const source = lib.read(BACKUP);
	const rollback = source.slice(source.indexOf('restore_rollback()'), source.indexOf('restore_verify()'));

	includes(rollback, 'cp "$snap/etc/config/$cfg" "$WM_CONFIG_DIR/$cfg"');
	includes(rollback, 'for cfg in network wireless dhcp firewall system meshassistant dawn wifimanager; do');
	includes(rollback, 'uci_commit "$cfg"');
});

test('restore: the view lists the affected files and requires an acknowledgement', function() {
	const view = lib.read(VIEW);

	includes(view, 'const files = backup.affectedFiles(plan.scope);');
	includes(view, "E('input', { 'type': 'checkbox' })");
	includes(view, "'disabled': true");
	includes(view, 'restoreButton.disabled = !ack.checked;');
	includes(view, 'Only these files are replaced or merged. A restore never replaces the whole /etc/config directory.');
	includes(view, "rpc.backupRestore(plan.id, true, plan.password)");
	includes(view, 'widgets.waitForOperation(300000)');
});

test('restore: the view warns about disconnection, pre-restore state and legacy archives', function() {
	const view = lib.read(VIEW);

	includes(view, 'Wireless settings are part of the restore; Wi-Fi clients will reconnect.');
	includes(view, 'This page can become unreachable');
	includes(view, 'A full pre-restore backup is created before any configuration file is changed.');
	includes(view, 'If the restored configuration cuts off the path to this router, the automatic rollback cannot reach it either.');
	includes(view, 'It is not converted, rewritten or deleted by the restore.');
});

test('restore: compatibility covers firmware, radio count, radio path and interface names', function() {
	const source = lib.read(BACKUP);
	const compat = source.slice(source.indexOf('backup_compat_warnings()'),
		source.indexOf('backup_write_manifest()'));

	for (const marker of [ '@.firmware.id', '@.firmware.version', '@.firmware.target',
		'@.radios[*].name', 'radio_band "$radio"', '@.radios[@.name=\'$radio\'].path',
		'@.interfaces[*]', '/sys/class/net/$ifname' ]) {
		includes(compat, marker, marker);
	}
	includes(compat, 'The archive contains %s radios; this device has %s.');
	includes(compat, 'This device has no radio "%s" that the archive references.');
	includes(compat, 'does not exist on this device; interface names may have changed.');
	// Names from an archive are data, not a command line.
	includes(compat, 'case "$radio" in *[!A-Za-z0-9_-]*) continue ;; esac');
	includes(compat, 'case "$ifname" in *[!A-Za-z0-9_.-]*) continue ;; esac');
});

test('restore: compatibility findings reach validation, details and the restore log', function() {
	const source = lib.read(BACKUP);
	const validate = source.slice(source.indexOf('backup_validate_json()'),
		source.indexOf('backup_details_json()'));
	const details = source.slice(source.indexOf('backup_details_json()'),
		source.indexOf('backup_export_json()'));
	const worker = source.slice(source.indexOf('backup_restore_worker()'),
		source.indexOf('backup_import()'));

	includes(validate, 'backup_compat_warnings "$manifest"');
	includes(validate, 'json_add_array compatibility');
	includes(validate, 'done <<EOF');
	includes(details, 'json_add_array compatibility');
	includes(details, 'backup_compat_warnings "$manifest"');
	includes(worker, 'wm_log "restore: compatibility: $compat_line"');
	includes(worker, 'compatibility warning(s).');
	includes(worker, 'wm_event restore id "$id" result ok compatibility "$compat_count"');
});

test('restore: the page shows compatibility warnings before acknowledgement', function() {
	const view = lib.read(VIEW);

	includes(view, 'warnings = report.compatibility || report.warnings || []');
	includes(view, 'warnings: warnings');
	includes(view, "E('h4', {}, [ _('Compatibility warnings') ])");
	includes(view, 'widgets.list(plan.warnings)');
	includes(view, 'details.compatibility');
});

test('restore: validation happens before details and the restore call', function() {
	const view = lib.read(VIEW);
	const validate = view.indexOf('rpc.backupValidate(entry.id, password)');
	const details = view.indexOf('rpc.backupDetails(entry.id, password)');

	ok(validate !== -1 && details !== -1 && validate < details, 'validate before details');
	includes(view, 'reply.warnings || []');
});

test('restore: the restore menu leaf and write ACL exist', function() {
	const entry = lib.menu()['admin/network/wifimanager/backup/restore'];
	const acl = lib.acl()['luci-app-wifimanager-backup'];

	ok(entry, 'Backup > Restore menu entry');
	equal(entry.action.path, 'wifimanager/backup/restore');
	ok(acl.write.ubus.wifimanager.indexOf('backup_restore') !== -1);
});

test('restore: the list, details and confirmation show the archive description', function() {
	const view = lib.read(VIEW);

	includes(view, "{ label: _('Description') }");
	includes(view, "[ _('Description'), details.description || '-' ]");
	includes(view, "[ _('Description'), plan.details.description || entry.description || '-' ]");
	includes(view, 'entry.description');
});

test('restore: the page distinguishes WiFi Manager Backup from Sysupgrade Backup', function() {
	const view = lib.read(VIEW);
	const card = view.slice(view.indexOf("card(_('WiFi Manager Backup or OpenWrt Sysupgrade Backup?')"),
		view.indexOf("card(_('Related pages')"));

	includes(card, 'stores and restores only the configuration files in the selected scope');
	includes(card, 'OpenWrt Sysupgrade Backup is a separate mechanism');
	includes(card, 'WiFi Manager neither creates nor replaces it.');
	includes(card, 'it is not a system image');
});

/*
 * Behaviour tests for the scoped restore policies.  A small uci stub reads and
 * writes flat key/value fixtures, so the real restore.sh functions run under
 * sh: a Wireless restore restores matching radios and leaves mesh-owned radios
 * alone, renamed radios are matched by PHY path, and the meshassistant merge
 * touches only the selected scope.
 */

function policyModules(dir) {
	const files = [ 'root/usr/lib/wifimanager/common.sh',
		'root/usr/lib/wifimanager/capabilities.sh',
		'root/usr/lib/wifimanager/radio.sh',
		POLICIES ];
	const combined = files.map(function(rel) {
		return lib.read(rel).split('\n').filter(function(line) {
			return line.indexOf('. /usr/') !== 0;
		}).join('\n');
	}).join('\n');
	const file = path.join(dir, 'modules.sh');

	fs.writeFileSync(file, combined);
	return file;
}

function writeMap(file, lines) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, lines.join('\n') + '\n');
}

const POLICY_DRIVER = [
	'#!/bin/sh',
	'set -u',
	'MODULES="$1"',
	'WORK="$2"',
	'. "$MODULES"',
	'',
	'failures=0',
	'check() {',
	'	if [ "$2" = "$3" ]; then',
	'		echo "ok: $1"',
	'	else',
	'		echo "FAIL: $1: expected [$2], got [$3]"',
	'		failures=$((failures + 1))',
	'	fi',
	'}',
	'fail() { echo "FAIL: $1"; failures=$((failures + 1)); }',
	'',
	'LIVE="$WORK/live.uci"',
	'ARCH="$WORK/archive/uci.map"',
	'mkdir -p "$WORK/archive"',
	'',
	'_uci_line() {',
	'	local line',
	'	line=$(grep -F "$2=" "$1" 2>/dev/null | head -n 1)',
	'	[ -n "$line" ] || line=$(grep -F "$2:section=" "$1" 2>/dev/null | head -n 1)',
	'	[ -n "$line" ] || line=$(grep -F "$2:list=" "$1" 2>/dev/null | head -n 1)',
	'	[ -n "$line" ] && printf "%s\\n" "$line"',
	'	return 0',
	'}',
	'',
	'_uci_print() {',
	'	local line words w key',
	'	key="$2"',
	'	case "$key" in',
	'		*:list) key="${key%:list}" ;;',
	'		*:section) key="${key%:section}" ;;',
	'	esac',
	'	line=$(_uci_line "$1" "$2")',
	'	[ -n "$line" ] || return 1',
	'	case "$2" in',
	'		*:section) printf "%s=%s\\n" "$key" "${line#*=}" ;;',
	'		*:list)',
	'			words=""',
	'			for w in ${line#*=}; do',
	'				words="$words \'$w\'"',
	'			done',
	'			printf "%s=%s\\n" "$key" "$words"',
	'			;;',
	'		*) printf "%s=\'%s\'\\n" "$key" "${line#*=}" ;;',
	'	esac',
	'}',
	'',
	'uci() {',
	'	local db="$LIVE" cmd="" key="" val="" line existing',
	'	while [ "$#" -gt 0 ]; do',
	'		case "$1" in',
	'			-q) shift ;;',
	'			-c) db="$2/uci.map"; shift 2 ;;',
	'			get|set|del|show|add_list|commit) cmd="$1"; shift; break ;;',
	'			*) shift ;;',
	'		esac',
	'	done',
	'	case "$cmd" in',
	'		get)',
	'			line=$(_uci_line "$db" "$1")',
	'			[ -n "$line" ] || return 1',
	'			printf "%s\\n" "${line#*=}"',
	'			;;',
	'		set)',
	'			key="${1%%=*}"',
	'			val="${1#*=}"',
	'			case "$key" in',
	'				*.*.*)',
	'					grep -vF "$key=" "$db" >"$db.tmp" 2>/dev/null',
	'					grep -vF "$key:list=" "$db.tmp" >"$db" 2>/dev/null',
	'					rm -f "$db.tmp"',
	'					printf "%s=%s\\n" "$key" "$val" >>"$db"',
	'					;;',
	'				*.*)',
	'					grep -vF "$key:section=" "$db" >"$db.tmp" 2>/dev/null',
	'					mv "$db.tmp" "$db"',
	'					printf "%s:section=%s\\n" "$key" "$val" >>"$db"',
	'					;;',
	'			esac',
	'			;;',
	'		del)',
	'			key="$1"',
	'			case "$key" in',
	'				*.*.*)',
	'					grep -vF "$key=" "$db" >"$db.tmp" 2>/dev/null',
	'					grep -vF "$key:list=" "$db.tmp" >"$db" 2>/dev/null',
	'					rm -f "$db.tmp"',
	'					;;',
	'				*.*)',
	'					grep -vF "$key:section=" "$db" | grep -vF "$key." >"$db.tmp"',
	'					mv "$db.tmp" "$db"',
	'					;;',
	'			esac',
	'			;;',
	'		add_list)',
	'			key="${1%%=*}"',
	'			val="${1#*=}"',
	'			line=$(grep -F "$key:list=" "$db" 2>/dev/null | head -n 1)',
	'			if [ -n "$line" ]; then',
	'				existing="${line#*=}"',
	'				grep -vF "$key:list=" "$db" >"$db.tmp"',
	'				printf "%s:list=%s %s\\n" "$key" "$existing" "$val" >>"$db.tmp"',
	'				mv "$db.tmp" "$db"',
	'			else',
	'				printf "%s:list=%s\\n" "$key" "$val" >>"$db"',
	'			fi',
	'			;;',
	'		show)',
	'			key="$1"',
	'			case "$key" in',
	'				*.*.*) _uci_print "$db" "$key" ;;',
	'				*.*)',
	'					line=$(grep -F "$key:section=" "$db" 2>/dev/null | head -n 1)',
	'					[ -n "$line" ] && printf "%s=%s\\n" "$key" "${line#*=}"',
	'					grep -F "$key." "$db" 2>/dev/null | while IFS= read -r line; do',
	'						_uci_print "$db" "${line%%=*}"',
	'					done',
	'					;;',
	'				*)',
	'					grep -F "$key." "$db" 2>/dev/null | while IFS= read -r line; do',
	'						_uci_print "$db" "${line%%=*}"',
	'					done',
	'					;;',
	'			esac',
	'			;;',
	'		commit) return 0 ;;',
	'		*) return 1 ;;',
	'	esac',
	'}',
	'',
	'cp "$WORK/live.base" "$LIVE"',
	'cp "$WORK/archive.base" "$ARCH"',
	'merge_wireless_nonmesh "$WORK/archive" >/dev/null',
	'check "a matching radio restores its channel" 36 "$(uci -q get wireless.radio0.channel)"',
	'check "a matching radio restores its TX power" 20 "$(uci -q get wireless.radio0.txpower)"',
	'check "a non-mesh AP interface is restored" Home "$(uci -q get wireless.lan_ap.ssid)"',
	'check "a mesh-owned radio keeps its channel" 1 "$(uci -q get wireless.radio1.channel)"',
	'check "a mesh-owned interface is not replaced" mesh-a "$(uci -q get wireless.mesh_radio1.mesh_id)"',
	'',
	'cp "$WORK/live-rename.base" "$LIVE"',
	'cp "$WORK/archive-rename.base" "$ARCH"',
	'merge_wireless_nonmesh "$WORK/archive" >/dev/null',
	'check "a renamed radio is matched by PHY path" 36 "$(uci -q get wireless.radio1.channel)"',
	'check "the other renamed radio is matched back" 6 "$(uci -q get wireless.radio0.channel)"',
	'check "an interface follows its radio to the new name" radio1 "$(uci -q get wireless.lan_ap.device)"',
	'check "the interface itself is restored" Home "$(uci -q get wireless.lan_ap.ssid)"',
	'check "an interface on an unrestorable radio is skipped" "" "$(uci -q get wireless.lan_x.ssid)"',
	'',
	'cp "$WORK/live-mesh.base" "$LIVE"',
	'cp "$WORK/archive-mesh.base" "$ARCH"',
	'merge_meshassistant_scope "$WORK/archive" mesh >/dev/null',
	'check "Mesh restores the enable flag" 1 "$(uci -q get meshassistant.config.enabled)"',
	'check "Mesh restores the mesh ID" mesh-a "$(uci -q get meshassistant.config.mesh_id)"',
	'check "Mesh restores a list option" "radio0 radio1" "$(uci -q get meshassistant.config.wifi_radio)"',
	'check "Mesh restores a spectrum option" 44 "$(uci -q get meshassistant.config.spectrum_radio0_channel)"',
	'check "Mesh leaves roaming options alone" 0 "$(uci -q get meshassistant.config.kvr)"',
	'check "Mesh leaves backhaul options alone" 0 "$(uci -q get meshassistant.config.backhaul_auto)"',
	'check "Mesh does not restore runtime state" 0 "$(uci -q get meshassistant.config.running)"',
	'check "Mesh does not restore runtime bookkeeping" 1 "$(uci -q get meshassistant.config.lan_state_saved)"',
	'check "Mesh drops a live option absent from the archive" "" "$(uci -q get meshassistant.config.ssid_mode)"',
	'',
	'merge_meshassistant_scope "$WORK/archive" roaming >/dev/null',
	'check "Roaming restores the k/v/r flag" 1 "$(uci -q get meshassistant.config.kvr)"',
	'check "Roaming restores the RSSI threshold" -62 "$(uci -q get meshassistant.config.rssi_val)"',
	'check "Roaming restores a per-band threshold" -58 "$(uci -q get meshassistant.config.rssi_val_5g)"',
	'check "Roaming restores DAWN options" 1 "$(uci -q get meshassistant.config.dawn_kicking)"',
	'check "Roaming leaves Mesh options alone" mesh-a "$(uci -q get meshassistant.config.mesh_id)"',
	'check "Roaming leaves backhaul options alone" 0 "$(uci -q get meshassistant.config.backhaul_auto)"',
	'',
	'merge_meshassistant_scope "$WORK/archive" backhaul >/dev/null',
	'check "Backhaul restores the switching flag" 1 "$(uci -q get meshassistant.config.backhaul_auto)"',
	'check "Backhaul restores the wired port" eth1 "$(uci -q get meshassistant.config.wired_port)"',
	'check "Backhaul restores the AP-mode hostname" ap-node "$(uci -q get meshassistant.config.hostname)"',
	'check "Backhaul leaves a runtime hostname snapshot alone" live-old "$(uci -q get meshassistant.config.hostname_orig)"',
	'check "Backhaul leaves a runtime state flag alone" 1 "$(uci -q get meshassistant.config.hostname_state_saved)"',
	'check "Backhaul leaves roaming options alone" 1 "$(uci -q get meshassistant.config.kvr)"',
	'',
	'if [ "$failures" != 0 ]; then',
	'	echo "$failures restore policy check(s) failed"',
	'	exit 1',
	'fi',
	'echo "restore policy simulation passed"',
	'exit 0'
].join('\n');

test('restore: scoped policies restore radios and only the selected meshassistant options', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-policy-'));
	const modules = policyModules(dir);
	const work = path.join(dir, 'work');

	fs.mkdirSync(work);

	writeMap(path.join(work, 'live.base'), [
		'wireless.radio0:section=wifi-device',
		'wireless.radio0.path=platform/a',
		'wireless.radio0.channel=149',
		'wireless.radio0.htmode=HE160',
		'wireless.radio1:section=wifi-device',
		'wireless.radio1.path=pci/b',
		'wireless.radio1.channel=1',
		'wireless.radio1.htmode=HT20',
		'wireless.lan_ap:section=wifi-iface',
		'wireless.lan_ap.device=radio0',
		'wireless.lan_ap.mode=ap',
		'wireless.lan_ap.ssid=Old',
		'wireless.mesh_radio1:section=wifi-iface',
		'wireless.mesh_radio1.device=radio1',
		'wireless.mesh_radio1.mode=mesh',
		'wireless.mesh_radio1.mesh_id=mesh-a'
	]);
	writeMap(path.join(work, 'archive.base'), [
		'wireless.radio0:section=wifi-device',
		'wireless.radio0.path=platform/a',
		'wireless.radio0.channel=36',
		'wireless.radio0.htmode=HE80',
		'wireless.radio0.txpower=20',
		'wireless.radio1:section=wifi-device',
		'wireless.radio1.path=pci/b',
		'wireless.radio1.channel=6',
		'wireless.radio1.htmode=HE20',
		'wireless.lan_ap:section=wifi-iface',
		'wireless.lan_ap.device=radio0',
		'wireless.lan_ap.mode=ap',
		'wireless.lan_ap.ssid=Home',
		'wireless.mesh_radio1:section=wifi-iface',
		'wireless.mesh_radio1.device=radio1',
		'wireless.mesh_radio1.mesh_id=mesh-a'
	]);
	writeMap(path.join(work, 'live-rename.base'), [
		'wireless.radio0:section=wifi-device',
		'wireless.radio0.path=pci/b',
		'wireless.radio0.band=2g',
		'wireless.radio0.channel=149',
		'wireless.radio1:section=wifi-device',
		'wireless.radio1.path=platform/a',
		'wireless.radio1.band=5g',
		'wireless.radio1.channel=1',
		'wireless.lan_ap:section=wifi-iface',
		'wireless.lan_ap.device=radio1',
		'wireless.lan_ap.ssid=Old'
	]);
	writeMap(path.join(work, 'archive-rename.base'), [
		'wireless.radio0:section=wifi-device',
		'wireless.radio0.path=platform/a',
		'wireless.radio0.band=5g',
		'wireless.radio0.channel=36',
		'wireless.radio1:section=wifi-device',
		'wireless.radio1.path=pci/b',
		'wireless.radio1.band=2g',
		'wireless.radio1.channel=6',
		'wireless.radio9:section=wifi-device',
		'wireless.radio9.path=vendor/absent',
		'wireless.radio9.channel=44',
		'wireless.lan_ap:section=wifi-iface',
		'wireless.lan_ap.device=radio0',
		'wireless.lan_ap.ssid=Home',
		'wireless.lan_x:section=wifi-iface',
		'wireless.lan_x.device=radio9',
		'wireless.lan_x.ssid=Ghost'
	]);
	writeMap(path.join(work, 'live-mesh.base'), [
		'meshassistant.config:section=meshassistant',
		'meshassistant.config.enabled=0',
		'meshassistant.config.role=node',
		'meshassistant.config.wifi_id=OldName',
		'meshassistant.config.ssid_mode=per_band',
		'meshassistant.config.wifi_radio:list=radio0',
		'meshassistant.config.mesh_id=old-mesh',
		'meshassistant.config.spectrum_radio0_channel=1',
		'meshassistant.config.kvr=0',
		'meshassistant.config.rssi_val=-70',
		'meshassistant.config.rssi_val_5g=-70',
		'meshassistant.config.dawn_kicking=0',
		'meshassistant.config.backhaul_auto=0',
		'meshassistant.config.backhaul_pref=ethernet',
		'meshassistant.config.wired_port=eth0',
		'meshassistant.config.hostname=old-host',
		'meshassistant.config.hostname_orig=live-old',
		'meshassistant.config.hostname_state_saved=1',
		'meshassistant.config.running=0',
		'meshassistant.config.lan_state_saved=1'
	]);
	writeMap(path.join(work, 'archive-mesh.base'), [
		'meshassistant.config:section=meshassistant',
		'meshassistant.config.enabled=1',
		'meshassistant.config.role=server',
		'meshassistant.config.wifi_id=NewName',
		'meshassistant.config.wifi_radio:list=radio0 radio1',
		'meshassistant.config.mesh_id=mesh-a',
		'meshassistant.config.key=secret123',
		'meshassistant.config.spectrum_radio0_channel=44',
		'meshassistant.config.kvr=1',
		'meshassistant.config.ft=1',
		'meshassistant.config.mobility_domain=abcd',
		'meshassistant.config.rssi_val=-62',
		'meshassistant.config.rssi_val_5g=-58',
		'meshassistant.config.low_rssi_val=-85',
		'meshassistant.config.dawn_kicking=1',
		'meshassistant.config.backhaul_auto=1',
		'meshassistant.config.backhaul_pref=wireless',
		'meshassistant.config.wired_port=eth1',
		'meshassistant.config.hostname=ap-node',
		'meshassistant.config.hostname_orig=archive-old',
		'meshassistant.config.hostname_state_saved=0',
		'meshassistant.config.running=1',
		'meshassistant.config.lan_state_saved=0'
	]);

	fs.writeFileSync(path.join(dir, 'driver.sh'), POLICY_DRIVER);
	const result = lib.command('sh', [ path.join(dir, 'driver.sh'), modules, work ]);

	equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
	includes(result.stdout, 'restore policy simulation passed');
});

test('restore: the pre-restore backup cannot be disabled and the old opt-out is rewritten', function() {
	const source = lib.read(BACKUP);
	const settings = source.slice(source.indexOf('backup_settings_set()'), source.indexOf('backup_resolve()'));
	const rpcd = lib.read(RPDC);
	const rpc = lib.read('htdocs/luci-static/resources/wifimanager/utils/rpc.js');
	const settingsView = lib.read('htdocs/luci-static/resources/view/wifimanager/backup/settings.js');

	includes(source, 'json_add_boolean require_pre_restore 1');
	includes(settings, 'for key in enabled frequency max_count max_size_mb retention_days path legacy_enabled encrypt_default');
	includes(settings, 'uci set wifimanager.backup.require_pre_restore=1');
	notIncludes(rpcd, '"require_pre_restore"');
	notIncludes(rpc, 'require_pre_restore');
	notIncludes(settingsView, 'require_pre_restore');
	includes(settingsView, 'Every restore first creates a full pre-restore backup. This cannot be turned off');
});

test('restore: retention prunes before creation and again over the store that includes the new archive', function() {
	const source = lib.read(BACKUP);
	const create = source.slice(source.indexOf('backup_create_core()'),
		source.indexOf('# Record the outcome of the last automatic backup'));

	const firstPrune = create.indexOf('backup_prune "$dir"');
	const freeCheck = create.indexOf('not enough free space');
	const tar = create.indexOf('tar -cf');
	const secondPrune = create.indexOf('backup_prune "$dir"', firstPrune + 1);

	ok(firstPrune !== -1 && secondPrune !== -1, 'both prune passes present');
	ok(firstPrune < freeCheck && freeCheck < tar, 'first prune runs before the free-space check and the archive');
	ok(secondPrune > tar, 'second prune runs after the archive is written');
	includes(create, '[ -f "$dir/$id" ] || {');
	includes(create, 'exceeds the storage limit and was removed again');
});

test('restore: the restored configuration is applied and its runtime services verified', function() {
	const source = lib.read(BACKUP);
	const policies = lib.read('root/usr/lib/wifimanager/restore.sh');
	const worker = source.slice(source.indexOf('backup_restore_worker()'), source.indexOf('backup_import()'));

	includes(worker, 'if ! verify_msg=$(restore_apply_runtime); then');
	includes(worker, 'reload_config >/dev/null 2>&1');
	includes(worker, 'wm_reload_network');
	includes(worker, 'wm_reload_wifi');
	includes(worker, 'wm_op_finish failed "$verify_msg The previous configuration was restored." 0');
	includes(source, 'restore_verify_services "$wireless" || return 1');

	includes(policies, 'restore_apply_runtime() {');
	includes(policies, 'mesh_apply_config');
	includes(policies, 'restore_verify_services() { # touched_wireless');
	includes(policies, 'process_running hostapd');
	includes(policies, '[ -e /sys/class/net/bat0 ]');
	includes(policies, '/etc/init.d/dawn status');
	includes(policies, 'hostapd did not start although access points are configured.');
	includes(policies, 'bat0 did not come up');
	includes(policies, 'DAWN is managed for this device but did not start.');
});

test('restore: a rollback removes configuration files the restore created', function() {
	const source = lib.read(BACKUP);
	const rollback = source.slice(source.indexOf('restore_rollback()'), source.indexOf('restore_verify()'));

	includes(rollback, 'elif [ -f "$WM_CONFIG_DIR/$cfg" ]; then');
	includes(rollback, 'rm -f "$WM_CONFIG_DIR/$cfg"');
	includes(rollback, '[ -f "$WM_CONFIG_DIR/$cfg" ] || continue');
	includes(rollback, 'uci commit on an absent config would recreate the file.');
});
