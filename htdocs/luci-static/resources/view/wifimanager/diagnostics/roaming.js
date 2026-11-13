'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const kv = widgets.kv;
const adminLink = widgets.adminLink;

function yesNo(value, yes, no) {
	return value ? badge(yes || _('Yes'), 'ok') : badge(no || _('No'), 'muted');
}

function stateBadge(installed, running) {
	if (!installed)
		return badge(_('Not installed'), 'muted');

	return running ? badge(_('Running'), 'ok') : badge(_('Stopped'), 'error');
}

function clientSummary(event) {
	const parts = [];

	if (event.mac)
		parts.push(format.mac(event.mac));
	if (event.iface)
		parts.push(event.ssid ? '%s (%s)'.format(event.iface, event.ssid) : event.iface);
	if (event.signal && event.signal !== 'unavailable')
		parts.push('%s dBm'.format(event.signal));

	return parts.length ? parts.join(' · ') : '-';
}

function eventSummary(event) {
	switch (event.event) {
	case 'client-join':
	case 'client-leave':
		return clientSummary(event);
	case 'roam':
		return '%s · %s → %s'.format(format.mac(event.mac),
			event.from_iface || '-', event.to_iface || '-');
	case 'link-up':
	case 'link-down':
		return event.iface || '-';
	case 'dawn-restart':
		return '%s · %s'.format(event.result || '-',
			event.attempt != null ? _('attempt %s').format(event.attempt) : '');
	default:
		return event.message || event.error || event.reason || '-';
	}
}

function logBlock(lines) {
	if (!lines || !lines.length)
		return E('p', { 'class': 'wm-muted' }, [ _('The DAWN log is empty.') ]);

	return E('pre', { 'class': 'wm-log' }, [ lines.join('\n') ]);
}

return view.extend({
	load: function() {
		return Promise.all([
			rpc.diagnostics('roaming').catch(function(err) {
				return { ok: false, message: err && err.message };
			}),
			rpc.meshEvents(20).catch(function() { return null; }),
			rpc.logs('dawn', 80).catch(function() { return null; })
		]).then(function(result) {
			return { roaming: result[0], events: result[1], log: result[2] };
		});
	},

	render: function(data) {
		const roaming = (data && data.roaming) || {};

		if (roaming.ok === false)
			return widgets.page(_('Roaming diagnostics'), null, [
				widgets.errorBox(new Error(roaming.message ||
					_('The roaming diagnostics could not be read.')))
			]);

		const caps = roaming.capabilities || {};
		const interfaces = roaming.interfaces || [];
		const params = caps.dawn_params || {};
		const events = (data.events && data.events.events) || [];
		const log = (data.log && data.log.lines) || [];

		const interfaceRows = interfaces.map(function(entry) {
			return [
				entry.section,
				entry.ssid || '-',
				entry.ifname || '-',
				entry.up ? badge(_('Up'), 'ok') : badge(_('Down'), 'muted'),
				yesNo(entry.k),
				yesNo(entry.v),
				yesNo(entry.r),
				entry.mobility_domain || '-'
			];
		});

		const eventRows = events.map(function(event) {
			return [
				format.dateFromEpoch(event.ts),
				event.event || '-',
				E('span', { 'class': 'wm-wrap' }, [ eventSummary(event) ])
			];
		});

		return widgets.page(_('Roaming diagnostics'),
			_('DAWN, the 802.11k/v/r flags on each access point, recent roaming events and the DAWN log.'),
			[
				card(_('DAWN service'), [
					kv([
						[ _('Installed'), yesNo(caps.dawn) ],
						[ _('State'), stateBadge(caps.dawn, caps.dawn_running) ],
						[ _('Managed by WiFi Manager'), yesNo(caps.dawn_managed) ],
						[ _('Watchdog enabled'), yesNo(caps.dawn_watchdog) ],
						[ _('Restarts since start'), caps.dawn_restarts != null ? String(caps.dawn_restarts) : '-' ],
						[ _('Consecutive watchdog failures'), caps.dawn_watchdog_failures != null ? String(caps.dawn_watchdog_failures) : '0' ],
						[ _('Steering mode'), params.kicking != null
							? String(params.kicking) : '-' ],
						[ _('Steering RSSI difference'), params.kicking_threshold != null
							? '%s dB'.format(params.kicking_threshold) : '-' ],
						[ _('Minimum clients'), params.min_clients != null ? String(params.min_clients) : '-' ],
						[ _('Evaluation interval'), params.duration != null
							? _('%s seconds').format(params.duration) : '-' ]
					])
				], { description: _('The service state is read from init.d; the parameters are the values the managed DAWN configuration holds. DAWN is managed only while mesh networking and 802.11k or 802.11v are enabled.') }),
				card(_('802.11k/v/r status'), [
					kv([
						[ _('802.11k configured'), yesNo(caps.k, _('Enabled'), _('Disabled')) ],
						[ _('802.11v configured'), yesNo(caps.v, _('Enabled'), _('Disabled')) ],
						[ _('802.11r configured'), yesNo(caps.ft, _('Enabled'), _('Disabled')) ],
						[ _('802.11v support in wpad'), yesNo(caps.wnm, _('Available'), _('Unavailable')) ]
					]),
					table([
						{ label: _('Section') },
						{ label: _('SSID') },
						{ label: _('Interface') },
						{ label: _('Runtime state') },
						{ label: _('802.11k') },
						{ label: _('802.11v') },
						{ label: _('802.11r') },
						{ label: _('Mobility domain') }
					], interfaceRows, { empty: _('No access point is configured.') }),
					!caps.wnm && caps.v
						? alert('warn', _('802.11v is enabled but this wpad build cannot send BSS transition requests. The radio flags are written, yet no steering request reaches the client.'))
						: ''
				], { description: _('The flags are the values stored in /etc/config/wireless for each AP section. hostapd reads them at start, so a change takes effect after Wi-Fi is reloaded.') }),
				card(_('Recent roaming events'), [
					table([
						{ label: _('Time') },
						{ label: _('Event') },
						{ label: _('Detail'), className: 'wm-wrap' }
					], eventRows, { empty: _('No roaming event has been recorded yet.') }),
					widgets.list([
						adminLink('admin/network/wifimanager/roaming/events', _('All roaming events'))
					])
				], { description: _('The sampler compares the station table every 15 seconds. A join and a leave between two samples are not visible, and disconnect duration, reconnect duration and packet loss are recorded as unavailable.') }),
				card(_('DAWN log'), [
					logBlock(log),
					widgets.list([
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Open the log viewer'))
					])
				], { description: _('The last 80 lines that syslog carries for the dawn service.') }),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/roaming/settings', _('Roaming settings')),
						adminLink('admin/network/wifimanager/roaming/dawn', _('DAWN status')),
						adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics')),
						adminLink('admin/network/wifimanager/diagnostics/wireless', _('Wireless diagnostics'))
					])
				])
			]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
