#!/bin/sh
# Roaming: 802.11k/v/r, DAWN configuration, and the roaming event sampler.

. /usr/lib/wifimanager/common.sh
# radio_band() and iface_runtime_ifname() name the band of an AP section and
# its runtime interface; the roaming advice reads station signals through them.
. /usr/lib/wifimanager/radio.sh
# Applying roaming settings rewrites wireless and DAWN; both changes go through
# the shared Backup Manager before they are made.
. /usr/lib/wifimanager/backup.sh

# 802.11v needs CONFIG_WNM_AP in hostapd.  Basic builds contain the substring in
# other symbols, so compare whole NUL-terminated strings.  The answer is cached
# for the lifetime of the process.
wnm_supported() {
	if [ -n "${WM_WNM_OK:-}" ]; then
		[ "$WM_WNM_OK" = 1 ]
		return
	fi
	WM_WNM_OK=0
	local bin
	for bin in /usr/sbin/wpad /usr/sbin/hostapd; do
		[ -f "$bin" ] || continue
		if tr '\0' '\n' <"$bin" 2>/dev/null | grep -qx 'bss_transition'; then
			WM_WNM_OK=1
			break
		fi
	done
	[ "$WM_WNM_OK" = 1 ]
}

dawn_installed() {
	[ -x /etc/init.d/dawn ]
}

# Restore the DAWN configuration found before WiFi Manager took it over.
dawn_release() {
	[ -f "$WM_DAWN_MARKER" ] || return 0
	/etc/init.d/dawn stop >/dev/null 2>&1
	/etc/init.d/dawn disable >/dev/null 2>&1
	if [ -f "$WM_DAWN_BACKUP" ]; then
		cp "$WM_DAWN_BACKUP" "$WM_DAWN_CONF"
		rm -f "$WM_DAWN_BACKUP"
	else
		rm -f "$WM_DAWN_CONF"
	fi
	rm -f "$WM_DAWN_MARKER"
	wm_log "Released DAWN and stopped client steering."
}

# Read an integer form option with a fallback and clamp it to the range the
# DAWN configuration can use.  The previous version hardcoded these decision
# parameters, so an absent option keeps exactly the old behavior.
dawn_int_option() { # name default min max
	local value
	value=$(uci -q get "meshassistant.config.$1")
	case "$value" in
		''|*[!0-9]*) value="$2" ;;
	esac
	[ "$value" -lt "$3" ] && value="$3"
	[ "$value" -gt "$4" ] && value="$4"
	printf '%s\n' "$value"
}

