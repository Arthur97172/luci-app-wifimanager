'use strict';

/*
 * Small formatters shared by every page.  They never invent a value: a
 * missing measurement renders as a dash, so "unknown" never looks like zero.
 */

function number(value) {
	const n = Number(value);

	return Number.isFinite(n) ? n : null;
}

function dash(value) {
	return (value == null || value === '') ? '-' : String(value);
}

function bytesFromKb(kb) {
	const n = number(kb);

	if (n == null || n < 0)
		return '-';

	if (n < 1024)
		return '%d KiB'.format(n);

	const mb = n / 1024;

	if (mb < 1024)
		return '%.1f MiB'.format(mb);

	return '%.2f GiB'.format(mb / 1024);
}

function duration(seconds) {
	const n = number(seconds);

	if (n == null || n < 0)
		return '-';

	const s = Math.floor(n);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);

	if (d > 0)
		return _('%d d %d h').format(d, h);

	if (h > 0)
		return _('%d h %d min').format(h, m);

	if (m > 0)
		return _('%d min').format(m);

	return _('%d s').format(s % 60);
}

function signal(dbm) {
	const n = number(dbm);

	if (n == null)
		return '-';

	return '%d dBm'.format(Math.round(n));
}

function mhz(value) {
	const n = number(value);

	return n == null ? '-' : '%d MHz'.format(n);
}

function rate(mbps) {
	const n = number(mbps);

	if (n == null)
		return '-';

	if (n >= 1000)
		return '%.1f Gbit/s'.format(n / 1000);

	return '%d Mbit/s'.format(Math.round(n));
}

function percent(value) {
	const n = number(value);

	return n == null ? '-' : '%d%%'.format(Math.round(n));
}

/*
 * Manifest timestamps are written as local time with a numeric zone
 * ("2026-11-12T10:00:00+0800").  Date() cannot parse that spelling in every
 * browser, so the offset is inserted before the colon.  An unparsable value
 * is shown verbatim rather than as "Invalid Date".
 */
function date(value) {
	if (value == null || value === '')
		return '-';

	let text = String(value);
	const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)$/.exec(text);

	if (m)
		text = m[1] + m[2] + ':' + m[3];

	const d = new Date(text);

	if (isNaN(d.getTime()))
		return String(value);

	return d.toLocaleString();
}

function dateFromEpoch(seconds) {
	const n = number(seconds);

	if (n == null || n <= 0)
		return '-';

	return new Date(n * 1000).toLocaleString();
}

function mac(value) {
	const text = String(value == null ? '' : value).trim().toLowerCase();

	return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(text) ? text : dash(value);
}

/*
 * Config files and radio names come from UCI, not from a peer, but an
 * interface name can still contain markup-significant characters.  Every
 * string that reaches the DOM through E() is a text node, so this helper is
 * for places where a value is embedded in a larger label.
 */
function text(value) {
	return String(value == null ? '' : value);
}

return {
	number: number,
	dash: dash,
	bytesFromKb: bytesFromKb,
	duration: duration,
	signal: signal,
	mhz: mhz,
	rate: rate,
	percent: percent,
	date: date,
	dateFromEpoch: dateFromEpoch,
	mac: mac,
	text: text
};
