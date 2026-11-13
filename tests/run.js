#!/usr/bin/env node
'use strict';

/*
 * WiFi Manager test runner.
 *
 *   ./tests/run.js              run every suite
 *   ./tests/run.js backup       run one suite (wifi, wireless, capabilities,
 *                               mlo, network, mesh, neighbors, backhaul,
 *                               roaming, diagnosis, backup, restore,
 *                               i18n, package)
 *
 * Suites are plain CommonJS files that register tests through tests/lib.js.
 * The runner needs only node and the standard shell tools (sh, msgfmt is not
 * required); no OpenWrt tree or LuCI installation is used.
 */

const path = require('path');
const lib = require('./lib');

const SUITES = [
	'wifi',
	'wireless',
	'capabilities',
	'mlo',
	'network',
	'mesh',
	'neighbors',
	'backhaul',
	'roaming',
	'diagnosis',
	'backup',
	'restore',
	'i18n',
	'package'
];

const requested = process.argv.slice(2).filter(function(arg) {
	return arg !== '--';
});

if (requested.length === 0) {
	for (const name of SUITES)
		require(path.join(__dirname, name + '.test.js'));
}
else {
	for (const name of requested) {
		const file = path.join(__dirname, name.replace(/\.test\.js$/, '') + '.test.js');

		if (SUITES.indexOf(name.replace(/\.test\.js$/, '')) === -1) {
			process.stderr.write('Unknown suite: ' + name + '\n');
			process.stderr.write('Available: ' + SUITES.join(', ') + '\n');
			process.exit(2);
		}
		require(file);
	}
}

lib.run().then(function(ok) {
	process.exit(ok ? 0 : 1);
}).catch(function(err) {
	process.stderr.write((err && err.stack) || String(err));
	process.exit(1);
});
