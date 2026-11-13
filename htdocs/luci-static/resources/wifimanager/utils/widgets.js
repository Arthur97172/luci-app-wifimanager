'use strict';
'require ui';
'require wifimanager.utils.rpc as wmRpc';

/*
 * Shared page furniture.  Every page uses these so a card, a status badge or
 * an operation message looks and behaves the same everywhere, and so the
 * operation polling exists in exactly one place.
 */

const STYLE_ID = 'wifimanager-style';
const STYLE_URL = L.resource('view/wifimanager/wifimanager.css');

function injectStyle() {
	if (document.getElementById(STYLE_ID))
		return;

	document.querySelector('head').appendChild(E('link', {
		'id': STYLE_ID,
		'rel': 'stylesheet',
		'type': 'text/css',
		'href': STYLE_URL
	}));
}

function page(title, subtitle, children) {
	injectStyle();

	const nodes = [
		E('h2', {}, [ title ])
	];

	if (subtitle)
		nodes.push(E('p', { 'class': 'wm-subtitle' }, [ subtitle ]));

	for (const child of (children || []))
		nodes.push(child);

	return E('div', { 'class': 'wm-page' }, nodes);
}

function card(title, children, options) {
	options = options || {};

	const nodes = [];

	if (title)
		nodes.push(E('h3', {}, [ title ]));

	if (options.description)
		nodes.push(E('p', { 'class': 'wm-muted' }, [ options.description ]));

	for (const child of (children || []))
		nodes.push(child);

	return E('div', {
		'class': 'cbi-section wm-card' + (options.className ? ' ' + options.className : ''),
		'id': options.id || null
	}, nodes);
}

function toolbar(children) {
	return E('div', { 'class': 'wm-toolbar' }, children);
}

/*
 * One labelled control in the CBI layout, for pages whose values are saved
 * through a dedicated RPC instead of a form.Map().
 */
function field(label, control, description) {
	const body = E('div', { 'class': 'cbi-value-field' }, [ control ]);

	if (description)
		body.appendChild(E('div', { 'class': 'cbi-value-description' }, [ description ]));

	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, [ label ]),
		body
	]);
}

function button(label, handler, kind) {
	return E('button', {
		'class': 'btn cbi-button cbi-button-' + (kind || 'action'),
		'click': ui.createHandlerFn(null, handler)
	}, [ label ]);
}

function badge(text, kind) {
	return E('span', { 'class': 'wm-badge wm-badge-' + (kind || 'muted') }, [ text ]);
}

function boolBadge(value, yes, no) {
	return value ? badge(yes || _('Yes'), 'ok') : badge(no || _('No'), 'muted');
}

function stateBadge(up) {
	return up ? badge(_('Up'), 'ok') : badge(_('Down'), 'error');
}

function alert(kind, text) {
	return E('div', { 'class': 'alert-message ' + (kind || 'info') }, [ text ]);
}

function loading(text) {
	return E('p', { 'class': 'wm-muted' }, [ text || _('Loading…') ]);
}

function empty(text) {
	return E('p', { 'class': 'wm-muted wm-empty' }, [ text || _('Nothing to show.') ]);
}

function errorBox(err) {
	const message = (err && err.message) || String(err || _('Unknown error'));

	return alert('error', _('Failed to load: %s').format(message));
}

/*
 * Columns are { label, key, render, className }.  A row may be an array that
 * matches the columns positionally or an object the columns read by key.
 */
function table(columns, rows, options) {
	options = options || {};

	const head = E('tr', {}, (columns || []).map(function(column) {
		return E('th', { 'class': column.className || null }, [ column.label ]);
	}));

	const body = [];

	for (const row of (rows || [])) {
		const cells = (columns || []).map(function(column, index) {
			if (column.render) {
				return E('td', { 'class': column.className || null }, [
					column.render(row, index)
				]);
			}

			const value = Array.isArray(row) ? row[index] : row[column.key];

			return E('td', { 'class': column.className || null }, [
				value == null || value === '' ? '-' : String(value)
			]);
		});

		body.push(E('tr', {}, cells));
	}

	if (body.length === 0)
		return empty(options.empty || _('No entries.'));

	return E('div', { 'class': 'wm-scroll' }, [
		E('table', { 'class': 'table wm-table' }, [
			E('thead', {}, [ head ]),
			E('tbody', {}, body)
		])
	]);
}

function kv(pairs) {
	const rows = [];

	for (const pair of (pairs || [])) {
		if (!pair)
			continue;

		rows.push(E('tr', {}, [
			E('th', {}, [ pair[0] ]),
			E('td', {}, [ pair[1] == null || pair[1] === '' ? '-' : pair[1] ])
		]));
	}

	return E('table', { 'class': 'table wm-kv' }, [ E('tbody', {}, rows) ]);
}

function list(items, ordered) {
	if (!items || items.length === 0)
		return empty();

	return E(ordered ? 'ol' : 'ul', { 'class': 'wm-list' },
		items.map(function(item) { return E('li', {}, [ item ]); }));
}

function link(path, text) {
	return E('a', { 'href': path }, [ text ]);
}

function adminLink(path, text) {
	return E('a', { 'href': L.url(path) }, [ text ]);
}