# Write the managed DAWN configuration from the meshassistant form values.
setup_dawn() {
	local rssi low secret shared band suffix good bad
	local kicking threshold min_clients duration

	if ! roaming_steering_enabled; then
		dawn_release
		return 0
	fi
	if ! wnm_supported; then
		# 802.11k alone still benefits from DAWN's neighbor reports; only a
		# pure 802.11v request has to give up when wpad cannot send it.
		if roaming_v_enabled && ! roaming_k_enabled; then
			dawn_release
			wm_log "Warning: wpad has no 802.11v support; DAWN left stopped."
			return 0
		fi
		wm_log "Warning: wpad has no 802.11v support; DAWN keeps neighbor reports without client steering."
	fi
	if ! dawn_installed; then
		wm_log "Warning: DAWN is not installed; client steering is unavailable."
		return 0
	fi

	rssi=$(uci -q get meshassistant.config.rssi_val)
	[ -n "$rssi" ] || rssi='-60'
	low=$(uci -q get meshassistant.config.low_rssi_val)
	[ -n "$low" ] || low='-88'

	if [ ! -f "$WM_DAWN_MARKER" ] && [ ! -f "$WM_DAWN_BACKUP" ] && [ -f "$WM_DAWN_CONF" ]; then
		cp "$WM_DAWN_CONF" "$WM_DAWN_BACKUP"
		chmod 600 "$WM_DAWN_BACKUP" 2>/dev/null
	fi

	[ -n "$(uci -q get dawn.global)" ] || uci set dawn.global='metric'
	[ -n "$(uci -q get dawn.802_11g)" ] || uci set dawn.802_11g='metric'
	[ -n "$(uci -q get dawn.802_11a)" ] || uci set dawn.802_11a='metric'
	[ -n "$(uci -q get dawn.802_11ax)" ] || uci set dawn.802_11ax='metric'
	[ -n "$(uci -q get 'dawn.@network[0]')" ] || uci add dawn network >/dev/null

	secret=$(uci -q get meshassistant.config.key)
	[ -n "$secret" ] || secret=$(uci -q get meshassistant.config.mesh_id)
	shared=$(printf 'meshassistant:%s' "$secret" | md5sum | cut -c1-32)

	# Decision parameters are operator-adjustable (DESIGN §8.4).  The
	# defaults are the values this engine always used, so an upgrade that has
	# no option set keeps the previous steering behavior.
	kicking=$(dawn_int_option dawn_kicking 3 0 3)
	# Steering needs 802.11v; neighbour reports only need 802.11k, so DAWN
	# keeps running with kicking disabled when v is off or unsupported.
	if ! roaming_v_enabled || ! wnm_supported; then
		kicking=0
	fi
	threshold=$(dawn_int_option dawn_kicking_threshold 20 1 100)
	min_clients=$(dawn_int_option dawn_min_clients 3 1 100)
	duration=$(dawn_int_option dawn_duration 150 10 3600)
	uci set dawn.global.kicking="$kicking"
	uci set dawn.global.kicking_threshold="$threshold"
	uci set dawn.global.min_number_to_kick="$min_clients"
	# set_hostapd_nr makes DAWN publish the known BSSes as 802.11k neighbour
	# reports.  Tie it to the 802.11k flag on every apply instead of writing
	# it only when the DAWN takeover happens.
	if roaming_k_enabled; then
		uci set dawn.global.set_hostapd_nr='1'
	else
		uci -q del dawn.global.set_hostapd_nr
	fi
	uci set dawn.global.duration="$duration"
	for band in 802_11g 802_11a 802_11ax; do
		case "$band" in
			802_11g) suffix=2g ;;
			802_11a) suffix=5g ;;
			802_11ax) suffix=6g ;;
		esac
		good=$(uci -q get "meshassistant.config.rssi_val_$suffix")
		[ -n "$good" ] || good=$rssi
		bad=$(uci -q get "meshassistant.config.low_rssi_val_$suffix")
		[ -n "$bad" ] || bad=$low
		uci set "dawn.$band.rssi_val=$good"
		uci set "dawn.$band.low_rssi_val=$bad"
		uci set "dawn.$band.rssi_center=$bad"
	done
	uci set 'dawn.@network[0].shared_key='"$shared"

	touch "$WM_DAWN_MARKER"
	if ! uci -q commit dawn; then
		wm_log "DAWN configuration could not be committed."
		return 1
	fi
	/etc/init.d/dawn enable >/dev/null 2>&1
	/etc/init.d/dawn restart >/dev/null 2>&1
	if [ "$kicking" = 0 ]; then
		echo "Neighbor reports enabled; DAWN does not steer clients."
	else
		echo "Client steering enabled (good $rssi dBm, bad $low dBm)."
	fi
}

dawn_watchdog_enabled() {
	[ "$(uci -q get meshassistant.config.dawn_watchdog)" != 0 ]
}

