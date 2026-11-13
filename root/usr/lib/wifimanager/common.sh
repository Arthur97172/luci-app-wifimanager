#!/bin/sh
# Shared helpers for the WiFi Manager backend.
# POSIX sh (ash) only: OpenWrt's /bin/sh is busybox ash.

# Modules build JSON with jshn; sourcing it here means every entry point has it.
. /usr/share/libubox/jshn.sh 2>/dev/null

WM_VERSION="2.0.6"
WM_APP="luci-app-wifimanager"

WM_CONF_DIR="/etc/wifimanager"
WM_LOG_DIR="$WM_CONF_DIR/logs"
WM_CFG_DIR="$WM_CONF_DIR/config"
WM_RUNTIME_DIR="$WM_CONF_DIR/runtime"
WM_BACKUP_DIR_DEFAULT="$WM_CONF_DIR/backup"
WM_LOG="$WM_LOG_DIR/wifimanager.log"
WM_EVENTS="$WM_LOG_DIR/roaming-events.jsonl"

WM_RUN_DIR="/var/run/wifimanager"
WM_OP_FILE="$WM_RUN_DIR/op.json"
WM_LOCK="$WM_RUN_DIR/lock"
WM_UPLOAD_DIR="/tmp/wifimanager-upload"

WM_CONFIG_DIR="/etc/config"
# Every UCI file this package may read, back up or rewrite.  The backup manager
# and the restore/apply syntax checks share one list so a file cannot be
# covered by one and missed by the other.
WM_CONFIG_FILES="network wireless dhcp firewall system meshassistant dawn wifimanager"
WM_MESH_CONF="$WM_CONFIG_DIR/meshassistant"
WM_DAWN_CONF="$WM_CONFIG_DIR/dawn"
WM_DAWN_MARKER="$WM_CFG_DIR/dawn.managed"
WM_DAWN_BACKUP="$WM_CFG_DIR/dawn.orig"
WM_LAN_SNAPSHOT="$WM_CFG_DIR/lan-state"

WM_PEERS="$WM_RUN_DIR/peers"
WM_NAMES="$WM_RUN_DIR/names"
WM_PORT="47123"
WM_ANNOUNCE_INTERVAL="20"
WM_PEER_MAX_AGE="300"
WM_NAME_MAX_AGE="900"

# ---------------------------------------------------------------------------
# Basic setup
# ---------------------------------------------------------------------------

wm_init_dirs() {
	mkdir -p "$WM_LOG_DIR" "$WM_CFG_DIR" "$WM_RUNTIME_DIR" "$WM_RUN_DIR" 2>/dev/null
	mkdir -p "$WM_UPLOAD_DIR" 2>/dev/null
	chmod 700 "$WM_CONF_DIR" "$WM_CFG_DIR" "$WM_LOG_DIR" "$WM_RUN_DIR" "$WM_UPLOAD_DIR" 2>/dev/null
	touch "$WM_LOG" 2>/dev/null
	chmod 600 "$WM_LOG" 2>/dev/null
}

wm_log() {
	local ts
	ts=$(date '+%Y-%m-%d %H:%M:%S')
	printf '%s %s\n' "$ts" "$(printf '%s' "$*" | tr '\n\r' '  ')" >>"$WM_LOG"
	# Keep the log bounded; the tail is what the Logs page shows.
	if [ -f "$WM_LOG" ]; then
		local count
		count=$(wc -l <"$WM_LOG" 2>/dev/null)
		if [ "${count:-0}" -gt 4000 ]; then
			tail -n 2000 "$WM_LOG" >"$WM_LOG.tmp" 2>/dev/null && mv "$WM_LOG.tmp" "$WM_LOG"
		fi
	fi
	# Mirror to syslog so operators find it beside other daemons.
	logger -t wifimanager "$*" 2>/dev/null
}

wm_event() {
	local kind="$1" json
	shift
	wm_init_dirs
	json="$(
		. /usr/share/libubox/jshn.sh 2>/dev/null
		json_init
		json_add_int ts "$(date +%s)"
		json_add_string event "$kind"
		while [ "$#" -ge 2 ]; do
			json_add_string "$1" "$2"
			shift 2
		done
		json_dump
	)"
	[ -n "$json" ] && printf '%s\n' "$json" >>"$WM_EVENTS"
	if [ -f "$WM_EVENTS" ]; then
		local n
		n=$(wc -l <"$WM_EVENTS" 2>/dev/null)
		[ "${n:-0}" -gt 500 ] && { tail -n 300 "$WM_EVENTS" >"$WM_EVENTS.tmp" && mv "$WM_EVENTS.tmp" "$WM_EVENTS"; }
	fi
}

