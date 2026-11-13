#!/bin/sh
# Mesh engine: roles, batman-adv, 802.11s, AP/MLO sections, spectrum,
# hybrid backhaul, node LAN and dumb AP mode.
#
# This is a split rewrite of the audited 2.7.12 engine.  The UCI effects are
# intentionally identical so that mixed fleets stay interoperable; the
# differences are: explicit server/node/client roles, pre-change backups via
# the global backup manager, and no whole-file *.meshbak restore.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/radio.sh
. /usr/lib/wifimanager/backup.sh
. /usr/lib/wifimanager/roaming.sh

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

# Print an error message and return 1 when the saved settings cannot be
# applied.  Runs before anything is written.
mesh_validate() {
	local role radio radios count key opt

	role=$(uci -q get meshassistant.config.role)
	case "${role:-server}" in
		server|node|client|off) ;;
		*) echo "Unknown mesh role '${role}'."; return 1 ;;
	esac

	if [ "$(uci -q get meshassistant.config.enabled)" != 1 ]; then
		return 0
	fi

	radio=$(uci -q get meshassistant.config.apRadio)
	set -- $radio
	if [ "$#" -ne 1 ]; then
		echo "Exactly one mesh radio must be selected (got '${radio}')."
		return 1
	fi
	uci -q get "wireless.$radio" >/dev/null 2>&1 || {
		echo "The selected mesh radio '${radio}' does not exist."
		return 1
	}

	[ -n "$(uci -q get meshassistant.config.mesh_id)" ] || {
		echo "Mesh Network SSID is empty."
		return 1
	}

	radios=$(uci -q get meshassistant.config.wifi_radio)
	[ -n "$radios" ] || {
		echo "No AP radio is selected."
		return 1
	}
	count=0
	for radio in $radios; do
		uci -q get "wireless.$radio" >/dev/null 2>&1 || {
			echo "AP radio '${radio}' does not exist."
			return 1
		}
		count=$((count + 1))
	done
	if [ "$(uci -q get meshassistant.config.mlo)" = 1 ] && [ "$count" -ne 2 ]; then
		echo "MLO requires exactly two AP radios (got ${count})."
		return 1
	fi

	key=$(uci -q get meshassistant.config.key)
	if [ "$(uci -q get meshassistant.config.encryption)" = 1 ] && [ -z "$key" ]; then
		echo "Encryption is enabled but the key is empty."
		return 1
	fi

	if [ "$(uci -q get meshassistant.config.backhaul_priority)" = manual ]; then
		for opt in backhaul_wired_mbit backhaul_wireless_mbit; do
			local mbit
			mbit=$(uci -q get "meshassistant.config.$opt")
			case "$mbit" in
				'') ;;
				*[!0-9]*)
					echo "The $opt value '${mbit}' is not a whole number of Mbit/s."
					return 1
					;;
				*)
					if [ "$mbit" -gt 100000 ]; then
						echo "The $opt value ${mbit} Mbit/s is above the supported maximum of 100000 Mbit/s."
						return 1
					fi
					;;
			esac
		done
	fi

	if [ "$(uci -q get meshassistant.config.ipmode)" = static ] &&
		[ "${role:-server}" != server ]; then
		valid_ipv4 "$(uci -q get meshassistant.config.ipaddr)" || {
			echo "The static LAN address is invalid."
			return 1
		}
		valid_netmask "$(uci -q get meshassistant.config.netmask)" || {
			echo "The static LAN netmask is invalid."
			return 1
		}
	fi
	return 0
}

# ---------------------------------------------------------------------------
# Wireless sections
# ---------------------------------------------------------------------------

# Remove mesh 802.11s sections for a mesh_id that is no longer current.  The
# optional second argument names one section to keep, so its kernel device is
# never removed while netifd still references it.
clear_by_mesh_id() { # mesh_id [keep_section]
	local mesh_id="$1" keep="$2" output sections section ssid

	[ -n "$mesh_id" ] || return 0
	output=$(uci -q show wireless)

	sections=$(printf '%s\n' "$output" |
		grep -E '^wireless\.mesh_radio[0-9]+\.mesh_id=' |
		grep -F -e "mesh_id='${mesh_id}-mesh'" -e "mesh_id='${mesh_id}'" |
		cut -d. -f2 | sort -u)
	for section in $sections; do
		[ -n "$keep" ] && [ "$section" = "$keep" ] && {
			echo "Keeping mesh network '$section' for reconfiguration."
			continue
		}
		uci -q del "wireless.$section"
		echo "Deleted mesh network '$section' with mesh_id '$mesh_id'."
	done

	# Legacy wifinetN backhaul sections from older releases.  Only delete when
	# they carry the mesh network and the mesh SSID.
	sections=$(printf '%s\n' "$output" |
		grep -E '^wireless\.wifinet[0-9]+\.network=' |
		grep -F 'mesh_batman' | cut -d. -f2 | sort -u)
	for section in $sections; do
		[ -n "$keep" ] && [ "$section" = "$keep" ] && continue
		ssid=$(uci -q get "wireless.$section.ssid")
		case "$ssid" in
			"$mesh_id"|"$mesh_id-mesh")
				uci -q del "wireless.$section"
				echo "Deleted legacy mesh wireless network '$section'."
				;;
		esac
	done
	uci_commit wireless
}