# One recovery pass, called by the minute ticker.  It only acts on a DAWN
# configuration this package manages (the marker is written by setup_dawn and
# removed by dawn_release), so a DAWN the operator disabled deliberately is
# never restarted.  Attempts are spaced out so a persistent failure cannot
# turn into a restart loop.
dawn_watchdog_once() {
	local now last failures

	[ -f "$WM_DAWN_MARKER" ] || return 0
	roaming_steering_enabled || return 0
	dawn_watchdog_enabled || return 0
	dawn_installed || return 0

	if /etc/init.d/dawn status >/dev/null 2>&1; then
		rm -f "$WM_RUNTIME_DIR/dawn-watchdog" "$WM_RUNTIME_DIR/dawn-watchdog-failures"
		return 0
	fi

	now=$(date +%s)
	last=$(cat "$WM_RUNTIME_DIR/dawn-watchdog" 2>/dev/null)
	case "$last" in
		''|*[!0-9]*) last=0 ;;
	esac
	# At most one recovery attempt every five minutes.
	[ $((now - last)) -lt 300 ] && return 0

	mkdir -p "$WM_RUNTIME_DIR" 2>/dev/null
	echo "$now" >"$WM_RUNTIME_DIR/dawn-watchdog"

	failures=$(cat "$WM_RUNTIME_DIR/dawn-watchdog-failures" 2>/dev/null)
	case "$failures" in
		''|*[!0-9]*) failures=0 ;;
	esac
	failures=$((failures + 1))

	wm_log "DAWN is managed but not running; restart attempt $failures."
	/etc/init.d/dawn enable >/dev/null 2>&1
	/etc/init.d/dawn restart >/dev/null 2>&1

	if /etc/init.d/dawn status >/dev/null 2>&1; then
		rm -f "$WM_RUNTIME_DIR/dawn-watchdog-failures"
		echo "$now" >"$WM_RUNTIME_DIR/dawn-last-restart"
		wm_event dawn-restart attempt "$failures" result restarted
		wm_log "DAWN restarted by the watchdog."
	else
		echo "$failures" >"$WM_RUNTIME_DIR/dawn-watchdog-failures"
		wm_event dawn-restart attempt "$failures" result failed
		wm_log "DAWN watchdog restart attempt $failures failed."
	fi
}

# Write k/v/r options on the AP sections managed by the engine.  Sections that
# are not AP mode or not managed are left alone.
roaming_apply_internal() {
	local section ft

	ft=$(uci -q get meshassistant.config.ft)
	[ -n "$ft" ] || ft=0

	for section in $(uci -q show wireless 2>/dev/null |
		sed -n "s/^wireless\.\(wifi_ap_[^.]*\)=wifi-iface\$/\1/p"); do
		[ "$(uci -q get "wireless.$section.mode")" = ap ] || continue

		if [ "$ft" = 1 ]; then
			uci set "wireless.$section.ieee80211r=1"
			uci set "wireless.$section.mobility_domain=$(uci -q get meshassistant.config.mobility_domain)"
			uci set "wireless.$section.ft_over_ds=$(ft_over_ds_value)"
			uci set "wireless.$section.ft_psk_generate_local=0"
		else
			uci -q del "wireless.$section.ieee80211r"
			uci -q del "wireless.$section.mobility_domain"
			uci -q del "wireless.$section.ft_over_ds"
			uci -q del "wireless.$section.ft_psk_generate_local"
		fi

		if roaming_k_enabled; then
			uci set "wireless.$section.ieee80211k=1"
		else
			uci -q del "wireless.$section.ieee80211k"
		fi
		if roaming_v_enabled && wnm_supported; then
			uci set "wireless.$section.bss_transition=1"
		else
			uci -q del "wireless.$section.bss_transition"
		fi
	done
	if ! uci -q commit wireless; then
		wm_log "The wireless configuration could not be committed."
		return 1
	fi
	# hostapd only reads ieee80211k/v/r at start, so a commit alone would
	# leave the running APs unchanged.
	wm_reload_wifi
	setup_dawn
}

