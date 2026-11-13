'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { test, ok, equal, includes, notIncludes } = lib;

const VIEW = 'htdocs/luci-static/resources/view/wifimanager/mesh/backhaul.js';
const BACKEND = 'root/usr/lib/wifimanager/mesh.sh';
const SWITCH = 'root/usr/lib/wifimanager/backhaul.sh';
const COMMON = 'root/usr/lib/wifimanager/common.sh';
const DIAG = 'root/usr/lib/wifimanager/diagnostics.sh';

test('backhaul: Ethernet backhaul is applied as a batadv hardif', function() {
	const source = lib.read(BACKEND);

	includes(source, 'apply_wired_backhaul()');
	includes(source, 'proto=batadv_hardif');
	includes(source, 'master=bat0');
	includes(source, 'throughput_override');
});

test('backhaul: a wired port is never stolen from another bridge', function() {
	const source = lib.read(BACKEND);

	includes(source, 'wired_port_is_usable()');
	includes(source, 'must not be stolen');
	includes(source, 'type=\'bridge\'');
	includes(source, 'remove_wired_backhaul()');
});

test('backhaul: a WAN port can never become the wired backhaul', function() {
	const mesh = lib.read(BACKEND);
	const common = lib.read(COMMON);
	const diag = lib.read(DIAG);
	const view = lib.read(VIEW);

	includes(mesh, 'wired_port_is_wan()');
	includes(mesh, 'wired_port_is_wan "$port"');
	includes(mesh, 'carries the WAN uplink');
	includes(common, 'wan_network_devices()');
	includes(common, 'network_iface_devices()');
	includes(common, 'network.$iface.device');
	includes(common, 'network.$iface.ifname');
	includes(common, 'firewall_zone_section wan');
	includes(common, 'network.$section.type');
	includes(diag, 'json_add_array wan_devices');
	includes(view, 'system.wan_devices');
	includes(view, 'wanDevices.indexOf(currentPort)');
	includes(view, 'wanDevices.indexOf(value)');
	includes(view, 'The WAN uplink port cannot be used for the wired backhaul.');
	includes(view, 'carries the WAN uplink');
});

test('backhaul: removing the wired port from the LAN bridge is recorded for rollback', function() {
	const source = lib.read(BACKEND);

	includes(source, 'wired_backhaul_bridge_removed=1');
	includes(source, 'wired_backhaul_restore_port');
	includes(source, 'bridge_add_port "$port"');
});

test('backhaul: AP mode bridges WAN and disables WAN firewall/DHCP roles', function() {
	const source = lib.read(BACKEND);
	const dumbap = source.slice(source.indexOf('mesh_dumbap'), source.indexOf('mesh_undumbap'));

	includes(dumbap, 'bridge_add_port wan');
	includes(dumbap, 'dumbap_wan_bridged=1');
	includes(dumbap, 'dhcp.lan.ignore=1');
	includes(dumbap, 'uci -q del firewall.wan.network');
	includes(dumbap, 'wm_reload_wifi');
	includes(source, 'dumbap_wan_bridged');
});

test('backhaul: the view reports the medium and offers AP mode', function() {
	lib.ok(lib.exists(VIEW));

	const source = lib.read(VIEW);

	includes(source, 'rpc.meshStatus()');
	includes(source, "rpc.diagnostics('system')");
	includes(source, "form.Flag, 'wired_backhaul'");
	includes(source, 'rpc.meshDumbap');
	includes(source, 'rpc.meshUndumbap');
	includes(source, 'Ethernet');
	includes(source, 'Wireless');
});

test('backhaul: the backhaul menu leaf exists', function() {
	const entry = lib.menu()['admin/network/wifimanager/mesh/backhaul'];

	ok(entry, 'Mesh > Backhaul menu entry');
	equal(entry.action.type, 'view');
	equal(entry.action.path, 'wifimanager/mesh/backhaul');
});

test('backhaul: client role is not treated as a wired bridge', function() {
	const source = lib.read(BACKEND);
	const client = source.slice(source.indexOf('client)'), source.indexOf('esac', source.indexOf('client)')));

	notIncludes(client, 'bridge_add_port');
	includes(client, 'disable_service_recorded');
});

