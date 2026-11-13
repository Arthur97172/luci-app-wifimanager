'use strict';

const lib = require('./lib');
const { test, ok, includes, notIncludes, match } = lib;

const BACKEND = 'root/usr/lib/wifimanager/network.sh';
const RPC = 'root/usr/libexec/rpcd/wifimanager';
const ACL = 'root/usr/share/rpcd/acl.d/luci-app-wifimanager.json';
const UTIL = 'htdocs/luci-static/resources/wifimanager/utils/network.js';
const OVERVIEW = 'htdocs/luci-static/resources/view/wifimanager/overview.js';
const SYSTEM = 'htdocs/luci-static/resources/view/wifimanager/diagnostics/system.js';

test('network: the checker covers DHCP, DNS, addressing, routing, firewall and mesh', function() {
	const source = lib.read(BACKEND);

	for (const code of [ 'N-DHCP-01', 'N-DHCP-02', 'N-DHCP-03', 'N-DHCP-04',
		'N-IP-01', 'N-IP-02', 'N-POOL-01', 'N-POOL-02', 'N-DNS-01', 'N-DNS-02',
		'N-BRIDGE-01', 'N-BRIDGE-02', 'N-ROUTE-01', 'N-FW-01', 'N-FW-02', 'N-FW-03',
		'N-MESH-01', 'N-MESH-02', 'N-MESH-03', 'N-MESH-04', 'N-MESH-05', 'N-MESH-06' ])
		includes(source, code);

	includes(source, 'network_check_json');
	includes(source, 'json_add_int errors');
	includes(source, 'json_add_int warnings');
	includes(source, 'server_dhcp');
	includes(source, 'service_enabled dnsmasq');
});

test('network: the checker is read-only', function() {
	const source = lib.read(BACKEND);

	notIncludes(source, 'wm_take_lock');
	notIncludes(source, 'wm_reload');
	lib.notMatch(source, /uci\s+(-q\s+)?(set|add|delete|commit|revert)\b/);
	lib.notMatch(source, /backup_create|backup_restore/);
	lib.notMatch(source, />\s*\/etc\//);
});

test('network: network_check is a read-only RPC granted to the view', function() {
	const rpcd = lib.read(RPC);
	const acl = lib.acl()['luci-app-wifimanager'];
	const rpc = lib.read('htdocs/luci-static/resources/wifimanager/utils/rpc.js');

	match(rpcd, /radio_check\|network_check/);
	match(rpcd, /channel_advice\|backup_list/);
	includes(rpc, "networkCheck: declare('network_check')");
	ok(acl.read.ubus.wifimanager.indexOf('network_check') !== -1, 'read grant');
	ok(acl.write.ubus.wifimanager.indexOf('network_check') === -1, 'no write grant');
});

test('network: LAN bridge detection covers the DSA device form', function() {
	const common = lib.read('root/usr/lib/wifimanager/common.sh');

	includes(common, 'network.$section.name');
	includes(common, 'a device section named after the bridge');
});

test('network: disabled interfaces and DHCP defaults are handled', function() {
	const source = lib.read(BACKEND);

	includes(source, 'network.$s.disabled');
	includes(source, '[ -n "$start" ] || start=100');
	includes(source, '[ -n "$limit" ] || limit=150');
	includes(source, 'active_dhcp=1');
	includes(source, '[ "$active_dhcp" = 1 ] && service_enabled dnsmasq');
});

test('network: DHCP pool bounds treat start and limit as subnet offsets', function() {
	const source = lib.read(BACKEND);

	includes(source, 'pool_start=$((base + start))');
	includes(source, 'nc_emit_findings "$pool_findings"');
	notIncludes(source, 'pool_start=$(nc_ip_int "$start")');
});

test('network: findings are labelled and shown on the overview and system pages', function() {
	const util = lib.read(UTIL);
	const overview = lib.read(OVERVIEW);
	const system = lib.read(SYSTEM);

	for (const code of [ 'N-DHCP-01', 'N-IP-01', 'N-DNS-01', 'N-BRIDGE-01',
		'N-FW-01', 'N-MESH-02' ])
		includes(util, "'" + code + "':");

	includes(util, 'Configuration-level checks');
	includes(util, 'Runtime reachability is not probed');
	includes(overview, "rpc.networkCheck()");
	includes(overview, 'network.findingsCard');
	includes(system, "rpc.networkCheck()");
	includes(system, 'diagnosis.diagnose');
	includes(system, 'network: networkReport');
});
