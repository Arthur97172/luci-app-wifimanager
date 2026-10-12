'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require dom';
'require poll';
'require rpc';

const callLuciWirelessDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getWirelessDevices',
	expect: { '': {} }
});

const callIwinfoAssoclist = rpc.declare({
	object: 'iwinfo',
	method: 'assoclist',
	params: [ 'device', 'mac' ],
	expect: { results: [] }
});

function listValues(value) {
	return L.toArray(value).map(v => String(v).trim()).filter(v => v.length > 0);
}

function uniqueValues(value) {
	// Object.create(null), not {}: UCI section names may be "constructor" or
	// "toString", which a plain object would report as already seen, silently
	// dropping the value from the returned list.
	let seen = Object.create(null);
	let out = [];

	for (let item of listValues(value)) {
		if (seen[item])
			continue;

		seen[item] = true;
		out.push(item);
	}

	return out;
}

/**
 * Seeds a ListValue's value from the UCI config if the option is missing from
 * the form submission. Mirrors stock Wireless page behavior (wireless.js):
 * - The option has no default/rmempty, so formvalue() returns null on first
 *   render (not the default), allowing the seeded value to show.
 * - On save, if the user didn't change it, the seeded value is written back.
 * - This prevents "default=ap" from being written to every legacy interface
 *   that never had a mode option.
 * - Also adds the loaded value to keylist/vallist if not present, so values
 *   outside the static list (e.g. 'wpa2' for encryption, or 'monitor' for mode,
 *   which the stock Wireless page offers) are preserved on save instead of
 *   being silently replaced by the first candidate.
 */
L.keepConfiguredValue = function(option) {
	option.load = function(sectionId) {
		// sectionId is passed by AbstractSection.load() / openModal().
		// Do NOT use this.section.section - in modal context this.section is
		// the GridSection (list view), not the CBINamedSection for the modal.
		let section = this.section;
		let map = section ? section.map : null;
		if (map && map.data && map.data.get && sectionId) {
			let uciValue = map.data.get('wireless', sectionId, this.option);
			if (uciValue !== null && uciValue !== undefined) {
				// Dynamically add to keylist/vallist if not present (stock maclist pattern)
				let keys = this.keylist || [];
				if (keys.indexOf(uciValue) === -1) {
					keys.push(uciValue);
					(this.vallist ||= []).push(uciValue);
				}
				return uciValue;
			}
		}
		return undefined;
	};
	// No default, no rmempty: formvalue() returns null on first render,
	// allowing the seeded cfgvalue to show. On save, formvalue() == default
	// (both null/undefined) so write() is skipped unless user changed it.
	option.default = undefined;
	option.rmempty = false;
};

function optionValue(section, option) {
	return uci.get('wireless', section, option);
}

function nextSectionName(prefix) {
	let idx = 0;
	let sid = null;

	do {
		sid = '%s%d'.format(prefix, idx++);
	} while (uci.get('wireless', sid) != null);

	return sid;
}

function radioLabel(radio) {
	let bits = [radio['.name']];

	if (radio.band)
		bits.push(radio.band);

	if (radio.channel)
		bits.push(_('channel %s').format(radio.channel));

	return bits.join(' | ');
}

function radioMap(radios) {
	// Object.create(null) so that a missing radio name is reported as missing
	// instead of resolving to an inherited member such as "constructor".
	let out = Object.create(null);

	for (let radio of radios)
		out[radio['.name']] = radio;

	return out;
}

function renderBadge(label, background, foreground) {
	return E('span', {
		'style': 'display:inline-block;margin:0 .35em .35em 0;padding:.15em .55em;border-radius:999px;background:%s;color:%s;font-size:12px;line-height:1.3;white-space:nowrap;'.format(background, foreground || '#fff')
	}, label);
}

function renderMetaLine(label, value) {
	return E('div', { 'style': 'margin:.15em 0;' }, [
		E('strong', { 'style': 'margin-right:.35em;' }, label),
		value
	]);
}

function compactChildren(items) {
	return items.filter(item => item !== null && item !== undefined && item !== false);
}

