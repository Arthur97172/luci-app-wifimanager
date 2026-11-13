'use strict';
'require baseclass';
'require wifimanager.utils.validation as validation';

/*
 * Vocabulary for the global Backup & Restore module.  The default scopes
 * mirror default_scope() in the backend; the UI never sends a type whose
 * scope it derived differently from the server.
 */

const TYPE_NAMES = {
	full: _('Full'),
	wireless: _('Wireless (includes MLO)'),
	mesh: _('Mesh'),
	roaming: _('Roaming'),
	custom: _('Custom'),
	legacy: _('Legacy (Mesh Assistant)')
};

const TYPE_DESCRIPTIONS = {
	full: _('Wireless, MLO, mesh, backhaul, roaming, DAWN, network, DHCP/DNS, firewall, system and WiFi Manager settings.'),
	wireless: _('Wireless radios, access points, MLO interfaces and wireless security only.'),
	mesh: _('Mesh roles, BATMAN-adv, 802.11s, backhaul and the mesh-related network settings.'),
	roaming: _('802.11k/v/r settings and the DAWN configuration.'),
	custom: _('Choose the areas to include. Invalid combinations are rejected before a backup is created.')
};

const DEFAULT_SCOPES = {
	full: [ 'wireless', 'mlo', 'mesh', 'backhaul', 'roaming', 'dawn', 'network', 'dhcp', 'firewall', 'system', 'wifimanager' ],
	wireless: [ 'wireless', 'mlo' ],
	mesh: [ 'mesh', 'backhaul' ],
	roaming: [ 'roaming', 'dawn' ],
	custom: []
};

const FREQUENCY_NAMES = {
	before_change: _('Before configuration changes'),
	daily: _('Daily'),
	weekly: _('Weekly'),
	manual: _('Manual only')
};

function typeName(type) {
	return TYPE_NAMES[type] || String(type || _('Unknown'));
}

function typeDescription(type) {
	return TYPE_DESCRIPTIONS[type] || '';
}

function defaultScope(type) {
	return (DEFAULT_SCOPES[type] || []).slice();
}

function frequencyName(frequency) {
	return FREQUENCY_NAMES[frequency] || String(frequency || _('Unknown'));
}

function displayName(backup) {
	if (!backup)
		return '';

	return backup.name || backup.id || '';
}

/*
 * A list entry carries the scope as a space-separated string (the backend
 * joins the manifest array); details carry a real array.
 */
function scopeList(backup) {
	if (!backup)
		return [];

	if (Array.isArray(backup.scope))
		return backup.scope.filter(validation.isScopeArea);

	return String(backup.scope || '').trim().split(/\s+/).filter(validation.isScopeArea);
}

function scopeLabel(area) {
	return validation.AREAS[area] || area;
}

function scopeText(scope) {
	const areas = (scope || []).map(scopeLabel);

	return areas.length ? areas.join(', ') : _('None');
}

/*
 * The restore confirmation names the configuration files the archive can
 * replace, so the warning is concrete instead of a generic "network may
 * change".  Areas map to the files the backend's files_for_scopes() covers.
 */
const AREA_FILES = {
	wireless: [ 'wireless' ],
	mlo: [ 'wireless' ],
	mesh: [ 'wireless', 'network', 'dhcp', 'firewall', 'meshassistant' ],
	backhaul: [ 'wireless', 'network', 'dhcp', 'firewall', 'meshassistant' ],
	roaming: [ 'wireless', 'dawn', 'meshassistant' ],
	dawn: [ 'wireless', 'dawn' ],
	network: [ 'network' ],
	dhcp: [ 'dhcp' ],
	firewall: [ 'firewall' ],
	system: [ 'system' ],
	wifimanager: [ 'wifimanager' ]
};

function affectedFiles(scope) {
	const seen = {};

	for (const area of (scope || [])) {
		for (const file of (AREA_FILES[area] || []))
			seen[file] = true;
	}

	return Object.keys(seen).sort();
}

function touchesConnectivity(scope) {
	const files = affectedFiles(scope);

	return files.indexOf('network') !== -1 ||
		files.indexOf('firewall') !== -1 ||
		files.indexOf('dhcp') !== -1;
}

/*
 * Advisory findings for a custom selection, mirroring backup_scope_warnings()
 * in the backend.  Errors are handled by the form; these are combinations the
 * backend accepts but that change more or less than the labels suggest.
 */
function scopeWarnings(scope) {
	const areas = scope || [];
	const warnings = [];

	if (areas.indexOf('dawn') !== -1 && areas.indexOf('roaming') === -1)
		warnings.push(_('DAWN is selected without Roaming. The DAWN configuration and the wireless roaming options are restored together, so the wireless configuration changes as well.'));

	if ((areas.indexOf('dhcp') !== -1 || areas.indexOf('firewall') !== -1) &&
		areas.indexOf('network') === -1)
		warnings.push(_('DHCP/DNS or Firewall is selected without Network. Those files are restored, but the network interfaces they refer to are not part of this backup.'));

	return warnings;
}

return baseclass.extend({
	TYPE_NAMES: TYPE_NAMES,
	FREQUENCY_NAMES: FREQUENCY_NAMES,
	typeName: typeName,
	typeDescription: typeDescription,
	defaultScope: defaultScope,
	frequencyName: frequencyName,
	displayName: displayName,
	scopeList: scopeList,
	scopeLabel: scopeLabel,
	scopeText: scopeText,
	affectedFiles: affectedFiles,
	touchesConnectivity: touchesConnectivity,
	scopeWarnings: scopeWarnings
});