# Read a string field of a JSON argument blob.
jget() {
	printf '%s' "$1" | jsonfilter -e "$2" 2>/dev/null
}

# Emit {"ok":false,...}. Callers exit afterwards.
wm_error() {
	(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_boolean ok 0
		json_add_string error "$1"
		json_add_string message "$2"
		json_dump
	)
	echo
}

# ---------------------------------------------------------------------------
# Locking and background operations
# ---------------------------------------------------------------------------

wm_take_lock() {
	mkdir -p "$WM_RUN_DIR" 2>/dev/null
	exec 8>"$WM_LOCK"
	if command -v flock >/dev/null 2>&1; then
		if ! flock -n 8; then
			echo "Another WiFi Manager operation is already running." >&2
			return 1
		fi
	fi
}

# wm_op_write <state> <op> <message> <started> [extra-key value]...
wm_op_write() {
	local state="$1" op="$2" message="$3" started="$4" tmp
	shift 4
	tmp="$WM_OP_FILE.$$"
	(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_string state "$state"
		json_add_string op "$op"
		json_add_string message "$message"
		json_add_int started "${started:-$(date +%s)}"
		json_add_int updated "$(date +%s)"
		while [ "$#" -ge 2 ]; do
			json_add_string "$1" "$2"
			shift 2
		done
		json_dump
	) >"$tmp" 2>/dev/null && mv "$tmp" "$WM_OP_FILE"
	chmod 600 "$WM_OP_FILE" 2>/dev/null
}

wm_op_begin() {
	WM_OP_STARTED=$(date +%s)
	WM_OP_NAME="$1"
	export WM_OP_STARTED WM_OP_NAME
	wm_op_write running "$1" "${2:-}" "$WM_OP_STARTED"
}

wm_op_finish() {
	local state="$1" message="$2" verified="${3:-}"
	if [ -n "$verified" ]; then
		wm_op_write "$state" "${WM_OP_NAME:-operation}" "$message" "$WM_OP_STARTED" verified "$verified"
	else
		wm_op_write "$state" "${WM_OP_NAME:-operation}" "$message" "$WM_OP_STARTED"
	fi
}

# ---------------------------------------------------------------------------
# UCI helpers
# ---------------------------------------------------------------------------

uci_set_value() { # path value
	[ -n "$2" ] && uci set "$1=$2"
}

uci_set_optional() { # path value
	[ -n "$2" ] && uci set "$1=$2"
	return 0
}

uci_commit() { uci -q commit "$1" 2>/dev/null; }

uci_commit_all() {
	local cfg
	for cfg in $WM_CONFIG_FILES; do
		uci -q commit "$cfg" 2>/dev/null
	done
}

# The radio that carries the mesh.  The settings page and the engine write
# apRadio; configurations created before that option existed may still carry
# mesh_radio, so it is honoured when apRadio is absent.  Multi-radio lists are
# reduced to the first entry for the single-radio checks and labels.
mesh_managed_radio() {
	local radio
	radio=$(uci -q get meshassistant.config.apRadio)
	[ -n "$radio" ] || radio=$(uci -q get meshassistant.config.mesh_radio)
	printf '%s\n' "${radio%% *}"
}

# The 802.11s section the engine runs on the mesh radio, or empty.  The name
# is the convention setup_mesh_radio writes; matching the device keeps a
# renamed or legacy section working.
mesh_iface_section() {
	local radio section
	radio=$(mesh_managed_radio)
	[ -n "$radio" ] || return 0

	for section in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$section.mode")" = mesh ] || continue
		[ "$(uci -q get "wireless.$section.device")" = "$radio" ] || continue
		printf '%s\n' "$section"
		return 0
	done
}

# Whether the mesh link is protected and which encryption it runs.  Only the
# state and the encryption name are announced: the key itself is never sent.
# The configured values are used when the mesh section has not been written
# yet, so a device that is not running the mesh still reports its intent.
local_mesh_key_state() {
	local section key
	section=$(mesh_iface_section)
	if [ -n "$section" ]; then
		key=$(uci -q get "wireless.$section.key")
		[ -n "$key" ] || key=$(uci -q get "wireless.$section.sae_password")
		[ -n "$key" ] && {
			printf 'set\n'
			return 0
		}
	fi

	[ "$(uci -q get meshassistant.config.encryption)" = 1 ] &&
		[ -n "$(uci -q get meshassistant.config.key)" ] &&
		printf 'set\n' || printf 'unset\n'
}