enable_eht_htmode() { # radio
	local htmode width
	htmode=$(uci -q get "wireless.$1.htmode")
	case "$htmode" in EHT*) return 0 ;; esac
	width=${htmode#HE}
	width=${width#VHT}
	width=${width#HT}
	case "$width" in 20|40|80|160|320) ;; *) width=20 ;; esac
	uci set "wireless.$1.htmode=EHT$width"
	echo "Set $1 htmode to EHT$width for MLO."
}

configure_ap_iface() { # section device [ssid]
	local section="$1" device="$2" ssid="${3:-$WIFI_ID}" ft
	ft=$(uci -q get meshassistant.config.ft)
	[ -n "$ft" ] || ft=0

	uci set "wireless.$section=wifi-iface"
	uci set "wireless.$section.device=$device"
	uci set "wireless.$section.mode=ap"
	uci set "wireless.$section.ssid=$ssid"
	uci set "wireless.$section.network=lan"
	uci set "wireless.$section.disabled=0"

	if [ "$ft" = 1 ]; then
		uci set "wireless.$section.ieee80211r=1"
		uci set "wireless.$section.mobility_domain=$MOBILITY_DOMAIN"
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

	if [ "$(uci -q get meshassistant.config.encryption)" = 1 ] && [ -n "$NETWORK_KEY" ]; then
		uci set "wireless.$section.encryption=sae-mixed"
		uci set "wireless.$section.key=$NETWORK_KEY"
	else
		uci set "wireless.$section.encryption=none"
	fi
}

setup_ap_radios() {
	local radio managed count=0 radio_ssid configured_ssid seed

	WIFI_ID=$(uci -q get meshassistant.config.wifi_id)
	WIFI_RADIOS=$(uci -q get meshassistant.config.wifi_radio)
	NETWORK_KEY=$(uci -q get meshassistant.config.key)
	MOBILITY_DOMAIN=$(uci -q get meshassistant.config.mobility_domain)
	MLO_ENABLED=$(uci -q get meshassistant.config.mlo)
	SSID_MODE=$(uci -q get meshassistant.config.ssid_mode)
	[ -n "$SSID_MODE" ] || SSID_MODE=same
	[ -n "$WIFI_ID" ] || WIFI_ID="WiFi"

	if [ -z "$MOBILITY_DOMAIN" ]; then
		seed=$(uci -q get meshassistant.config.mesh_id)
		[ -n "$seed" ] || seed="$WIFI_ID"
		MOBILITY_DOMAIN=$(printf '%s' "$seed" | cksum | awk '{ printf "%04x", $1 % 65536 }')
		uci set meshassistant.config.mobility_domain="$MOBILITY_DOMAIN"
		echo "Mobility domain derived from the mesh SSID: $MOBILITY_DOMAIN"
	fi

	for radio in $WIFI_RADIOS; do count=$((count + 1)); done

	if [ "$MLO_ENABLED" = 1 ] && [ "$count" -eq 2 ]; then
		for radio in $WIFI_RADIOS; do enable_eht_htmode "$radio"; done
		configure_ap_iface wifi_ap_mlo "$WIFI_RADIOS"
		uci set wireless.wifi_ap_mlo.mlo=1
		for radio in $WIFI_RADIOS; do
			if [ "$(uci -q get "wireless.wifi_ap_$radio.mode")" = ap ]; then
				uci -q del "wireless.wifi_ap_$radio"
				echo "Merged AP '$radio' into the MLO access point."
			fi
		done
	else
		if [ "$(uci -q get wireless.wifi_ap_mlo.mlo)" = 1 ]; then
			uci -q del wireless.wifi_ap_mlo
			echo "Deleted the MLO access point."
		fi
		for radio in $WIFI_RADIOS; do
			radio_ssid="$WIFI_ID"
			if [ "$SSID_MODE" = separate ]; then
				configured_ssid=$(uci -q get "meshassistant.config.wifi_id_$radio")
				[ -n "$configured_ssid" ] && radio_ssid="$configured_ssid"
			fi
			configure_ap_iface "wifi_ap_$radio" "$radio" "$radio_ssid"
			echo "Configured AP on $radio (SSID '$radio_ssid')."
		done
	fi

	# Only sections recorded as ours are removed when the selection shrinks.
	managed=$(uci -q get meshassistant.config.ap_radios_managed)
	for radio in $managed; do
		case " $WIFI_RADIOS " in
			*" $radio "*) continue ;;
		esac
		[ "$(uci -q get "wireless.wifi_ap_$radio.mode")" = ap ] && {
			uci -q del "wireless.wifi_ap_$radio"
			echo "Deleted stale AP '$radio'."
		}
	done
	uci -q del meshassistant.config.ap_radios_managed
	for radio in $WIFI_RADIOS; do
		uci add_list "meshassistant.config.ap_radios_managed=$radio"
	done

	uci_commit meshassistant
	uci_commit wireless
}

