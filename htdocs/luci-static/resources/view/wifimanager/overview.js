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
		// The page paints at once; the four replies fill it in as they land.
		return null;
	},

	render: function() {
		const pending = Promise.all([
			rpc.status().catch(function() { return null; }),
			rpc.radioInventory().catch(function() { return null; }),
			rpc.meshStatus().catch(function() { return null; }),
			rpc.networkCheck().catch(function() { return null; })
		]);

		return widgets.deferredPage(_('WiFi Manager'),
			_('Unified wireless, MLO, mesh and roaming control for this device.'),
			pending, this.renderBody.bind(this),
			_('The WiFi Manager status could not be read.'));
	},

	renderBody: function(data) {
		let status = data[0] || {};
		let inventory = data[1] || {};
		let mesh = data[2] || {};
		let networkReport = data[3] || {};
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
				summary(), meshCard(), conflictsCard(),
				network.findingsCard(networkReport), operation(), shortcuts()
			]);
		};

		const refresh = function() {
			return Promise.all([
				rpc.status().catch(function() { return status; }),
				rpc.radioInventory().catch(function() { return inventory; }),
				rpc.meshStatus().catch(function() { return mesh; }),
				rpc.networkCheck().catch(function() { return networkReport; })
			]).then(function(next) {
				status = next[0] || status;
				inventory = next[1] || inventory;
				mesh = next[2] || mesh;
				networkReport = next[3] || networkReport;
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
