'use strict';
'require view';
'require form';
'require uci';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.mesh as mesh';
'require wifimanager.utils.format as format';
'require wifimanager.utils.validation as validation';
'require wifimanager.utils.uci as uciutil';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;
const kv = widgets.kv;

/*
 * Physical ports share the namespace with bridges, the mesh device, radio
 * netdevs and tunnels.  Only the remaining names can be handed to batman-adv;
 * the engine checks again before it removes a port from the LAN bridge.
 * Devices that carry the WAN uplink are never offered either: moving one to
 * bat0 would take the router off its uplink.  A port that already belongs to
 * another bridge is refused for the same reason: the LAN bridge is the only
 * one the engine may take a port out of.
 */
const VIRTUAL_RE = /^(lo|br-|bat|mesh|wlan|phy|vlan|tun|tap|wg|pppoe|docker|veth)/;

function portCandidates(system, inventory) {
	const wireless = {};
	const wan = {};
	const ports = [];

	for (const iface of ((inventory && inventory.interfaces) || [])) {
		if (iface.ifname)
			wireless[iface.ifname] = true;
	}

	for (const dev of ((system && system.wan_devices) || []))
		wan[dev] = true;

	for (const iface of ((system && system.interfaces) || [])) {
		const name = String(iface.name || '');

		if (!name || VIRTUAL_RE.test(name) || wireless[name] || wan[name])
			continue;
		if (iface.bridge && !iface.lan_bridge)
			continue;

		ports.push(iface);
	}

	ports.sort(function(a, b) {
		return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
	});

	return ports;
}

function linkStateBadge(state) {
	if (state === 'inuse')
		return badge(_('In use'), 'ok');
	if (state === 'standby')
		return badge(_('Standby'), 'muted');

	return '-';
}

function mediumBadge(medium) {
	if (medium === 'wired')
		return badge(_('Ethernet'), 'ok');
	if (medium === 'wlan')
		return badge(_('Wireless'), 'info');

	return badge(_('Unknown'), 'muted');
}

