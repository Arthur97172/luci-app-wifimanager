'use strict';
'require baseclass';

/*
 * Validation shared by the forms and by the read-only pages that preview a
 * configuration.  The backend validates the same rules again: a browser check
 * is a convenience, never the security boundary.
 */

function isIPv4(value) {
	const parts = String(value == null ? '' : value).trim().split('.');

	if (parts.length !== 4)
		return false;

	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part))
			return false;

		const n = Number(part);

		if (n < 0 || n > 255)
			return false;
	}

	return true;
}

function ipv4ToInt(value) {
	return String(value).trim().split('.').reduce(function(acc, part) {
		return ((acc << 8) | Number(part)) >>> 0;
	}, 0);
}

function isNetmask(value) {
	if (!isIPv4(value))
		return false;

	const n = ipv4ToInt(value);
	const inverted = (~n) >>> 0;

	return ((inverted + 1) & inverted) === 0;
}

function isMac(value) {
	return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(String(value == null ? '' : value).trim());
}

/*
 * SSIDs are byte strings on the air: 32 octets, not 32 characters.  Counting
 * with encodeURIComponent keeps a Chinese SSID within the limit the driver
 * enforces.
 */
function ssidBytes(value) {
	return encodeURIComponent(String(value == null ? '' : value))
		.replace(/%[0-9A-F]{2}/g, 'x').length;
}

function isSSID(value) {
	const text = String(value == null ? '' : value);

	return text.length > 0 && ssidBytes(text) <= 32;
}

function isMeshId(value) {
	return isSSID(value) && String(value).trim().length > 0;
}

/* WPA2/WPA3 passphrases: 8..63 printable ASCII characters. */
function isKey(value) {
	const text = String(value == null ? '' : value);

	return text.length >= 8 && text.length <= 63 && /^[\x20-\x7e]+$/.test(text);
}

function isMobilityDomain(value) {
	return /^[0-9a-fA-F]{4}$/.test(String(value == null ? '' : value).trim());
}

function isHostname(value) {
	const text = String(value == null ? '' : value).trim();

	return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(text) &&
		text.length <= 63;
}

function isPortName(value) {
	return /^[A-Za-z0-9_.@-]{1,15}$/.test(String(value == null ? '' : value));
}

/* A description shown in lists and logs: printable, bounded, no markup. */
function isDescription(value) {
	const text = String(value == null ? '' : value);

	return text.length <= 200 && !/[\x00-\x1f\x7f]/.test(text);
}

/*
 * The scope areas the backend understands.  The UI offers exactly this list;
 * a value outside it is rejected before the RPC is sent.
 */
const AREAS = {
	wireless: _('Wireless'),
	mlo: _('MLO'),
	mesh: _('Mesh'),
	backhaul: _('Backhaul'),
	roaming: _('Roaming'),
	dawn: _('DAWN'),
	network: _('Network'),
	dhcp: _('DHCP / DNS'),
	firewall: _('Firewall'),
	system: _('System'),
	wifimanager: _('WiFi Manager')
};

function isScopeArea(area) {
	return Object.prototype.hasOwnProperty.call(AREAS, area);
}

return baseclass.extend({
	isIPv4: isIPv4,
	isNetmask: isNetmask,
	isMac: isMac,
	isSSID: isSSID,
	isMeshId: isMeshId,
	isKey: isKey,
	isMobilityDomain: isMobilityDomain,
	isHostname: isHostname,
	isPortName: isPortName,
	isDescription: isDescription,
	isScopeArea: isScopeArea,
	AREAS: AREAS
});
