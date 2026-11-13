'use strict';
'require ui';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.wireless as wireless';
'require wifimanager.utils.radio as radio';

/*
 * One dialog shared by the Wireless and MLO pages.  It edits the same
 * allowlisted fields the backend accepts, never loads a stored passphrase into
 * the browser, and states that a Wireless backup precedes every write.
 */

const field = widgets.field;

function textInput(attributes) {
	return E('input', Object.assign({ 'class': 'cbi-input-text', 'type': 'text' }, attributes || {}));
}

function checkbox(label, checked) {
	const input = E('input', { 'type': 'checkbox' });

	input.checked = !!checked;

	return { input: input, node: E('label', {}, [ input, ' ', label ]) };
}

function selectInput(choices, value) {
	const node = E('select', { 'class': 'cbi-input-select' },
		choices.map(function(choice) {
			return E('option', { value: choice.value }, [ choice.label ]);
		}));

	node.value = value == null ? '' : String(value);

	return node;
}

function appendValue(choices, value, label) {
	for (const choice of choices) {
		if (choice.value === value)
			return;
	}

	choices.push({ value: value, label: label });
}

function errorList(errors) {
	return E('ul', { 'class': 'wm-list' }, errors.map(function(message) {
		return E('li', {}, [ message ]);
	}));
}

