'use strict';
'require baseclass';

/*
 * Ranking for the automatic channel recommendation.
 *
 * channel_advice reports the candidates the driver accepts and a single scan
 * snapshot of the access points around the radio.  This module turns that
 * snapshot into a ranking.  It is a heuristic, not a survey: an empty scan is
 * reported as "no data", not as proof that the spectrum is free, and DFS
 * channels are marked because starting one needs a channel availability check.
 */

function freqOf(band, channel) {
	channel = Number(channel);

	if (!isFinite(channel))
		return null;

	if (band === '2g')
		return channel === 14 ? 2484 : 2407 + channel * 5;
	if (band === '6g')
		return 5950 + channel * 5;

	return 5000 + channel * 5;
}

function signalWeight(signal) {
	signal = Number(signal);

	if (!isFinite(signal))
		return 0;
	if (signal >= -50)
		return 4;
	if (signal >= -60)
		return 3;
	if (signal >= -70)
		return 2;

	return 1;
}

function overlapSpan(width) {
	width = Number(width);

	if (!isFinite(width) || width <= 0)
		width = 20;

	/* The candidate's half-width plus the 20 MHz width of a scanned cell. */
	return (width + 20) / 2;
}

function rank(reply) {
	reply = reply || {};

	const cells = reply.cells || [];
	const width = Number(reply.width) || 20;
	const span = overlapSpan(width);
	const current = reply.current_channel;
	const busy = Number(reply.current_busy) || 0;

	const candidates = (reply.candidates || []).filter(function(candidate) {
		return !reply.band || candidate.band === reply.band;
	}).map(function(candidate) {
		let interference = 0;
		let cochannel = 0;

		for (const cell of cells) {
			const distance = Math.abs(Number(cell.freq) - Number(candidate.freq));

			if (!isFinite(distance) || distance > span)
				continue;

			const weight = signalWeight(cell.signal);

			interference += weight;

			if (distance === 0)
				cochannel += weight;
		}

		let score = interference + cochannel + (candidate.dfs ? 2 : 0);

		if (current != null && String(candidate.channel) === String(current))
			score += busy / 10;

		return {
			channel: candidate.channel,
			freq: candidate.freq,
			band: candidate.band,
			dfs: !!candidate.dfs,
			score: score,
			interference: interference,
			cochannel: cochannel
		};
	});

	candidates.sort(function(a, b) {
		return (a.score - b.score) ||
			((a.dfs ? 1 : 0) - (b.dfs ? 1 : 0)) ||
			(a.channel - b.channel);
	});

	const best = candidates.length > 0 ? candidates[0] : null;

	return {
		width: width,
		cells: cells.length,
		hasData: cells.length > 0,
		current: current == null ? '' : String(current),
		busy: busy,
		candidates: candidates,
		best: best,
		keep: !!(best && current != null && String(best.channel) === String(current))
	};
}

return baseclass.extend({
	freqOf: freqOf,
	signalWeight: signalWeight,
	overlapSpan: overlapSpan,
	rank: rank
});
