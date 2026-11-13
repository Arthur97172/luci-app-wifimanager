'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require wifimanager.utils.backup as backup';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const kv = widgets.kv;
const adminLink = widgets.adminLink;

function isOn(value) {
	return value === true || value === 1 || value === '1';
}

/*
 * The backend compares the files stored in the newest unencrypted archive
 * with the live files and answers 1, 0 or "unknown".  Unknown is shown as
 * unknown: an encrypted archive cannot be compared without its passphrase
 * (DESIGN §10.4).
 */
function configChangedBadge(value) {
	const state = String(value == null ? '' : value);

	if (state === '1')
		return badge(_('Changed since the newest backup'), 'warn');
	if (state === '0')
		return badge(_('Unchanged'), 'ok');

	return badge(_('Unknown'), 'muted');
}

/*
 * The backend records the outcome of the last automatic backup (timer or
 * pre-change).  A failure is shown as a failure; it is never inferred from the
 * timestamp of the last successful run.
 */
function autoResultBadge(status) {
	const result = String((status && status.auto_result) || '');

	if (result === 'success')
		return badge(_('Succeeded'), 'ok');
	if (result === 'failure')
		return badge(_('Failed'), 'error');

	return badge(_('Never'), 'muted');
}

function autoResultText(status) {
	const result = String((status && status.auto_result) || '');
	const time = status && status.auto_result_time;

	if (result !== 'success' && result !== 'failure')
		return autoResultBadge(status);

	return E('span', {}, [
		autoResultBadge(status),
		time ? E('span', { 'class': 'wm-muted' }, [ ' ', format.dateFromEpoch(time) ]) : '',
		status.auto_result_description
			? E('div', { 'class': 'wm-muted' }, [ status.auto_result_description ])
			: ''
	]);
}

function changedFilesText(status) {
	const files = (status && status.config_changed_files) || [];

	if (files.length)
		return files.join(', ');

	if (String(status && status.config_changed) === '0')
		return _('None');

	return _('Not determinable');
}

function newerFirst(a, b) {
	const left = String(a.created_at || a.id || '');
	const right = String(b.created_at || b.id || '');

	return right.localeCompare(left);
}

