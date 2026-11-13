#!/bin/sh
# Read-only network checks: DHCP, DNS, IPv4 addressing, routing, firewall
# zones and the mesh/bridge relationship.
#
# The checker never writes UCI and never changes a service.  Findings are
# configuration-level facts from /etc/config plus the enabled state of the
# services that would act on them; runtime reachability is not claimed.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/radio.sh

NC_COUNT=0
NC_ERRORS=0
NC_WARNINGS=0

nc_emit() { # code severity message detail
	json_add_object
	json_add_string code "$1"
	json_add_string severity "$2"
	json_add_string message "$3"
	json_add_string detail "$4"
	json_close_object
	NC_COUNT=$((NC_COUNT + 1))
	if [ "$2" = error ]; then
		NC_ERRORS=$((NC_ERRORS + 1))
	else
		NC_WARNINGS=$((NC_WARNINGS + 1))
	fi
}

nc_network_sections() {
	local s
	for s in $(uci -q show network 2>/dev/null |
		sed -n 's/^network\.\([^.]*\)=interface$/\1/p'); do
		[ "$(uci -q get "network.$s.disabled")" = 1 ] && continue
		printf '%s\n' "$s"
	done
}

nc_ip_int() {
	printf '%s' "$1" | awk -F. 'NF == 4 { printf "%.0f\n", $1 * 16777216 + $2 * 65536 + $3 * 256 + $4 }'
}

# ip prefix -> "base end"
nc_subnet_bounds() {
	awk -v ip="$(nc_ip_int "$1")" -v p="$2" 'BEGIN {
		if (p < 0 || p > 32) exit 1
		size = 2 ^ (32 - p)
		base = int(ip / size) * size
		printf "%.0f %.0f\n", base, base + size - 1
	}'
}

nc_emit_findings() { # newline records: code|severity|message|detail
	local code sev msg detail
	while IFS='|' read -r code sev msg detail; do
		code=${code# }
		code=${code% }
		[ -n "$code" ] || continue
		nc_emit "$code" "$sev" "$msg" "$detail"
	done <<EOF
$1
EOF
}

nc_lan_bridge_has() { # device
	local section ports
	section=$(lan_bridge_section) || return 1
	[ -n "$section" ] || return 1
	[ "$(uci -q get "network.$section.device")" = "$1" ] && return 0
	ports=$(uci -q get "network.$section.ports")
	case " $ports " in
		*" $1 "*) return 0 ;;
	esac
	return 1
}

# ---------------------------------------------------------------------------
# IPv4 addressing
# ---------------------------------------------------------------------------

nc_ip_records() {
	local s ip mask
	for s in $(nc_network_sections); do
		ip=$(uci -q get "network.$s.ipaddr")
		[ -n "$ip" ] || continue
		valid_ipv4 "$ip" || continue
		mask=$(uci -q get "network.$s.netmask")
		[ -n "$mask" ] || mask="-"
		printf '%s %s %s\n' "$s" "$ip" "$mask"
	done
}

