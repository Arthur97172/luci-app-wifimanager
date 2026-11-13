'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require wifimanager.utils.backup as backup';
'require wifimanager.utils.validation as validation';
'require dom';
'require ui';

const card = widgets.card;
const badge = widgets.badge;
const alert = widgets.alert;
const kv = widgets.kv;
const field = widgets.field;
const adminLink = widgets.adminLink;

const TYPES = [ 'full', 'wireless', 'mesh', 'roaming', 'custom' ];

function textInput(attributes) {
	return E('input', Object.assign({ 'class': 'cbi-input-text', 'type': 'text' }, attributes || {}));
}

function checkbox(label, checked) {
	const input = E('input', { 'type': 'checkbox' });

	input.checked = !!checked;

	return { input: input, node: E('label', {}, [ input, ' ', label ]) };
}

function inputValue(node) {
	return String(node.value == null ? '' : node.value).trim();
}

return view.extend({
	load: function() {
		return Promise.all([
			rpc.backupStatus().catch(function() { return null; }),
			rpc.backupSettingsGet().catch(function() { return null; })
		]).then(function(result) {
			return { status: result[0] || {}, settings: result[1] || {} };
		});
	},

	render: function(data) {
		const status = data.status || {};
		const settings = (data.settings && data.settings.settings) || {};

		const typeSelect = E('select', { 'class': 'cbi-input-select' },
			TYPES.map(function(type) {
				return E('option', { value: type }, [ backup.typeName(type) ]);
			}));

		typeSelect.value = 'full';

		const typeNote = E('p', { 'class': 'wm-muted' }, []);
		const summary = E('div', {});

		const nameInput = textInput({ placeholder: _('Optional display name'), maxlength: 64 });
		const descriptionInput = textInput({
			placeholder: _('Optional description'),
			maxlength: 200
		});

		const encryptBox = checkbox(_('Encrypt the archive with a passphrase'),
			settings.encrypt_default === true || settings.encrypt_default === 1 ||
			settings.encrypt_default === '1');
		const passwordInput = E('input', {
			'class': 'cbi-input-text',
			'type': 'password',
			'autocomplete': 'new-password',
			'maxlength': 128,
			'placeholder': _('Passphrase')
		});
		const passwordConfirmInput = E('input', {
			'class': 'cbi-input-text',
			'type': 'password',
			'autocomplete': 'new-password',
			'maxlength': 128,
			'placeholder': _('Repeat the passphrase')
		});
		const passwordFields = E('div', { 'style': encryptBox.input.checked ? '' : 'display:none' }, [
			field(_('Passphrase'), passwordInput,
				_('At least 12 characters. Encrypting requires the openssl command on the router.')),
			field(_('Repeat passphrase'), passwordConfirmInput)
		]);

		encryptBox.input.addEventListener('change', function() {
			passwordFields.style.display = encryptBox.input.checked ? '' : 'none';
		});

		const scopeInputs = {};
		const scopeBox = E('div', { 'class': 'wm-scope-box', 'style': 'display:none' });

		for (const area of Object.keys(validation.AREAS)) {
			const entry = checkbox(backup.scopeLabel(area), false);

			scopeInputs[area] = entry.input;
			scopeBox.appendChild(E('div', { 'class': 'wm-scope-entry' }, [ entry.node ]));
		}

		const scopeWarningBox = E('div', {});

		const currentScope = function() {
			const type = typeSelect.value;

			return type === 'custom'
				? Object.keys(scopeInputs).filter(function(area) { return scopeInputs[area].checked; })
				: backup.defaultScope(type);
		};

		const updateScopeWarnings = function() {
			dom.content(scopeWarningBox, backup.scopeWarnings(currentScope()).map(function(text) {
				return alert('warn', text);
			}));
		};

		for (const area of Object.keys(scopeInputs))
			scopeInputs[area].addEventListener('change', updateScopeWarnings);

		const updateType = function() {
			const type = typeSelect.value;

			typeNote.textContent = backup.typeDescription(type);
			scopeBox.style.display = type === 'custom' ? '' : 'none';

			const areas = (type === 'custom' ? [] : backup.defaultScope(type)).map(backup.scopeLabel);

			dom.content(summary, [
				kv([
					[ _('Type'), backup.typeName(type) ],
					[ _('Areas'), areas.length ? areas.join(', ') : _('Choose the areas below') ]
				])
			]);
			updateScopeWarnings();
		};

		typeSelect.addEventListener('change', updateType);
		updateType();

		const result = E('div', {});

		const collect = function() {
			const type = typeSelect.value;

			return {
				type: type,
				scope: currentScope(),
				name: inputValue(nameInput),
				description: inputValue(descriptionInput),
				password: encryptBox.input.checked ? passwordInput.value : ''
			};
		};

		const validate = function(values) {
			if (values.name && !/^[A-Za-z0-9._ -]+$/.test(values.name))
				return _('The name may only contain letters, digits, dots, dashes, underscores and spaces.');

			if (values.name.length > 64)
				return _('The name is too long (64 characters maximum).');

			if (values.description && !validation.isDescription(values.description))
				return _('The description may not contain control characters and is limited to 200 characters.');

			if (values.type === 'custom') {
				if (values.scope.length === 0)
					return _('Select at least one area for a custom backup.');

				if (values.scope.indexOf('mlo') !== -1 && values.scope.indexOf('wireless') === -1)
					return _('The MLO area requires the Wireless area.');

				if ((values.scope.indexOf('mesh') !== -1 || values.scope.indexOf('backhaul') !== -1) &&
					(values.scope.indexOf('wireless') === -1 || values.scope.indexOf('network') === -1))
					return _('Mesh and backhaul areas need the Wireless and Network areas so a restore can rebuild the bridge.');

				if (values.scope.indexOf('roaming') !== -1 && values.scope.indexOf('wireless') === -1)
					return _('The Roaming area requires the Wireless area.');
			}

			if (encryptBox.input.checked) {
				if (values.password.length < 12)
					return _('Use a passphrase of at least 12 characters.');

				if (values.password.length > 128)
					return _('The passphrase is too long (128 characters maximum).');

				if (values.password !== passwordConfirmInput.value)
					return _('The two passphrases do not match.');
			}

			return null;
		};

		const createButton = widgets.button(_('Create backup'), function() {
			const values = collect();
			const problem = validate(values);

			if (problem) {
				widgets.notify('error', problem);
				return;
			}

			ui.showModal(_('Creating backup'), [
				widgets.spinner(_('The configuration is archived; this can take a moment…'))
			]);

			createButton.disabled = true;

			return rpc.backupCreate(values.type, values.scope, values.description,
				values.name, values.password)
				.then(widgets.check)
				.then(function(reply) {
					ui.hideModal();
					createButton.disabled = false;

					dom.content(result, [
						alert('success', _('Backup created: %s (%s).').format(
							reply.id, format.bytesFromKb(reply.size_kb))),
						kv([
							[ _('Archive'), reply.id ],
							[ _('Type'), backup.typeName(reply.type) ],
							[ _('Areas'), backup.scopeText(backup.scopeList(reply)) ],
							[ _('Size'), format.bytesFromKb(reply.size_kb) ],
							[ _('Encryption'), values.password
								? badge(_('Encrypted'), 'info')
								: badge(_('Not encrypted'), 'muted') ]
						]),
						E('p', { 'class': 'wm-muted' }, [
							values.password
								? _('The passphrase is not stored anywhere. Without it the archive cannot be restored or opened.')
								: _('The archive is stored with owner-only permissions in the backup directory.')
						])
					]);

					widgets.notify('info', _('Backup %s created.').format(reply.id));
				})
				.catch(function(err) {
					ui.hideModal();
					createButton.disabled = false;
					widgets.notify('error', err && err.message ? err.message :
						_('The backup could not be created.'));
				});
		}, 'action');

		const freeNote = status.free_kb != null
			? _('%s free in %s.').format(format.bytesFromKb(status.free_kb), status.path || '-')
			: _('The backup store could not be queried.');

		return widgets.page(_('Create backup'),
			_('Archive the selected configuration areas into one integrity-checked file.'),
			[
				card(_('Backup scope'), [
					field(_('Type'), typeSelect, backup.typeDescription('full')),
					typeNote,
					summary,
					scopeBox,
					scopeWarningBox,
					E('p', { 'class': 'wm-muted' }, [
						_('A backup always contains the network configuration it was taken from. A custom selection is still validated against the areas a restore needs to rebuild the bridge.')
					])
				], { description: _('A backup copies configuration files only; it contains no passwords from the UI. Wi-Fi keys are part of the wireless configuration and are therefore inside an unencrypted archive, which is why the file permissions are owner-only.') }),
				card(_('WiFi Manager Backup or OpenWrt Sysupgrade Backup?'), [
					E('p', {}, [
						_('WiFi Manager Backup stores and restores only the configuration files in the selected scope. A restore replaces or merges those files, can restart the network, and can make this page unreachable.')
					]),
					E('p', {}, [
						_('OpenWrt Sysupgrade Backup is a separate mechanism: it covers the whole system configuration and is applied by the firmware during an upgrade. WiFi Manager neither creates nor replaces it.')
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('Use a Sysupgrade backup before flashing firmware. Use a WiFi Manager backup to undo a WiFi, mesh or roaming change without touching the rest of the system.')
					])
				], { description: _('Even a Full backup is limited to the configuration files WiFi Manager knows about; it is not a system image.') }),
				card(_('Labels and protection'), [
					field(_('Name'), nameInput, _('Shown in the backup list. The archive id stays timestamp based.')),
					field(_('Description'), descriptionInput, _('Stored in the archive manifest and shown in the list.')),
					encryptBox.node,
					passwordFields,
					E('p', { 'class': 'wm-muted' }, [
						_('An encrypted archive can only be validated, restored or opened with its passphrase. There is no recovery mechanism on the router; keep the passphrase separately.')
					])
				]),
				card(_('Storage'), [
					kv([
						[ _('Location'), status.path || settings.path || '-'],
						[ _('Backups stored'), String(status.count != null ? status.count : 0) ],
						[ _('Free space'), freeNote ],
						[ _('Retention'), _('Older archives are removed according to the backup settings after each backup.') ]
					]),
					widgets.toolbar([ createButton ])
				]),
				result,
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/backup/overview', _('Backup overview')),
						adminLink('admin/network/wifimanager/backup/restore', _('Restore')),
						adminLink('admin/network/wifimanager/backup/settings', _('Backup settings'))
					])
				])
			]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