function activeBadge(medium) {
	if (medium === 'ethernet')
		return badge(_('Ethernet'), 'ok');
	if (medium === 'wireless')
		return badge(_('Wireless'), 'info');

	return badge(_('Unknown'), 'muted');
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

return view.extend({
	load: function() {
		return Promise.all([
			uciutil.ensureConfig('meshassistant'),
			uci.load('wireless').catch(function() { return null; }),
			rpc.meshStatus().catch(function() { return null; }),
			rpc.diagnostics('system').catch(function() { return null; }),
			rpc.radioInventory().catch(function() { return null; }),
			rpc.status().catch(function() { return null; }),
			rpc.backhaulStatus().catch(function() { return null; })
		]).then(function(result) {
			const status = result[2] || {};
			const parsed = mesh.parseStatus(status.neighbors, status.peers,
				status.linkinfo, status.originators);

			return {
				mesh: status,
				parsed: parsed,
				system: result[3] || {},
				status: result[5] || {},
				backhaul: result[6] || {},
				ports: portCandidates(result[3], result[4])
			};
		});
	},

	render: function(data) {
		const self = this;
		const meshStatus = data.mesh || {};
		const parsed = data.parsed || { local: [] };
		const state = meshStatus.state || {};
		const bat0 = meshStatus.bat0 || {};
		const backhaul = data.backhaul || {};
		const backhaulWired = backhaul.wired || {};
		const backhaulWireless = backhaul.wireless || {};
		const wiredConfigured = uci.get('meshassistant', 'config', 'wired_backhaul') === '1';
		const wiredDevice = uci.get('network', 'mesh_wired', 'device') || '';
		const dumbapEnabled = uci.get('meshassistant', 'config', 'ap_mode_enabled') === '1';
		const currentPort = uci.get('meshassistant', 'config', 'wired_port') ||
			uci.get('meshassistant', 'config', 'wired_backhaul_port') || '';

		const ports = (data.ports || []).slice();
		const portNames = ports.map(function(entry) { return entry.name; });
		const wanDevices = (data.system && data.system.wan_devices) || [];

		if (currentPort && portNames.indexOf(currentPort) === -1 &&
		    wanDevices.indexOf(currentPort) === -1)
			ports.push({ name: currentPort, up: false, mac: '', addresses: [],
				bridge: '', lan_bridge: false, speed: 0 });

		const m = new form.Map('meshassistant');

		this.map = m;

		const s = m.section(form.TypedSection, 'meshassistant', _('Backhaul and AP mode'));
		s.anonymous = true;
		s.addremove = false;
		s.tab('wired', _('Wired backhaul'));
		s.tab('switch', _('Automatic switching'));
		s.tab('dumbap', _('AP mode'));

		let o;

		o = s.taboption('wired', form.Flag, 'wired_backhaul', _('Use a wired backhaul'),
			_('Move one Ethernet port out of the LAN bridge and attach it to bat0, so the mesh can use that cable instead of the wireless backhaul. The wireless mesh link stays available as a fallback.'));
		o.default = '0';

		o = s.taboption('wired', form.ListValue, 'wired_port', _('Wired port'),
			_('A port that is not already part of another bridge and does not carry the WAN uplink. If it is in the LAN bridge, the mesh engine removes it from the bridge and records what it removed so disabling the mesh can restore it.'));
		o.depends('wired_backhaul', '1');
		o.rmempty = false;
		for (const entry of ports) {
			const detail = [];

			if (entry.mac)
				detail.push(format.mac(entry.mac));

			if (entry.lan_bridge)
				detail.push(_('LAN bridge'));
			if (Number(entry.speed) > 0)
				detail.push(format.rate(entry.speed));
			detail.push(entry.up ? _('link up') : _('link down'));
			o.value(entry.name, '%s (%s)'.format(entry.name, detail.join(', ')));
		}
		o.default = currentPort || (ports.length ? ports[0].name : '');
		o.validate = function(section_id, value) {
			if (this.formvalue(section_id) === '1' && !value)
				return _('Select a wired port.');

			if (this.formvalue(section_id) === '1' && wanDevices.indexOf(value) !== -1)
				return _('The WAN uplink port cannot be used for the wired backhaul.');

			return true;
		};

		o = s.taboption('wired', form.DummyValue, '_wired_note', '', '');
		o.default = _('Applying this setting creates a full pre-change backup first. If the port cannot be used, the engine keeps the wireless backhaul and reports the reason instead of blocking the mesh.');

		o = s.taboption('switch', form.Flag, 'backhaul_auto', _('Switch the backhaul automatically'),
			_('The monitor samples the wired link carrier, not just the presence of the interface, and detaches the wired hardif from bat0 after the fallback delay. It restores it only after the cable has stayed up for the stability time, so a flapping cable does not move traffic back and forth. The wireless mesh link is never touched.'));
		o.default = '0';

		o = s.taboption('switch', form.ListValue, 'backhaul_pref', _('Preferred backhaul'),
			_('Ethernet preference is the default: the wired link is used whenever it is stable and the wireless mesh takes over when the cable is lost.'));
		o.value('ethernet', _('Ethernet, with wireless fallback'));
		o.value('wireless', _('Wireless, with Ethernet fallback'));
		o.default = 'ethernet';
		o.depends('backhaul_auto', '1');

		o = s.taboption('switch', form.Value, 'backhaul_switch_delay', _('Fallback delay (seconds)'),
			_('How long the wired link must stay down before the wired hardif is detached.'));
		o.datatype = 'range(5,600)';
		o.default = '30';
		o.depends('backhaul_auto', '1');

		o = s.taboption('switch', form.Value, 'backhaul_stable_time', _('Restore stability time (seconds)'),
			_('How long the wired link must stay up before it is used again.'));
		o.datatype = 'range(10,3600)';
		o.default = '60';
		o.depends('backhaul_auto', '1');

		o = s.taboption('switch', form.ListValue, 'backhaul_priority', _('Backhaul priority'),
			_('Automatic priority leaves throughput_override unset so BATMAN-adv measures the real links; the negotiated Ethernet rate is not treated as usable throughput. Manual overrides are written to the hardif sections when the mesh configuration is applied.'));
		o.value('auto', _('Automatic (measured by BATMAN-adv)'));
		o.value('manual', _('Manual throughput override'));
		o.default = 'auto';

		o = s.taboption('switch', form.Value, 'backhaul_wired_mbit', _('Wired throughput override (Mbit/s)'),
			_('Operator estimate for the wired hardif. Leave empty to let BATMAN-adv measure it.'));
		o.datatype = 'range(1,100000)';
		o.depends('backhaul_priority', 'manual');

		o = s.taboption('switch', form.Value, 'backhaul_wireless_mbit', _('Wireless throughput override (Mbit/s)'),
			_('Operator estimate for the wireless mesh hardif. Leave empty to let BATMAN-adv measure it.'));
		o.datatype = 'range(1,100000)';
		o.depends('backhaul_priority', 'manual');

		o = s.taboption('dumbap', form.DummyValue, '_dumbap_note', _('AP mode'), '');
		o.default = _('AP mode turns this router into a bridged access point behind another router: firewall, DHCP and RA are disabled, the WAN port becomes a LAN port, and the LAN address is either obtained over DHCP or set statically. Enabling it changes the LAN address, so this page can become unreachable.');
		o.rawhtml = false;

		o = s.taboption('dumbap', form.ListValue, 'ipmode', _('LAN address mode'),
			_('Static keeps a fixed management address; DHCP takes the address from the upstream router.'));
		o.value('dhcp', _('DHCP client'));
		o.value('static', _('Static address'));
		o.default = 'dhcp';
		o.rmempty = false;

		o = s.taboption('dumbap', form.Value, 'ipaddr', _('Static IPv4 address'),
			_('The address this device keeps on the LAN in AP mode.'));
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (this.formvalue(section_id) === 'static' && !validation.isIPv4(value))
				return _('Enter a valid IPv4 address.');

			return true;
		};

		o = s.taboption('dumbap', form.Value, 'netmask', _('Static netmask'),
			_('Netmask of the static address.'));
		o.depends('ipmode', 'static');
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (this.formvalue(section_id) === 'static' && !validation.isNetmask(value))
				return _('Enter a contiguous IPv4 netmask, for example 255.255.255.0.');

			return true;
		};

		o = s.taboption('dumbap', form.Value, 'gateway', _('Gateway'),
			_('Optional default gateway in AP mode.'));
		o.datatype = 'ip4addr';
		o.depends('ipmode', 'static');

		o = s.taboption('dumbap', form.Value, 'dns', _('DNS server'),
			_('Optional DNS server advertised to clients in AP mode.'));
		o.datatype = 'ip4addr';

		o = s.taboption('dumbap', form.Value, 'hostname', _('Hostname'),
			_('Optional hostname to set while AP mode is enabled. Leaving it empty keeps the current hostname.'));
		o.datatype = 'hostname';

		const runtimeRows = (parsed.local || []).map(function(row) {
			return [
				row.iface || '-',
				mediumBadge(row.backhaul),
				linkStateBadge(row.backhaulState),
				row.radio || '-',
				row.signal || '-',
				row.txRate ? format.rate(row.txRate) : '-',
				row.rxRate ? format.rate(row.rxRate) : '-',
				row.speed ? format.rate(row.speed) : '-',
				row.channel
					? (row.width ? '%s / %s'.format(row.channel, row.width) : String(row.channel))
					: '-',
				row.utilization || '-'
			];
		});

		const runtime = card(_('Runtime backhaul'), [
			kv([
				[ _('Mesh applied'), parsed.active === null
					? badge(_('Unknown'), 'muted')
					: (parsed.active ? badge(_('Active'), 'ok') : badge(_('Not applied'), 'muted')) ],
				[ _('Mesh role'), state.role || parsed.role || '-' ],
				[ _('bat0 device'), bat0.exists
					? (bat0.up ? badge(_('Up'), 'ok') : badge(_('Down'), 'error'))
					: badge(_('Not present'), 'muted') ],
				[ _('Attached hardifs'), (bat0.hardifs || []).join(', ') || '-' ],
				[ _('Selected hardifs'), (bat0.selected || []).join(', ') || '-' ],
				[ _('Wired backhaul configured'), wiredConfigured ? _('Yes') : _('No') ],
				[ _('Wired port in use'), wiredDevice || '-' ],
				[ _('Active backhaul'), activeBadge(backhaul.active) ],
				[ _('Wired carrier'), carrierBadge(backhaulWired.carrier) ],
				[ _('Wired link rate'), backhaulWired.negotiated_mbit
					? format.rate(backhaulWired.negotiated_mbit) : '-' ],
				[ _('Wireless link'), backhaulWireless.healthy
					? badge(_('Healthy'), 'ok')
					: badge(_('Unavailable'), 'warn') ],
				[ _('Last switch'), switchSummary(backhaul.last_switch) ]
			]),
			table([
				{ label: _('Local interface') },
				{ label: _('Medium') },
				{ label: _('State') },
				{ label: _('Radio') },
				{ label: _('Best signal') },
				{ label: _('TX rate') },
				{ label: _('RX rate') },
				{ label: _('Rate') },
				{ label: _('Channel / width') },
				{ label: _('Channel use') }
			], runtimeRows, { empty: _('No interface is attached to bat0 yet.') }),
			E('p', { 'class': 'wm-muted' }, [
				_('The radio is the wireless device behind the hardif. TX and RX rates are measured on the wireless station of the best neighbor; “Rate” is the link throughput batman-adv reports. A wired hardif has no radio and no station rates, so those cells stay empty.')
			])
		]);

		const warnings = [];

		if (currentPort && wanDevices.indexOf(currentPort) !== -1)
			warnings.push(alert('error',
				_('The saved wired port %s carries the WAN uplink. The engine will not use it and keeps the wireless backhaul; select another port.').format(currentPort)));

		if (wiredConfigured && !wiredDevice)
			warnings.push(alert('warn',
				_('A wired backhaul is configured but no port is attached. Save and apply to let the engine attach it, or check that the port is usable.')));

		if (dumbapEnabled)
			warnings.push(alert('info', _('AP mode is enabled on this device.')));

		if (backhaul.last_error)
			warnings.push(alert('error', _('The last automatic backhaul switch failed: %s').format(backhaul.last_error)));

		if (backhaul.auto && !wiredConfigured)
			warnings.push(alert('warn', _('Automatic switching needs the wired backhaul to be enabled.')));
		else if (backhaul.auto && !backhaulWired.device)
			warnings.push(alert('warn', _('Automatic switching is enabled, but no wired backhaul port is configured.')));
		else if (backhaul.auto && backhaul.running === false)
			warnings.push(alert('info', _('Automatic switching is configured but the mesh is not applied, so the monitor is idle.')));

		/* Common commit-then-run path: the engine reads UCI files, not the form. */
		const runAfterSave = function(start, label, title, message, confirmLabel, danger) {
			return widgets.confirm(title, message, confirmLabel, danger).then(function(confirmed) {
				if (!confirmed)
					return;

				ui.showModal(label, [ widgets.spinner(_('Saving the form and starting the operation…')) ]);

				return self.map.save()
					.then(function() { return uci.apply(60); })
					.then(function() { return widgets.runOperation(start, label); })
					.then(function(op) {
						ui.hideModal();
						widgets.notify('info', op.message || _('%s: finished.').format(label));
						window.setTimeout(function() { window.location.reload(); }, 2500);
					})
					.catch(function(err) {
						ui.hideModal();
						widgets.notify('error', err && err.message ? err.message :
							_('The operation failed.'));
					});
			});
		};

		const actions = card(_('Actions'), [
			E('p', { 'class': 'wm-muted' }, [
				_('Actions use the saved form values. Save the form first if you changed an option; every action commits the form before the engine runs and creates a backup on its own.')
			]),
			widgets.toolbar([
				widgets.button(_('Apply saved configuration'), function() {
					return runAfterSave(rpc.meshApply, _('Apply mesh configuration'),
						_('Apply mesh configuration'),
						_('The mesh engine rewrites the wireless and network configuration. Wi-Fi clients may reconnect and this page may be unreachable for a short time.'),
						_('Apply'), false);
				}, 'action'),
				widgets.button(dumbapEnabled ? _('Leave AP mode') : _('Enable AP mode'), function() {
					if (dumbapEnabled)
						return runAfterSave(rpc.meshUndumbap, _('Leave AP mode'),
							_('Leave AP mode'),
							_('The LAN, firewall, DHCP and WAN configuration saved before AP mode was enabled is restored. The LAN address may change back, so this page can become unreachable.'),
							_('Leave AP mode'), true);

					return runAfterSave(rpc.meshDumbap, _('Enable AP mode'),
						_('Enable AP mode'),
						_('Firewall, DHCP and RA are disabled, the WAN port is bridged into the LAN, and the LAN address changes to the selected DHCP or static address. This page will likely become unreachable and must be opened at the new address. A pre-change backup is created automatically.'),
						_('Enable AP mode'), true);
				}, dumbapEnabled ? 'reset' : 'negative')
			]),
			E('p', { 'class': 'wm-muted' }, [
				_('Leaving AP mode restores the network configuration that was saved automatically when AP mode was enabled. If that state is missing, check the standard network configuration before rebooting the device.')
			])
		]);

		return m.render().then(function(mapEl) {
			return widgets.page(_('Mesh backhaul'),
				_('Choose the medium that carries mesh traffic and the LAN behaviour of an access point.'),
				[
					E('div', {}, warnings),
					runtime,
					mapEl,
					actions,
					widgets.operationCard(data.status && data.status.op),
					card(_('Related pages'), [
						widgets.list([
							adminLink('admin/network/wifimanager/mesh/settings', _('Mesh settings')),
							adminLink('admin/network/wifimanager/mesh/topology', _('Mesh topology')),
							adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics'))
						])
					])
				]);
		});
	},

	handleSaveApply: function() {
		const self = this;

		return widgets.confirm(_('Save and apply mesh settings'),
			_('The form is committed and the mesh engine applies it. Wi-Fi clients may reconnect and this page may be unreachable for a short time.'),
			_('Save & apply'), false).then(function(confirmed) {
			if (!confirmed)
				return;

			ui.showModal(_('Applying mesh configuration'), [
				widgets.spinner(_('Saving the form and applying the configuration…'))
			]);

			return self.map.save()
				.then(function() { return uci.apply(60); })
				.then(function() { return widgets.runOperation(rpc.meshApply, _('Apply mesh configuration')); })
				.then(function(op) {
					ui.hideModal();
					widgets.notify('info', op.message || _('Mesh configuration applied.'));
					window.setTimeout(function() { window.location.reload(); }, 2500);
				})
				.catch(function(err) {
					ui.hideModal();
					widgets.notify('error', err && err.message ? err.message :
						_('The configuration could not be applied.'));
				});
		});
	}
});
