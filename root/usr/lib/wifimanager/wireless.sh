#!/bin/sh
# Wireless interface write path: AP, STA and standalone MLO.
#
# The browser never writes UCI itself.  This module validates every field,
# takes the operation lock, creates a Wireless-scope pre-change backup, keeps a
# private copy of /etc/config/wireless for rollback, runs the same radio check
# as the UI and only then commits and reloads.  Mesh-owned sections are never
# edited here; the Mesh engine remains their only writer.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/radio.sh
. /usr/lib/wifimanager/backup.sh

wireless_bool() { # value -> 1/0, empty means 0
	case "$1" in
		1|true) echo 1 ;;
		0|false|'') echo 0 ;;
		*) return 1 ;;
	esac
}

wireless_valid_token() { # UCI network name
	case "$1" in
		''|*[!A-Za-z0-9_]*) return 1 ;;
	esac
	return 0
}

wireless_valid_ifname() {
	case "$1" in
		''|*[!A-Za-z0-9_.-]*) return 1 ;;
	esac
	[ "${#1}" -le 15 ]
}

wireless_valid_mac() {
	printf '%s' "$1" | grep -Eq '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$'
}

wireless_valid_key() { # WPA passphrase, 8..63 printable ASCII bytes
	local key="$1"
	[ "${#key}" -ge 8 ] && [ "${#key}" -le 63 ] || return 1
	case "$key" in
		*[[:cntrl:]]*) return 1 ;;
	esac
	printf '%s' "$key" | LC_ALL=C grep -q '[^ -~]' && return 1
	return 0
}

wireless_ssid_bytes() {
	printf '%s' "$1" | wc -c | awk '{ print $1 }'
}

wireless_new_section_name() { # mlo flag
	local prefix n=0
	if [ "$1" = 1 ]; then
		prefix="mlo"
	else
		prefix="wifimanager_"
	fi
	while uci -q get "wireless.$prefix$n" >/dev/null 2>&1; do
		n=$((n + 1))
	done
	printf '%s\n' "$prefix$n"
}

wireless_section_owned_by_mesh() {
	iface_is_mesh_owned "$1"
}

# MLO links are EHT links.  Keep the configured width when it is a valid EHT
# width; otherwise pick a conservative width for the band.  The caller has
# already taken the pre-change backup.
wireless_enable_eht() { # radio
	local dev="$1" htmode width band
	htmode=$(uci -q get "wireless.$dev.htmode")
	case "$htmode" in EHT*) return 0 ;; esac
	width=${htmode#HE}
	width=${width#VHT}
	width=${width#HT}
	case "$width" in 20|40|80|160|320) ;; *) width=160 ;; esac
	band=$(radio_band "$dev")
	[ "$band" = 2g ] && case "$width" in 80|160|320) width=40 ;; esac
	uci set "wireless.$dev.htmode=EHT$width"
}

wireless_iface_count() {
	iw dev 2>/dev/null | awk '$1 == "Interface" { count++ } END { print count + 0 }'
}

wireless_restore_snapshot() { # snapshot
	[ -s "$1" ] || return 1
	cp "$1" "$WM_CONFIG_DIR/wireless" 2>/dev/null || return 1
	chmod 600 "$WM_CONFIG_DIR/wireless" 2>/dev/null
	uci -q commit wireless 2>/dev/null
	wm_reload_wifi
	rm -f "$1"
	return 0
}

# wireless_rollback_message <snapshot> <failure>
wireless_rollback_message() {
	if wireless_restore_snapshot "$1"; then
		printf '%s; the previous wireless configuration was restored.\n' "$2"
	else
		printf '%s; the previous wireless configuration could not be restored automatically. A recovery copy is kept at %s.\n' "$2" "$1"
	fi
}