local_mesh_encryption() {
	local section enc
	section=$(mesh_iface_section)
	if [ -n "$section" ]; then
		enc=$(uci -q get "wireless.$section.encryption")
		[ -n "$enc" ] && {
			printf '%s\n' "$enc"
			return 0
		}
	fi

	if [ "$(uci -q get meshassistant.config.encryption)" = 1 ]; then
		printf 'sae\n'
	else
		printf 'none\n'
	fi
}

# hostapd has one fast-transition transport per BSS: 0 sends the FT
# authentication frames over the air, 1 over the distribution system.  Only an
# explicit "1" selects DS; a missing option keeps the historical air default so
# an upgrade does not silently change the running APs.
ft_over_ds_value() {
	if [ "$(uci -q get meshassistant.config.ft_over_ds)" = 1 ]; then
		echo 1
	else
		echo 0
	fi
}

# 802.11k and 802.11v used to share the single "kvr" switch.  A configuration
# that has neither new option keeps the old behaviour; once a value is stored
# it wins, so one feature can be turned off without silently turning off the
# other.
roaming_option() { # new-option
	local value
	value=$(uci -q get "meshassistant.config.$1")
	case "$value" in
		0|1) printf '%s\n' "$value"; return 0 ;;
	esac
	case "$(uci -q get meshassistant.config.kvr)" in
		1) printf '1\n' ;;
		*) printf '0\n' ;;
	esac
}

roaming_k_enabled() {
	[ "$(roaming_option ieee80211k)" = 1 ]
}

roaming_v_enabled() {
	[ "$(roaming_option ieee80211v)" = 1 ]
}

# DAWN is managed for 802.11k neighbor reports as well as for 802.11v
# steering, so either feature keeps it running.
roaming_steering_enabled() {
	[ "$(uci -q get meshassistant.config.enabled)" = 1 ] || return 1
	roaming_k_enabled || roaming_v_enabled
}

# Parse every managed UCI file in a config directory.  uci prints a parse error
# and exits non-zero for a malformed file; the message names the file so a
# restore can be refused before anything reaches /etc/config.
config_check_syntax() { # config-dir [label]
	local dir="$1" label="${2:-Configuration}" cfg msg

	for cfg in $WM_CONFIG_FILES; do
		[ -f "$dir/$cfg" ] || continue
		if ! msg=$(uci -c "$dir" export "$cfg" 2>&1 >/dev/null); then
			echo "$label file '$cfg' does not parse: $msg"
			return 1
		fi
	done
	return 0
}

# Set or remove an option according to whether the value is empty.
uci_update_optional() { # path value
	if [ -n "$2" ]; then
		uci set "$1=$2"
	else
		uci -q del "$1"
	fi
}

# Copy one named UCI section from a config directory into the live config.  The
# optional destination name lets a section be restored under a different live
# name, which is how radios are matched by PHY path after a rename.
uci_copy_section_from_dir() { # srcdir cfg sec [dest]
	local src="$1" cfg="$2" sec="$3" dest="${4:-$3}" type line opt value rest item

	type=$(uci -q -c "$src" get "$cfg.$sec") || return 1
	[ -n "$type" ] || return 1

	uci -q del "$cfg.$dest"
	uci set "$cfg.$dest=$type" || return 1

	uci -q -c "$src" show "$cfg.$sec" 2>/dev/null | while IFS= read -r line; do
		opt=$(printf '%s' "$line" | sed -n 's/^[^.]*\.[^.]*\.\([^=]*\)=.*/\1/p')
		[ -n "$opt" ] || continue
		value=$(uci -q -c "$src" get "$cfg.$sec.$opt")
		rest=${line#*=}
		case "$rest" in
			*"'"*"'"*"'"*"'"*)
				# Two or more quoted words: a UCI list.
				for item in $value; do
					uci add_list "$cfg.$dest.$opt=$item"
				done
				;;
			*)
				uci set "$cfg.$dest.$opt=$value"
				;;
		esac
	done
	return 0
}

