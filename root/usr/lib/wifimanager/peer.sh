#!/bin/sh
# Peer identity announcements and the client-name table.
#
# The wire format is the one Mesh Assistant 2.7.12 uses, so a WiFi Manager node
# and a Mesh Assistant node see each other.  Every datagram is a set of
# newline-separated lines; a receiver understands the oldest line and ignores
# the newer ones it does not know:
#
#   meshassistant/1 <mac> <ip> <hostname>
#   meshassistant/2 <...> <load>
#   meshassistant/3 <mac> <lanmac> <ip> <hostname> <load>
#   meshassistant/4 <...> <state>
#   meshassistant/5 <...> <kind>
#   meshassistant/6 <...> <speed>
#   meshassistant/7 <...> <iface>
#   meshassistant/8 <client mac> <ip|-> <hostname>     (name table, not a peer)
#   meshassistant/9 <...> <memory%> <clients> <mesh id> <channel> <htmode>
#                    <band> <role> <routing algorithm>
#   meshassistant/10 <...> <key set|unset> <encryption>
#
# Version 9 adds the values DESIGN §6.3 compares between nodes: memory use and
# connected clients (topology columns) and the mesh parameters each device
# runs.  Version 10 adds whether the mesh link has a key and which encryption
# it uses.  The key itself is never put on the wire; a device can therefore
# compare that both sides run the same protection, not that the passwords are
# equal.  Equal passwords are proven by the 802.11s peering itself.
# Channel, HT mode and band belong to the radio that carries the hardif;
# the other values repeat on every hardif of the device.  A receiver that does
# not know a line ignores it, so the older versions are still sent.
#
# The product name is WiFi Manager, but the protocol prefix stays
# "meshassistant/" because it is an inter-node wire contract, not UI text.

. /usr/lib/wifimanager/common.sh

WM_LEASES="/tmp/dhcp.leases"
WM_RDNS_CACHE="$WM_RUN_DIR/rdns"
WM_RDNS_TTL="300"
WM_STATION_INACTIVE_MAX="120"

# ---------------------------------------------------------------------------
# Local hardif facts
# ---------------------------------------------------------------------------

# A mac80211 netdev exposes a "phy80211" link in sysfs; an Ethernet port used
# for wired backhaul does not.
hardif_is_wireless() {
	[ -e "/sys/class/net/$1/phy80211" ]
}

# "<iface> <MAC> <kind>" for every batman-adv hardif.  The name is needed by
# the announcement (state/speed belong to that hardif), the MAC identifies the
# local link in the status table, and the medium lets a receiver label a hardif
# it is not a direct neighbor of.
mesh_hardif_bindings() {
	local iface mac kind
	for iface in $(batctl meshif bat0 interface 2>/dev/null |
		sed -n 's/^\([^:]*\):.*/\1/p'); do
		[ -r "/sys/class/net/$iface/address" ] || continue
		mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null)
		[ -n "$mac" ] || continue
		if hardif_is_wireless "$iface"; then
			kind=wlan
		else
			kind=wired
		fi
		printf '%s %s %s\n' "$iface" "$mac" "$kind"
	done
}

mesh_hardif_macs() {
	mesh_hardif_bindings | awk '{ print $2 }'
}

# Best direct link speed per hardif as "batctl n" measures it (Mbit/s).  Only
# the device at one end of a link can measure it, so the announcement carries
# the value to nodes that are not its direct neighbor.
mesh_hardif_speeds() {
	batctl meshif bat0 neighbors 2>/dev/null | awk '
		$3 == "(" && NF >= 5 {
			iface = $NF
			gsub(/[^A-Za-z0-9_.@-]/, "", iface)
			speed = $4
			gsub(/[^0-9.]/, "", speed)
			if (iface != "" && speed ~ /^[0-9]+(\.[0-9]+)?$/)
				if (!(iface in best) || speed + 0 > best[iface] + 0)
					best[iface] = speed
		}
		END {
			for (iface in best)
				print iface, best[iface]
		}'
}