# Wait for the kernel to show the expected interface.  A disabled interface is
# not expected at runtime, so it reports "skipped" and only the UCI commit is
# verified.  Without a configured ifname the driver assigns the name; netifd
# maps the UCI section to it, which is more precise than the interface count.
wireless_wait_iface() { # section ifname baseline want_present disabled
	local section="$1" ifname="$2" baseline="$3" want="$4" disabled="$5"
	local i=0 now runtime
	[ "$disabled" = 1 ] && {
		echo skipped
		return 0
	}
	while [ "$i" -lt 15 ]; do
		if [ -n "$ifname" ]; then
			if [ "$want" = 1 ]; then
				ip link show "$ifname" >/dev/null 2>&1 && {
					echo verified
					return 0
				}
			elif ! ip link show "$ifname" >/dev/null 2>&1 &&
				[ -z "$(uci -q get "wireless.$section")" ]; then
				# The netdev is gone and the section is gone from UCI.
				echo verified
				return 0
			fi
		else
			iface_runtime_forget
			runtime=$(iface_runtime_ifname "$section")
			if [ "$want" = 1 ]; then
				if [ -n "$runtime" ]; then
					ip link show "$runtime" >/dev/null 2>&1 && {
						echo verified
						return 0
					}
				else
					now=$(wireless_iface_count)
					[ "${now:-0}" -gt "${baseline:-0}" ] && {
						echo verified
						return 0
					}
				fi
			elif [ -z "$runtime" ] &&
				[ -z "$(uci -q get "wireless.$section")" ]; then
				# The section is gone from both netifd and UCI.
				echo verified
				return 0
			fi
		fi
		sleep 1
		i=$((i + 1))
	done
	if [ -n "$ifname" ]; then
		return 1
	fi
	# A delete is only "config-only" when netifd no longer reports the section
	# and UCI no longer has it; positive evidence of the old interface is a
	# failed removal, not an unverified success.
	if [ "$want" = 0 ] &&
		{ [ -n "${runtime:-}" ] || [ -n "$(uci -q get "wireless.$section")" ]; }; then
		return 1
	fi
	# Without an explicit ifname the runtime name is driver-assigned.  The
	# commit is verified, but the runtime state is reported separately.
	echo config-only
	return 0
}

wireless_radio_check_args() { # mode devices mlo section
	local mode="$1" devices="$2" mlo="$3" section="$4" dev
	(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_string mode "$mode"
		json_add_array device
		for dev in $devices; do
			json_add_string "" "$dev"
		done
		json_close_array
		json_add_boolean mlo "$mlo"
		json_add_string section "$section"
		json_dump
	)
}

# Print a blocking message for the first error finding, or nothing.
wireless_first_error() { # check json
	local check="$1" total i code msg
	total=$(printf '%s' "$check" | jsonfilter -e '@.conflict_count' 2>/dev/null)
	i=0
	while [ "$i" -lt "${total:-0}" ]; do
		code=$(printf '%s' "$check" | jsonfilter -e "@.conflicts[$i].code" 2>/dev/null)
		case "$code" in
			E-*)
				msg=$(printf '%s' "$check" | jsonfilter -e "@.conflicts[$i].message" 2>/dev/null)
				printf '%s: %s\n' "$code" "$msg"
				return 0
				;;
		esac
		i=$((i + 1))
	done
	return 1
}

wireless_add_warnings() { # check json; array must be open
	local check="$1" total i code msg
	total=$(printf '%s' "$check" | jsonfilter -e '@.conflict_count' 2>/dev/null)
	i=0
	while [ "$i" -lt "${total:-0}" ]; do
		code=$(printf '%s' "$check" | jsonfilter -e "@.conflicts[$i].code" 2>/dev/null)
		case "$code" in
			E-*|'') ;;
			*)
				msg=$(printf '%s' "$check" | jsonfilter -e "@.conflicts[$i].message" 2>/dev/null)
				json_add_string "" "$code: $msg"
				;;
		esac
		i=$((i + 1))
	done
}