# Copy one option from a config directory, removing it when absent there.
# Lists are rebuilt with add_list so a multi-value option stays a list.
uci_copy_option_from_dir() { # srcdir cfg sec opt
	local src="$1" cfg="$2" sec="$3" opt="$4" value line rest item

	if ! line=$(uci -q -c "$src" show "$cfg.$sec.$opt" 2>/dev/null); then
		uci -q del "$cfg.$sec.$opt"
		return 0
	fi
	value=$(uci -q -c "$src" get "$cfg.$sec.$opt")
	uci -q del "$cfg.$sec.$opt"
	rest=${line#*=}
	case "$rest" in
		*"'"*"'"*"'"*"'"*)
			for item in $value; do
				uci add_list "$cfg.$sec.$opt=$item"
			done
			;;
		*)
			uci set "$cfg.$sec.$opt=$value"
			;;
	esac
}

# ---------------------------------------------------------------------------
# Network helpers
# ---------------------------------------------------------------------------

valid_ipv4() {
	case "$1" in
		''|*[!0-9.]*|.*|*.) return 1 ;;
	esac
	local IFS=. a b c d
	set -- $1
	[ "$#" -eq 4 ] || return 1
	for a in "$@"; do
		[ "$a" -ge 0 ] 2>/dev/null && [ "$a" -le 255 ] 2>/dev/null || return 1
	done
	return 0
}

valid_netmask() {
	local prefix
	prefix=$(netmask_prefix "$1") || return 1
	[ -n "$prefix" ]
}

netmask_prefix() {
	case "$1" in
		255.255.255.255) echo 32 ;;
		255.255.255.254) echo 31 ;;
		255.255.255.252) echo 30 ;;
		255.255.255.248) echo 29 ;;
		255.255.255.240) echo 28 ;;
		255.255.255.224) echo 27 ;;
		255.255.255.192) echo 26 ;;
		255.255.255.128) echo 25 ;;
		255.255.255.0) echo 24 ;;
		255.255.254.0) echo 23 ;;
		255.255.252.0) echo 22 ;;
		255.255.248.0) echo 21 ;;
		255.255.240.0) echo 20 ;;
		255.255.224.0) echo 19 ;;
		255.255.192.0) echo 18 ;;
		255.255.128.0) echo 17 ;;
		255.255.0.0) echo 16 ;;
		*) return 1 ;;
	esac
}

lan_device() {
	local dev
	dev=$(uci -q get network.lan.device)
	[ -n "$dev" ] || dev=$(uci -q get network.lan.ifname)
	dev=${dev%% *}
	[ -n "$dev" ] || dev="br-lan"
	printf '%s\n' "$dev"
}

# The bridge a device currently belongs to, or empty.  Runtime membership is
# authoritative; UCI is consulted for a port that is down or not yet enslaved,
# so the backhaul editor can keep a port out of another bridge before it is
# brought up.  The name is the bridge netdev (br-lan and so on).
port_bridge() { # dev
	local dev="$1" section ports name master
	[ -n "$dev" ] || return 0

	master=$(readlink -f "/sys/class/net/$dev/master" 2>/dev/null)
	if [ -n "$master" ] && [ -e "$master/bridge" ]; then
		printf '%s\n' "${master##*/}"
		return 0
	fi

	for section in $(uci -q show network 2>/dev/null |
		sed -n "s/^network\.\([^.]*\)\.type='bridge'\$/\1/p"); do
		ports=$(uci -q get "network.$section.ports")
		case " $ports " in
			*" $dev "*) ;;
			*)
				[ "$(uci -q get "network.$section.device")" = "$dev" ] || continue
				;;
		esac
		name=$(uci -q get "network.$section.name")
		[ -n "$name" ] || name="br-$section"
		printf '%s\n' "$name"
		return 0
	done
}

