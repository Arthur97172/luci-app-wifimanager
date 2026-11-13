#!/bin/sh
# Diagnostics and read-only status for every page.
#
# Each section keeps four kinds of state apart, as DESIGN.MD §11 requires:
#   config  - what UCI says
#   runtime - what the kernel/driver shows right now
#   service - whether the init service is enabled and actually running
#   links   - real link state (batman originators, carrier, station tables)
# A value that cannot be read is omitted or null, never guessed.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/radio.sh
. /usr/lib/wifimanager/roaming.sh
. /usr/lib/wifimanager/peer.sh
. /usr/lib/wifimanager/backhaul.sh
. /usr/lib/wifimanager/backup.sh

diag_int() {
	case "$1" in
		''|*[!0-9]*) printf '0\n' ;;
		*) printf '%s\n' "$1" ;;
	esac
}

svc_init() {
	[ -x "/etc/init.d/$1" ] && printf '%s\n' "/etc/init.d/$1"
}

# service enabled: init script's own answer, 1/0
service_enabled_flag() {
	[ -x "/etc/init.d/$1" ] || { echo 0; return; }
	/etc/init.d/"$1" enabled >/dev/null 2>&1 && echo 1 || echo 0
}

# service running: ubus knows the instance (procd), init status is the fallback.
SERVICE_LIST_CACHE=""
service_running_flag() {
	if [ -z "$SERVICE_LIST_CACHE" ]; then
		SERVICE_LIST_CACHE=$(ubus call service list 2>/dev/null)
	fi
	if [ -n "$SERVICE_LIST_CACHE" ]; then
		if printf '%s' "$SERVICE_LIST_CACHE" | jsonfilter -e "@.$1.instances" >/dev/null 2>&1; then
			echo 1
			return
		fi
	fi
	[ -x "/etc/init.d/$1" ] && /etc/init.d/"$1" status >/dev/null 2>&1 && echo 1 || echo 0
}

# ---------------------------------------------------------------------------
# Raw mesh info for utils/mesh.js (same text formats the 2.7.12 UI parsed)
# ---------------------------------------------------------------------------

# "<kind> ..." lines describing every batman hardif plus this device:
#   state active=1|0
#   local <hostname> <IPv4|-> <load|-> <role> <memory|-> <clients|->
#         <mesh id|-> <channel|-> <htmode|-> <band|-> <routing algo|->
#         <key set|unset> <encryption>
#   radio <hardif> <radio|->   (the wireless device behind the hardif)
#   kind <hardif> wlan|wired [<mac>]
#   iface <hardif> <MHz> <channel> <width MHz>
#   busy <hardif> <percent>
#   peer <hardif> <MAC> <dBm|-> <tx Mbit|-> <rx Mbit|->
# The memory, client and mesh values on the local line are the ones this
# device announces to the other nodes; they are shown next to the announced
# values of the peers so a mismatch is visible on one page.
link_info() {
	local ip have_iw role info link busy channel htmode band mesh_radio radio

	if [ "$(uci -q get meshassistant.config.running)" = 1 ]; then
		printf 'state active=1\n'
	else
		printf 'state active=0\n'
	fi
	ip=$(lan_ipv4)
	role=$(uci -q get meshassistant.config.role)
	role=${role:-server}
	mesh_radio=$(mesh_managed_radio)
	channel='-'
	htmode='-'
	band='-'
	if [ -n "$mesh_radio" ]; then
		channel=$(uci -q get "wireless.$mesh_radio.channel")
		[ -n "$channel" ] || channel='-'
		htmode=$(uci -q get "wireless.$mesh_radio.htmode")
		[ -n "$htmode" ] || htmode='-'
		band=$(uci -q get "wireless.$mesh_radio.band")
		case "$band" in
			2g|5g|6g) ;;
			*) band='-' ;;
		esac
	fi
	printf 'local %s %s %s %s %s %s %s %s %s %s %s %s %s\n' "$(local_hostname)" "${ip:--}" \
		"$(local_load)" "$role" "$(local_memory)" "$(local_client_count)" \
		"$(local_mesh_id)" "$channel" "$htmode" "$band" "$(local_routing_algo)" \
		"$(local_mesh_key_state)" "$(local_mesh_encryption)"

	command -v iw >/dev/null 2>&1 && have_iw=1 || have_iw=0

	batctl meshif bat0 interface 2>/dev/null |
		sed -n 's/^\([^:]*\):.*/\1/p' |
		while read -r iface; do
			[ -n "$iface" ] || continue

			if hardif_is_wireless "$iface"; then
				kind=wlan
			else
				kind=wired
			fi
			mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null)
			if [ -n "$mac" ]; then
				printf 'kind %s %s %s\n' "$iface" "$kind" "$mac"
			else
				printf 'kind %s %s\n' "$iface" "$kind"
			fi
			radio=$(mesh_hardif_radio "$iface")
			printf 'radio %s %s\n' "$iface" "$radio"

			[ "$have_iw" = 1 ] || continue
			# iw prints "channel 37 (6135 MHz), width: 320 MHz".
			info=$(iw dev "$iface" info 2>/dev/null)
			link=$(printf '%s\n' "$info" |
				sed -n 's/.*channel \([0-9][0-9]*\) (\([0-9][0-9]*\) MHz), width: \([0-9][0-9]*\) MHz.*/\2 \1 \3/p' |
				head -n 1)
			if [ -z "$link" ]; then
				link=$(printf '%s\n' "$info" |
					sed -n 's/.*channel [0-9][0-9]* (\([0-9][0-9]*\) MHz).*/\1/p' |
					head -n 1)
			fi
			[ -n "$link" ] && printf 'iface %s %s\n' "$iface" "$link"
			busy=$(iw dev "$iface" survey dump 2>/dev/null | awk '
				/^[[:space:]]*frequency:/ { inuse = ($0 ~ /\[in use\]/); next }
				inuse && /channel active time:/ { active = $4 }
				inuse && /channel busy time:/ { busy = $4 }
				END {
					if (active + 0 > 0)
						printf "%.0f", busy * 100 / active
				}')
			[ -n "$busy" ] && printf 'busy %s %s\n' "$iface" "$busy"
			iw dev "$iface" station dump 2>/dev/null |
				awk -v iface="$iface" '
					function flush() {
						if (mac == "") return
						print "peer " iface " " mac " " sig " " tx " " rx
					}
					/^Station / { flush(); mac = $2; sig = "-"; tx = "-"; rx = "-"; next }
					/^[[:space:]]*signal:/ { sig = $2; next }
					/^[[:space:]]*tx bitrate:/ { tx = $3; next }
					/^[[:space:]]*rx bitrate:/ { rx = $3; next }
					END { flush() }'
		done
}