# wireless_iface_save {section, mode, device[], network, ssid, encryption, key,
#   hidden, ieee80211w, ifname, macaddr, bssid, wds, uapsd, ocv,
#   disassoc_low_ack, disabled, mlo}
wireless_iface_save_json() {
	local args="$1"
	local section mode devices mlo network ssid encryption key hidden ieee80211w
	local ifname macaddr bssid wds uapsd ocv disassoc_low_ack disabled
	local dev devlist count=0 existing_key is_new=0 backup_id snap baseline
	local check check_args verified="" now msg

	section=$(jget "$args" '@.section')
	mode=$(jget "$args" '@.mode')
	devices=$(jget "$args" '@.device[*]')
	network=$(jget "$args" '@.network')
	ssid=$(jget "$args" '@.ssid')
	encryption=$(jget "$args" '@.encryption')
	key=$(jget "$args" '@.key')
	hidden=$(jget "$args" '@.hidden')
	ieee80211w=$(jget "$args" '@.ieee80211w')
	ifname=$(jget "$args" '@.ifname')
	macaddr=$(jget "$args" '@.macaddr')
	bssid=$(jget "$args" '@.bssid')
	wds=$(jget "$args" '@.wds')
	uapsd=$(jget "$args" '@.uapsd')
	ocv=$(jget "$args" '@.ocv')
	disassoc_low_ack=$(jget "$args" '@.disassoc_low_ack')
	disabled=$(jget "$args" '@.disabled')
	mlo=$(jget "$args" '@.mlo')

	case "$mlo" in
		true|1) mlo=1 ;;
		false|0|'') mlo=0 ;;
		*)
			wm_error E-ARG "Invalid MLO flag."
			return 1
			;;
	esac

	case "$mode" in
		ap|sta|adhoc) ;;
		mesh)
			wm_error E-ARG "802.11s mesh interfaces are managed by Mesh Settings, not by this page."
			return 1
			;;
		*)
			wm_error E-ARG "Mode must be ap, sta or adhoc."
			return 1
			;;
	esac

	if [ "$mlo" = 1 ] && [ "$mode" = adhoc ]; then
		wm_error E-ARG "MLO is only available for AP and STA interfaces."
		return 1
	fi

	# Section: either an existing operator section or a generated one.
	if [ -n "$section" ]; then
		wireless_valid_token "$section" || {
			wm_error E-ID "The section name contains invalid characters."
			return 1
		}
		[ "$(uci -q get "wireless.$section")" = wifi-iface ] || {
			wm_error E-ID "The wireless interface does not exist."
			return 1
		}
		wireless_section_owned_by_mesh "$section" && {
			wm_error E-MESH-OWNED "This interface is managed by the Mesh engine and cannot be edited here."
			return 1
		}
		[ "$(uci -q get "wireless.$section.mode")" = mesh ] && {
			wm_error E-MESH-OWNED "802.11s interfaces are configured in Mesh Settings, not on this page."
			return 1
		}
		existing_key=$(uci -q get "wireless.$section.key")
	else
		is_new=1
		existing_key=""
	fi

	# Radios: real wifi-device sections, no duplicates, MLO needs two links.
	devlist=""
	for dev in $devices; do
		[ "$(uci -q get "wireless.$dev")" = wifi-device ] || {
			wm_error E-ARG "The radio '$dev' does not exist."
			return 1
		}
		case " $devlist " in
			*" $dev "*)
				wm_error E-ARG "The same radio is selected more than once."
				return 1
				;;
		esac
		devlist="$devlist $dev"
		count=$((count + 1))
	done
	devlist=${devlist# }
	[ "$count" -gt 0 ] || {
		wm_error E-ARG "Select at least one radio."
		return 1
	}
	if [ "$mlo" = 1 ]; then
		[ "$count" -ge 2 ] || {
			wm_error E-ARG "MLO needs at least two radios."
			return 1
		}
	else
		[ "$count" -eq 1 ] || {
			wm_error E-ARG "Select exactly one radio unless the interface uses MLO."
			return 1
		}
	fi

	# Network must already exist; this page does not create network sections.
	[ -n "$network" ] || {
		if [ "$mode" = sta ]; then network=wan; else network=lan; fi
	}
	for dev in $network; do
		wireless_valid_token "$dev" || {
			wm_error E-ARG "The network name contains invalid characters."
			return 1
		}
		[ -n "$(uci -q get "network.$dev")" ] || {
			wm_error E-ARG "The network '$dev' does not exist. Create it under Network first."
			return 1
		}
	done

	[ -n "$ssid" ] || {
		wm_error E-ARG "The SSID is empty."
		return 1
	}
	[ "$(wireless_ssid_bytes "$ssid")" -le 32 ] || {
		wm_error E-ARG "The SSID is longer than 32 bytes."
		return 1
	}

	case "$encryption" in
		none|psk2|psk-mixed|sae|sae-mixed|owe|'') ;;
		*)
			wm_error E-ARG "Unsupported encryption mode."
			return 1
			;;
	esac
	[ -n "$encryption" ] || encryption=none

	case "$encryption" in
		psk2|psk-mixed|sae|sae-mixed)
			if [ -n "$key" ]; then
				wireless_valid_key "$key" || {
					wm_error E-ARG "The passphrase must be 8 to 63 printable ASCII characters."
					return 1
				}
			elif [ "$is_new" = 1 ] || [ -z "$existing_key" ]; then
				wm_error E-ARG "A passphrase is required for this encryption mode."
				return 1
			fi
			;;
	esac

	if [ -n "$ifname" ]; then
		wireless_valid_ifname "$ifname" || {
			wm_error E-ARG "The interface name may contain at most 15 letters, digits, dots, dashes or underscores."
			return 1
		}
		for dev in $(uci -q show wireless 2>/dev/null |
			sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
			[ "$dev" = "$section" ] && continue
			[ "$(uci -q get "wireless.$dev.ifname")" = "$ifname" ] && {
				wm_error E-ID "The interface name '$ifname' is already in use."
				return 1
			}
		done
	fi
	[ -z "$macaddr" ] || wireless_valid_mac "$macaddr" || {
		wm_error E-ARG "The MAC address is invalid."
		return 1
	}
	[ -z "$bssid" ] || wireless_valid_mac "$bssid" || {
		wm_error E-ARG "The BSSID is invalid."
		return 1
	}

	case "$ieee80211w" in ''|0|1|2) ;; *)
		wm_error E-ARG "802.11w must be 0, 1 or 2."
		return 1
		;; esac

	hidden=$(wireless_bool "$hidden") || {
		wm_error E-ARG "Invalid hidden-SSID flag."
		return 1
	}
	wds=$(wireless_bool "$wds") || {
		wm_error E-ARG "Invalid WDS flag."
		return 1
	}
	uapsd=$(wireless_bool "$uapsd") || {
		wm_error E-ARG "Invalid U-APSD flag."
		return 1
	}
	ocv=$(wireless_bool "$ocv") || {
		wm_error E-ARG "Invalid OCV flag."
		return 1
	}
	disassoc_low_ack=$(wireless_bool "$disassoc_low_ack") || {
		wm_error E-ARG "Invalid disassociation flag."
		return 1
	}
	disabled=$(wireless_bool "$disabled") || {
		wm_error E-ARG "Invalid disabled flag."
		return 1
	}

	# Same rules as the preview in the browser; errors block, warnings do not.
	check_args=$(wireless_radio_check_args "$mode" "$devlist" "$mlo" "$section")
	check=$(radio_check_json "$check_args")
	if err=$(wireless_first_error "$check"); then
		wm_error E-CONFLICT "$err"
		return 1
	fi

	wm_take_lock || {
		wm_error E-BUSY "Another operation is already running."
		return 1
	}

	backup_id=$(backup_create_auto wireless "Before saving wireless interface ${section:-new}")
	[ -n "$backup_id" ] || {
		wm_error E-BACKUP "The pre-change backup failed; no wireless setting was written."
		return 1
	}

	snap="$WM_RUN_DIR/wireless.pre.$$"
	cp "$WM_CONFIG_DIR/wireless" "$snap" 2>/dev/null || {
		wm_error E-IO "The wireless configuration could not be snapshotted."
		return 1
	}
	chmod 600 "$snap" 2>/dev/null
	baseline=$(wireless_iface_count)

	if [ "$is_new" = 1 ]; then
		section=$(wireless_new_section_name "$mlo")
		uci set "wireless.$section=wifi-iface"
	fi

	uci set "wireless.$section.mode=$mode"
	uci set "wireless.$section.device=$devlist"
	uci set "wireless.$section.network=$network"
	uci set "wireless.$section.ssid=$ssid"
	uci set "wireless.$section.encryption=$encryption"
	uci set "wireless.$section.disabled=$disabled"

	case "$encryption" in
		none|owe) uci -q del "wireless.$section.key" ;;
		*) [ -n "$key" ] && uci set "wireless.$section.key=$key" ;;
	esac

	if [ "$hidden" = 1 ]; then
		uci set "wireless.$section.hidden=1"
	else
		uci -q del "wireless.$section.hidden"
	fi
	case "$ieee80211w" in
		'') uci -q del "wireless.$section.ieee80211w" ;;
		*) uci set "wireless.$section.ieee80211w=$ieee80211w" ;;
	esac

	uci_update_optional "wireless.$section.ifname" "$ifname"
	uci_update_optional "wireless.$section.macaddr" "$macaddr"
	uci_update_optional "wireless.$section.bssid" "$bssid"

	if [ "$wds" = 1 ]; then uci set "wireless.$section.wds=1"; else uci -q del "wireless.$section.wds"; fi
	if [ "$uapsd" = 1 ]; then uci set "wireless.$section.uapsd=1"; else uci -q del "wireless.$section.uapsd"; fi
	if [ "$ocv" = 1 ]; then uci set "wireless.$section.ocv=1"; else uci -q del "wireless.$section.ocv"; fi
	if [ "$disassoc_low_ack" = 1 ]; then
		uci set "wireless.$section.disassoc_low_ack=1"
	else
		uci -q del "wireless.$section.disassoc_low_ack"
	fi

	if [ "$mlo" = 1 ]; then
		uci set "wireless.$section.mlo=1"
		for dev in $devlist; do
			wireless_enable_eht "$dev"
		done
	else
		uci -q del "wireless.$section.mlo"
	fi

	if ! uci -q commit wireless; then
		msg=$(wireless_rollback_message "$snap" "The wireless configuration could not be committed")
		wm_error E-IO "$msg"
		return 1
	fi

	wm_reload_wifi
	verified=$(wireless_wait_iface "$section" "$ifname" "$baseline" 1 "$disabled")
	if [ "$verified" = "config-only" ] && [ "$is_new" = 1 ]; then
		# A new interface without an ifname must increase the interface count.
		now=$(wireless_iface_count)
		[ "${now:-0}" -gt "${baseline:-0}" ] || verified=""
	fi
	if [ -z "$verified" ]; then
		msg=$(wireless_rollback_message "$snap" "The interface did not appear after reload")
		wm_log "wireless: interface $section did not appear; rolled back"
		wm_event "wireless-rollback" section "$section"
		wm_error E-VERIFY "$msg"
		return 1
	fi

	rm -f "$snap"
	wm_log "wireless: saved interface $section (mode $mode, backup $backup_id)"
	wm_event "wireless-save" section "$section" mode "$mode" backup "$backup_id"

	json_init
	json_add_boolean ok 1
	json_add_string section "$section"
	json_add_string backup "$backup_id"
	json_add_string verified "$verified"
	json_add_array warnings
	wireless_add_warnings "$check"
	json_close_array
	json_dump
	echo
	return 0
}