lan_ipv4() {
	local ip
	ip=$(ip -4 -o addr show dev "$(lan_device)" 2>/dev/null |
		awk '{ for (i = 1; i <= NF; i++) if ($i == "inet") { print $(i + 1); exit } }')
	ip=${ip%%/*}
	case "$ip" in
		''|*[!0-9.]*) return 0 ;;
	esac
	printf '%s\n' "$ip"
}

lan_broadcast() {
	ip -4 -o addr show dev "$(lan_device)" 2>/dev/null |
		awk '{ for (i = 1; i <= NF; i++) if ($i == "brd") { print $(i + 1); exit } }'
}

lan_hwaddr() {
	local mac
	mac=$(cat "/sys/class/net/$(lan_device)/address" 2>/dev/null | tr 'A-F' 'a-f')
	case "$mac" in
		[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
		*) mac='' ;;
	esac
	[ -n "$mac" ] && printf '%s\n' "$mac"
}

# Named bridge section that carries the given device (or lan).  Covers both
# the legacy swconfig form (a bridge interface section) and the DSA form
# used by OpenWrt 21.02 and later (a device section named after the bridge).
lan_bridge_section() {
	local dev="$1" section name ports
	[ -n "$dev" ] || dev=$(lan_device)
	for section in $(uci -q show network 2>/dev/null |
		sed -n "s/^network\.\([^.]*\)\.type='bridge'\$/\1/p"); do
		ports=$(uci -q get "network.$section.ports")
		case " $ports " in
			*" $dev "*) echo "$section"; return 0 ;;
		esac
		[ "$(uci -q get "network.$section.device")" = "$dev" ] && {
			echo "$section"
			return 0
		}
		name=$(uci -q get "network.$section.name")
		[ "$name" = "$dev" ] && {
			echo "$section"
			return 0
		}
	done
	return 1
}

bridge_add_port() {
	local dev="$1" section ports
	section=$(lan_bridge_section)
	if [ -z "$section" ]; then
		echo "Warning: no LAN bridge section found; '$dev' is not bridged."
		return 1
	fi
	ports=$(uci -q get "network.$section.ports")
	case " $ports " in
		*" $dev "*) return 0 ;;
	esac
	uci add_list "network.$section.ports=$dev"
	echo "Added '$dev' to the LAN bridge."
}

bridge_del_port() {
	local dev="$1" section ports
	section=$(lan_bridge_section)
	[ -n "$section" ] || return 0
	ports=$(uci -q get "network.$section.ports")
	case " $ports " in
		*" $dev "*) uci del_list "network.$section.ports=$dev" && echo "Removed '$dev' from the LAN bridge." ;;
	esac
}

# ---------------------------------------------------------------------------
# Firewall helpers (zones are found by name, never by index)
# ---------------------------------------------------------------------------

firewall_zone_section() { # name
	local want="$1" section
	for section in $(uci -q show firewall 2>/dev/null |
		sed -n "s/^firewall\.\([^.]*\)\.name='\(.*\)'\$/\1 \2/p" | awk -v n="$want" '$2 == n { print $1; exit }'); do
		echo "$section"
		return 0
	done
	return 1
}

firewall_zone_has_network() { # zonename network
	local section
	section=$(firewall_zone_section "$1") || return 1
	case " $(uci -q get "firewall.$section.network") " in
		*" $2 "*) return 0 ;;
	esac
	return 1
}

firewall_zone_add_network() { # zonename network
	local section
	section=$(firewall_zone_section "$1") || return 1
	firewall_zone_has_network "$1" "$2" && return 0
	uci add_list "firewall.$section.network=$2"
}

firewall_remove_network_everywhere() { # network
	local section
	for section in $(uci -q show firewall 2>/dev/null |
		sed -n "s/^firewall\.\([^.]*\)\.network=.*/\1/p" | sort -u); do
		case " $(uci -q get "firewall.$section.network") " in
			*" $1 "*) uci del_list "firewall.$section.network=$1" ;;
		esac
	done
}

ensure_lan_wan_forwarding() {
	local fwd
	for fwd in $(uci -q show firewall 2>/dev/null |
		sed -n "s/^firewall\.\([^.]*\)=forwarding\$/\1/p"); do
		if [ "$(uci -q get "firewall.$fwd.src")" = lan ] &&
			[ "$(uci -q get "firewall.$fwd.dest")" = wan ]; then
			return 0
		fi
	done
	uci set firewall.wifimanager_lan_wan=forwarding
	uci set firewall.wifimanager_lan_wan.src='lan'
	uci set firewall.wifimanager_lan_wan.dest='wan'
	echo added
}

# ---------------------------------------------------------------------------
# WAN device discovery
# ---------------------------------------------------------------------------

# A "config device" section can be referenced by its section name or by its
# name option (DSA writes both forms).  Print the section id, if any.
network_device_section() { # netdev
	local dev="$1" section
	uci -q get "network.$dev.type" >/dev/null 2>&1 && {
		printf '%s\n' "$dev"
		return 0
	}
	for section in $(uci -q show network 2>/dev/null |
		sed -n "s/^network\.\([^.]*\)\.name='\(.*\)'\$/\1 \2/p" |
		awk -v n="$dev" '$2 == n { print $1; exit }'); do
		printf '%s\n' "$section"
		return 0
	done
	return 1
}

