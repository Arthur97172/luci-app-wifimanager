#!/bin/sh
# Channel scan data for the automatic channel recommendation.
#
# A scan on a running AP briefly takes the radio off-channel, so this module is
# only called after the operator confirms the scan in the UI.  Everything here
# is read-only.  Candidate channels come from the driver (iw phy info); when the
# driver does not report them the method fails instead of inventing a channel
# plan.  The ranking itself lives in utils/channel.js so it can be tested
# without a radio.  The rpcd plugin sources radio.sh before this file: the
# radio and runtime-interface helpers live there.

. /usr/lib/wifimanager/common.sh

# channel_width_of <htmode> -> 20|40|80|160|320
# HT20, VHT80, HE160 and EHT320 carry the width as the trailing number.  An
# unknown or empty htmode is reported as 20 MHz, the width every band accepts.
channel_width_of() {
	local htmode="$1" width

	width=$(printf '%s' "$htmode" | sed -n 's/^[A-Za-z]*\([0-9][0-9]*\)$/\1/p')
	case "$width" in
		20|40|80|160|320) ;;
		*) width=20 ;;
	esac
	printf '%s\n' "$width"
}

# channel_ifname_for_radio <wifi-device> -> a runtime interface on that radio
# Prefers an interface the kernel reports as up; a configured name alone is not
# enough to scan with.
channel_ifname_for_radio() {
	local dev="$1" section ifname fallback=""

	for section in $(iface_names_of_radio "$dev"); do
		[ "$(uci -q get "wireless.$section.disabled")" = 1 ] && continue
		ifname=$(iface_runtime_ifname "$section")
		[ -n "$ifname" ] || continue
		if iface_runtime_up "$ifname"; then
			printf '%s\n' "$ifname"
			return 0
		fi
		[ -n "$fallback" ] || fallback="$ifname"
	done

	[ -n "$fallback" ] && printf '%s\n' "$fallback"
	return 0
}

# channel_scan_cells <ifname> <band>
# Prints "<frequency> <signal dBm>" for every BSS the scan returns.  Returns 1
# only when neither iwinfo nor iw could run the scan; an empty result from a
# successful scan is valid and means no BSS was visible.
channel_scan_cells() {
	local ifname="$1" band="$2" out rc=1

	if [ -n "$band" ] && command -v iwinfo >/dev/null 2>&1; then
		out=$(iwinfo "$ifname" scan 2>/dev/null)
		rc=$?
		if [ "$rc" -eq 0 ]; then
			printf '%s\n' "$out" | awk -v band="$band" '
				function chfreq(ch) {
					if (band == "2g")
						return (ch == 14) ? 2484 : 2407 + ch * 5
					if (band == "6g")
						return 5950 + ch * 5
					return 5000 + ch * 5
				}
				function flush() {
					if (ch ~ /^[0-9]+$/ && sig ~ /^-?[0-9]+$/)
						print chfreq(ch), sig
					ch = ""; sig = ""
				}
				/^Cell [0-9]+/ { flush(); next }
				/Channel:[[:space:]]*[0-9]+/ {
					match($0, /Channel:[[:space:]]*[0-9]+/)
					ch = substr($0, RSTART, RLENGTH)
					sub(/.*:[[:space:]]*/, "", ch)
					next
				}
				/Signal:[[:space:]]*-?[0-9]+/ {
					match($0, /Signal:[[:space:]]*-?[0-9]+/)
					sig = substr($0, RSTART, RLENGTH)
					sub(/.*:[[:space:]]*/, "", sig)
					next
				}
				END { flush() }'
			return 0
		fi
	fi

	if command -v iw >/dev/null 2>&1; then
		out=$(iw dev "$ifname" scan 2>/dev/null)
		rc=$?
		[ "$rc" -eq 0 ] || return 1
		printf '%s\n' "$out" | awk '
			function flush() {
				if (freq ~ /^[0-9]+$/ && sig ~ /^-?[0-9]+$/)
					print freq, sig + 0
				freq = ""; sig = ""
			}
			/^BSS / { flush(); next }
			/^[[:space:]]*freq:/ {
				freq = $2
				sub(/\.0+$/, "", freq)
				next
			}
			/^[[:space:]]*signal:/ {
				sig = $2
				sub(/\..*$/, "", sig)
				next
			}
			END { flush() }'
		return 0
	fi

	return 1
}

