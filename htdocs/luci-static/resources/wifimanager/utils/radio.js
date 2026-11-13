'use strict';

/*
 * Radio vocabulary shared by the Wireless, Mesh and Diagnostics pages.
 * The conflict codes are the ones the backend emits, so the UI can explain a
 * code without duplicating the backend's analysis.
 */

const BAND_NAMES = {
	'2g': '2.4 GHz',
	'5g': '5 GHz',
	'6g': '6 GHz'
};

const BAND_NUMBERS = {
	'2g': 2,
	'5g': 5,
	'6g': 6
};

const BAND_MODES = {
	'2g': [ 'HT', 'HE', 'EHT' ],
	'5g': [ 'HT', 'VHT', 'HE', 'EHT' ],
	'6g': [ 'HE', 'EHT' ]
};

const BAND_WIDTHS = {
	'2g': [ 20, 40 ],
	'5g': [ 20, 40, 80, 160 ],
	'6g': [ 20, 40, 80, 160, 320 ]
};

const MODE_NAMES = {
	ap: 'Access Point',
	sta: 'Client (STA)',
	mesh: '802.11s Mesh',
	adhoc: 'Ad-Hoc',
	monitor: 'Monitor',
	'': 'Unknown'
};

const CONFLICT_TITLES = {
	'E-ALLOC-01': 'Radio selected twice',
	'E-ALLOC-02': 'MLO needs two radios',
	'E-ALLOC-03': 'AP on the mesh radio',
	'E-ALLOC-04': 'Enabled interface on a disabled radio',
	'E-ALLOC-05': 'Radio does not exist',
	'W-CONC-01': 'AP and STA share a radio',
	'W-CONC-02': 'AP and mesh share a radio',
	'W-CONC-03': 'MLO and mesh share a radio',
	'W-CHAN-01': 'Spectrum override disagrees',
	'W-CHAN-02': 'Overlapping 2.4 GHz channels',
	'W-CHAN-03': 'DFS channel inside MLO',
	'E-CAP-01': 'Mode not supported by the driver',
	'E-CAP-02': 'Band not supported by the driver',
	'E-CAP-03': 'PHY mode not supported by the driver',
	'E-CAP-04': 'Driver rejects this interface mix',
	'E-CAP-05': 'Channel not advertised by the driver',
	'W-CAP-01': 'Driver capability unconfirmed'
};

function bandName(band) {
	return BAND_NAMES[band] || _('Unknown band');
}

function bandNumber(band) {
	return BAND_NUMBERS[band] || null;
}

function modeName(mode) {
	return MODE_NAMES[mode] || mode || _('Unknown');
}

function parseHtmode(htmode) {
	const match = /^(HT|VHT|HE|EHT)(20|40|80|160|320)$/.exec(htmode || '');

	return match
		? { mode: match[1], width: Number(match[2]) }
		: { mode: '', width: null };
}

function isDfsChannel(band, channel) {
	if (band !== '5g')
		return false;

	channel = Number(channel);

	return (channel >= 52 && channel <= 64) ||
		(channel >= 100 && channel <= 144);
}

function validSpectrumPair(band, mode, width) {
	switch (mode) {
	case 'HT':
		return width === 20 || width === 40;
	case 'VHT':
		return band === '5g' && [ 20, 40, 80, 160 ].indexOf(width) !== -1;
	case 'HE':
		return [ 20, 40, 80, 160 ].indexOf(width) !== -1;
	case 'EHT':
		return [ 20, 40, 80, 160 ].indexOf(width) !== -1 ||
			(band === '6g' && width === 320);
	default:
		return true;
	}
}

function radioLabel(radio) {
	if (!radio)
		return _('Unknown radio');

	const band = radio.band ? bandName(radio.band) : '';

	return band ? '%s (%s)'.format(radio.name, band) : String(radio.name);
}

function findBy(list, key, value) {
	for (const entry of (list || [])) {
		if (entry && entry[key] === value)
			return entry;
	}

	return null;
}

function conflictTitle(conflict) {
	if (!conflict)
		return '';

	return CONFLICT_TITLES[conflict.code] || conflict.code || _('Conflict');
}

function conflictDetail(conflict) {
	if (!conflict)
		return '';

	const parts = [];

	if (conflict.message)
		parts.push(conflict.message);

	if (conflict.detail)
		parts.push('(' + conflict.detail + ')');

	return parts.join(' ');
}

function pushUnique(list, value) {
	if (list.indexOf(value) === -1)
		list.push(value);
}

/*
 * Smart radio allocation, advisory only.
 *
 * The backend reports what UCI and the mesh settings say; this function turns
 * that into a per-radio verdict and a suggested selection.  Nothing here is a
 * measured driver capability: an occupied radio is "possible", never
 * "recommended", and an error code the backend would reject is "avoid".
 * The caller decides what to do with the suggestion; the editor never changes
 * a checkbox on its own.
 */