# wireless_iface_delete {section, confirm}
wireless_iface_delete_json() {
	local args="$1" section confirm ifname disabled baseline snap backup_id verified msg

	section=$(jget "$args" '@.section')
	confirm=$(jget "$args" '@.confirm')
	if [ "$confirm" != true ] && [ "$confirm" != 1 ]; then
		wm_error E-CONFIRM "Deleting a wireless interface requires explicit confirmation."
		return 1
	fi
	wireless_valid_token "$section" || {
		wm_error E-ID "The section name contains invalid characters."
		return 1
	}
	[ "$(uci -q get "wireless.$section")" = wifi-iface ] || {
		wm_error E-ID "The wireless interface does not exist."
		return 1
	}
	wireless_section_owned_by_mesh "$section" && {
		wm_error E-MESH-OWNED "This interface is managed by the Mesh engine and cannot be deleted here."
		return 1
	}
	[ "$(uci -q get "wireless.$section.mode")" = mesh ] && {
		wm_error E-MESH-OWNED "802.11s interfaces are configured in Mesh Settings, not on this page."
		return 1
	}

	wm_take_lock || {
		wm_error E-BUSY "Another operation is already running."
		return 1
	}

	backup_id=$(backup_create_auto wireless "Before deleting wireless interface $section")
	[ -n "$backup_id" ] || {
		wm_error E-BACKUP "The pre-change backup failed; the interface was not deleted."
		return 1
	}

	snap="$WM_RUN_DIR/wireless.pre.$$"
	cp "$WM_CONFIG_DIR/wireless" "$snap" 2>/dev/null || {
		wm_error E-IO "The wireless configuration could not be snapshotted."
		return 1
	}
	chmod 600 "$snap" 2>/dev/null
	ifname=$(uci -q get "wireless.$section.ifname")
	disabled=$(uci -q get "wireless.$section.disabled")
	baseline=$(wireless_iface_count)

	uci -q del "wireless.$section"
	if ! uci -q commit wireless; then
		msg=$(wireless_rollback_message "$snap" "The wireless configuration could not be committed")
		wm_error E-IO "$msg"
		return 1
	fi

	wm_reload_wifi
	verified=$(wireless_wait_iface "$section" "$ifname" "$baseline" 0 "$disabled")
	if [ -z "$verified" ]; then
		msg=$(wireless_rollback_message "$snap" "The interface still exists after reload")
		wm_log "wireless: interface $section still exists; delete rolled back"
		wm_event "wireless-rollback" section "$section" action delete
		wm_error E-VERIFY "$msg"
		return 1
	fi

	rm -f "$snap"
	wm_log "wireless: deleted interface $section (backup $backup_id)"
	wm_event "wireless-delete" section "$section" backup "$backup_id"

	json_init
	json_add_boolean ok 1
	json_add_string section "$section"
	json_add_string backup "$backup_id"
	json_add_string verified "$verified"
	json_dump
	echo
	return 0
}