# Local hardifs that carry at least one selected originator ("*" rows of
# "batctl o"; the bracketed trailing field names the local hardif).
mesh_selected_ifaces() {
	batctl meshif bat0 originators 2>/dev/null | awk '
		$1 == "*" && match($0, /\[[^]]*\]$/) {
			iface = substr($0, RSTART + 1, RLENGTH - 2)
			gsub(/^[ \t]+|[ \t]+$/, "", iface)
			if (iface != "")
				print iface
		}'
}

local_hostname() {
	local hostname
	hostname=$(uci -q get system.@system[0].hostname)
	[ -n "$hostname" ] || hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)
	hostname=$(printf '%s' "$hostname" | tr -cd 'A-Za-z0-9._-')
	printf '%s\n' "${hostname:--}"
}

local_load() {
	local load
	load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
	case "$load" in
		''|*[!0-9.]*|*.*.*) load='-' ;;
	esac
	printf '%s\n' "$load"
}

# Memory in use as a percentage, using MemAvailable when the kernel provides
# it.  A device that cannot read /proc/meminfo announces "-", never a zero.
local_memory() {
	local used
	used=$(awk '
		/^MemTotal:/ { total = $2 }
		/^MemAvailable:/ { available = $2 }
		END {
			if (total > 0 && available >= 0)
				printf "%d", int((total - available) * 100 / total + 0.5)
		}' /proc/meminfo 2>/dev/null)
	case "$used" in
		''|*[!0-9]*) printf '%s\n' '-' ;;
		*) printf '%s\n' "$used" ;;
	esac
}

# Clients associated to this device's access points.  Mesh point stations are
# the other routers, not clients, so only AP-mode interfaces are counted.
# A device without iw announces "-" rather than 0.
local_client_count() {
	local iface count total=0

	command -v iw >/dev/null 2>&1 || {
		printf '%s\n' '-'
		return 0
	}

	for iface in $(iw dev 2>/dev/null |
		sed -n 's/^[[:space:]]*Interface[[:space:]]\{1,\}\([^[:space:]]*\)$/\1/p'); do
		iw dev "$iface" info 2>/dev/null | grep -q 'type AP' || continue
		count=$(iw dev "$iface" station dump 2>/dev/null | grep -c '^Station')
		total=$((total + count))
	done
	printf '%s\n' "$total"
}

# The mesh parameters DESIGN §6.3 compares between nodes.  The mesh ID and the
# role are device-wide; the channel and HT mode belong to the radio that
# carries the mesh, which "wifi_radio" names.
local_mesh_id() {
	local mesh_id
	mesh_id=$(uci -q get meshassistant.config.mesh_id)
	mesh_id=$(printf '%s' "$mesh_id" | tr -cd 'A-Za-z0-9_.-')
	printf '%s\n' "${mesh_id:--}"
}

local_mesh_role() {
	local role
	role=$(uci -q get meshassistant.config.role)
	case "$role" in
		server|node|client|off) ;;
		*) role=server ;;
	esac
	printf '%s\n' "$role"
}

local_routing_algo() {
	local algo
	algo=$(uci -q get network.bat0.routing_algo)
	case "$algo" in
		BATMAN_IV|BATMAN_V) ;;
		*) algo=BATMAN_IV ;;
	esac
	printf '%s\n' "$algo"
}

# The radio device behind one hardif, or "-".  The mesh section the driver was
# handed names that radio; a hardif without a matching mesh section (an
# Ethernet backhaul) has no radio.
mesh_hardif_radio() {
	local iface="$1" section device

	for section in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$section.mode")" = mesh ] || continue
		[ "$(uci -q get "wireless.$section.ifname")" = "$iface" ] || continue
		device=$(uci -q get "wireless.$section.device")
		if [ -n "$device" ]; then
			printf '%s\n' "$device"
			return 0
		fi
		break
	done

	printf '%s\n' '-'
}

# "<channel|-> <htmode|-> <band|->" of the radio behind one hardif.
mesh_hardif_radio_facts() {
	local device channel htmode band

	device=$(mesh_hardif_radio "$1")
	if [ "$device" = '-' ]; then
		printf -- '- - -\n'
		return 0
	fi

	channel=$(uci -q get "wireless.$device.channel")
	htmode=$(uci -q get "wireless.$device.htmode")
	band=$(uci -q get "wireless.$device.band")
	case "$band" in
		2g|5g|6g) ;;
		*) band='-' ;;
	esac
	printf '%s %s %s\n' "${channel:--}" "${htmode:--}" "$band"
}

