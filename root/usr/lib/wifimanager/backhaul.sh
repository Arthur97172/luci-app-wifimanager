#!/bin/sh
# Hybrid backhaul: carrier sampling, automatic switching and link priority.
#
# Switching is runtime-only.  The wired hardif is detached from bat0 through
# netifd (ubus call network.interface.mesh_wired down) and reattached with
# "up"; no UCI file is rewritten, so a failed switch cannot leave a broken
# saved configuration behind.  Priority is configuration: the mesh engine
# writes the hardif throughput_override on Apply.
#
# Link presence is never inferred from the interface name alone: the kernel
# carrier of the wired port is the signal, because a configured Ethernet
# netdev exists whether or not a cable is plugged in.

. /usr/lib/wifimanager/common.sh
# hardif_is_wireless / mesh_hardif_speeds / mesh_selected_ifaces describe the
# links bat0 currently has.
. /usr/lib/wifimanager/peer.sh

WM_BACKHAUL_STATE="$WM_RUN_DIR/backhaul.state"
WM_BACKHAUL_POLL=5

backhaul_auto_enabled() {
	[ "$(uci -q get meshassistant.config.backhaul_auto)" = 1 ]
}

# The monitor is only meaningful while the mesh is applied and the wired
# hardif exists; otherwise there is nothing it could switch.
backhaul_running() {
	[ "$(uci -q get meshassistant.config.enabled)" = 1 ] &&
		[ "$(uci -q get meshassistant.config.running)" = 1 ] &&
		[ "$(uci -q get network.mesh_wired.proto)" = batadv_hardif ]
}

backhaul_wired_device() {
	local dev
	dev=$(uci -q get network.mesh_wired.device)
	[ -n "$dev" ] || dev=$(uci -q get meshassistant.config.wired_port)
	[ -n "$dev" ] || dev=$(uci -q get meshassistant.config.wired_backhaul_port)
	printf '%s\n' "$dev"
}

# up | down | absent | unknown.  "unknown" means the device exists but the
# kernel exposes neither carrier nor a usable operstate; the caller keeps the
# previous sample instead of inventing a transition.
backhaul_carrier_state() {
	local dev="$1" carrier state

	[ -n "$dev" ] || {
		echo absent
		return 0
	}
	[ -e "/sys/class/net/$dev" ] || {
		echo absent
		return 0
	}

	carrier=$(cat "/sys/class/net/$dev/carrier" 2>/dev/null)
	case "$carrier" in
		1) echo up; return 0 ;;
		0) echo down; return 0 ;;
	esac

	state=$(cat "/sys/class/net/$dev/operstate" 2>/dev/null)
	case "$state" in
		up) echo up ;;
		down|lowerlayerdown|notpresent) echo down ;;
		*) echo unknown ;;
	esac
}

# The wireless side is healthy when BATMAN-adv has a direct neighbor or a
# selected originator over a wireless hardif; the hardif name alone would be
# true even when the radio has no peer.
backhaul_wireless_healthy() {
	local iface

	for iface in $(mesh_hardif_speeds | awk '{ print $1 }') \
		$(mesh_selected_ifaces | sort -u); do
		hardif_is_wireless "$iface" && return 0
	done
	return 1
}