# Physical devices a network interface currently uses.  A bridge device is
# expanded to its ports, so a WAN built on br-wan is recognized as well.
network_iface_devices() { # iface
	local iface="$1" dev section ports port
	for dev in $(uci -q get "network.$iface.device") $(uci -q get "network.$iface.ifname"); do
		case "$dev" in
			''|@*) continue ;;
		esac
		section=$(network_device_section "$dev")
		if [ -n "$section" ] && [ "$(uci -q get "network.$section.type")" = bridge ]; then
			ports=$(uci -q get "network.$section.ports")
			for port in $ports; do
				printf '%s\n' "$port"
			done
		else
			printf '%s\n' "$dev"
		fi
	done
}

# Devices that carry the WAN side today: the interfaces of the firewall zone
# named "wan" (the authoritative list, because operators rename sections) plus
# the conventional wan/wan6/wwan sections.  A port from this list must never
# be handed to the mesh backhaul: moving it would take the uplink with it.
wan_network_devices() {
	local iface section
	{
		for iface in wan wan6 wwan; do
			network_iface_devices "$iface"
		done
		section=$(firewall_zone_section wan 2>/dev/null) || section=''
		if [ -n "$section" ]; then
			for iface in $(uci -q get "firewall.$section.network"); do
				network_iface_devices "$iface"
			done
		fi
	} | sort -u
}

# ---------------------------------------------------------------------------
# Service state helpers
# ---------------------------------------------------------------------------

service_enabled() {
	/etc/init.d/"$1" enabled >/dev/null 2>&1
}

# Disable a service only if it is currently enabled, and record that fact so the
# restore path turns on exactly what this engine turned off.
disable_service_recorded() {
	local service="$1"
	[ "$(uci -q get "meshassistant.config.svc_disabled_$service")" = 1 ] && return 0
	if service_enabled "$service"; then
		uci set "meshassistant.config.svc_disabled_$service=1"
		/etc/init.d/"$service" disable >/dev/null 2>&1
		/etc/init.d/"$service" stop >/dev/null 2>&1
		echo "Stopped '$service' (will be restored when the mesh is disabled)."
	fi
}

restore_service_if_disabled() {
	local service="$1"
	[ "$(uci -q get "meshassistant.config.svc_disabled_$service")" = 1 ] || return 0
	uci -q del "meshassistant.config.svc_disabled_$service"
	/etc/init.d/"$service" enable >/dev/null 2>&1
	/etc/init.d/"$service" start >/dev/null 2>&1
	echo "Restored '$service'."
}

restore_services() {
	local service
	for service in firewall dnsmasq odhcpd; do
		restore_service_if_disabled "$service"
	done
}

# ---------------------------------------------------------------------------
# LAN / hostname / DHCP snapshots
# ---------------------------------------------------------------------------

# Snapshot the whole lan network section once; used by node/client roles and
# dumb AP mode.  Saving twice would overwrite the original with converted data.
save_node_lan_state() {
	[ "$(uci -q get meshassistant.config.lan_state_saved)" = 1 ] && return 0
	uci -q export network.lan >"$WM_LAN_SNAPSHOT" 2>/dev/null || return 1
	chmod 600 "$WM_LAN_SNAPSHOT"
	uci set meshassistant.config.lan_state_saved=1
	echo "Saved the original LAN configuration."
}

restore_node_lan_state() {
	[ "$(uci -q get meshassistant.config.lan_state_saved)" = 1 ] || return 0
	[ -s "$WM_LAN_SNAPSHOT" ] || {
		uci -q del meshassistant.config.lan_state_saved
		return 0
	}
	local type
	type=$(awk '/^config /{ print $2; exit }' "$WM_LAN_SNAPSHOT")
	uci -q del network.lan
	uci set "network.lan=$type"
	awk '
		/^\toption / { line = substr($0, 9); i = index(line, " "); k = substr(line, 1, i - 1); v = substr(line, i + 1); gsub(/^\x27|\x27$/, "", v); printf "option %s %s\n", k, v }
		/^\tlist /   { line = substr($0, 7); i = index(line, " "); k = substr(line, 1, i - 1); v = substr(line, i + 1); gsub(/^\x27|\x27$/, "", v); printf "list %s %s\n", k, v }
	' "$WM_LAN_SNAPSHOT" | while IFS=' ' read -r kind opt value; do
		case "$kind" in
			option) uci set "network.lan.$opt=$value" ;;
			list) uci add_list "network.lan.$opt=$value" ;;
		esac
	done
	rm -f "$WM_LAN_SNAPSHOT"
	uci -q del meshassistant.config.lan_state_saved
	echo "Restored the original LAN configuration."
	uci_commit network
}