function advise(radios, options) {
	options = options || {};

	const mode = options.mode || 'ap';
	const mlo = !!options.mlo;
	const section = options.section || '';
	const selected = options.device || [];

	const verdicts = (radios || []).map(function(entry) {
		const reasons = [];
		const usage = (entry.interfaces || []).filter(function(iface) {
			return iface && !iface.disabled && iface.section !== section;
		});

		if (entry.disabled) {
			reasons.push('E-ALLOC-04');
		}
		else if (mode === 'ap' && entry.mesh_radio) {
			reasons.push('E-ALLOC-03');
		}
		else if (usage.length === 0) {
			reasons.push('I-FREE');
		}
		else {
			for (const iface of usage) {
				if (iface.mode === 'mesh' || iface.mesh_owned) {
					if (mode === 'ap')
						pushUnique(reasons, 'W-CONC-02');
					else if (mlo)
						pushUnique(reasons, 'W-CONC-03');
					else
						pushUnique(reasons, 'W-MESH');
				}
				else if ((mode === 'ap' && iface.mode === 'sta') ||
				         (mode === 'sta' && iface.mode === 'ap')) {
					pushUnique(reasons, 'W-CONC-01');
				}
				else {
					pushUnique(reasons, 'W-USED');
				}
			}

			if (entry.mesh_radio)
				pushUnique(reasons, mlo ? 'W-CONC-03' : 'W-MESH');
		}

		const level = reasons.some(function(code) { return code.indexOf('E-') === 0; })
			? 'avoid'
			: (reasons.indexOf('I-FREE') !== -1 ? 'recommended' : 'possible');

		return {
			name: entry.name,
			band: entry.band || '',
			level: level,
			reasons: reasons,
			selected: selected.indexOf(entry.name) !== -1
		};
	});

	const usable = verdicts.filter(function(verdict) {
		return verdict.level !== 'avoid';
	});

	const suggestion = { type: 'none', device: [], notes: [] };

	if (mlo) {
		const pair = pickMloPair(usable);

		if (pair.device.length === 2) {
			suggestion.type = 'mlo';
			suggestion.device = pair.device;
			suggestion.notes = pair.notes;
		}
		else {
			suggestion.notes = [ 'E-ALLOC-02' ].concat(pair.notes);
		}
	}
	else if (usable.length > 0) {
		suggestion.type = 'single';
		suggestion.device = [ usable[0].name ];
	}

	if (suggestion.type === 'none' && suggestion.notes.length === 0) {
		for (const verdict of verdicts) {
			for (const code of verdict.reasons) {
				if (code.indexOf('E-') === 0)
					pushUnique(suggestion.notes, code);
			}
		}
	}

	return { verdicts: verdicts, suggestion: suggestion };
}

function pickMloPair(usable) {
	const notes = [];
	const first = usable[0];

	if (!first)
		return { device: [], notes: notes };

	const other = usable.filter(function(verdict) {
		return verdict !== first && verdict.band !== first.band;
	})[0] || usable[1];

	if (!other)
		return { device: [], notes: notes };

	if (first.band === other.band)
		notes.push('W-SAME-BAND');

	return { device: [ first.name, other.name ], notes: notes };
}

function adviceLevelName(level) {
	switch (level) {
	case 'recommended':
		return _('Recommended');
	case 'possible':
		return _('Possible');
	case 'avoid':
		return _('Avoid');
	default:
		return _('Unknown');
	}
}

function adviceReason(code) {
	switch (code) {
	case 'I-FREE':
		return _('No enabled interface uses this radio.');
	case 'W-USED':
		return _('Another enabled interface already uses this radio; the driver has to support both interfaces at once.');
	case 'W-MESH':
		return _('This is the mesh radio; another interface here depends on the driver and may reduce mesh throughput.');
	case 'W-CONC-01':
		return _('An AP and a client (STA) interface on one radio compete for airtime and may not be supported.');
	case 'W-CONC-02':
		return _('An AP and the mesh share this radio; the driver decides whether both can run.');
	case 'W-CONC-03':
		return _('MLO links and the mesh share this radio; the driver decides whether both can run.');
	case 'W-SAME-BAND':
		return _('Both links are on the same band, so MLO brings less benefit.');
	case 'E-ALLOC-02':
		return _('MLO needs two radios that can run at the same time.');
	case 'E-ALLOC-03':
		return _('An operator AP cannot be placed on the mesh radio.');
	case 'E-ALLOC-04':
		return _('This radio is disabled in the wireless configuration.');
	case 'E-CAP-01':
		return _('The driver does not report this interface mode on this radio.');
	case 'E-CAP-02':
		return _('The driver does not report a usable channel in this band.');
	case 'E-CAP-03':
		return _('The driver does not report this PHY mode in this band.');
	case 'E-CAP-04':
		return _('The reported interface combinations do not allow this mix.');
	case 'E-CAP-05':
		return _('The driver does not advertise the configured channel as usable.');
	case 'W-CAP-01':
		return _('The driver did not report its capabilities, so this combination cannot be confirmed.');
	default:
		return _('No additional information.');
	}
}