setup_mesh_radio() { # radio
	local radio="$1" mesh_id ssid
	mesh_id=$(uci -q get meshassistant.config.mesh_id)
	[ -n "$mesh_id" ] || {
		echo "Error: Mesh SSID is empty; cannot configure the mesh radio."
		return 1
	}
	[ -n "$radio" ] || {
		echo "Error: mesh radio is empty."
		return 1
	}
	ssid="${mesh_id}-mesh"

	uci set "wireless.mesh_$radio=wifi-iface"
	uci set "wireless.mesh_$radio.device=$radio"
	uci set "wireless.mesh_$radio.ifname=mesh_$radio"
	uci set "wireless.mesh_$radio.network=mesh_batman"
	uci set "wireless.mesh_$radio.mode=mesh"
	uci set "wireless.mesh_$radio.mesh_id=$ssid"
	uci set "wireless.mesh_$radio.mesh_fwding=0"
	uci set "wireless.mesh_$radio.mesh_rssi_threshold=0"
	uci set "wireless.mesh_$radio.mesh_ttl=1"
	uci set "wireless.mesh_$radio.mcast_rate=24000"
	uci set "wireless.mesh_$radio.disabled=0"

	if [ "$(uci -q get meshassistant.config.encryption)" = 1 ] &&
		[ -n "$(uci -q get meshassistant.config.key)" ]; then
		uci set "wireless.mesh_$radio.encryption=sae"
		uci set "wireless.mesh_$radio.key=$(uci -q get meshassistant.config.key)"
	else
		uci set "wireless.mesh_$radio.encryption=none"
	fi
	uci_commit wireless
	echo "Configured 802.11s backhaul on $radio (mesh ID '$ssid')."
}

valid_spectrum_htmode() { # band mode width
	case "$2" in
		HT) case "$3" in 20|40) return 0 ;; esac ;;
		VHT) case "$1:$3" in 5g:20|5g:40|5g:80|5g:160) return 0 ;; esac ;;
		HE) case "$3" in 20|40|80|160) return 0 ;; esac ;;
		EHT)
			case "$3" in
				20|40|80|160) return 0 ;;
				320) [ "$1" = 6g ] && return 0 ;;
			esac
			;;
	esac
	return 1
}

apply_spectrum() {
	local radio radio_list seen band country channel mode width txpower current effective

	radio_list="$(uci -q get meshassistant.config.apRadio) $(uci -q get meshassistant.config.wifi_radio)"
	seen=""
	for radio in $radio_list; do
		[ -n "$radio" ] || continue
		case " $seen " in *" $radio "*) continue ;; esac
		seen="$seen $radio"

		band=$(radio_band "$radio")
		country=$(uci -q get "meshassistant.config.spectrum_${radio}_country")
		channel=$(uci -q get "meshassistant.config.spectrum_${radio}_channel")
		mode=$(uci -q get "meshassistant.config.spectrum_${radio}_mode")
		width=$(uci -q get "meshassistant.config.spectrum_${radio}_width")
		txpower=$(uci -q get "meshassistant.config.spectrum_${radio}_txpower")

		if [ -n "$country" ]; then
			case "$country" in
				[A-Z0-9][A-Z0-9]) uci set "wireless.$radio.country=$country" ;;
				*) echo "Spectrum: ignoring invalid country '$country' for $radio." ;;
			esac
		fi

		if [ -n "$channel" ]; then
			case "$channel" in
				auto) uci set "wireless.$radio.channel=auto" ;;
				*[!0-9]*) echo "Spectrum: ignoring invalid channel '$channel' for $radio." ;;
				*) uci set "wireless.$radio.channel=$channel" ;;
			esac
		fi

		if [ -n "$mode" ] || [ -n "$width" ]; then
			current=$(uci -q get "wireless.$radio.htmode")
			if [ -z "$mode" ]; then
				case "$current" in
					EHT*) mode=EHT ;;
					HE*) mode=HE ;;
					VHT*) mode=VHT ;;
					HT*) mode=HT ;;
					*) mode='' ;;
				esac
			fi
			if [ -z "$width" ]; then
				width=${current#EHT}
				width=${width#HE}
				width=${width#VHT}
				width=${width#HT}
				case "$width" in 20|40|80|160|320) ;; *) width=20 ;; esac
			fi
			if [ -n "$mode" ] && valid_spectrum_htmode "$band" "$mode" "$width"; then
				uci set "wireless.$radio.htmode=$mode$width"
			else
				echo "Spectrum: ignoring invalid PHY mode '${mode}${width}' for $radio."
			fi
		fi

		if [ -n "$txpower" ]; then
			case "$txpower" in
				*[!0-9]*) echo "Spectrum: ignoring invalid txpower '$txpower' for $radio." ;;
				*)
					if [ "$txpower" -ge 1 ] && [ "$txpower" -le 40 ]; then
						uci set "wireless.$radio.txpower=$txpower"
					else
						echo "Spectrum: ignoring out-of-range txpower '$txpower' for $radio."
					fi
					;;
			esac
		fi

		effective=$(uci -q get "wireless.$radio.channel")
		if [ "$(uci -q get meshassistant.config.mlo)" = 1 ] && [ "$band" = 5g ]; then
			case " $(uci -q get meshassistant.config.wifi_radio) " in
				*" $radio "*)
					case "$effective" in
						52|56|60|64|100|104|108|112|116|120|124|128|132|136|140|144)
							echo "Spectrum: warning: $radio uses DFS channel $effective; radar may interrupt the MLO link."
							;;
					esac
					;;
			esac
		fi
	done
	uci_commit wireless
}

