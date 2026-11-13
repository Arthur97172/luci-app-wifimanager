'use strict';
'require view';
'require form';
'require uci';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.radio as radio';
'require wifimanager.utils.validation as validation';
'require wifimanager.utils.uci as uciutil';
'require ui';

const listValues = function(value) {
	if (value == null)
		return [];

	if (Array.isArray(value))
		return value.filter(Boolean);

	return String(value).trim().split(/[\s,]+/).filter(Boolean);
};

/* A fresh installation has no /etc/config/meshassistant yet. */
function ensureConfig() {
	return uciutil.ensureConfig('meshassistant');
}

function loadFrequencies(radios) {
	const banded = radios.filter(function(entry) {
		return radio.bandNumber(entry.band) != null;
	});

	if (banded.length === 0)
		return Promise.resolve({ frequencies: [], countries: [] });

	return Promise.all([
		Promise.all(banded.map(function(entry) {
			return rpc.freqList(entry.name).catch(function() { return []; });
		})),
		rpc.countryList(banded[0].name).catch(function() { return []; })
	]).then(function(results) {
		const seen = {};

		for (const list of results[0]) {
			for (const freq of ((list && list.results) || [])) {
				if (!freq || !freq.channel)
					continue;

				seen[freq.band + ':' + freq.channel] = freq;
			}
		}

		return {
			frequencies: Object.keys(seen).map(function(key) { return seen[key]; }),
			countries: (results[1] && results[1].results) || []
		};
	});
}

function bandFrequencies(frequencies, band) {
	const want = radio.bandNumber(band);
	const seen = {};
	const out = [];

	for (const freq of (frequencies || [])) {
		if (freq.band !== want || seen[freq.channel])
			continue;

		if (freq.restricted && (freq.flags || []).indexOf('no_ir') !== -1)
			continue;

		seen[freq.channel] = true;
		out.push(freq);
	}

	out.sort(function(a, b) { return a.channel - b.channel; });

	return out;
}

