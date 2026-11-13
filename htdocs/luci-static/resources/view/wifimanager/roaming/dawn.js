'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;
const kv = widgets.kv;

function yesNo(value, yes, no) {
	return value ? badge(yes || _('Yes'), 'ok') : badge(no || _('No'), 'muted');
}

return view.extend({
	load: function() {
		return rpc.diagnostics('roaming').catch(function() { return null; });
	},

	render: function(data) {
		const content = E('div', {});
		let roaming = data || {};

		const renderContent = function() {
			const caps = roaming.capabilities || {};
			const interfaces = roaming.interfaces || [];
			const events = roaming.events || {};
			const configured = !!(caps.k || caps.v);
			const warnings = [];

			if (!roaming.ok)
				warnings.push(alert('warn',
					_('The DAWN status could not be read. The values below may be stale.')));

			if (configured && !caps.dawn)
				warnings.push(alert('warn',
					_('Client steering is configured, but DAWN is not installed. 802.11k/v remain enabled on the APs; install the dawn package to get client steering.')));

			if (caps.v && !caps.wnm)
				warnings.push(alert('warn',
					_('This wpad build has no 802.11v support. DAWN can collect metrics, but the AP cannot send a BSS transition request, so it cannot steer a client away.')));

			if (configured && !caps.dawn_managed)
				warnings.push(alert('info',
					_('DAWN is not managed by WiFi Manager yet. Apply the roaming settings while mesh networking is enabled to write the managed configuration.')));

			if (caps.dawn_restarts != null && caps.dawn_restarts > 0)
				warnings.push(alert('warn',
					_('DAWN has been restarted %d time(s) since it started. Repeated restarts point to a configuration or driver problem; check the DAWN log.')
						.format(caps.dawn_restarts)));

			if (caps.dawn_managed && caps.dawn_watchdog && !caps.dawn_running)
				warnings.push(alert('warn',
					_('DAWN is managed but not running. The watchdog in the minute ticker restarts it at most once every five minutes; the last attempt is recorded in the log.')));

			if (caps.dawn_watchdog_failures > 0)
				warnings.push(alert('error',
					_('The DAWN watchdog failed to restart the service %d time(s) in a row. Check that the dawn package and its configuration are intact.')
						.format(caps.dawn_watchdog_failures)));

			const interfacesRows = interfaces.map(function(entry) {
				return [
					entry.section,
					entry.ssid || '-',
					yesNo(entry.k),
					yesNo(entry.v),
					yesNo(entry.r),
					entry.mobility_domain || '-'
				];
			});

			dom.content(content, [
				E('div', {}, warnings),
				card(_('DAWN'), [
					kv([
						[ _('802.11k neighbor reports'), yesNo(caps.k, _('Enabled'), _('Disabled')) ],
						[ _('802.11v client steering'), yesNo(caps.v, _('Enabled'), _('Disabled')) ],
						[ _('DAWN installed'), yesNo(caps.dawn) ],
						[ _('DAWN running'), yesNo(caps.dawn_running, _('Running'), _('Stopped')) ],
						[ _('Managed configuration'), caps.dawn_managed
							? badge(_('Managed by WiFi Manager'), 'info')
							: badge(_('Not managed'), 'muted') ],
						[ _('802.11v support in wpad'), yesNo(caps.wnm, _('Available'), _('Unavailable')) ],
						[ _('Restarts since start'), caps.dawn_restarts != null ? String(caps.dawn_restarts) : '-' ],
						[ _('Recorded events'), String(events.count != null ? events.count : 0) ],
						[ _('Last event'), events.last ? format.dateFromEpoch(events.last) : _('Never') ]
					])
				], { description: _('DAWN scores every access point a client can see and asks the client to move when another AP is clearly better. It needs 802.11k neighbor reports, 802.11v transition requests and a shared key on every AP.') }),
				card(_('Steering decisions'), [
					kv([
						[ _('Client steering'), caps.dawn_params
							? ({ '0': _('Disabled'), '1': _('Advisory only'),
							     '2': _('Disconnect after ignored requests'),
							     '3': _('Disconnect immediately') })[String(caps.dawn_params.kicking)] || String(caps.dawn_params.kicking)
							: '-' ],
						[ _('Steering RSSI difference'), caps.dawn_params && caps.dawn_params.kicking_threshold != null
							? '%s dB'.format(caps.dawn_params.kicking_threshold) : '-' ],
						[ _('Minimum clients'), caps.dawn_params && caps.dawn_params.min_clients != null
							? String(caps.dawn_params.min_clients) : '-' ],
						[ _('Evaluation interval'), caps.dawn_params && caps.dawn_params.duration != null
							? _('%d seconds').format(caps.dawn_params.duration) : '-' ],
						[ _('Watchdog'), yesNo(caps.dawn_watchdog, _('Enabled'), _('Disabled')) ],
						[ _('Watchdog failures'), String(caps.dawn_watchdog_failures || 0) ],
						[ _('Last watchdog restart'), caps.dawn_last_restart
							? format.dateFromEpoch(caps.dawn_last_restart) : _('Never') ]
					])
				], { description: _('The values this engine writes to the managed DAWN configuration. Change them on the roaming settings page; DAWN only steers clients while mesh networking is enabled.') }),
				card(_('Access points'), [
					table([
						{ label: _('Section') },
						{ label: _('SSID') },
						{ label: _('802.11k') },
						{ label: _('802.11v') },
						{ label: _('802.11r') },
						{ label: _('Mobility domain') }
					], interfacesRows, { empty: _('No access point interface was found.') })
				], { description: _('These are the configured values from /etc/config/wireless. The running hostapd picks them up after the roaming settings are applied.') }),
				card(_('Managed DAWN configuration'), [
					E('p', {}, [
						_('While client steering is enabled and mesh networking is on, WiFi Manager owns /etc/config/dawn: it writes the metric sections, per-band thresholds and a shared key derived from the mesh password, and restarts DAWN. A pre-existing DAWN configuration is backed up first and restored when client steering is turned off.')
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('The shared key is never shown here. Edits made to the managed DAWN file outside WiFi Manager are overwritten on the next apply.')
					]),
					widgets.toolbar([
						widgets.button(_('Apply roaming settings'), function() {
							return widgets.confirm(_('Apply roaming settings'),
								_('The managed AP sections, DAWN configuration and service are rewritten. Wi-Fi clients may reconnect briefly.'),
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
				]),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/roaming/settings', _('Roaming settings and thresholds')),
						adminLink('admin/network/wifimanager/roaming/events', _('Roaming events')),
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return rpc.diagnostics('roaming').then(function(next) {
				roaming = next || roaming;
				renderContent();
			});
		}, 30000);

		return widgets.page(_('DAWN client steering'),
			_('Status of the steering daemon and the 802.11k/v/r flags on the access points.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