function renderJoinedValues(values, mapper) {
	let out = [];

	for (let i = 0; i < values.length; i++) {
		if (i > 0)
			out.push(', ');

		out.push(mapper(values[i], i));
	}

	return out;
}

function replaceNode(oldNode, newNode) {
	if (oldNode && oldNode.parentNode)
		oldNode.parentNode.replaceChild(newNode, oldNode);
}

function stationKey(station) {
	if (typeof(station) == 'string')
		return station.toLowerCase();

	if (!station || typeof(station) != 'object')
		return null;

	return (station.mac || station.addr || station.mld_addr || station.mldAddr ||
		station.address || JSON.stringify(station)).toLowerCase();
}

function flattenWirelessStatus(status) {
	// sections is keyed by UCI section name, so it must not inherit from
	// Object.prototype: looking up a section called "constructor" would
	// otherwise yield a function and break every caller that reads
	// .ifnames / .stations off the result.
	let runtime = {
		radios: [],
		sections: Object.create(null),
		activeMldIfnames: []
	};

	for (let radioName in status || {}) {
		let radio = status[radioName] || {};
		let cfg = radio.config || {};

		runtime.radios.push({
			name: radioName,
			up: !!radio.up,
			band: cfg.band,
			channel: cfg.channel
		});

		for (let iface of L.toArray(radio.interfaces)) {
			let sid = iface.section;
			let ifaceCfg = iface.config || {};
			let info;

			if (!sid)
				continue;

			info = runtime.sections[sid] || {
				ifnames: [],
				radios: [],
				up: false,
				stations: 0,
				stationMap: {},
				mode: null,
				ssid: null,
				encryption: null,
				mldDetected: false
			};

			if (iface.ifname && info.ifnames.indexOf(iface.ifname) < 0)
				info.ifnames.push(iface.ifname);

			if (info.radios.indexOf(radioName) < 0)
				info.radios.push(radioName);

			info.up = info.up || !!radio.up;
			info.mode = info.mode || ifaceCfg.mode;
			info.ssid = info.ssid || ifaceCfg.ssid;
			info.encryption = info.encryption || ifaceCfg.encryption;
			info.mldDetected = info.mldDetected ||
				(iface.ifname && iface.ifname.indexOf('-mld') > -1) ||
				uniqueValues(ifaceCfg.device).length > 1;

			for (let station of L.toArray(iface.stations)) {
				let key = stationKey(station);

				if (key)
					info.stationMap[key] = true;
			}

			info.stations = Object.keys(info.stationMap).length;

			runtime.sections[sid] = info;

			if (iface.ifname && iface.ifname.indexOf('-mld') > -1 && runtime.activeMldIfnames.indexOf(iface.ifname) < 0)
				runtime.activeMldIfnames.push(iface.ifname);
		}
	}

	runtime.radios.sort((a, b) => L.naturalCompare(a.name, b.name));
	runtime.activeMldIfnames.sort(L.naturalCompare);

	return runtime;
}

function enrichRuntimeStations(runtime) {
	let tasks = [];

	for (let sectionName in runtime.sections) {
		let info = runtime.sections[sectionName];

		info.stationMap = {};
		info.stations = 0;

		for (let ifname of info.ifnames) {
			tasks.push(
				L.resolveDefault(callIwinfoAssoclist(ifname, null), []).then(function(stations) {
					for (let station of L.toArray(stations)) {
						let key = stationKey(station);

						if (key)
							info.stationMap[key] = true;
					}

					info.stations = Object.keys(info.stationMap).length;
				})
			);
		}
	}

	return Promise.all(tasks).then(function() {
		return runtime;
	});
}