test('backhaul: switching is runtime-only and never rewrites UCI', function() {
	lib.ok(lib.exists(SWITCH));

	const source = lib.read(SWITCH);

	includes(source, 'backhaul_monitor_once()');
	includes(source, 'ubus call network.interface.mesh_wired up');
	includes(source, 'ubus call network.interface.mesh_wired down');
	includes(source, 'wm_take_lock');
	notIncludes(source, 'uci set network.mesh_wired');
	notIncludes(source, 'uci_set_value');
});

test('backhaul: the carrier of the port is the link signal', function() {
	const source = lib.read(SWITCH);

	includes(source, 'cat "/sys/class/net/$dev/carrier"');
	includes(source, 'operstate');
	includes(source, 'echo absent');
	includes(source, 'echo unknown');
	includes(source, 'carrier=$BACKHAUL_WIRED');
});

test('backhaul: switching is debounced and the first pass only records state', function() {
	const source = lib.read(SWITCH);

	includes(source, 'backhaul_switch_delay');
	includes(source, 'backhaul_stable_time');
	includes(source, 'delay=30');
	includes(source, 'stable=60');
	includes(source, 'wired_for=$((now -');
	includes(source, 'wlan_for=$((now -');
	includes(source, 'if ! backhaul_state_load; then');
});

test('backhaul: switches and failures are recorded as events', function() {
	const source = lib.read(SWITCH);

	includes(source, 'wm_event backhaul-switch from "$from" to "$target" reason "$reason"');
	includes(source, 'wm_event backhaul-switch-failed from "$from" to "$target"');
	includes(source, 'BACKHAUL_LAST_ERROR');
});

test('backhaul: automatic priority removes the override and manual priority writes it', function() {
	const source = lib.read(BACKEND);
	const priority = source.slice(source.indexOf('mesh_apply_priority()'));

	includes(priority, 'uci -q del network.mesh_wired.throughput_override');
	includes(priority, 'uci -q del network.mesh_batman.throughput_override');
	includes(priority, 'throughput_override_set network.mesh_wired wired "$wired_mbit"');
	includes(priority, 'throughput_override_set network.mesh_batman wireless "$wireless_mbit"');
	includes(source, 'throughput_override=${value}mbit');
	includes(source, 'WM_THROUGHPUT_MAX=100000');
	includes(source, 'throughput_override_capable');
	includes(source, 'The kernel-negotiated speed is deliberately not copied into');
	includes(source, '\tapply_wired_backhaul\n\tmesh_apply_priority\n\tuci_commit network');
});

test('backhaul: the worker and init script run the switching monitor', function() {
	const worker = lib.read('root/usr/lib/wifimanager/worker.sh');
	const init = lib.read('root/etc/init.d/wifimanager');

	includes(worker, '. /usr/lib/wifimanager/backhaul.sh');
	includes(worker, 'backhaul_tick)');
	includes(worker, 'backhaul-daemon)');
	includes(init, 'procd_open_instance backhaul');
	includes(init, 'worker.sh backhaul-daemon');
});

test('backhaul: the status method is read-only and allowed by the ACL', function() {
	const rpcd = lib.read('root/usr/libexec/rpcd/wifimanager');
	const acl = lib.acl()['luci-app-wifimanager'];

	includes(rpcd, '"backhaul_status": {}');
	includes(rpcd, '. /usr/lib/wifimanager/backhaul.sh');
	includes(rpcd, 'backhaul_status) backhaul_status_json ;;');

	ok(acl.read.ubus.wifimanager.indexOf('backhaul_status') !== -1,
		'backhaul_status is readable');
	ok((acl.write.ubus.wifimanager || []).indexOf('backhaul_status') === -1,
		'backhaul_status is not writable');

	includes(lib.read('htdocs/luci-static/resources/wifimanager/utils/rpc.js'),
		"backhaulStatus: declare('backhaul_status')");
});

