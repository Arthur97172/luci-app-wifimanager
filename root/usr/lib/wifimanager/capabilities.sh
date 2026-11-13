#!/bin/sh
# Driver capability data taken from "iw phy <phy> info".
#
# Every value reported here is something the driver states itself: a band and
# its frequencies, an interface mode it lists, or an interface combination it
# allows.  When a driver reports nothing, the callers say that the capability
# is unconfirmed instead of assuming a limit.  The parsers read iw output on
# standard input, so a recorded matrix can drive the tests.

. /usr/lib/wifimanager/common.sh

# cap_bands -> one line per band:
#   <band>|ht=<0|1>|ht40=<0|1>|vht=<0|1>|vht160=<0|1>|he=<0|1>|eht=<0|1>|dfs=<0|1>|channels=<n,n,..>
# Disabled and no-IR frequencies are not usable for a local AP and are left
# out of the channel list; a band whose channels are all unusable still
# appears, with an empty list, so the caller can tell it apart from a band the
# driver does not advertise at all.
cap_bands() {
	awk '
	function flush_band(   name) {
		if (!inband)
			return
		name = ""
		if (firstfreq >= 2400 && firstfreq < 2500)
			name = "2g"
		else if (firstfreq >= 4900 && firstfreq < 5925)
			name = "5g"
		else if (firstfreq >= 5925 && firstfreq < 7125)
			name = "6g"
		if (name != "")
			printf "%s|ht=%d|ht40=%d|vht=%d|vht160=%d|he=%d|eht=%d|dfs=%d|channels=%s\n", \
				name, ht, ht40, vht, vht160, he, eht, dfs, channels
		inband = 0
	}
	BEGIN {
		inband = 0; infreq = 0; firstfreq = 0
		ht = 0; ht40 = 0; vht = 0; vht160 = 0; he = 0; eht = 0; dfs = 0
		channels = ""
	}
	/^[[:space:]]*Band [0-9]+:/ {
		flush_band()
		inband = 1; infreq = 0
		ht = 0; ht40 = 0; vht = 0; vht160 = 0; he = 0; eht = 0; dfs = 0
		channels = ""; firstfreq = 0
		next
	}
	inband && /^[[:space:]]*Frequencies:/ { infreq = 1; next }
	inband && /^[[:space:]]*(Band [0-9]+:|valid interface combinations:|Supported interface modes:|Available antennas:)/ {
		infreq = 0
	}
	# The frequency table is the bulk of the output; match it first so the
	# capability checks below only run for the few flag lines.
	inband && infreq && /^[[:space:]]*\* [0-9.]+ MHz \[[0-9]+\]/ {
		if (firstfreq == 0 && match($0, /[0-9.]+ MHz/))
			firstfreq = substr($0, RSTART, RLENGTH) + 0
		if ($0 !~ /disabled/ && $0 !~ /no IR/ && match($0, /\[[0-9]+\]/)) {
			ch = substr($0, RSTART + 1, RLENGTH - 2)
			channels = (channels == "" ? ch : channels "," ch)
		}
		if ($0 ~ /radar detection/)
			dfs = 1
		next
	}
	inband && index($0, "HT20") { ht = 1 }
	inband && index($0, "HT40") { ht = 1; ht40 = 1 }
	inband && index($0, "VHT Capabilities") { vht = 1 }
	inband && index($0, "Supported Channel Width:") {
		if ($0 !~ /neither/ && index($0, "160"))
			vht160 = 1
	}
	inband && index($0, "HE Iftypes") { he = 1 }
	inband && index($0, "EHT Iftypes") { eht = 1 }
	END { flush_band() }
	'
}

# cap_modes -> the names in "Supported interface modes:", one per line.
cap_modes() {
	awk '
	/^[[:space:]]*Supported interface modes:/ { inc = 1; next }
	inc {
		if ($0 ~ /^[[:space:]]*\*/) {
			line = $0
			sub(/^[[:space:]]*\*[[:space:]]*/, "", line)
			sub(/[[:space:]]+$/, "", line)
			if (line != "")
				print line
			next
		}
		if ($0 ~ /^[[:space:]]*$/)
			next
		inc = 0
	}
	'
}

cap_combinations_reported() {
	grep -q 'valid interface combinations:' && echo 1 || echo 0
}