function collectSummary(runtime, radios) {
	let sections = uci.sections('wireless', 'wifi-iface');
	let summary = {
		totalIfaces: sections.length,
		mloIfaces: 0,
		invalidMlo: 0,
		customIfname: 0,
		warnings: []
	};

	for (let section of sections) {
		let devices = uniqueValues(section.device);
		let isMlo = section.mlo == '1';

		if (!isMlo)
			continue;

		summary.mloIfaces++;

		if (devices.length < 2)
			summary.invalidMlo++;

		if (section.ifname)
			summary.customIfname++;
	}

	if (!radios.length)
		summary.warnings.push(_('No radio is configured. MLO needs at least two radios.'));
	else if (radios.length < 2)
		summary.warnings.push(_('Only one radio is configured. MLO needs at least two radios.'));

	if (!summary.totalIfaces)
		summary.warnings.push(_('No wireless interfaces are configured yet.'));
	else if (!summary.mloIfaces)
		summary.warnings.push(_('No MLO-enabled wireless interface is configured yet.'));

	if (summary.invalidMlo)
		summary.warnings.push(_('%d MLO interface(s) still have fewer than two radios selected.').format(summary.invalidMlo));

	if (summary.mloIfaces && !runtime.activeMldIfnames.length)
		summary.warnings.push(_('MLO is configured, but no active runtime MLD interface is currently reported.'));

	if (summary.customIfname)
		summary.warnings.push(_('%d MLO interface(s) override the auto-generated MLD ifname.').format(summary.customIfname));

	return summary;
}

function renderMetric(label, value) {
	return E('div', {
		'style': 'flex:1 1 10em;min-width:10em;padding:.85em 1em;border:1px solid #d7d7d7;border-radius:10px;background:#fafafa;'
	}, [
		E('div', { 'style': 'font-size:12px;color:#666;margin-bottom:.25em;' }, label),
		E('div', { 'style': 'font-size:22px;font-weight:600;line-height:1.2;' }, value)
	]);
}

function renderSummaryBox(runtime, summary, addApMlo, addStaMlo, refreshStatus) {
	let warningList = summary.warnings.length
		? E('ul', { 'style': 'margin:.75em 0 0 1.2em;' },
			summary.warnings.map(w => E('li', { 'style': 'margin:.25em 0;' }, w)))
		: E('div', { 'style': 'margin-top:.75em;color:#2f6f3e;' },
			_('Runtime detection looks healthy. Auto-generated MLD names appear as <code>ap-mldX</code> or <code>sta-mldX</code>.'));

		return E('div', {
			'class': 'cbi-section',
			'data-mlo-summary-box': '1'
		}, [
			E('h3', _('WiFi Manager Overview')),
			E('div', {
				'style': 'display:flex;gap:.75em;flex-wrap:wrap;margin:.5em 0 1em 0;'
			}, [
			renderMetric(_('Configured radios'), String(runtime.radios.length)),
			renderMetric(_('Wireless interfaces'), String(summary.totalIfaces)),
			renderMetric(_('MLO-enabled'), String(summary.mloIfaces)),
			renderMetric(_('Active MLD ifnames'), runtime.activeMldIfnames.length ? runtime.activeMldIfnames.join(', ') : _('none'))
		]),
		E('div', {
			'style': 'display:flex;gap:.5em;flex-wrap:wrap;margin-bottom:.5em;'
		}, [
			E('button', {
				'class': 'cbi-button cbi-button-add',
				'click': function(ev) {
					ev.preventDefault();
					return addApMlo();
				}
			}, _('Quick Add AP MLO')),
			E('button', {
				'class': 'cbi-button',
				'click': function(ev) {
					ev.preventDefault();
					return addStaMlo();
				}
			}, _('Quick Add STA MLO')),
			E('button', {
				'class': 'cbi-button',
				'click': function(ev) {
					ev.preventDefault();
					return refreshStatus();
				}
			}, _('Refresh Runtime Status'))
		]),
		warningList
	]);
}