# AP stations with rate data, one line per station:
#   <iface> <mac> <signal|-> <rx Mbit|-> <tx Mbit|-> <connected s|-> <inactive s|-> <ssid> <section>
# A station silent past WM_STATION_INACTIVE_MAX is still listed here; callers
# that need the live view filter it out (client_info does).
station_lines() {
	local section iface ssid
	for section in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$section.mode")" = ap ] || continue
		[ "$(uci -q get "wireless.$section.disabled")" = 1 ] && continue
		iface=$(uci -q get "wireless.$section.ifname")
		[ -n "$iface" ] || continue
		ssid=$(uci -q get "wireless.$section.ssid")
		iw dev "$iface" station dump 2>/dev/null |
			awk -v i="$iface" -v s="$ssid" -v sec="$section" '
				function flush() {
					if (mac == "") return
					printf "%s %s %s %s %s %s %s %s %s\n", i, mac, sig, rx, tx,
						conn, inact, s, sec
					mac = ""
				}
				/^Station / { flush(); mac = $2; sig = "-"; rx = "-"; tx = "-"; conn = "-"; inact = "-"; next }
				/^[[:space:]]*inactive time:/ { inact = int($3 / 1000); next }
				/^[[:space:]]*signal:/ { sig = $2; next }
				/^[[:space:]]*rx bitrate:/ { rx = $3; next }
				/^[[:space:]]*tx bitrate:/ { tx = $3; next }
				/^[[:space:]]*connected time:/ { conn = $3; next }
				END { flush() }'
	done
}

# Name and address tables used to label clients:
#   $1/localnames  "<mac> <ip|-> <name>"
#   $1/announced   "<mac> <ip|-> <name|->"   (from other mesh nodes)
#   $1/neigh       "<mac> <ip>"
diag_name_files() {
	local dir="$1" mac ip name

	local_names >"$dir/localnames" 2>/dev/null
	: >"$dir/announced"
	if [ -r "$WM_NAMES" ]; then
		while read -r _ mac ip name; do
			[ -n "$mac" ] || continue
			printf '%s %s %s\n' "$mac" "${ip:--}" "${name:--}" >>"$dir/announced"
		done <"$WM_NAMES"
	fi
	: >"$dir/neigh"
	ip -4 neigh show dev "$(lan_device)" 2>/dev/null |
		awk '$2 == "lladdr" { print $3, $1 }' >"$dir/neigh"
}

