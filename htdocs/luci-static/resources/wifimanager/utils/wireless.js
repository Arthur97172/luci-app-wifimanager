'use strict';
'require baseclass';

/*
 * Pure draft validation for the wireless interface editor.  The same rules
 * exist in root/usr/lib/wifimanager/wireless.sh; this module gives immediate
 * feedback, while the backend remains the authority and performs the radio
 * check, backup, commit and runtime verification.
 */

const MODES = [
	{ value: 'ap', label: _('Access point') },
	{ value: 'sta', label: _('Client (STA)') },
	{ value: 'adhoc', label: _('Ad-hoc') }
];

const ENCRYPTIONS = [
	{ value: 'none', label: _('Open') },
	{ value: 'psk2', label: _('WPA2-PSK') },
	{ value: 'psk-mixed', label: _('WPA/WPA2 mixed') },
	{ value: 'sae', label: _('WPA3-SAE') },
	{ value: 'sae-mixed', label: _('WPA2/WPA3 mixed') },
	{ value: 'owe', label: _('OWE (enhanced open)') }
];

const KEY_ENCRYPTIONS = [ 'psk2', 'psk-mixed', 'sae', 'sae-mixed' ];

function deviceList(value) {
	if (Array.isArray(value))
		return value.slice();

	return String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean);
}

function utf8Bytes(value) {
	let bytes = 0;

	for (const character of String(value == null ? '' : value)) {
		const code = character.codePointAt(0);

		bytes += code < 0x80 ? 1 : (code < 0x800 ? 2 : (code < 0x10000 ? 3 : 4));
	}

	return bytes;
}

function validIfname(value) {
	return /^[A-Za-z0-9_.-]{0,15}$/.test(value);
}

function validMac(value) {
	return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value);
}

function validKey(value) {
	const text = String(value == null ? '' : value);

	return text.length >= 8 && text.length <= 63 &&
		/^[\x20-\x7e]+$/.test(text) && !/[\x00-\x1f\x7f]/.test(text);
}

function defaults(entry, overrides) {
	const draft = {
		section: '',
		mode: 'ap',
		device: [],
		network: 'lan',
		ssid: '',
		encryption: 'psk2',
		key: '',
		hidden: false,
		ieee80211w: '',
		ifname: '',
		macaddr: '',
		bssid: '',
		wds: false,
		uapsd: false,
		ocv: false,
		disassoc_low_ack: false,
		disabled: false,
		mlo: false,
		has_key: false
	};

	if (entry) {
		draft.section = entry.section || '';
		draft.mode = entry.mode || 'ap';
		draft.device = deviceList(entry.device);
		draft.network = entry.network || (draft.mode === 'sta' ? 'wan' : 'lan');
		draft.ssid = entry.ssid || '';
		draft.encryption = entry.encryption || 'none';
		draft.hidden = !!entry.hidden;
		draft.ieee80211w = entry.ieee80211w == null ? '' : String(entry.ieee80211w);
		draft.ifname = entry.ifname || '';
		draft.macaddr = entry.macaddr || '';
		draft.bssid = entry.bssid || '';
		draft.wds = !!entry.wds;
		draft.uapsd = !!entry.uapsd;
		draft.ocv = !!entry.ocv;
		draft.disassoc_low_ack = !!entry.disassoc_low_ack;
		draft.disabled = !!entry.disabled;
		draft.mlo = !!entry.mlo;
		draft.has_key = !!entry.has_key;
	}

	return Object.assign(draft, overrides || {});
}