# channel_candidates <phy>
# Prints "<channel> <frequency> <band> <dfs>" for every channel the driver says
# can run an AP.  Disabled and no-IR entries are skipped.
channel_candidates() {
	local phy="$1"

	[ -n "$phy" ] || return 1

	iw phy "$phy" info 2>/dev/null | awk '
		/Frequencies:/ { in_freq = 1; next }
		in_freq && /\* [0-9.]+ MHz \[[0-9]+\]/ {
			line = $0
			if (line ~ /disabled/ || line ~ /no IR/)
				next
			match(line, /[0-9.]+ MHz \[[0-9]+\]/)
			cell = substr(line, RSTART, RLENGTH)
			split(cell, part, " ")
			freq = part[1] + 0
			chan = part[3]
			gsub(/[\[\]]/, "", chan)
			if (freq >= 2400 && freq < 2500)
				band = "2g"
			else if (freq >= 5925 && freq < 7125)
				band = "6g"
			else if (freq >= 4900 && freq < 5925)
				band = "5g"
			else
				next
			dfs = (line ~ /radar detection/) ? 1 : 0
			print chan, freq, band, dfs
		}' | sort -k2n | awk '!seen[$2]++'
}

# channel_busy <ifname> -> integer 0-100 of the in-use channel, empty if unknown
channel_busy() {
	local ifname="$1"

	[ -n "$ifname" ] || return 0
	iw dev "$ifname" survey dump 2>/dev/null | awk '
		/frequency:/ { inuse = ($0 ~ /\[in use\]/); next }
		inuse && /channel active time:/ { active = $4 }
		inuse && /channel busy time:/ { busy = $4 }
		END {
			if (active + 0 > 0)
				printf "%.0f", busy * 100 / active
		}'
}

# channel_advice_json <wifi-device>
# Read-only scan and candidate data.  The interface is chosen from UCI, never
# taken from the browser, and the radio name is checked against
# /etc/config/wireless before anything is run.
channel_advice_json() {
	local dev="$1" band phy ifname width current busy cells candidates

	case "$dev" in
		''|*[!A-Za-z0-9_]*) wm_error E-INPUT "Invalid radio name."; return 0 ;;
	esac
	uci -q get "wireless.$dev" >/dev/null 2>&1 || {
		wm_error E-INPUT "Radio '$dev' does not exist."
		return 0
	}

	band=$(radio_band "$dev")
	phy=$(radio_phy "$dev")
	width=$(channel_width_of "$(uci -q get "wireless.$dev.htmode")")
	ifname=$(channel_ifname_for_radio "$dev")

	# An automatic channel leaves radio_band empty.  The running interface still
	# reports its frequency, which is enough to name the band for the scan.
	if [ -z "$band" ] && [ -n "$ifname" ]; then
		band=$(iw dev "$ifname" info 2>/dev/null |
			sed -n 's/.*channel [0-9][0-9]* (\([0-9][0-9]*\) MHz).*/\1/p' |
			head -n 1 | awk '{
				if ($1 >= 2400 && $1 < 2500) print "2g"
				else if ($1 >= 5925 && $1 < 7125) print "6g"
				else if ($1 >= 4900 && $1 < 5925) print "5g"
			}')
	fi
	[ -n "$ifname" ] || {
		wm_error E-NOIFACE "No running interface on radio '$dev'; start an interface before scanning."
		return 0
	}
	[ -n "$phy" ] || {
		wm_error E-NOPHY "Radio '$dev' could not be mapped to a phy."
		return 0
	}

	candidates=$(channel_candidates "$phy")
	[ -n "$candidates" ] || {
		wm_error E-NOPHY "The driver reported no usable channel for radio '$dev'."
		return 0
	}

	cells=$(channel_scan_cells "$ifname" "$band") || {
		wm_error E-SCAN "The channel scan could not be run on '$ifname'."
		return 0
	}

	current=$(iface_runtime_info "$ifname" | awk '{ print $1 }')
	case "$current" in
		''|'-'|auto) current=$(uci -q get "wireless.$dev.channel") ;;
	esac
	case "$current" in
		''|'-'|auto) current="" ;;
	esac
	busy=$(channel_busy "$ifname")

	json_init
	json_add_boolean ok 1
	json_add_string radio "$dev"
	json_add_string ifname "$ifname"
	json_add_string band "$band"
	json_add_int width "$width"
	json_add_string current_channel "${current:--}"
	json_add_int current_busy "${busy:-0}"
	json_add_boolean scan_ok 1

	json_add_array cells
	while read -r freq sig; do
		[ -n "$freq" ] || continue
		json_add_object
		json_add_int freq "$freq"
		json_add_int signal "$sig"
		json_close_object
	done <<EOF
$cells
EOF
	json_close_array

	json_add_array candidates
	while read -r chan freq cband dfs; do
		[ -n "$chan" ] || continue
		json_add_object
		json_add_int channel "$chan"
		json_add_int freq "$freq"
		json_add_string band "$cband"
		json_add_boolean dfs "$dfs"
		json_close_object
	done <<EOF
$candidates
EOF
	json_close_array

	json_dump
	echo
}
