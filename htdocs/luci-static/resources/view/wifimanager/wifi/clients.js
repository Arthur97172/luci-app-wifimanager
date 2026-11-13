'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.mesh as mesh';
'require wifimanager.utils.format as format';
'require dom';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;

function load() {
	return rpc.meshStatus().then(function(status) {
		const parsed = mesh.parseClients(status && status.clients);

		return {
			ok: parsed.ok,
			clients: parsed.clients,
			counts: (status && status.counts) || {},
			state: (status && status.state) || {}
		};
	});
}

return view.extend({
	load: function() {
		// The client list waits on the inventory and the station tables; paint
		// the page first and fill it in when the reply arrives.
		return null;
	},

	render: function() {
		return widgets.deferredPage(_('Clients'),
			_('Devices associated with this device, with the link that carries each one.'),
			load().catch(function(err) { return { error: err }; }),
			this.renderBody.bind(this),
			_('The client list could not be read.'));
	},

	renderBody: function(data) {
		if (!data || data.error)
			return widgets.page(_('Clients'), null, [ widgets.errorBox(data && data.error) ]);

		const content = E('div', {});
		let current = data;

		const renderContent = function() {
			const clients = current.clients || [];
			const wireless = clients.filter(function(entry) {
				return entry.signal != null;
			}).length;

			const rows = clients.map(function(entry) {
				return [
					format.mac(entry.mac),
					entry.hostname || '-',
					entry.iface || '-',
					entry.ip || '-',
					entry.signal != null ? format.signal(entry.signal) : badge(_('Wired'), 'muted'),
					entry.signal != null ? _('Wireless') : _('Bridge')
				];
			});

			dom.content(content, [
				card(_('Connected clients'), [
					!current.ok
						? alert('warn', _('The client list could not be read. The rows below may be incomplete.'))
						: '',
					table([
						{ label: _('MAC address') },
						{ label: _('Hostname') },
						{ label: _('Interface') },
						{ label: _('IPv4 address') },
						{ label: _('Signal') },
						{ label: _('Seen on') }
					], rows, { empty: _('No client is currently known.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('%d client(s) are listed; %d of them are associated wirelessly.').format(clients.length, wireless)
					])
				], { description: _('Wireless stations and devices learned on the LAN bridge. A signal strength exists only for a wireless station; a bridged device is shown without one instead of a guessed value.') }),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/wifi/interfaces', _('Wireless interfaces')),
						adminLink('admin/network/wifimanager/roaming/events', _('Roaming events')),
						adminLink('admin/status/overview', _('Standard status overview'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return load().then(function(next) {
				current = next;
				renderContent();
			});
		}, 15000);

		return widgets.page(_('Clients'), _('Devices associated with this device, with the link that carries each one.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
