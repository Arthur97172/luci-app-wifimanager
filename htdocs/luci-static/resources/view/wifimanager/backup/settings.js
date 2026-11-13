'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require wifimanager.utils.backup as backup';

const card = widgets.card;
const alert = widgets.alert;
const badge = widgets.badge;
const table = widgets.table;
const kv = widgets.kv;
const field = widgets.field;
const adminLink = widgets.adminLink;

const FREQUENCIES = [ 'before_change', 'daily', 'weekly', 'manual' ];

function isOn(value) {
	return value === true || value === 1 || value === '1';
}

function numberInput(attributes) {
	return E('input', Object.assign({
		'class': 'cbi-input-text',
		'type': 'number',
		'step': '1'
	}, attributes || {}));
}

function textInput(attributes) {
	return E('input', Object.assign({ 'class': 'cbi-input-text', 'type': 'text' }, attributes || {}));
}

function checkbox(label, checked) {
	const input = E('input', { 'type': 'checkbox' });

	input.checked = !!checked;

	return { input: input, node: E('label', {}, [ input, ' ', label ]) };
}

function intValue(input, fallback) {
	const n = Number(input.value);

	return Number.isInteger(n) ? n : fallback;
}

function pathIsAcceptable(path) {
	if (!path || path.indexOf('..') !== -1)
		return false;

	if (!/^\/(etc|mnt|media|tmp)(\/|$)/.test(path))
		return false;

	return /^\/[A-Za-z0-9._\/-]+$/.test(path);
}

