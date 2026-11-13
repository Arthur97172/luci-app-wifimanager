#!/bin/sh
# Radio inventory and allocation checks.
#
# Everything here reports what UCI has configured and what the kernel/driver
# currently shows; when a value cannot be read it is omitted, never guessed.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/capabilities.sh

# An inventory call reads many options of every radio and interface.  uci is a
# fork per lookup, so read the whole wireless config once and resolve options
# from that text; the cache lives for one RPC process only.
WM_WIRELESS_SHOW_READY=""
WM_WIRELESS_SHOW=""

wm_wireless_show() {
	if [ -z "$WM_WIRELESS_SHOW_READY" ]; then
		WM_WIRELESS_SHOW_READY=1
		WM_WIRELESS_SHOW=$(uci -q show wireless 2>/dev/null)
	fi
	printf '%s\n' "$WM_WIRELESS_SHOW"
}

# wm_wireless_get <section>.<option> -> the configured value (empty when unset).
# Callers that read many options should prime the cache with
# "wm_wireless_show >/dev/null" first; without it the lookup reads uci directly
# so a value written earlier in the same process is never missed.
wm_wireless_get() {
	local want="wireless.$1=" value pre post
	[ -n "$WM_WIRELESS_SHOW_READY" ] || {
		uci -q get "wireless.$1"
		return
	}
	case "$WM_WIRELESS_SHOW" in
		*"$want"*) ;;
		*) return 1 ;;
	esac
	# Cut at the first occurrence of the option name and then at the end of
	# that line; a shell read loop over the whole config was measurably slower
	# than two parameter expansions per lookup.
	value=${WM_WIRELESS_SHOW#*"$want"}
	value=${value%%"
"*}
	# uci show single-quotes the value and escapes an embedded quote as '\''.
	value=${value#\'}
	value=${value%\'}
	while :; do
		case "$value" in
			*"'\\''"*)
				pre=${value%%"'\''"*}; post=${value#*"'\\''"}
				value=$pre"'"$post
				;;
			*) break ;;
		esac
	done
	printf '%s\n' "$value"
}

# wm_wireless_sections <type> -> the section names of that type.
# Parsed in the shell: listing sections is done on every inventory and does not
# need a sed fork for a 100-line file.
wm_wireless_sections() {
	local type="$1" line name
	while IFS= read -r line; do
		case "$line" in
			wireless.*"=$type")
				name=${line#wireless.}
				printf '%s\n' "${name%"=$type"}"
				;;
		esac
	done <<EOF
$(wm_wireless_show)
EOF
}

# Device-to-interface mapping, built once per shell.  The inventory asks for
# the interfaces of each radio several times; building this in a subshell each
# time repeated the scan for every call.
wm_iface_radio_map() {
	local line section devs dev
	if [ -n "$WM_IFACE_RADIO_MAP_READY" ]; then
		printf '%s' "$WM_IFACE_RADIO_MAP"
		return 0
	fi
	WM_IFACE_RADIO_MAP_READY=1
	while IFS= read -r line; do
		case "$line" in
			wireless.*.device=*)
				section=${line#wireless.}
				section=${section%%.device=*}
				devs=${line#wireless.*.device=}
				devs=${devs#\'}
				devs=${devs%\'}
				for dev in $devs; do
					WM_IFACE_RADIO_MAP="$WM_IFACE_RADIO_MAP$dev $section
"
				done
				;;
		esac
	done <<EOF
$(wm_wireless_show)
EOF
	printf '%s' "$WM_IFACE_RADIO_MAP"
}

radio_band() { # uci radio name
	local dev="$1" band channel hwmode
	band=$(wm_wireless_get "$dev.band")
	[ -n "$band" ] && {
		echo "$band"
		return
	}
	hwmode=$(wm_wireless_get "$dev.hwmode")
	channel=$(wm_wireless_get "$dev.channel")
	case "$hwmode" in
		11a) echo 5g; return ;;
		11g|11b) echo 2g; return ;;
	esac
	case "$channel" in
		''|auto) echo ''; return ;;
	esac
	if [ "$channel" -le 14 ] 2>/dev/null; then echo 2g; else echo 5g; fi
}

radio_phy() { # uci radio name -> phyN when it can be mapped
	local dev="$1" path mac phy target
	path=$(wm_wireless_get "$dev.path")
	mac=$(wm_wireless_get "$dev.macaddr" | tr 'A-F' 'a-f')
	for phy in /sys/class/ieee80211/*; do
		[ -e "$phy" ] || continue
		phy=${phy##*/}
		if [ -n "$mac" ]; then
			target=$(cat "/sys/class/ieee80211/$phy/macaddress" 2>/dev/null | tr 'A-F' 'a-f')
			[ "$target" = "$mac" ] && {
				echo "$phy"
				return 0
			}
		fi
		if [ -n "$path" ]; then
			target=$(readlink -f "/sys/class/ieee80211/$phy/device" 2>/dev/null)
			case "$target" in
				*/"$path") echo "$phy"; return 0 ;;
			esac
		fi
	done
	# Single-radio devices: the mapping is unambiguous.
	set -- /sys/class/ieee80211/phy*
	if [ "$#" -eq 1 ] && [ -e "$1" ]; then
		basename "$1"
		return 0
	fi
	return 1
}

