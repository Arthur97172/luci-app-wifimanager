#!/bin/sh
# Neighbouring access point scan (DESIGN §8.1).
#
# 802.11k neighbor reports are built from the BSSIDs an AP can hear.  This
# module performs the scan and reports exactly what it returned; the analysis
# (self detection, same-SSID neighbours, security mismatch) lives in
# utils/neighbors.js.  A scan briefly takes the radio off its channel, so it
# only runs when the operator asks for it.

. /usr/lib/wifimanager/common.sh

# Fields are separated by US (0x1f) so an SSID may contain spaces and pipes.
ap_scan_sep() {
	printf '\037'
}

# ap_scan_parse_iw: parse "iw dev <if> scan" from standard input.
# Output: bssid US ssid US freq US channel US band US signal US security
ap_scan_parse_iw() {
	awk '
	function classify() {
		if (has_rsn) {
			if (auths ~ /OWE/ && auths !~ /SAE/ && auths !~ /PSK/)
				return "owe"
			if (auths ~ /SAE/ && auths ~ /PSK/)
				return "wpa2/wpa3"
			if (auths ~ /SAE/)
				return "wpa3"
			if (auths ~ /802\.1X/)
				return "enterprise"
			if (has_wpa)
				return "wpa/wpa2"
			return "wpa2"
		}
		if (has_wpa)
			return "wpa"
		if (privacy)
			return "wep"
		return "open"
	}
	function guess_chan(f) {
		if (f == 2484)
			return 14
		if (f >= 2412 && f < 2484)
			return int((f - 2407) / 5)
		if (f >= 5000 && f < 5925)
			return int((f - 5000) / 5)
		if (f >= 5925)
			return int((f - 5950) / 5)
		return 0
	}
	function guess_band(f) {
		if (f >= 5925 && f < 7125)
			return "6g"
		if (f >= 4900 && f < 5925)
			return "5g"
		if (f >= 2400 && f < 2500)
			return "2g"
		return ""
	}
	function flush(   sec, band, ch) {
		if (bssid == "")
			return
		sec = classify()
		ch = chan
		if (ch == "" && freq != "")
			ch = guess_chan(freq + 0)
		band = freq == "" ? "" : guess_band(freq + 0)
		printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\n", \
			bssid, ssid, freq, ch, band, signal, sec
		bssid = ""; ssid = ""; freq = ""; chan = ""; signal = ""
		privacy = 0; has_rsn = 0; has_wpa = 0; auths = ""
	}
	/^BSS / {
		flush()
		bssid = $2
		sub(/\(.*/, "", bssid)
		bssid = tolower(bssid)
		next
	}
	/^\tfreq: / { freq = $2; next }
	/^\tsignal: / { signal = int($2 + 0); next }
	/^\tSSID: / { ssid = substr($0, index($0, "SSID: ") + 6); next }
	/^\tcapability: / { if ($0 ~ /Privacy/) privacy = 1; next }
	/^\tRSN:/ { has_rsn = 1; next }
	/^\tWPA:/ { has_wpa = 1; next }
	/Authentication suites:/ {
		auths = auths " " substr($0, index($0, "Authentication suites:") + 23)
		next
	}
	/^\t\* channel [0-9]+/ {
		if (match($0, /channel [0-9]+/))
			chan = substr($0, RSTART + 8, RLENGTH - 8) + 0
		next
	}
	END { flush() }
	'
}

# ap_scan_parse_iwinfo: parse "iwinfo <if> scan" from standard input.
ap_scan_parse_iwinfo() {
	awk '
	function classify(enc) {
		if (enc ~ /WPA3/ && enc ~ /WPA2/)
			return "wpa2/wpa3"
		if (enc ~ /WPA3/ || enc ~ /SAE/)
			return "wpa3"
		if (enc ~ /OWE/)
			return "owe"
		if (enc ~ /WPA2/)
			return "wpa2"
		if (enc ~ /WPA/)
			return "wpa"
		if (enc ~ /WEP/)
			return "wep"
		return "open"
	}
	function flush(   band) {
		if (bssid == "")
			return
		band = ""
		if (ghz != "")
			band = ghz >= 5.925 ? "6g" : (ghz >= 4.9 ? "5g" : "2g")
		else if (chan != "")
			band = chan <= 14 ? "2g" : "5g"
		printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\n", \
			bssid, ssid, freq, chan, band, signal, classify(enc)
		bssid = ""; ssid = ""; freq = ""; chan = ""; signal = ""; enc = ""; ghz = ""
	}
	/^Cell [0-9]+ - Address: / {
		flush()
		bssid = tolower($NF)
		next
	}	/^[^ \t]+[ \t]+ESSID: / || /^[ \t]+ESSID: / {
		if (ssid != "")
			flush()
		line = $0
		sub(/^.*ESSID:[ \t]*/, "", line)
		gsub(/^"|"$/, "", line)
		ssid = line
		next
	}
	/Access Point: / {
		if (bssid == "") {
			bssid = tolower($NF)
		}
		next
	}
	/Channel: / {
		if (match($0, /Channel: [0-9]+/))
			chan = substr($0, RSTART + 9, RLENGTH - 9) + 0
		if (match($0, /[0-9.]+ GHz/))
			ghz = substr($0, RSTART, RLENGTH) + 0
		next
	}
	/Signal: / {
		if (match($0, /Signal: -?[0-9]+/))
			signal = substr($0, RSTART + 8, RLENGTH - 8) + 0
		next
	}
	/Encryption: / {
		enc = substr($0, index($0, "Encryption: ") + 12)
		next
	}
	END { flush() }
	'
}

# ap_scan_interface <radio> -> a netdev that can scan, empty when none exists
ap_scan_interface() {
	local radio="$1" section name phy
	for section in $(iface_names_of_radio "$radio"); do
		name=$(iface_runtime_ifname "$section")
		[ -n "$name" ] || continue
		iface_runtime_up "$name" && {
			printf '%s\n' "$name"
			return 0
		}
	done
	# No configured interface is up; a down one can still be tried when the
	# driver keeps it around, and a mesh point on the phy is a last resort.
	for section in $(iface_names_of_radio "$radio"); do
		name=$(iface_runtime_ifname "$section")
		[ -n "$name" ] && [ -d "/sys/class/net/$name" ] && {
			printf '%s\n' "$name"
			return 0
		}
	done
	phy=$(radio_phy "$radio")
	[ -n "$phy" ] || return 1
	iw dev 2>/dev/null | awk -v p="$phy" '
		/^phy#/ { cur = "phy" substr($0, 5); next }
		/^[[:space:]]*Interface / { if (cur == p) { print $2; exit } }'
}

# roaming_neighbor_scan_json <radio>
roaming_neighbor_scan_json() {
	local radio="$1" ifname phy band out aps source us bssid ssid freq chan aband sig sec
	local count=0

	case "$radio" in
		''|*[!A-Za-z0-9_]*)
			wm_error E-INPUT "Invalid radio name."
			return 0
			;;
	esac
	if ! uci -q get "wireless.$radio" >/dev/null 2>&1; then
		wm_error E-NORADIO "Radio '$radio' does not exist."
		return 0
	fi

	band=$(radio_band "$radio")
	phy=$(radio_phy "$radio")
	ifname=$(ap_scan_interface "$radio")

	if [ -z "$ifname" ]; then
		wm_error E-NOIFACE "Radio '$radio' has no interface to scan from. Create or enable an interface on it first."
		return 0
	fi

	aps=""
	source=""
	if command -v iw >/dev/null 2>&1; then
		out=$(iw dev "$ifname" scan 2>/dev/null)
		if [ -n "$out" ]; then
			aps=$(printf '%s\n' "$out" | ap_scan_parse_iw)
			source=iw
		fi
	fi
	if [ -z "$aps" ] && command -v iwinfo >/dev/null 2>&1; then
		out=$(iwinfo "$ifname" scan 2>/dev/null)
		if [ -n "$out" ]; then
			aps=$(printf '%s\n' "$out" | ap_scan_parse_iwinfo)
			source=iwinfo
		fi
	fi

	if [ -z "$source" ]; then
		wm_error E-SCAN "The scan returned no result. The radio may be down, busy, or restricted by the regulatory domain."
		return 0
	fi

	us=$(ap_scan_sep)

	json_init
	json_add_boolean ok 1
	json_add_string radio "$radio"
	json_add_string phy "${phy:-}"
	json_add_string ifname "$ifname"
	json_add_string band "${band:-}"
	json_add_string source "$source"
	json_add_int scanned_at "$(date +%s)"
	json_add_array access_points
	while IFS="$us" read -r bssid ssid freq chan aband sig sec; do
		[ -n "$bssid" ] || continue
		case "$bssid" in
			*[!0-9a-fA-F:]*) continue ;;
		esac
		count=$((count + 1))
		json_add_object
		json_add_string bssid "$bssid"
		json_add_string ssid "$ssid"
		case "$freq" in
			''|*[!0-9]*) json_add_string freq "" ;;
			*) json_add_int freq "$freq" ;;
		esac
		case "$chan" in
			''|*[!0-9]*) json_add_string channel "" ;;
			*) json_add_int channel "$chan" ;;
		esac
		json_add_string band "${aband:-$band}"
		case "$sig" in
			''|*[!0-9-]*) json_add_string signal "" ;;
			*) json_add_int signal "$sig" ;;
		esac
		json_add_string security "${sec:-other}"
		json_close_object
	done <<EOF
$aps
EOF
	json_close_array
	json_add_int access_point_count "$count"
	json_dump
	echo
}