# ---------------------------------------------------------------------------
# Network, firewall, DHCP
# ---------------------------------------------------------------------------

create_bat0() {
	local role server_dhcp wan_section wan_networks

	if ! uci -q get network.bat0 >/dev/null 2>&1; then
		uci set network.bat0=interface
		uci set network.bat0.proto=batadv
		uci set network.bat0.routing_algo=BATMAN_V
		uci set network.bat0.aggregated_ogms=1
		uci set network.bat0.ap_isolation=0
		uci set network.bat0.bonding=1
		uci set network.bat0.bridge_loop_avoidance=1
		uci set network.bat0.distributed_arp_table=1
		uci set network.bat0.fragmentation=1
		uci set network.bat0.hop_penalty=30
		uci set network.bat0.isolation_mark=0x00000000/0x00000000
		uci set network.bat0.log_level=0
		uci set network.bat0.multicast_fanout=16
		uci set network.bat0.multicast_mode=1
		uci set network.bat0.network_coding=0
		uci set network.bat0.orig_interval=1000
		echo "Created bat0."
	fi

	role=$(uci -q get meshassistant.config.role)
	[ -n "$role" ] || role=server

	case "$role" in
		server)
			uci set network.bat0.gw_mode=server
			restore_node_lan_state
			restore_hostname_state
			bridge_add_port bat0
			if ! firewall_zone_has_network lan bat0; then
				uci set meshassistant.config.lan_zone_bat0_added=1
			fi
			firewall_zone_add_network lan bat0
			firewall_remove_network_everywhere mesh_batman

			server_dhcp=$(uci -q get meshassistant.config.server_dhcp)
			[ -n "$server_dhcp" ] || server_dhcp=1
			wan_section=$(firewall_zone_section wan)
			if [ -z "$wan_section" ]; then
				echo "Warning: no firewall zone named 'wan'."
			else
				wan_networks=$(uci -q get "firewall.$wan_section.network")
				if [ -z "$wan_networks" ]; then
					uci add_list "firewall.$wan_section.network=wan"
				fi
				if [ "$(uci -q get "firewall.$wan_section.masq")" != 1 ]; then
					uci set "firewall.$wan_section.masq=1"
				fi
				if [ "$(ensure_lan_wan_forwarding)" = added ]; then
					uci set meshassistant.config.forwarding_added=1
				fi
			fi
			uci_commit firewall
			restore_service_if_disabled firewall

			if [ "$server_dhcp" = 1 ]; then
				restore_service_if_disabled dnsmasq
				restore_service_if_disabled odhcpd
				restore_dhcp_lan_state
				apply_server_dhcp_dns "$(uci -q get meshassistant.config.dhcp_dns)"
				uci_commit dhcp
			else
				save_dhcp_lan_state
				if uci -q get dhcp.lan >/dev/null 2>&1; then
					uci set dhcp.lan.ignore=1
					uci set dhcp.lan.ra=disabled
					uci set dhcp.lan.dhcpv6=disabled
					uci_commit dhcp
				fi
				restore_service_if_disabled dnsmasq
				disable_service_recorded odhcpd
				echo "Server does not provide DHCP; DHCP and RA are disabled on the LAN."
			fi
			;;

		node|off)
			# "off" is accepted as a legacy alias for a non-gateway node.
			uci set network.bat0.gw_mode=off
			bridge_add_port bat0
			for service in firewall dnsmasq odhcpd; do
				disable_service_recorded "$service"
			done
			apply_node_lan
			;;

		client)
			# A client uses the mesh as an uplink and must not bridge the
			# mesh into its LAN: that would loop layer 2 back into the
			# uplink.  It also provides no DHCP/DNS/firewall.
			uci set network.bat0.gw_mode=off
			for service in firewall dnsmasq odhcpd; do
				disable_service_recorded "$service"
			done
			apply_node_lan
			;;
	esac

	# The hardif carries no device: netifd binds the 802.11s interface.
	uci -q del network.mesh_batman.device
	uci set network.mesh_batman=interface
	uci set network.mesh_batman.proto=batadv_hardif
	uci set network.mesh_batman.master=bat0
	uci set network.mesh_batman.mtu=1536

	apply_wired_backhaul
	mesh_apply_priority
	uci_commit network
	uci_commit meshassistant
}

# ---------------------------------------------------------------------------
# Wired backhaul
# ---------------------------------------------------------------------------

wired_backhaul_port() {
	local enabled port
	enabled=$(uci -q get meshassistant.config.wired_backhaul)
	[ "$enabled" = 1 ] || return 1
	port=$(uci -q get meshassistant.config.wired_port)
	[ -n "$port" ] || port=$(uci -q get meshassistant.config.wired_backhaul_port)
	[ -n "$port" ] || return 1
	printf '%s\n' "$port"
}

# The WAN uplink and the mesh backhaul must not share a port: bat0 would take
# the device out of the WAN network and the router would lose its uplink.
# Checked by device (firewall zone plus wan/wan6/wwan), so a section renamed
# by the operator is still caught.
wired_port_is_wan() { # port
	local dev
	for dev in $(wan_network_devices); do
		[ "$dev" = "$1" ] && return 0
	done
	return 1
}

