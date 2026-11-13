'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { test, ok, equal, includes, notIncludes } = lib;

const MESH_UTIL = 'htdocs/luci-static/resources/wifimanager/utils/mesh.js';
const MESH_BACKEND = 'root/usr/lib/wifimanager/mesh.sh';
const COMMON = 'root/usr/lib/wifimanager/common.sh';

test('mesh: the managed radio is apRadio, with mesh_radio as the legacy fallback', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-mesh-radio-'));
	const bin = path.join(dir, 'bin');
	const driver = path.join(dir, 'driver.sh');
	const modules = path.join(dir, 'modules.sh');
	const source = lib.read(COMMON);
	const helper = source.slice(source.indexOf('mesh_managed_radio()'),
		source.indexOf('ft_over_ds_value()'));

	includes(helper, 'uci -q get meshassistant.config.apRadio');
	includes(helper, 'uci -q get meshassistant.config.mesh_radio');
	includes(helper, '${radio%% *}');

	// The views and checks that need one radio must not read the stale key.
	for (const file of [ 'root/usr/lib/wifimanager/diagnostics.sh',
		'root/usr/lib/wifimanager/radio.sh' ])
		lib.notMatch(lib.read(file), /uci[^\n]*meshassistant\.config\.mesh_radio/);

	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, 'uci'), [
		'#!/bin/sh',
		'[ "$1" = "-q" ] && shift',
		'[ "$1" = "get" ] || exit 1',
		'case "$2" in',
		'  meshassistant.config.apRadio) [ -n "$FAKE_AP" ] && printf \'%s\\n\' "$FAKE_AP" ;;',
		'  meshassistant.config.mesh_radio) [ -n "$FAKE_MESH" ] && printf \'%s\\n\' "$FAKE_MESH" ;;',
		'  *) exit 1 ;;',
		'esac',
		'exit 0',
		''
	].join('\n'));
	fs.chmodSync(path.join(bin, 'uci'), 0o755);
	fs.writeFileSync(modules, source.split('\n').filter(function(line) {
		return line.indexOf('. /usr/') !== 0;
	}).join('\n'));
	fs.writeFileSync(driver, '#!/bin/sh\n. "$1"\nmesh_managed_radio\n');

	const run = function(ap, legacy) {
		const env = Object.assign({}, process.env, {
			PATH: bin + ':' + process.env.PATH,
			FAKE_AP: ap,
			FAKE_MESH: legacy
		});
		return lib.command('sh', [ driver, modules ], { env: env });
	};

	try {
		let result = run('radio1', 'radio0');
		equal(result.status, 0, result.stderr);
		equal(result.stdout.trim(), 'radio1', 'apRadio wins');

		result = run('', 'radio0');
		equal(result.stdout.trim(), 'radio0', 'mesh_radio is honoured when apRadio is unset');

		result = run('radio1 radio2', '');
		equal(result.stdout.trim(), 'radio1', 'a multi-radio list reduces to its first entry');

		result = run('', '');
		equal(result.stdout.trim(), '', 'no configured radio prints nothing');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('mesh: a failed apply restores the pre-apply configuration', function() {
	const source = lib.read(MESH_BACKEND);
	const apply = source.slice(source.indexOf('mesh_apply()'), source.indexOf('mesh_op_disable()'));
	const snap = apply.indexOf('mesh_apply_snapshot "$snap"');
	const config = apply.indexOf('if ! mesh_apply_config; then');
	const rollback = apply.indexOf('mesh_apply_rollback "$snap"');

	includes(source, 'mesh_apply_snapshot() {');
	includes(source, 'mesh_apply_rollback() {');
	includes(source, 'uci -q revert "$cfg"');
	includes(source, 'restore_rollback "$snap"');
	includes(apply, 'snap=$(mktemp -d /tmp/wifimanager-mesh.XXXXXX');
	ok(snap !== -1 && config !== -1 && rollback !== -1);
	ok(snap < config && config < rollback, 'order: snapshot < apply < rollback');
	includes(apply, 'the previous configuration was restored.');
	includes(apply, 'wm_event mesh-apply result failed rolled_back 1 backup "$backup_id"');
	includes(apply, 'Unable to create the pre-apply snapshot; no configuration was changed.');
});

test('mesh: peer announcements are parsed with their optional fields', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const entries = mesh.parsePeers(
		'1700000000 AA:BB:CC:DD:EE:FF 192.168.1.5 router 0.25 00:11:22:33:44:55 inuse wired 1000 br-lan\n' +
		'1700000001 00:11:22:33:44:66 - node1 - - - - - -\n');

	equal(entries.length, 2);
	equal(entries[0].mac, 'aa:bb:cc:dd:ee:ff');
	equal(entries[0].ip, '192.168.1.5');
	equal(entries[0].hostname, 'router');
	equal(entries[0].state, 'inuse');
	equal(entries[0].kind, 'wired');
	equal(entries[0].iface, 'br-lan');
	equal(entries[1].ip, '');
	equal(entries[1].load, '');
});

