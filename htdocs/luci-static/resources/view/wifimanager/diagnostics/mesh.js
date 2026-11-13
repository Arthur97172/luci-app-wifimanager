'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require dom';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const kv = widgets.kv;
const adminLink = widgets.adminLink;

function isOn(value) {
	return value === true || value === 1 || value === '1';
}

function stateBadge(value) {
	return isOn(value) ? badge(_('Yes'), 'ok') : badge(_('No'), 'muted');
}

function serviceBadge(installed, enabled, running) {
	if (!isOn(installed))
		return badge(_('Not installed'), 'muted');

	if (isOn(running))
		return badge(_('Running'), 'ok');

	if (isOn(enabled))
		return badge(_('Enabled, stopped'), 'warn');

	return badge(_('Disabled'), 'muted');
}

function roleName(role) {
	switch (role) {
	case 'server': return _('Server (root node)');
	case 'node': return _('Node (mesh point)');
	case 'client': return _('Client (wireless client)');
	case '': return '-';
	default: return role;
	}
}

function text(value) {
	return value == null || value === '' ? '-' : String(value);
}

function carrierBadge(state) {
	if (state === 'up')
		return badge(_('Up'), 'ok');
	if (state === 'absent')
		return badge(_('Not present'), 'muted');
	if (state === 'unknown')
		return badge(_('Unknown'), 'muted');

	return badge(_('Down'), 'error');
}

function activeBadge(medium) {
	if (medium === 'ethernet')
		return badge(_('Ethernet'), 'ok');
	if (medium === 'wireless')
		return badge(_('Wireless'), 'info');

	return badge(_('Unknown'), 'muted');
}

function switchSummary(last) {
	if (!last || !last.ts)
		return _('No switch has been recorded since boot.');

	const parts = [];

	if (last.from && last.to)
		parts.push('%s → %s'.format(last.from, last.to));
	if (last.reason)
		parts.push(last.reason);

	return '%s · %s'.format(format.dateFromEpoch(last.ts), parts.join(' · '));
}

/*
 * Each check results in one explicit row: what was compared, the verdict and
 * what the operator can do about it.  A missing measurement is reported as
 * unknown, not as a failure.
 */
function checkRows(diag) {
	const config = diag.config || {};
	const service = diag.service || {};
	const runtime = diag.runtime || {};
	const checks = diag.checks || {};
	const rows = [];

	if (checks.config_runtime_mismatch === true) {
		rows.push([
			_('Configuration vs runtime'),
			badge(_('Mismatch'), 'error'),
			_('Mesh is configured as running, but bat0 does not exist. The service either failed to start or has not finished starting.'),
			adminLink('admin/network/wifimanager/diagnostics/logs', _('Open the logs'))
		]);
	}
	else if (isOn(config.running)) {
		rows.push([
			_('Configuration vs runtime'),
			badge(_('Consistent'), 'ok'),
			runtime.bat0_up
				? _('Mesh is configured as running and bat0 exists with operstate up.')
				: _('Mesh is configured as running and bat0 exists, but its operstate is not up.'),
			''
		]);
	}
	else {
		rows.push([
			_('Configuration vs runtime'),
			badge(_('Not running'), 'muted'),
			_('Mesh is not configured as running, so runtime state is not compared.'),
			''
		]);
	}

	rows.push([
		_('batctl'),
		isOn(service.batctl) ? badge(_('Available'), 'ok') : badge(_('Missing'), 'warn'),
		isOn(service.batctl)
			? _('Neighbor and originator queries can be executed.')
			: _('Neighbors and topology need the batctl package; the configuration itself does not.'),
		''
	]);

	return rows;
}