# Devices attached to this router, one line each for the mesh status view:
#   client <MAC> <iface> <hostname|-> <IPv4|-> <signal|dBm|->
client_info() {
	local br dir
	br=$(lan_device)
	wm_init_dirs
	dir=$(mktemp -d "$WM_RUN_DIR/diag.XXXXXX" 2>/dev/null) || return 1

	station_lines |
		awk -v max="$WM_STATION_INACTIVE_MAX" '($7 == "-" || $7 + 0 <= max)' >"$dir/stations"

	: >"$dir/fdb"
	if command -v bridge >/dev/null 2>&1; then
		bridge fdb show br "$br" 2>/dev/null |
			awk '$2 == "dev" { print $1, $3 }' |
			while read -r mac dev; do
				[ "$dev" = bat0 ] && continue
				[ "$dev" = "$br" ] && continue
				[ -e "/sys/class/net/$dev/phy80211" ] && continue
				printf '%s %s\n' "$mac" "$dev"
			done >"$dir/fdb"
	fi

	diag_name_files "$dir"

	# The wireless station data wins over the bridge entry for the same MAC;
	# local names beat announced names; ARP beats lease and announcement.
	awk '
		FILENAME ~ /stations$/ {
			m = $2
			if (!(m in seen)) {
				seen[m] = 1; ord[++n] = m; ifc[m] = $1; sig[m] = $3
			} else if ($3 + 0 > sig[m] + 0) {
				ifc[m] = $1; sig[m] = $3
			}
			next
		}
		FILENAME ~ /fdb$/ {
			m = $1
			if (!(m in seen)) {
				seen[m] = 1; ord[++n] = m; ifc[m] = $2; sig[m] = "-"
			}
			next
		}
		FILENAME ~ /localnames$/ {
			if ($3 != "-") name[$1] = $3
			if ($2 != "-") lip[$1] = $2
			next
		}
		FILENAME ~ /announced$/ {
			if (!($1 in name) && $3 != "-") name[$1] = $3
			if (!($1 in anip) && $2 != "-") anip[$1] = $2
			next
		}
		FILENAME ~ /neigh$/ { if (!($1 in nip)) nip[$1] = $2; next }
		END {
			for (i = 1; i <= n; i++) {
				m = ord[i]
				ip = (m in nip) ? nip[m] : ((m in lip) ? lip[m] : ((m in anip) ? anip[m] : "-"))
				nm = (m in name) ? name[m] : "-"
				print "client", m, ifc[m], nm, ip, sig[m]
			}
		}' "$dir/stations" "$dir/fdb" "$dir/localnames" "$dir/announced" "$dir/neigh" |
		sort -k4,4 -k2,2

	rm -rf "$dir"
}

# Rich client list for the Wireless → Clients page.  Emitted as complete JSON
# objects from awk so an SSID with quotes or backslashes cannot break the
# document.  Unknown numeric values become null.
clients_json() {
	local br dir
	br=$(lan_device)
	wm_init_dirs
	dir=$(mktemp -d "$WM_RUN_DIR/diag.XXXXXX" 2>/dev/null) || return 1

	station_lines >"$dir/stations"

	: >"$dir/fdb"
	if command -v bridge >/dev/null 2>&1; then
		bridge fdb show br "$br" 2>/dev/null |
			awk '$2 == "dev" { print $1, $3 }' |
			while read -r mac dev; do
				[ "$dev" = bat0 ] && continue
				[ "$dev" = "$br" ] && continue
				[ -e "/sys/class/net/$dev/phy80211" ] && continue
				printf '%s %s\n' "$mac" "$dev"
			done >"$dir/fdb"
	fi

	diag_name_files "$dir"

	printf '{"ok":true,"clients":['
	awk '
		function esc(s,   i, c, out) {
			out = ""
			for (i = 1; i <= length(s); i++) {
				c = substr(s, i, 1)
				if (c == "\\" || c == "\"") out = out "\\" c
				else out = out c
			}
			return out
		}
		function num(v) { return (v == "-" || v == "") ? "null" : v + 0 }
		FILENAME ~ /stations$/ {
			m = $2
			if (!(m in seen)) {
				seen[m] = 1; ord[++n] = m
				ifc[m] = $1; sig[m] = $3; rx[m] = $4; tx[m] = $5
				conn[m] = $6; inact[m] = $7; ssid[m] = $8; sec[m] = $9
			}
			next
		}
		FILENAME ~ /fdb$/ {
			m = $1
			if (!(m in seen)) {
				seen[m] = 1; ord[++n] = m
				ifc[m] = $2; sig[m] = "-"; rx[m] = "-"; tx[m] = "-"
				conn[m] = "-"; inact[m] = "-"; ssid[m] = ""; sec[m] = ""
			}
			next
		}
		FILENAME ~ /localnames$/ {
			if ($3 != "-") name[$1] = $3
			if ($2 != "-") lip[$1] = $2
			next
		}
		FILENAME ~ /announced$/ {
			if (!($1 in name) && $3 != "-") name[$1] = $3
			if (!($1 in anip) && $2 != "-") anip[$1] = $2
			next
		}
		FILENAME ~ /neigh$/ { if (!($1 in nip)) nip[$1] = $2; next }
		END {
			for (i = 1; i <= n; i++) {
				m = ord[i]
				ip = (m in nip) ? nip[m] : ((m in lip) ? lip[m] : ((m in anip) ? anip[m] : "-"))
				nm = (m in name) ? name[m] : "-"
				if (i > 1) printf ","
				printf "{\"mac\":\"%s\",\"iface\":\"%s\",\"hostname\":\"%s\",\"ip\":\"%s\",\"signal\":%s,\"rx_rate\":%s,\"tx_rate\":%s,\"connected\":%s,\"inactive\":%s,\"ssid\":\"%s\",\"section\":\"%s\"}",
					m, esc(ifc[m]), esc(nm), (ip == "-" ? "" : ip),
					num(sig[m]), num(rx[m]), num(tx[m]), num(conn[m]),
					num(inact[m]), esc(ssid[m]), esc(sec[m])
			}
		}' "$dir/stations" "$dir/fdb" "$dir/localnames" "$dir/announced" "$dir/neigh"
	printf ']}\n'

	rm -rf "$dir"
}