nc_check_ipv4() {
	local records findings
	records=$(nc_ip_records)
	[ -n "$records" ] || return 0

	findings=$(printf '%s\n' "$records" | awk '
		function toint(ip, a) {
			split(ip, a, ".")
			return a[1] * 16777216 + a[2] * 65536 + a[3] * 256 + a[4]
		}
		function prefix(mask, v, p, size) {
			v = toint(mask)
			for (p = 0; p <= 32; p++) {
				size = 2 ^ (32 - p)
				if (int(v / size) * size == v)
					return p
			}
			return -1
		}
		{
			iface = $1
			ip = $2
			mask = $3
			if (ip in seen)
				printf "N-IP-01|error|Two interfaces are configured with the same IPv4 address.|%s and %s use %s\n", seen[ip], iface, ip
			else
				seen[ip] = iface
			if (mask == "-")
				next
			n++
			name[n] = iface
			addr[n] = ip
			p = prefix(mask)
			if (p < 0)
				next
			size = 2 ^ (32 - p)
			base[n] = int(toint(ip) / size) * size
			end[n] = base[n] + size - 1
			valid[n] = 1
		}
		END {
			for (i = 1; i <= n; i++) {
				if (!valid[i])
					continue
				for (j = i + 1; j <= n; j++) {
					if (!valid[j] || name[i] == name[j] || addr[i] == addr[j])
						continue
					if (base[i] <= end[j] && base[j] <= end[i])
						printf "N-IP-02|warning|Two interfaces have overlapping IPv4 subnets.|%s and %s\n", name[i], name[j]
				}
			}
		}
	')
	nc_emit_findings "$findings"
}

# ---------------------------------------------------------------------------
# DHCP pools and servers
# ---------------------------------------------------------------------------

nc_check_dhcp() {
	local s iface ignore start limit ip mask prefix bounds base end pool_start pool_end
	local pool_records="" seen_ifaces=" " duplicate_findings="" pool_findings=""
	local active_dhcp=0 role server_dhcp

	for s in $(uci -q show dhcp 2>/dev/null |
		sed -n 's/^dhcp\.\([^.]*\)=dhcp$/\1/p'); do
		ignore=$(uci -q get "dhcp.$s.ignore")
		[ "$ignore" = 1 ] && continue
		if [ -n "$(uci -q get "dhcp.$s.interface")" ]; then
			active_dhcp=1
		fi
		for iface in $(uci -q get "dhcp.$s.interface"); do
			case " $seen_ifaces " in
				*" $iface "*)
					duplicate_findings="${duplicate_findings:+$duplicate_findings
}N-DHCP-01|error|More than one DHCP server is active on the same interface.|$iface ($s)"
					;;
				*) seen_ifaces="$seen_ifaces $iface " ;;
			esac
		done

		iface=$(uci -q get "dhcp.$s.interface" | awk '{ print $1 }')
		[ -n "$iface" ] || continue
		ip=$(uci -q get "network.$iface.ipaddr")
		mask=$(uci -q get "network.$iface.netmask")
		[ -n "$ip" ] && [ -n "$mask" ] || continue
		valid_ipv4 "$ip" || continue
		prefix=$(netmask_prefix "$mask") || continue
		start=$(uci -q get "dhcp.$s.start")
		limit=$(uci -q get "dhcp.$s.limit")
		[ -n "$start" ] || start=100
		[ -n "$limit" ] || limit=150
		case "$start$limit" in *[!0-9]*) continue ;; esac
		[ "${limit:-0}" -gt 0 ] || continue
		bounds=$(nc_subnet_bounds "$ip" "$prefix") || continue
		set -- $bounds
		base="$1"
		end="$2"
		# dhcp start/limit are offsets from the network address, not dotted IPs.
		pool_start=$((base + start))
		pool_end=$((pool_start + limit - 1))
		if [ "${pool_start:-0}" -lt "${base:-0}" ] || [ "${pool_end:-0}" -gt "${end:-0}" ]; then
			pool_findings="${pool_findings:+$pool_findings
}N-POOL-01|error|The DHCP pool is outside its interface subnet.|$s $iface offset $start + $limit vs $ip/$prefix"
		else
			pool_records="$pool_records$s $iface $pool_start $pool_end
"
		fi
	done

	nc_emit_findings "$duplicate_findings"
	nc_emit_findings "$pool_findings"

	if [ -n "$pool_records" ]; then
		findings=$(printf '%s' "$pool_records" | awk '
			{
				n++
				section[n] = $1
				iface[n] = $2
				start[n] = $3
				end[n] = $4
			}
			END {
				for (i = 1; i <= n; i++)
					for (j = i + 1; j <= n; j++)
						if (section[i] != section[j] && start[i] <= end[j] && start[j] <= end[i])
							printf "N-POOL-02|warning|Two DHCP pools overlap.|%s (%s) and %s (%s)\n", section[i], iface[i], section[j], iface[j]
			}
		')
		nc_emit_findings "$findings"
	fi

	# Role expectations: only the server may run a DHCP server.
	if [ "$(uci -q get meshassistant.config.enabled)" = 1 ]; then
		role=$(uci -q get meshassistant.config.role)
		[ -n "$role" ] || role=server
		case "$role" in
			node|client)
				if [ "$active_dhcp" = 1 ] && service_enabled dnsmasq; then
					nc_emit N-DHCP-02 warning \
						"The node/client role should not run a DHCP server, but an active DHCP pool is configured." "$role"
				fi
				;;
			server)
				server_dhcp=$(uci -q get meshassistant.config.server_dhcp)
				[ -n "$server_dhcp" ] || server_dhcp=1
				if [ "$server_dhcp" = 0 ]; then
					if [ "$(uci -q get dhcp.lan.ignore)" != 1 ]; then
						nc_emit N-DHCP-03 warning \
							"The server is set not to provide DHCP, but the LAN DHCP server is still active." "dhcp.lan.ignore is not 1"
					fi
				elif [ "$(uci -q get dhcp.lan.ignore)" = 1 ]; then
					nc_emit N-DHCP-04 warning \
						"The server role should provide DHCP, but the LAN DHCP server is disabled." "dhcp.lan.ignore=1"
				fi
				;;
		esac
	fi
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