/*
 * Turn an RPC reply into a value or an Error.  The backend reports expected
 * failures as { ok: false, error, message }; a transport failure rejects
 * before this runs.
 */
function check(reply) {
	if (!reply)
		throw new Error(_('The router did not answer.'));

	if (reply.ok === false) {
		const err = new Error(reply.message || reply.error || _('The request failed.'));

		err.code = reply.error || '';
		throw err;
	}

	return reply;
}

function notify(kind, text) {
	ui.addNotification(null, E('p', {}, [ text ]), kind || 'info');
}

function confirm(title, message, confirmLabel, danger) {
	return new Promise(function(resolve) {
		const close = function(value) {
			ui.hideModal();
			resolve(value);
		};

		ui.showModal(title, [
			E('div', {}, message),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': function() { close(false); }
				}, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button ' +
						(danger ? 'cbi-button-negative' : 'cbi-button-action'),
					'click': function() { close(true); }
				}, [ confirmLabel || _('Continue') ])
			])
		]);
	});
}

function operationCard(op, options) {
	options = options || {};

	if (!op || op.state === 'idle' || !op.state)
		return card(options.title || _('Last operation'), [
			E('p', { 'class': 'wm-muted' }, [ _('No operation has run yet.') ])
		]);

	const kind = op.state === 'failed' ? 'error' :
		(op.state === 'done' ? 'ok' : 'info');

	const rows = [
		[ _('State'), badge(op.state, kind) ],
		[ _('Operation'), op.op || '-' ],
		[ _('Message'), op.message || '-' ],
		[ _('Started'), op.started ? new Date(op.started * 1000).toLocaleString() : '-' ]
	];

	if (op.verified)
		rows.push([ _('Verified'), boolBadge(op.verified === '1' || op.verified === 1 || op.verified === true) ]);

	return card(options.title || _('Last operation'), [ kv(rows) ]);
}

function sleep(ms) {
	return new Promise(function(resolve) { window.setTimeout(resolve, ms); });
}

/*
 * Wait for the background worker to leave queued/running.  A worker writes
 * its state before the RPC returns, so polling starts after a real operation
 * exists.  Timeout is a failure: the page must not claim success it did not
 * observe.
 */
function waitForOperation(timeoutMs) {
	const deadline = Date.now() + (timeoutMs || 180000);

	const poll = function() {
		return wmRpc.opStatus().then(function(reply) {
			const op = (reply && reply.operation) || { state: 'idle' };

			if (op.state === 'queued' || op.state === 'running') {
				if (Date.now() > deadline) {
					const err = new Error(_('The operation did not finish in time.'));

					err.code = 'E-TIMEOUT';
					throw err;
				}

				return sleep(1000).then(poll);
			}

			return op;
		});
	};

	return poll();
}

/*
 * Queue a worker and follow it to a terminal state.  The returned promise
 * resolves with the final operation object, or rejects with the worker's
 * message so the caller can show it.
 */
function runOperation(start, label) {
	return start().then(check).then(function() {
		notify('info', _('%s: operation queued.').format(label || _('Background')));

		return waitForOperation();
	}).then(function(op) {
		if (op.state === 'failed') {
			const err = new Error(op.message || _('The operation failed.'));

			err.code = 'E-OP';
			throw err;
		}

		notify('info', op.message || _('%s: operation finished.').format(label || _('Background')));

		return op;
	});
}

/*
 * Refresh on an interval, but only while the document is visible: a hidden
 * tab must not keep reading batctl or the station table.
 */
function autoRefresh(fn, intervalMs) {
	let busy = false;
	let timer = null;

	const tick = function() {
		if (document.visibilityState === 'hidden' || busy)
			return;

		busy = true;
		Promise.resolve().then(fn).catch(function() {
			/* The page keeps its last good view. */
		}).then(function() {
			busy = false;
		});
	};

	timer = window.setInterval(tick, intervalMs || 15000);

	const onVisible = function() {
		if (document.visibilityState !== 'hidden')
			tick();
	};

	const stop = function() {
		if (timer != null) {
			window.clearInterval(timer);
			timer = null;
		}

		document.removeEventListener('visibilitychange', onVisible);
	};

	document.addEventListener('visibilitychange', onVisible);
	window.addEventListener('pagehide', stop, { once: true });

	tick();

	return stop;
}

function refreshButton(fn) {
	return E('button', {
		'class': 'btn cbi-button',
		'click': ui.createHandlerFn(this, fn)
	}, [ _('Refresh') ]);
}

function spinner(text) {
	return E('p', { 'class': 'wm-loading' }, [
		E('span', { 'class': 'spinning' }, [ text || _('Loading…') ])
	]);
}

return {
	injectStyle: injectStyle,
	page: page,
	card: card,
	toolbar: toolbar,
	field: field,
	button: button,
	badge: badge,
	boolBadge: boolBadge,
	stateBadge: stateBadge,
	alert: alert,
	loading: loading,
	empty: empty,
	errorBox: errorBox,
	table: table,
	kv: kv,
	list: list,
	link: link,
	adminLink: adminLink,
	check: check,
	notify: notify,
	confirm: confirm,
	operationCard: operationCard,
	waitForOperation: waitForOperation,
	runOperation: runOperation,
	autoRefresh: autoRefresh,
	refreshButton: refreshButton,
	spinner: spinner
};