save_hostname_state() {
	[ "$(uci -q get meshassistant.config.hostname_state_saved)" = 1 ] && return 0
	uci set meshassistant.config.hostname_orig="$(uci -q get system.@system[0].hostname)"
	uci set meshassistant.config.hostname_state_saved=1
}

restore_hostname_state() {
	[ "$(uci -q get meshassistant.config.hostname_state_saved)" = 1 ] || return 0
	local orig
	orig=$(uci -q get meshassistant.config.hostname_orig)
	if [ -n "$orig" ]; then
		uci set system.@system[0].hostname="$orig"
	else
		uci -q del system.@system[0].hostname
	fi
	uci -q del meshassistant.config.hostname_orig
	uci -q del meshassistant.config.hostname_state_saved
	uci_commit system
}

# Snapshot dhcp.lan once, for both server (option 6) and node (ignore/ra) edits.
save_dhcp_lan_state() {
	[ "$(uci -q get meshassistant.config.dhcp_state_saved)" = 1 ] && return 0
	uci -q get dhcp.lan >/dev/null 2>&1 || return 0
	uci -q export dhcp.lan >"$WM_CFG_DIR/dhcp-lan.orig" 2>/dev/null || return 1
	chmod 600 "$WM_CFG_DIR/dhcp-lan.orig"
	uci set meshassistant.config.dhcp_state_saved=1
}

restore_dhcp_lan_state() {
	[ "$(uci -q get meshassistant.config.dhcp_state_saved)" = 1 ] || return 0
	uci_copy_section_from_file dhcp lan "$WM_CFG_DIR/dhcp-lan.orig"
	rm -f "$WM_CFG_DIR/dhcp-lan.orig"
	uci -q del meshassistant.config.dhcp_state_saved
	uci_commit dhcp
	echo "Restored the LAN DHCP configuration."
}

# Copy a section from a uci export file.
uci_copy_section_from_file() { # cfg sec file
	local cfg="$1" sec="$2" file="$3" type tmpdir rc
	[ -s "$file" ] || return 1
	tmpdir=$(mktemp -d /tmp/wifimanager-uci.XXXXXX) || return 1
	mkdir -p "$tmpdir"
	cp "$file" "$tmpdir/$cfg" 2>/dev/null || {
		rm -rf "$tmpdir"
		return 1
	}
	uci_copy_section_from_dir "$tmpdir" "$cfg" "$sec"
	rc=$?
	rm -rf "$tmpdir"
	return $rc
}

remove_dhcp_option6() {
	local opts opt keep
	opts=$(uci -q get dhcp.lan.dhcp_option)
	[ -n "$opts" ] || return 0
	keep=""
	for opt in $opts; do
		case "$opt" in
			6,*|6) continue ;;
		esac
		keep="$keep $opt"
	done
	uci -q del dhcp.lan.dhcp_option
	local item
	for item in $keep; do
		uci add_list "dhcp.lan.dhcp_option=$item"
	done
}

apply_dhcp_lan_dns() { # dns
	remove_dhcp_option6
	if [ -n "$1" ]; then
		uci add_list "dhcp.lan.dhcp_option=6,$1"
	fi
}

apply_server_dhcp_dns() { # dns
	[ "$(uci -q get dhcp.lan)" ] || uci set dhcp.lan=dhcp
	uci -q del dhcp.lan.ignore
	uci -q del dhcp.lan.ra
	uci -q del dhcp.lan.dhcpv6
	apply_dhcp_lan_dns "$1"
}