test('backhaul: the view exposes switching and priority settings', function() {
	const source = lib.read(VIEW);

	includes(source, "s.tab('switch'");
	includes(source, "form.Flag, 'backhaul_auto'");
	includes(source, "form.ListValue, 'backhaul_pref'");
	includes(source, "form.Value, 'backhaul_switch_delay'");
	includes(source, "form.Value, 'backhaul_stable_time'");
	includes(source, "form.ListValue, 'backhaul_priority'");
	includes(source, "form.Value, 'backhaul_wired_mbit'");
	includes(source, "form.Value, 'backhaul_wireless_mbit'");
	includes(source, 'rpc.backhaulStatus()');
	includes(source, 'switchSummary(backhaul.last_switch)');
	includes(source, 'backhaul.running === false');
});

test('backhaul: the event log labels backhaul switches', function() {
	const source = lib.read('htdocs/luci-static/resources/view/wifimanager/roaming/events.js');

	includes(source, "'backhaul-switch': 'info'");
	includes(source, "'backhaul-switch-failed': 'error'");
	includes(source, "case 'backhaul-switch':");
	includes(source, "case 'backhaul-switch-failed':");
});

const SWITCH_DRIVER = `#!/bin/sh
set -u
STUB="$1"
. "$2"

WM_RUN_DIR="$STUB/run"
WM_BACKHAUL_STATE="$WM_RUN_DIR/backhaul.state"
mkdir -p "$WM_RUN_DIR"

failures=0
check() {
	if [ "$2" = "$3" ]; then
		echo "ok: $1"
	else
		echo "FAIL: $1: expected [$2], got [$3]"
		failures=$((failures + 1))
	fi
}
fail() {
	echo "FAIL: $1"
	failures=$((failures + 1))
}

uci() {
	local key=""
	while [ "$#" -gt 0 ]; do
		case "$1" in
			-q) shift ;;
			get) key="$2"; shift 2 ;;
			*) shift ;;
		esac
	done
	[ -n "$key" ] || return 1
	grep -F "$key=" "$STUB/uci" 2>/dev/null | head -n 1 | cut -d= -f2-
}

ubus() {
	echo "$*" >>"$STUB/ubus.calls"
	local rc
	rc=$(cat "$STUB/ubus.rc" 2>/dev/null || echo 0)
	if [ "$rc" != 0 ]; then
		cat "$STUB/ubus.err" 2>/dev/null
		return "$rc"
	fi
	case "$*" in
		*'mesh_wired down')
			grep -vxF "$(cat "$STUB/wired.dev")" "$STUB/hardifs" >"$STUB/hardifs.tmp"
			mv "$STUB/hardifs.tmp" "$STUB/hardifs"
			;;
		*'mesh_wired up')
			cat "$STUB/wired.dev" >>"$STUB/hardifs"
			;;
	esac
	return 0
}

batctl() { return 0; }

mesh_hardif_bindings() {
	local entry
	while IFS= read -r entry; do
		[ -n "$entry" ] && echo "$entry 00:11:22:33:44:55 ethernet"
	done <"$STUB/hardifs"
}

mesh_hardif_speeds() {
	[ -s "$STUB/wlan" ] && echo "wlan1 150 00:aa:bb:cc:dd:ee"
	return 0
}

mesh_selected_ifaces() { return 0; }
hardif_is_wireless() { [ "$1" = wlan1 ]; }
backhaul_carrier_state() { cat "$STUB/carrier" 2>/dev/null || echo unknown; }
wm_take_lock() { [ "$(cat "$STUB/lock" 2>/dev/null || echo 0)" = 1 ] && return 1; return 0; }
wm_log() { echo "$*" >>"$STUB/log"; }
wm_event() { echo "$*" >>"$STUB/events"; }
date() { case "$1" in +%s) cat "$STUB/now" ;; *) echo "2026-01-01 00:00:00" ;; esac; }
sleep() { return 0; }

reset() {
	rm -f "$WM_BACKHAUL_STATE" "$WM_BACKHAUL_STATE".*
	mkdir -p "$STUB/run"
	: >"$STUB/ubus.calls"
	: >"$STUB/events"
	: >"$STUB/log"
	: >"$STUB/wlan"
	: >"$STUB/hardifs"
	echo 0 >"$STUB/ubus.rc"
	echo 0 >"$STUB/lock"
	echo eth9 >"$STUB/wired.dev"
	echo absent >"$STUB/carrier"
	echo 0 >"$STUB/now"
}

cfg() {
	cat >"$STUB/uci" <<EOF
meshassistant.config.enabled=1
meshassistant.config.running=1
meshassistant.config.backhaul_auto=1
meshassistant.config.backhaul_pref=$1
meshassistant.config.backhaul_switch_delay=30
meshassistant.config.backhaul_stable_time=60
network.mesh_wired.device=eth9
network.mesh_wired.proto=batadv_hardif
EOF
}

at() { echo "$1" >"$STUB/now"; }
carrier() { echo "$1" >"$STUB/carrier"; }
wlan() { if [ "$1" = up ]; then echo 1 >"$STUB/wlan"; else : >"$STUB/wlan"; fi; }
active() { sed -n 's/^active=//p' "$WM_BACKHAUL_STATE"; }
calls() { grep -c 'network.interface.mesh_wired' "$STUB/ubus.calls" 2>/dev/null || true; }

# ethernet -> wireless: delay and flapping
reset; cfg ethernet; wlan up; carrier up; at 1000
backhaul_monitor_once
check "the first pass records the initial medium" ethernet "$(active)"

echo eth9 >>"$STUB/hardifs"
carrier down; at 1010
backhaul_monitor_once
check "no switch before the fallback delay" ethernet "$(active)"
check "no netifd call before the delay" 0 "$(calls)"

carrier up; at 1020; backhaul_monitor_once
carrier down; at 1025; backhaul_monitor_once
at 1045; backhaul_monitor_once
check "a flapping cable restarts the fallback timer" ethernet "$(active)"
at 1060; backhaul_monitor_once
check "the switch happens after the delay" wireless "$(active)"
check "exactly one netifd call" 1 "$(calls)"
grep -q 'mesh_wired down' "$STUB/ubus.calls" || fail "the wired hardif was not detached"
grep -q '^backhaul-switch from ethernet to wireless reason wired-lost$' "$STUB/events" ||
	fail "the switch event is missing"
check "the wired hardif leaves bat0" 0 "$(grep -cx 'eth9' "$STUB/hardifs" || true)"

# wireless -> ethernet: stability
reset; cfg ethernet; wlan up; carrier down; at 2000
backhaul_monitor_once
check "the first pass records the wireless medium" wireless "$(active)"
carrier up; at 2010; backhaul_monitor_once
at 2050; backhaul_monitor_once
check "no restore before the stability time" wireless "$(active)"
at 2075; backhaul_monitor_once
check "the restore happens after the stability time" ethernet "$(active)"
grep -q 'mesh_wired up' "$STUB/ubus.calls" || fail "the wired hardif was not reattached"
grep -q '^backhaul-switch from wireless to ethernet reason wired-restored$' "$STUB/events" ||
	fail "the restore event is missing"

# a failed switch keeps the previous medium
reset; cfg ethernet; wlan up; carrier up; at 3000
backhaul_monitor_once
echo eth9 >>"$STUB/hardifs"
echo 1 >"$STUB/ubus.rc"
echo 'netifd: mesh_wired not found' >"$STUB/ubus.err"
carrier down; at 3030; backhaul_monitor_once
at 3060; backhaul_monitor_once
check "a failed switch keeps the previous medium" ethernet "$(active)"
grep -q '^backhaul-switch-failed ' "$STUB/events" || fail "the failure event is missing"
grep -q '^last_error=netifd' "$WM_BACKHAUL_STATE" || fail "the error was not recorded"
echo 0 >"$STUB/ubus.rc"
at 3090; backhaul_monitor_once
check "the next pass retries the switch" wireless "$(active)"

# wireless preference
reset; cfg wireless; wlan up; carrier up; at 4000
backhaul_monitor_once
check "the Ethernet link is used first" ethernet "$(active)"
at 4050; backhaul_monitor_once
check "the wireless preference waits for stability" ethernet "$(active)"
at 4060; backhaul_monitor_once
check "the wireless preference wins after stability" wireless "$(active)"
grep -q 'reason preference' "$STUB/events" || fail "the preference event is missing"

# a configuration operation owns the mesh
reset; cfg ethernet; wlan up; carrier up; at 5000
backhaul_monitor_once
echo eth9 >>"$STUB/hardifs"
echo 1 >"$STUB/lock"
carrier down; at 5030; backhaul_monitor_once
at 5060; backhaul_monitor_once
check "the lock blocks the switch" ethernet "$(active)"
check "no netifd call while the lock is held" 0 "$(calls)"
echo 0 >"$STUB/lock"
at 5090; backhaul_monitor_once
check "the switch runs once the lock is free" wireless "$(active)"

# idle unless the mesh is applied and automatic switching is on
reset; cfg ethernet
printf '%s\\n' 'meshassistant.config.enabled=0' 'meshassistant.config.running=0' \\
	'meshassistant.config.backhaul_auto=1' 'network.mesh_wired.proto=batadv_hardif' >"$STUB/uci"
carrier down; at 6000
backhaul_monitor_once
check "no state while the mesh is not running" 0 "$( [ -f "$WM_BACKHAUL_STATE" ] && echo 1 || echo 0 )"

reset; cfg ethernet
printf '%s\\n' 'meshassistant.config.enabled=1' 'meshassistant.config.running=1' \\
	'meshassistant.config.backhaul_auto=0' 'network.mesh_wired.proto=batadv_hardif' >"$STUB/uci"
carrier down; at 6100
backhaul_monitor_once
check "no state while automatic switching is disabled" 0 "$( [ -f "$WM_BACKHAUL_STATE" ] && echo 1 || echo 0 )"

if [ "$failures" != 0 ]; then
	echo "$failures simulation check(s) failed"
	exit 1
fi
echo "backhaul simulation passed"
exit 0
`;