function validate(draft, options) {
	options = options || {};

	const errors = [];
	const radios = options.radios || [];
	const networks = options.networks || [];
	const interfaces = options.interfaces || [];
	const devices = deviceList(draft.device);
	const known = {};

	for (const radio of radios)
		known[radio.name] = radio;

	if ([ 'ap', 'sta', 'adhoc' ].indexOf(draft.mode) === -1)
		errors.push(_('Choose a valid interface mode.'));

	if (draft.mlo && draft.mode === 'adhoc')
		errors.push(_('MLO is only available for access point and client interfaces.'));

	if (devices.length === 0) {
		errors.push(_('Select at least one radio.'));
	}
	else {
		const seen = {};

		for (const name of devices) {
			if (!known[name])
				errors.push(_('The radio %s does not exist.').format(name));
			else if (seen[name])
				errors.push(_('The same radio is selected more than once.'));
			seen[name] = true;
		}
	}

	if (draft.mlo) {
		if (devices.length < 2)
			errors.push(_('MLO needs at least two radios.'));
	}
	else if (devices.length !== 1) {
		errors.push(_('Select exactly one radio unless the interface uses MLO.'));
	}

	const network = String(draft.network || '').trim();

	if (!network) {
		errors.push(_('Select the network the interface belongs to.'));
	}
	else {
		for (const name of network.split(/\s+/)) {
			if (!/^[A-Za-z0-9_]+$/.test(name))
				errors.push(_('The network name contains invalid characters.'));
			else if (networks.length > 0 && networks.indexOf(name) === -1)
				errors.push(_('The network %s does not exist.').format(name));
		}
	}

	const ssid = String(draft.ssid || '');

	if (!ssid)
		errors.push(_('The SSID is empty.'));
	else if (utf8Bytes(ssid) > 32)
		errors.push(_('The SSID is longer than 32 bytes.'));

	if ([ 'none', 'owe' ].concat(KEY_ENCRYPTIONS).indexOf(draft.encryption) === -1)
		errors.push(_('Choose a supported encryption mode.'));

	if (KEY_ENCRYPTIONS.indexOf(draft.encryption) !== -1) {
		if (draft.key) {
			if (!validKey(draft.key))
				errors.push(_('The passphrase must be 8 to 63 printable ASCII characters.'));
		}
		else if (!draft.section || !draft.has_key) {
			errors.push(_('A passphrase is required for this encryption mode.'));
		}
	}

	if (!validIfname(String(draft.ifname || '')))
		errors.push(_('The interface name may contain at most 15 letters, digits, dots, dashes or underscores.'));

	if (draft.ifname) {
		for (const entry of interfaces) {
			if (entry && entry.section !== draft.section && entry.ifname === draft.ifname)
				errors.push(_('The interface name %s is already in use.').format(draft.ifname));
		}
	}

	if (draft.macaddr && !validMac(draft.macaddr))
		errors.push(_('The MAC address is invalid.'));

	if (draft.bssid && !validMac(draft.bssid))
		errors.push(_('The BSSID is invalid.'));

	if ([ '', '0', '1', '2' ].indexOf(String(draft.ieee80211w)) === -1)
		errors.push(_('802.11w must be 0, 1 or 2.'));

	return errors;
}

function payload(draft) {
	const result = {
		section: draft.section || '',
		mode: draft.mode,
		device: deviceList(draft.device),
		network: String(draft.network || '').trim(),
		ssid: String(draft.ssid || ''),
		encryption: draft.encryption,
		hidden: !!draft.hidden,
		ieee80211w: String(draft.ieee80211w == null ? '' : draft.ieee80211w),
		ifname: String(draft.ifname || '').trim(),
		macaddr: String(draft.macaddr || '').trim(),
		bssid: String(draft.bssid || '').trim(),
		wds: !!draft.wds,
		uapsd: !!draft.uapsd,
		ocv: !!draft.ocv,
		disassoc_low_ack: !!draft.disassoc_low_ack,
		disabled: !!draft.disabled,
		mlo: !!draft.mlo
	};

	if (draft.key)
		result.key = draft.key;

	return result;
}

function modeName(mode) {
	for (const entry of MODES) {
		if (entry.value === mode)
			return entry.label;
	}

	return mode || _('Unknown');
}

return baseclass.extend({
	MODES: MODES,
	ENCRYPTIONS: ENCRYPTIONS,
	KEY_ENCRYPTIONS: KEY_ENCRYPTIONS,
	deviceList: deviceList,
	utf8Bytes: utf8Bytes,
	defaults: defaults,
	validate: validate,
	payload: payload,
	modeName: modeName
});