return view.extend({
	load: function() {
		return Promise.all([
			rpc.backupSettingsGet().catch(function() { return null; }),
			rpc.backupStatus().catch(function() { return null; }),
			rpc.backupStorage().catch(function() { return null; })
		]).then(function(result) {
			return {
				settings: result[0] || {},
				status: result[1] || {},
				storage: result[2] || {}
			};
		});
	},

	render: function(data) {
		const settings = (data.settings && data.settings.settings) || {};
		let status = data.status || {};
		const storageInfo = data.storage || {};
		const candidates = storageInfo.candidates || [];

		const enabledBox = checkbox(_('Enable automatic backups'), isOn(settings.enabled));
		const frequencySelect = E('select', { 'class': 'cbi-input-select' },
			FREQUENCIES.map(function(frequency) {
				return E('option', { value: frequency }, [ backup.frequencyName(frequency) ]);
			}));

		frequencySelect.value = FREQUENCIES.indexOf(settings.frequency) !== -1
			? settings.frequency : 'before_change';

		const maxCountInput = numberInput({ min: 1, max: 200 });
		const maxSizeInput = numberInput({ min: 4, max: 4096 });
		const retentionInput = numberInput({ min: 0, max: 3650 });
		const pathInput = textInput({ placeholder: '/etc/wifimanager/backup' });
		const legacyBox = checkbox(_('Show legacy Mesh Assistant backups'),
			settings.legacy_enabled !== false);
		const encryptBox = checkbox(_('Encrypt newly created backups by default'),
			isOn(settings.encrypt_default));

		maxCountInput.value = String(settings.max_count != null ? settings.max_count : 10);
		maxSizeInput.value = String(settings.max_size_mb != null ? settings.max_size_mb : 64);
		retentionInput.value = String(settings.retention_days != null ? settings.retention_days : 0);
		pathInput.value = settings.path || '/etc/wifimanager/backup';

		const warnings = [];

		if (data.settings.ok !== true)
			warnings.push(alert('warn',
				_('The backup settings could not be read; the values shown may be defaults.')));

		const storage = E('div', {});

		const pathUnderExternalRoot = function(path) {
			return /^\/(mnt|media)(\/|$)/.test(path || '');
		};

		// The backend refuses a /mnt or /media path when nothing is mounted
		// there; checking first keeps a directory from being created on the
		// internal flash before the refusal.
		const pathHasMount = function(path) {
			return candidates.some(function(candidate) {
				return candidate.external && (path === candidate.path ||
					path.indexOf(String(candidate.path).replace(/\/$/, '') + '/') === 0);
			});
		};

		const storageWarnings = [];

		if (pathUnderExternalRoot(storageInfo.dir || status.path) && !pathHasMount(storageInfo.dir || status.path))
			storageWarnings.push(alert('warn',
				_('The configured backup path is under /mnt or /media, but no external volume is mounted there. Saving this page will refuse the path until the volume is mounted.')));

		const candidateRows = candidates.map(function(candidate) {
			const kinds = [
				candidate.external ? badge(_('External'), 'ok') : badge(_('Internal flash'), 'muted')
			];

			if (candidate.volatile)
				kinds.push(badge(_('Lost on reboot'), 'warn'));

			return [
				candidate.path,
				candidate.filesystem || '-',
				format.bytesFromKb(candidate.free_kb),
				E('div', {}, kinds),
				candidate.writable ? badge(_('Writable'), 'ok') : badge(_('Not writable'), 'error'),
				widgets.button(_('Use'), function() {
					pathInput.value = candidate.suggested || candidate.path;
					widgets.notify('info',
						_('The location was copied into the field above. Save the settings to use it.'));
				})
			];
		});

		const renderStorage = function() {
			dom.content(storage, [
				...storageWarnings,
				kv([
					[ _('Storage location'), status.path || pathInput.value || '-'],
					[ _('Filesystem'), storageInfo.filesystem || '-' ],
					[ _('Mount point'), storageInfo.mount || '-' ],
					[ _('Backups stored'), String(status.count != null ? status.count : 0) ],
					[ _('Storage used'), format.bytesFromKb(status.total_kb) ],
					[ _('Free space'), format.bytesFromKb(status.free_kb) ],
					[ _('Newest backup'), status.last_created ? format.date(status.last_created) : _('Never') ]
				]),
				table([
					{ label: _('Mount') },
					{ label: _('Filesystem') },
					{ label: _('Free space') },
					{ label: _('Type') },
					{ label: _('State') },
					{ label: _('Action') }
				], candidateRows, { empty: _('No usable storage location was found.') }),
				E('p', { 'class': 'wm-muted' }, [
					_('Only /mnt, /media and /tmp are offered as external locations; /tmp is cleared on reboot and is not suitable for archives that must survive one. The action button copies the suggested path into the field above; nothing is saved until the page is saved.')
				])
			]);
		};

		renderStorage();

		const validate = function(values) {
			if (!pathIsAcceptable(values.path))
				return _('The storage location must be an absolute path under /etc, /mnt, /media or /tmp without "..".');

			if (pathUnderExternalRoot(values.path) && !pathHasMount(values.path))
				return _('No external storage is mounted at this location. Mount the volume or choose another path.');

			if (values.max_count < 1 || values.max_count > 200)
				return _('The maximum number of backups must be between 1 and 200.');

			if (values.max_size_mb < 4 || values.max_size_mb > 4096)
				return _('The maximum storage usage must be between 4 and 4096 MiB.');

			if (values.retention_days < 0 || values.retention_days > 3650)
				return _('The retention period must be between 0 and 3650 days.');

			return null;
		};

		const saveButton = widgets.button(_('Save settings'), function() {
			const values = {
				enabled: enabledBox.input.checked,
				frequency: frequencySelect.value,
				max_count: intValue(maxCountInput, 10),
				max_size_mb: intValue(maxSizeInput, 64),
				retention_days: intValue(retentionInput, 0),
				path: String(pathInput.value || '').trim(),
				legacy_enabled: legacyBox.input.checked,
				encrypt_default: encryptBox.input.checked
			};
			const problem = validate(values);

			if (problem) {
				widgets.notify('error', problem);
				return;
			}

			saveButton.disabled = true;

			return rpc.backupSettingsSet(values.enabled, values.frequency, values.max_count,
				values.max_size_mb, values.retention_days, values.path,
				values.legacy_enabled, values.encrypt_default)
				.then(widgets.check)
				.then(function(reply) {
					saveButton.disabled = false;
					widgets.notify('info', (reply && reply.message) || _('Backup settings saved.'));

					return rpc.backupStatus().then(function(next) {
						status = next || status;
						renderStorage();
					}).catch(function() {});
				})
				.catch(function(err) {
					saveButton.disabled = false;
					widgets.notify('error', err && err.message ? err.message :
						_('The backup settings could not be saved.'));
				});
		}, 'action');

		return widgets.page(_('Backup settings'),
			_('Retention, storage location and how often backups are created automatically.'),
			[
				E('div', {}, warnings),
				card(_('Automatic backups'), [
					enabledBox.node,
					field(_('Frequency'), frequencySelect,
						_('Scheduled backups run from the WiFi Manager timer. "Before configuration changes" keeps the timer off, but the mesh engine and every restore still create their own pre-change backup.')),
					field(_('Maximum backups kept'), maxCountInput,
						_('The oldest archives are removed after a new one is created. Between 1 and 200.')),
					field(_('Maximum storage usage (MiB)'), maxSizeInput,
						_('Oldest archives are removed until the total size fits. Between 4 and 4096 MiB.')),
					field(_('Retention (days)'), retentionInput,
						_('0 keeps backups until the count or size limit removes them. Encrypted archives are never removed by age; they count towards the other limits.'))
				], { description: _('These settings apply to the whole backup store, not only to automatic archives.') }),
				card(_('Storage'), [
					field(_('Storage location'), pathInput,
						_('Must be under /etc, /mnt, /media or /tmp. The directory is created when the setting is saved and receives owner-only permissions. A location that cannot be used falls back to /etc/wifimanager/backup.')),
					storage
				]),
				card(_('Encryption'), [
					encryptBox.node,
					E('p', { 'class': 'wm-muted' }, [
						_('Encrypted archives use AES-256-CBC with PBKDF2-SHA256 and 200000 iterations. The passphrase must have at least 12 characters and is never stored. Archives written by an older release still restore with their original passphrase.')
					])
				], { description: _('This setting only preselects encryption on the Create backup page; it never changes an archive that already exists.') }),
				card(_('Restore safety'), [
					E('p', {}, [
						_('Every restore first creates a full pre-restore backup. This cannot be turned off: the in-memory snapshot used for the automatic rollback does not survive a reboot, so the archive is the copy that remains.')
					]),
					field(_('Legacy backups'), legacyBox.node,
						_('Only controls whether the read-only legacy archives are listed. They are never converted or deleted by this setting.')
					)
				], { description: _('A restore validates the archive, creates the pre-restore backup, applies the selected scope, verifies the result and rolls back automatically when the device does not come back.') }),
				card(_('Save'), [
					widgets.toolbar([ saveButton ]),
					E('p', { 'class': 'wm-muted' }, [
						_('Saving commits /etc/config/wifimanager directly. Other pages keep working with the values they read at load time until they are reloaded.')
					])
				]),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/backup/overview', _('Backup overview')),
						adminLink('admin/network/wifimanager/backup/create', _('Create backup')),
						adminLink('admin/network/wifimanager/backup/restore', _('Restore'))
					])
				])
			]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