# The files an apply may change, plus the state of the DAWN takeover files, so
# a failed apply can be reverted without guessing what existed before.
roaming_apply_snapshot() { # dir
	local snap="$1"

	mkdir -p "$snap/etc/config" "$snap/state" || return 1
	if [ -f "$WM_CONFIG_DIR/wireless" ]; then
		cp "$WM_CONFIG_DIR/wireless" "$snap/etc/config/wireless" 2>/dev/null || return 1
	else
		touch "$snap/state/wireless.absent"
	fi
	if [ -f "$WM_CONFIG_DIR/dawn" ]; then
		cp "$WM_CONFIG_DIR/dawn" "$snap/etc/config/dawn" 2>/dev/null || return 1
	else
		touch "$snap/state/dawn.absent"
	fi
	[ -f "$WM_DAWN_MARKER" ] && touch "$snap/state/dawn.managed"
	[ -f "$WM_DAWN_BACKUP" ] && cp "$WM_DAWN_BACKUP" "$snap/state/dawn.orig" 2>/dev/null
	/etc/init.d/dawn status >/dev/null 2>&1 && touch "$snap/state/dawn.running"
	return 0
}

roaming_apply_rollback() { # dir
	local snap="$1"

	uci -q revert wireless 2>/dev/null
	uci -q revert dawn 2>/dev/null
	restore_rollback "$snap"
	if [ -f "$snap/state/wireless.absent" ]; then
		rm -f "$WM_CONFIG_DIR/wireless"
	fi
	if [ -f "$snap/state/dawn.absent" ]; then
		rm -f "$WM_CONFIG_DIR/dawn"
	fi
	if [ -f "$snap/state/dawn.managed" ]; then
		touch "$WM_DAWN_MARKER"
	else
		rm -f "$WM_DAWN_MARKER"
	fi
	if [ -f "$snap/state/dawn.orig" ]; then
		cp "$snap/state/dawn.orig" "$WM_DAWN_BACKUP" 2>/dev/null
		chmod 600 "$WM_DAWN_BACKUP" 2>/dev/null
	else
		rm -f "$WM_DAWN_BACKUP"
	fi
	reload_config >/dev/null 2>&1
	wm_reload_wifi
	if [ -x /etc/init.d/dawn ]; then
		if [ -f "$WM_DAWN_MARKER" ] || [ -f "$snap/state/dawn.running" ]; then
			/etc/init.d/dawn restart >/dev/null 2>&1
		else
			/etc/init.d/dawn stop >/dev/null 2>&1
		fi
	fi
}

# DAWN is managed only when steering is enabled on a mesh node.  Its service
# state is the one runtime value this apply can verify; a slow start gets a
# short grace period instead of a rollback.
roaming_apply_verify() {
	local i=0

	roaming_steering_enabled || return 0
	dawn_installed || return 0
	# A pure 802.11v request without wpad support leaves DAWN released, so
	# there is no service state to verify.
	if roaming_v_enabled && ! roaming_k_enabled && ! wnm_supported; then
		return 0
	fi
	[ -f "$WM_DAWN_MARKER" ] || return 1
	while [ "$i" -lt 5 ]; do
		/etc/init.d/dawn status >/dev/null 2>&1 && return 0
		sleep 1
		i=$((i + 1))
	done
	return 1
}

roaming_apply() {
	local backup_id snap

	wm_take_lock || {
		# Do not touch op.json: another operation owns it.
		wm_log "Operation refused: another operation is already running."
		return 1
	}
	wm_op_begin roaming_apply "Applying roaming settings"

	# DESIGN §10.10/§21.5: the same global Backup Manager used by the
	# Wireless and Mesh engines runs before any k/v/r or DAWN write.
	backup_id=$(backup_create_auto roaming "Before applying roaming settings")
	[ -n "$backup_id" ] || {
		wm_op_finish failed "The pre-change backup failed; no roaming setting was written." 0
		wm_log "roaming: pre-change backup failed; nothing was changed"
		return 1
	}

	snap=$(mktemp -d /tmp/wifimanager-roaming.XXXXXX 2>/dev/null)
	if [ -z "$snap" ] || ! roaming_apply_snapshot "$snap"; then
		[ -n "$snap" ] && rm -rf "$snap"
		wm_op_finish failed "Unable to create the pre-apply snapshot; no roaming setting was written." 0
		return 1
	fi

	if ! roaming_apply_internal; then
		roaming_apply_rollback "$snap"
		rm -rf "$snap"
		wm_op_finish failed "Applying roaming settings failed; the previous configuration was restored." 0
		wm_event roaming-apply result failed rolled_back 1 backup "$backup_id"
		wm_log "roaming: apply failed; the previous wireless/DAWN configuration was restored (backup $backup_id)"
		return 1
	fi
	rm -rf "$snap"

	if ! roaming_apply_verify; then
		wm_op_finish done "Roaming settings applied, but DAWN did not start." 0
		wm_event roaming-apply result unverified backup "$backup_id"
		wm_log "roaming: settings applied but DAWN did not start (backup $backup_id)"
	elif roaming_v_enabled && { ! wnm_supported || ! dawn_installed; }; then
		wm_op_finish done "Roaming settings applied; 802.11v steering is unavailable or disabled." 1
		wm_event roaming-apply result ok backup "$backup_id"
		wm_log "roaming: settings applied; 802.11v steering is unavailable or disabled (backup $backup_id)"
	else
		wm_op_finish done "Roaming settings applied." 1
		wm_event roaming-apply result ok backup "$backup_id"
		wm_log "roaming: settings applied (backup $backup_id)"
	fi
	return 0
}