return view.extend({
	load: function() {
		return Promise.all([
			rpc.backupStatus().catch(function() { return null; }),
			rpc.backupSettingsGet().catch(function() { return null; }),
			rpc.backupList(true).catch(function() { return null; }),
			rpc.status().catch(function() { return null; })
		]).then(function(result) {
			return {
				status: result[0] || {},
				settingsReply: result[1] || {},
				listReply: result[2] || {},
				system: result[3] || {}
			};
		});
	},

	render: function(data) {
		const status = data.status || {};
		const settings = (data.settingsReply && data.settingsReply.settings) || {};
		const backups = (data.listReply && data.listReply.backups) || [];
		const owned = backups.filter(function(entry) { return !entry.legacy; });
		const legacy = backups.filter(function(entry) { return entry.legacy; });
		const recent = owned.slice().sort(newerFirst).slice(0, 8);

		const warnings = [];

		if (!data.status.ok)
			warnings.push(alert('warn',
				_('The backup store could not be read. The values below may be incomplete.')));

		if (settings.enabled === false)
			warnings.push(alert('info',
				_('Automatic backups are disabled. Only manually created backups are kept.')));

		if (status.auto_result === 'failure')
			warnings.push(alert('warn',
				_('The last automatic backup failed (%s). No archive was created; manual backups and the next scheduled attempt are unaffected.')
					.format(status.auto_result_description || '-')));

		if (legacy.length)
			warnings.push(alert('info',
				_('%d legacy Mesh Assistant backup(s) were found. They are shown read-only and are never converted or deleted automatically.').format(legacy.length)));

		const storageCard = card(_('Backup storage'), [
			kv([
				[ _('Storage location'), status.path || settings.path || '-'],
				[ _('Backups stored'), String(status.count != null ? status.count : owned.length) ],
				[ _('Storage used'), format.bytesFromKb(status.total_kb) ],
				[ _('Free space'), format.bytesFromKb(status.free_kb) ],
				[ _('Newest backup'), status.last_created
					? format.date(status.last_created)
					: (recent.length ? format.date(recent[0].created_at) : _('Never')) ],
				[ _('Current configuration compared with the newest backup'),
					configChangedBadge(status.config_changed) ],
				[ _('Changed files'), changedFilesText(status) ],
				[ _('Last automatic backup'), status.auto_last
					? format.dateFromEpoch(status.auto_last)
					: _('Never') ],
				[ _('Last automatic backup result'), autoResultText(status) ],
				[ _('Legacy backups'), String(legacy.length) ]
			])
		], { description: _('Archives are created atomically and kept with owner-only permissions. The newest backups are kept according to the retention settings. The comparison covers the files stored in the newest unencrypted backup; an encrypted archive or a damaged file is reported as unknown, and files outside the backup scope are not compared.') });

		const settingsCard = card(_('Automatic backup settings'), [
			kv([
				[ _('Automatic backups'), isOn(settings.enabled)
					? badge(_('Enabled'), 'ok') : badge(_('Disabled'), 'muted') ],
				[ _('Frequency'), backup.frequencyName(settings.frequency) ],
				[ _('Maximum backups kept'), String(settings.max_count != null ? settings.max_count : 10) ],
				[ _('Maximum storage usage'), format.bytesFromKb((settings.max_size_mb != null ? settings.max_size_mb : 64) * 1024) ],
				[ _('Retention'), Number(settings.retention_days) > 0
					? _('%d day(s)').format(Number(settings.retention_days))
					: _('Until the count or size limit is reached') ],
				[ _('Pre-restore backup'), badge(_('Always'), 'ok') ],
				[ _('Legacy backups shown'), isOn(settings.legacy_enabled)
					? badge(_('Yes'), 'ok') : badge(_('No'), 'muted') ]
			]),
			widgets.toolbar([
				adminLink('admin/network/wifimanager/backup/settings', _('Change settings'))
			])
		]);

		const recentRows = recent.map(function(entry) {
			return [
				E('div', {}, [
					E('strong', {}, [ backup.displayName(entry) ]),
					entry.name ? E('div', { 'class': 'wm-muted' }, [ entry.id ]) : ''
				]),
				entry.description
					? E('span', { 'class': 'wm-wrap' }, [ entry.description ])
					: '-',
				format.date(entry.created_at),
				backup.typeName(entry.type),
				format.bytesFromKb(entry.size_kb),
				entry.encrypted ? badge(_('Encrypted'), 'info') : badge(_('Not encrypted'), 'muted')
			];
		});

		const recentCard = card(_('Recent backups'), [
			table([
				{ label: _('Name') },
				{ label: _('Description') },
				{ label: _('Created') },
				{ label: _('Type') },
				{ label: _('Size') },
				{ label: _('Encryption') }
			], recentRows, { empty: _('No backup has been created yet.') }),
			E('p', { 'class': 'wm-muted' }, [
				_('Integrity is checked from the Restore page, where each archive is validated before it can be restored.')
			]),
			widgets.toolbar([
				adminLink('admin/network/wifimanager/backup/create', _('Create a backup')),
				adminLink('admin/network/wifimanager/backup/restore', _('Restore or manage backups'))
			])
		], { description: _('The eight newest backups. Encrypted archives need their passphrase to be opened.') });

		const legacyCard = legacy.length ? card(_('Legacy Mesh Assistant backups'), [
			E('p', {}, [
				_('These archives live in /etc/meshassistant/backup. They are listed and validated in place; they are never deleted or rewritten by WiFi Manager. A copy with a current manifest can be created from the Restore page.')
			]),
			widgets.toolbar([
				adminLink('admin/network/wifimanager/backup/restore', _('Open the Restore page'))
			])
		], { description: _('Created by luci-app-meshassistant 2.7.x.') }) : '';

		const scopeNote = card(_('WiFi Manager Backup or OpenWrt Sysupgrade Backup?'), [
			E('p', {}, [
				_('WiFi Manager Backup stores and restores only the configuration files in the selected scope. A restore replaces or merges those files, can restart the network, and can make this page unreachable.')
			]),
			E('p', {}, [
				_('OpenWrt Sysupgrade Backup is a separate mechanism: it covers the whole system configuration and is applied by the firmware during an upgrade. WiFi Manager neither creates nor replaces it.')
			]),
			E('p', { 'class': 'wm-muted' }, [
				_('Use a Sysupgrade backup before flashing firmware. Use a WiFi Manager backup to undo a WiFi, mesh or roaming change without touching the rest of the system.')
			])
		], { description: _('Even a Full backup is limited to the configuration files WiFi Manager knows about; it is not a system image.') });

		const relatedCard = card(_('Related pages'), [
			widgets.list([
				adminLink('admin/network/wifimanager/backup/create', _('Create backup')),
				adminLink('admin/network/wifimanager/backup/restore', _('Restore')),
				adminLink('admin/network/wifimanager/backup/settings', _('Backup settings')),
				adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs'))
			])
		]);

		return widgets.page(_('Backup & Restore'),
			_('Backup storage, retention and the most recent archives.'),
			[
				E('div', {}, warnings),
				storageCard,
				scopeNote,
				settingsCard,
				recentCard,
				legacyCard,
				widgets.operationCard(status.op),
				relatedCard
			]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