wired_port_is_usable() { # port
	local port="$1" section ports
	[ -e "/sys/class/net/$port" ] || return 1
	wired_port_is_wan "$port" && return 1
	# A port that belongs to another bridge must not be stolen.
	for section in $(uci -q show network 2>/dev/null |
		sed -n "s/^network\.\([^.]*\)\.type='bridge'\$/\1/p"); do
		[ "$section" = "$(lan_bridge_section)" ] && continue
		ports=$(uci -q get "network.$section.ports")
		case " $ports " in
			*" $port "*) return 1 ;;
		esac
	done
	return 0
}

remove_wired_backhaul() {
	local port restore
	port=$(uci -q get network.mesh_wired.device)
	[ -n "$port" ] || port=$(uci -q get meshassistant.config.wired_backhaul_restore_port)
	restore=$(uci -q get meshassistant.config.wired_backhaul_bridge_removed)

	if uci -q get network.mesh_wired >/dev/null 2>&1; then
		uci -q del network.mesh_wired
		echo "Removed the wired backhaul interface."
	fi
	[ "$restore" = 1 ] && [ -n "$port" ] && bridge_add_port "$port"
	uci -q del meshassistant.config.wired_backhaul_bridge_removed
	uci -q del meshassistant.config.wired_backhaul_restore_port
}

apply_wired_backhaul() {
	local port section ports

	if ! port=$(wired_backhaul_port); then
		remove_wired_backhaul
		return 0
	fi
	if [ "$(uci -q get network.mesh_wired.device)" != "$port" ]; then
		remove_wired_backhaul
	fi
	if ! wired_port_is_usable "$port"; then
		if wired_port_is_wan "$port"; then
			echo "Warning: '$port' carries the WAN uplink and cannot be used for wired backhaul; keeping the mesh radio."
		else
			echo "Warning: '$port' cannot be used for wired backhaul; keeping the mesh radio."
		fi
		remove_wired_backhaul
		return 1
	fi

	section=$(lan_bridge_section)
	if [ -n "$section" ]; then
		ports=$(uci -q get "network.$section.ports")
		case " $ports " in
			*" $port "*)
				uci del_list "network.$section.ports=$port"
				uci set meshassistant.config.wired_backhaul_bridge_removed=1
				uci set meshassistant.config.wired_backhaul_restore_port="$port"
				echo "Removed '$port' from the LAN bridge for wired backhaul."
				;;
		esac
	fi

	uci set network.mesh_wired=interface
	uci set network.mesh_wired.proto=batadv_hardif
	uci set network.mesh_wired.master=bat0
	uci set network.mesh_wired.device="$port"
	uci set network.mesh_wired.mtu=1500
	# The kernel-negotiated speed is deliberately not copied into
	# throughput_override: it is a link rate, not a measured throughput.
	# Priority is configuration and is written by mesh_apply_priority().
	echo "Wired backhaul enabled on '$port'."
}

# Priority is configuration-level: the operator's manual throughput_override
# is written to the hardif sections.  Automatic priority leaves the option
# unset so BATMAN-adv measures the links itself; a negotiated Ethernet rate
# must not be mistaken for usable throughput.
# A throughput override is an operator estimate in Mbit/s.  batman-adv takes
# it as a fixed link rate, so zero means "measure it" and anything above a
# plausible link is a typo; both cases drop the option instead of writing a
# value the kernel would silently clamp.  The upper bound matches the largest
# link rate batctl formats without losing precision.
WM_THROUGHPUT_MAX=100000

throughput_override_set() { # section label value
	local section="$1" label="$2" value="$3"

	case "$value" in
		''|0)
			uci -q del "$section.throughput_override"
			return 0
			;;
		*[!0-9]*)
			echo "Backhaul priority: ignoring non-numeric $label throughput override '$value'."
			uci -q del "$section.throughput_override"
			return 1
			;;
	esac
	if [ "$value" -gt "$WM_THROUGHPUT_MAX" ]; then
		echo "Backhaul priority: $label throughput override ${value} Mbit/s is above ${WM_THROUGHPUT_MAX} Mbit/s; keeping it automatic."
		uci -q del "$section.throughput_override"
		return 1
	fi
	uci set "$section.throughput_override=${value}mbit"
}

# batman-adv exposes throughput_override per hardif.  When the hardif is
# already attached, verify that the module really exposes the option; a
# stripped-down build without it must not look as if the override applied.
throughput_override_capable() { # hardif
	local iface="$1"
	[ -n "$iface" ] || return 0
	# Not created or not attached yet: nothing proves the module cannot do
	# it, and refusing here would drop the saved value before every first
	# apply.  Judge only a hardif batman-adv has already taken over.
	[ -e "/sys/class/net/$iface/batman_adv" ] || return 0
	[ -e "/sys/class/net/$iface/batman_adv/throughput_override" ]
}

