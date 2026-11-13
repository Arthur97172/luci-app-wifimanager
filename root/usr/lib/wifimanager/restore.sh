#!/bin/sh
# Scoped restore policies: what each backup scope is allowed to change.
# Split out of backup.sh to keep every backend module below the size limit.

. /usr/lib/wifimanager/common.sh

# ---------------------------------------------------------------------------
# Section-level restore policies
# ---------------------------------------------------------------------------

# Read UCI from an archive directory, or from the live configuration when the
# directory is empty.
uci_c() { # cfgdir args...
	local dir="$1"
	shift
	if [ -n "$dir" ]; then
		uci -q -c "$dir" "$@"
	else
		uci -q "$@"
	fi
}

section_is_mesh_owned_in() { # cfgdir section
	local dir="$1" sec="$2" mesh_id network
	case "$sec" in
		mesh_radio*|wifi_ap_*|mesh_*) return 0 ;;
	esac
	mesh_id=$(uci_c "$dir" get "wireless.$sec.mesh_id")
	[ -n "$mesh_id" ] && return 0
	network=$(uci_c "$dir" get "wireless.$sec.network")
	case " $network " in
		*mesh_batman*) return 0 ;;
	esac
	return 1
}

# True when a radio carries an interface owned by the mesh engine.  The
# Wireless scope must not change such a radio's channel or width: those
# settings belong to the Mesh scope, and moving them can drop the backhaul.
radio_is_mesh_owned_in() { # cfgdir radio
	local dir="$1" radio="$2" sec dev
	for sec in $(uci_c "$dir" show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		section_is_mesh_owned_in "$dir" "$sec" || continue
		dev=$(uci_c "$dir" get "wireless.$sec.device")
		case " $dev " in
			*" $radio "*) return 0 ;;
		esac
	done
	return 1
}

# Find the live radio whose PHY path matches an archived one.
radio_for_path() { # path [already-used...]
	local path="$1" used="$2" dev
	[ -n "$path" ] || return 1
	for dev in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p'); do
		[ "$(uci -q get "wireless.$dev.path")" = "$path" ] || continue
		case " $used " in
			*" $dev "*) continue ;;
		esac
		printf '%s\n' "$dev"
		return 0
	done
	return 1
}

# Archive radio name to live radio name, learned while the radio sections are
# restored.  An empty target means the radio was not restored, so interfaces
# that reference it must not be restored either.
WM_RADIO_MAP=""

radio_map_target() { # archived radio
	local pair
	for pair in $WM_RADIO_MAP; do
		case "$pair" in
			"$1="*)
				printf '%s\n' "${pair#*=}"
				return 0
				;;
		esac
	done
	return 1
}

# Translate an archived interface's device list through the radio map.
iface_devices_remapped() { # srcdir iface
	local src="$1" sec="$2" dev radio target out=""

	dev=$(uci -q -c "$src" get "wireless.$sec.device")
	[ -n "$dev" ] || return 0
	for radio in $dev; do
		if target=$(radio_map_target "$radio"); then
			[ -n "$target" ] || return 1
			out="$out $target"
		else
			out="$out $radio"
		fi
	done
	printf '%s\n' "${out# }"
}

