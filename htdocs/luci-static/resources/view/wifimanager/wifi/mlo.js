'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.radio as radio';
'require wifimanager.utils.wireless-form as wirelessForm';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;

function deviceList(value) {
	return String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean);
}

function reloadSoon() {
	window.setTimeout(function() { window.location.reload(); }, 1200);
}

function openForm(inventory, entry) {
	return wirelessForm.open({
		inventory: inventory,
		entry: entry,
		overrides: entry ? null : { mlo: true, mode: 'ap' }
	}).then(function(reply) {
		if (!reply)
			return null;

		if (reply.action === 'delete')
			return wirelessForm.remove(reply.entry).then(function(done) {
				if (done)
					reloadSoon();
			});

		reloadSoon();

		return reply;
	}).catch(function(err) {
		widgets.notify('error', err.message || _('The MLO interface could not be saved.'));
	});
}

return view.extend({
	load: function() {
		return rpc.radioInventory().then(function(inventory) {
			const links = (inventory.interfaces || []).filter(function(entry) {
				return entry.mlo;
			});

			return Promise.all(links.map(function(entry) {
				return rpc.radioCheck({
					mode: entry.mode || 'ap',
					device: deviceList(entry.device),
					mlo: true,
					section: entry.section
				}).catch(function() { return null; });
			})).then(function(checks) {
				return { inventory: inventory, checks: checks };
			});
		}).catch(function(err) {
			return { error: err };
		});
	},

	render: function(data) {
		if (!data || data.error)
			return widgets.page(_('MLO'), null, [ widgets.errorBox(data && data.error) ]);

		const inventory = data.inventory || {};
		const radios = {};
		const links = (inventory.interfaces || []).filter(function(entry) {
			return entry.mlo;
		});
		const conflicts = (inventory.conflicts || []).filter(function(conflict) {
			return [ 'E-ALLOC-02', 'W-CONC-03', 'W-CHAN-03' ].indexOf(conflict.code) !== -1;
		});

		for (const entry of (inventory.radios || []))
			radios[entry.name] = entry;

		if (links.length === 0) {
			return widgets.page(_('MLO'), _('Wi-Fi 7 Multi-Link Operation combines two radios into one access point.'),
				[
					card(_('MLO interfaces'), [
						alert('info', _('No MLO interface is configured on this device.')),
						E('p', {}, [
							_('A standalone MLO interface can be created here without using Mesh. It needs at least two radios, and saving switches those radios to EHT mode. Mesh Settings has a separate MLO option for the mesh access point; the two paths do not share a wireless section.')
						]),
						E('div', { 'class': 'wm-toolbar' }, [
							widgets.button(_('Create MLO interface'), function() {
								openForm(inventory, null);
							})
						]),
						widgets.list([
							adminLink('admin/network/wifimanager/mesh/settings', _('Open Mesh Settings')),
							adminLink('admin/network/wifimanager/wireless/radios', _('Review radios'))
						])
					]),
					(conflicts.length ? card(_('MLO-related findings'), [
						table([
							{ label: _('Severity') },
							{ label: _('Code') },
							{ label: _('Message'), className: 'wm-wrap' }
						], conflicts.map(function(c) {
							return [
								badge(c.severity === 'error' ? _('Error') : _('Warning'),
									c.severity === 'error' ? 'error' : 'warn'),
								c.code,
								c.message || ''
							];
						}))
					]) : E([]))
				]);
		}

		const rows = links.map(function(entry, index) {
			const devices = deviceList(entry.device);
			const check = data.checks[index];
			const checks = (check && check.conflicts) || [];
			const htmode = devices.map(function(name) {
				const dev = radios[name];

				return dev ? (dev.htmode || _('not set')) : _('missing');
			}).join(', ');

			return [
				E('strong', {}, [ entry.section ]),
				entry.runtime_ifname || entry.ifname || '-',
				entry.ssid || '-',
				devices.map(function(name) {
					const dev = radios[name];

					return dev ? '%s (%s)'.format(name, radio.bandName(dev.band)) : name;
				}).join(', ') || '-',
				htmode,
				entry.network || '-',
				entry.up ? badge(_('Up'), 'ok') : badge(_('Down'), 'error'),
				checks.length
					? checks.map(function(c) {
						return badge(c.code, c.severity === 'error' ? 'error' : 'warn');
					})
					: badge(_('No conflict'), 'ok'),
				entry.mesh_owned
					? badge(_('Managed by Mesh'), 'muted')
					: E('span', {}, [
						widgets.button(_('Edit'), function() { openForm(inventory, entry); }),
						' ',
						widgets.button(_('Delete'), function() {
							wirelessForm.remove(entry).then(function(done) {
								if (done)
									reloadSoon();
							});
						}, 'negative')
					])
			];
		});

		const checkDetails = [];

		links.forEach(function(entry, index) {
			const check = data.checks[index];
			const checks = (check && check.conflicts) || [];

			for (const conflict of checks) {
				checkDetails.push([
					entry.section,
					badge(conflict.severity === 'error' ? _('Error') : _('Warning'),
						conflict.severity === 'error' ? 'error' : 'warn'),
					conflict.code,
					radio.conflictTitle(conflict),
					conflict.message || '',
					conflict.detail || ''
				]);
			}
		});

		return widgets.page(_('MLO'), _('Wi-Fi 7 Multi-Link Operation across two radios.'),
			[
				card(_('MLO interfaces'), [
					E('div', { 'class': 'wm-toolbar' }, [
						widgets.button(_('Create MLO interface'), function() {
							openForm(inventory, null);
						})
					]),
					table([
						{ label: _('Section') },
						{ label: _('Interface') },
						{ label: _('SSID') },
						{ label: _('Radios') },
						{ label: _('PHY mode') },
						{ label: _('Network') },
						{ label: _('State') },
						{ label: _('Checks') },
						{ label: _('Actions') }
					], rows)
				], { description: _('Each MLO link needs at least two radios, and both must be switched to EHT. A DFS channel inside the link can delay association while the radar check runs.') }),
				card(_('Allocation checks'), [
					table([
						{ label: _('Section') },
						{ label: _('Severity') },
						{ label: _('Code') },
						{ label: _('Check') },
						{ label: _('Message'), className: 'wm-wrap' },
						{ label: _('Detail') }
					], checkDetails, { empty: _('No MLO allocation problem was found.') })
				]),
				conflicts.length ? card(_('Findings from the radio inventory'), [
					table([
						{ label: _('Severity') },
						{ label: _('Code') },
						{ label: _('Message'), className: 'wm-wrap' }
					], conflicts.map(function(c) {
						return [
							badge(c.severity === 'error' ? _('Error') : _('Warning'),
								c.severity === 'error' ? 'error' : 'warn'),
							c.code,
							c.message || ''
						];
					}))
				]) : E([]),
				card(_('Related settings'), [
					widgets.list([
						adminLink('admin/network/wifimanager/mesh/settings', _('Open Mesh Settings for the mesh MLO option')),
						adminLink('admin/network/wireless', _('Open the standard Wireless configuration'))
					])
				])
			]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