mesh_apply_priority() {
	local mode wired_mbit wireless_mbit wired_iface wireless_iface

	mode=$(uci -q get meshassistant.config.backhaul_priority)
	wired_mbit=$(uci -q get meshassistant.config.backhaul_wired_mbit)
	wireless_mbit=$(uci -q get meshassistant.config.backhaul_wireless_mbit)
	wired_iface=$(uci -q get network.mesh_wired.device)
	wireless_iface="mesh_$(mesh_managed_radio)"

	if [ "$mode" = manual ]; then
		if [ "$(uci -q get network.mesh_wired.proto)" = batadv_hardif ]; then
			if throughput_override_capable "$wired_iface"; then
				throughput_override_set network.mesh_wired wired "$wired_mbit"
			else
				echo "Backhaul priority: batman-adv exposes no throughput_override for '$wired_iface'; keeping it automatic."
				uci -q del network.mesh_wired.throughput_override
			fi
		fi
		if [ "$(uci -q get network.mesh_batman.proto)" = batadv_hardif ]; then
			if throughput_override_capable "$wireless_iface"; then
				throughput_override_set network.mesh_batman wireless "$wireless_mbit"
			else
				echo "Backhaul priority: batman-adv exposes no throughput_override for '$wireless_iface'; keeping it automatic."
				uci -q del network.mesh_batman.throughput_override
			fi
		fi
		echo "Backhaul priority: manual throughput override."
	else
		uci -q del network.mesh_wired.throughput_override
		uci -q del network.mesh_batman.throughput_override
	fi
}

# ---------------------------------------------------------------------------
# Apply / disable
# ---------------------------------------------------------------------------

mesh_apply_config() {
	local radio radios rc=0 role mesh_id

	mesh_id=$(uci -q get meshassistant.config.mesh_id)
	[ -n "$mesh_id" ] || return 1
	radios=$(uci -q get meshassistant.config.apRadio)
	set -- $radios
	[ "$#" -eq 1 ] || return 1
	radio="$1"

	clear_by_mesh_id "$mesh_id" "mesh_$radio"
	clear_by_mesh_id "$(uci -q get meshassistant.config.old_mesh_id)" "mesh_$radio"
	uci set meshassistant.config.old_mesh_id="$mesh_id"

	create_bat0
	apply_spectrum
	setup_ap_radios
	setup_mesh_radio "$radio" || rc=1
	[ "$rc" = 0 ] || return 1

	# Enable every radio that participates; a disabled radio would leave the
	# corresponding interface without a device.
	radios="$radio $(uci -q get meshassistant.config.wifi_radio)"
	for radio in $radios; do
		[ -n "$radio" ] || continue
		uci set "wireless.$radio.disabled=0"
	done
	uci_commit wireless

	wm_reload_network
	wm_reload_wifi
	reload_config >/dev/null 2>&1

	roaming_apply_internal
	lan_watchdog_check
}

# Applying the mesh rewrites several files through uci.  The pre-change backup
# is the durable copy; this snapshot is what the failure path restores at once,
# without going through the archive format in the middle of an apply (DESIGN
# §6.4 requires automatic rollback of a failed configuration change).
mesh_apply_snapshot() { # dir
	local snap="$1" cfg

	mkdir -p "$snap/etc/config"
	for cfg in wireless network dhcp firewall meshassistant dawn; do
		[ -f "$WM_CONFIG_DIR/$cfg" ] && cp "$WM_CONFIG_DIR/$cfg" "$snap/etc/config/$cfg"
	done
}

mesh_apply_rollback() { # snapdir
	local snap="$1" cfg

	# Discard anything staged but not committed first, so a later commit by
	# another path cannot reapply the half-written changes.
	for cfg in wireless network dhcp firewall meshassistant dawn; do
		uci -q revert "$cfg" 2>/dev/null
	done
	restore_rollback "$snap"
	reload_config >/dev/null 2>&1
	wm_reload_network
	wm_reload_wifi
}

mesh_apply() {
	local msg backup_id snap

	wm_take_lock || {
		# Do not touch op.json: another operation owns it.
		wm_log "Operation refused: another operation is already running."
		return 1
	}
	wm_op_begin mesh_apply "Applying mesh settings"

	if [ "$(uci -q get meshassistant.config.enabled)" != 1 ]; then
		mesh_op_disable
		return $?
	fi

	if ! msg=$(mesh_validate); then
		wm_log "mesh_apply rejected: $msg"
		wm_op_finish failed "$msg"
		return 1
	fi

	backup_id=$(backup_create_auto full "Before applying mesh settings")
	if [ -z "$backup_id" ]; then
		wm_op_finish failed "The pre-change backup failed; no configuration was changed."
		return 1
	fi
	wm_log "Pre-change backup $backup_id created."

	snap=$(mktemp -d /tmp/wifimanager-mesh.XXXXXX 2>/dev/null)
	if [ -z "$snap" ] || [ ! -d "$snap" ]; then
		wm_op_finish failed "Unable to create the pre-apply snapshot; no configuration was changed."
		return 1
	fi
	mesh_apply_snapshot "$snap"

	if ! mesh_apply_config; then
		mesh_apply_rollback "$snap"
		rm -rf "$snap"
		wm_op_finish failed "Applying the mesh configuration failed; the previous configuration was restored." 0
		wm_event mesh-apply result failed rolled_back 1 backup "$backup_id"
		wm_log "Mesh apply failed; the pre-apply configuration was restored (backup $backup_id)."
		return 1
	fi

	uci set meshassistant.config.running=1
	uci_commit meshassistant
	/etc/init.d/wifimanager enable >/dev/null 2>&1
	/etc/init.d/wifimanager restart >/dev/null 2>&1

	if ! ip link show bat0 >/dev/null 2>&1; then
		# The mesh did not come up: leaving the new configuration in place
		# would strand the router without the backhaul the operator had.
		# Restore the snapshot and report a failure, never a success with
		# verified=0.
		mesh_apply_rollback "$snap"
		rm -rf "$snap"
		wm_op_finish failed "bat0 did not come up; the previous configuration was restored." 0
		wm_event mesh-apply result failed rolled_back 1 backup "$backup_id"
		wm_log "Mesh apply: bat0 missing after reload; the pre-apply configuration was restored (backup $backup_id)."
		return 1
	fi
	rm -rf "$snap"

	wm_op_finish done "Mesh configuration applied." 1
	wm_event mesh-apply result ok backup "$backup_id"
	wm_log "Mesh configuration applied (backup $backup_id)."
	return 0
}