# Restore wifi-device sections from a Wireless backup.  A section is matched by
# name, or by PHY path when the section was renamed; radios that do not match
# this device, or that carry a mesh interface, are left untouched.
merge_wireless_radios() { # srcdir
	local src="$1" sec target path cur_path band cur_band used="" restored=0 skipped=0

	WM_RADIO_MAP=""
	for sec in $(uci -q -c "$src" show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p'); do
		case "$sec" in
			''|*[!A-Za-z0-9_-]*) continue ;;
		esac
		path=$(uci -q -c "$src" get "wireless.$sec.path")
		target=""

		if uci -q get "wireless.$sec" >/dev/null 2>&1; then
			cur_path=$(uci -q get "wireless.$sec.path")
			if [ -z "$path" ] || [ "$path" = "$cur_path" ]; then
				target="$sec"
			fi
		fi
		if [ -z "$target" ]; then
			target=$(radio_for_path "$path" "$used") || target=""
		fi
		if [ -z "$target" ]; then
			echo "Skipped radio $sec: this device has no matching PHY."
			WM_RADIO_MAP="$WM_RADIO_MAP $sec="
			skipped=$((skipped + 1))
			continue
		fi
		case " $used " in
			*" $target "*)
				# The section name matched a radio already restored from
				# another archive section; try the PHY path instead.
				target=""
				[ -n "$path" ] &&
					target=$(radio_for_path "$path" "$used") || target=""
				if [ -z "$target" ]; then
					echo "Skipped radio $sec: PHY is already restored by another section."
					WM_RADIO_MAP="$WM_RADIO_MAP $sec="
					skipped=$((skipped + 1))
					continue
				fi
				;;
		esac
		band=$(uci -q -c "$src" get "wireless.$sec.band")
		cur_band=$(uci -q get "wireless.$target.band")
		if [ -n "$band" ] && [ -n "$cur_band" ] && [ "$band" != "$cur_band" ]; then
			echo "Skipped radio $sec: the archive has band $band, this device has $cur_band."
			WM_RADIO_MAP="$WM_RADIO_MAP $sec="
			skipped=$((skipped + 1))
			continue
		fi
		if radio_is_mesh_owned_in "$src" "$sec" ||
			radio_is_mesh_owned_in "" "$target"; then
			echo "Skipped radio $sec: it carries a mesh interface; restore the Mesh scope to change it."
			# The radio still exists under this name; interfaces on it are
			# valid even though its settings were not changed.
			WM_RADIO_MAP="$WM_RADIO_MAP $sec=$target"
			skipped=$((skipped + 1))
			continue
		fi
		cur_path=$(uci -q get "wireless.$target.path")
		if uci_copy_section_from_dir "$src" wireless "$sec" "$target"; then
			# An old archive may not carry a PHY path; keep the live one so a
			# restored radio stays bound to its hardware.
			[ -n "$path" ] || [ -z "$cur_path" ] ||
				uci set "wireless.$target.path=$cur_path"
			WM_RADIO_MAP="$WM_RADIO_MAP $sec=$target"
			used="$used $target"
			restored=$((restored + 1))
		else
			echo "Skipped radio $sec: the section could not be copied."
			WM_RADIO_MAP="$WM_RADIO_MAP $sec="
			skipped=$((skipped + 1))
		fi
	done
	[ "$skipped" -eq 0 ] ||
		echo "Restored $restored radio(s); skipped $skipped."
}

merge_wireless_mesh() { # srcdir
	local src="$1" sec

	# Mesh-owned sections present in the archive are restored verbatim.
	for sec in $(uci -q -c "$src" show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		section_is_mesh_owned_in "$src" "$sec" || continue
		uci_copy_section_from_dir "$src" wireless "$sec"
	done
	# Mesh-owned sections that exist live but not in the archive are removed,
	# so a mesh backup taken with the mesh off does not resurrect sections.
	for sec in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		uci -q -c "$src" get "wireless.$sec" >/dev/null 2>&1 && continue
		iface_is_mesh_owned "$sec" && uci -q del "wireless.$sec"
	done
	uci_commit wireless
}

# Wireless restore: restore Radio sections that match this device, then replace
# non-mesh interface sections that the archive contains.  Every mesh-owned
# section and every section absent from the archive stays untouched.  This is
# what keeps a Wireless restore from breaking the mesh.
merge_wireless_nonmesh() { # srcdir
	local src="$1" sec devs
	merge_wireless_radios "$src"
	for sec in $(uci -q -c "$src" show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		section_is_mesh_owned_in "$src" "$sec" && continue
		if ! devs=$(iface_devices_remapped "$src" "$sec"); then
			echo "Skipped interface $sec: its radio was not restored."
			continue
		fi
		uci_copy_section_from_dir "$src" wireless "$sec" || continue
		# A renamed radio leaves the archived device name pointing at a radio
		# that may now be on the other band.
		[ "$devs" = "$(uci -q get "wireless.$sec.device")" ] ||
			uci set "wireless.$sec.device=$devs"
	done
	uci_commit wireless
}

merge_wireless_roaming() { # srcdir
	local src="$1" sec opt
	for sec in $(uci -q -c "$src" show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		uci -q get "wireless.$sec" >/dev/null 2>&1 || continue
		for opt in ieee80211k bss_transition ieee80211r mobility_domain ft_over_ds ft_psk_generate_local; do
			uci_copy_option_from_dir "$src" wireless "$sec" "$opt"
		done
	done
	uci_commit wireless
}

# Which restore scope owns a /etc/config/meshassistant option.  Runtime
# bookkeeping (running, *_state_saved, wired_backhaul_restore_port, ...) is
# deliberately unclassified and is never restored.
meshassistant_option_scope() { # option
	case "$1" in
		enabled|role|server_dhcp|dhcp_dns|wifi_id|wifi_radio|mlo|ssid_mode|apRadio|mesh_radio|mesh_id|encryption|key|wifi_id_*|spectrum_*)
			echo mesh
			;;
		kvr|ft|mobility_domain|ft_over_ds|rssi_val|low_rssi_val|dawn_kicking|dawn_kicking_threshold|dawn_min_clients|dawn_duration|dawn_watchdog|rssi_val_*|low_rssi_val_*)
			echo roaming
			;;
		wired_backhaul|wired_port|wired_backhaul_port|backhaul_auto|backhaul_pref|backhaul_switch_delay|backhaul_stable_time|backhaul_priority|backhaul_wired_mbit|backhaul_wireless_mbit|ipmode|ipaddr|netmask|gateway|dns|hostname)
			echo backhaul
			;;
	esac
	return 0
}

