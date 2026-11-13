'use strict';
'require rpc';

/*
 * Every privileged read and action goes through the single "wifimanager"
 * ubus object.  There is no fs.exec grant for this package: the views below
 * only ever name one of the methods listed in the rpcd plugin, so a browser
 * cannot ask the router to run an arbitrary command.
 *
 * Methods answer with a JSON object that always carries "ok".  A rejected
 * promise therefore means the RPC itself failed (ACL, rpcd, timeout), while
 * ok:false carries the validated error code and message from the backend.
 */

function declare(method, params) {
	return rpc.declare({
		object: 'wifimanager',
		method: method,
		params: params || [],
		expect: {}
	});
}

/*
 * iwinfo is a read-only ubus object.  This package's ACL grants only the two
 * lookups a channel picker needs; it is not a command interface.
 */
const freqList = rpc.declare({
	object: 'iwinfo',
	method: 'freqlist',
	params: [ 'device' ],
	expect: { results: [] }
});

const countryList = rpc.declare({
	object: 'iwinfo',
	method: 'countrylist',
	params: [ 'device' ],
	expect: { results: [] }
});

return {
	freqList: freqList,
	countryList: countryList,

	status: declare('status'),
	radioInventory: declare('radio_inventory'),
	radioAdvice: declare('radio_advice'),
	radioCheck: declare('radio_check', [ 'mode', 'device', 'mlo', 'section' ]),
	networkCheck: declare('network_check'),
	channelAdvice: declare('channel_advice', [ 'radio' ]),
	roamingAdvice: declare('roaming_advice'),
	roamingNeighborScan: declare('roaming_neighbor_scan', [ 'radio' ]),

	wirelessIfaceSave: declare('wireless_iface_save',
		[ 'section', 'mode', 'device', 'network', 'ssid', 'encryption', 'key',
		  'hidden', 'ieee80211w', 'ifname', 'macaddr', 'bssid', 'wds', 'uapsd',
		  'ocv', 'disassoc_low_ack', 'disabled', 'mlo' ]),
	wirelessIfaceDelete: declare('wireless_iface_delete', [ 'section', 'confirm' ]),

	backupList: declare('backup_list', [ 'include_legacy' ]),
	backupDetails: declare('backup_details', [ 'id', 'password' ]),
	backupValidate: declare('backup_validate', [ 'id', 'password' ]),
	backupStatus: declare('backup_status'),
	backupSettingsGet: declare('backup_settings_get'),
	backupSettingsSet: declare('backup_settings_set',
		[ 'enabled', 'frequency', 'max_count', 'max_size_mb', 'retention_days',
		  'path', 'legacy_enabled', 'encrypt_default' ]),
	backupStorage: declare('backup_storage'),
	backupCreate: declare('backup_create',
		[ 'type', 'scope', 'description', 'name', 'password' ]),
	backupDelete: declare('backup_delete', [ 'id' ]),
	backupRestore: declare('backup_restore', [ 'id', 'confirm', 'password' ]),
	backupImport: declare('backup_import', [ 'path', 'password' ]),
	backupLegacyImport: declare('backup_legacy_import', [ 'id' ]),
	backupExport: declare('backup_export', [ 'id' ]),

	meshStatus: declare('mesh_status'),
	meshEvents: declare('mesh_events', [ 'limit' ]),
	backhaulStatus: declare('backhaul_status'),

	diagnostics: declare('diagnostics', [ 'section' ]),
	logs: declare('logs', [ 'name', 'lines' ]),
	opStatus: declare('op_status'),
	migrationStatus: declare('migration_status'),
	migrationConfirm: declare('migration_confirm', [ 'confirm' ]),
	migrationRestoreLegacy: declare('migration_restore_legacy', [ 'confirm' ]),

	meshApply: declare('mesh_apply'),
	meshDisable: declare('mesh_disable'),
	meshDumbap: declare('mesh_dumbap'),
	meshUndumbap: declare('mesh_undumbap'),
	roamingApply: declare('roaming_apply')
};