iface_runtime_up() {
	ip -o link show "$1" 2>/dev/null | grep -q 'state UP\|,UP'
}

# netifd reports the UCI section name next to the driver-assigned interface
# name.  Modern mac80211 ignores an empty wifi-iface ifname and names the netdev
# itself, so runtime lookups cannot rely on the configured option.
iface_runtime_map() {
	local status dev sections names count i section name
	if [ "${WM_IFACE_RUNTIME_READY:-0}" = 1 ]; then
		printf '%s' "$WM_IFACE_RUNTIME_MAP"
		return 0
	fi
	WM_IFACE_RUNTIME_READY=1
	WM_IFACE_RUNTIME_MAP=""
	status=$(ubus call network.wireless status 2>/dev/null)
	[ -n "$status" ] || return 1
	for dev in $(wm_wireless_sections wifi-device); do
		case "$dev" in
			''|*[!A-Za-z0-9_]*) continue ;;
		esac
		sections=$(printf '%s' "$status" |
			jsonfilter -e "@.$dev.interfaces[*].section" 2>/dev/null)
		names=$(printf '%s' "$status" |
			jsonfilter -e "@.$dev.interfaces[*].ifname" 2>/dev/null)
		count=$(printf '%s\n' "$sections" | grep -c .)
		i=1
		while [ "$i" -le "$count" ]; do
			section=$(printf '%s\n' "$sections" | sed -n "${i}p")
			name=$(printf '%s\n' "$names" | sed -n "${i}p")
			[ -n "$section" ] && [ -n "$name" ] &&
				WM_IFACE_RUNTIME_MAP="${WM_IFACE_RUNTIME_MAP}${section} ${name}
"
			i=$((i + 1))
		done
	done
	printf '%s' "$WM_IFACE_RUNTIME_MAP"
}

iface_runtime_forget() {
	WM_IFACE_RUNTIME_READY=0
	WM_IFACE_RUNTIME_MAP=""
}

iface_runtime_ifname() { # section -> runtime name, configured name as fallback
	local section="$1" name
	name=$(iface_runtime_map | awk -v s="$section" '$1 == s { print $2; exit }')
	[ -n "$name" ] && {
		printf '%s\n' "$name"
		return 0
	}
	wm_wireless_get "$section.ifname"
}

iface_station_count() {
	[ -n "$1" ] || {
		echo 0
		return
	}
	iw dev "$1" station dump 2>/dev/null | grep -c '^Station'
}

# "<signal dBm|-> <tx Mbit|-> <rx Mbit|->" of the station with the strongest
# signal on one netdev.  The page shows one line per interface, so the
# strongest station is reported instead of an average that would invent a
# value; a netdev without stations reports dashes.
iface_station_summary() {
	[ -n "$1" ] || {
		printf -- '- - -\n'
		return
	}
	iw dev "$1" station dump 2>/dev/null | awk '
		BEGIN { best = ""; btx = "-"; brx = "-" }
		function flush() {
			if (mac == "") return
			if (sig ~ /^-?[0-9]+$/ && (best == "" || sig + 0 > best + 0)) {
				best = sig; btx = tx; brx = rx
			}
			mac = ""
		}
		/^Station / { flush(); mac = $2; sig = "-"; tx = "-"; rx = "-"; next }
		/^[[:space:]]*signal:/ { sig = $2; next }
		/^[[:space:]]*tx bitrate:/ { tx = $3; next }
		/^[[:space:]]*rx bitrate:/ { rx = $3; next }
		END {
			flush()
			if (best == "")
				print "- - -"
			else
				print best " " btx " " brx
		}'
}

iface_runtime_info() { # ifname -> "channel txpower"
	local ifname="$1" info channel txpower
	[ -n "$ifname" ] || return 0
	# One iwinfo call answers both values; the driver info is collected once
	# per radio and iwinfo is not cheap on a router.
	info=$(iwinfo "$ifname" info 2>/dev/null)
	channel=$(printf '%s\n' "$info" |
		sed -n 's/.*Channel: \([0-9][0-9]*\).*/\1/p' | head -n 1)
	if [ -z "$channel" ]; then
		channel=$(iw dev "$ifname" info 2>/dev/null |
			sed -n 's/.*channel \([0-9][0-9]*\).*/\1/p' | head -n 1)
	fi
	txpower=$(printf '%s\n' "$info" |
		sed -n 's/.*Tx-Power: \([0-9][0-9]*\) dBm.*/\1/p' | head -n 1)
	printf '%s %s\n' "${channel:--}" "${txpower:--}"
}