nc_check_dns() {
	local s ip dns bad
	for s in $(nc_network_sections); do
		ip=$(uci -q get "network.$s.ipaddr")
		[ -n "$ip" ] || continue
		dns=$(uci -q get "network.$s.dns")
		[ -n "$dns" ] || continue
		bad=""
		for addr in $dns; do
			case "$addr" in
				127.0.0.1|0.0.0.0|"$ip") bad="$bad $addr" ;;
			esac
		done
		if [ -n "$bad" ]; then
			nc_emit N-DNS-01 warning \
				"An interface points its resolver at itself or at a loopback address." "$s:$bad"
		fi
	done

	for s in $(uci -q show dhcp 2>/dev/null |
		sed -n 's/^dhcp\.\([^.]*\)=dnsmasq$/\1/p'); do
		[ "$(uci -q get "dhcp.$s.noresolv")" = 1 ] || continue
		[ -n "$(uci -q get "dhcp.$s.server")" ] && continue
		nc_emit N-DNS-02 warning \
			"dnsmasq ignores the system resolvers but no upstream server is configured." "$s"
	done
}

# ---------------------------------------------------------------------------
# Bridging and routing
# ---------------------------------------------------------------------------

nc_check_bridge_route() {
	local s dev lan ports lan_section defaults=0 gateways=0 names=""

	lan=$(lan_device)
	lan_section=$(lan_bridge_section) || lan_section=""
	ports=""
	[ -n "$lan_section" ] && ports=$(uci -q get "network.$lan_section.ports")

	for s in $(nc_network_sections); do
		case "$s" in
			wan|wan6|wan_*|wwan|wwan_*)
				for dev in $(uci -q get "network.$s.device") $(uci -q get "network.$s.ifname"); do
					if [ "$dev" = "$lan" ]; then
						nc_emit N-BRIDGE-01 error \
							"A WAN interface uses the same device as the LAN bridge." "$s -> $dev"
					fi
					case " $ports " in
						*" $dev "*) nc_emit N-BRIDGE-02 error \
							"A WAN interface is a member of the LAN bridge." "$s -> $dev" ;;
					esac
				done
				;;
		esac
	done

	for s in $(nc_network_sections); do
		[ "$(uci -q get "network.$s.defaultroute")" = 1 ] && {
			defaults=$((defaults + 1))
			names="$names $s"
		}
		if [ "$(uci -q get "network.$s.proto")" = static ] && [ "$s" != lan ] &&
			[ -n "$(uci -q get "network.$s.gateway")" ]; then
			gateways=$((gateways + 1))
			case " $names " in *" $s "*) ;; *) names="$names $s" ;; esac
		fi
	done
	if [ "$defaults" -gt 1 ] || [ "$gateways" -gt 1 ]; then
		nc_emit N-ROUTE-01 warning \
			"More than one interface proposes a default route." "$names"
	fi
}

# ---------------------------------------------------------------------------
# Firewall zones
# ---------------------------------------------------------------------------