return view.extend({
	load: function() {
		return Promise.all([
			ensureConfig(),
			uci.load('wireless').catch(function() { return null; }),
			rpc.radioInventory().catch(function() { return null; })
		]).then(function(result) {
			const inventory = result[2] || {};
			const radios = inventory.radios || [];

			return loadFrequencies(radios).then(function(extra) {
				return {
					radios: radios,
					frequencies: extra.frequencies,
					countries: extra.countries,
					inventoryError: inventory.ok === false ? inventory.message : null
				};
			});
		});
	},

	render: function(data) {
		const self = this;
		const radios = data.radios || [];
		const radioLabels = {};

		for (const entry of radios)
			radioLabels[entry.name] = radio.radioLabel(entry);

		const firstRadio = radios.length ? radios[0].name : '';
		const mesh = new form.Map('meshassistant');

		this.map = mesh;

		const s = mesh.section(form.TypedSection, 'meshassistant', _('Mesh'));

		s.anonymous = true;
		s.addremove = false;
		s.tab('general', _('General'));
		s.tab('radios', _('Radios'));
		s.tab('spectrum', _('Spectrum'));

		let o;

		o = s.taboption('general', form.Flag, 'enabled', _('Enable mesh networking'),
			_('Turn the mesh on or off on this device. Turning it off restores the LAN, DHCP, hostname and services that the mesh engine changed.'));
		o.default = '0';

		o = s.taboption('general', form.ListValue, 'role', _('Mesh role'),
			_('The server is the gateway of the mesh and provides DHCP, DNS and firewall duties. A node bridges the mesh into its LAN but runs no DHCP server. A client uses the mesh only as an uplink and keeps its LAN separate.'));
		o.value('server', _('Server (gateway)'));
		o.value('node', _('Node (bridged, no DHCP)'));
		o.value('client', _('Client (uplink, LAN not bridged)'));
		o.default = 'server';
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'server_dhcp', _('Server provides DHCP'),
			_('Keep this on when this server is the only DHCP server on the LAN. Turn it off when another router already hands out addresses; the server then keeps the gateway and DNS role without running DHCP or RA.'));
		o.default = '1';
		o.depends('role', 'server');

		o = s.taboption('general', form.Value, 'dhcp_dns', _('DHCP DNS server'),
			_('Address advertised to DHCP clients as option 6. Leave empty to advertise this router itself.'));
		o.datatype = 'ip4addr';
		o.rmempty = true;
		o.depends({ role: 'server', server_dhcp: '1' });

		o = s.taboption('general', form.Value, 'wifi_id', _('Wi-Fi network SSID'),
			_('SSID of the regular access point. It is also used by the MLO access point and by radios without their own SSID.'));
		o.default = 'WiFi';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return validation.isSSID(value) ||
				_('Enter an SSID of 1 to 32 bytes.');
		};

		o = s.taboption('general', form.MultiValue, 'wifi_radio', _('Access point radios'),
			_('Select the radios that carry the regular access point. MLO requires exactly two.'));
		for (const entry of radios)
			o.value(entry.name, radioLabels[entry.name]);
		o.default = firstRadio;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return listValues(value).length > 0 ||
				_('Select at least one radio.');
		};

		const wifiRadioOption = o;

		o = s.taboption('general', form.Flag, 'mlo', _('Enable MLO'),
			_('Combine two selected radios into one Wi-Fi 7 Multi-Link Operation access point. Both radios are switched to EHT mode.'));
		o.default = '0';
		o.depends('wifi_radio', /^[^,]+(?:,[^,]+)+$/);
		o.validate = function(section_id) {
			if (this.formvalue(section_id) == '1' &&
			    listValues(wifiRadioOption.formvalue(section_id)).length !== 2)
				return _('MLO requires exactly two radios.');

			return true;
		};

		o = s.taboption('general', form.ListValue, 'ssid_mode', _('SSID mode'),
			_('Use one SSID on every radio, or a separate SSID per radio. Separate SSIDs turn off seamless 802.11r roaming between them.'));
		o.value('same', _('Same SSID on all radios'));
		o.value('separate', _('Separate SSID per radio'));
		o.default = 'same';
		o.depends({ mlo: '0', wifi_radio: /^[^,]+(?:,[^,]+)+$/ });

		for (const entry of radios) {
			o = s.taboption('general', form.Value, 'wifi_id_' + entry.name,
				_('SSID for %s').format(radioLabels[entry.name]),
				_('Leave empty to use the shared SSID above.'));
			o.depends({
				mlo: '0',
				ssid_mode: 'separate',
				wifi_radio: new RegExp('(^|,)' + entry.name + '(,|$)')
			});
			o.validate = function(section_id, value) {
				return value == null || value === '' || validation.isSSID(value) ||
					_('Enter an SSID of 1 to 32 bytes.');
			};
		}

		o = s.taboption('general', form.ListValue, 'apRadio', _('Mesh radio'),
			_('The one radio that carries the 802.11s mesh backhaul.'));
		for (const entry of radios)
			o.value(entry.name, radioLabels[entry.name]);
		o.default = firstRadio;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return String(value == null ? '' : value).trim().split(/\s+/).length === 1 ||
				_('Select exactly one mesh radio.');
		};

		o = s.taboption('general', form.Value, 'mesh_id', _('Mesh network ID'),
			_('Every server and node in the mesh must use the same mesh ID. The 802.11s interface is named “<mesh ID>-mesh”.'));
		o.default = 'WiFiManager-Mesh';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			return validation.isMeshId(value) ||
				_('Enter a mesh ID of 1 to 32 bytes.');
		};

		o = s.taboption('general', form.Flag, 'encryption', _('Password protection'),
			_('Require the password below on the access points and on the mesh link.'));
		o.default = '0';

		o = s.taboption('general', form.Value, 'key', _('Mesh password'),
			_('WPA2/WPA3 passphrase, 8 to 63 printable characters. The value is written to UCI and never shown in logs.'));
		o.password = true;
		o.rmempty = false;
		o.depends('encryption', '1');
		o.validate = function(section_id, value) {
			return validation.isKey(value) ||
				_('Enter a passphrase of 8 to 63 printable characters.');
		};

		o = s.taboption('radios', form.DummyValue, '_radios_note', '', '');
		o.default = _('The mesh engine owns the sections it creates (mesh_<radio>, wifi_ap_<radio>, wifi_ap_mlo). Edit other wireless interfaces on the standard Wireless page.');
		o.rawhtml = false;

		/* Spectrum settings apply to every radio this form may touch. */
		for (const entry of radios) {
			const current = radio.parseHtmode(entry.htmode);
			const currentChannel = entry.channel || 'auto';
			const currentTxpower = entry.txpower || '';
			const currentCountry = uci.get('wireless', entry.name, 'country') || '';
			const band = entry.band;

			o = s.taboption('spectrum', form.DummyValue, '_spectrum_' + entry.name,
				radioLabels[entry.name], '');
			o.rawhtml = false;

			if (!band) {
				o.default = _('This radio reports no frequency band, so no spectrum settings are available.');
				continue;
			}

			o.default = _('Configured: channel %s, %s').format(
				currentChannel, entry.htmode || _('driver default'));
			o.rawhtml = false;

			const modeOpt = s.taboption('spectrum', form.ListValue,
				'spectrum_' + entry.name + '_mode', _('PHY mode (%s)').format(radioLabels[entry.name]),
				_('Leave at “Keep current” to keep the radio mode.'));
			modeOpt.value('', _('Keep current (%s)').format(current.mode || _('driver default')));
			for (const mode of radio.BAND_MODES[band])
				modeOpt.value(mode, mode);
			modeOpt.default = '';
			modeOpt.depends({
				wifi_radio: new RegExp('(^|,)' + entry.name + '(,|$)'),
				mlo: '1',
				'!reverse': true
			});

			let widthOpt;

			modeOpt.validate = function(section_id, value) {
				if (!value)
					return true;

				let width = current.width;

				try {
					const selected = widthOpt && widthOpt.formvalue(section_id);

					if (selected)
						width = Number(selected);
				}
				catch (e) { }

				return radio.validSpectrumPair(band, value, width) ||
					_('The selected PHY mode does not support this channel width.');
			};

			widthOpt = s.taboption('spectrum', form.ListValue,
				'spectrum_' + entry.name + '_width', _('Channel width'),
				_('Leave at “Keep current” to keep the radio width.'));
			widthOpt.value('', _('Keep current (%s)').format(
				current.width ? current.width + ' MHz' : _('driver default')));
			for (const width of radio.BAND_WIDTHS[band])
				widthOpt.value(String(width), width + ' MHz');
			widthOpt.default = '';
			widthOpt.validate = function(section_id, value) {
				if (!value)
					return true;

				let mode = current.mode;

				try {
					const selected = modeOpt.formvalue(section_id);

					if (selected)
						mode = selected;
				}
				catch (e) { }

				return radio.validSpectrumPair(band, mode, Number(value)) ||
					_('The selected PHY mode does not support this channel width.');
			};

			const channelOpt = s.taboption('spectrum', form.ListValue,
				'spectrum_' + entry.name + '_channel', _('Channel'),
				_('Leave at “Keep current” to keep the configured channel. A DFS channel can be unavailable while the radar check runs.'));
			channelOpt.value('', _('Keep current (%s)').format(currentChannel));
			channelOpt.value('auto', _('Auto'));
			for (const freq of bandFrequencies(data.frequencies, band)) {
				const label = radio.isDfsChannel(band, freq.channel)
					? _('Channel %s (%s MHz, DFS)').format(freq.channel, freq.mhz)
					: _('Channel %s (%s MHz)').format(freq.channel, freq.mhz);

				channelOpt.value(String(freq.channel), label);
			}
			channelOpt.default = '';

			o = s.taboption('spectrum', form.Value,
				'spectrum_' + entry.name + '_txpower', _('Maximum transmit power'),
				_('Transmit power in dBm. Leave empty to keep the current value.'));
			o.default = '';
			o.placeholder = currentTxpower || '0';
			o.datatype = 'range(1,40)';

			const countryOpt = s.taboption('spectrum', form.ListValue,
				'spectrum_' + entry.name + '_country', _('Country code'),
				_('Regulatory domain. Leave at “Keep current” to keep the current country.'));
			countryOpt.value('', _('Keep current (%s)')
				.format(currentCountry || _('driver default')));

			const seenCountries = {};

			for (const country of data.countries) {
				const code = country.iso3166 || country.code;

				if (!code || seenCountries[code])
					continue;

				seenCountries[code] = true;
				countryOpt.value(code, '%s - %s'.format(code, country.country || code));
			}

			countryOpt.default = '';
		}

		const applyCard = widgets.card(_('Apply configuration'), [
			E('p', { 'class': 'wm-muted' }, [
				_('Saving writes the form to /etc/config/meshassistant. Applying also lets the mesh engine rewrite the wireless and network configuration; it creates a full pre-change backup through Backup & Restore first.')
			]),
			widgets.button(_('Apply saved configuration'), function() {
				return widgets.confirm(_('Apply mesh configuration'),
					_('The saved values are applied now. Wi-Fi clients may reconnect and this page may be unreachable for a short time.'),
					_('Apply'), false).then(function(confirmed) {
					if (!confirmed)
						return;

					ui.showModal(_('Applying mesh configuration'), [
						widgets.spinner(_('The mesh engine is applying the configuration…'))
					]);

					return widgets.runOperation(rpc.meshApply, _('Apply mesh configuration'))
						.then(function(op) {
							ui.hideModal();
							widgets.notify('info', op.message || _('Mesh configuration applied.'));
							window.setTimeout(function() { window.location.reload(); }, 1500);
						})
						.catch(function(err) {
							ui.hideModal();
							widgets.notify('error', err.message || String(err));
						});
				});
			}, 'action')
		]);

		const notes = [];

		if (data.inventoryError)
			notes.push(widgets.alert('warn',
				_('The radio inventory could not be read: %s').format(data.inventoryError)));

		if (radios.length === 0)
			notes.push(widgets.alert('warn',
				_('No radio was found. Mesh settings cannot be applied until a wireless device exists.')));

		return mesh.render().then(function(mapEl) {
			return widgets.page(_('Mesh settings'),
				_('Roles, radios, mesh identity and the spectrum used by the mesh.'),
				[ applyCard, E('div', {}, notes), mapEl ]);
		});
	},

	/*
	 * Save & Apply has to commit the form before the engine runs, because the
	 * engine reads the UCI files rather than LuCI's uncommitted in-memory
	 * state.  The ordinary apply UI reloads the page before a follow-up RPC
	 * could run, so this handler commits with rollback protection and then
	 * queues the engine operation.
	 */
	handleSaveApply: function(ev, mode) {
		const self = this;

		return widgets.confirm(_('Save and apply mesh settings'),
			_('The form is saved and committed, then the mesh engine applies it. Wi-Fi clients may reconnect and this page may be unreachable for a short time.'),
			_('Save & apply'), false).then(function(confirmed) {
			if (!confirmed)
				return;

			ui.showModal(_('Applying mesh configuration'), [
				widgets.spinner(_('Saving the form and applying the configuration…'))
			]);

			return self.map.save()
				.then(function() {
					return uci.apply(60);
				})
				.then(function() {
					return widgets.runOperation(rpc.meshApply, _('Apply mesh configuration'));
				})
				.then(function(op) {
					ui.hideModal();
					widgets.notify('info', op.message || _('Mesh configuration applied.'));
					window.setTimeout(function() { window.location.reload(); }, 1500);
				})
				.catch(function(err) {
					ui.hideModal();
					widgets.notify('error', err && err.message ? err.message :
						_('The configuration could not be applied.'));
				});
		});
	}
});