# Apply the node/client LAN configuration from the apmode tab.  A static
# address is verified after the reload by lan_watchdog_check().
apply_node_lan() {
	local ipmode ipaddr netmask gateway dns snapshot

	ipmode=$(uci -q get meshassistant.config.ipmode)
	[ -n "$ipmode" ] || ipmode='dhcp'
	ipaddr=$(uci -q get meshassistant.config.ipaddr)
	netmask=$(uci -q get meshassistant.config.netmask)
	gateway=$(uci -q get meshassistant.config.gateway)
	dns=$(uci -q get meshassistant.config.dns)

	save_node_lan_state
	save_hostname_state

	if [ "$ipmode" = "static" ]; then
		if ! valid_ipv4 "$ipaddr" || ! valid_netmask "$netmask"; then
			echo "Error: the static LAN address is invalid; keeping the current address."
			return 1
		fi
		uci set network.lan.proto='static'
		uci_set_value network.lan.ipaddr "$ipaddr"
		uci_set_value network.lan.netmask "$netmask"
		uci_set_optional network.lan.gateway "$gateway"
		uci_set_optional network.lan.dns "$dns"
		uci -q del network.lan.peerdns
		uci -q del network.lan.ip6assign
		uci_commit network
		lan_state_expect "$ipaddr"
	else
		uci -q del network.lan.ipaddr
		uci -q del network.lan.netmask
		uci -q del network.lan.gateway
		uci -q del network.lan.ip6assign
		apply_dhcp_lan_dns "$dns"
		uci set network.lan.proto='dhcp'
		uci_commit network
	fi

	local hostname
	hostname=$(uci -q get meshassistant.config.hostname)
	[ -n "$hostname" ] && uci set "system.@system[0].hostname=$hostname" && uci_commit system
	return 0
}

# Address the watchdog expects after the next network reload.
lan_state_expect() {
	uci set meshassistant.config.lan_expect_ip="$1"
	uci set meshassistant.config.lan_watchdog_pending=1
	uci_commit meshassistant
}

# Roll the LAN back when the expected static address did not come up.  Runs in
# the worker after reload; a no-op for DHCP mode.
lan_watchdog_check() {
	[ "$(uci -q get meshassistant.config.lan_watchdog_pending)" = 1 ] || return 0
	local want i=0 ip
	want=$(uci -q get meshassistant.config.lan_expect_ip)

	while [ "$i" -lt 60 ]; do
		ip=$(lan_ipv4)
		if [ -n "$want" ] && [ "$ip" = "$want" ]; then
			break
		fi
		if [ -z "$want" ] && [ -n "$ip" ]; then
			break
		fi
		sleep 1
		i=$((i + 1))
	done

	if [ -n "$ip" ] && { [ -z "$want" ] || [ "$ip" = "$want" ]; }; then
		uci -q del meshassistant.config.lan_watchdog_pending
		uci -q del meshassistant.config.lan_expect_ip
		uci_commit meshassistant
		echo "LAN address verified: $ip"
		return 0
	fi

	wm_log "LAN watchdog: address did not come up, rolling back ($ip != $want)"
	restore_node_lan_state
	uci_commit network
	/etc/init.d/network reload >/dev/null 2>&1
	wm_event "lan-rollback" want "$want" actual "$ip"
	echo "The LAN address did not come up; the previous configuration was restored."
	return 1
}

# ---------------------------------------------------------------------------
# Wired backhaul helpers
# ---------------------------------------------------------------------------

wired_link_speed() { # port -> Mbit/s on stdout
	local speed
	speed=$(cat "/sys/class/net/$1/speed" 2>/dev/null)
	case "$speed" in
		''|*[!0-9]*) return 1 ;;
	esac
	# 0 or negative means "unknown" on many drivers.
	[ "$speed" -gt 0 ] || return 1
	printf '%s\n' "$speed"
}

# Candidate ports for wired backhaul: physical Ethernet devices that are not
# already dedicated to WAN and are not wireless.
wired_backhaul_candidates() {
	local dev
	for dev in /sys/class/net/*; do
		dev=${dev##*/}
		case "$dev" in
			lo|br-*|bat*|mesh*|wlan*|phy*|sit*|ip6*|tun*|tap*|docker*|veth*) continue ;;
		esac
		[ -e "/sys/class/net/$dev/phy80211" ] && continue
		[ -e "/sys/class/net/$dev/device" ] || continue
		printf '%s\n' "$dev"
	done
}

# ---------------------------------------------------------------------------
# Reload and operation wrappers
# ---------------------------------------------------------------------------

wm_reload_network() {
	/etc/init.d/network reload >/dev/null 2>&1
}

wm_reload_wifi() {
	wifi reload >/dev/null 2>&1
}

wm_reload_all() {
	reload_config >/dev/null 2>&1
	wm_reload_network
	wm_reload_wifi
}

wm_free_kb() {
	df -k "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

wm_kb_to_mb() {
	awk -v kb="$1" 'BEGIN { printf "%d", (kb + 1023) / 1024 }'
}
