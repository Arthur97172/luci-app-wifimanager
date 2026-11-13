'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.mesh as mesh';
'require wifimanager.utils.format as format';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;
const kv = widgets.kv;

function mediumBadge(medium) {
	if (medium === 'wired')
		return badge(_('Ethernet'), 'ok');
	if (medium === 'wlan')
		return badge(_('Wireless'), 'info');

	return badge(_('Unknown'), 'muted');
}

function stateBadge(state) {
	if (state === 'inuse')
		return badge(_('In use'), 'ok');
	if (state === 'standby')
		return badge(_('Standby'), 'muted');

	return '-';
}

function linkCells(row) {
	return [
		mediumBadge(row.backhaul),
		row.iface || '-',
		stateBadge(row.backhaulState),
		row.signal || '-',
		row.speed ? format.rate(row.speed) : '-',
		row.channel
			? (row.width ? '%s / %s'.format(row.channel, row.width) : String(row.channel))
			: '-',
		row.utilization || '-',
		row.load || '-'
	];
}

function load() {
	return rpc.meshStatus().then(function(status) {
		const parsed = mesh.parseStatus(status.neighbors, status.peers,
			status.linkinfo, status.originators);

		return {
			status: status,
			parsed: parsed,
			direct: parsed.rows.filter(function(row) { return !row.announced; }),
			announced: parsed.rows.filter(function(row) { return !!row.announced; })
		};
	});
}

return view.extend({
	load: function() {
		return load().catch(function(err) {
			return { error: err };
		});
	},

	render: function(data) {
		if (!data || data.error)
			return widgets.page(_('Mesh neighbors'), null,
				[ widgets.errorBox(data && data.error) ]);

		const content = E('div', {});
		let current = data;

		const renderContent = function() {
			const status = current.status || {};
			const parsed = current.parsed || { local: [] };
			const state = status.state || {};
			const applied = parsed.active;
			const configured = state.active;

			const warnings = [];

			if (!parsed.ok)
				warnings.push(alert('warn',
					_('The neighbor table could not be read. The lists below may be empty although the mesh is running.')));

			if (configured && applied === false)
				warnings.push(alert('warn',
					_('Mesh is configured but has not been applied. Neighbor data appears after the next successful apply.')));

			const summary = card(_('Summary'), [
				kv([
					[ _('Direct neighbors'), String(current.direct.length) ],
					[ _('Announced devices'), String(new Set(current.announced.map(function(row) {
						return mesh.deviceKey(row);
					})).size) ],
					[ _('Local backhaul interfaces'), String((parsed.local || []).length) ],
					[ _('Mesh applied'), applied === null
						? badge(_('Unknown'), 'muted')
						: (applied ? badge(_('Active'), 'ok') : badge(_('Not applied'), 'muted')) ]
				])
			]);

			const directRows = current.direct.map(function(row) {
				return [
					format.mac(row.neighbor),
					row.hostname || '-',
					(row.ips || []).join(', ') || '-',
					row.lastSeen
				].concat(linkCells(row));
			});

			const announcedRows = current.announced.map(function(row) {
				return [
					row.hostname || _('Unknown device'),
					format.mac(row.neighbor),
					(row.ips || []).join(', ') || '-',
					row.lastSeen || '-'
				].concat(linkCells(row));
			});

			const localRows = (parsed.local || []).map(function(row) {
				return [
					row.iface || '-',
					format.mac(row.neighbor),
					mediumBadge(row.backhaul),
					stateBadge(row.backhaulState),
					row.signal || '-',
					row.speed ? format.rate(row.speed) : '-',
					row.channel
						? (row.width ? '%s / %s'.format(row.channel, row.width) : String(row.channel))
						: '-',
					row.utilization || '-'
				];
			});

			dom.content(content, [
				E('div', {}, warnings),
				summary,
				card(_('Direct neighbors'), [
					table([
						{ label: _('Neighbor') },
						{ label: _('Hostname') },
						{ label: _('IPv4 address') },
						{ label: _('Last seen') },
						{ label: _('Backhaul') },
						{ label: _('Interface') },
						{ label: _('State') },
						{ label: _('Signal') },
						{ label: _('Rate') },
						{ label: _('Channel / width') },
						{ label: _('Channel use') },
						{ label: _('Load') }
					], directRows, { empty: _('No direct mesh neighbor is visible.') })
				], { description: _('Neighbors reported by this device’s batman-adv table. Signal, channel use and load are measured on this side of the link.') }),
				card(_('Announced devices'), [
					table([
						{ label: _('Device') },
						{ label: _('Mesh MAC') },
						{ label: _('IPv4 address') },
						{ label: _('Last seen') },
						{ label: _('Backhaul') },
						{ label: _('Interface') },
						{ label: _('State') },
						{ label: _('Signal') },
						{ label: _('Rate') },
						{ label: _('Channel / width') },
						{ label: _('Channel use') },
						{ label: _('Load') }
					], announcedRows, { empty: _('No other device has announced itself.') })
				], { description: _('Links that the other device reports for itself. The announced rate is the value that device measures; a signal and a channel use cannot be measured from here and therefore stay empty.') }),
				card(_('Local backhaul interfaces'), [
					table([
						{ label: _('Interface') },
						{ label: _('MAC address') },
						{ label: _('Medium') },
						{ label: _('State') },
						{ label: _('Best signal') },
						{ label: _('Rate') },
						{ label: _('Channel / width') },
						{ label: _('Channel use') }
					], localRows, { empty: _('No interface is currently attached to bat0.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('Signal and rate mirror the strongest neighbor on the same interface: this device does not measure a link to itself.')
					])
				]),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/mesh/topology', _('Mesh topology')),
						adminLink('admin/network/wifimanager/mesh/backhaul', _('Backhaul configuration')),
						adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics'))
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

		return widgets.page(_('Mesh neighbors'),
			_('Direct neighbors, announced devices and the interfaces attached to the mesh bridge.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