# iface_station_stats <ifname> -> "<count> <signal|-> <tx|-> <rx|->".
# One "station dump" per interface; asking for the count and the summary in
# separate calls reads the station table twice.
iface_station_stats() {
	local dump count summary
	if [ -z "$1" ]; then
		printf '0 - - -\n'
		return
	fi
	dump=$(iw dev "$1" station dump 2>/dev/null)
	count=$(printf '%s\n' "$dump" | grep -c '^Station')
	summary=$(printf '%s\n' "$dump" | awk '
		BEGIN { best = ""; btx = "-"; brx = "-" }
		function flush() {
			if (mac == "") return
			if (sig ~ /^-?[0-9]+$/ && (best == "" || sig + 0 > best + 0)) {
				best = sig; btx = tx; brx = rx
			}
			mac = ""
		}
		/^Station / { flush(); mac = $2; sig = "-"; tx = "-"; rx = "-"; next }
		/^[[:space:]]*signal:/ { sig = $2; next }
		/^[[:space:]]*tx bitrate:/ { tx = $3; next }
		/^[[:space:]]*rx bitrate:/ { rx = $3; next }
		END {
			flush()
			if (best == "")
				print "- - -"
			else
				print best " " btx " " brx
		}')
	printf '%s %s\n' "$count" "$summary"
}

iface_names_of_radio() { # uci radio name
	local dev="$1" name section
	while read -r name section; do
		[ "$name" = "$dev" ] && printf '%s\n' "$section"
	done <<EOF
$(wm_iface_radio_map)
EOF
}

iface_ifname() { # uci iface section
	wm_wireless_get "$1.ifname"
}

# Mesh-owned wifi-iface detection (kept in sync with docs/04 §5).
iface_is_mesh_owned() { # section
	local sec="$1" network mesh_id
	case "$sec" in
		mesh_radio*|wifi_ap_*|mesh_*) return 0 ;;
	esac
	mesh_id=$(wm_wireless_get "$sec.mesh_id")
	[ -n "$mesh_id" ] && return 0
	network=$(wm_wireless_get "$sec.network")
	case " $network " in
		*mesh_batman*) return 0 ;;
	esac
	return 1
}

iface_is_mlo() {
	local sec="$1" mlo devices
	mlo=$(wm_wireless_get "$sec.mlo")
	[ "$mlo" = 1 ] && return 0
	devices=$(wm_wireless_get "$sec.device")
	case "$devices" in
		*' '*) return 0 ;;
	esac
	return 1
}

radio_usage_collect() { # emits "radio|mode|section" lines
	local dev section mode device d
	for dev in $(wm_wireless_sections wifi-device); do
		for section in $(iface_names_of_radio "$dev"); do
			# A disabled section is not carried by the radio at runtime, so it
			# must not make the concurrency checks report a clash.
			[ "$(wm_wireless_get "$section.disabled")" = 1 ] && continue
			mode=$(wm_wireless_get "$section.mode")
			[ -n "$mode" ] || mode=ap
			printf '%s|%s|%s\n' "$dev" "$mode" "$section"
		done
	done
}

# cap_counts_for <radio> <section to leave out> <mode to add>
# -> "ap=<n>;sta=<n>;mesh=<n>;adhoc=<n>" for the interfaces the radio would
# carry, including the one being edited and ignoring disabled sections.
cap_counts_for() {
	local dev="$1" skip="$2" add="$3" section mode
	local ap=0 sta=0 mesh=0 adhoc=0

	for section in $(iface_names_of_radio "$dev"); do
		[ "$section" = "$skip" ] && continue
		[ "$(wm_wireless_get "$section.disabled")" = 1 ] && continue
		mode=$(wm_wireless_get "$section.mode")
		[ -n "$mode" ] || mode=ap
		case "$mode" in
			ap) ap=$((ap + 1)) ;;
			sta) sta=$((sta + 1)) ;;
			mesh) mesh=$((mesh + 1)) ;;
			adhoc) adhoc=$((adhoc + 1)) ;;
		esac
	done
	case "$add" in
		ap) ap=$((ap + 1)) ;;
		sta) sta=$((sta + 1)) ;;
		mesh) mesh=$((mesh + 1)) ;;
		adhoc) adhoc=$((adhoc + 1)) ;;
	esac
	printf 'ap=%s;sta=%s;mesh=%s;adhoc=%s\n' "$ap" "$sta" "$mesh" "$adhoc"
}