function renderSectionOverview(section_id, radiosByName) {
	let cfg = uci.get('wireless', section_id) || {};
	let devices = uniqueValues(cfg.device);
	let networks = uniqueValues(cfg.network);
	let issues = [];

	if (cfg.mlo == '1' && devices.length < 2)
		issues.push(E('div', { 'style': 'color:#b94a48;margin-top:.25em;' }, _('Needs at least two radios')));

	if (cfg.mlo == '1' && cfg.mode == 'ap' && ![ 'sae', 'sae-mixed', 'owe' ].includes(cfg.encryption))
		issues.push(E('div', { 'style': 'color:#8a6d3b;margin-top:.25em;' }, _('AP MLO is usually paired with WPA3-SAE or OWE')));

	if (cfg.mlo == '1' && cfg.ifname && cfg.ifname.indexOf('mld') < 0)
		issues.push(E('div', { 'style': 'color:#8a6d3b;margin-top:.25em;' }, _('Custom ifname overrides the default ap-mldX / sta-mldX naming')));

		return E('div', {
			'data-mlo-overview-section': section_id,
			'style': 'min-width:17em;'
		}, [
			E('div', { 'style': 'margin-bottom:.2em;' }, [
			renderBadge(cfg.mlo == '1' ? _('MLO') : _('Single-link'), cfg.mlo == '1' ? '#2d6cdf' : '#6c757d'),
			renderBadge((cfg.mode || 'ap').toUpperCase(), '#495057'),
			renderBadge(cfg.disabled == '1' ? _('Disabled') : _('Enabled'), cfg.disabled == '1' ? '#b94a48' : '#2f6f3e')
			]),
			renderMetaLine(_('SSID'), cfg.ssid || E('em', _('unset'))),
			renderMetaLine(_('Radios'), devices.length
				? renderJoinedValues(devices, dev => radiosByName[dev] ? radioLabel(radiosByName[dev]) : dev)
				: E('em', _('none'))),
			renderMetaLine(_('Networks'), networks.length ? networks.join(', ') : E('em', _('none'))),
			renderMetaLine(_('Security'), cfg.encryption || E('em', _('unset'))),
			issues
	]);
}

function renderRuntimeCell(section_id, runtime) {
	let cfg = uci.get('wireless', section_id) || {};
	let state = runtime.sections[section_id];

	if (cfg.disabled == '1') {
		return E('div', {
			'data-mlo-runtime-section': section_id,
			'style': 'min-width:15em;'
		}, [
			renderBadge(_('Disabled'), '#b94a48'),
			E('div', { 'style': 'margin-top:.25em;color:#666;' }, _('Section is disabled in UCI'))
		]);
	}

	if (!state) {
		return E('div', {
			'data-mlo-runtime-section': section_id,
			'style': 'min-width:15em;'
		}, [
			renderBadge(_('No runtime state'), '#6c757d'),
			E('div', { 'style': 'margin-top:.25em;color:#666;' }, _('No active interface was reported yet')),
			cfg.mlo == '1'
				? E('div', { 'style': 'margin-top:.25em;color:#8a6d3b;' }, _('Save & Apply, then verify driver support if this persists'))
				: null
		]);
	}

	return E('div', {
		'data-mlo-runtime-section': section_id,
		'style': 'min-width:15em;'
	}, [
		E('div', { 'style': 'margin-bottom:.2em;' }, compactChildren([
			renderBadge(state.up ? _('Active') : _('Present'), state.up ? '#2f6f3e' : '#6c757d'),
			state.mldDetected ? renderBadge(_('MLD runtime'), '#2d6cdf') : null
		])),
		renderMetaLine(_('ifname'), state.ifnames.length ? state.ifnames.join(', ') : E('em', _('unknown'))),
		renderMetaLine(_('Runtime radios'), state.radios.join(', ')),
		renderMetaLine(_('Stations'), String(state.stations))
	]);
}