test('mesh: peer announcements older than the announced window are filtered', function() {
	const mesh = lib.loadModule(MESH_UTIL);

	const entries = mesh.parsePeers(
		'1000 aa:bb:cc:dd:ee:01 - host1\n' +
		'1100 aa:bb:cc:dd:ee:02 - host2\n', 50);

	equal(entries.length, 1);
	equal(entries[0].hostname, 'host2');
});

test('mesh: a silent announced device stays visible and is marked offline', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const topology = lib.loadModule(
		'htdocs/luci-static/resources/wifimanager/utils/topology.js');
	const peers =
		'2000 aa:bb:cc:dd:ee:01 192.168.1.1 router 0.1 00:11:22:33:44:55 inuse wired 1000 br-lan 10 1 wm 36 HE80 5g server BATMAN_V\n' +
		'1750 aa:bb:cc:dd:ee:02 192.168.1.2 node-b 0.2 00:11:22:33:44:66 inuse wlan 866.7 wlan0 20 2 wm 36 HE80 5g node BATMAN_V\n';
	const link = 'state active=1\n' +
		'local router 192.168.1.1 0.1 server\n' +
		'kind wlan0 wlan aa:bb:cc:dd:ee:01\n';
	const parsed = mesh.parseStatus('', peers, link, '');

	equal(parsed.rows.length, 1);
	equal(parsed.rows[0].neighbor, 'aa:bb:cc:dd:ee:02');
	equal(parsed.rows[0].announced, true);
	equal(parsed.rows[0].lastSeen, '250s');

	const monitor = topology.monitor({ rows: parsed.rows, configured: true });
	const stale = monitor.findings.filter(function(finding) {
		return finding.code === 'T-STALE-01';
	});

	equal(stale.length, 1);
	equal(stale[0].level, 'error');
	equal(monitor.summary.offline, 1);

	const dropped = mesh.parseStatus('',
		'2000 aa:bb:cc:dd:ee:01 192.168.1.1 router 0.1 00:11:22:33:44:55 inuse wired 1000 br-lan\n' +
		'1650 aa:bb:cc:dd:ee:02 192.168.1.2 node-b 0.2 00:11:22:33:44:66 inuse wlan 866.7 wlan0\n',
		link, '');

	equal(dropped.rows.length, 0, 'the cache window matches the daemon');
});

test('mesh: the neighbors view splits rows by origin, not by last seen', function() {
	const source = lib.read(
		'htdocs/luci-static/resources/view/wifimanager/mesh/neighbors.js');

	includes(source, 'return !row.announced');
	includes(source, 'return !!row.announced');
	notIncludes(source, '!!row.lastSeen',
		'an announced row now carries its own last-seen age');
});

test('mesh: neighbor and originator output is parsed', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const plain = mesh.parseNeighbors('wlan0 00:11:22:33:44:55 2.5s\n');
	const speed = mesh.parseNeighbors('00:11:22:33:44:55 1.2s ( 300.0) [ wlan0 ]\n');

	equal(plain.length, 1);
	equal(plain[0].iface, 'wlan0');
	equal(plain[0].neighbor, '00:11:22:33:44:55');
	equal(speed[0].neighbor, '00:11:22:33:44:55');
	equal(speed[0].speed, '300.0');
	equal(speed[0].iface, 'wlan0');

	const originators = mesh.parseOriginators(
		'* 00:58:28:12:81:54  0.070s ( 100000.0) 00:58:28:12:81:50 [ lan2]\n' +
		'  00:58:28:12:81:55  0.100s (  50000.0) 00:58:28:12:81:51 [ lan2]\n');

	equal(Object.keys(originators), [ '00:58:28:12:81:54' ]);
	equal(originators['00:58:28:12:81:54'].iface, 'lan2');
	equal(originators['00:58:28:12:81:54'].throughput, 100000);
});