# radio_conflict_emit <code> <message format> <format arguments>
radio_conflict_emit() {
	local code="$1" message="$2" detail="$3"
	json_add_object
	json_add_string code "$code"
	case "$code" in
		E-*) json_add_string severity error ;;
		*) json_add_string severity warning ;;
	esac
	json_add_string message "$(printf "$message" $detail)"
	json_add_string detail "$detail"
	json_close_object
}

# radio_channel_is_dfs <channel>
radio_channel_is_dfs() {
	case "$1" in
		''|auto|*[!0-9]*) return 1 ;;
	esac
	{ [ "$1" -ge 52 ] && [ "$1" -le 64 ]; } ||
		{ [ "$1" -ge 100 ] && [ "$1" -le 144 ]; }
}

# radio_channel_conflicts_json <radio>...
# Adds W-CHAN-01/W-CHAN-02 conflicts that involve at least one of the named
# radios, then prints how many were added.  With no arguments every radio is
# examined; the inventory uses that form, while the save check passes the
# radios being edited so it does not repeat warnings about another pair.
radio_channel_conflicts_json() {
	local selected="$*" dev spec channel c1 c2 d1 d2 devs found=0 involves

	devs=$(wm_wireless_sections wifi-device)

	for dev in $devs; do
		if [ -n "$selected" ]; then
			case " $selected " in
				*" $dev "*) ;;
				*) continue ;;
			esac
		fi
		spec=$(uci -q get "meshassistant.config.spectrum_${dev}_channel")
		channel=$(wm_wireless_get "$dev.channel")
		if [ -n "$spec" ] && [ "$spec" != auto ] && [ -n "$channel" ] &&
			[ "$channel" != auto ] && [ "$spec" != "$channel" ]; then
			radio_conflict_emit W-CHAN-01 \
				"Radio '%s' uses channel %s but the mesh spectrum profile asks for %s." "$dev $channel $spec"
			found=$((found + 1))
		fi
	done

	for d1 in $devs; do
		for d2 in $devs; do
			[ "$d1" \< "$d2" ] || continue
			[ "$(radio_band "$d1")" = 2g ] || continue
			[ "$(radio_band "$d2")" = 2g ] || continue
			involves=1
			if [ -n "$selected" ]; then
				involves=0
				case " $selected " in
					*" $d1 "*|*" $d2 "*) involves=1 ;;
				esac
				[ "$involves" = 1 ] || continue
			fi
			c1=$(wm_wireless_get "$d1.channel")
			c2=$(wm_wireless_get "$d2.channel")
			case "$c1$c2" in *[!0-9]*) continue ;; esac
			local diff=$((c1 - c2))
			[ "$diff" -lt 0 ] && diff=$((-diff))
			if [ "$diff" -ge 1 ] && [ "$diff" -le 4 ]; then
				radio_conflict_emit W-CHAN-02 \
					"Radios '%s' and '%s' use overlapping 2.4 GHz channels %s and %s." "$d1 $d2 $c1 $c2"
				found=$((found + 1))
			fi
		done
	done

	printf '%s\n' "$found"
}

# radio_mlo_dfs_conflicts_json <radio>...
# Adds W-CHAN-03 for each named radio that is on a DFS channel, then prints how
# many were added.  The caller decides which radios belong to an MLO link.
radio_mlo_dfs_conflicts_json() {
	local dev channel found=0

	for dev in "$@"; do
		channel=$(wm_wireless_get "$dev.channel")
		if radio_channel_is_dfs "$channel"; then
			radio_conflict_emit W-CHAN-03 \
				"MLO link on radio '%s' uses DFS channel %s; CAC may delay the link." "$dev $channel"
			found=$((found + 1))
		fi
	done

	printf '%s\n' "$found"
}

