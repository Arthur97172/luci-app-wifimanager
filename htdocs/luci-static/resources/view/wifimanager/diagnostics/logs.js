'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';

const card = widgets.card;
const alert = widgets.alert;
const adminLink = widgets.adminLink;

const LOGS = [
	{ id: 'wifimanager', label: _('WiFi Manager log') },
	{ id: 'events', label: _('Mesh and roaming events') },
	{ id: 'dawn', label: _('DAWN (syslog entries)') },
	{ id: 'syslog', label: _('System log (syslog)') }
];

const LINE_COUNTS = [ 100, 200, 500, 1000 ];

function logLabel(id) {
	const entry = LOGS.find(function(item) { return item.id === id; });

	return entry ? entry.label : id;
}

function isMissing(reply) {
	return reply && reply.ok === false && String(reply.error || '').indexOf('NOTFOUND') !== -1;
}

function downloadText(name, text) {
	const blob = new Blob([ text ], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const anchor = E('a', { 'href': url, 'download': 'wifimanager-' + name + '.log' });

	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	window.setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
}

return view.extend({
	load: function() {
		return rpc.logs('wifimanager', 200).catch(function(err) {
			return { ok: false, message: err && err.message };
		});
	},

	render: function(first) {
		let name = 'wifimanager';
		let lineCount = 200;
		let current = first || {};
		let busy = false;

		const select = E('select', { 'class': 'cbi-input-select' },
			LOGS.map(function(entry) {
				return E('option', { value: entry.id }, [ entry.label ]);
			}));

		const linesSelect = E('select', { 'class': 'cbi-input-select' },
			LINE_COUNTS.map(function(count) {
				return E('option', { value: String(count) }, [ _('%d lines').format(count) ]);
			}));

		const content = E('div', {});

		const copyButton = widgets.button(_('Copy'), function() {
			const text = (current.lines || []).join('\n');

			if (!text) {
				widgets.notify('info', _('The log is empty.'));
				return;
			}

			if (!navigator.clipboard || !navigator.clipboard.writeText) {
				widgets.notify('warn', _('This browser does not allow copying from the page. Select the text and copy it manually.'));
				return;
			}

			navigator.clipboard.writeText(text)
				.then(function() {
					widgets.notify('info', _('Log copied to the clipboard.'));
				})
				.catch(function() {
					widgets.notify('error', _('The log could not be copied.'));
				});
		});

		const downloadButton = widgets.button(_('Download'), function() {
			const text = (current.lines || []).join('\n');

			if (!text) {
				widgets.notify('info', _('The log is empty.'));
				return;
			}

			downloadText(name, text);
		});

		const renderContent = function() {
			const lines = current.lines || [];
			const nodes = [];

			if (current.error) {
				nodes.push(alert('error', _('The log could not be read: %s').format(current.error)));
			}
			else if (isMissing(current)) {
				nodes.push(alert('info', _('This log file does not exist yet. It is created when the first entry is written.')));
			}
			else if (current.ok === false) {
				nodes.push(alert('error', current.message || _('The log could not be read.')));
			}
			else if (lines.length === 0) {
				nodes.push(widgets.empty(_('The log is empty.')));
			}
			else {
				nodes.push(E('pre', { 'class': 'wm-log' }, [ lines.join('\n') ]));
			}

			dom.content(content, [
				card(_('Log'), nodes, {
					description: _('%d line(s) from %s. Entries are shown exactly as written.')
						.format(lines.length, logLabel(name))
				})
			]);
		};

		const fetchLog = function() {
			if (busy)
				return Promise.resolve();

			busy = true;
			dom.content(content, [ widgets.loading(_('Reading the log…')) ]);

			return rpc.logs(name, lineCount).then(function(reply) {
				current = reply || {};
				busy = false;
				renderContent();
			}).catch(function(err) {
				current = { error: (err && err.message) || _('The request failed.') };
				busy = false;
				renderContent();
			});
		};

		select.addEventListener('change', function() {
			name = select.value;
			fetchLog();
		});

		linesSelect.addEventListener('change', function() {
			lineCount = Number(linesSelect.value) || 200;
			fetchLog();
		});

		select.value = name;
		linesSelect.value = String(lineCount);

		if (first && first.error)
			current = first;
		else if (first && first.ok === false)
			current = first;

		renderContent();

		widgets.autoRefresh(fetchLog, 15000);

		return widgets.page(_('Logs'),
			_('WiFi Manager operation log, mesh and roaming events, and the system log.'),
			[
				card(_('Source'), [
					widgets.toolbar([
						select,
						linesSelect,
						widgets.refreshButton(fetchLog),
						copyButton,
						downloadButton
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('The WiFi Manager log and the event log never contain archive passphrases. The system log includes entries from every daemon on the router.')
					])
				]),
				content,
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/diagnostics/wireless', _('Wireless diagnostics')),
						adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics')),
						adminLink('admin/network/wifimanager/diagnostics/system', _('System diagnostics')),
						adminLink('admin/network/wifimanager/roaming/events', _('Roaming events'))
					])
				])
			]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
