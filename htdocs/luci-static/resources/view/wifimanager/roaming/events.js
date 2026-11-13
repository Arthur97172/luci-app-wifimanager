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
const adminLink = widgets.adminLink;
const kv = widgets.kv;

const EVENT_KINDS = {
	'client-join': 'ok',
	'client-leave': 'muted',
	'roam': 'info',
	'link-up': 'ok',
	'link-down': 'error',
	'batman-error': 'error',
	'backhaul-switch': 'info',
	'backhaul-switch-failed': 'error',
	'dawn-restart': 'warn'
};

function eventLabel(name) {
	switch (name) {
	case 'client-join': return _('Client joined');
	case 'client-leave': return _('Client left');
	case 'roam': return _('Client roamed');
	case 'link-up': return _('Mesh link up');
	case 'link-down': return _('Mesh link down');
	case 'batman-error': return _('batman-adv error');
	case 'backhaul-switch': return _('Backhaul switched');
	case 'backhaul-switch-failed': return _('Backhaul switch failed');
	case 'dawn-restart': return _('DAWN watchdog restart');
	default: return name || '-';
	}
}

function eventBadge(name) {
	return badge(eventLabel(name), EVENT_KINDS[name] || 'muted');
}

/*
 * Signal and timing fields come from the sampler, which runs every 15 seconds.
 * A value the event does not carry is shown as "Unavailable" instead of a
 * dash or a made-up zero, so a missing measurement is never mistaken for a
 * measured one (DESIGN §8.5).
 */
const FIELD_LABELS = {
	mac: function() { return _('Client MAC'); },
	iface: function() { return _('AP interface'); },
	ssid: function() { return _('SSID / mesh ID'); },
	bssid: function() { return _('BSSID'); },
	from_iface: function() { return _('Source AP'); },
	to_iface: function() { return _('Destination AP'); },
	from_ssid: function() { return _('Source SSID'); },
	to_ssid: function() { return _('Destination SSID'); },
	from_bssid: function() { return _('Source BSSID'); },
	to_bssid: function() { return _('Destination BSSID'); },
	signal: function() { return _('RSSI'); },
	from_signal: function() { return _('Source RSSI'); },
	to_signal: function() { return _('Destination RSSI'); },
	disconnect_time: function() { return _('Disconnect time'); },
	reconnect_time: function() { return _('Reconnect time'); },
	packet_loss: function() { return _('Packet loss'); },
	attempt: function() { return _('Attempt'); },
	result: function() { return _('Result'); },
	message: function() { return _('Message'); }
};

const CLIENT_FIELDS = {
	'client-join': [ 'mac', 'iface', 'ssid', 'bssid', 'to_signal',
		'disconnect_time', 'reconnect_time', 'packet_loss' ],
	'client-leave': [ 'mac', 'iface', 'ssid', 'bssid', 'from_signal',
		'disconnect_time', 'reconnect_time', 'packet_loss' ],
	'roam': [ 'mac', 'from_iface', 'to_iface', 'from_ssid', 'to_ssid',
		'from_bssid', 'to_bssid', 'from_signal', 'to_signal',
		'disconnect_time', 'reconnect_time', 'packet_loss' ]
};

function isUnavailable(value) {
	return value == null || value === '' || value === '-' || value === 'unavailable';
}

function fieldText(value) {
	return isUnavailable(value) ? _('Unavailable') : String(value);
}

function signalText(value) {
	return isUnavailable(value) ? _('signal unknown') : format.signal(value);
}

function clientValue(event, key) {
	const value = event[key];

	/* Events written before the split signal field only carry "signal". */
	if (key === 'to_signal' && isUnavailable(value))
		return event.signal;
	if (key === 'from_signal' && isUnavailable(value))
		return event.signal;

	return value;
}

function describe(event) {
	switch (event.event) {
	case 'client-join':
		return '%s · %s · %s'.format(
			format.mac(event.mac), fieldText(event.iface),
			signalText(clientValue(event, 'to_signal')));
	case 'client-leave':
		return '%s · %s · %s'.format(
			format.mac(event.mac), fieldText(event.iface),
			signalText(clientValue(event, 'from_signal')));
	case 'roam':
		return '%s · %s (%s) → %s (%s)'.format(
			format.mac(event.mac),
			fieldText(event.from_iface), signalText(event.from_signal),
			fieldText(event.to_iface), signalText(event.to_signal));
	case 'link-up':
	case 'link-down':
		return fieldText(event.iface);
	case 'batman-error':
		return event.message || _('batctl could not query bat0');
	case 'backhaul-switch':
		return '%s → %s · %s'.format(fieldText(event.from), fieldText(event.to),
			fieldText(event.reason));
	case 'backhaul-switch-failed':
		return '%s → %s · %s'.format(fieldText(event.from), fieldText(event.to),
			event.error || fieldText(event.reason));
	case 'dawn-restart':
		return '%s · %s'.format(
			fieldText(event.result),
			event.attempt != null ? _('attempt %s').format(event.attempt) : '');
	default:
		return Object.keys(event).filter(function(key) {
			return key !== 'ts' && key !== 'event';
		}).map(function(key) {
			return key + '=' + fieldText(event[key]);
		}).join(' · ') || '-';
	}
}