# ---------------------------------------------------------------------------
# Event sampler
#
# One sample compares the current station table and mesh link state with the
# previous sample.  Only transitions are recorded; unknown signal values are
# omitted instead of being written as 0.
# ---------------------------------------------------------------------------

roaming_state_dir() {
	mkdir -p "$WM_RUNTIME_DIR" 2>/dev/null
}

station_snapshot() {
	local iface
	for iface in $(ls /sys/class/net 2>/dev/null); do
		# Any interface backed by a wireless phy, not only the names this
		# engine happens to create: renamed and operator-added AP sections
		# carry clients too.
		[ -e "/sys/class/net/$iface/phy80211" ] || continue
		iw dev "$iface" station dump 2>/dev/null | awk -v i="$iface" '
			/^Station / {
				if (mac != "") print i, mac, (sig == "" ? "-" : sig)
				mac = $2; sig = ""; next
			}
			/signal:/ { sig = $2 }
			END { if (mac != "") print i, mac, (sig == "" ? "-" : sig) }
		'
	done
}

# The event log names the BSS the client used, not just the local netdev name.
# An SSID may contain spaces, so it is read from the line rather than split
# into fields.  A mesh interface reports a mesh ID instead of an SSID.
roaming_iface_ssid() {
	local value
	value=$(iw dev "$1" info 2>/dev/null | sed -n 's/^[[:space:]]*ssid //p' | head -n 1)
	[ -n "$value" ] || value=$(iw dev "$1" info 2>/dev/null |
		sed -n 's/^[[:space:]]*mesh id //p' | head -n 1)
	printf '%s\n' "$value"
}

roaming_iface_bssid() {
	iw dev "$1" info 2>/dev/null | sed -n 's/^[[:space:]]*addr //p' | head -n 1
}

mesh_link_snapshot() {
	local iface
	for iface in $(ls /sys/class/net 2>/dev/null); do
		case "$iface" in mesh_*) ;; *) continue ;; esac
		printf '%s %s\n' "$iface" "$(cat "/sys/class/net/$iface/operstate" 2>/dev/null || echo unknown)"
	done
}

# Compare two snapshots and emit events.  $1 old file, $2 new file, $3 kind.
station_events() {
	local old="$1" new="$2"
	awk '
		FNR == NR { old[$1 " " $2] = $3; next }
		{ seen[$1 " " $2] = 1; sig[$1 " " $2] = $3 }
		END {
			for (k in old) {
				if (!(k in seen)) {
					split(k, p, " ")
					printf "leave %s %s %s\n", p[2], p[1], old[k]
				}
			}
			for (k in seen) {
				if (!(k in old)) {
					split(k, p, " ")
					printf "join %s %s %s\n", p[2], p[1], sig[k]
				}
			}
		}
	' "$old" "$new" 2>/dev/null
}