/*
 * Driver-reported capabilities (DESIGN §5.1).  Everything here formats data
 * the backend read from "iw phy info"; when the driver reported nothing the
 * caller shows "not reported" instead of inventing a limit.
 */
function capabilityAvailable(entry) {
	return !!(entry && entry.capabilities && entry.capabilities.available);
}

function capabilityModeName(raw) {
	switch (raw) {
	case 'ap':
	case 'AP':
		return _('Access Point (AP)');
	case 'sta':
	case 'managed':
		return _('Client (STA)');
	case 'mesh':
	case 'mesh point':
		return _('802.11s mesh point');
	case 'adhoc':
	case 'IBSS':
		return _('Ad-Hoc (IBSS)');
	case 'AP/VLAN':
		return _('AP VLAN');
	case 'monitor':
		return _('Monitor');
	default:
		return raw || _('Unknown');
	}
}

function bandSummary(band) {
	const modes = [];

	if (band && band.ht)
		modes.push(band.ht40 ? 'HT20/HT40' : 'HT20');
	if (band && band.vht)
		modes.push(band.vht160 ? 'VHT 20–160 MHz' : 'VHT 20–80 MHz');
	if (band && band.he)
		modes.push('HE');
	if (band && band.eht)
		modes.push('EHT');

	return modes.length ? modes.join(', ') : _('No PHY mode reported');
}

/*
 * Whether one reported combination allows a set of interface counts.  Inside
 * a combination the modes of one group are additive and "total" limits the
 * whole combination, which mirrors how cfg80211 states the limits.  A type
 * the combination never mentions is not permitted by it, so a requested mode
 * that appears in no group makes the combination unfit.  The channel count is
 * not checked: one radio always uses one channel.
 */
function comboFits(combo, counts) {
	const used = {
		ap: Number(counts && counts.ap) || 0,
		sta: Number(counts && counts.sta) || 0,
		mesh: Number(counts && counts.mesh) || 0,
		adhoc: Number(counts && counts.adhoc) || 0
	};
	const total = used.ap + used.sta + used.mesh + used.adhoc;
	const mentioned = {};

	for (const group of (combo && combo.groups) || []) {
		let sum = 0;

		for (const mode of group.modes || []) {
			sum += used[mode] || 0;
			mentioned[mode] = true;
		}
		if (sum > Number(group.limit))
			return false;
	}

	for (const mode of Object.keys(used)) {
		if (used[mode] > 0 && !mentioned[mode])
			return false;
	}

	return combo && combo.total != null ? total <= Number(combo.total) : true;
}

/*
 * "supported" / "unsupported" / "unknown" for an interface mix, defaulting to
 * one AP plus one STA.  "unknown" is the honest answer when the driver
 * reported no combination this module can read.
 */
function concurrentSummary(caps, counts) {
	const combos = (caps && caps.combinations) || [];

	if (!caps || !caps.available || !combos.length)
		return 'unknown';

	return combos.some(function(combo) { return comboFits(combo, counts || { ap: 1, sta: 1 }); })
		? 'supported'
		: 'unsupported';
}

function concurrencyLabel(state) {
	switch (state) {
	case 'supported':
		return _('Supported');
	case 'unsupported':
		return _('Not supported');
	default:
		return _('Not reported');
	}
}

function capabilityHint(caps) {
	if (!caps)
		return '';

	return _('Driver reports AP + STA: %s.').format(concurrencyLabel(concurrentSummary(caps)));
}

function combinationText(combo) {
	const parts = ((combo && combo.groups) || []).map(function(group) {
		return '%s ≤ %d'.format((group.modes || []).map(capabilityModeName).join(' + '),
			Number(group.limit));
	});

	if (combo && combo.total != null)
		parts.push(_('total ≤ %d').format(combo.total));
	if (combo && combo.channels != null)
		parts.push(_('channels ≤ %d').format(combo.channels));

	return parts.join('; ');
}

return {
	BAND_NAMES: BAND_NAMES,
	BAND_NUMBERS: BAND_NUMBERS,
	BAND_MODES: BAND_MODES,
	BAND_WIDTHS: BAND_WIDTHS,
	CONFLICT_TITLES: CONFLICT_TITLES,
	bandName: bandName,
	bandNumber: bandNumber,
	modeName: modeName,
	parseHtmode: parseHtmode,
	isDfsChannel: isDfsChannel,
	validSpectrumPair: validSpectrumPair,
	radioLabel: radioLabel,
	findBy: findBy,
	conflictTitle: conflictTitle,
	conflictDetail: conflictDetail,
	advise: advise,
	adviceLevelName: adviceLevelName,
	adviceReason: adviceReason,
	capabilityAvailable: capabilityAvailable,
	capabilityModeName: capabilityModeName,
	bandSummary: bandSummary,
	comboFits: comboFits,
	concurrentSummary: concurrentSummary,
	concurrencyLabel: concurrencyLabel,
	capabilityHint: capabilityHint,
	combinationText: combinationText
};