return view.extend({
	callLuciWirelessDevices: callLuciWirelessDevices,

	load: function() {
		return Promise.all([
			uci.load('wireless'),
			uci.load('network'),
			L.resolveDefault(this.callLuciWirelessDevices(), {})
		]);
	},

	render: function(data) {
		let m, s, o;
		let initialStatus = data[2] || {};
		let radios = uci.sections('wireless', 'wifi-device');
		let networks = uci.sections('network', 'interface');
		let radiosByName = radioMap(radios);
		let runtime = flattenWirelessStatus(initialStatus);
		let summary = collectSummary(runtime, radios);
		let quickAdd;
		let ensureSummaryBox;
		let refreshRuntime;

		m = new form.Map('wireless', _('WiFi Manager'));
		m.chain('network');

		s = m.section(form.GridSection, 'wifi-iface', _('Wireless Interfaces'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add MLO-ready interface');
		s.modaltitle = _('Edit wireless interface');
		s.sectiontitle = function(section_id) {
			return optionValue(section_id, 'ssid') ||
				optionValue(section_id, 'ifname') ||
				section_id;
		};

		quickAdd = function(mode) {
			let selectedRadios = radios.slice(0, 2).map(r => r['.name']);
			let sid;
			let defaultNetworks = [];

			if (selectedRadios.length < 2) {
				ui.addNotification(null, E('p', _('At least two configured radios are required before an MLO interface can be created.')));
				return Promise.resolve();
			}

			if (mode == 'ap') {
				if (networks.some(n => n['.name'] == 'lan'))
					defaultNetworks = [ 'lan' ];
				else if (networks.length)
					defaultNetworks = [ networks[0]['.name'] ];
			}
			else {
				if (networks.some(n => n['.name'] == 'wwan'))
					defaultNetworks = [ 'wwan' ];
				else if (networks.some(n => n['.name'] == 'wan'))
					defaultNetworks = [ 'wan' ];
			}

			sid = nextSectionName('mlo');

			uci.add('wireless', 'wifi-iface', sid);
			uci.set('wireless', sid, 'mode', mode);
			uci.set('wireless', sid, 'mlo', '1');
			uci.set('wireless', sid, 'disabled', '0');
			uci.set('wireless', sid, 'device', selectedRadios);
			uci.set('wireless', sid, 'network', defaultNetworks);
			// WPA3-SAE is the MLO-capable default for both roles: an AP MLO needs
			// it for PMF, and a client MLO needs it to associate with an MLO AP.
			uci.set('wireless', sid, 'encryption', 'sae');
			uci.set('wireless', sid, 'ieee80211w', '2');

			if (mode == 'ap')
				uci.set('wireless', sid, 'ssid', 'OpenWrt-MLO');

			// Same bookkeeping as form.GridSection.handleAdd(): the section was
			// created before the modal is confirmed, so remember it on the map
			// element the modal is stacked upon. handleModalCancel() reads that
			// property and drops the section again when the modal is dismissed
			// instead of saved.
			let mapNode = s.getPreviousModalMap();
			let prevMap = mapNode ? dom.findClassInstance(mapNode) : s.map;

			prevMap.addedSection = sid;

			return s.renderMoreOptionsModal(sid);
		};

		s.handleAdd = function(ev) {
			if (ev)
				ev.preventDefault();

			return quickAdd('ap');
		};

		o = s.option(form.DummyValue, '_overview', _('Profile'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			return renderSectionOverview(section_id, radiosByName);
		};

		o = s.option(form.DummyValue, '_runtime', _('Runtime'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			return renderRuntimeCell(section_id, runtime);
		};

		s.tab('general', _('General'));
		s.tab('security', _('Security'));
		s.tab('advanced', _('Advanced'));

		o = s.taboption('general', form.Flag, 'disabled', _('Enabled'));
		o.enabled = '0';
		o.disabled = '1';
		o.default = '0';
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'mlo', _('Enable MLO'),
			_('When enabled, this <code>wifi-iface</code> spans multiple radios through a multi-value <code>device</code> list.'));
		// A section without an explicit mlo option is a single-link interface,
		// so the unchecked state is the default. form.Flag already defaults to
		// its disabled value; forcing the enabled value here would render every
		// existing interface as MLO-enabled and, on save, write mlo='1' onto
		// interfaces that never had the option.
		o.default = o.disabled;
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'mode', _('Mode'));
		o.value('ap', _('Access Point'));
		o.value('sta', _('Client'));
		o.value('adhoc', _('Ad-Hoc'));
		o.value('mesh', _('Mesh'));
		L.keepConfiguredValue(o);

		o = s.taboption('general', form.MultiValue, 'device', _('Radio devices'),
			_('Select one radio for normal Wi-Fi, or two or more radios for MLO.'));
		for (let radio of radios)
			o.value(radio['.name'], radioLabel(radio));
		o.rmempty = true;
		o.validate = function(section_id, value) {
			let values = uniqueValues(value);
			let mloOption = this.section.children.find(opt => opt.option == 'mlo');
			let mloEnabled = mloOption ? mloOption.formvalue(section_id) : optionValue(section_id, 'mlo');

			if (!values.length)
				return _('Select at least one radio device');

			if (mloEnabled == '1' && values.length < 2)
				return _('MLO requires at least two radio devices');

			return true;
		};

		o = s.taboption('general', form.MultiValue, 'network', _('Attached network(s)'),
			_('Logical network names from <code>/etc/config/network</code>, for example <code>lan</code>.'));
		for (let network of networks)
			o.value(network['.name']);
		o.rmempty = true;
		o.modalonly = true;

		o = s.taboption('general', form.Value, 'ssid', _('SSID'));
		// Deliberately no depends() on mode. The mode list below offers four
		// modes (ap / sta / adhoc / mesh), so depends('mode','ap') +
		// depends('mode','sta') is not a tautology - it is a filter, and form.js
		// removes an option that is not active when the form is saved. An
		// interface in adhoc or mesh mode would then lose its ssid on an
		// unrelated save. An empty dependency list is unconditionally satisfied,
		// and ssid is meaningful in every mode - for a client it is the SSID to
		// join, for adhoc/mesh it is the network id.
		o.datatype = 'maxlength(32)';

		o = s.taboption('general', form.Flag, 'hidden', _('Hide SSID'));
		o.depends('mode', 'ap');
		o.modalonly = true;

		o = s.taboption('security', form.ListValue, 'encryption', _('Encryption'),
			_('For AP MLO, WPA3-SAE with Management Frame Protection set to Required is the most compatible starting point in this tree.'));
		o.value('sae', _('WPA3-SAE'));
		o.value('sae-mixed', _('WPA2/WPA3 mixed'));
		o.value('psk2', _('WPA2-PSK'));
		o.value('psk-mixed', _('WPA/WPA2 mixed PSK'));
		o.value('owe', _('OWE'));
		o.value('none', _('No encryption'));
		L.keepConfiguredValue(o);

		o = s.taboption('security', form.Value, 'key', _('Passphrase'));
		o.password = true;
		o.datatype = 'wpakey';
		o.depends('encryption', 'sae');
		o.depends('encryption', 'sae-mixed');
		o.depends('encryption', 'psk2');
		o.depends('encryption', 'psk-mixed');
		o.modalonly = true;
		o.validate = function(section_id, value) {
			let encryptionOption = this.section.children.find(opt => opt.option == 'encryption');
			let encryption = encryptionOption ? encryptionOption.formvalue(section_id) : optionValue(section_id, 'encryption');

			if ([ 'sae', 'sae-mixed', 'psk2', 'psk-mixed' ].includes(encryption) && !value)
				return _('Passphrase is required for the selected encryption');

			return true;
		};

		o = s.taboption('security', form.ListValue, 'ieee80211w', _('802.11w Management Frame Protection'));
		o.value('0', _('Disabled'));
		o.value('1', _('Optional'));
		o.value('2', _('Required'));
		o.default = '2';
		// Management frame protection is not a property of this page's interface
		// alone: writing it onto an interface that never had the option changes
		// which clients can associate at all (ieee80211w=2 on a WPA2-PSK SSID
		// locks out every client without PMF support). The stock Wireless page
		// solves this in two steps, mirrored here:
		//   - the default is resolved per encryption (form.js updateDefaultValue(),
		//     using the empty condition list as the fallback), so a psk2 interface
		//     shows Disabled and a sae-mixed one shows Optional;
		//   - a value equal to the default is removed instead of written, so only
		//     an explicit user choice reaches the configuration.
		o.defaults = {
			'2': [ { encryption: 'sae' }, { encryption: 'owe' } ],
			'1': [ { encryption: 'sae-mixed' } ],
			'0': []
		};
		o.write = function(section_id, value) {
			if (value != this.default)
				return form.ListValue.prototype.write.call(this, section_id, value);

			return form.ListValue.prototype.remove.call(this, section_id);
		};
		o.depends('encryption', 'sae');
		o.depends('encryption', 'sae-mixed');
		o.depends('encryption', 'psk2');
		o.depends('encryption', 'psk-mixed');
		o.depends('encryption', 'owe');
		o.modalonly = true;

		o = s.taboption('advanced', form.Value, 'ifname', _('Interface name'),
			_('Optional override. Leave empty to use auto-generated names such as <code>ap-mld0</code> or <code>sta-mld0</code>.'));
		o.datatype = 'netdevname';
		o.placeholder = 'ap-mld0';
		o.modalonly = true;

		o = s.taboption('advanced', form.Value, 'macaddr', _('MAC address'),
			_('Optional override for the generated interface MAC address.'));
		// 'random' is a valid value for this option (the stock Wireless page
		// offers it as a choice), so it must not be rejected by the macaddr
		// data type - otherwise such an interface cannot be saved at all.
		o.datatype = "or('random',macaddr)";
		o.modalonly = true;

		o = s.taboption('advanced', form.Value, 'bssid', _('BSSID'));
		o.datatype = 'macaddr';
		o.depends('mode', 'sta');
		o.modalonly = true;

		o = s.taboption('advanced', form.Flag, 'wds', _('Enable WDS / 4-address mode'));
		// Same reasoning as ssid above: 4-address mode is meaningful beyond ap
		// and sta (adhoc and mesh use it too), so an ap/sta depends pair would
		// only add the remove-on-save hazard for those interfaces.
		o.modalonly = true;

		o = s.taboption('advanced', form.Flag, 'uapsd', _('Enable U-APSD'));
		o.depends('mode', 'ap');
		o.modalonly = true;

		o = s.taboption('advanced', form.Flag, 'ocv', _('Enable OCV'));
		o.depends('encryption', 'sae');
		o.depends('encryption', 'sae-mixed');
		o.depends('encryption', 'owe');
		o.modalonly = true;

		o = s.taboption('advanced', form.Flag, 'disassoc_low_ack', _('Disassociate on low ACK'));
		o.depends('mode', 'ap');
		o.modalonly = true;

		refreshRuntime = function(nodes) {
			return L.resolveDefault(callLuciWirelessDevices(), {}).then(function(status) {
				let nextRuntime = flattenWirelessStatus(status);
				return enrichRuntimeStations(nextRuntime).then(function(nextRuntime) {
					runtime = nextRuntime;
					summary = collectSummary(nextRuntime, radios);

					ensureSummaryBox(nodes);

					uci.sections('wireless', 'wifi-iface').forEach(function(section) {
						let overviewNode = nodes.querySelector('[data-mlo-overview-section="%s"]'.format(section['.name']));
						let rowNode = nodes.querySelector('[data-mlo-runtime-section="%s"]'.format(section['.name']));

						if (overviewNode)
							replaceNode(overviewNode, renderSectionOverview(section['.name'], radiosByName));

						if (rowNode)
							replaceNode(rowNode, renderRuntimeCell(section['.name'], runtime));
					});
				});
			});
		};

		ensureSummaryBox = function(nodes) {
			let summaryNode = nodes.querySelector('[data-mlo-summary-box="1"]');
			let nextSummaryNode = renderSummaryBox(runtime, summary,
				function() { return quickAdd('ap'); },
				function() { return quickAdd('sta'); },
				function() { return refreshRuntime(nodes); });

			if (summaryNode)
				replaceNode(summaryNode, nextSummaryNode);
			else
				nodes.insertBefore(nextSummaryNode, nodes.firstChild);
		};

		// CBIMap.renderContents() empties the map element and rebuilds it, which
		// also drops the overview box injected below - it happens on every save
		// and on every modal dismissal (both run load() + reset()). Re-insert the
		// box as soon as the map finished re-rendering, instead of leaving the
		// page without it until the next poll tick.
		let renderContents = m.renderContents.bind(m);

		m.renderContents = function() {
			return renderContents().then(function(nodes) {
				ensureSummaryBox(nodes);

				return nodes;
			});
		};

		return m.render().then(function(nodes) {
			return refreshRuntime(nodes).then(function() {
				poll.add(function() {
					return refreshRuntime(nodes);
				}, 5);

				return nodes;
			});
		});
	}
});