# Same MAC now seen on a different BSS is a roam.  The join/leave pair from a
# single sample is correlated here, and only same-device moves are reported.
station_roams() {
	local old="$1" new="$2"
	awk '
		FNR == NR { iface[$2] = $1; sig[$2] = $3; next }
		($2 in iface) && iface[$2] != $1 {
			printf "roam %s %s %s %s %s\n", $2, iface[$2], $1, sig[$2], $3
		}
	' "$old" "$new" 2>/dev/null
}

roaming_event_emit() { # event key value...
	local event="$1"
	shift
	wm_event "$event" "$@"
}

# Public entry point used by the ticker every 15 seconds and after every apply.
roaming_events_sample() {
	local tmp old new links events iface state

	roaming_state_dir
	tmp="$WM_RUNTIME_DIR/.stations.$$"
	old="$WM_RUNTIME_DIR/stations"
	new="$WM_RUNTIME_DIR/stations.new"
	links="$WM_RUNTIME_DIR/meshlinks"
	state="$WM_RUNTIME_DIR/meshlinks.new"

	station_snapshot >"$tmp" 2>/dev/null
	[ -s "$tmp" ] || : >"$tmp"

	if [ -f "$old" ]; then
		# The sampler knows the source and destination RSSI, the interface
		# and its own sample time.  Disconnect/reconnect duration and packet
		# loss are not observable at a 15-second poll (hostapd exposes no
		# per-client loss counter), so they are recorded as explicitly
		# unavailable instead of being guessed (DESIGN §8.5).
		station_events "$old" "$tmp" | while read -r kind mac iface sig; do
			case "$kind" in
				join) roaming_event_emit client-join mac "$mac" iface "$iface" \
					ssid "$(roaming_iface_ssid "$iface")" \
					bssid "$(roaming_iface_bssid "$iface")" \
					signal "$sig" to_signal "$sig" \
					disconnect_time unavailable reconnect_time unavailable \
					packet_loss unavailable ;;
				leave) roaming_event_emit client-leave mac "$mac" iface "$iface" \
					ssid "$(roaming_iface_ssid "$iface")" \
					bssid "$(roaming_iface_bssid "$iface")" \
					signal "$sig" from_signal "$sig" \
					disconnect_time unavailable reconnect_time unavailable \
					packet_loss unavailable ;;
			esac
		done
		station_roams "$old" "$tmp" | while read -r _ mac from to fromsig tosig; do
			roaming_event_emit roam mac "$mac" from_iface "$from" to_iface "$to" \
				from_ssid "$(roaming_iface_ssid "$from")" \
				to_ssid "$(roaming_iface_ssid "$to")" \
				from_bssid "$(roaming_iface_bssid "$from")" \
				to_bssid "$(roaming_iface_bssid "$to")" \
				signal "$tosig" from_signal "$fromsig" to_signal "$tosig" \
				disconnect_time unavailable reconnect_time unavailable \
				packet_loss unavailable
		done
	fi
	mv "$tmp" "$new" 2>/dev/null && mv "$new" "$old"

	mesh_link_snapshot >"$state" 2>/dev/null
	if [ -s "$state" ] && [ -f "$links" ]; then
		awk 'FNR == NR { old[$1] = $2; next }
			($1 in old) && old[$1] != $2 { print $1, $2 }' "$links" "$state" |
			while read -r iface val; do
				case "$val" in
					up) roaming_event_emit link-up iface "$iface" ;;
					down|lowerlayerdown) roaming_event_emit link-down iface "$iface" ;;
				esac
			done
	fi
	mv "$state" "$links" 2>/dev/null

	if [ "$(uci -q get meshassistant.config.running)" = 1 ]; then
		if ! batctl meshif bat0 interface >/dev/null 2>&1; then
			if [ "$(cat "$WM_RUNTIME_DIR/batman-error" 2>/dev/null)" != 1 ]; then
				echo 1 >"$WM_RUNTIME_DIR/batman-error"
				roaming_event_emit batman-error message "batctl could not query bat0"
			fi
		else
			rm -f "$WM_RUNTIME_DIR/batman-error"
		fi
	fi
}