# Merge only the meshassistant options owned by the selected scopes.  The file
# holds Mesh, Backhaul and Roaming settings together; replacing it whole would
# roll one scope back while restoring another.
merge_meshassistant_scope() { # srcdir scope...
	local src="$1" want="$2" type opt opt_scope

	[ -n "$want" ] || return 0
	uci -q -c "$src" get meshassistant.config >/dev/null 2>&1 || return 0

	type=$(uci -q -c "$src" get meshassistant.config)
	[ -n "$type" ] || type=meshassistant
	uci -q get meshassistant.config >/dev/null 2>&1 ||
		uci set "meshassistant.config=$type"

	# Remove live options of the selected scopes when the archive lacks them,
	# so the restored scope matches the archive instead of keeping newer values.
	for opt in $(uci -q show meshassistant.config 2>/dev/null |
		sed -n 's/^meshassistant\.config\.\([^=]*\)=.*/\1/p'); do
		opt_scope=$(meshassistant_option_scope "$opt")
		[ -n "$opt_scope" ] || continue
		case " $want " in
			*" $opt_scope "*) ;;
			*) continue ;;
		esac
		uci -q -c "$src" get "meshassistant.config.$opt" >/dev/null 2>&1 ||
			uci -q del "meshassistant.config.$opt"
	done

	for opt in $(uci -q -c "$src" show meshassistant.config 2>/dev/null |
		sed -n 's/^meshassistant\.config\.\([^=]*\)=.*/\1/p'); do
		opt_scope=$(meshassistant_option_scope "$opt")
		[ -n "$opt_scope" ] || continue
		case " $want " in
			*" $opt_scope "*) ;;
			*) continue ;;
		esac
		uci_copy_option_from_dir "$src" meshassistant config "$opt"
	done
	uci_commit meshassistant
}

merge_network_mesh() { # srcdir
	local src="$1" sec port old_port

	old_port=$(uci -q get network.mesh_wired.device)

	for sec in bat0 mesh_batman mesh_wired; do
		if uci -q -c "$src" get "network.$sec" >/dev/null 2>&1; then
			uci_copy_section_from_dir "$src" network "$sec"
		else
			uci -q del "network.$sec"
		fi
	done

	# LAN bridge membership for the mesh ports only.
	if uci -q get network.bat0 >/dev/null 2>&1; then
		bridge_add_port bat0
	else
		bridge_del_port bat0
	fi
	port=$(uci -q get network.mesh_wired.device)
	if [ -n "$port" ]; then
		bridge_add_port "$port"
	fi
	if [ -n "$old_port" ] && [ "$old_port" != "$port" ]; then
		bridge_del_port "$old_port"
	fi
	uci_commit network
}

merge_dhcp_mesh() { # srcdir
	local src="$1" opt
	uci -q -c "$src" get dhcp.lan >/dev/null 2>&1 || return 0
	uci -q get dhcp.lan >/dev/null 2>&1 || uci set dhcp.lan=dhcp
	for opt in ignore ra dhcpv6 dns dhcp_option; do
		uci_copy_option_from_dir "$src" dhcp "lan" "$opt"
	done
	uci_commit dhcp
}