test('backhaul: switching simulation covers delay, stability, flapping and failure', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-backhaul-'));
	const combined = [ 'common.sh', 'peer.sh', 'backhaul.sh' ].map(function(name) {
		return lib.read('root/usr/lib/wifimanager/' + name).split('\n').filter(function(line) {
			return line.indexOf('. /usr/') !== 0;
		}).join('\n');
	}).join('\n');

	fs.writeFileSync(path.join(dir, 'modules.sh'), combined);
	fs.writeFileSync(path.join(dir, 'driver.sh'), SWITCH_DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'), dir, path.join(dir, 'modules.sh') ]);

		equal(result.status, 0, 'simulation output:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'backhaul simulation passed');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('backhaul: the runtime table reports radio and station rates', function() {
	const view = lib.read(VIEW);
	const peer = lib.read('root/usr/lib/wifimanager/peer.sh');

	includes(view, "label: _('Radio')");
	includes(view, "label: _('TX rate')");
	includes(view, "label: _('RX rate')");
	includes(view, 'row.radio');
	includes(view, 'row.txRate');
	includes(view, 'row.rxRate');
	includes(view, 'format.rate(row.txRate)');
	includes(peer, 'mesh_hardif_radio()');
});

test('backhaul: mesh diagnostics render the backhaul runtime', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/diagnostics/mesh.js');
	const source = lib.read('root/usr/lib/wifimanager/diagnostics.sh');

	includes(view, "card(_('Backhaul runtime')");
	includes(view, 'backhaul.wired');
	includes(view, 'backhaul.last_switch');
	includes(view, 'backhaul.last_error');
	includes(source, 'json_add_object backhaul');
});