# Last <limit> events as a JSON array.  Lines are already JSON objects; any
# line that does not look like one is skipped rather than embedded blindly.
roaming_events_json() {
	local limit="${1:-100}" file="$WM_EVENTS" line first=1

	case "$limit" in ''|*[!0-9]*) limit=100 ;; esac
	[ "$limit" -gt 500 ] && limit=500

	printf '{"ok":true,"events":['
	if [ -f "$file" ]; then
		tail -n "$limit" "$file" | while IFS= read -r line; do
			case "$line" in
				'{'*'}') ;;
				*) continue ;;
			esac
			[ "$first" = 1 ] || printf ','
			first=0
			printf '%s' "$line"
		done
	fi
	printf ']}\n'
}

roaming_capabilities_json() {
	local k=0 v=0 kvr=0 wnm=0 dawn=0 running=0 restarts watchdog=0 failures last_restart

	roaming_k_enabled && k=1
	roaming_v_enabled && v=1
	if [ "$k" = 1 ] || [ "$v" = 1 ]; then
		kvr=1
	fi
	wnm_supported && wnm=1
	if dawn_installed; then
		dawn=1
		if /etc/init.d/dawn status >/dev/null 2>&1; then
			running=1
			restarts=$(ubus call service list '{"name":"dawn"}' 2>/dev/null |
				jsonfilter -e '@.dawn.instances.instance1.respawn_count' 2>/dev/null)
		fi
	fi

	json_init
	json_add_boolean ok 1
	json_add_boolean k "$k"
	json_add_boolean v "$v"
	# Combined flag kept for older views; it is on when either feature is on.
	json_add_boolean kvr "$kvr"
	json_add_boolean wnm "$wnm"
	json_add_boolean ft "$([ "$(uci -q get meshassistant.config.ft)" = 1 ] && echo 1 || echo 0)"
	json_add_boolean dawn "$dawn"
	json_add_boolean dawn_running "$running"
	json_add_boolean dawn_managed "$([ -f "$WM_DAWN_MARKER" ] && echo 1 || echo 0)"
	if [ -n "$restarts" ]; then
		json_add_int dawn_restarts "$restarts"
	fi
	# Watchdog state: whether recovery is enabled, how many consecutive
	# restarts failed and when the last successful restart happened.
	[ -f "$WM_DAWN_MARKER" ] && dawn_watchdog_enabled && watchdog=1
	json_add_boolean dawn_watchdog "$watchdog"
	failures=$(cat "$WM_RUNTIME_DIR/dawn-watchdog-failures" 2>/dev/null)
	case "$failures" in
		''|*[!0-9]*) failures=0 ;;
	esac
	json_add_int dawn_watchdog_failures "$failures"
	last_restart=$(cat "$WM_RUNTIME_DIR/dawn-last-restart" 2>/dev/null)
	case "$last_restart" in
		''|*[!0-9]*) last_restart=0 ;;
	esac
	json_add_int dawn_last_restart "$last_restart"
	json_add_object dawn_params
	json_add_int kicking "$(dawn_int_option dawn_kicking 3 0 3)"
	json_add_int kicking_threshold "$(dawn_int_option dawn_kicking_threshold 20 1 100)"
	json_add_int min_clients "$(dawn_int_option dawn_min_clients 3 1 100)"
	json_add_int duration "$(dawn_int_option dawn_duration 150 10 3600)"
	json_close_object
	json_dump
	echo
}

# ---------------------------------------------------------------------------
# Parameter advice
#
# Read-only snapshots of the configured thresholds and the signals currently
# reported by associated stations.  The recommendations themselves live in
# utils/roaming-advice.js so they can be tested without a radio; nothing here
# writes UCI.
# ---------------------------------------------------------------------------