test('mesh: link state and netmasks are validated', function() {
	const mesh = lib.loadModule(MESH_UTIL);

	equal(mesh.parseMeshState('state active=1\n'), true);
	equal(mesh.parseMeshState('state active=0\n'), false);
	equal(mesh.parseMeshState(''), null);

	equal(mesh.prefixToNetmask(24), '255.255.255.0');
	equal(mesh.prefixToNetmask(32), '255.255.255.255');
	equal(mesh.prefixToNetmask(0), '0.0.0.0');
	equal(mesh.prefixToNetmask(33), '');

	equal(mesh.netmask('255.255.255.0'), '255.255.255.0');
	equal(mesh.netmask('0.0.0.0'), '');
	equal(mesh.netmask('255.0.255.0'), '');
	equal(mesh.netmask('255.255.255.1'), '');
	equal(mesh.ipv4('192.168.1.1'), '192.168.1.1');
	equal(mesh.ipv4('255.255.255.255'), '255.255.255.255');
	equal(mesh.ipv4('256.1.1.1'), '');
	equal(mesh.ipv4('999.1.1.1'), '');
	equal(mesh.ipv4('192.168.1'), '');
});

test('mesh: the client role is explicitly not bridged into the LAN', function() {
	const source = lib.read(MESH_BACKEND);
	const client = source.slice(source.indexOf('client)'));

	includes(client, 'must not bridge');
	includes(client, 'apply_node_lan');
	notIncludes(client.slice(0, client.indexOf('esac')), 'bridge_add_port bat0');
});

test('mesh: roles are server, node and client with the gateway duties split', function() {
	const settings = lib.read('htdocs/luci-static/resources/view/wifimanager/mesh/settings.js');

	includes(settings, "o.value('server'");
	includes(settings, "o.value('node'");
	includes(settings, "o.value('client'");
	includes(settings, 'Server provides DHCP');
	includes(lib.read(MESH_BACKEND), 'server_dhcp');
	includes(lib.read(MESH_BACKEND), 'disable_service_recorded "$service"');
});

test('mesh: menu leaves for settings, topology, neighbors and backhaul exist', function() {
	const menu = lib.menu();

	for (const leaf of [ 'settings', 'topology', 'neighbors', 'backhaul' ]) {
		const key = 'admin/network/wifimanager/mesh/' + leaf;
		const entry = menu[key];

		ok(entry, key);
		equal(entry.action.type, 'view');
		ok(lib.exists('htdocs/luci-static/resources/view/' + entry.action.path + '.js'), key + ' view');
	}

	ok(!menu['admin/network/wifimanager/mesh/backup'], 'Backup must not live under Mesh');
});

test('mesh: version 9 announcements carry memory, clients and mesh parameters', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const line = '1700000000 aa:bb:cc:dd:ee:ff 192.168.1.5 router 0.25 ' +
		'00:11:22:33:44:55 inuse wlan 866.7 wlan0 42 17 My-Mesh 36 HE80 5g server BATMAN_V';

	const entries = mesh.parsePeers(line + '\n');

	equal(entries.length, 1);
	equal(entries[0].memory, 42);
	equal(entries[0].clients, 17);
	equal(entries[0].meshId, 'My-Mesh');
	equal(entries[0].channel, '36');
	equal(entries[0].htmode, 'HE80');
	equal(entries[0].band, '5g');
	equal(entries[0].role, 'server');
	equal(entries[0].routingAlgo, 'BATMAN_V');
});

test('mesh: invalid version 9 values are dropped instead of trusted', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const line = '1700000000 aa:bb:cc:dd:ee:ff 192.168.1.5 router 0.25 ' +
		'00:11:22:33:44:55 inuse wlan 866.7 wlan0 120 xx bad/mesh-id abc HE 80 7g boss BATMAN_VI';

	const entries = mesh.parsePeers(line + '\n');

	equal(entries[0].memory, null);
	equal(entries[0].clients, null);
	equal(entries[0].meshId, '');
	equal(entries[0].channel, '');
	equal(entries[0].htmode, 'HE');
	equal(entries[0].band, '');
	equal(entries[0].role, '');
	equal(entries[0].routingAlgo, '');
});

