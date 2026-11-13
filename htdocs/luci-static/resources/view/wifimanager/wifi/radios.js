'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.radio as radio';
'require wifimanager.utils.channel as channel';
'require wifimanager.utils.format as format';
'require dom';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;

function runtimeBadge(entry) {
	if (entry.disabled)
		return badge(_('Disabled'), 'muted');

	if (entry.up)
		return badge(_('Up'), 'ok');

	if (entry.runtime_channel === '-')
		return badge(_('Runtime unavailable'), 'warn');

	return badge(_('Down'), 'error');
}

return view.extend({
	load: function() {
		// The inventory takes up to two seconds on a router; the page paints
		// at once and fills in when the reply arrives.
		return null;
	},

	render: function() {
		return widgets.deferredPage(_('Radios'),
			_('Radio allocation, channel plan and conflicts detected from configuration and runtime.'),
			rpc.radioInventory(), this.renderBody.bind(this),
			_('The radio inventory could not be read.'));
	},

	renderBody: function(inventory) {
		if (!inventory || inventory.ok === false)
			return widgets.page(_('Radios'), null, [
				widgets.errorBox(new Error((inventory && inventory.message) || _('The radio inventory could not be read.')))
			]);

		const content = E('div', {});
		let current = inventory;
		const analyses = {};
		let analyzing = '';

		/*
		 * The channel recommendation is an explicit action: a scan briefly
		 * takes a running radio off-channel.  The request only names a radio
		 * the inventory reported; the backend resolves the scan interface and
		 * the candidate list itself.
		 */
		const analyze = function(entry) {
			if (analyzing)
				return;

			widgets.confirm(_('Channel scan'),
				E('div', {}, [
					E('p', {}, [
						_('Analyzing %s runs a scan. While the scan runs the radio briefly leaves its channel, so connected clients may see a short interruption and the mesh may re-converge.').format(radio.radioLabel(entry))
					]),
					E('p', {}, [ _('The scan is read-only; it changes no configuration.') ])
				]), _('Scan now'), false).then(function(yes) {
				if (!yes)
					return;

				analyzing = entry.name;
				renderContent();

				rpc.channelAdvice(entry.name).then(function(reply) {
					analyses[entry.name] = (reply && reply.ok === false)
						? { error: reply.message || reply.error || _('The channel scan failed.') }
						: { reply: reply };
				}).catch(function(err) {
					analyses[entry.name] = { error: err.message || _('The channel scan failed.') };
				}).then(function() {
					analyzing = '';
					renderContent();
				});
			});
		};

		const renderAnalysis = function(reply) {
			const ranked = channel.rank(reply);
			const rows = ranked.candidates.slice(0, 8).map(function(candidate) {
				return [
					E('strong', {}, [ String(candidate.channel) ]),
					radio.bandName(candidate.band),
					candidate.dfs ? _('Yes') : _('No'),
					String(candidate.interference),
					candidate.cochannel > 0 ? String(candidate.cochannel) : '-',
					String(Math.round(candidate.score * 10) / 10),
					ranked.current === String(candidate.channel) ? _('In use') : '-'
				];
			});

			const nodes = [];

			if (ranked.best) {
				nodes.push(E('p', {}, [
					E('strong', {}, [
						_('Suggested channel: %s (%s, %s MHz wide).').format(
							ranked.best.channel, radio.bandName(ranked.best.band), String(ranked.width))
					]),
					ranked.keep
						? ' ' + _('This is the channel the radio already uses.')
						: ''
				]));
			}
			else {
				nodes.push(E('p', {}, [ _('The driver reported no usable channel for this band.') ]));
			}

			nodes.push(table([
				{ label: _('Channel') },
				{ label: _('Band') },
				{ label: _('DFS') },
				{ label: _('Interference') },
				{ label: _('Co-channel') },
				{ label: _('Score') },
				{ label: _('State') }
			], rows, { empty: _('No candidate channel was reported.') }));

			const notes = [
				_('The scan is a snapshot of the access points visible from this radio; it does not prove a channel will stay free.'),
				_('Scores assume the configured channel width; a different runtime width changes which channels overlap.'),
				_('DFS channels need a channel availability check and can be vacated when radar is detected.')
			];

			if (!ranked.hasData)
				notes.push(_('No access point was visible, so the ranking only reflects DFS and the current utilization.'));
			if (ranked.busy > 0)
				notes.push(_('Current channel utilization: %d%%.').format(ranked.busy));

			nodes.push(widgets.list(notes));

			return E('div', {}, nodes);
		};

		const channelBlock = function(entry) {
			const result = analyses[entry.name];
			const parts = [
				E('div', { 'class': 'wm-toolbar' }, [
					E('strong', {}, [ radio.radioLabel(entry) ]),
					' ',
					entry.disabled
						? E('span', { 'class': 'wm-muted' }, [ _('The radio is disabled; enable it before scanning.') ])
						: widgets.button(analyzing === entry.name ? _('Scanning…') : _('Analyze channels'),
							function() { analyze(entry); }, 'action')
				])
			];

			if (analyzing === entry.name)
				parts.push(widgets.loading(_('Scanning the radio; its clients may be interrupted briefly…')));
			else if (result && result.error)
				parts.push(widgets.alert('error', result.error));
			else if (result && result.reply)
				parts.push(renderAnalysis(result.reply));
			else if (!entry.disabled)
				parts.push(E('p', { 'class': 'wm-muted' }, [
					_('Run a scan to rank the channels this radio can use.')
				]));

			return E('div', { 'class': 'wm-scope-entry' }, parts);
		};

		/*
		 * Compact a channel list ("1,2,...,13,36,40,...") into ranges so the
		 * capability table stays readable for a radio with many channels.
		 */
		const channelList = function(channels) {
			const values = (channels || []).map(Number).filter(function(value) {
				return Number.isFinite(value);
			}).sort(function(a, b) { return a - b; });
			const parts = [];
			let start = null;
			let previous = null;

			for (const value of values) {
				if (start == null) {
					start = previous = value;
					continue;
				}

				if (value === previous + 1) {
					previous = value;
					continue;
				}

				parts.push(start === previous ? String(start) : '%d-%d'.format(start, previous));
				start = previous = value;
			}

			if (start != null)
				parts.push(start === previous ? String(start) : '%d-%d'.format(start, previous));

			return parts.join(', ');
		};

		const capabilityBlock = function(entry) {
			const caps = entry.capabilities;
			const parts = [
				E('div', { 'class': 'wm-toolbar' }, [
					E('strong', {}, [ radio.radioLabel(entry) ]),
					' ',
					entry.phy
						? E('span', { 'class': 'wm-muted' }, [ entry.phy ])
						: '',
					' ',
					radio.capabilityAvailable(entry)
						? badge(_('Reported'), 'ok')
						: badge(_('Not reported'), 'warn')
				])
			];

			if (!radio.capabilityAvailable(entry)) {
				parts.push(E('p', { 'class': 'wm-muted' }, [
					_('The driver did not report its capabilities for this radio, so the wireless settings fall back to the generic checks and ask before a combination is saved.')
				]));

				return E('div', { 'class': 'wm-scope-entry' }, parts);
			}

			const bandRows = (caps.bands || []).map(function(band) {
				return [
					radio.bandName(band.band),
					channelList(band.channels) || '-',
					radio.bandSummary(band),
					band.dfs ? _('Yes') : _('No')
				];
			});

			parts.push(table([
				{ label: _('Band') },
				{ label: _('Usable channels') },
				{ label: _('PHY modes') },
				{ label: _('DFS') }
			], bandRows, { empty: _('The driver reported no usable band.') }));

			parts.push(E('p', {}, [
				E('strong', {}, [ _('Interface modes:') ]),
				' ',
				(caps.modes || []).length
					? (caps.modes || []).map(radio.capabilityModeName).join(', ')
					: _('Not reported')
			]));

			const combinations = caps.combinations || [];

			if (combinations.length) {
				parts.push(E('p', {}, [
					E('strong', {}, [ _('Reported interface combinations:') ])
				]));
				parts.push(widgets.list(combinations.map(radio.combinationText)));
				parts.push(E('p', { 'class': 'wm-muted' }, [
					_('Combinations limit how many interfaces of each mode the driver accepts on one radio. The channel count of one combination is not shown as a limit because a single radio always uses one channel.')
				]));
			}
			else {
				parts.push(E('p', { 'class': 'wm-muted' }, [
					_('The driver reported no interface combinations, so running several interfaces on this radio cannot be confirmed.')
				]));
			}

			return E('div', { 'class': 'wm-scope-entry' }, parts);
		};

		const renderContent = function() {
			const radios = current.radios || [];
			const conflicts = current.conflicts || [];
			const byRadio = {};
			const ifaceBySection = {};

			// A radio's interfaces array only carries section names; the full
			// records say what each section is, so join the two here.
			for (const iface of (current.interfaces || []))
				ifaceBySection[iface.section] = iface;

			const interfaceCell = function(sections) {
				const list = sections || [];

				if (!list.length)
					return '-';

				return E('div', {}, list.map(function(section) {
					const info = ifaceBySection[section];

					if (!info)
						return E('div', {}, [ section ]);

					const marks = [];

					if (info.mlo)
						marks.push(badge(_('MLO'), 'info'));
					if (info.mesh_owned)
						marks.push(badge(_('Mesh-owned'), 'info'));
					if (info.disabled)
						marks.push(badge(_('Disabled'), 'muted'));

					return E('div', {}, [
						E('strong', {}, [ section ]),
						info.runtime_ifname && info.runtime_ifname !== section
							? E('span', { 'class': 'wm-muted' }, [ ' (' + info.runtime_ifname + ')' ])
							: '',
						E('div', { 'class': 'wm-event-detail' }, [ radio.modeName(info.mode) ]),
						marks.length ? E('span', {}, marks) : ''
					]);
				}));
			};

			for (const conflict of conflicts) {
				const detail = String(conflict.detail || '');

				for (const name of radios.map(function(r) { return r.name; })) {
					if (detail.split(/\s+/).indexOf(name) !== -1 ||
					    String(conflict.message || '').indexOf("'" + name + "'") !== -1) {
						if (!byRadio[name])
							byRadio[name] = [];
						byRadio[name].push(conflict);
					}
				}
			}

			const rows = radios.map(function(entry) {
				const htmode = entry.htmode || '';
				const runtime = entry.runtime_channel !== '-' || entry.runtime_txpower !== '-'
					? '%s / %s'.format(entry.runtime_channel || '-', entry.runtime_txpower || '-')
					: '-';
				const mismatch = [];

				if (!entry.disabled && entry.runtime_channel === '-')
					mismatch.push(_('runtime not readable'));

				if (entry.channel && entry.channel !== 'auto' &&
				    entry.runtime_channel !== '-' && entry.channel !== entry.runtime_channel)
					mismatch.push(_('channel differs from runtime'));

				return [
					E('div', {}, [
						E('strong', {}, [ entry.name ]),
						entry.phy ? E('div', { 'class': 'wm-event-detail' }, [ entry.phy ]) : ''
					]),
					radio.bandName(entry.band),
					htmode || '-',
					entry.channel || _('auto'),
					entry.txpower || _('auto'),
					runtime,
					E('div', {}, [
						runtimeBadge(entry),
						mismatch.length ? E('div', { 'class': 'wm-event-detail' }, [ mismatch.join(', ') ]) : ''
					]),
					interfaceCell(entry.interfaces),
					byRadio[entry.name] ? badge(_('%d conflict(s)').format(byRadio[entry.name].length), 'warn') : '-'
				];
			});

			const conflictRows = conflicts.map(function(conflict) {
				return [
					badge(conflict.severity === 'error' ? _('Error') : _('Warning'),
						conflict.severity === 'error' ? 'error' : 'warn'),
					conflict.code,
					radio.conflictTitle(conflict),
					conflict.message || '',
					conflict.detail || ''
				];
			});

			dom.content(content, [
				card(_('Radio inventory'), [
					table([
						{ label: _('Radio') },
						{ label: _('Band') },
						{ label: _('PHY mode') },
						{ label: _('Channel (config)') },
						{ label: _('TX power (config)') },
						{ label: _('Channel / TX power (runtime)') },
						{ label: _('State') },
						{ label: _('Interfaces') },
						{ label: _('Checks') }
					], rows, { empty: _('No radios were found.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('Configured values come from UCI. Runtime values come from iwinfo; a value the driver does not expose stays “-” instead of being guessed.')
					])
				]),
				card(_('Channel recommendation'), radios.map(channelBlock), {
					description: _('Ranks the channels the driver accepts by the access points a scan can see. A scan is only run after you confirm it.')
				}),
				card(_('Hardware capability'), radios.map(capabilityBlock), {
					description: _('Bands, interface modes and interface combinations the driver reports for each radio. Values the driver does not report stay “not reported”; nothing here is inferred from the configuration.')
				}),
				card(_('Radio conflicts'), [
					table([
						{ label: _('Severity') },
						{ label: _('Code') },
						{ label: _('Check') },
						{ label: _('Message'), className: 'wm-wrap' },
						{ label: _('Detail') }
					], conflictRows, { empty: _('No conflicts were found.') })
				], { description: _('E-* findings block a safe allocation; W-* findings are warnings about combinations the driver may reject.') }),
				card(_('Related settings'), [
					widgets.list([
						adminLink('admin/network/wireless', _('Open the standard Wireless configuration')),
						adminLink('admin/network/wifimanager/mesh/settings', _('Choose these radios in Mesh Settings'))
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

		return widgets.page(_('Radios'), _('Radio allocation, channel plan and conflicts detected from configuration and runtime.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
