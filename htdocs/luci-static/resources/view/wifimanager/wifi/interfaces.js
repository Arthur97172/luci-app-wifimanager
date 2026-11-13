'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.radio as radio';
'require wifimanager.utils.wireless-form as wirelessForm';
'require dom';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const adminLink = widgets.adminLink;

function flags(entry) {
	const marks = [];

	if (entry.mlo)
		marks.push(badge('MLO', 'info'));
	if (entry.mesh_owned)
		marks.push(badge(_('Mesh-owned'), 'info'));
	if (entry.disabled)
		marks.push(badge(_('Disabled'), 'muted'));
	else if (entry.up)
		marks.push(badge(_('Up'), 'ok'));
	else
		marks.push(badge(_('Down'), 'error'));

	return E('span', {}, marks);
}

return view.extend({
	load: function() {
		return rpc.radioInventory().catch(function(err) {
			return { ok: false, message: err.message };
		});
	},

	render: function(inventory) {
		if (!inventory || inventory.ok === false)
			return widgets.page(_('Interfaces'), null, [
				widgets.errorBox(new Error((inventory && inventory.message) || _('The wireless interfaces could not be read.')))
			]);

		let current = inventory;
		const content = E('div', {});

		const refresh = function() {
			return rpc.radioInventory().then(function(next) {
				if (next && next.ok !== false) {
					current = next;
					renderContent();
				}
			}).catch(function(err) {
				widgets.notify('error', err.message || _('The wireless interfaces could not be read.'));
			});
		};

		const openForm = function(entry) {
			return wirelessForm.open({ inventory: current, entry: entry }).then(function(reply) {
				if (!reply)
					return null;

				if (reply.action === 'delete')
					return wirelessForm.remove(reply.entry).then(function(done) {
						return done ? refresh() : null;
					});

				return refresh();
			}).catch(function(err) {
				widgets.notify('error', err.message || _('The interface could not be saved.'));
			});
		};

		const actions = function(entry) {
			if (entry.mesh_owned || entry.mode === 'mesh')
				return badge(_('Managed by Mesh'), 'muted');

			return E('span', {}, [
				widgets.button(_('Edit'), function() { openForm(entry); }),
				' ',
				widgets.button(_('Delete'), function() {
					wirelessForm.remove(entry).then(function(done) {
						if (done)
							refresh();
					});
				}, 'negative')
			]);
		};

		const renderContent = function() {
			const radios = {};
			const interfaces = current.interfaces || [];

			for (const entry of (current.radios || []))
				radios[entry.name] = entry;

			const rows = interfaces.map(function(entry) {
				const bands = String(entry.device || '').trim().split(/\s+/).map(function(name) {
					return radios[name] ? radio.bandName(radios[name].band) : '';
				}).filter(Boolean).join(', ');

				return [
					E('strong', {}, [ entry.section ]),
					entry.runtime_ifname || entry.ifname || '-',
					radio.modeName(entry.mode),
					entry.device ? '%s%s'.format(entry.device, bands ? ' (' + bands + ')' : '') : '-',
					entry.mode === 'mesh' ? (entry.mesh_id || '-') : (entry.ssid || '-'),
					entry.network || '-',
					entry.encryption || _('Open'),
					String(entry.stations != null ? entry.stations : 0),
					flags(entry),
					actions(entry)
				];
			});

			dom.content(content, [
				card(_('Wireless interfaces'), [
					E('div', { 'class': 'wm-toolbar' }, [
						widgets.button(_('Create interface'), function() { openForm(null); })
					]),
					table([
						{ label: _('Section') },
						{ label: _('Interface') },
						{ label: _('Mode') },
						{ label: _('Radio') },
						{ label: _('SSID / Mesh ID') },
						{ label: _('Network') },
						{ label: _('Encryption') },
						{ label: _('Stations') },
						{ label: _('State') },
						{ label: _('Actions') }
					], rows, { empty: _('No wireless interfaces were found.') })
				], { description: _('This list is read from /etc/config/wireless and from the running system, including each interface’s runtime state. Mesh-owned interfaces are edited in Mesh Settings. A Wireless backup is created before every save or delete.') }),
				card(_('Related settings'), [
					widgets.list([
						adminLink('admin/network/wireless', _('Open the standard Wireless configuration')),
						adminLink('admin/network/wifimanager/wireless/radios', _('Review radio allocation')),
						adminLink('admin/network/wifimanager/wireless/clients', _('See connected clients'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return rpc.radioInventory().then(function(next) {
				if (next && next.ok !== false) {
					current = next;
					renderContent();
				}
			});
		}, 15000);

		return widgets.page(_('Interfaces'), _('Access points, mesh links, client links and their runtime state.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
