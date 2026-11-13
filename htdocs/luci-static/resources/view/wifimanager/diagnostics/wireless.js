'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.radio as radio';
'require wifimanager.utils.format as format';
'require dom';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const kv = widgets.kv;
const adminLink = widgets.adminLink;

function radioState(entry) {
	if (entry.disabled)
		return badge(_('Disabled'), 'muted');

	if (entry.up)
		return badge(_('Up'), 'ok');

	if (entry.runtime_channel === '-')
		return badge(_('Runtime unavailable'), 'warn');

	return badge(_('Down'), 'error');
}

function ifaceState(entry) {
	if (entry.disabled)
		return badge(_('Disabled'), 'muted');

	if (!entry.ifname && !entry.runtime_ifname)
		return badge(_('No netdev'), 'warn');

	if (entry.up)
		return badge(_('Up'), 'ok');

	return badge(_('Down'), 'error');
}

/*
 * Differences between the configured and the runtime view are only stated
 * when both sides are known.  A driver that does not expose the runtime value
 * yields "-", which must not be read as a mismatch.
 */
function runtimeNotes(entry) {
	const notes = [];

	if (entry.disabled)
		return notes;

	if (entry.runtime_channel === '-')
		notes.push(_('runtime channel unavailable'));

	if (entry.runtime_txpower === '-')
		notes.push(_('runtime TX power unavailable'));

	if (entry.channel && entry.channel !== 'auto' &&
	    entry.runtime_channel !== '-' && entry.channel !== entry.runtime_channel)
		notes.push(_('configured channel and runtime channel differ'));

	if (entry.txpower && entry.txpower !== 'auto' &&
	    entry.runtime_txpower !== '-' && entry.txpower !== entry.runtime_txpower)
		notes.push(_('configured TX power and runtime TX power differ'));

	return notes;
}

function ifaceName(entry) {
	return entry.mode === 'mesh'
		? (entry.mesh_id || _('(no mesh ID)'))
		: (entry.ssid || '-');
}