test('mesh: link info carries the radio and the station rates', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const links = mesh.parseLinkInfo(
		'radio wlan0 phy0\n' +
		'kind wlan0 wlan 00:11:22:33:44:55\n' +
		'iface wlan0 5180 36 80\n' +
		'peer wlan0 aa:bb:cc:dd:ee:ff -56 866.7 780.0\n');

	equal(links.wlan0.radio, 'phy0');
	equal(links.wlan0.kind, 'wlan');
	equal(links.wlan0.signals['aa:bb:cc:dd:ee:ff'], -56);
	equal(links.wlan0.rates['aa:bb:cc:dd:ee:ff'].tx, '866.7');
	equal(links.wlan0.rates['aa:bb:cc:dd:ee:ff'].rx, '780.0');

	const wired = mesh.parseLinkInfo('radio br-lan -\nkind br-lan wired\n');

	equal(wired['br-lan'].radio, undefined);
});

test('mesh: the local row carries its radio and the rates of its best neighbour', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const link = 'state active=1\n' +
		'local router 192.168.1.1 0.1 server 42 17 My-Mesh 36 HE80 5g BATMAN_V\n' +
		'kind wlan0 wlan 00:11:22:33:44:55\n' +
		'radio wlan0 phy0\n' +
		'iface wlan0 5180 36 80\n' +
		'peer wlan0 aa:bb:cc:dd:ee:ff -56 866.7 780.0\n';
	const rows = [ {
		iface: 'wlan0',
		neighbor: 'aa:bb:cc:dd:ee:ff',
		signal: '-56 dBm',
		speed: '866.7',
		lastSeen: '1.0s'
	} ];
	const local = mesh.parseLocalRows('MainIF/MAC: wlan0/00:11:22:33:44:55', link, rows, {});

	equal(local.length, 1);
	equal(local[0].radio, 'phy0');
	equal(local[0].txRate, '866.7');
	equal(local[0].rxRate, '780.0');
	equal(local[0].memory, 42);
	equal(local[0].clients, 17);
});

test('mesh: consistency findings compare only announced values', function() {
	const mesh = lib.loadModule(MESH_UTIL);
	const rows = [
		{ hostname: 'router-a', meshId: 'My-Mesh', peerRole: 'server',
		  routingAlgo: 'BATMAN_V', channel: '36', htmode: 'HE80', band: '5g' },
		{ hostname: 'router-b', meshId: 'My-Mesh', peerRole: 'server',
		  routingAlgo: 'BATMAN_V', channel: '40', htmode: 'HE80', band: '5g' },
		{ hostname: 'router-old' }
	];
	const result = mesh.consistencyFindings(rows, {
		hostname: 'router-a', meshId: 'My-Mesh', role: 'server',
		routingAlgo: 'BATMAN_V', channel: '36', htmode: 'HE80', band: '5g'
	});
	const codes = result.findings.map(function(finding) { return finding.code; });

	ok(codes.indexOf('channel') !== -1, 'channel drift is reported');
	ok(codes.indexOf('role-multiple') !== -1, 'two servers are reported');
	ok(codes.indexOf('not-announced') !== -1, 'an older peer is listed, not failed');
	ok(codes.indexOf('mesh-id') === -1, 'equal mesh IDs are not a finding');
	ok(codes.indexOf('routing-algo') === -1, 'equal algorithms are not a finding');

	const mismatch = mesh.consistencyFindings([
		{ hostname: 'router-b', meshId: 'Other-Mesh', peerRole: 'node',
		  routingAlgo: 'BATMAN_IV' }
	], { hostname: 'router-a', meshId: 'My-Mesh', role: 'server',
		routingAlgo: 'BATMAN_V' });
	const mismatchCodes = mismatch.findings.map(function(finding) { return finding.code; });

	ok(mismatchCodes.indexOf('mesh-id') !== -1, 'different mesh IDs are an error');
	ok(mismatchCodes.indexOf('routing-algo') !== -1, 'different algorithms are an error');
});

test('mesh: version 9 announcements are sent with validated trailing fields', function() {
	const source = lib.read('root/usr/lib/wifimanager/peer.sh');

	includes(source, "printf 'meshassistant/9 %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s\\n'");
	includes(source, 'mesh_hardif_radio()');
	includes(source, 'mesh_hardif_radio_facts()');
	includes(source, 'local_memory()');
	includes(source, 'local_client_count()');
	includes(source, 'local_mesh_id()');
	includes(source, 'local_routing_algo()');
	includes(source, 'meshassistant/9)');
	includes(source, '[ "$count" -ge 17 ] || continue');
	includes(source, "if [ \"$memory\" != '-' ] && [ \"$memory\" -gt 100 ]");
	includes(source, 'BATMAN_IV|BATMAN_V');
});