return view.extend({
	load: function() {
		return rpc.diagnostics('mesh').catch(function(err) {
			return { ok: false, message: err && err.message };
		});
	},

	render: function(diag) {
		if (!diag || diag.ok === false)
			return widgets.page(_('Mesh diagnostics'), null, [
				widgets.errorBox(new Error((diag && diag.message) ||
					_('The mesh diagnostics could not be read.')))
			]);

		const content = E('div', {});
		let current = diag;

		const renderContent = function() {
			const config = current.config || {};
			const service = current.service || {};
			const runtime = current.runtime || {};
			const backhaul = current.backhaul || {};
			const backhaulWired = backhaul.wired || {};
			const backhaulWireless = backhaul.wireless || {};
			const links = current.links || {};
			const checks = current.checks || {};
			const hardifs = links.hardifs || [];
			const selected = links.selected || [];
			const neighbors = current.neighbors || [];
			const originators = current.originators || [];
			const batctl = isOn(service.batctl);

			const notices = [];

			if (checks.config_runtime_mismatch === true)
				notices.push(alert('error',
					_('Mesh is configured as running but bat0 does not exist.')));

			dom.content(content, [
				E('div', {}, notices),
				card(_('Configuration'), [
					kv([
						[ _('Mesh enabled'), stateBadge(config.enabled) ],
						[ _('Configured to run'), stateBadge(config.running) ],
						[ _('Role'), roleName(config.role) ],
						[ _('Mesh radio'), text(config.mesh_radio) ],
						[ _('Mesh ID'), text(config.mesh_id) ],
						[ _('AP radios'), text(config.ap_radios) ],
						[ _('MLO'), stateBadge(config.mlo) ],
						[ _('Wired backhaul'), stateBadge(config.wired_backhaul) ]
					])
				], { description: _('Values as stored in /etc/config/meshassistant. They describe intent and are not proof of what is running.') }),
				card(_('Services'), [
					table([
						{ label: _('Service') },
						{ label: _('State') },
						{ label: _('Details') }
					], [
						[ 'wifimanager',
						  serviceBadge(true, service.wifimanager_enabled, service.wifimanager_running),
						  _('Mesh manager and timer of WiFi Manager.') ]
					], { empty: _('No service information.') })
				]),
				card(_('Runtime (batman-adv)'), [
					kv([
						[ _('bat0 exists'), stateBadge(runtime.bat0_exists) ],
						[ _('bat0 operstate'), runtime.bat0_exists
							? (isOn(runtime.bat0_up) ? badge(_('Up'), 'ok') : badge(_('Down'), 'error'))
							: '-' ],
						[ _('bat0 MAC'), format.mac(runtime.bat0_mac) ],
						[ _('Peers'), String(runtime.peers != null ? runtime.peers : '-') ]
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('The peer count is read from the WiFi Manager peer cache, which is refreshed by the mesh engine and travels with the event log. It is not a live batctl query.')
					])
				], { description: _('Runtime state is read from the kernel after the service started. It can lag behind a configuration change until the mesh service is re-applied.') }),
				card(_('Backhaul runtime'), [
					kv([
						[ _('Automatic switching'), stateBadge(backhaul.auto) ],
						[ _('Monitor running'), stateBadge(backhaul.running) ],
						[ _('Preferred backhaul'), backhaul.pref === 'wireless'
							? _('Wireless') : _('Ethernet') ],
						[ _('Active backhaul'), activeBadge(backhaul.active) ],
						[ _('Wired port'), text(backhaulWired.device) ],
						[ _('Wired carrier'), carrierBadge(backhaulWired.carrier) ],
						[ _('Wired link rate'), backhaulWired.negotiated_mbit
							? format.rate(backhaulWired.negotiated_mbit) : '-' ],
						[ _('Wireless link'), backhaulWireless.healthy
							? badge(_('Healthy'), 'ok')
							: badge(_('Unavailable'), 'warn') ],
						[ _('Last switch'), switchSummary(backhaul.last_switch) ]
					]),
					backhaul.last_error
						? alert('error', _('The last automatic backhaul switch failed: %s').format(backhaul.last_error))
						: ''
				], { description: _('Carrier state and switch timing are read from the kernel. The active medium is the state the monitor recorded, not a measurement of traffic.') }),
				card(_('Links'), [
					kv([
						[ _('batman-adv hard interfaces'), hardifs.length ? hardifs.join(', ') : _('None') ],
						[ _('Interfaces selected in the configuration'), selected.length ? selected.join(', ') : _('None') ]
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('The hard interface list is what batman-adv has actually attached. The selected list is what the configuration asks for; when they differ, the mesh has not been applied yet or an interface disappeared.')
					])
				]),
				card(_('Neighbors'), [
					table([
						{ label: _('Interface') },
						{ label: _('Neighbor') },
						{ label: _('Last seen') }
					], neighbors.map(function(entry) {
						return [
							text(entry.iface),
							format.mac(entry.mac),
							text(entry.last_seen)
						];
					}), { empty: batctl
						? _('No direct neighbor is currently known to batman-adv.')
						: _('batctl is not installed, so the neighbor table cannot be read.') })
				], { description: _('Direct batman-adv neighbours of this node and when each was last heard. The table is read live from batctl and is empty when bat0 is not running.') }),
				card(_('Originators'), [
					table([
						{ label: _('Originator') },
						{ label: _('Table row'), className: 'wm-wrap' }
					], originators.map(function(entry) {
						return [
							format.mac(entry.originator),
							text(entry.detail)
						];
					}), { empty: batctl
						? _('batman-adv has not learned any originator yet.')
						: _('batctl is not installed, so the originator table cannot be read.') })
				], { description: _('Nodes batman-adv can reach and the path it selected, as printed by batctl originators. Only the local view of this node is shown; the topology page combines the announcements of every node.') }),
				card(_('Checks'), [
					table([
						{ label: _('Check') },
						{ label: _('Result') },
						{ label: _('Explanation'), className: 'wm-wrap' },
						{ label: _('Action') }
					], checkRows(current), { empty: _('No checks.') })
				], { description: _('Configuration, service and runtime are reported separately so a stopped service is not mistaken for a broken configuration.') }),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/mesh/settings', _('Mesh settings')),
						adminLink('admin/network/wifimanager/mesh/topology', _('Topology')),
						adminLink('admin/network/wifimanager/mesh/neighbors', _('Neighbors')),
						adminLink('admin/network/wifimanager/diagnostics/wireless', _('Wireless diagnostics')),
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return rpc.diagnostics('mesh').then(function(next) {
				if (next && next.ok !== false) {
					current = next;
					renderContent();
				}
			});
		}, 20000);

		return widgets.page(_('Mesh diagnostics'),
			_('Configuration, services, batman-adv runtime and link state, each reported separately.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