return view.extend({
	load: function() {
		return rpc.diagnostics('wireless').catch(function(err) {
			return { ok: false, message: err && err.message };
		});
	},

	render: function(diag) {
		if (!diag || diag.ok === false)
			return widgets.page(_('Wireless diagnostics'), null, [
				widgets.errorBox(new Error((diag && diag.message) ||
					_('The wireless diagnostics could not be read.')))
			]);

		const content = E('div', {});
		let current = diag;

		const renderContent = function() {
			const inventory = current.inventory || {};
			const radios = inventory.radios || [];
			const ifaces = inventory.interfaces || [];
			const conflicts = current.conflicts || inventory.conflicts || [];
			const errors = conflicts.filter(function(conflict) {
				return conflict.severity === 'error';
			});
			const warnings = conflicts.filter(function(conflict) {
				return conflict.severity !== 'error';
			});
			const upRadios = radios.filter(function(entry) { return entry.up; }).length;
			const upIfaces = ifaces.filter(function(entry) { return entry.up; }).length;

			const notices = [];

			if (errors.length)
				notices.push(alert('error',
					_('%d allocation problem(s) prevent a safe radio layout.').format(errors.length)));

			if (warnings.length)
				notices.push(alert('warn',
					_('%d warning(s) describe combinations the driver may reject.').format(warnings.length)));

			const radioRows = radios.map(function(entry) {
				const notes = runtimeNotes(entry);
				const runtime = '%s / %s'.format(
					entry.runtime_channel || '-', entry.runtime_txpower || '-');

				return [
					E('strong', {}, [ entry.name ]),
					radio.bandName(entry.band),
					entry.htmode || '-',
					entry.channel || _('auto'),
					entry.txpower || _('auto'),
					runtime,
					E('div', {}, [
						radioState(entry),
						notes.length
							? E('div', { 'class': 'wm-event-detail' }, [ notes.join(', ') ])
							: ''
					]),
					(entry.interfaces || []).length ? (entry.interfaces || []).join(', ') : '-'
				];
			});

			const ifaceRows = ifaces.map(function(entry) {
				return [
					entry.section,
					entry.runtime_ifname || entry.ifname || '-',
					radio.modeName(entry.mode),
					entry.device || '-',
					ifaceName(entry),
					entry.network || '-',
					entry.encryption || '-',
					E('div', {}, [
						entry.mlo ? badge(_('MLO'), 'info') : '',
						entry.mlo && entry.mesh_owned ? ' ' : '',
						entry.mesh_owned ? badge(_('Mesh'), 'muted') : ''
					]),
					String(entry.stations != null ? entry.stations : '-'),
					entry.signal && entry.signal !== '-' ? entry.signal + ' dBm' : '-',
					entry.tx_rate && entry.tx_rate !== '-' ? format.rate(entry.tx_rate) : '-',
					entry.rx_rate && entry.rx_rate !== '-' ? format.rate(entry.rx_rate) : '-',
					ifaceState(entry)
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
				E('div', {}, notices),
				card(_('Summary'), [
					kv([
						[ _('Radios'), '%d (%d up)'.format(radios.length, upRadios) ],
						[ _('Interfaces'), '%d (%d up)'.format(ifaces.length, upIfaces) ],
						[ _('Mesh running'), widgets.boolBadge(!!inventory.mesh_running) ],
						[ _('Allocation conflicts'), conflicts.length
							? badge(_('%d finding(s)').format(conflicts.length), errors.length ? 'error' : 'warn')
							: badge(_('None'), 'ok') ]
					])
				], { description: _('Configured values come from UCI. Up/down and channel information come from the running system and may lag behind a pending configuration change.') }),
				card(_('Radios'), [
					table([
						{ label: _('Radio') },
						{ label: _('Band') },
						{ label: _('PHY mode') },
						{ label: _('Channel (config)') },
						{ label: _('TX power (config)') },
						{ label: _('Channel / TX power (runtime)') },
						{ label: _('State') },
						{ label: _('Interfaces') }
					], radioRows, { empty: _('No radios were found.') })
				], { description: _('A runtime value the driver does not expose stays “-”; it is never guessed from the configuration.') }),
				card(_('Interfaces'), [
					table([
						{ label: _('Section') },
						{ label: _('Netdev') },
						{ label: _('Mode') },
						{ label: _('Radio') },
						{ label: _('SSID / mesh ID') },
						{ label: _('Network') },
						{ label: _('Encryption') },
						{ label: _('Flags') },
						{ label: _('Stations') },
						{ label: _('Signal') },
						{ label: _('TX rate') },
						{ label: _('RX rate') },
						{ label: _('State') }
					], ifaceRows, { empty: _('No wireless interfaces were found.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('The station count is read from the running interface; “No netdev” means the configured interface is not attached to a netdev yet. Signal and rates belong to the station with the strongest signal on that interface; an interface without stations shows no value.')
					])
				]),
				card(_('Configuration checks'), [
					table([
						{ label: _('Severity') },
						{ label: _('Code') },
						{ label: _('Check') },
						{ label: _('Message'), className: 'wm-wrap' },
						{ label: _('Detail') }
					], conflictRows, { empty: _('No allocation conflicts were found.') }),
					current.note ? E('p', { 'class': 'wm-muted' }, [ current.note ]) : ''
				], { description: _('These checks compare configuration only. They do not restart radios and do not change anything.') }),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/wireless/radios', _('Radio allocation')),
						adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics')),
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs')),
						adminLink('admin/network/wireless', _('Standard Wireless configuration'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return rpc.diagnostics('wireless').then(function(next) {
				if (next && next.ok !== false) {
					current = next;
					renderContent();
				}
			});
		}, 20000);

		return widgets.page(_('Wireless diagnostics'),
			_('Configured radio layout, runtime state and allocation checks side by side.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