roaming_num() { # value default [min] [max]
	local v="$1" d="$2" lo="${3:--100}" hi="${4:--10}" digits
	case "$v" in
		-*) digits=${v#-} ;;
		*) digits=$v ;;
	esac
	case "$digits" in
		''|*[!0-9]*) v="$d" ;;
	esac
	# Only negative dBm values make sense for these thresholds.
	case "$v" in
		-*) ;;
		*) v="$d" ;;
	esac
	[ "$v" -lt "$lo" ] && v="$lo"
	[ "$v" -gt "$hi" ] && v="$hi"
	printf '%s\n' "$v"
}

# Print "<band> <signal>" for every associated station of an AP interface.
# Entries without a numeric signal are skipped, never written as 0.
roaming_signal_lines() {
	local section dev band ifname

	for section in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$section.mode")" = ap ] || continue
		dev=$(uci -q get "wireless.$section.device")
		band=$(radio_band "$dev")
		ifname=$(iface_runtime_ifname "$section")
		if [ -z "$band" ] && [ -n "$ifname" ]; then
			band=$(iw dev "$ifname" info 2>/dev/null |
				sed -n 's/.*channel [0-9][0-9]* (\([0-9][0-9]*\) MHz).*/\1/p' |
				head -n 1 | awk '{
					if ($1 >= 2400 && $1 < 2500) print "2g"
					else if ($1 >= 5925 && $1 < 7125) print "6g"
					else if ($1 >= 4900 && $1 < 5925) print "5g"
				}')
		fi
		case "$band" in 2g|5g|6g) ;; *) band=unknown ;; esac
		[ -n "$ifname" ] || continue
		iw dev "$ifname" station dump 2>/dev/null | awk -v b="$band" '
			/^Station / {
				if (sig ~ /^-?[0-9]+$/) print b, sig
				sig = ""
				next
			}
			/signal:/ { sig = $2 }
			END { if (sig ~ /^-?[0-9]+$/) print b, sig }'
	done
}

roaming_advice_json() {
	local caps ifaces thresholds bands lines good bad suffix g b

	caps=$(roaming_capabilities_json)
	ifaces=$(roaming_ifaces_json | jsonfilter -e '@.interfaces' 2>/dev/null)
	[ -n "$ifaces" ] || ifaces='[]'

	good=$(roaming_num "$(uci -q get meshassistant.config.rssi_val)" -60 -100 -10)
	bad=$(roaming_num "$(uci -q get meshassistant.config.low_rssi_val)" -88 -100 -10)

	thresholds=$(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_object thresholds
		json_add_int good "$good"
		json_add_int bad "$bad"
		for suffix in 2g 5g 6g; do
			g=$(roaming_num "$(uci -q get "meshassistant.config.rssi_val_$suffix")" "$good" -100 -10)
			b=$(roaming_num "$(uci -q get "meshassistant.config.low_rssi_val_$suffix")" "$bad" -100 -10)
			json_add_int "good_$suffix" "$g"
			json_add_int "bad_$suffix" "$b"
		done
		json_close_object
		json_dump
	)
	thresholds=$(printf '%s' "$thresholds" | jsonfilter -e '@.thresholds' 2>/dev/null)
	[ -n "$thresholds" ] || thresholds='{"good":-60,"bad":-88}'

	lines=$(roaming_signal_lines)
	bands=$(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_array bands
		for b in 2g 5g 6g unknown; do
			signals=$(printf '%s\n' "$lines" | awk -v band="$b" '$1 == band { print $2 }')
			count=$(printf '%s\n' "$signals" | awk 'NF' | wc -l)
			[ "$count" -gt 0 ] || continue
			json_add_object
			json_add_string band "$b"
			json_add_int clients "$count"
			json_add_array signals
			while read -r sig; do
				[ -n "$sig" ] && json_add_int "" "$sig"
			done <<EOF
$signals
EOF
			json_close_array
			json_close_object
		done
		json_close_array
		json_dump
	)
	bands=$(printf '%s' "$bands" | jsonfilter -e '@.bands' 2>/dev/null)
	[ -n "$bands" ] || bands='[]'

	printf '{"ok":true,"capabilities":%s,"interfaces":%s,"thresholds":%s,"bands":%s}\n' \
		"$caps" "$ifaces" "$thresholds" "$bands"
}