# The client names this device knows: the DHCP lease file plus the static host
# reservations.  Reservations come last so the administrator's name wins for a
# MAC that also has a lease.
#   <MAC> <IPv4|-> <hostname>
local_names() {
	local section mac ip name

	if [ -r "$WM_LEASES" ]; then
		while read -r _ mac ip name _; do
			[ -n "$mac" ] || continue
			[ "$name" = '*' ] && continue
			mac=$(printf '%s' "$mac" | tr 'A-F' 'a-f')
			name=$(printf '%s' "$name" | tr -cd 'A-Za-z0-9._-')
			[ -n "$name" ] || continue
			case "$ip" in
				''|*[!0-9.]*) ip='-' ;;
			esac
			printf '%s %s %s\n' "$mac" "$ip" "$name"
		done <"$WM_LEASES"
	fi

	uci -q show dhcp 2>/dev/null |
		sed -n 's/^\(dhcp\.[^=]*\)=host$/\1/p' |
		while read -r section; do
			[ -n "$section" ] || continue
			mac=$(uci -q get "$section.mac")
			mac=$(printf '%s' "$mac" | tr 'A-F' 'a-f')
			case "$mac" in
				[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
				*) continue ;;
			esac
			name=$(uci -q get "$section.name")
			name=$(printf '%s' "$name" | tr -cd 'A-Za-z0-9._-')
			[ -n "$name" ] || continue
			ip=$(uci -q get "$section.ip")
			case "$ip" in
				''|*[!0-9.]*) ip='-' ;;
			esac
			printf '%s %s %s\n' "$mac" "$ip" "$name"
		done
}

# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

announce_identity() {
	local ip brd hostname load mac lanmac selected speeds iface state speed kind
	local memory clients mesh_id role routing_algo channel htmode band
	local key_state mesh_enc

	command -v socat >/dev/null 2>&1 || return 0

	ip=$(lan_ipv4)
	[ -n "$ip" ] || return 0

	brd=$(lan_broadcast)
	[ -n "$brd" ] || brd=255.255.255.255

	hostname=$(local_hostname)
	load=$(local_load)
	lanmac=$(lan_hwaddr)

	memory=$(local_memory)
	clients=$(local_client_count)
	mesh_id=$(local_mesh_id)
	role=$(local_mesh_role)
	routing_algo=$(local_routing_algo)
	key_state=$(local_mesh_key_state)
	mesh_enc=$(local_mesh_encryption)

	selected=$(mesh_selected_ifaces)
	speeds=$(mesh_hardif_speeds)

	mesh_hardif_bindings | while read -r iface mac kind; do
		[ -n "$mac" ] || continue

		state='-'
		if [ -n "$selected" ]; then
			if printf '%s\n' "$selected" | grep -qx "$iface"; then
				state='inuse'
			else
				state='standby'
			fi
		fi

		speed=$(printf '%s\n' "$speeds" |
			awk -v i="$iface" '$1 == i { print $2; exit }')
		[ -n "$speed" ] || speed='-'

		set -- $(mesh_hardif_radio_facts "$iface")
		channel=${1:--}
		htmode=${2:--}
		band=${3:--}

		{
			printf 'meshassistant/2 %s %s %s %s\n' "$mac" "$ip" "$hostname" "$load"
			[ -n "$lanmac" ] &&
				printf 'meshassistant/3 %s %s %s %s %s\n' \
					"$mac" "$lanmac" "$ip" "$hostname" "$load"
			printf 'meshassistant/4 %s %s %s %s %s %s\n' \
				"$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state"
			printf 'meshassistant/5 %s %s %s %s %s %s %s\n' \
				"$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" "$kind"
			printf 'meshassistant/6 %s %s %s %s %s %s %s %s\n' \
				"$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" \
				"$kind" "$speed"
			printf 'meshassistant/7 %s %s %s %s %s %s %s %s %s\n' \
				"$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" \
				"$kind" "$speed" "$iface"
			printf 'meshassistant/9 %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s\n' \
				"$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" \
				"$kind" "$speed" "$iface" "$memory" "$clients" "$mesh_id" \
				"$channel" "$htmode" "$band" "$role" "$routing_algo"
			printf 'meshassistant/10 %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s\n' \
				"$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" \
				"$kind" "$speed" "$iface" "$memory" "$clients" "$mesh_id" \
				"$channel" "$htmode" "$band" "$role" "$routing_algo" \
				"$key_state" "$mesh_enc"
		} | socat -u - "UDP-DATAGRAM:$brd:$WM_PORT,broadcast" 2>/dev/null
	done
}

