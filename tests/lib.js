'use strict';

/*
 * Minimal test harness for a LuCI package.
 *
 * The views and utils are LuCI modules, not CommonJS modules: they declare
 * dependencies with leading 'require ...' lines and end with a top-level
 * return.  loadModule() turns one such file into a function, supplies the
 * small set of globals the pure utils need, and returns the exported object.
 * Nothing here boots LuCI itself; the tests cover the logic and the source
 * contracts (menu, ACL, RPC, scopes, packaging) that can be checked on a
 * development machine.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
const moduleCache = {};

function test(name, fn) {
	tests.push({ name: name, fn: fn });
}

function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
	return fs.existsSync(path.join(ROOT, rel));
}

function listFiles(rel, suffix) {
	const base = path.join(ROOT, rel);
	const out = [];

	if (!fs.existsSync(base))
		return out;

	for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
		const full = path.join(base, entry.name);

		if (entry.isDirectory())
			out.push.apply(out, listFiles(path.relative(ROOT, full), suffix));
		else if (!suffix || full.endsWith(suffix))
			out.push(path.relative(ROOT, full));
	}

	return out.sort();
}

function json(rel) {
	return JSON.parse(read(rel));
}

function menu() {
	return json('root/usr/share/luci/menu.d/luci-app-wifimanager.json');
}

function acl() {
	const merged = {};

	for (const file of listFiles('root/usr/share/rpcd/acl.d', '.json')) {
		if (!/\/luci-app-wifimanager[^/]*\.json$/.test(file))
			continue;

		const scopes = json(file);

		for (const name of Object.keys(scopes))
			merged[name] = scopes[name];
	}

	return merged;
}

function fail(message) {
	throw new Error(message);
}

function ok(condition, message) {
	if (!condition)
		fail(message || 'Expected a truthy value');
}

function equal(actual, expected, message) {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		fail((message || 'Values differ') + ': expected ' + JSON.stringify(expected) +
			', got ' + JSON.stringify(actual));
}

function deepEqual(actual, expected, message) {
	equal(actual, expected, message);
}

function includes(text, needle, message) {
	if (String(text).indexOf(needle) === -1)
		fail((message || 'Missing text') + ': ' + needle);
}

function notIncludes(text, needle, message) {
	if (String(text).indexOf(needle) !== -1)
		fail((message || 'Unexpected text') + ': ' + needle);
}

function match(text, regexp, message) {
	if (!regexp.test(String(text)))
		fail((message || 'Text does not match') + ': ' + regexp);
}

function notMatch(text, regexp, message) {
	if (regexp.test(String(text)))
		fail((message || 'Text unexpectedly matches') + ': ' + regexp);
}

const FORMAT_POLYFILL = [
	'if (!String.prototype.format) {',
	'  String.prototype.format = function() {',
	'    var args = Array.prototype.slice.call(arguments);',
	'    var index = 0;',
	'    return this.replace(/%(-?\\d*(?:\\.\\d+)?)([dsf%])/g, function(all, spec, type) {',
	'      if (type === "%") return "%";',
	'      var value = args[index++];',
	'      if (type === "d") return String(parseInt(value, 10));',
	'      if (type === "f") {',
	'        var digits = spec.indexOf(".") !== -1 ? Number(spec.split(".")[1]) : 0;',
	'        return Number(value).toFixed(digits);',
	'      }',
	'      return value == null ? "" : String(value);',
	'    });',
	'  };',
	'}'
].join('\n');

function loadModule(rel, overrides) {
	const key = rel + '|' + JSON.stringify(Object.keys(overrides || {}));

	if (moduleCache[key])
		return moduleCache[key];

	const source = read(rel);
	const lines = source.split('\n').map(function(line) {
		const requireMatch = /^'require ([^']+?)(?: as (\w+))?';$/.exec(line.trim());

		if (!requireMatch)
			return line;

		const spec = requireMatch[1];
		const alias = requireMatch[2] || spec.split('.').pop();

		return 'const ' + alias + ' = __require(' + JSON.stringify(spec) + ');';
	});

	const sandbox = {
		console: console,
		__require: function(spec) {
			if (overrides && Object.prototype.hasOwnProperty.call(overrides, spec))
				return overrides[spec];

			if (spec === 'baseclass')
				return { extend: function(props) { return props; } };

			if (spec === 'wifimanager.utils.validation')
				return loadModule('htdocs/luci-static/resources/wifimanager/utils/validation.js', overrides);

			if (spec === 'wifimanager.utils.backup')
				return loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js', overrides);

			if (spec.indexOf('wifimanager.utils.') === 0) {
				const name = spec.split('.').pop();

				return loadModule('htdocs/luci-static/resources/wifimanager/utils/' + name + '.js', overrides);
			}

			return {};
		},
		_: function(text) { return text; },
		L: {
			resource: function(pathname) { return '/luci-static/resources/' + pathname; },
			url: function(pathname) { return '/cgi-bin/luci/' + pathname; }
		},
		E: function(tag) { return { tag: tag, children: Array.prototype.slice.call(arguments, 1) }; },
		ui: {},
		document: { visibilityState: 'visible', getElementById: function() { return null; } },
		window: { setTimeout: setTimeout, clearTimeout: clearTimeout }
	};

	vm.createContext(sandbox);
	vm.runInContext(FORMAT_POLYFILL, sandbox);

	const wrapped = '(function() {\n' + lines.join('\n') + '\n})()';
	const result = vm.runInContext(wrapped, sandbox, { filename: rel });

	moduleCache[key] = result;

	return result;
}

function command(command, args, options) {
	return childProcess.spawnSync(command, args, Object.assign({
		cwd: ROOT,
		encoding: 'utf8'
	}, options || {}));
}

async function run() {
	let passed = 0;
	const failures = [];

	for (const entry of tests) {
		try {
			await entry.fn();
			passed++;
			process.stdout.write('  ok   ' + entry.name + '\n');
		}
		catch (err) {
			failures.push({ name: entry.name, error: err });
			process.stdout.write('  FAIL ' + entry.name + '\n');
			process.stdout.write('       ' + (err && err.stack ? err.stack.split('\n')[0] : String(err)) + '\n');
		}
	}

	process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');

	if (failures.length) {
		process.stdout.write('\nFailures:\n');

		for (const failure of failures) {
			process.stdout.write('\n* ' + failure.name + '\n');
			process.stdout.write((failure.error && failure.error.stack ? failure.error.stack : String(failure.error)) + '\n');
		}
	}

	return failures.length === 0;
}

module.exports = {
	ROOT: ROOT,
	test: test,
	run: run,
	read: read,
	exists: exists,
	listFiles: listFiles,
	json: json,
	menu: menu,
	acl: acl,
	loadModule: loadModule,
	command: command,
	ok: ok,
	equal: equal,
	deepEqual: deepEqual,
	includes: includes,
	notIncludes: notIncludes,
	match: match,
	notMatch: notMatch
};