radio_inventory_json() {
	local dev section mode devices band channel htmode txpower disabled phy
	local ifname runtime_ifname up stations signal tx_rate rx_rate
	local ch_runtime tx_runtime meshrunning net
	local ifaces_json radios_count=0

	meshrunning=0
	[ "$(uci -q get meshassistant.config.running)" = 1 ] && meshrunning=1

	json_init
	json_add_boolean ok 1
	json_add_string version "$WM_VERSION"
	json_add_array radios

	for dev in $(wm_wireless_sections wifi-device); do
		radios_count=$((radios_count + 1))
		band=$(radio_band "$dev")
		channel=$(wm_wireless_get "$dev.channel")
		htmode=$(wm_wireless_get "$dev.htmode")
		txpower=$(wm_wireless_get "$dev.txpower")
		disabled=$(wm_wireless_get "$dev.disabled")
		phy=$(radio_phy "$dev")
		runtime_ifname=""
		for section in $(iface_names_of_radio "$dev"); do
			[ -n "$runtime_ifname" ] && break
			runtime_ifname=$(iface_runtime_ifname "$section")
		done
		set -- $(iface_runtime_info "$runtime_ifname")
		ch_runtime="$1"
		tx_runtime="$2"
		up=0
		[ -n "$runtime_ifname" ] && iface_runtime_up "$runtime_ifname" && up=1

		json_add_object
		json_add_string name "$dev"
		json_add_string band "$band"
		json_add_string channel "${channel:-}"
		json_add_string htmode "${htmode:-}"
		json_add_string txpower "${txpower:-}"
		json_add_boolean disabled "$([ "$disabled" = 1 ] && echo 1 || echo 0)"
		json_add_string phy "${phy:-}"
		json_add_string path "$(wm_wireless_get "$dev.path")"
		capability_json_add "$phy"
		json_add_boolean up "$([ "$up" = 1 ] && echo 1 || echo 0)"
		json_add_string runtime_channel "${ch_runtime:--}"
		json_add_string runtime_txpower "${tx_runtime:--}"
		json_add_array interfaces
		for section in $(iface_names_of_radio "$dev"); do
			json_add_string "" "$section"
		done
		json_close_array
		json_close_object
	done
	json_close_array

	json_add_array interfaces
	for section in $(wm_wireless_sections wifi-iface); do
		mode=$(wm_wireless_get "$section.mode")
		[ -n "$mode" ] || mode=ap
		devices=$(wm_wireless_get "$section.device")
		ifname=$(iface_ifname "$section")
		runtime_ifname=$(iface_runtime_ifname "$section")
		up=0
		[ -n "$runtime_ifname" ] && iface_runtime_up "$runtime_ifname" && up=1
		set -- $(iface_station_stats "$runtime_ifname")
		stations="$1"
		signal="$2"
		tx_rate="$3"
		rx_rate="$4"
		json_add_object
		json_add_string section "$section"
		json_add_string ifname "${ifname:-}"
		json_add_string runtime_ifname "${runtime_ifname:-}"
		json_add_string mode "$mode"
		json_add_string device "$devices"
		json_add_string ssid "$(wm_wireless_get "$section.ssid")"
		json_add_string mesh_id "$(wm_wireless_get "$section.mesh_id")"
		json_add_string network "$(wm_wireless_get "$section.network")"
		json_add_string encryption "$(wm_wireless_get "$section.encryption")"
		json_add_boolean hidden "$([ "$(wm_wireless_get "$section.hidden")" = 1 ] && echo 1 || echo 0)"
		json_add_string ieee80211w "$(wm_wireless_get "$section.ieee80211w")"
		json_add_string macaddr "$(wm_wireless_get "$section.macaddr")"
		json_add_string bssid "$(wm_wireless_get "$section.bssid")"
		json_add_boolean wds "$([ "$(wm_wireless_get "$section.wds")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean uapsd "$([ "$(wm_wireless_get "$section.uapsd")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean ocv "$([ "$(wm_wireless_get "$section.ocv")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean disassoc_low_ack "$([ "$(wm_wireless_get "$section.disassoc_low_ack")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean has_key "$([ -n "$(wm_wireless_get "$section.key")" ] && echo 1 || echo 0)"
		json_add_boolean disabled "$([ "$(wm_wireless_get "$section.disabled")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean mlo "$(iface_is_mlo "$section" && echo 1 || echo 0)"
		json_add_boolean mesh_owned "$(iface_is_mesh_owned "$section" && echo 1 || echo 0)"
		json_add_boolean up "$([ "$up" = 1 ] && echo 1 || echo 0)"
		json_add_int stations "$stations"
		json_add_string signal "${signal:--}"
		json_add_string tx_rate "${tx_rate:--}"
		json_add_string rx_rate "${rx_rate:--}"
		json_close_object
	done
	json_close_array

	json_add_int radio_count "$radios_count"
	json_add_boolean mesh_running "$([ "$meshrunning" = 1 ] && echo 1 || echo 0)"

	# Network sections a wireless interface may attach to.  Only existing
	# sections are offered; the wireless editor never creates network config.
	json_add_array networks
	for net in $(uci -q show network 2>/dev/null |
		sed -n 's/^network\.\([^.]*\)=interface$/\1/p'); do
		json_add_string "" "$net"
	done
	json_close_array

	# --- Conflict analysis -------------------------------------------------
	local conflicts=0 usage count=0
	json_add_array conflicts

	usage=$(radio_usage_collect)

	# E-ALLOC-02 / W-CONC-03: MLO needs two radios; MLO + mesh is constrained.
	for section in $(wm_wireless_sections wifi-iface); do
		if iface_is_mlo "$section"; then
			devices=$(wm_wireless_get "$section.device")
			set -- $devices
			if [ "$#" -lt 2 ]; then
				radio_conflict_emit E-ALLOC-02 \
					"MLO interface '%s' needs at least two radios." "$section"
				conflicts=$((conflicts + 1))
			fi
			for dev in $devices; do
				if printf '%s\n' "$usage" | grep -q "^$dev|mesh|"; then
					radio_conflict_emit W-CONC-03 \
						"Radio '%s' is used by both MLO and mesh; the driver may reject this." "$dev"
					conflicts=$((conflicts + 1))
				fi
			done
		fi
	done

	# E-ALLOC-04: enabled interface on a disabled radio.
	for dev in $(wm_wireless_sections wifi-device); do
		[ "$(wm_wireless_get "$dev.disabled")" = 1 ] || continue
		for section in $(iface_names_of_radio "$dev"); do
			[ "$(wm_wireless_get "$section.disabled")" = 1 ] && continue
			radio_conflict_emit E-ALLOC-04 \
				"Interface '%s' is enabled on disabled radio '%s'." "$section $dev"
			conflicts=$((conflicts + 1))
		done
	done

	# W-CONC-01 / W-CONC-02 / E-ALLOC-03 per radio.
	for dev in $(wm_wireless_sections wifi-device); do
		local modes
		modes=$(printf '%s\n' "$usage" | awk -F'|' -v d="$dev" '$1 == d { print $2 }')
		case " $modes " in
			*" ap "*)
				case " $modes " in
					*" sta "*)
						radio_conflict_emit W-CONC-01 \
							"Radio '%s' carries both AP and STA interfaces; support depends on the driver." "$dev"
						conflicts=$((conflicts + 1))
						;;
				esac
				case " $modes " in
					*" mesh "*)
						radio_conflict_emit W-CONC-02 \
							"Radio '%s' carries both AP and 802.11s mesh interfaces." "$dev"
						conflicts=$((conflicts + 1))
						;;
				esac
				;;
		esac
		# E-ALLOC-03: an operator AP on the mesh radio while the mesh runs.
		if [ "$meshrunning" = 1 ] && [ "$(mesh_managed_radio)" = "$dev" ]; then
			for section in $(iface_names_of_radio "$dev"); do
				[ "$(wm_wireless_get "$section.mode")" = mesh ] && continue
				iface_is_mesh_owned "$section" && continue
				radio_conflict_emit E-ALLOC-03 \
					"Radio '%s' is the mesh radio but interface '%s' is not mesh-owned." "$dev $section"
				conflicts=$((conflicts + 1))
			done
		fi
	done

	# W-CHAN-01/W-CHAN-02: spectrum override and 2.4 GHz channel overlap.
	count=$(radio_channel_conflicts_json)
	conflicts=$((conflicts + count))

	# W-CHAN-03: DFS channel inside an MLO link.
	for section in $(wm_wireless_sections wifi-iface); do
		iface_is_mlo "$section" || continue
		count=$(radio_mlo_dfs_conflicts_json $(wm_wireless_get "$section.device"))
		conflicts=$((conflicts + count))
	done

	json_close_array
	json_add_int conflict_count "$conflicts"
	json_dump
	echo
}