nc_check_firewall() {
	local z s n proto zone_networks=" " role enabled

	for z in $(uci -q show firewall 2>/dev/null |
		sed -n 's/^firewall\.\([^.]*\)=zone$/\1/p'); do
		for n in $(uci -q get "firewall.$z.network"); do
			case " $zone_networks " in
				*" $n "*) ;;
				*) zone_networks="$zone_networks $n " ;;
			esac
		done
	done

	for s in $(nc_network_sections); do
		[ "$s" = loopback ] && continue
		proto=$(uci -q get "network.$s.proto")
		case "$proto" in
			batadv|batadv_hardif|none|'') continue ;;
		esac
		[ "$s" = bat0 ] && continue
		case " $zone_networks " in
			*" $s "*) ;;
			*) nc_emit N-FW-01 warning \
				"The network interface is not assigned to any firewall zone." "$s" ;;
		esac
	done

	enabled=$(uci -q get meshassistant.config.enabled)
	[ "$enabled" = 1 ] || return 0
	role=$(uci -q get meshassistant.config.role)
	[ -n "$role" ] || role=server
	case "$role" in
		server)
			# Only the server runs a firewall.  A node disables firewall,
			# dnsmasq and odhcpd, so requiring bat0 in a zone there would
			# always report a problem that does not exist.
			firewall_zone_has_network lan bat0 || nc_emit N-FW-02 warning \
				"bat0 is not in the LAN firewall zone while the mesh is active." "$role"
			;;
		node)
			;;
		client)
			firewall_zone_has_network lan bat0 && nc_emit N-FW-03 warning \
				"The client role should not place bat0 in the LAN firewall zone." "client"
			;;
	esac
}

# ---------------------------------------------------------------------------
# Mesh wiring
# ---------------------------------------------------------------------------

nc_check_mesh() {
	local enabled role s proto master mesh_count=0 network

	enabled=$(uci -q get meshassistant.config.enabled)
	[ "$enabled" = 1 ] || return 0
	role=$(uci -q get meshassistant.config.role)
	[ -n "$role" ] || role=server

	case "$role" in
		server|node)
			nc_lan_bridge_has bat0 || nc_emit N-MESH-01 warning \
				"bat0 is not bridged into the LAN while the server/node role is active." "$role"
			;;
		client)
			nc_lan_bridge_has bat0 && nc_emit N-MESH-02 error \
				"bat0 is bridged into the LAN while the client role is active; this can create a loop." "client"
			;;
	esac

	proto=$(uci -q get network.mesh_batman.proto)
	master=$(uci -q get network.mesh_batman.master)
	if [ "$proto" != batadv_hardif ] || [ "$master" != bat0 ]; then
		nc_emit N-MESH-03 warning \
			"network.mesh_batman is not a batadv_hardif attached to bat0." "${proto:-missing}/${master:-missing}"
	fi

	if [ "$(uci -q get meshassistant.config.wired_backhaul)" = 1 ]; then
		proto=$(uci -q get network.mesh_wired.proto)
		master=$(uci -q get network.mesh_wired.master)
		if [ "$proto" != batadv_hardif ] || [ "$master" != bat0 ]; then
			nc_emit N-MESH-06 warning \
				"The wired backhaul is enabled but network.mesh_wired is not attached to bat0." \
				"${proto:-missing}/${master:-missing}"
		fi
	fi

	for s in $(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		[ "$(uci -q get "wireless.$s.mode")" = mesh ] || continue
		mesh_count=$((mesh_count + 1))
		network=$(uci -q get "wireless.$s.network")
		case " $network " in
			*" mesh_batman "*) ;;
			*) nc_emit N-MESH-05 warning \
				"The 802.11s interface is not attached to network.mesh_batman." "$s: ${network:-missing}" ;;
		esac
	done

	if [ "$mesh_count" -gt 1 ]; then
		nc_emit N-MESH-04 warning \
			"More than one 802.11s interface exists; the mesh engine manages one mesh radio." "$mesh_count"
	fi
}

network_check_json() {
	NC_COUNT=0
	NC_ERRORS=0
	NC_WARNINGS=0

	json_init
	json_add_boolean ok 1
	json_add_boolean available 1
	json_add_array checks

	nc_check_ipv4
	nc_check_dhcp
	nc_check_dns
	nc_check_bridge_route
	nc_check_firewall
	nc_check_mesh

	json_close_array
	json_add_int count "$NC_COUNT"
	json_add_int errors "$NC_ERRORS"
	json_add_int warnings "$NC_WARNINGS"
	json_dump
	echo
}