function labelFor(key) {
	return FIELD_LABELS[key] ? FIELD_LABELS[key]() : key;
}

function detailPairs(event) {
	const skip = { ts: true, event: true };
	const known = CLIENT_FIELDS[event.event];
	const pairs = [];
	const used = {};

	if (known) {
		for (const key of known) {
			used[key] = true;
			pairs.push([ labelFor(key), fieldText(clientValue(event, key)) ]);
		}
	}

	for (const key of Object.keys(event)) {
		if (skip[key] || used[key])
			continue;

		pairs.push([ labelFor(key), fieldText(event[key]) ]);
	}

	return pairs;
}

function load(limit) {
	return rpc.meshEvents(limit).then(function(reply) {
		return {
			ok: !reply || reply.ok !== false,
			events: (reply && reply.events) || [],
			message: reply && reply.message
		};
	});
}

return view.extend({
	load: function() {
		return load(200).catch(function(err) {
			return { error: err };
		});
	},

	render: function(data) {
		if (!data || data.error)
			return widgets.page(_('Roaming events'), null,
				[ widgets.errorBox(data && data.error) ]);

		const content = E('div', {});
		let current = data;
		let limit = 200;
		let filter = 'all';

		const renderContent = function() {
			const events = current.events || [];
			const filtered = events.filter(function(event) {
				return filter === 'all' || event.event === filter;
			});

			const rows = filtered.map(function(event) {
				return [
					format.dateFromEpoch(event.ts),
					eventBadge(event.event),
					describe(event),
					E('details', {}, [
						E('summary', {}, [ _('Fields') ]),
						kv(detailPairs(event))
					])
				];
			});

			const kinds = [ { value: 'all', label: _('All events') } ];

			for (const name of Object.keys(EVENT_KINDS))
				kinds.push({ value: name, label: eventLabel(name) });

			dom.content(content, [
				!current.ok
					? alert('warn', current.message || _('The event log could not be read.'))
					: '',
				card(_('Event log'), [
					widgets.toolbar([
						E('select', {
							'class': 'cbi-input-select',
							'change': function(ev) {
								filter = ev.target.value;
								renderContent();
							}
						}, kinds.map(function(entry) {
							const option = E('option', { value: entry.value }, [ entry.label ]);

							if (entry.value === filter)
								option.selected = true;

							return option;
						})),
						E('span', { 'class': 'wm-grow' }),
						E('select', {
							'class': 'cbi-input-select',
							'change': function(ev) {
								limit = Number(ev.target.value) || 200;
								load(limit).then(function(next) {
									current = next;
									renderContent();
								});
							}
						}, [ 50, 100, 200, 500 ].map(function(value) {
							const option = E('option', { value: String(value) },
								[ _('Last %d events').format(value) ]);

							if (value === limit)
								option.selected = true;

							return option;
						})),
						widgets.button(_('Refresh'), function() {
							return load(limit).then(function(next) {
								current = next;
								renderContent();
							});
						})
					]),
					table([
						{ label: _('Time') },
						{ label: _('Event') },
						{ label: _('Detail'), className: 'wm-wrap' },
						{ label: _('Fields') }
					], rows, { empty: _('No event has been recorded yet.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('%d of %d recorded event(s) shown.').format(filtered.length, events.length)
					])
				], { description: _('Client joins, leaves and roams, mesh link state changes and batman-adv errors.') }),
				card(_('How events are collected'), [
					widgets.list([
						_('The station table and the mesh link state are sampled every 15 seconds, so a client that joins and leaves between two samples is not recorded.'),
						_('A roam is inferred when the same MAC is seen on a different BSS in the next sample; the exact transition time is unknown.'),
						_('For a roam, the source RSSI is the last value seen on the old BSS and the destination RSSI is the first value seen on the new one, up to 15 seconds apart.'),
						_('Disconnect duration, reconnect duration and packet loss are not observable from the station table, so those fields are recorded and shown as unavailable rather than estimated.'),
						_('A missing signal value is recorded as unknown instead of 0 dBm.'),
						_('Only the most recent events are kept on the router; the log is trimmed when it grows past its limit.')
					])
				]),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/roaming/settings', _('Roaming settings')),
						adminLink('admin/network/wifimanager/roaming/dawn', _('DAWN status')),
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return load(limit).then(function(next) {
				current = next;
				renderContent();
			});
		}, 30000);

		return widgets.page(_('Roaming events'),
			_('Recorded client and mesh link transitions with the gaps the sampler cannot see.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