# State is runtime-only and survives between passes; it is not UCI state.
backhaul_state_load() {
	BACKHAUL_WIRED=""
	BACKHAUL_WIRED_SINCE=""
	BACKHAUL_WLAN=""
	BACKHAUL_WLAN_SINCE=""
	BACKHAUL_ACTIVE=""
	BACKHAUL_LAST_SWITCH=""
	BACKHAUL_LAST_FROM=""
	BACKHAUL_LAST_TO=""
	BACKHAUL_LAST_REASON=""
	BACKHAUL_LAST_ERROR=""

	[ -f "$WM_BACKHAUL_STATE" ] || return 1
	while IFS='=' read -r key value; do
		case "$key" in
			wired) BACKHAUL_WIRED=$value ;;
			wired_since) BACKHAUL_WIRED_SINCE=$value ;;
			wlan) BACKHAUL_WLAN=$value ;;
			wlan_since) BACKHAUL_WLAN_SINCE=$value ;;
			active) BACKHAUL_ACTIVE=$value ;;
			last_switch) BACKHAUL_LAST_SWITCH=$value ;;
			last_from) BACKHAUL_LAST_FROM=$value ;;
			last_to) BACKHAUL_LAST_TO=$value ;;
			last_reason) BACKHAUL_LAST_REASON=$value ;;
			last_error) BACKHAUL_LAST_ERROR=$value ;;
		esac
	done <"$WM_BACKHAUL_STATE"

	[ -n "$BACKHAUL_WIRED" ]
}

backhaul_state_save() {
	local tmp="$WM_BACKHAUL_STATE.$$"

	mkdir -p "$WM_RUN_DIR" 2>/dev/null
	(
		umask 077
		printf 'wired=%s\n' "$BACKHAUL_WIRED"
		printf 'wired_since=%s\n' "$BACKHAUL_WIRED_SINCE"
		printf 'wlan=%s\n' "$BACKHAUL_WLAN"
		printf 'wlan_since=%s\n' "$BACKHAUL_WLAN_SINCE"
		printf 'active=%s\n' "$BACKHAUL_ACTIVE"
		printf 'last_switch=%s\n' "$BACKHAUL_LAST_SWITCH"
		printf 'last_from=%s\n' "$BACKHAUL_LAST_FROM"
		printf 'last_to=%s\n' "$BACKHAUL_LAST_TO"
		printf 'last_reason=%s\n' "$BACKHAUL_LAST_REASON"
		printf 'last_error=%s\n' "$BACKHAUL_LAST_ERROR"
	) >"$tmp" 2>/dev/null || return 1
	mv "$tmp" "$WM_BACKHAUL_STATE" 2>/dev/null || return 1
	chmod 600 "$WM_BACKHAUL_STATE" 2>/dev/null
	return 0
}

# backhaul_switch_to <ethernet|wireless>
# Uses netifd's lifecycle so the hardif is detached/reattached with bat0's
# cooperation.  Sets BACKHAUL_SWITCH_ERROR on failure.  The post-condition is
# verified on batctl's hardif list for up to 10 seconds when batctl exists.
backhaul_switch_to() {
	local target="$1" dev err hardifs i=0 rc

	BACKHAUL_SWITCH_ERROR=""
	dev=$(backhaul_wired_device)
	case "$target" in
		ethernet|wireless) ;;
		*)
			BACKHAUL_SWITCH_ERROR="unknown switch target '$target'"
			return 1
			;;
	esac
	[ -n "$dev" ] || {
		BACKHAUL_SWITCH_ERROR="no wired device is configured"
		return 1
	}

	if [ "$target" = ethernet ]; then
		err=$(ubus call network.interface.mesh_wired up 2>&1)
	else
		err=$(ubus call network.interface.mesh_wired down 2>&1)
	fi
	rc=$?
	if [ "$rc" != 0 ]; then
		BACKHAUL_SWITCH_ERROR=$(printf '%s' "$err" | tr '\n\r' '  ' | cut -c1-200)
		[ -n "$BACKHAUL_SWITCH_ERROR" ] ||
			BACKHAUL_SWITCH_ERROR="netifd refused to bring mesh_wired $target"
		return 1
	fi

	command -v batctl >/dev/null 2>&1 || return 0
	while [ "$i" -lt 10 ]; do
		hardifs=$(mesh_hardif_bindings | awk '{ print $1 }')
		if [ "$target" = ethernet ]; then
			printf '%s\n' "$hardifs" | grep -qx "$dev" && return 0
		else
			printf '%s\n' "$hardifs" | grep -qx "$dev" || return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	if [ "$target" = ethernet ]; then
		BACKHAUL_SWITCH_ERROR="the hardif did not appear within 10 seconds"
	else
		BACKHAUL_SWITCH_ERROR="the hardif did not disappear within 10 seconds"
	fi
	return 1
}

