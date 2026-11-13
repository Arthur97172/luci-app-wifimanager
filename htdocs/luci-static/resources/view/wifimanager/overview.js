'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require wifimanager.utils.radio as radio';
'require wifimanager.utils.network as network';
'require dom';

const card = widgets.card;
const kv = widgets.kv;
const badge = widgets.badge;
const table = widgets.table;
const alert = widgets.alert;
const adminLink = widgets.adminLink;

return view.extend({
	load: function() {
		return Promise.all([
			rpc.status().catch(function() { return null; }),
			rpc.radioInventory().catch(function() { return null; }),
			rpc.meshStatus().catch(function() { return null; }),
			rpc.networkCheck().catch(function() { return null; }),
			rpc.migrationStatus().catch(function() { return null; })
		]);
	},

	render: function(data) {
		let status = data[0] || {};
		let inventory = data[1] || {};
		let mesh = data[2] || {};
		let networkReport = data[3] || {};
		let migration = data[4] || {};
		const content = E('div', {});

		const summary = function() {
			const counts = mesh.counts || {};
			const backup = status.backup || {};
			const role = (mesh.state && mesh.state.role) || (status.mesh && status.mesh.role) || '-';

			return card(_('Summary'), [
				kv([
					[ _('Product'), '%s %s'.format(status.product || 'WiFi Manager', status.version || '') ],
					[ _('Mesh'), status.mesh && status.mesh.running
						? badge(_('Running'), 'ok')
						: badge(_('Stopped'), 'muted') ],
					[ _('Mesh role'), role ],
					[ _('Radios'), String(inventory.radio_count != null ? inventory.radio_count : (status.radios || 0)) ],
					[ _('Wireless interfaces'), String((inventory.interfaces || []).length) ],
					[ _('Mesh neighbors'), String(counts.neighbors != null ? counts.neighbors : 0) ],
					[ _('Connected clients'), String(counts.clients != null ? counts.clients : 0) ],
					[ _('Backups'), String(backup.count != null ? backup.count : 0) ],
					[ _('Last backup'), backup.last_created ? format.date(backup.last_created) : _('Never') ]
				])
			]);
		};

		const meshCard = function() {
			const state = mesh.state || {};
			const bat0 = mesh.bat0 || {};
			const service = mesh.service || {};

			return card(_('Mesh status'), [
				kv([
					[ _('Configured'), state.active ? _('Enabled') : _('Disabled') ],
					[ _('Mesh SSID'), state.mesh_id || '-'],
					[ _('Mesh radio'), state.mesh_radio || '-'],
					[ _('bat0 device'), bat0.exists
						? (bat0.up ? badge(_('Up'), 'ok') : badge(_('Down'), 'error'))
						: badge(_('Not present'), 'muted') ],
					[ _('Backhaul interfaces'), (bat0.hardifs || []).join(', ') || '-'],
					[ _('Selected backhaul'), (bat0.selected || []).join(', ') || '-'],
					[ _('WiFi Manager service'), service.wifimanager_running
						? badge(_('Running'), 'ok') : badge(_('Stopped'), 'muted') ],
					[ _('Legacy service'), service.legacy_installed
						? (service.legacy_running ? badge(_('Running'), 'warn') : badge(_('Stopped'), 'muted'))
						: _('Not installed') ]
				])
			]);
		};

		const conflictsCard = function() {
			const conflicts = inventory.conflicts || [];

			if (conflicts.length === 0)
				return card(_('Configuration checks'), [
					alert('success', _('No radio allocation or channel conflict was found.'))
				]);

			return card(_('Configuration checks'), [
				table([
					{ label: _('Severity'), render: function(c) {
						return badge(c.severity === 'error' ? _('Error') : _('Warning'),
							c.severity === 'error' ? 'error' : 'warn');
					} },
					{ label: _('Code'), key: 'code' },
					{ label: _('Message'), className: 'wm-wrap', render: function(c) {
						return radio.conflictTitle(c) + ': ' + (c.message || '');
					} }
				], conflicts, { empty: _('No conflicts.') })
			], { description: _('Allocation and channel problems are detected from UCI and the running radios.') });
		};

		const migrationCard = function() {
			if (!migration.pending)
				return '';

			const notices = [];

			if (migration.old_valid === false || migration.old_valid === 0)
				notices.push(alert('error',
					_('The installed configuration did not parse when the migration was prepared. Check the affected file before confirming; the pre-migration backup stays available.')));

			const run = function(action, success) {
				return action().then(widgets.check).then(function() {
					widgets.notify('info', success);
					return refresh();
				}).catch(function(err) {
					widgets.notify('error', (err && err.message) || _('The request failed.'));
				});
			};

			return card(_('Migration from Mesh Assistant'), [
				E('div', {}, notices),
				E('p', {}, [
					_('Mesh Assistant is installed on this router. WiFi Manager validated its configuration, took a pre-migration backup when it could and stopped the legacy service so two managers never run at once. Confirm the migration to finish the switch, or restore the legacy service.')
				]),
				kv([
					[ _('Detected'), migration.detected_at
						? format.dateFromEpoch(Number(migration.detected_at))
						: _('Unknown') ],
					[ _('Legacy configuration'), migration.old_valid === false || migration.old_valid === 0
						? badge(_('Invalid'), 'error') : badge(_('Valid'), 'ok') ],
					[ _('Legacy service'), migration.legacy_running
						? badge(_('Running'), 'warn') : badge(_('Stopped'), 'muted') ],
					[ _('Mesh runtime'), migration.mesh_running
						? badge(_('bat0 up'), 'ok') : badge(_('bat0 down'), 'warn') ],
					[ _('Pre-migration backup'), migration.backup || _('None') ]
				]),
				widgets.toolbar([
					widgets.button(_('Confirm migration'), function() {
						return widgets.confirm(_('Confirm migration'),
							_('WiFi Manager takes over the Mesh Assistant configuration. The Mesh Assistant service stays stopped; its configuration and backups are not deleted. Continue?'),
							_('Confirm migration'), false).then(function(yes) {
							if (!yes)
								return;

							return run(function() { return rpc.migrationConfirm(true); },
								_('Migration confirmed. WiFi Manager manages the configuration; the Mesh Assistant service stays stopped.'));
						});
					}, 'action'),
					widgets.button(_('Restore legacy service'), function() {
						return widgets.confirm(_('Restore the Mesh Assistant service'),
							_('The Mesh Assistant service is enabled and started again, and WiFi Manager records the migration as declined. This is refused while the WiFi Manager mesh is enabled.'),
							_('Restore legacy service'), true).then(function(yes) {
							if (!yes)
								return;

							return run(function() { return rpc.migrationRestoreLegacy(true); },
								_('Mesh Assistant is enabled again; WiFi Manager records the migration as declined.'));
						});
					}, 'reset')
				])
			]);
		};

		const operation = function() {
			return widgets.operationCard(status.op);
		};

		const shortcuts = function() {
			return card(_('Shortcuts'), [
				widgets.list([
					adminLink('admin/network/wifimanager/wireless/radios', _('Radios and channels')),
					adminLink('admin/network/wifimanager/mesh/topology', _('Mesh topology')),
					adminLink('admin/network/wifimanager/backup/overview', _('Backup & Restore')),
					adminLink('admin/network/wifimanager/diagnostics/system', _('System diagnostics'))
				])
			]);
		};

		const renderContent = function() {
			dom.content(content, [
				migrationCard(), summary(), meshCard(), conflictsCard(),
				network.findingsCard(networkReport), operation(), shortcuts()
			]);
		};

		const refresh = function() {
			return Promise.all([
				rpc.status().catch(function() { return status; }),
				rpc.radioInventory().catch(function() { return inventory; }),
				rpc.meshStatus().catch(function() { return mesh; }),
				rpc.networkCheck().catch(function() { return networkReport; }),
				rpc.migrationStatus().catch(function() { return migration; })
			]).then(function(next) {
				status = next[0] || status;
				inventory = next[1] || inventory;
				mesh = next[2] || mesh;
				networkReport = next[3] || networkReport;
				migration = next[4] || migration;
				renderContent();
			});
		};

		renderContent();

		const page = widgets.page(_('WiFi Manager'),
			_('Unified wireless, MLO, mesh and roaming control for this device.'),
			[ content ]);

		widgets.autoRefresh(refresh, 15000);

		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