# cap_combinations -> one line per usable combination:
#   G:<mode>[+<mode>...]=<limit>;G:...;T=<total>;C=<channels>
# Only modes this package configures are kept (ap, sta, mesh, adhoc); a
# combination that mentions none of them cannot constrain the selection and is
# omitted rather than reported as a limit.
cap_combinations() {
	awk '
	function mapmode(s) {
		gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
		if (s == "AP")
			return "ap"
		if (s == "managed")
			return "sta"
		if (s == "mesh point")
			return "mesh"
		if (s == "IBSS")
			return "adhoc"
		return ""
	}
	function flush(   n, parts, i, part, gstart, glen, grp, rest, lim, names, j, key, mapped, out, total, chans, m, depth, cur, len, ch, k) {
		if (combo == "")
			return
		out = ""; total = ""; chans = ""
		# Split on commas, but never inside a #{ ... } group: the group is
		# one limit whose modes apply together.
		n = 0; depth = 0; cur = ""
		len = length(combo)
		for (k = 1; k <= len; k++) {
			ch = substr(combo, k, 1)
			if (ch == "{")
				depth++
			else if (ch == "}")
				depth--
			if (ch == "," && depth == 0) {
				parts[++n] = cur
				cur = ""
			}
			else {
				cur = cur ch
			}
		}
		parts[++n] = cur
		for (i = 1; i <= n; i++) {
			part = parts[i]
			gsub(/^[[:space:]]+|[[:space:]]+$/, "", part)
			gstart = index(part, "#{")
			if (gstart > 0) {
				glen = index(substr(part, gstart), "}")
				if (glen > 0) {
					grp = substr(part, gstart + 2, glen - 3)
					rest = substr(part, gstart + glen)
					mapped = ""
					if (match(rest, /<=[[:space:]]*[0-9]+/)) {
						lim = substr(rest, RSTART, RLENGTH)
						gsub(/[^0-9]/, "", lim)
						m = split(grp, names, ",")
						for (j = 1; j <= m; j++) {
							key = mapmode(names[j])
							if (key != "")
								mapped = (mapped == "" ? key : mapped "+" key)
						}
					}
					if (mapped != "")
						out = out (out == "" ? "" : ";") "G:" mapped "=" lim
				}
			}
			else if (index(part, "total") > 0 && match(part, /<=[[:space:]]*[0-9]+/)) {
				total = substr(part, RSTART, RLENGTH)
				gsub(/[^0-9]/, "", total)
			}
			else if (index(part, "#channels") > 0 && match(part, /<=[[:space:]]*[0-9]+/)) {
				chans = substr(part, RSTART, RLENGTH)
				gsub(/[^0-9]/, "", chans)
			}
		}
		if (total != "")
			out = out (out == "" ? "" : ";") "T=" total
		if (chans != "")
			out = out (out == "" ? "" : ";") "C=" chans
		if (out != "")
			print out
		combo = ""
	}
	/^[[:space:]]*valid interface combinations:/ { inc = 1; next }
	inc {
		if ($0 ~ /^[[:space:]][[:space:]]/) {
			line = $0
			sub(/^[[:space:]]+/, "", line)
			if (line ~ /^\*/) {
				flush()
				sub(/^\*[[:space:]]*/, "", line)
				combo = line
			}
			else {
				combo = combo " " line
			}
			next
		}
		flush()
		inc = 0
	}
	END { flush() }
	'
}

# cap_mode_key <editor mode> -> the name iw uses
cap_mode_key() {
	case "$1" in
		ap) echo AP ;;
		sta) echo managed ;;
		mesh) echo "mesh point" ;;
		adhoc) echo IBSS ;;
		*) echo "" ;;
	esac
}

# cap_modes_support <cap_modes output> <editor mode>
cap_modes_support() {
	local key
	key=$(cap_mode_key "$2")
	[ -n "$key" ] || return 1
	printf '%s\n' "$1" | grep -qxF "$key"
}

# cap_band_field <cap_bands output> <band> <field> -> value, empty when absent
cap_band_field() {
	printf '%s\n' "$1" | awk -F'|' -v b="$2" -v f="$3" '
		$1 == b {
			for (i = 2; i <= NF; i++) {
				split($i, kv, "=")
				if (kv[1] == f) {
					print kv[2]
					exit
				}
			}
		}'
}

# cap_htmode_field <htmode> -> the capability field it needs, empty for none
cap_htmode_field() {
	case "$1" in
		HT*) echo ht ;;
		VHT*) echo vht ;;
		HE*) echo he ;;
		EHT*) echo eht ;;
		*) echo "" ;;
	esac
}

# cap_combinations_support <combinations> <counts>
# counts is "ap=<n>;sta=<n>;mesh=<n>;adhoc=<n>".  A configuration is supported
# when at least one reported combination allows it: inside a combination the
# modes of one #{ ... } group are additive, and total/#channels limit the whole
# combination.  Returns 0 when supported, 1 otherwise.
cap_combinations_support() {
	local combos="$1" counts="$2"
	[ -n "$combos" ] || return 1
	printf '%s\n' "$combos" | awk -v counts="$counts" '
		# A combination only permits the interface types its groups name, so a
		# requested mode that the combination never mentions makes it unfit.
		function combo_mentions(line, mode,   parts2, n2, j2, kv2, modes2, mm2, k2) {
			n2 = split(line, parts2, ";")
			for (j2 = 1; j2 <= n2; j2++) {
				split(parts2[j2], kv2, "=")
				if (substr(kv2[1], 1, 2) != "G:")
					continue
				mm2 = split(substr(kv2[1], 3), modes2, "+")
				for (k2 = 1; k2 <= mm2; k2++)
					if (modes2[k2] == mode)
						return 1
			}
			return 0
		}
		BEGIN {
			n = split(counts, pairs, ";")
			for (i = 1; i <= n; i++) {
				split(pairs[i], kv, "=")
				c[kv[1]] = kv[2] + 0
			}
			used = c["ap"] + c["sta"] + c["mesh"] + c["adhoc"]
		}
		{ line[++count] = $0 }
		END {
			for (i = 1; i <= count; i++) {
				ok = 1
				m = split(line[i], parts, ";")
				for (j = 1; j <= m; j++) {
					split(parts[j], kv, "=")
					key = kv[1]
					lim = kv[2] + 0
					if (key == "T") {
						if (used > lim)
							ok = 0
					}
					else if (substr(key, 1, 2) == "G:") {
						mm = split(substr(key, 3), modes, "+")
						sum = 0
						for (k = 1; k <= mm; k++)
							sum += c[modes[k]]
						if (sum > lim)
							ok = 0
					}
				}
				for (key in c)
					if (c[key] > 0 && !combo_mentions(line[i], key))
						ok = 0
				if (ok)
					exit 0
			}
			exit 1
		}
	'
}

