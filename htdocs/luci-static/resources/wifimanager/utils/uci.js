'use strict';
'require uci';

/*
 * Thin helpers over LuCI's uci class.  Forms read and write UCI themselves;
 * these exist for the read-only pages and for flags that may be absent on an
 * upgraded installation (an absent flag is not false, it is "not set yet").
 */

function listValues(value) {
	if (value == null)
		return [];

	if (Array.isArray(value))
		return value.filter(function(entry) { return entry !== ''; });

	return String(value).trim().split(/\s+/).filter(Boolean);
}

function getBool(packageName, section, option) {
	const value = uci.get(packageName, section, option);

	return value === '1' || value === 1 || value === true ||
		value === 'true' || value === 'yes' || value === 'on';
}

function getInt(packageName, section, option, fallback) {
	const value = Number(uci.get(packageName, section, option));

	return Number.isFinite(value) ? value : fallback;
}

function getList(packageName, section, option) {
	return listValues(uci.get(packageName, section, option));
}

function has(packageName, section, option) {
	return uci.get(packageName, section, option) != null;
}

/*
 * LuCI rejects — and caches the rejection — for a config file that does not
 * exist yet.  A fresh installation has no /etc/config/meshassistant, so the
 * forms would never render.  Replace the rejected load with the named section
 * the engine expects (meshassistant.config) and let the form create the file
 * on the first save.
 */
function ensureConfig(packageName) {
	return uci.load(packageName).catch(function() {
		delete uci.loaded[packageName];
		uci.state.values[packageName] = {};
		uci.add(packageName, packageName, 'config');
	});
}

return {
	listValues: listValues,
	getBool: getBool,
	getInt: getInt,
	getList: getList,
	has: has,
	ensureConfig: ensureConfig
};