merge_firewall_mesh() { # srcdir
	local src="$1" sec zone
	if uci -q -c "$src" get firewall.meshassistant_lan_wan >/dev/null 2>&1; then
		uci_copy_section_from_dir "$src" firewall meshassistant_lan_wan
	else
		uci -q del firewall.meshassistant_lan_wan
	fi

	firewall_remove_network_everywhere bat0
	firewall_remove_network_everywhere mesh_batman
	for sec in $(uci -q -c "$src" show firewall 2>/dev/null |
		sed -n 's/^firewall\.\([^.]*\)=zone$/\1/p'); do
		zone=$(uci -q -c "$src" get "firewall.$sec.name")
		[ -n "$zone" ] || continue
		case " $(uci -q -c "$src" get "firewall.$sec.network") " in
			*" bat0 "*) firewall_zone_add_network "$zone" bat0 ;;
		esac
		case " $(uci -q -c "$src" get "firewall.$sec.network") " in
			*" mesh_batman "*) firewall_zone_add_network "$zone" mesh_batman ;;
		esac
	done
	uci_commit firewall
}

replace_config_file() { # srcdir cfg
	local src="$1" cfg="$2" tmp="$WM_CONFIG_DIR/.$2.$$"
	[ -f "$src/etc/config/$cfg" ] || return 0
	cp "$src/etc/config/$cfg" "$tmp" || return 1
	chmod 600 "$tmp"
	mv "$tmp" "$WM_CONFIG_DIR/$cfg" || {
		rm -f "$tmp"
		return 1
	}
	echo "Restored /etc/config/$cfg."
}

# ---------------------------------------------------------------------------
# Runtime apply and verification
# ---------------------------------------------------------------------------

process_running() { # name
	if command -v pidof >/dev/null 2>&1; then
		pidof "$1" >/dev/null 2>&1
	else
		ps 2>/dev/null | grep -q "[ /]$1\$"
	fi
}

# A configured access point without hostapd has an interface but serves no
# SSID; that half-started state must not be reported as a verified restore.
wifi_has_ap() {
	local sec
	for sec in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$sec.mode")" = ap ] && return 0
	done
	return 1
}

dawn_should_run() {
	[ -f "$WM_DAWN_MARKER" ] || return 1
	[ -x /etc/init.d/dawn ]
}

# Bring the restored configuration into force.  The network and Wi-Fi are
# reloaded after every restore; a configuration that enables the mesh is
# applied through the same path as the Mesh Settings page, so bat0, the mesh
# radio and DAWN exist afterwards instead of the runtime keeping the sections
# the restore just replaced.
restore_apply_runtime() {
	reload_config >/dev/null 2>&1
	wm_reload_network
	wm_reload_wifi

	[ "$(uci -q get meshassistant.config.enabled)" = 1 ] || return 0

	if ! type mesh_apply_config >/dev/null 2>&1; then
		echo "The mesh backend is not available; the restored mesh configuration was not applied."
		return 1
	fi
	if ! mesh_apply_config; then
		echo "The restored mesh configuration could not be applied."
		return 1
	fi
	uci set meshassistant.config.running=1
	uci_commit meshassistant
	/etc/init.d/wifimanager enable >/dev/null 2>&1
	/etc/init.d/wifimanager restart >/dev/null 2>&1
	return 0
}

# After the reload, check that the services the restored configuration asks
# for are actually running, not merely enabled (DESIGN §10.7 "Verify Runtime
# Status").
restore_verify_services() { # touched_wireless
	local wireless="$1" i=0

	if [ "$wireless" = 1 ] && wifi_has_ap && ! process_running hostapd; then
		while [ "$i" -lt 20 ]; do
			process_running hostapd && break
			sleep 1
			i=$((i + 1))
		done
		process_running hostapd || {
			echo "hostapd did not start although access points are configured."
			return 1
		}
	fi

	if [ "$(uci -q get meshassistant.config.enabled)" = 1 ]; then
		i=0
		while [ "$i" -lt 20 ] && [ ! -e /sys/class/net/bat0 ]; do
			sleep 1
			i=$((i + 1))
		done
		[ -e /sys/class/net/bat0 ] || {
			echo "The mesh is enabled in the restored configuration but bat0 did not come up."
			return 1
		}
	fi

	if dawn_should_run && ! /etc/init.d/dawn status >/dev/null 2>&1; then
		i=0
		while [ "$i" -lt 20 ]; do
			/etc/init.d/dawn status >/dev/null 2>&1 && break
			sleep 1
			i=$((i + 1))
		done
		/etc/init.d/dawn status >/dev/null 2>&1 || {
			echo "DAWN is managed for this device but did not start."
			return 1
		}
	fi
	return 0
}