# capability_json_add <phy>: append a "capabilities" object to the current JSON
# object.  available=0 means the driver (or iw itself) reported nothing; the
# UI then shows the capability as unconfirmed instead of inventing zeros.
#
# Radios often share one phy (a tri-band front end on a single wiphy) and each
# inventory entry asks for the same capabilities.  The parsed result of the
# last phy is kept for the life of the process, which turns three driver
# parses into one.
capability_json_add() {
	local phy="$1" info="" mode band ht ht40 vht vht160 he eht dfs chlist
	local combos="" reported=0 modes="" bands="" line part cmodes climit total chans m

	if [ -n "$WM_CAP_PHY_SET" ] && [ "$phy" = "$WM_CAP_PHY" ]; then
		info="$WM_CAP_INFO"
		modes="$WM_CAP_MODES"
		bands="$WM_CAP_BANDS"
		combos="$WM_CAP_COMBOS"
		reported="$WM_CAP_REPORTED"
	else
		[ -n "$phy" ] && command -v iw >/dev/null 2>&1 && info=$(iw phy "$phy" info 2>/dev/null)
		if [ -n "$info" ]; then
			modes=$(printf '%s\n' "$info" | cap_modes)
			bands=$(printf '%s\n' "$info" | cap_bands)
			combos=$(printf '%s\n' "$info" | cap_combinations)
			reported=$(printf '%s\n' "$info" | cap_combinations_reported)
		fi
		WM_CAP_PHY_SET=1
		WM_CAP_PHY="$phy"
		WM_CAP_INFO="$info"
		WM_CAP_MODES="$modes"
		WM_CAP_BANDS="$bands"
		WM_CAP_COMBOS="$combos"
		WM_CAP_REPORTED="$reported"
	fi

	json_add_object capabilities
	json_add_string phy "${phy:-}"
	json_add_boolean available "$([ -n "$info" ] && echo 1 || echo 0)"

	json_add_array modes
	if [ -n "$info" ]; then
		while IFS= read -r mode; do
			[ -n "$mode" ] && json_add_string "" "$mode"
		done <<EOF
$modes
EOF
	fi
	json_close_array

	json_add_array bands
	if [ -n "$info" ]; then
		while IFS='|' read -r band ht ht40 vht vht160 he eht dfs chlist; do
			[ -n "$band" ] || continue
			json_add_object
			json_add_string band "$band"
			json_add_boolean ht "${ht#ht=}"
			json_add_boolean ht40 "${ht40#ht40=}"
			json_add_boolean vht "${vht#vht=}"
			json_add_boolean vht160 "${vht160#vht160=}"
			json_add_boolean he "${he#he=}"
			json_add_boolean eht "${eht#eht=}"
			json_add_boolean dfs "${dfs#dfs=}"
			json_add_array channels
			for part in $(printf '%s' "${chlist#channels=}" | tr ',' ' '); do
				json_add_int "" "$part"
			done
			json_close_array
			json_close_object
		done <<EOF
$bands
EOF
	fi
	json_close_array

	json_add_array combinations
	if [ -n "$combos" ]; then
		while IFS= read -r line; do
			[ -n "$line" ] || continue
			total=""
			chans=""
			json_add_object
			json_add_array groups
			for part in $(printf '%s' "$line" | tr ';' ' '); do
				case "$part" in
					G:*)
						cmodes=${part#G:}
						climit=${cmodes##*=}
						cmodes=${cmodes%=*}
						json_add_object
						json_add_array modes
						for m in $(printf '%s' "$cmodes" | tr '+' ' '); do
							json_add_string "" "$m"
						done
						json_close_array
						json_add_int limit "$climit"
						json_close_object
						;;
					T=*) total=${part#T=} ;;
					C=*) chans=${part#C=} ;;
				esac
			done
			json_close_array
			[ -n "$total" ] && json_add_int total "$total"
			[ -n "$chans" ] && json_add_int channels "$chans"
			json_close_object
		done <<EOF
$combos
EOF
	fi
	json_close_array
	json_add_boolean combinations_reported "$reported"

	json_close_object
}