test('mesh: diagnostics report the radio, rates and backhaul state', function() {
	const source = lib.read('root/usr/lib/wifimanager/diagnostics.sh');
	const link = source.slice(source.indexOf('link_info()'), source.indexOf('station_lines()'));
	const mesh = source.slice(source.indexOf('diag_mesh_json()'), source.indexOf('diag_roaming_json()'));

	includes(link, "printf 'radio %s %s\\n' \"$iface\" \"$radio\"");
	includes(link, 'print "peer " iface " " mac " " sig " " tx " " rx');
	includes(mesh, 'json_add_object backhaul');
	includes(mesh, 'backhaul_state_load');
	includes(mesh, 'backhaul_carrier_state');
	includes(mesh, 'backhaul_wireless_healthy');
	includes(mesh, 'last_switch');
});

test('mesh: the topology page shows MAC, role, CPU load and channel per device', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/mesh/topology.js');

	includes(view, "card(_('Nodes')");
	includes(view, "{ label: _('MAC address') }");
	includes(view, "{ label: _('Node role') }");
	includes(view, "{ label: _('CPU load') }");
	includes(view, "{ label: _('WiFi channel') }");
	includes(view, "{ label: _('Link status') }");
	includes(view, "nodeValue(group, 'lanMac') || nodeValue(group, 'neighbor')");
	includes(view, "roleName(nodeValue(group, 'peerRole'))");
	includes(view, 'groupLoad(group)');
	includes(view, 'groupChannel(group)');
	// The local device shows the same fields as a peer.
	includes(view, "bat0.mac ? format.mac(bat0.mac) : '-'");
	includes(view, "localInfo && localInfo.channel");
	includes(view, "localInfo && localInfo.load");
});

test('mesh: the topology page shows the node state and weak/offline markers', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/mesh/topology.js');

	includes(view, "{ label: _('Node state') }");
	includes(view, 'nodeStateBadge(groupNodeState(group))');
	includes(view, "'class': 'wm-topo-node wm-topo-node-' + kind + ' wm-topo-node-state-' + nodeState");
	includes(view, 'topology.stateName(nodeState)');
	includes(view, 'topology.classifyState(seen, mediaOf(group), signal)');
	includes(view, "badge(_('Weak signal'), 'warn')");
	includes(view, "badge(_('Offline'), 'error')");
});

test('mesh: the topology node table is built from announced values, not guessed ones', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/mesh/topology.js');
	const nodeValue = view.slice(view.indexOf('function nodeValue'),
		view.indexOf('function roleName'));

	includes(nodeValue, "row[key] != null && row[key] !== ''");
	includes(view, 'a value an older announcement does not carry stays empty instead of being guessed');
	includes(view, "case 'off': return _('Mesh disabled');");
});

test('mesh: the topology graph follows the originator table instead of capping nodes', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/mesh/topology.js');

	includes(view, 'function topologyEdges(rows, originators)');
	includes(view, 'if (!row.announced && key)');
	includes(view, 'macToKey[entry.nexthop]');
	includes(view, "addEdge('local', mesh.deviceKey(row), row.backhaul || '')");
	includes(view, 'if (!directKeys[target])');
	includes(view, 'topologyGraph(localLabel, current.groups, parsed.rows, parsed.originators)');
	includes(view, "'class': 'wm-topo-line wm-topo-line-' + mediumOfEdge(edge)");
	notIncludes(view, 'first 8 devices');
});

test('mesh: version 10 announcements add key state and encryption, and consistency compares them', function() {
	const source = lib.read('root/usr/lib/wifimanager/peer.sh');
	const common = lib.read('root/usr/lib/wifimanager/common.sh');

	includes(source, "printf 'meshassistant/10 %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s\\n'");
	includes(common, 'local_mesh_key_state() {');
	includes(common, 'local_mesh_encryption() {');
	includes(source, 'meshassistant/10)');
	includes(source, 'key_state=$(local_mesh_key_state)');
	includes(source, 'mesh_enc=$(local_mesh_encryption)');

	const mesh = lib.loadModule(MESH_UTIL);
	const result = mesh.consistencyFindings([
		{ hostname: 'router-b', keyState: 'set', meshEnc: 'sae' },
		{ hostname: 'router-c', keyState: 'unset', meshEnc: 'sae' },
		{ hostname: 'router-d', keyState: 'set', meshEnc: 'none' }
	], { hostname: 'router-a', keyState: 'set', meshEnc: 'sae' });
	const codes = result.findings.map(function(finding) { return finding.code; });

	ok(codes.indexOf('key-state') !== -1, 'different key state is reported');
	ok(codes.indexOf('encryption') !== -1, 'different encryption is reported');
});