mesh_op_disable() {
	local backup_id

	backup_id=$(backup_create_auto full "Before disabling the mesh")
	if [ -z "$backup_id" ]; then
		wm_op_finish failed "The pre-change backup failed; the mesh stays enabled."
		return 1
	fi
	mesh_disable_config
	wm_op_finish done "Mesh disabled; previous LAN and services restored." 1
	wm_event mesh-apply result disabled backup "$backup_id"
	return 0
}

mesh_disable_config() {
	local mesh_id

	mesh_id=$(uci -q get meshassistant.config.mesh_id)
	clear_by_mesh_id "$mesh_id"
	clear_by_mesh_id "$(uci -q get meshassistant.config.old_mesh_id)"
	uci -q del meshassistant.config.old_mesh_id

	remove_wired_backhaul
	uci -q del network.bat0
	uci -q del network.mesh_batman
	uci_commit network

	/etc/init.d/wifimanager stop >/dev/null 2>&1

	bridge_del_port bat0
	restore_node_lan_state
	restore_hostname_state
	restore_dhcp_lan_state
	restore_services

	if [ "$(uci -q get meshassistant.config.lan_zone_bat0_added)" = 1 ]; then
		firewall_remove_network_everywhere bat0
		uci -q del meshassistant.config.lan_zone_bat0_added
	fi
	firewall_remove_network_everywhere mesh_batman
	if [ "$(uci -q get meshassistant.config.forwarding_added)" = 1 ]; then
		if [ "$(uci -q get firewall.meshassistant_lan_wan)" ]; then
			uci -q del firewall.meshassistant_lan_wan
		fi
		uci -q del meshassistant.config.forwarding_added
	fi
	uci_commit network
	uci_commit firewall
	uci_commit meshassistant

	wm_reload_all
	roaming_apply_internal
	uci -q del meshassistant.config.running
	uci_commit meshassistant
}

mesh_disable() {
	wm_take_lock || {
		# Do not touch op.json: another operation owns it.
		wm_log "Operation refused: another operation is already running."
		return 1
	}
	wm_op_begin mesh_disable "Disabling mesh"
	mesh_op_disable
	return 0
}

# ---------------------------------------------------------------------------
# Dumb AP mode
# ---------------------------------------------------------------------------

# Scoped state so leaving dumb AP restores exactly what was changed, without a
# whole-file overwrite.
dumbap_save_state() {
	[ "$(uci -q get meshassistant.config.ap_mode_enabled)" = 1 ] && return 0
	mkdir -p "$WM_CFG_DIR"
	uci -q export network.wan >"$WM_CFG_DIR/dumbap-wan.orig" 2>/dev/null
	uci -q export network.wan6 >"$WM_CFG_DIR/dumbap-wan6.orig" 2>/dev/null
	uci set meshassistant.config.dumbap_fw_lan="$(uci -q get firewall.lan.network)"
	uci set meshassistant.config.dumbap_fw_wan="$(uci -q get firewall.wan.network)"
	uci set meshassistant.config.dumbap_fw_saved=1
	uci set meshassistant.config.ap_mode_enabled=1
	uci_commit meshassistant
}