# radio_check {mode, device[], mlo, section}
radio_check_json() {
	local args="$1" mode stored_mode devices mlo section dev count=0
	local conflicts=0

	mode=$(jget "$args" '@.mode')
	devices=$(jget "$args" '@.device[*]')
	mlo=$(jget "$args" '@.mlo')
	section=$(jget "$args" '@.section')

	# An MLO link still has a real interface mode.  Older callers sent
	# mode=mlo; recover the section's mode, falling back to AP for a new link.
	if [ "$mode" = mlo ]; then
		stored_mode=$(wm_wireless_get "$section.mode")
		mode=${stored_mode:-ap}
		mlo=1
	fi
	case "$mlo" in
		1|true) mlo=1 ;;
		*) mlo=0 ;;
	esac

	json_init
	json_add_boolean ok 1
	json_add_array conflicts

	# E-ALLOC-01: the same radio selected twice.
	count=$(printf '%s\n' "$devices" | awk 'NF { c[$0]++ } END { for (k in c) if (c[k] > 1) print k }' | wc -l)
	if [ "${count:-0}" -gt 0 ]; then
		radio_conflict_emit E-ALLOC-01 "The same radio is selected more than once." "$devices"
		conflicts=$((conflicts + 1))
	fi

	# Unknown / disabled radios.
	for dev in $devices; do
		if ! wm_wireless_get "$dev" >/dev/null 2>&1; then
			radio_conflict_emit E-ALLOC-05 "Radio '%s' does not exist." "$dev"
			conflicts=$((conflicts + 1))
		elif [ "$(wm_wireless_get "$dev.disabled")" = 1 ]; then
			radio_conflict_emit E-ALLOC-04 "Radio '%s' is disabled." "$dev"
			conflicts=$((conflicts + 1))
		fi
	done

	# E-ALLOC-02: MLO with fewer than two radios.
	if [ "$mlo" = 1 ]; then
		count=$(printf '%s\n' "$devices" | awk 'NF' | wc -l)
		if [ "${count:-0}" -lt 2 ]; then
			radio_conflict_emit E-ALLOC-02 "MLO needs at least two radios." "$devices"
			conflicts=$((conflicts + 1))
		fi
	fi

	# Channel conflicts the save would introduce or leave in place.  The same
	# helpers drive the inventory so both views agree.  An empty selection must
	# not turn into "every radio": the helper uses no arguments for that.
	if [ -n "$devices" ]; then
		count=$(radio_channel_conflicts_json $devices)
		conflicts=$((conflicts + count))
		if [ "$mlo" = 1 ]; then
			count=$(radio_mlo_dfs_conflicts_json $devices)
			conflicts=$((conflicts + count))
		fi
	fi

	# Concurrency with existing interfaces on the selected radios.
	local usage section_mode phy info bands modes combos reported band bline
	local chlist channel htmode hf counts eht_emitted
	usage=$(radio_usage_collect)
	for dev in $devices; do
		for section_mode in $(printf '%s\n' "$usage" |
			awk -F'|' -v d="$dev" -v s="$section" '$1 == d && $3 != s { print $2 }' | sort -u); do
			case "$mode:$section_mode" in
				ap:sta|sta:ap)
					radio_conflict_emit W-CONC-01 \
						"Radio '%s' already carries a %s interface." "$dev $section_mode"
					conflicts=$((conflicts + 1))
					;;
				ap:mesh|mesh:ap)
					radio_conflict_emit W-CONC-02 \
						"Radio '%s' already carries a %s interface." "$dev $section_mode"
					conflicts=$((conflicts + 1))
					;;
			esac
		done
		if [ "$mlo" = 1 ] && printf '%s\n' "$usage" |
			awk -F'|' -v d="$dev" -v s="$section" \
				'$1 == d && $2 == "mesh" && $3 != s { found = 1 } END { exit !found }'; then
			radio_conflict_emit W-CONC-03 \
				"Radio '%s' is used by both MLO and mesh; the driver may reject this." "$dev"
			conflicts=$((conflicts + 1))
		fi
		if [ "$mode" = ap ] && [ "$(uci -q get meshassistant.config.running)" = 1 ] &&
			[ "$(mesh_managed_radio)" = "$dev" ]; then
			radio_conflict_emit E-ALLOC-03 \
				"Radio '%s' is the mesh radio; an operator AP there conflicts with the mesh." "$dev"
			conflicts=$((conflicts + 1))
		fi

		# DESIGN §5.1/§5.2: driver-reported capabilities.  Only what the driver
		# states is used to refuse a combination; when it reports nothing the
		# combination is unconfirmed and the operator has to acknowledge it.
		[ "$(wm_wireless_get "$dev.disabled")" = 1 ] && continue

		phy=$(radio_phy "$dev")
		info=""
		[ -n "$phy" ] && command -v iw >/dev/null 2>&1 &&
			info=$(iw phy "$phy" info 2>/dev/null)
		if [ -z "$info" ]; then
			radio_conflict_emit W-CAP-01 \
				"The driver capabilities of radio '%s' could not be read; this combination cannot be confirmed." "$dev"
			conflicts=$((conflicts + 1))
			continue
		fi

		bands=$(printf '%s\n' "$info" | cap_bands)
		modes=$(printf '%s\n' "$info" | cap_modes)
		combos=$(printf '%s\n' "$info" | cap_combinations)
		reported=$(printf '%s\n' "$info" | cap_combinations_reported)

		if [ -z "$bands" ] || [ -z "$modes" ]; then
			radio_conflict_emit W-CAP-01 \
				"Radio '%s' did not report its bands or interface modes; this combination cannot be confirmed." "$dev"
			conflicts=$((conflicts + 1))
			continue
		fi

		if [ -n "$(cap_mode_key "$mode")" ] && ! cap_modes_support "$modes" "$mode"; then
			radio_conflict_emit E-CAP-01 \
				"Radio '%s' does not report support for mode '%s'." "$dev $mode"
			conflicts=$((conflicts + 1))
		fi

		band=$(radio_band "$dev")
		bline=""
		[ -n "$band" ] && bline=$(printf '%s\n' "$bands" | awk -F'|' -v b="$band" '$1 == b')
		eht_emitted=0
		if [ -n "$band" ] && [ -z "$bline" ]; then
			radio_conflict_emit E-CAP-02 \
				"Radio '%s' does not report the %s band." "$dev $band"
			conflicts=$((conflicts + 1))
		elif [ -n "$band" ]; then
			chlist=$(cap_band_field "$bands" "$band" channels)
			if [ -z "$chlist" ]; then
				radio_conflict_emit E-CAP-02 \
					"Radio '%s' reports no usable channel in the %s band; every channel is disabled or no-IR." "$dev $band"
				conflicts=$((conflicts + 1))
			else
				channel=$(wm_wireless_get "$dev.channel")
				case "$channel" in
					''|auto|*[!0-9]*) ;;
					*)
						case ",$chlist," in
							*",$channel,"*) ;;
							*)
								radio_conflict_emit E-CAP-05 \
									"Radio '%s' does not advertise channel %s as usable." "$dev $channel"
								conflicts=$((conflicts + 1))
								;;
						esac
						;;
				esac
			fi
			htmode=$(wm_wireless_get "$dev.htmode")
			hf=$(cap_htmode_field "$htmode")
			if [ -n "$hf" ] && [ "$(cap_band_field "$bands" "$band" "$hf")" = 0 ]; then
				radio_conflict_emit E-CAP-03 \
					"Radio '%s' does not report %s support in the %s band, which %s needs." "$dev $hf $band $htmode"
				conflicts=$((conflicts + 1))
				[ "$hf" = eht ] && eht_emitted=1
			fi
		fi

		if [ "$mlo" = 1 ] && [ "$eht_emitted" = 0 ]; then
			if [ -n "$band" ]; then
				[ "$(cap_band_field "$bands" "$band" eht)" = 1 ] || {
					radio_conflict_emit E-CAP-03 \
						"MLO needs EHT, which radio '%s' does not report in the %s band." "$dev $band"
					conflicts=$((conflicts + 1))
				}
			elif ! printf '%s\n' "$bands" | grep -q '|eht=1'; then
				radio_conflict_emit E-CAP-03 \
					"MLO needs EHT, which radio '%s' does not report in any band." "$dev"
				conflicts=$((conflicts + 1))
			fi
		fi

		if [ -n "$combos" ]; then
			if [ -n "$(cap_mode_key "$mode")" ]; then
				counts=$(cap_counts_for "$dev" "$section" "$mode")
				if ! cap_combinations_support "$combos" "$counts"; then
					radio_conflict_emit E-CAP-04 \
						"Radio '%s' reports that it cannot run this interface mix (%s)." "$dev $counts"
					conflicts=$((conflicts + 1))
				fi
			fi
		elif [ "$reported" = 1 ]; then
			radio_conflict_emit W-CAP-01 \
				"Radio '%s' reported interface combinations, but none mentions a mode this check understands; the mix cannot be confirmed." "$dev"
			conflicts=$((conflicts + 1))
		else
			radio_conflict_emit W-CAP-01 \
				"Radio '%s' reports no interface combinations; concurrent use cannot be confirmed." "$dev"
			conflicts=$((conflicts + 1))
		fi
	done

	json_close_array
	json_add_int conflict_count "$conflicts"
	json_dump
	echo
}