function open(options) {
	options = options || {};

	const inventory = options.inventory || {};
	const entry = options.entry || null;
	const draft = wireless.defaults(entry, options.overrides);
	const radios = (inventory.radios || []).slice();
	const interfaces = inventory.interfaces || [];
	const networkValues = (inventory.networks || []).slice();

	const modeSelect = selectInput(wireless.MODES, draft.mode);

	const radioInputs = {};
	const radioBoxes = radios.map(function(entryRadio) {
		const box = checkbox('%s (%s)'.format(entryRadio.name,
			entryRadio.band || _('unknown band')), draft.device.indexOf(entryRadio.name) !== -1);
		const hint = radio.capabilityHint(entryRadio.capabilities);

		radioInputs[entryRadio.name] = box.input;

		return E('div', { 'class': 'wm-scope-entry' }, [
			box.node,
			hint ? E('div', { 'class': 'cbi-value-description' }, [ hint ]) : ''
		]);
	});

	const mloBox = checkbox(_('Use MLO across the selected radios'), draft.mlo);

	mloBox.input.addEventListener('change', function() {
		if (mloBox.input.checked)
			return;

		/* Back to a single link: keep the first selected radio. */
		let kept = false;

		for (const name of Object.keys(radioInputs)) {
			if (radioInputs[name].checked) {
				if (kept)
					radioInputs[name].checked = false;
				else
					kept = true;
			}
		}

		renderAdvice();
	});

	for (const name of Object.keys(radioInputs)) {
		radioInputs[name].addEventListener('change', function() {
			if (!radioInputs[name].checked || mloBox.input.checked)
				return;

			for (const other of Object.keys(radioInputs)) {
				if (other !== name)
					radioInputs[other].checked = false;
			}
		});

		renderAdvice();
	}

	modeSelect.addEventListener('change', function() { renderAdvice(); });

	const networkChoices = [];

	for (const name of networkValues)
		appendValue(networkChoices, name, name);

	for (const name of String(draft.network || '').trim().split(/\s+/)) {
		if (name)
			appendValue(networkChoices, name, _('%s (missing)').format(name));
	}

	if (networkChoices.length === 0)
		networkChoices.push({ value: 'lan', label: _('lan (missing)') });

	const networkSelect = selectInput(networkChoices, String(draft.network || '').trim().split(/\s+/)[0] || 'lan');
	const ssidInput = textInput({ value: draft.ssid, maxlength: 32, placeholder: _('Network name') });
	const encryptionSelect = selectInput(wireless.ENCRYPTIONS, draft.encryption);
	const keyInput = E('input', {
		'class': 'cbi-input-text',
		'type': 'password',
		'autocomplete': 'new-password',
		'placeholder': draft.has_key ? _('Stored passphrase (leave blank to keep it)') : _('Passphrase')
	});

	const hiddenBox = checkbox(_('Hide the SSID'), draft.hidden);
	const ieee80211wSelect = selectInput([
		{ value: '', label: _('Default') },
		{ value: '0', label: _('Disabled') },
		{ value: '1', label: _('Optional') },
		{ value: '2', label: _('Required') }
	], draft.ieee80211w);

	const ifnameInput = textInput({ value: draft.ifname, maxlength: 15, placeholder: _('Automatic') });
	const macaddrInput = textInput({ value: draft.macaddr, maxlength: 17, placeholder: _('Not set') });
	const bssidInput = textInput({ value: draft.bssid, maxlength: 17, placeholder: _('Not set') });

	const wdsBox = checkbox(_('WDS'), draft.wds);
	const uapsdBox = checkbox(_('U-APSD'), draft.uapsd);
	const ocvBox = checkbox(_('Operating Channel Validation'), draft.ocv);
	const lowAckBox = checkbox(_('Disassociate clients with a low ACK ratio'), draft.disassoc_low_ack);
	const disabledBox = checkbox(_('Disable this interface'), draft.disabled);

	const errorBox = widgets.alert('error', '');
	errorBox.style.display = 'none';

	/*
	 * Smart radio allocation is advisory.  The facts come from the read-only
	 * radio_advice method once, and the verdicts are recomputed locally when
	 * the mode, the radios or MLO change.  A failed advice call leaves the
	 * editor usable: it never blocks the save and never ticks a checkbox.
	 */
	const adviceNode = E('div', { 'class': 'wm-radio-advice' });
	let advice = null;
	let adviceRequested = false;

	const saveButton = E('button', { 'class': 'btn cbi-button cbi-button-action' },
		[ entry ? _('Save interface') : _('Create interface') ]);

	const readDraft = function() {
		const next = wireless.defaults(entry, options.overrides);
		const originalNetworks = String(draft.network || '').trim().split(/\s+/).filter(function(name) {
			return name;
		});

		next.mode = modeSelect.value;
		next.device = Object.keys(radioInputs).filter(function(name) {
			return radioInputs[name].checked;
		});
		/* Keep extra network attachments when the primary one is unchanged. */
		next.network = [ networkSelect.value ].concat(
			networkSelect.value === originalNetworks[0] ? originalNetworks.slice(1) : []).join(' ');
		next.ssid = ssidInput.value;
		next.encryption = encryptionSelect.value;
		next.key = keyInput.value;
		next.hidden = hiddenBox.input.checked;
		next.ieee80211w = ieee80211wSelect.value;
		next.ifname = String(ifnameInput.value || '').trim();
		next.macaddr = String(macaddrInput.value || '').trim();
		next.bssid = String(bssidInput.value || '').trim();
		next.wds = wdsBox.input.checked;
		next.uapsd = uapsdBox.input.checked;
		next.ocv = ocvBox.input.checked;
		next.disassoc_low_ack = lowAckBox.input.checked;
		next.disabled = disabledBox.input.checked;
		next.mlo = mloBox.input.checked;

		return next;
	};

	const renderAdvice = function() {
		if (!advice) {
			dom.content(adviceNode, []);
			return;
		}

		const next = readDraft();
		const result = radio.advise(advice.radios || [], {
			mode: next.mode,
			device: next.device,
			mlo: next.mlo,
			section: entry ? entry.section : ''
		});

		const verdictNodes = result.verdicts.map(function(verdict) {
			const kind = verdict.level === 'recommended' ? 'ok'
				: (verdict.level === 'avoid' ? 'error' : 'warn');

			return E('div', { 'class': 'wm-event-detail' }, [
				widgets.badge(radio.adviceLevelName(verdict.level), kind),
				' ',
				E('strong', {}, [ radio.radioLabel(radio.findBy(advice.radios || [], 'name', verdict.name) || { name: verdict.name }) ]),
				': ',
				verdict.reasons.map(radio.adviceReason).join(' ')
			]);
		});

		const suggestion = result.suggestion;
		const suggestedNodes = [];

		if (suggestion.type === 'single' || suggestion.type === 'mlo') {
			const names = suggestion.device.map(function(name) {
				const found = radio.findBy(advice.radios || [], 'name', name);

				return found ? radio.radioLabel(found) : name;
			});

			suggestedNodes.push(E('p', {}, [
				E('strong', {}, [
					suggestion.type === 'mlo'
						? _('Suggested MLO pair: %s').format(names.join(' + '))
						: _('Suggested radio: %s').format(names[0])
				])
			]));
		}
		else if (suggestion.notes.length > 0) {
			suggestedNodes.push(E('p', {}, [
				E('strong', {}, [
					_('No radio is suitable: %s').format(suggestion.notes.map(radio.adviceReason).join(' '))
				])
			]));
		}

		for (const code of (suggestion.type === 'mlo' ? suggestion.notes : []))
			suggestedNodes.push(E('p', { 'class': 'wm-muted' }, [ radio.adviceReason(code) ]));

		dom.content(adviceNode, [
			E('p', { 'class': 'wm-muted' }, [
				E('strong', {}, [ _('Radio advice') ]),
				' — ',
				_('advisory only: it never changes the selection and only uses configuration and mesh settings already known to the router.')
			]),
			E('div', {}, verdictNodes),
			E('div', {}, suggestedNodes)
		]);
	};

	const loadAdvice = function() {
		if (adviceRequested)
			return;

		adviceRequested = true;

		rpc.radioAdvice().then(function(reply) {
			if (reply && reply.ok !== false)
				advice = reply;
		}).catch(function() {
			/* The advice is optional; the editor and its save path stay usable. */
		}).then(renderAdvice);
	};

	const close = function(value) {
		ui.hideModal();
		return value;
	};

	let resolveResult;
	const result = new Promise(function(resolve) {
		resolveResult = resolve;
	});

	/*
	 * DESIGN §5.2: the radio allocation check runs before the write.  An
	 * error stops the save; a warning is a combination the driver may reject,
	 * which the operator has to acknowledge instead of it being applied
	 * silently.  The check is read-only and does not touch the configuration.
	 */
	const checkRadio = function(next) {
		const conflicts = function() {
			return rpc.radioCheck({
				mode: next.mode,
				device: next.device || [],
				mlo: !!next.mlo,
				section: entry ? entry.section : ''
			});
		};

		const describe = function(list) {
			return list.map(function(conflict) {
				const message = conflict.message || radio.conflictDetail(conflict);

				return message
					? '%s: %s'.format(radio.conflictTitle(conflict), message)
					: radio.conflictTitle(conflict);
			});
		};

		return conflicts().catch(function() {
			return null;
		}).then(function(reply) {
			if (!reply) {
				return widgets.confirm(_('Radio allocation check'),
					_('The radio allocation check could not be run. Saving without it may apply a combination the driver rejects.'),
					_('Save anyway'), false);
			}

			const all = reply.conflicts || [];
			const errors = all.filter(function(conflict) {
				return conflict.severity === 'error';
			});
			const warnings = all.filter(function(conflict) {
				return conflict.severity !== 'error';
			});

			if (errors.length) {
				errorBox.style.display = '';
				dom.content(errorBox, [
					E('p', {}, [ _('This radio combination cannot be used:') ]),
					errorList(describe(errors)),
					E('p', { 'class': 'wm-muted' }, [
						_('The interface was not saved. Select different radios or another mode.')
					])
				]);
				return false;
			}

			if (!warnings.length)
				return true;

			return widgets.confirm(_('Radio concurrency warning'),
				E('div', {}, [
					E('p', {}, [ _('The selected radios may not support this combination:') ]),
					errorList(describe(warnings))
				]), _('Save anyway'), false);
		});
	};

	const submit = function() {
		const next = readDraft();
		const errors = wireless.validate(next, {
			radios: radios,
			networks: networkValues,
			interfaces: interfaces
		});

		if (errors.length > 0) {
			errorBox.style.display = '';
			dom.content(errorBox, errorList(errors));
			return;
		}

		saveButton.disabled = true;
		errorBox.style.display = 'none';

		checkRadio(next).then(function(proceed) {
			if (!proceed) {
				saveButton.disabled = false;
				return;
			}

			doSave(next);
		});
	};

	const doSave = function(next) {
		errorBox.style.display = '';
		dom.content(errorBox, [ E('p', { 'class': 'wm-muted' }, [ _('Saving the interface and waiting for it to appear…') ]) ]);

		rpc.wirelessIfaceSave(wireless.payload(next)).then(function(reply) {
			widgets.check(reply);

			if (reply.verified === 'skipped') {
				widgets.notify('info', _('Interface %s saved. It is disabled, so no runtime check was run.').format(reply.section));
			}
			else if (reply.verified === 'config-only') {
				widgets.notify('info', _('Interface %s saved. The configuration is verified; the runtime name is assigned by the driver.').format(reply.section));
			}
			else {
				widgets.notify('info', _('Interface %s saved and verified.').format(reply.section));
			}

			for (const warning of reply.warnings || [])
				widgets.notify('warning', warning);

			resolveResult(close(reply));
		}).catch(function(err) {
			saveButton.disabled = false;
			errorBox.style.display = '';
			dom.content(errorBox, [
				E('p', {}, [ err.message || _('The interface could not be saved.') ])
			]);
		});
	};

	saveButton.addEventListener('click', submit);

	const footer = [
		E('button', { 'class': 'btn cbi-button', 'click': function() { resolveResult(close(null)); } },
			[ _('Cancel') ])
	];

	if (entry && !entry.mesh_owned) {
		footer.push(' ');
		footer.push(E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'click': function() {
				resolveResult(close({ action: 'delete', entry: entry }));
			}
		}, [ _('Delete') ]));
	}

	footer.push(' ');
	footer.push(saveButton);

	const nodes = [
		errorBox,
		field(_('Mode'), modeSelect),
		field(_('Radios'), E('div', {}, [
			E('div', {}, radioBoxes.length ? radioBoxes : [ _('No radio was found.') ]),
			adviceNode
		]), _('Select one radio, or two or more when MLO is enabled.')),
		field(_('MLO'), mloBox.node,
			_('An MLO interface needs at least two radios; saving switches them to EHT.')),
		field(_('SSID'), ssidInput, _('1 to 32 bytes.')),
		field(_('Network'), networkSelect,
			_('Only network interfaces that already exist can be selected.')),
		field(_('Encryption'), encryptionSelect),
		field(_('Passphrase'), keyInput,
			draft.has_key
				? _('A passphrase is stored on the router. Leave this blank to keep it; type a new one to replace it.')
				: _('8 to 63 printable ASCII characters.')),
		field(_('Hidden SSID'), hiddenBox.node),
		field(_('802.11w management frame protection'), ieee80211wSelect),
		field(_('Interface name'), ifnameInput,
			_('Optional, at most 15 characters. Leave blank to let the driver choose.')),
		field(_('MAC address'), macaddrInput, _('Optional override.')),
		field(_('BSSID'), bssidInput, _('Optional, for client interfaces.')),
		field(_('Advanced'), E('div', {}, [
			wdsBox.node,
			E('br'),
			uapsdBox.node,
			E('br'),
			ocvBox.node,
			E('br'),
			lowAckBox.node,
			E('br'),
			disabledBox.node
		])),
		field(_('Backup'), E('p', { 'class': 'wm-muted' }, [
			_('A Wireless backup is created before the change. If the new interface does not appear, the previous wireless configuration is restored automatically.')
		])),
		E('div', { 'class': 'right' }, footer)
	];

	ui.showModal(entry ? _('Edit wireless interface: %s').format(entry.section)
		: _('Create wireless interface'), nodes);

	loadAdvice();

	return result;
}

function remove(entry) {
	return widgets.confirm(_('Delete wireless interface'),
		E('p', {}, [
			_('Delete %s? A Wireless backup is created first, and the interface is restored if it cannot be removed.').format(entry.section)
		]),
		_('Delete'), true).then(function(yes) {
		if (!yes)
			return null;

		return rpc.wirelessIfaceDelete({ section: entry.section, confirm: true });
	}).then(function(reply) {
		if (!reply)
			return null;

		widgets.check(reply);
		widgets.notify('info', _('Interface %s deleted.').format(reply.section));

		return reply;
	}).catch(function(err) {
		widgets.notify('error', err.message || _('The interface could not be deleted.'));

		return null;
	});
}

return {
	open: open,
	remove: remove
};
