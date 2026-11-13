'use strict';
'require view';
'require form';
'require uci';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.validation as validation';
'require wifimanager.utils.uci as uciutil';
'require wifimanager.utils.roaming-advice as adviceUtil';
'require wifimanager.utils.neighbors as neighbours';
'require wifimanager.utils.radio as radioUtil';
'require dom';
'require ui';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;
const kv = widgets.kv;

const BAND_SUFFIXES = [ '2g', '5g', '6g' ];

function bandLabel(suffix) {
	return suffix === '2g' ? _('2.4 GHz') :
		(suffix === '5g' ? _('5 GHz') : _('6 GHz'));
}

function isDbm(value) {
	const n = Number(value);

	return Number.isInteger(n) && n >= -100 && n <= -10;
}

function capabilityBadge(value, yes, no) {
	return value ? badge(yes || _('Yes'), 'ok') : badge(no || _('No'), 'muted');
}

return view.extend({
	load: function() {
		return Promise.all([
			uciutil.ensureConfig('meshassistant'),
			rpc.diagnostics('roaming').catch(function() { return null; }),
			rpc.status().catch(function() { return null; }),
			rpc.roamingAdvice().catch(function() { return null; }),
			rpc.radioInventory().catch(function() { return null; })
		]).then(function(result) {
			return {
				roaming: result[1] || {},
				status: result[2] || {},
				advice: result[3] || null,
				inventory: result[4] || null
			};
		});
	},

	render: function(data) {
		const self = this;
		const roaming = data.roaming || {};
		const caps = roaming.capabilities || {};
		const interfaces = roaming.interfaces || [];
		const meshEnabled = uci.get('meshassistant', 'config', 'enabled') === '1';
		const kvrEnabled = uci.get('meshassistant', 'config', 'kvr') === '1';
		// Configurations written before 802.11k and 802.11v had separate
		// options fall back to the old combined switch.
		const storedK = uci.get('meshassistant', 'config', 'ieee80211k');
		const storedV = uci.get('meshassistant', 'config', 'ieee80211v');
		const kEnabled = storedK == null ? kvrEnabled : storedK === '1';
		const vEnabled = storedV == null ? kvrEnabled : storedV === '1';
		const globalGood = uci.get('meshassistant', 'config', 'rssi_val') || '-60';
		const globalBad = uci.get('meshassistant', 'config', 'low_rssi_val') || '-88';

		const m = new form.Map('meshassistant');

		this.map = m;

		const s = m.section(form.TypedSection, 'meshassistant', _('Roaming'));
		s.anonymous = true;
		s.addremove = false;
		s.tab('general', _('General'));
		s.tab('thresholds', _('Thresholds'));
		s.tab('dawn', _('DAWN decisions'));

		let o;
		let goodOption, badOption;

		o = s.taboption('general', form.Flag, 'ieee80211k', _('Enable 802.11k neighbor reports'),
			_('802.11k lets a client ask its access point for a list of neighbouring access points. DAWN and the client use these radio measurements to decide where to roam.'));
		o.default = kvrEnabled ? '1' : '0';

		o = s.taboption('general', form.Flag, 'ieee80211v', _('Enable 802.11v client steering'),
			_('802.11v lets the access point suggest a better access point to a client. DAWN uses it to steer clients; without wpad support for 802.11v the neighbor reports still work, but no steering request is sent.'));
		o.default = kvrEnabled ? '1' : '0';

		o = s.taboption('general', form.Flag, 'ft', _('Enable 802.11r fast transition'),
			_('Fast BSS transition lets a client move between access points with the same SSID without a full re-authentication. All APs must share the same mobility domain; separate SSIDs per radio disable it by design.'));
		o.default = '0';

		o = s.taboption('general', form.Value, 'mobility_domain', _('Mobility domain'),
			_('Four hexadecimal digits shared by every AP in the roaming group. Leave empty to derive the value from the mesh ID on the next apply.'));
		o.placeholder = _('Derived from the mesh ID');
		o.depends('ft', '1');
		o.validate = function(section_id, value) {
			if (!value)
				return true;

			return validation.isMobilityDomain(value) ||
				_('Enter exactly four hexadecimal digits, for example 1a2b.');
		};

		o = s.taboption('general', form.Flag, 'ft_over_ds',
			_('FT over DS (fast transition over the distribution system)'),
			_('Off sends the fast-transition frames over the air, which is the hostapd default and works without a wired path between the access points. On sends them over the distribution system; enable it only when every AP of the mobility domain is reachable over the wired network. hostapd supports one transport per interface, so this selects DS instead of air rather than both.'));
		o.default = '0';
		o.depends('ft', '1');

		goodOption = s.taboption('thresholds', form.Value, 'rssi_val', _('Good signal threshold'),
			_('Signal level in dBm above which DAWN considers a client well connected and does not steer it away.'));
		goodOption.default = '-60';
		goodOption.placeholder = '-60';
		goodOption.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;

			return isDbm(value) ||
				_('Enter a signal level in dBm between -100 and -10.');
		};

		badOption = s.taboption('thresholds', form.Value, 'low_rssi_val', _('Bad signal threshold'),
			_('Signal level in dBm below which DAWN considers a client a steering candidate. It must be lower than the good threshold.'));
		badOption.default = '-88';
		badOption.placeholder = '-88';
		badOption.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;

			if (!isDbm(value))
				return _('Enter a signal level in dBm between -100 and -10.');

			const good = Number((goodOption && goodOption.formvalue(section_id)) || globalGood);

			return Number(value) < good ||
				_('The bad threshold must be lower than the good threshold.');
		};

		o = s.taboption('thresholds', form.DummyValue, '_band_note', _('Per-band overrides'), '');
		o.default = _('Leave a field empty to use the global threshold. A 6 GHz radio usually needs a higher good threshold than a 2.4 GHz radio because its free-space path loss is higher.');

		const bandGoodOptions = {};

		for (const suffix of BAND_SUFFIXES) {
			const band = { suffix: suffix, label: bandLabel(suffix) };

			o = s.taboption('thresholds', form.Value, 'rssi_val_' + band.suffix,
				_('Good threshold: %s').format(band.label), '');
			o.placeholder = globalGood;
			o.validate = function(section_id, value) {
				if (value == null || value === '')
					return true;

				return isDbm(value) ||
					_('Enter a signal level in dBm between -100 and -10.');
			};
			bandGoodOptions[band.suffix] = o;

			o = s.taboption('thresholds', form.Value, 'low_rssi_val_' + band.suffix,
				_('Bad threshold: %s').format(band.label), '');
			o.placeholder = globalBad;
			o.validate = function(section_id, value) {
				if (value == null || value === '')
					return true;

				if (!isDbm(value))
					return _('Enter a signal level in dBm between -100 and -10.');

				const own = bandGoodOptions[band.suffix];
				const ownValue = own && own.formvalue(section_id);
				const good = Number(ownValue || (goodOption && goodOption.formvalue(section_id)) || globalGood);

				return Number(value) < good ||
					_('The bad threshold must be lower than the good threshold.');
			};
		}

		/*
		 * DAWN decision parameters (DESIGN §8.4).  The defaults are the values
		 * the engine used before these options existed, so an untouched
		 * configuration keeps steering exactly as it did.
		 */
		o = s.taboption('dawn', form.ListValue, 'dawn_kicking', _('Client steering'),
			_('Whether DAWN may ask a client to move to another access point. 0 disables kicking, 1 only advises, 2 disconnects a client that does not move and 3 disconnects it immediately.'));
		o.value('0', _('Disabled'));
		o.value('1', _('Advisory only'));
		o.value('2', _('Disconnect after two ignored requests'));
		o.value('3', _('Disconnect immediately'));
		o.default = '3';
		o.rmempty = false;

		o = s.taboption('dawn', form.Value, 'dawn_kicking_threshold', _('Steering RSSI difference (dB)'),
			_('How much stronger another access point must be before DAWN considers a move worth it. A larger value reduces steering between similar APs.'));
		o.datatype = 'range(1,100)';
		o.default = '20';
		o.placeholder = '20';

		o = s.taboption('dawn', form.Value, 'dawn_min_clients', _('Minimum clients per steering decision'),
			_('Client-count threshold: DAWN only starts a steering round when at least this many clients are connected to the access point, so a nearly idle AP is not emptied.'));
		o.datatype = 'range(1,100)';
		o.default = '3';
		o.placeholder = '3';

		o = s.taboption('dawn', form.Value, 'dawn_duration', _('Evaluation interval (seconds)'),
			_('How often DAWN re-evaluates the client table and applies the thresholds above.'));
		o.datatype = 'range(10,3600)';
		o.default = '150';
		o.placeholder = '150';

		o = s.taboption('dawn', form.Flag, 'dawn_watchdog', _('Restart DAWN when it stops'),
			_('The minute ticker checks a DAWN configuration that WiFi Manager manages and restarts the service when it is not running. At most one recovery attempt is made every five minutes, and each attempt is recorded in the log and the event log. A DAWN that was released again is never restarted.'));
		o.default = '1';

		o = s.taboption('dawn', form.DummyValue, '_dawn_note', _('Steering notes'), '');
		o.default = _('The effective values are written to /etc/config/dawn on apply and are shown on the DAWN status page. Steering needs mesh to be enabled and wpad with 802.11v support.');

		const warnings = [];

		if (!roaming.ok)
			warnings.push(alert('warn',
				_('The roaming capabilities could not be read; the checks below may be incomplete.')));

		if (vEnabled && !caps.wnm)
			warnings.push(alert('warn',
				_('This wpad build has no 802.11v support. 802.11k and DAWN start, but the AP cannot send BSS transition requests, so steering is advisory only.')));

		if (vEnabled && !caps.dawn)
			warnings.push(alert('warn',
				_('DAWN is not installed. 802.11k and 802.11v can still be enabled, but there is no client-steering service.')));

		if ((kEnabled || vEnabled) && !meshEnabled)
			warnings.push(alert('warn',
				_('DAWN steering requires mesh networking to be enabled: the engine only writes the managed DAWN configuration while mesh is on.')));

		const capabilityCard = card(_('Capabilities'), [
			kv([
				[ _('802.11k configured'), capabilityBadge(caps.k, _('Enabled'), _('Disabled')) ],
				[ _('802.11v configured'), capabilityBadge(caps.v, _('Enabled'), _('Disabled')) ],
				[ _('802.11v support in wpad'), capabilityBadge(caps.wnm, _('Available'), _('Unavailable')) ],
				[ _('802.11r configured'), capabilityBadge(caps.ft, _('Enabled'), _('Disabled')) ],
				[ _('DAWN installed'), capabilityBadge(caps.dawn, _('Yes'), _('No')) ],
				[ _('DAWN running'), capabilityBadge(caps.dawn_running, _('Yes'), _('No')) ],
				[ _('DAWN managed by WiFi Manager'), capabilityBadge(caps.dawn_managed, _('Yes'), _('No')) ]
			])
		]);

		/*
		 * Advisory analysis of the DAWN thresholds (DESIGN §8.4).  A snapshot
		 * of the associated stations can suggest thresholds, but it is never
		 * applied from here: the operator copies a value into the form and
		 * saves it deliberately.
		 */
		const advice = data.advice ? adviceUtil.advise(data.advice) : null;
		const levelKind = { error: 'error', warn: 'warn', info: 'muted' };

		if (data.advice == null)
			warnings.push(alert('warn',
				_('The roaming advice could not be loaded; only the configured values are known.')));

		const findingRows = advice ? advice.findings.map(function(finding) {
			return [
				badge(adviceUtil.levelName(finding.level), levelKind[finding.level] || 'muted'),
				finding.code,
				adviceUtil.adviceText(finding)
			];
		}) : [];

		const bandRows = advice ? advice.bands.map(function(item) {
			return [
				bandLabel(item.band),
				String(item.clients),
				item.median != null ? item.median + ' dBm' : '-',
				item.weakest != null ? item.weakest + ' dBm' : '-',
				item.suggestedGood != null ? item.suggestedGood + ' dBm' : '-',
				item.suggestedBad != null ? item.suggestedBad + ' dBm' : '-'
			];
		}) : [];

		const adviceContent = [];

		if (advice && !advice.findings.length)
			adviceContent.push(alert('ok',
				_('No roaming problem was found in the current configuration and signal sample.')));
		else if (advice && findingRows.length)
			adviceContent.push(table([
				{ label: _('Level') },
				{ label: _('Code') },
				{ label: _('Finding') }
			], findingRows));

		if (advice && bandRows.length)
			adviceContent.push(E('div', {}, [
				E('p', { 'class': 'wm-muted' }, [
					_('A suggestion is shown only when a band has at least five associated clients; the values are a snapshot and are never applied automatically.')
				]),
				table([
					{ label: _('Band') },
					{ label: _('Clients') },
					{ label: _('Median signal') },
					{ label: _('Weakest signal') },
					{ label: _('Suggested good threshold') },
					{ label: _('Suggested bad threshold') }
				], bandRows)
			]));
		else if (advice)
			adviceContent.push(E('p', { 'class': 'wm-muted' },
				[ _('No client is currently associated, so no signal statistics are available.') ]));

		const adviceCard = card(_('Roaming parameter advice'), adviceContent, {
			description: _('Compares the saved 802.11k/v/r flags and thresholds with the clients associated right now. Copy a suggested value into the form only after checking it against your deployment.')
		});

		const interfaceRows = interfaces.map(function(entry) {
			return [
				entry.section,
				entry.ssid || '-',
				entry.bssid || '-',
				entry.up == null
					? badge(_('Unknown'), 'muted')
					: (entry.up ? badge(_('Up'), 'ok') : badge(_('Down'), 'muted')),
				capabilityBadge(entry.k),
				capabilityBadge(entry.v),
				capabilityBadge(entry.r),
				entry.mobility_domain || '-',
				entry.r
					? (entry.ft_over_ds ? _('Over DS') : _('Over the air'))
					: '-'
			];
		});

		const interfaceCard = card(_('Access points'), [
			table([
				{ label: _('Section') },
				{ label: _('SSID') },
				{ label: _('BSSID') },
				{ label: _('Runtime state') },
				{ label: _('802.11k') },
				{ label: _('802.11v') },
				{ label: _('802.11r') },
				{ label: _('Mobility domain') },
				{ label: _('FT transport') }
			], interfaceRows, { empty: _('No access point interface was found.') })
		], { description: _('The configured per-interface values, the BSSID in use and whether the interface is up right now. The BSSID is checked for validity and uniqueness in the roaming advice; a value only takes effect after the roaming settings are applied.') });

		/*
		 * Neighbouring access points (DESIGN §8.1).  A scan takes the radio
		 * off its channel, so it runs only after an explicit confirmation for
		 * that one radio.  The backend reports the BSSIDs it heard; the
		 * analysis marks our own APs and compares foreign APs that use one of
		 * our SSIDs with the configured security.
		 */
		const neighborRadios = (data.inventory && data.inventory.radios) || [];
		const neighborScans = {};
		const neighborNode = E('div', {});
		let neighborScanning = '';

		const scanRadio = function(entry) {
			if (neighborScanning)
				return;

			widgets.confirm(_('Neighbouring access point scan'),
				E('div', {}, [
					E('p', {}, [
						_('Scanning %s takes the radio off its channel for a few seconds. Connected clients may see a short interruption and the mesh may re-converge.').format(radioUtil.radioLabel(entry))
					]),
					E('p', {}, [ _('The scan is read-only; it changes no configuration.') ])
				]), _('Scan now'), false).then(function(yes) {
				if (!yes)
					return;

				neighborScanning = entry.name;
				renderNeighbors();

				const done = function(scan) {
					neighborScans[entry.name] = scan;
					neighborScanning = '';
					renderNeighbors();
				};

				rpc.roamingNeighborScan(entry.name).then(function(reply) {
					if (reply && reply.ok === false) {
						done({
							radio: entry.name,
							ok: false,
							message: reply.message || reply.error || _('The scan failed.')
						});
						return;
					}

					done(Object.assign({ radio: entry.name, ok: true }, reply || {}));
				}).catch(function(err) {
					done({
						radio: entry.name,
						ok: false,
						message: err.message || _('The scan failed.')
					});
				});
			});
		};

		const renderNeighbors = function() {
			const scans = Object.keys(neighborScans).map(function(name) {
				return neighborScans[name];
			});
			const analysis = neighbours.analyse(scans, interfaces);
			const nodes = [];

			nodes.push(E('div', {}, neighborRadios.length
				? neighborRadios.map(function(entry) {
					const result = neighborScans[entry.name];
					const state = neighborScanning === entry.name
						? badge(_('Scanning…'), 'muted')
						: (!result
							? badge(_('Not scanned'), 'muted')
							: (result.ok === false
								? badge(_('Failed'), 'error')
								: badge(_('%d access point(s)').format((result.access_points || []).length), 'ok')));

					return E('div', { 'class': 'wm-scope-entry' }, [
						E('strong', {}, [ radioUtil.radioLabel(entry) ]),
						' ',
						state,
						' ',
						widgets.button(neighborScanning === entry.name
							? _('Scanning…') : _('Scan this radio'),
							function() { scanRadio(entry); }, 'action')
					]);
				})
				: [ E('p', { 'class': 'wm-muted' }, [ _('No radio was found.') ]) ]));

			for (const failure of analysis.failed)
				nodes.push(alert('error', _('%s: %s').format(failure.radio, failure.message)));

			if (!analysis.hasData) {
				nodes.push(E('p', { 'class': 'wm-muted' }, [
					analysis.scanned > 0
						? _('The scans returned no access point. The radio may be the only one in range, or the driver may report nothing while it is up.')
						: _('Scan a radio to list the access points it can hear. Each scan runs only after you confirm it.')
				]));
			}
			else {
				if (analysis.findings.length) {
					nodes.push(table([
						{ label: _('Level') },
						{ label: _('Code') },
						{ label: _('Finding') }
					], analysis.findings.map(function(finding) {
						return [
							badge(neighbours.levelName(finding.level),
								finding.level === 'warn' ? 'warn' :
									(finding.level === 'error' ? 'error' : 'muted')),
							finding.code,
							neighbours.findingText(finding)
						];
					})));
				}
				else {
					nodes.push(alert('ok',
						_('No neighbouring access point needs attention: none broadcasts one of your SSIDs with a different security setting.')));
				}

				nodes.push(table([
					{ label: _('BSSID') },
					{ label: _('SSID') },
					{ label: _('Band') },
					{ label: _('Channel') },
					{ label: _('Signal') },
					{ label: _('Security') },
					{ label: _('State') }
				], analysis.rows.map(function(row) {
					return [
						row.bssid,
						row.ssid || _('Hidden SSID'),
						row.band ? radioUtil.bandName(row.band) : '-',
						row.channel != null ? String(row.channel) : '-',
						row.signal != null ? '%d dBm'.format(row.signal) : '-',
						neighbours.securityName(row.security),
						row.self
							? badge(neighbours.stateName(row), 'ok')
							: (row.securityMatches === false
								? badge(neighbours.stateName(row), 'warn')
								: badge(neighbours.stateName(row), 'muted'))
					];
				})));

				const notes = [
					_('A scan is a snapshot of one moment and of one radio; it does not prove that a neighbour is permanent or reachable from the other access points.'),
					_('“Yours” marks a BSSID configured on this router. A foreign access point that uses one of your SSIDs with a different security setting breaks fast transition for that SSID.'),
					_('The list is read from the driver. A hidden neighbour cannot be shown, and a driver that returns no scan result is reported as a failure rather than as an empty area.')
				];

				if (analysis.scanned > 1)
					notes.push(_('Each radio scans on its own channel, so the merged list may mix 2.4, 5 and 6 GHz observations.'));

				nodes.push(widgets.list(notes));
			}

			dom.content(neighborNode, nodes);
		};

		const neighborCard = card(_('Neighbouring access points'), [ neighborNode ], {
			description: _('Lists the access points the selected radio can hear and compares foreign APs that use your SSIDs. A scan briefly takes the radio off its channel and only runs after you confirm it.')
		});

		renderNeighbors();

		const applyCard = card(_('Apply roaming settings'), [
			E('p', { 'class': 'wm-muted' }, [
				_('Saving writes the form to /etc/config/meshassistant. Applying also rewrites the managed AP sections, restarts hostapd and reconfigures DAWN; Wi-Fi clients may reconnect briefly.')
			]),
			widgets.toolbar([
				widgets.button(_('Apply saved configuration'), function() {
					return widgets.confirm(_('Apply roaming settings'),
						_('The saved values are applied now. Wi-Fi clients may reconnect and this page may be unreachable for a short time.'),
						_('Apply'), false).then(function(confirmed) {
						if (!confirmed)
							return;

						ui.showModal(_('Applying roaming settings'), [
							widgets.spinner(_('The roaming engine is applying the configuration…'))
						]);

						return widgets.runOperation(rpc.roamingApply, _('Apply roaming settings'))
							.then(function(op) {
								ui.hideModal();
								widgets.notify('info', op.message || _('Roaming settings applied.'));
								window.setTimeout(function() { window.location.reload(); }, 2000);
							})
							.catch(function(err) {
								ui.hideModal();
								widgets.notify('error', err && err.message ? err.message :
									_('The roaming settings could not be applied.'));
							});
					});
				}, 'action')
			])
		]);

		return m.render().then(function(mapEl) {
			return widgets.page(_('Roaming settings'),
				_('802.11k/v/r and the thresholds that DAWN uses to steer clients.'),
				[
					E('div', {}, warnings),
					capabilityCard,
					adviceCard,
					mapEl,
					interfaceCard,
					neighborCard,
					applyCard,
					widgets.operationCard(data.status && data.status.op),
					card(_('Related pages'), [
						widgets.list([
							adminLink('admin/network/wifimanager/roaming/dawn', _('DAWN status')),
							adminLink('admin/network/wifimanager/roaming/events', _('Roaming events')),
							adminLink('admin/network/wifimanager/mesh/settings', _('Mesh settings'))
						])
					])
				]);
		});
	},

	handleSaveApply: function() {
		const self = this;

		return widgets.confirm(_('Save and apply roaming settings'),
			_('The form is committed, then the roaming engine rewrites the AP sections, restarts hostapd and reconfigures DAWN. Wi-Fi clients may reconnect.'),
			_('Save & apply'), false).then(function(confirmed) {
			if (!confirmed)
				return;

			ui.showModal(_('Applying roaming settings'), [
				widgets.spinner(_('Saving the form and applying the configuration…'))
			]);

			return self.map.save()
				.then(function() { return uci.apply(60); })
				.then(function() { return widgets.runOperation(rpc.roamingApply, _('Apply roaming settings')); })
				.then(function(op) {
					ui.hideModal();
					widgets.notify('info', op.message || _('Roaming settings applied.'));
					window.setTimeout(function() { window.location.reload(); }, 2000);
				})
				.catch(function(err) {
					ui.hideModal();
					widgets.notify('error', err && err.message ? err.message :
						_('The roaming settings could not be applied.'));
				});
		});
	}
});