# One decision pass.  The first pass only records the current world; nothing
# is switched until a transition has been observed and its delay elapsed, so
# a boot-time race cannot move the backhaul.
backhaul_monitor_once() {
	local dev carrier wlan now pref delay stable wired_for wlan_for
	local target reason from

	backhaul_auto_enabled || return 0
	backhaul_running || return 0

	dev=$(backhaul_wired_device)
	[ -n "$dev" ] || return 0

	pref=$(uci -q get meshassistant.config.backhaul_pref)
	case "$pref" in
		ethernet|wireless) ;;
		*) pref=ethernet ;;
	esac
	delay=$(uci -q get meshassistant.config.backhaul_switch_delay)
	case "$delay" in
		''|*[!0-9]*) delay=30 ;;
	esac
	stable=$(uci -q get meshassistant.config.backhaul_stable_time)
	case "$stable" in
		''|*[!0-9]*) stable=60 ;;
	esac

	now=$(date +%s)
	carrier=$(backhaul_carrier_state "$dev")
	if backhaul_wireless_healthy; then
		wlan=up
	else
		wlan=down
	fi

	if ! backhaul_state_load; then
		BACKHAUL_WIRED=$carrier
		BACKHAUL_WIRED_SINCE=$now
		BACKHAUL_WLAN=$wlan
		BACKHAUL_WLAN_SINCE=$now
		[ "$carrier" = up ] && BACKHAUL_ACTIVE=ethernet ||
			BACKHAUL_ACTIVE=wireless
		backhaul_state_save
		return 0
	fi

	# An unreadable carrier carries no new information.
	[ "$carrier" = unknown ] && carrier=$BACKHAUL_WIRED
	if [ "$carrier" != "$BACKHAUL_WIRED" ]; then
		BACKHAUL_WIRED=$carrier
		BACKHAUL_WIRED_SINCE=$now
	fi
	if [ "$wlan" != "$BACKHAUL_WLAN" ]; then
		BACKHAUL_WLAN=$wlan
		BACKHAUL_WLAN_SINCE=$now
	fi
	case "$BACKHAUL_ACTIVE" in
		ethernet|wireless) ;;
		*) [ "$BACKHAUL_WIRED" = up ] && BACKHAUL_ACTIVE=ethernet ||
			BACKHAUL_ACTIVE=wireless ;;
	esac

	wired_for=$((now - ${BACKHAUL_WIRED_SINCE:-$now}))
	wlan_for=$((now - ${BACKHAUL_WLAN_SINCE:-$now}))
	[ "$wired_for" -ge 0 ] || wired_for=0
	[ "$wlan_for" -ge 0 ] || wlan_for=0

	target=""
	reason=""
	case "$BACKHAUL_ACTIVE" in
		ethernet)
			if [ "$BACKHAUL_WIRED" != up ] && [ "$wired_for" -ge "$delay" ]; then
				target=wireless
				reason=wired-lost
			elif [ "$pref" = wireless ] && [ "$BACKHAUL_WLAN" = up ] &&
				[ "$wlan_for" -ge "$stable" ]; then
				target=wireless
				reason=preference
			fi
			;;
		wireless)
			if [ "$pref" = ethernet ] && [ "$BACKHAUL_WIRED" = up ] &&
				[ "$wired_for" -ge "$stable" ]; then
				target=ethernet
				reason=wired-restored
			elif [ "$pref" = wireless ] && [ "$BACKHAUL_WLAN" != up ] &&
				[ "$wlan_for" -ge "$delay" ] && [ "$BACKHAUL_WIRED" = up ]; then
				target=ethernet
				reason=wireless-lost
			fi
			;;
	esac

	if [ -n "$target" ]; then
		from=$BACKHAUL_ACTIVE
		# Never switch while a configuration operation owns the mesh.
		if ! wm_take_lock 2>/dev/null; then
			backhaul_state_save
			return 0
		fi
		if backhaul_switch_to "$target"; then
			BACKHAUL_ACTIVE=$target
			BACKHAUL_LAST_SWITCH=$now
			BACKHAUL_LAST_FROM=$from
			BACKHAUL_LAST_TO=$target
			BACKHAUL_LAST_REASON=$reason
			BACKHAUL_LAST_ERROR=""
			wm_log "Backhaul switched from $from to $target ($reason)."
			wm_event backhaul-switch from "$from" to "$target" reason "$reason"
		else
			BACKHAUL_LAST_ERROR=$(printf '%s' "$BACKHAUL_SWITCH_ERROR" |
				tr '\n\r' '  ' | cut -c1-200)
			# Keep the previous active medium so the next pass retries.
			wm_log "Backhaul switch to $target failed: $BACKHAUL_LAST_ERROR"
			wm_event backhaul-switch-failed from "$from" to "$target" \
				reason "$reason" error "$BACKHAUL_LAST_ERROR"
		fi
		exec 8>&-
	fi
	backhaul_state_save
}