# radio_advice_json
# Read-only facts for the allocation advisor.  The verdicts and the ranking
# live in utils/radio.js so the editor can re-evaluate them when the mode
# changes without another RPC; this function only reports what UCI and the
# mesh settings say.  It never claims a concurrency capability the driver has
# not reported: an occupied radio is advice, not a measured capability.
radio_advice_json() {
	local dev section mode running mesh_radio

	running=0
	[ "$(uci -q get meshassistant.config.running)" = 1 ] && running=1
	mesh_radio=$(mesh_managed_radio)

	json_init
	json_add_boolean ok 1
	json_add_boolean mesh_running "$running"
	json_add_string mesh_radio "${mesh_radio:-}"
	json_add_array radios

	for dev in $(wm_wireless_sections wifi-device); do
		json_add_object
		json_add_string name "$dev"
		json_add_string band "$(radio_band "$dev")"
		json_add_string channel "$(wm_wireless_get "$dev.channel")"
		json_add_string htmode "$(wm_wireless_get "$dev.htmode")"
		json_add_boolean disabled "$([ "$(wm_wireless_get "$dev.disabled")" = 1 ] && echo 1 || echo 0)"
		json_add_boolean mesh_radio "$([ "$running" = 1 ] && [ "$mesh_radio" = "$dev" ] && echo 1 || echo 0)"
		json_add_array interfaces
		for section in $(iface_names_of_radio "$dev"); do
			mode=$(wm_wireless_get "$section.mode")
			[ -n "$mode" ] || mode=ap
			json_add_object
			json_add_string section "$section"
			json_add_string mode "$mode"
			json_add_boolean mesh_owned "$(iface_is_mesh_owned "$section" && echo 1 || echo 0)"
			json_add_boolean disabled "$([ "$(wm_wireless_get "$section.disabled")" = 1 ] && echo 1 || echo 0)"
			json_close_object
		done
		json_close_array
		json_close_object
	done

	json_close_array
	json_dump
	echo
}