const WAN_DRIVER = `#!/bin/sh
set -u
STUB="$1"
. "$2"

failures=0
check() {
	if [ "$2" = "$3" ]; then
		echo "ok: $1"
	else
		echo "FAIL: $1: expected [$2], got [$3]"
		failures=$((failures + 1))
	fi
}
fail() {
	echo "FAIL: $1"
	failures=$((failures + 1))
}

uci() {
	local cmd="" key=""
	while [ "$#" -gt 0 ]; do
		case "$1" in
			-q) shift ;;
			get) cmd=get; key="$2"; shift 2 ;;
			show) cmd=show; key="$2"; shift 2 ;;
			*) shift ;;
		esac
	done
	case "$cmd" in
		get)
			[ -n "$key" ] || return 1
			local line
			line=$(grep -F "$key=" "$STUB/uci.keys" 2>/dev/null | head -n 1) || return 1
			[ -n "$line" ] || return 1
			printf '%s\\n' "\${line#*=}"
			;;
		show)
			cat "$STUB/$key.show" 2>/dev/null
			;;
	esac
}

cat >"$STUB/uci.keys" <<EOF
network.wan.device=wan
network.wan6.device=@wan
network.wwan.device=wwan0
network.phone.device=usb0
network.somewan.device=br-wan
network.br_wan.type=bridge
network.br_wan.name=br-wan
network.br_wan.ports=eth0 eth1
network.lan.device=br-lan
network.br_lan.type=bridge
network.br_lan.name=br-lan
network.br_lan.ports=lan1 lan2
firewall.zonewan.network=wan somewan
EOF
cat >"$STUB/network.show" <<EOF
network.br_wan=device
network.br_wan.type='bridge'
network.br_wan.name='br-wan'
network.br_wan.ports='eth0 eth1'
network.br_lan=device
network.br_lan.type='bridge'
network.br_lan.name='br-lan'
network.br_lan.ports='lan1 lan2'
EOF
cat >"$STUB/firewall.show" <<EOF
firewall.zonelan=zone
firewall.zonelan.name='lan'
firewall.zonelan.network='lan'
firewall.zonewan=zone
firewall.zonewan.name='wan'
firewall.zonewan.network='wan somewan'
EOF

check "the WAN zone and the bridge behind it are recognized" \\
	"eth0 eth1 wan wwan0 " "$(wan_network_devices | tr '\\n' ' ')"

if wired_port_is_wan wan; then :; else fail "the wan interface is not recognized"; fi
if wired_port_is_wan eth1; then :; else fail "a port of the WAN bridge is not recognized"; fi
if wired_port_is_wan lan1; then fail "a LAN port was treated as WAN"; fi
if wired_port_is_wan usb0; then fail "an unrelated interface was treated as WAN"; fi

# A real, existing device (lo stands in for the WAN port) is refused while it
# carries the WAN side and accepted once it is removed from the WAN zone.
printf 'network.testwan.device=lo\\n' >>"$STUB/uci.keys"
sed -i 's/^firewall.zonewan.network=.*/firewall.zonewan.network=wan somewan testwan/' "$STUB/uci.keys"
cat >"$STUB/firewall.show" <<EOF
firewall.zonewan=zone
firewall.zonewan.name='wan'
firewall.zonewan.network='wan somewan testwan'
EOF
wired_port_is_usable lo; rc=$?
check "an existing device that carries the WAN side is refused" 1 "$rc"

sed -i '/^network.testwan/d; s/^firewall.zonewan.network=.*/firewall.zonewan.network=wan somewan/' "$STUB/uci.keys"
cat >"$STUB/firewall.show" <<EOF
firewall.zonewan=zone
firewall.zonewan.name='wan'
firewall.zonewan.network='wan somewan'
EOF
wired_port_is_usable lo; rc=$?
check "the same device is usable when it is not on the WAN side" 0 "$rc"

if [ "$failures" -ne 0 ]; then
	echo "wan-port simulation failed: $failures"
	exit 1
fi
echo "wan-port simulation passed"
`;

test('backhaul: WAN device discovery and the wired-port guard', function() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-wanport-'));
	const combined = [ 'common.sh', 'mesh.sh' ].map(function(name) {
		return lib.read('root/usr/lib/wifimanager/' + name).split('\n').filter(function(line) {
			return line.indexOf('. /usr/') !== 0;
		}).join('\n');
	}).join('\n');

	fs.writeFileSync(path.join(dir, 'modules.sh'), combined);
	fs.writeFileSync(path.join(dir, 'driver.sh'), WAN_DRIVER);

	try {
		const result = lib.command('sh', [ path.join(dir, 'driver.sh'), dir, path.join(dir, 'modules.sh') ]);

		equal(result.status, 0, 'simulation output:\n' + result.stdout + result.stderr);
		includes(result.stdout, 'wan-port simulation passed');
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