dumbap_enable() {
	local ipmode ipaddr netmask gateway dns hostname radio

	wm_take_lock || {
		# Do not touch op.json: another operation owns it.
		wm_log "Operation refused: another operation is already running."
		return 1
	}
	wm_op_begin mesh_dumbap "Enabling dumb AP mode"

	ipmode=$(uci -q get meshassistant.config.ipmode)
	if [ "$ipmode" = static ]; then
		ipaddr=$(uci -q get meshassistant.config.ipaddr)
		netmask=$(uci -q get meshassistant.config.netmask)
		gateway=$(uci -q get meshassistant.config.gateway)
		dns=$(uci -q get meshassistant.config.dns)
		if ! valid_ipv4 "$ipaddr" || ! valid_netmask "$netmask"; then
			wm_op_finish failed "The static LAN address is invalid; nothing was changed."
			return 1
		fi
		[ -z "$gateway" ] || valid_ipv4 "$gateway" || {
			wm_op_finish failed "The gateway address is invalid."
			return 1
		}
	fi

	if [ -z "$(backup_create_auto full "Before enabling dumb AP mode")" ]; then
		wm_op_finish failed "The pre-change backup failed; nothing was changed."
		return 1
	fi

	dumbap_save_state
	for service in firewall dnsmasq odhcpd; do
		disable_service_recorded "$service"
	done

	save_node_lan_state
	save_hostname_state
	if [ "$ipmode" = static ]; then
		uci set network.lan.proto=static
		uci_set_value network.lan.ipaddr "$ipaddr"
		uci_set_value network.lan.netmask "$netmask"
		uci_set_optional network.lan.gateway "$gateway"
		uci_set_optional network.lan.dns "$dns"
		uci -q del network.lan.peerdns
		uci_commit network
		lan_state_expect "$ipaddr"
	else
		uci -q del network.lan.ipaddr
		uci -q del network.lan.netmask
		uci -q del network.lan.gateway
		apply_dhcp_lan_dns "$(uci -q get meshassistant.config.dns)"
		uci set network.lan.proto=dhcp
		uci_commit network
	fi

	uci -q del network.wan
	uci -q del network.wan6
	# Turning the WAN port into a LAN port is the point of dumb AP mode.
	uci -q del firewall.lan.network
	uci -q del firewall.wan.network
	uci set dhcp.lan.ignore=1
	uci -q del dhcp.wan
	uci_commit network
	uci_commit firewall
	uci_commit dhcp

	hostname=$(uci -q get meshassistant.config.hostname)
	if [ -n "$hostname" ]; then
		uci set "system.@system[0].hostname=$hostname"
		uci_commit system
	fi
	bridge_add_port wan
	uci set meshassistant.config.dumbap_wan_bridged=1
	uci_commit network

	radio=$(uci -q get meshassistant.config.apRadio)
	if [ -n "$radio" ] && [ -n "$(uci -q get meshassistant.config.mesh_id)" ]; then
		local section ssid network
		uci -q show wireless |
			grep "wireless\.wifinet" | grep '\.ssid=' | while IFS= read -r line; do
			section=$(printf '%s' "$line" | cut -d. -f2)
			ssid=$(printf '%s' "$line" | cut -d= -f2 | tr -d "'")
			[ "$ssid" = "$(uci -q get meshassistant.config.mesh_id)" ] || continue
			network=$(uci -q get "wireless.$section.network")
			case " $network " in
				*mesh_batman*) ;;
				*) uci set "wireless.$section.network=$network mesh_batman" ;;
			esac
		done
		uci_commit wireless
	fi

	wm_reload_wifi
	wm_reload_network
	reload_config >/dev/null 2>&1
	lan_watchdog_check
	wm_op_finish done "Dumb AP mode enabled." 1
	return 0
}

dumbap_disable() {
	local port

	wm_take_lock || {
		# Do not touch op.json: another operation owns it.
		wm_log "Operation refused: another operation is already running."
		return 1
	}
	wm_op_begin mesh_undumbap "Leaving dumb AP mode"

	[ "$(uci -q get meshassistant.config.ap_mode_enabled)" = 1 ] || {
		wm_op_finish done "Dumb AP mode is not enabled." 1
		return 0
	}

	if [ -z "$(backup_create_auto full "Before leaving dumb AP mode")" ]; then
		wm_op_finish failed "The pre-change backup failed; dumb AP mode stays enabled."
		return 1
	fi

	restore_node_lan_state
	restore_hostname_state
	restore_services

	if [ "$(uci -q get meshassistant.config.dumbap_fw_saved)" = 1 ]; then
		[ -n "$(uci -q get meshassistant.config.dumbap_fw_lan)" ] &&
			uci set "firewall.lan.network=$(uci -q get meshassistant.config.dumbap_fw_lan)"
		[ -n "$(uci -q get meshassistant.config.dumbap_fw_wan)" ] &&
			uci set "firewall.wan.network=$(uci -q get meshassistant.config.dumbap_fw_wan)"
		uci -q del meshassistant.config.dumbap_fw_lan
		uci -q del meshassistant.config.dumbap_fw_wan
		uci -q del meshassistant.config.dumbap_fw_saved
	fi

	# Restore wan/wan6 sections only when they are still absent.
	if [ -s "$WM_CFG_DIR/dumbap-wan.orig" ]; then
		uci -q get network.wan >/dev/null 2>&1 ||
			uci_copy_section_from_file network wan "$WM_CFG_DIR/dumbap-wan.orig"
		rm -f "$WM_CFG_DIR/dumbap-wan.orig"
	fi
	if [ -s "$WM_CFG_DIR/dumbap-wan6.orig" ]; then
		uci -q get network.wan6 >/dev/null 2>&1 ||
			uci_copy_section_from_file network wan6 "$WM_CFG_DIR/dumbap-wan6.orig"
		rm -f "$WM_CFG_DIR/dumbap-wan6.orig"
	fi

	if [ "$(uci -q get meshassistant.config.dumbap_wan_bridged)" = 1 ]; then
		bridge_del_port wan
		uci -q del meshassistant.config.dumbap_wan_bridged
	fi
	uci -q del meshassistant.config.ap_mode_enabled
	uci_commit network
	uci_commit firewall
	uci_commit dhcp
	uci_commit meshassistant

	wm_reload_all
	wm_op_finish done "Dumb AP mode disabled; previous configuration restored." 1
	return 0
}