# One datagram carries every named client; a node without a lease file has
# nothing to announce.
announce_names() {
	local brd lines

	command -v socat >/dev/null 2>&1 || return 0

	lines=$(local_names)
	[ -n "$lines" ] || return 0

	brd=$(lan_broadcast)
	[ -n "$brd" ] || brd=255.255.255.255

	printf '%s\n' "$lines" |
		sed 's/^/meshassistant\/8 /' |
		socat -u - "UDP-DATAGRAM:$brd:$WM_PORT,broadcast" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Receiving
#
# socat starts one "peer" process per datagram and the daemon prunes the file
# while those processes append to it, so several processes write the file at
# the same time.  Every write takes the same lock on fd 9, released by the
# kernel when the descriptor closes.  Peer and name tables use fd 9 too, but
# are never locked at the same time.
# ---------------------------------------------------------------------------

lock_peers() {
	flock -x 9 2>/dev/null || :
}

lock_names() {
	flock -x 9 2>/dev/null || :
}

peer_append() {
	{
		lock_peers
		printf '%s\n' "$1" >>"$WM_PEERS"
	} 9>>"$WM_PEERS.lock"
}

name_append() {
	{
		lock_names
		printf '%s\n' "$1" >>"$WM_NAMES"
	} 9>>"$WM_NAMES.lock"
}

# Called for every received datagram (the datagram is on stdin).  Stored lines:
#   peers: "<epoch> <mesh MAC> <IPv4|-> <hostname> <load|-> [<LAN MAC|->]
#           [<state>] [<kind>] [<speed|->] [<iface|->] [<memory|->] [<clients|->]
#           [<mesh id|->] [<channel|->] [<htmode|->] [<band|->] [<role|->] [<algo|->]
#           [<key set|unset>] [<encryption>]"
#   names: "<epoch> <client MAC> <IPv4|-> <hostname>"
# Every value comes from the network and is validated before it is stored.
record_peer() {
	local proto rest mac lanmac ip hostname load state kind speed iface ts count
	local memory clients mesh_id channel htmode band role algo key_state mesh_enc

	while read -r proto rest || [ -n "$proto" ]; do
		mac=''
		lanmac=''
		ip=''
		hostname=''
		load=''
		state=''
		kind=''
		speed=''
		iface=''
		memory=''
		clients=''
		mesh_id=''
		channel=''
		htmode=''
		band=''
		role=''
		algo=''
		key_state=''
		mesh_enc=''

		# Split without pathname expansion: the content comes from the
		# network and must not expand a glob.
		set -f
		set -- $rest
		set +f
		count=$#

		case "$proto" in
			meshassistant/1)
				[ "$count" -ge 3 ] || continue
				mac=$1 ip=$2 hostname=$3
				;;
			meshassistant/2)
				[ "$count" -ge 4 ] || continue
				mac=$1 ip=$2 hostname=$3 load=$4
				;;
			meshassistant/3)
				[ "$count" -ge 5 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5
				;;
			meshassistant/4)
				[ "$count" -ge 6 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6
				;;
			meshassistant/5)
				[ "$count" -ge 7 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
				;;
			meshassistant/6)
				[ "$count" -ge 8 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
				speed=$8
				;;
			meshassistant/7)
				[ "$count" -ge 9 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
				speed=$8 iface=$9
				;;
			meshassistant/9)
				[ "$count" -ge 17 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
				speed=$8 iface=$9
				shift 9
				memory=$1 clients=$2 mesh_id=$3 channel=$4 htmode=$5
				band=$6 role=$7 algo=$8
				;;
			meshassistant/10)
				[ "$count" -ge 19 ] || continue
				mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
				speed=$8 iface=$9
				shift 9
				memory=$1 clients=$2 mesh_id=$3 channel=$4 htmode=$5
				band=$6 role=$7 algo=$8
				shift 8
				key_state=$1 mesh_enc=$2
				;;
			meshassistant/8)
				[ "$count" -ge 3 ] || continue
				mac=$1 ip=$2 hostname=$3
				;;
			*) continue ;;
		esac

		mac=$(printf '%s' "$mac" | tr 'A-F' 'a-f')
		case "$mac" in
			[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
			*) continue ;;
		esac

		case "$proto" in
			meshassistant/3|meshassistant/4|meshassistant/5|meshassistant/6|meshassistant/7|meshassistant/9|meshassistant/10)
				lanmac=$(printf '%s' "$lanmac" | tr 'A-F' 'a-f')
				case "$lanmac" in
					[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
					*) lanmac='-' ;;
				esac
				;;
			*) lanmac='' ;;
		esac

		case "$proto" in
			meshassistant/4|meshassistant/5|meshassistant/6|meshassistant/7|meshassistant/9|meshassistant/10)
				case "$state" in
					inuse|standby) ;;
					*) state='-' ;;
				esac
				;;
			*) state='' ;;
		esac

		case "$proto" in
			meshassistant/5|meshassistant/6|meshassistant/7|meshassistant/9|meshassistant/10)
				case "$kind" in
					wlan|wired) ;;
					*) kind='-' ;;
				esac
				;;
			*) kind='' ;;
		esac

		case "$proto" in
			meshassistant/6|meshassistant/7|meshassistant/9|meshassistant/10)
				case "$speed" in
					''|*[!0-9.]*|*.*.*) speed='-' ;;
				esac
				;;
			*) speed='' ;;
		esac

		# Interface names are at most IFNAMSIZ-1 bytes and use only these
		# characters; anything else is a hand-written or corrupt datagram.
		case "$proto" in
			meshassistant/7|meshassistant/9|meshassistant/10)
				case "$iface" in
					''|*[!A-Za-z0-9_.@-]*) iface='-' ;;
				esac
				if [ "$iface" != '-' ] && [ "${#iface}" -gt 15 ]; then
					iface='-'
				fi
				;;
			*) iface='' ;;
		esac

		case "$proto" in
		meshassistant/9|meshassistant/10)
			case "$memory" in
				''|*[!0-9]*) memory='-' ;;
			esac
			if [ "$memory" != '-' ] && [ "$memory" -gt 100 ]; then
				memory='-'
			fi
			case "$clients" in
				''|*[!0-9]*) clients='-' ;;
			esac
			if [ "$clients" != '-' ] && [ "$clients" -gt 100000 ]; then
				clients='-'
			fi
			mesh_id=$(printf '%s' "$mesh_id" | tr -cd 'A-Za-z0-9_.-')
			[ -n "$mesh_id" ] && [ "${#mesh_id}" -le 32 ] || mesh_id='-'
			case "$channel" in
				auto) ;;
				''|*[!0-9]*) channel='-' ;;
			esac
			[ "${#channel}" -le 4 ] || channel='-'
			htmode=$(printf '%s' "$htmode" | tr -cd 'A-Za-z0-9')
			[ -n "$htmode" ] && [ "${#htmode}" -le 10 ] || htmode='-'
			case "$band" in
				2g|5g|6g) ;;
				*) band='-' ;;
			esac
			case "$role" in
				server|node|client|off) ;;
				*) role='-' ;;
			esac
			case "$algo" in
				BATMAN_IV|BATMAN_V) ;;
				*) algo='-' ;;
			esac
			;;
		esac

		if [ "$proto" = 'meshassistant/10' ]; then
			case "$key_state" in
				set|unset) ;;
				*) key_state='-' ;;
			esac
			mesh_enc=$(printf '%s' "$mesh_enc" | tr -cd 'A-Za-z0-9+_-')
			[ -n "$mesh_enc" ] && [ "${#mesh_enc}" -le 20 ] || mesh_enc='-'
		fi

		[ "$ip" = "-" ] && ip=''
		case "$ip" in
			''|*[!0-9.]*) ip='' ;;
		esac

		hostname=$(printf '%s' "$hostname" | tr -cd 'A-Za-z0-9._-')
		[ -n "$hostname" ] || hostname='-'

		load=$(printf '%s' "$load" | tr -cd '0-9.')
		case "$load" in
			''|*.*.*) load='' ;;
		esac

		ts=$(date +%s)
		if [ "$proto" = 'meshassistant/8' ]; then
			name_append "$ts $mac ${ip:--} $hostname"
		elif [ "$proto" = 'meshassistant/10' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind $speed $iface $memory $clients $mesh_id $channel $htmode $band $role $algo $key_state $mesh_enc"
		elif [ "$proto" = 'meshassistant/9' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind $speed $iface $memory $clients $mesh_id $channel $htmode $band $role $algo"
		elif [ "$proto" = 'meshassistant/7' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind $speed $iface"
		elif [ "$proto" = 'meshassistant/6' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind $speed"
		elif [ "$proto" = 'meshassistant/5' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind"
		elif [ "$proto" = 'meshassistant/4' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state"
		elif [ "$proto" = 'meshassistant/3' ]; then
			peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac"
		else
			peer_append "$ts $mac ${ip:--} $hostname ${load:--}"
		fi
	done
}

# The rewrite replaces the file, so it holds the peer lock: a line appended
# between awk reading and the rename would otherwise vanish with the old inode.
# Stored timestamps are the receiver's own clock, so a value after "now" can
# only be a damaged line and is dropped too.
prune_peers() {
	local now tmp
	[ -f "$WM_PEERS" ] || return 0
	now=$(date +%s)
	tmp="$WM_PEERS.$$"
	{
		lock_peers
		if awk -v now="$now" -v max="$WM_PEER_MAX_AGE" \
			'($1 + 0) >= now - max && ($1 + 0) <= now' \
			"$WM_PEERS" >"$tmp" 2>/dev/null; then
			mv "$tmp" "$WM_PEERS"
		else
			rm -f "$tmp"
		fi
	} 9>>"$WM_PEERS.lock"
}

prune_names() {
	local now tmp
	[ -f "$WM_NAMES" ] || return 0
	now=$(date +%s)
	tmp="$WM_NAMES.$$"
	{
		lock_names
		if awk -v now="$now" -v max="$WM_NAME_MAX_AGE" \
			'($1 + 0) >= now - max && ($1 + 0) <= now' \
			"$WM_NAMES" >"$tmp" 2>/dev/null; then
			mv "$tmp" "$WM_NAMES"
		else
			rm -f "$tmp"
		fi
	} 9>>"$WM_NAMES.lock"
}

# ---------------------------------------------------------------------------
# Daemon
# ---------------------------------------------------------------------------

peer_daemon() {
	local listener pidfile="$WM_RUN_DIR/peer.pid"

	if ! command -v socat >/dev/null 2>&1; then
		wm_log "socat is not installed; peer announcements are disabled."
		exit 0
	fi

	wm_init_dirs
	echo $$ >"$pidfile"

	{
		lock_peers
		: >"$WM_PEERS"
	} 9>>"$WM_PEERS.lock"
	{
		lock_names
		: >"$WM_NAMES"
	} 9>>"$WM_NAMES.lock"

	socat -u "UDP-RECVFROM:$WM_PORT,reuseaddr,fork" \
		"EXEC:/usr/lib/wifimanager/worker.sh peer" >/dev/null 2>&1 &
	listener=$!

	cleanup() {
		kill "$listener" 2>/dev/null
		rm -f "$WM_PEERS" "$WM_NAMES" "$pidfile"
	}
	trap 'cleanup; exit 0' INT TERM
	trap 'cleanup' EXIT

	while true; do
		announce_identity
		announce_names
		prune_peers
		prune_names
		sleep "$WM_ANNOUNCE_INTERVAL" &
		wait $!
	done
}

peer_daemon_running() {
	local pid
	pid=$(cat "$WM_RUN_DIR/peer.pid" 2>/dev/null)
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