# ---------------------------------------------------------------------------
# status / op / mesh status
# ---------------------------------------------------------------------------

op_status_json() {
	local op
	op=$(cat "$WM_OP_FILE" 2>/dev/null)
	case "$op" in
		'{'*'}')
			printf '{"ok":true,"operation":%s}\n' "$op"
			;;
		*)
			printf '{"ok":true,"operation":{"state":"idle","op":"","message":"","started":0,"updated":0}}\n'
			;;
	esac
}

status_json() {
	local mesh_running=0 role radios backup op

	[ "$(uci -q get meshassistant.config.running)" = 1 ] && mesh_running=1
	role=$(uci -q get meshassistant.config.role)
	[ -n "$role" ] || role=server
	radios=$(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p' | wc -l)
	backup=$(backup_status_json)

	printf '{"ok":true,"product":"WiFi Manager","package":"%s","version":"%s",' \
		"$WM_APP" "$WM_VERSION"
	printf '"mesh":{"running":%s,"role":"%s","mesh_radio":"%s"},' \
		"$([ "$mesh_running" = 1 ] && echo true || echo false)" \
		"$role" "$(mesh_managed_radio)"
	printf '"radios":%s,' "$(diag_int "$radios")"
	printf '"backup":%s,' "$backup"
	op=$(op_status_json | sed -n 's/^{"ok":true,"operation":\(.*\)}$/\1/p')
	[ -n "$op" ] || op='{"state":"idle","op":"","message":"","started":0,"updated":0}'
	printf '"op":%s}\n' "$op"
}

mesh_status_json() {
	local peers neighbors originators clients selected hardifs
	local peer_count neighbor_count originator_count client_count
	local bat0_exists=0 bat0_up=0 bat0_mac=""

	peers=$(cat "$WM_PEERS" 2>/dev/null)
	neighbors=$(batctl meshif bat0 neighbors 2>/dev/null)
	originators=$(batctl meshif bat0 originators 2>/dev/null)
	clients=$(client_info 2>/dev/null)
	selected=$(mesh_selected_ifaces)
	hardifs=$(mesh_hardif_bindings | awk '{ print $1 }')

	peer_count=$(printf '%s\n' "$peers" | awk 'NF' | wc -l)
	neighbor_count=$(printf '%s\n' "$neighbors" | awk '$3 == "("' | wc -l)
	originator_count=$(printf '%s\n' "$originators" |
		awk 'NF > 3 && $1 != "Originator" && $1 !~ /^\[/' | wc -l)
	client_count=$(printf '%s\n' "$clients" | awk '$1 == "client"' | wc -l)

	if [ -e /sys/class/net/bat0 ]; then
		bat0_exists=1
		bat0_mac=$(cat /sys/class/net/bat0/address 2>/dev/null)
		[ "$(cat /sys/class/net/bat0/operstate 2>/dev/null)" = up ] && bat0_up=1
	fi

	json_init
	json_add_boolean ok 1
	json_add_object state
	json_add_boolean active "$([ "$(uci -q get meshassistant.config.running)" = 1 ] && echo 1 || echo 0)"
	json_add_string role "$(uci -q get meshassistant.config.role)"
	json_add_string mesh_radio "$(mesh_managed_radio)"
	json_add_string mesh_id "$(uci -q get meshassistant.config.mesh_id)"
	json_close_object
	json_add_object bat0
	json_add_boolean exists "$bat0_exists"
	json_add_boolean up "$bat0_up"
	json_add_string mac "$bat0_mac"
	json_add_array hardifs
	while read -r iface; do
		[ -n "$iface" ] && json_add_string "" "$iface"
	done <<EOF
$hardifs
EOF
	json_close_array
	json_add_array selected
	while read -r iface; do
		[ -n "$iface" ] && json_add_string "" "$iface"
	done <<EOF
$selected
EOF
	json_close_array
	json_close_object
	json_add_string linkinfo "$(link_info)"
	json_add_string peers "$peers"
	json_add_string neighbors "$neighbors"
	json_add_string originators "$originators"
	json_add_string clients "$clients"
	json_add_object counts
	json_add_int peers "$(diag_int "$peer_count")"
	json_add_int neighbors "$(diag_int "$neighbor_count")"
	json_add_int originators "$(diag_int "$originator_count")"
	json_add_int clients "$(diag_int "$client_count")"
	json_close_object
	json_add_object service
	json_add_boolean legacy_installed "$([ -x /etc/init.d/meshassistant ] && echo 1 || echo 0)"
	json_add_boolean legacy_enabled "$(service_enabled_flag meshassistant)"
	json_add_boolean legacy_running "$(service_running_flag meshassistant)"
	json_add_boolean wifimanager_enabled "$(service_enabled_flag wifimanager)"
	json_add_boolean wifimanager_running "$(service_running_flag wifimanager)"
	json_close_object
	json_dump
	echo
}

# ---------------------------------------------------------------------------
# diagnostics sections
# ---------------------------------------------------------------------------

diag_wireless_json() {
	local inv conflicts
	inv=$(radio_inventory_json)
	conflicts=$(printf '%s' "$inv" | jsonfilter -e '@.conflicts' 2>/dev/null)
	[ -n "$conflicts" ] || conflicts='[]'
	printf '{"ok":true,"section":"wireless","inventory":%s,"conflicts":%s,"note":"Runtime fields come from iwinfo/iw; a configured value that cannot be read at runtime is shown as configured and marked stale."}\n' \
		"$inv" "$conflicts"
}

diag_mesh_json() {
	local bat0_exists=0 bat0_up=0 bat0_mac="" hardifs selected peers
	local cfg_running dev carrier speed neighbors originators

	cfg_running=$(uci -q get meshassistant.config.running)
	peers=$(cat "$WM_PEERS" 2>/dev/null | awk 'NF' | wc -l)
	hardifs=$(mesh_hardif_bindings | awk '{ print $1 }')
	selected=$(mesh_selected_ifaces)
	if [ -e /sys/class/net/bat0 ]; then
		bat0_exists=1
		bat0_mac=$(cat /sys/class/net/bat0/address 2>/dev/null)
		[ "$(cat /sys/class/net/bat0/operstate 2>/dev/null)" = up ] && bat0_up=1
	fi

	# batctl tables are collected before json_init: filling the jshn state
	# inside a pipeline would lose it to the subshell.
	neighbors=""
	originators=""
	if [ "$bat0_exists" = 1 ] && command -v batctl >/dev/null 2>&1; then
		neighbors=$(batctl meshif bat0 neighbors 2>/dev/null | awk '
			NR > 1 && $2 ~ /^([0-9a-fA-F][0-9a-fA-F]:){5}/ {
				row = $0
				sub(/^[ \t]+/, "", row)
				print $1 "|" $2 "|" $3 "|" row
			}')
		originators=$(batctl meshif bat0 originators 2>/dev/null | awk '
			NR > 1 && $1 ~ /^([0-9a-fA-F][0-9a-fA-F]:){5}/ {
				row = $0
				sub(/^[ \t]+/, "", row)
				print $1 "|" row
			}')
	fi

	json_init
	json_add_boolean ok 1
	json_add_string section mesh
	json_add_object config
	json_add_string enabled "$(uci -q get meshassistant.config.enabled)"
	json_add_string running "$cfg_running"
	json_add_string role "$(uci -q get meshassistant.config.role)"
	json_add_string mesh_radio "$(mesh_managed_radio)"
	json_add_string mesh_id "$(uci -q get meshassistant.config.mesh_id)"
	json_add_string ap_radios "$(uci -q get meshassistant.config.wifi_radio)"
	json_add_string mlo "$(uci -q get meshassistant.config.mlo)"
	json_add_string wired_backhaul "$(uci -q get meshassistant.config.wired_backhaul)"
	json_close_object
	json_add_object service
	json_add_boolean wifimanager_enabled "$(service_enabled_flag wifimanager)"
	json_add_boolean wifimanager_running "$(service_running_flag wifimanager)"
	json_add_boolean legacy_installed "$([ -x /etc/init.d/meshassistant ] && echo 1 || echo 0)"
	json_add_boolean legacy_enabled "$(service_enabled_flag meshassistant)"
	json_add_boolean legacy_running "$(service_running_flag meshassistant)"
	json_add_boolean batctl "$(command -v batctl >/dev/null 2>&1 && echo 1 || echo 0)"
	json_close_object
	json_add_object runtime
	json_add_boolean bat0_exists "$bat0_exists"
	json_add_boolean bat0_up "$bat0_up"
	json_add_string bat0_mac "$bat0_mac"
	json_add_int peers "$(diag_int "$peers")"
	json_close_object
	json_add_object links
	json_add_array hardifs
	while read -r iface; do
		[ -n "$iface" ] && json_add_string "" "$iface"
	done <<EOF
$hardifs
EOF
	json_close_array
	json_add_array selected
	while read -r iface; do
		[ -n "$iface" ] && json_add_string "" "$iface"
	done <<EOF
$selected
EOF
	json_close_array
	json_close_object
	# Neighbor and originator tables are empty when bat0 is absent or batctl
	# is not installed; the page reports that as "not available", not as an
	# empty mesh.
	json_add_array neighbors
	while IFS='|' read -r iface mac last_seen row; do
		[ -n "$mac" ] || continue
		json_add_object
		json_add_string iface "$iface"
		json_add_string mac "$mac"
		json_add_string last_seen "$last_seen"
		json_add_string detail "$row"
		json_close_object
	done <<EOF
$neighbors
EOF
	json_close_array
	json_add_array originators
	while IFS='|' read -r originator row; do
		[ -n "$originator" ] || continue
		json_add_object
		json_add_string originator "$originator"
		json_add_string detail "$row"
		json_close_object
	done <<EOF
$originators
EOF
	json_close_array
	# The backhaul runtime is reported here as well, so the mesh page shows
	# why the wired link is or is not used without opening a second page.
	backhaul_state_load || :
	dev=$(backhaul_wired_device)
	carrier=$(backhaul_carrier_state "$dev")
	speed=$(wired_link_speed "$dev" 2>/dev/null)
	case "$speed" in
		''|*[!0-9]*) speed=0 ;;
	esac
	json_add_object backhaul
	json_add_boolean auto "$(backhaul_auto_enabled && echo 1 || echo 0)"
	json_add_boolean running "$(backhaul_running && echo 1 || echo 0)"
	json_add_string pref "$(uci -q get meshassistant.config.backhaul_pref)"
	json_add_object wired
	json_add_string device "$dev"
	json_add_string carrier "$carrier"
	json_add_int negotiated_mbit "$(diag_int "$speed")"
	json_close_object
	json_add_object wireless
	json_add_boolean healthy "$(backhaul_wireless_healthy && echo 1 || echo 0)"
	json_close_object
	json_add_string active "${BACKHAUL_ACTIVE:-}"
	json_add_object last_switch
	json_add_int ts "$(diag_int "${BACKHAUL_LAST_SWITCH:-0}")"
	json_add_string from "$BACKHAUL_LAST_FROM"
	json_add_string to "$BACKHAUL_LAST_TO"
	json_add_string reason "$BACKHAUL_LAST_REASON"
	json_close_object
	json_add_string last_error "$BACKHAUL_LAST_ERROR"
	json_close_object
	json_add_object checks
	# Configured as running but no bat0 is a real mismatch, not a UI state.
	json_add_boolean config_runtime_mismatch "$([ "$cfg_running" = 1 ] && [ "$bat0_exists" = 0 ] && echo 1 || echo 0)"
	# Both the legacy daemon and ours running means two managers fight.
	json_add_boolean legacy_conflict "$([ "$(service_running_flag meshassistant)" = 1 ] && [ "$(service_running_flag wifimanager)" = 1 ] && echo 1 || echo 0)"
	json_close_object
	json_dump
	echo
}

diag_roaming_json() {
	local caps interfaces ev_count ev_last

	caps=$(roaming_capabilities_json)
	interfaces=$(roaming_ifaces_json)
	ev_count=0
	ev_last=""
	if [ -f "$WM_EVENTS" ]; then
		ev_count=$(wc -l <"$WM_EVENTS" 2>/dev/null)
		ev_last=$(tail -n 1 "$WM_EVENTS" 2>/dev/null | jsonfilter -e '@.ts' 2>/dev/null)
	fi

	printf '{"ok":true,"section":"roaming","capabilities":%s,"interfaces":%s,"events":{"count":%s,"last":%s}}\n' \
		"$caps" "$interfaces" "$(diag_int "$ev_count")" \
		"$(case "$ev_last" in ''|*[!0-9]*) echo null ;; *) echo "$ev_last" ;; esac)"
}

# Assign one opaque group index per distinct secret within this call.  Only the
# index leaves the function: the key, the passphrase and even a hash of them are
# never written to the JSON, the log or an archive.
roaming_key_group() { # section mapfile salt
	local section="$1" map="$2" salt="$3"
	local secret auth hash group

	secret=$(uci -q get "wireless.$section.key")
	[ -n "$secret" ] || secret=$(uci -q get "wireless.$section.sae_password")
	auth=$(uci -q get "wireless.$section.auth_secret")
	[ -n "$secret$auth" ] || return 0

	hash=$(printf '%s\n%s\n%s\n' "$salt" "$secret" "$auth" | sha256sum 2>/dev/null | cut -c1-64)
	[ -n "$hash" ] || return 1

	group=$(awk -v h="$hash" '$1 == h { print $2; exit }' "$map" 2>/dev/null)
	if [ -z "$group" ]; then
		group=$(( $(wc -l <"$map" 2>/dev/null | tr -d ' ') + 1 ))
		printf '%s %s\n' "$hash" "$group" >>"$map"
	fi
	printf '%s\n' "$group"
}

# Per-AP-interface 802.11k/v/r view: configured flags plus whether wpad can do
# 802.11v at all.  The BSSID and the interface state come from the running
# system when the configuration does not pin them; the key group lets the
# advice compare secrets without exposing them.
roaming_ifaces_json() {
	local keymap salt section ifname bssid group secret

	keymap=$(mktemp /tmp/wifimanager-keys.XXXXXX 2>/dev/null)
	salt=$(printf '%s' "$$-$(date +%s)" | sha256sum 2>/dev/null | cut -c1-16)
	[ -n "$salt" ] || salt="$$"

	json_init
	json_add_array interfaces
	for section in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$section.mode")" = ap ] || continue
		ifname=$(iface_runtime_ifname "$section")
		bssid=$(uci -q get "wireless.$section.bssid")
		[ -n "$bssid" ] || bssid=$(cat "/sys/class/net/${ifname:-none}/address" 2>/dev/null)
		secret=$(uci -q get "wireless.$section.key")
		[ -n "$secret" ] || secret=$(uci -q get "wireless.$section.sae_password")
		[ -n "$secret" ] || secret=$(uci -q get "wireless.$section.auth_secret")
		group=""
		if [ -n "$keymap" ] && [ -n "$secret" ]; then
			group=$(roaming_key_group "$section" "$keymap" "$salt")
		fi

		json_add_object
		json_add_string section "$section"
		json_add_string ssid "$(uci -q get "wireless.$section.ssid")"
		json_add_string ifname "$ifname"
		json_add_boolean up "$([ -n "$ifname" ] && iface_runtime_up "$ifname" && echo 1 || echo 0)"
		json_add_string bssid "$bssid"
		json_add_boolean k "$([ "$(uci -q get "wireless.$section.ieee80211k")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean v "$([ "$(uci -q get "wireless.$section.bss_transition")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean r "$([ "$(uci -q get "wireless.$section.ieee80211r")" = 1 ] && echo 1 || echo 0)"
		json_add_string mobility_domain "$(uci -q get "wireless.$section.mobility_domain")"
		json_add_boolean ft_over_ds "$([ "$(uci -q get "wireless.$section.ft_over_ds")" = 1 ] && echo 1 || echo 0)"
		json_add_string encryption "$(uci -q get "wireless.$section.encryption")"
		json_add_string ieee80211w "$(uci -q get "wireless.$section.ieee80211w")"
		json_add_string auth_server "$(uci -q get "wireless.$section.auth_server")"
		json_add_string auth_port "$(uci -q get "wireless.$section.auth_port")"
		json_add_string key_file "$(uci -q get "wireless.$section.wpa_psk_file")"
		json_add_boolean key_set "$([ -n "$secret" ] && echo 1 || echo 0)"
		[ -n "$group" ] && json_add_int key_group "$group"
		json_close_object
	done
	json_close_array
	json_dump
	echo

	[ -n "$keymap" ] && rm -f "$keymap"
}

diag_system_json() {
	local hostname load1 load5 load15 mem_total mem_free mem_avail uptime
	local release

	hostname=$(local_hostname)
	load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
	load5=$(cut -d' ' -f2 /proc/loadavg 2>/dev/null)
	load15=$(cut -d' ' -f3 /proc/loadavg 2>/dev/null)
	mem_total=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)
	mem_free=$(awk '/^MemFree:/ { print $2 }' /proc/meminfo 2>/dev/null)
	mem_avail=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null)
	[ -n "$mem_avail" ] || mem_avail=$mem_free
	uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)
	release=$(ubus call system board 2>/dev/null | jsonfilter -e '@.release.description' 2>/dev/null)
	[ -n "$release" ] || release=$(sed -n "s/^DISTRIB_DESCRIPTION='\(.*\)'/\1/p" /etc/openwrt_release 2>/dev/null)

	json_init
	json_add_boolean ok 1
	json_add_string section system
	json_add_string hostname "$hostname"
	json_add_string release "$release"
	json_add_string kernel "$(uname -r 2>/dev/null)"
	json_add_int cpus "$(diag_int "$(grep -c '^cpu[0-9]' /proc/stat 2>/dev/null)")"
	json_add_int uptime "$(diag_int "${uptime%%.*}")"
	json_add_object load
	json_add_string m1 "${load1:--}"
	json_add_string m5 "${load5:--}"
	json_add_string m15 "${load15:--}"
	json_close_object
	json_add_object memory
	json_add_int total_kb "$(diag_int "$mem_total")"
	json_add_int free_kb "$(diag_int "$mem_free")"
	json_add_int available_kb "$(diag_int "$mem_avail")"
	json_close_object
	json_add_array services
	local svc
	for svc in network firewall dnsmasq odhcpd wpad hostapd dawn meshassistant wifimanager; do
		json_add_object
		json_add_string name "$svc"
		json_add_boolean installed "$([ -x "/etc/init.d/$svc" ] && echo 1 || echo 0)"
		json_add_boolean enabled "$(service_enabled_flag "$svc")"
		json_add_boolean running "$(service_running_flag "$svc")"
		json_close_object
	done
	json_close_array
	# Devices that currently carry the WAN side.  The backhaul editor keeps
	# them out of the wired-port list so a WAN port cannot be moved to bat0.
	json_add_array wan_devices
	local netdev
	for netdev in $(wan_network_devices); do
		json_add_string "" "$netdev"
	done
	json_close_array
	json_add_array interfaces
	local addr bridge speed lan_dev
	lan_dev=$(lan_device)
	for netdev in $(ls /sys/class/net 2>/dev/null | sort); do
		bridge=$(port_bridge "$netdev")
		speed=$(wired_link_speed "$netdev" 2>/dev/null)
		json_add_object
		json_add_string name "$netdev"
		json_add_boolean up "$([ "$(cat "/sys/class/net/$netdev/operstate" 2>/dev/null)" = up ] && echo 1 || echo 0)"
		json_add_string mac "$(cat "/sys/class/net/$netdev/address" 2>/dev/null)"
		# The backhaul editor marks the LAN bridge members it may move to
		# bat0 and refuses the ports that belong to any other bridge.
		json_add_string bridge "$bridge"
		json_add_boolean lan_bridge "$([ -n "$bridge" ] && [ "$bridge" = "$lan_dev" ] && echo 1 || echo 0)"
		json_add_int speed "$(diag_int "$speed")"
		json_add_array addresses
		for addr in $(ip -4 -o addr show dev "$netdev" 2>/dev/null |
			awk '{ split($4, a, "/"); print a[1] }'); do
			json_add_string "" "$addr"
		done
		json_close_array
		json_close_object
	done
	json_close_array
	json_dump
	echo
}