backhaul_daemon() {
	while true; do
		backhaul_monitor_once
		sleep "$WM_BACKHAUL_POLL" &
		wait $!
	done
}

# Read-only snapshot for the view.  Only the DAWN-style status fields are
# exposed; no password or key material exists here.
backhaul_status_json() {
	local dev carrier speed=0 auto=0 pref mode wm=0 wl=0 healthy=0

	dev=$(backhaul_wired_device)
	carrier=$(backhaul_carrier_state "$dev")
	speed=$(wired_link_speed "$dev" 2>/dev/null)
	case "$speed" in
		''|*[!0-9]*) speed=0 ;;
	esac
	backhaul_auto_enabled && auto=1
	pref=$(uci -q get meshassistant.config.backhaul_pref)
	case "$pref" in
		ethernet|wireless) ;;
		*) pref=ethernet ;;
	esac
	mode=$(uci -q get meshassistant.config.backhaul_priority)
	[ "$mode" = manual ] || mode=auto
	wm=$(uci -q get meshassistant.config.backhaul_wired_mbit)
	case "$wm" in
		''|*[!0-9]*) wm=0 ;;
	esac
	wl=$(uci -q get meshassistant.config.backhaul_wireless_mbit)
	case "$wl" in
		''|*[!0-9]*) wl=0 ;;
	esac
	backhaul_wireless_healthy && healthy=1

	backhaul_state_load || :

	json_init
	json_add_boolean ok 1
	json_add_boolean auto "$auto"
	json_add_boolean running "$(backhaul_running && echo 1 || echo 0)"
	json_add_string pref "$pref"
	json_add_object priority
	json_add_string mode "$mode"
	json_add_int wired_mbit "$wm"
	json_add_int wireless_mbit "$wl"
	json_close_object
	json_add_object wired
	json_add_string device "$dev"
	json_add_string carrier "$carrier"
	json_add_int negotiated_mbit "$speed"
	json_close_object
	json_add_object wireless
	json_add_boolean healthy "$healthy"
	json_close_object
	json_add_string active "${BACKHAUL_ACTIVE:-}"
	json_add_int wired_since "${BACKHAUL_WIRED_SINCE:-0}"
	json_add_object last_switch
	json_add_int ts "${BACKHAUL_LAST_SWITCH:-0}"
	json_add_string from "$BACKHAUL_LAST_FROM"
	json_add_string to "$BACKHAUL_LAST_TO"
	json_add_string reason "$BACKHAUL_LAST_REASON"
	json_close_object
	json_add_string last_error "$BACKHAUL_LAST_ERROR"
	json_add_string note "Carrier state and switch timing are read from the kernel. A switch is verified on the bat0 hardif list when batctl is available; otherwise its runtime effect is unverified."
	json_dump
	echo
}