diagnostics_json() { # section
	case "$1" in
		wireless) diag_wireless_json ;;
		mesh) diag_mesh_json ;;
		roaming) diag_roaming_json ;;
		system) diag_system_json ;;
		*) wm_error E-ARG "Unknown diagnostics section." ;;
	esac
}

# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

logs_json() { # name [lines]
	local name="$1" lines="${2:-200}" src="" body=""

	case "$lines" in
		''|*[!0-9]*) lines=200 ;;
	esac
	[ "$lines" -gt 1000 ] && lines=1000
	[ "$lines" -lt 1 ] && lines=100

	# Text is collected first: filling the jshn state inside a pipeline
	# subshell would be lost.
	case "$name" in
		wifimanager) src="$WM_LOG" ;;
		events) src="$WM_EVENTS" ;;
		dawn) body=$(logread -e dawn 2>/dev/null | tail -n "$lines") ;;
		syslog) body=$(logread 2>/dev/null | tail -n "$lines") ;;
		*) wm_error E-ARG "Unknown log name."; return ;;
	esac

	if [ -n "$src" ]; then
		[ -f "$src" ] || {
			wm_error E-NOTFOUND "The log file does not exist."
			return
		}
		body=$(tail -n "$lines" "$src" 2>/dev/null)
	fi

	json_init
	json_add_boolean ok 1
	json_add_string name "$name"
	json_add_array lines
	while IFS= read -r line; do
		json_add_string "" "$line"
	done <<EOF
$body
EOF
	json_close_array
	json_dump
	echo
}
