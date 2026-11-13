#!/bin/sh
# Global Backup Manager: the only backup implementation in the package.
# See docs/04-BACKUP-DESIGN.md for the format and scoped restore policies.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/radio.sh
. /usr/lib/wifimanager/restore.sh

WM_BACKUP_FORMAT=1
WM_BACKUP_APP="luci-app-wifimanager"
WM_LEGACY_BACKUP_DIR="/etc/meshassistant/backup"
WM_BACKUP_KNOWN_FILES="$WM_CONFIG_FILES"

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

backup_conf() { # key default
	local v
	v=$(uci -q get "wifimanager.backup.$1")
	[ -n "$v" ] || v="$2"
	printf '%s\n' "$v"
}

backup_path_is_valid() { # path
	local p="$1" parent
	case "$p" in
		/etc/*|/mnt/*|/media/*|/tmp/*) ;;
		*) return 1 ;;
	esac
	case "$p" in
		*..*) return 1 ;;
	esac
	case "$p" in
		*[!A-Za-z0-9._/-]*) return 1 ;;
	esac
	[ -L "$p" ] && return 1
	# The parent must be a real directory or creatable under an allowed root.
	parent=${p%/*}
	[ -z "$parent" ] && parent=/
	[ -d "$parent" ] || return 1
	return 0
}

backup_dir() {
	local dir
	dir=$(backup_conf path "$WM_BACKUP_DIR_DEFAULT")
	if backup_path_is_valid "$dir"; then
		printf '%s\n' "$dir"
	else
		printf '%s\n' "$WM_BACKUP_DIR_DEFAULT"
	fi
}

# backup_mount_of <path>: the longest mountpoint in /proc/mounts that contains
# the path.  Used to tell internal flash from an external volume and to refuse
# a path under /mnt or /media when nothing is mounted there.
backup_mount_of() {
	local p="$1" best="" dev mp rest

	[ -n "$p" ] || return 1
	[ -d "$p" ] || p=${p%/*}
	[ -n "$p" ] || p=/
	while read -r dev mp rest; do
		[ -n "$mp" ] || continue
		case "$p" in
			"$mp"|"$mp"/*)
				[ "${#mp}" -gt "${#best}" ] && best="$mp"
				;;
		esac
	done </proc/mounts
	printf '%s\n' "${best:-/}"
}

# backup_fstype <mountpoint>
backup_fstype() {
	local mp="$1" dev fs rest
	while read -r dev mp fs rest; do
		[ "$mp" = "$1" ] && {
			printf '%s\n' "$fs"
			return 0
		}
	done </proc/mounts
	printf '%s\n' '?'
}

# Read-only description of the backup store and every mount that can hold
# archives.  /tmp is listed because it is sometimes the only writable place,
# but it is marked volatile: tmpfs is cleared on reboot.
backup_storage_json() {
	local dir mount fs free writable=0 mp dev fstype cfree cext cvol cwrite suggested

	dir=$(backup_dir)
	mount=$(backup_mount_of "$dir")
	fs=$(backup_fstype "$mount")
	free=$(wm_free_kb "$dir")
	[ -n "$free" ] || free=0
	[ -w "$dir" ] 2>/dev/null && writable=1

	json_init
	json_add_boolean ok 1
	json_add_string dir "$dir"
	json_add_string mount "$mount"
	json_add_string filesystem "$fs"
	json_add_boolean external "$(case "$mount" in /mnt/*|/media/*) echo 1 ;; *) echo 0 ;; esac)"
	json_add_boolean writable "$writable"
	json_add_int free_kb "$free"
	json_add_array candidates
	for mp in $(awk '$2 == "/" || $2 == "/tmp" || $2 ~ /^\/(mnt|media)(\/|$)/ { print $2 }' /proc/mounts |
		sort -u); do
		dev=$(awk -v m="$mp" '$2 == m { print $1; exit }' /proc/mounts)
		fstype=$(backup_fstype "$mp")
		cfree=$(wm_free_kb "$mp")
		[ -n "$cfree" ] || cfree=0
		cext=0
		cvol=0
		cwrite=0
		case "$mp" in /mnt/*|/media/*) cext=1 ;; esac
		case "$mp" in /tmp|/tmp/*) cvol=1 ;; esac
		[ -w "$mp" ] 2>/dev/null && cwrite=1
		case "$mp" in
			/) suggested="$WM_BACKUP_DIR_DEFAULT" ;;
			*) suggested="${mp%/}/wifimanager-backup" ;;
		esac
		json_add_object
		json_add_string path "$mp"
		json_add_string suggested "$suggested"
		json_add_string device "$dev"
		json_add_string filesystem "$fstype"
		json_add_int free_kb "$cfree"
		json_add_boolean external "$cext"
		json_add_boolean volatile "$cvol"
		json_add_boolean writable "$cwrite"
		json_close_object
	done
	json_close_array
	json_dump
	echo
}

backup_list_files() { # dir
	find "$1" -maxdepth 1 -type f \( -name 'wifimanager-*.tar' -o -name 'wifimanager-*.tar.enc' \) 2>/dev/null | sort
}

# Remove an archive together with the files that describe it.  Encrypted
# archives carry a manifest sidecar because their name cannot be read without
# the passphrase.
backup_remove_file() { # archive
	rm -f "$1" "$1.sha256" "$1.meta.json"
}

backup_settings_json() {
	local enabled freq max_count max_size retention path legacy encrypt auto_last

	enabled=$(backup_conf enabled 1)
	freq=$(backup_conf frequency before_change)
	max_count=$(backup_conf max_count 10)
	max_size=$(backup_conf max_size_mb 64)
	retention=$(backup_conf retention_days 0)
	path=$(backup_dir)
	legacy=$(backup_conf legacy_enabled 1)
	encrypt=$(backup_conf encrypt_default 0)
	auto_last=$(cat "$WM_RUNTIME_DIR/last-auto" 2>/dev/null)

	json_init
	json_add_boolean ok 1
	json_add_object settings
	json_add_boolean enabled "$([ "$enabled" = 1 ] && echo 1 || echo 0)"
	json_add_string frequency "$freq"
	json_add_int max_count "${max_count:-10}"
	json_add_int max_size_mb "${max_size:-64}"
	json_add_int retention_days "${retention:-0}"
	json_add_string path "$path"
	# Always on.  A rollback that only exists in /tmp does not survive a reboot,
	# so the archive is no longer optional and no setting can turn it off.
	json_add_boolean require_pre_restore 1
	json_add_boolean legacy_enabled "$([ "$legacy" = 1 ] && echo 1 || echo 0)"
	json_add_boolean encrypt_default "$([ "$encrypt" = 1 ] && echo 1 || echo 0)"
	[ -n "$auto_last" ] && json_add_int auto_last "$auto_last"
	json_close_object
	json_dump
	echo
}

backup_settings_set() {
	local args="$1" key val path mp

	for key in enabled frequency max_count max_size_mb retention_days path legacy_enabled encrypt_default; do
		val=$(jget "$args" "@.$key")
		[ -n "$val" ] || continue
		# ubus JSON booleans arrive as true/false; UCI stores 1/0.
		case "$val" in true) val=1 ;; false) val=0 ;; esac
		case "$key" in
			enabled|legacy_enabled|encrypt_default)
				case "$val" in 0|1) ;; *) echo "Invalid value for $key."; return 1 ;; esac
				;;
			frequency)
				case "$val" in
					before_change|daily|weekly|manual) ;;
					*) echo "Invalid backup frequency."; return 1 ;;
				esac
				;;
			max_count)
				case "$val" in ''|*[!0-9]*) echo "Invalid max_count."; return 1 ;; esac
				[ "$val" -ge 1 ] && [ "$val" -le 200 ] || {
					echo "max_count must be between 1 and 200."
					return 1
				}
				;;
			max_size_mb)
				case "$val" in ''|*[!0-9]*) echo "Invalid max_size_mb."; return 1 ;; esac
				[ "$val" -ge 4 ] && [ "$val" -le 4096 ] || {
					echo "max_size_mb must be between 4 and 4096."
					return 1
				}
				;;
			retention_days)
				case "$val" in ''|*[!0-9]*) echo "Invalid retention_days."; return 1 ;; esac
				[ "$val" -le 3650 ] || return 1
				;;
			path)
				backup_path_is_valid "$val" || {
					echo "The backup path must be under /etc, /mnt, /media or /tmp and contain no '..'."
					return 1
				}
				# Under /mnt or /media the volume must actually be mounted,
				# otherwise archives would silently land on internal flash.
				case "$val" in
					/mnt/*|/media/*)
						mp=$(backup_mount_of "$val")
						case "$mp" in
							/mnt/*|/media/*) ;;
							*)
								echo "No external storage is mounted at this path; mount it or choose another location."
								return 1
								;;
						esac
						;;
				esac
				mkdir -p "$val" 2>/dev/null || {
					echo "The backup directory cannot be created."
					return 1
				}
				;;
		esac
		uci set "wifimanager.backup.$key=$val"
	done
	# Rewrite the old opt-out so an upgrade cannot keep restores unprotected.
	uci set wifimanager.backup.require_pre_restore=1
	uci_commit wifimanager
	echo "Backup settings saved."
}

# ---------------------------------------------------------------------------
# Archive names and validation
# ---------------------------------------------------------------------------

validate_backup_id() { # id
	case "$1" in
		wifimanager-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].tar) ;;
		wifimanager-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9]*.tar) ;;
		wifimanager-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].tar.enc) ;;
		wifimanager-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9]*.tar.enc) ;;
		*) return 1 ;;
	esac
	case "$1" in
		*..*|*/*|*\\*|*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

validate_legacy_id() { # id, as listed from the legacy directory
	case "$1" in
		[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].tar) ;;
		[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9]*.tar) ;;
		*) return 1 ;;
	esac
	case "$1" in
		*..*|*/*|*\\*|*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

# Resolve an id to a file path.  Sets BACKUP_FILE and BACKUP_IS_LEGACY.
backup_resolve() { # id
	local dir legacy
	dir=$(backup_dir)
	legacy="$WM_LEGACY_BACKUP_DIR"

	BACKUP_FILE=""
	BACKUP_IS_LEGACY=0

	if validate_backup_id "$1"; then
		[ -f "$dir/$1" ] && [ ! -L "$dir/$1" ] && {
			BACKUP_FILE="$dir/$1"
			return 0
		}
	fi
	if validate_legacy_id "$1"; then
		[ -f "$legacy/$1" ] && [ ! -L "$legacy/$1" ] && {
			BACKUP_FILE="$legacy/$1"
			BACKUP_IS_LEGACY=1
			return 0
		}
	fi
	return 1
}

# Reject symlinks, device nodes and paths outside etc/config before extraction.
backup_validate_entries() { # archive
	local listing line type name

	listing=$(tar -tf "$1" 2>/dev/null) || return 1
	[ -n "$listing" ] || return 1

	while IFS= read -r line; do
		[ -n "$line" ] || continue
		case "$line" in
			/*|*..*) return 1 ;;
		esac
		case "$line" in
			manifest|manifest.json|checksums.txt) ;;
			etc|etc/|etc/config|etc/config/) ;;
			etc/config/*)
				name=${line#etc/config/}
				case " $WM_BACKUP_KNOWN_FILES " in
					*" $name "*) ;;
					*) return 1 ;;
				esac
				;;
			*) return 1 ;;
		esac
	done <<EOF
$listing
EOF

	# Type check: only regular files and directories.  BusyBox tar -tv lists
	# the type in the first character.
	type=$(tar -tvf "$1" 2>/dev/null |
		awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { print; exit }')
	[ -z "$type" ] || return 1
	return 0
}

# Verify checksums.txt inside an extracted archive tree.
backup_verify_checksums() { # extract_dir
	local dir="$1" sums="$1/checksums.txt" rel expect actual
	[ -s "$sums" ] || {
		# Legacy archives carry a line manifest instead of checksums.
		[ -s "$1/manifest" ] && return 0
		return 1
	}
	while read -r expect rel; do
		[ -n "$rel" ] || continue
		case "$rel" in
			etc/config/*) ;;
			*) return 1 ;;
		esac
		[ -f "$dir/$rel" ] || return 1
		actual=$(sha256sum "$dir/$rel" 2>/dev/null | awk '{ print $1 }')
		[ "$actual" = "$expect" ] || return 1
	done <"$sums"
	return 0
}

# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------

# PBKDF2 iterations for archives written by this release.  The passphrase is
# fed through stdin so it never shows up in ps or in a log line.
WM_BACKUP_ENC_ITER=200000

backup_encrypt_file() { # in out password
	printf '%s' "$3" |
		openssl enc -aes-256-cbc -pbkdf2 -iter "$WM_BACKUP_ENC_ITER" -md sha256 \
			-salt -pass stdin -in "$1" -out "$2" 2>/dev/null
}

# Decrypt an archive.  New archives use the hardened iteration count; archives
# written by an earlier release used the openssl default, and those must keep
# restoring, so a failed hardened attempt falls back to the default KDF.
backup_decrypt_file() { # in out password
	local in="$1" out="$2" pass="$3"

	printf '%s' "$pass" |
		openssl enc -d -aes-256-cbc -pbkdf2 -iter "$WM_BACKUP_ENC_ITER" -md sha256 \
			-pass stdin -in "$in" -out "$out" 2>/dev/null && return 0
	rm -f "$out" 2>/dev/null
	printf '%s' "$pass" |
		openssl enc -d -aes-256-cbc -pbkdf2 -pass stdin -in "$in" -out "$out" 2>/dev/null && return 0
	rm -f "$out" 2>/dev/null
	return 1
}

# Extract (decrypting when needed) and validate an archive into a temp dir.
# Echoes the directory; returns non-zero with a message on stderr on failure.
backup_extract() { # archive [password]
	local archive="$1" password="${2:-}" tmp work

	tmp=$(mktemp -d /tmp/wifimanager-verify.XXXXXX) || return 1
	work="$archive"
	case "$archive" in
		*.enc)
			if [ -z "$password" ]; then
				echo "This backup is encrypted; a passphrase is required." >&2
				rm -rf "$tmp"
				return 1
			fi
			if ! command -v openssl >/dev/null 2>&1; then
				echo "openssl is not installed; the backup cannot be decrypted." >&2
				rm -rf "$tmp"
				return 1
			fi
			if ! backup_decrypt_file "$archive" "$tmp/archive.tar" "$password"; then
				echo "The passphrase is wrong or the archive is damaged." >&2
				rm -rf "$tmp"
				return 1
			fi
			work="$tmp/archive.tar"
			;;
	esac

	if ! backup_validate_entries "$work"; then
		echo "The archive contains unexpected or unsafe entries." >&2
		rm -rf "$tmp"
		return 1
	fi
	tar -xf "$work" -C "$tmp" 2>/dev/null || {
		echo "The archive cannot be extracted." >&2
		rm -rf "$tmp"
		return 1
	}
	if ! backup_verify_checksums "$tmp"; then
		echo "Checksum verification failed." >&2
		rm -rf "$tmp"
		return 1
	fi
	echo "$tmp"
}

backup_manifest_json() { # extract_dir id
	local dir="$1" id="$2" file="$1/manifest.json" legacy=0
	if [ ! -s "$file" ]; then
		file="$1/manifest"
		legacy=1
	fi
	[ -s "$file" ] || return 1
	if [ "$legacy" = 1 ]; then
		# Convert the legacy line manifest on read; never rewrite the archive.
		json_init
		json_add_int backup_format_version 0
		json_add_string id "$id"
		json_add_string application "luci-app-meshassistant"
		json_add_string application_version "2.7.x"
		json_add_string created_at "$(sed -n 's/^created=//p' "$file" | head -n 1)"
		json_add_string backup_type legacy
		json_add_array backup_scope
		json_add_string "" mesh
		json_close_array
		json_add_string hostname "$(sed -n 's/^hostname=//p' "$file" | head -n 1)"
		json_add_string lan_ip "$(sed -n 's/^lan_ip=//p' "$file" | head -n 1)"
		json_add_string role "$(sed -n 's/^role=//p' "$file" | head -n 1)"
		json_add_boolean legacy 1
		json_dump
		echo
		return 0
	fi
	cat "$file"
}

# ---------------------------------------------------------------------------
# Manifest construction
# ---------------------------------------------------------------------------

scope_area_files() { # scope area -> prints file names
	case "$1" in
		wireless|mlo) echo wireless ;;
		mesh|backhaul) echo "wireless network dhcp firewall meshassistant" ;;
		roaming|dawn) echo "wireless dawn meshassistant" ;;
		network) echo network ;;
		dhcp) echo dhcp ;;
		firewall) echo firewall ;;
		system) echo system ;;
		wifimanager) echo wifimanager ;;
	esac
}

default_scope() { # type
	case "$1" in
		full) echo "wireless mlo mesh backhaul roaming dawn network dhcp firewall system wifimanager" ;;
		wireless) echo "wireless mlo" ;;
		mesh) echo "mesh backhaul" ;;
		roaming) echo "roaming dawn" ;;
		*) echo "" ;;
	esac
}

files_for_scopes() { # scope words
	local area f out=""
	for area in $1; do
		for f in $(scope_area_files "$area"); do
			case " $out " in *" $f "*) ;; *) out="$out $f" ;; esac
		done
	done
	printf '%s\n' "$out"
}

# Validate the area selection for a custom backup.
backup_validate_scope() { # type scope
	local type="$1" scope="$2" area has_wireless=0 has_network=0

	[ -n "$scope" ] || return 0
	for area in $scope; do
		case "$area" in
			wireless|mlo|mesh|backhaul|roaming|dawn|network|dhcp|firewall|system|wifimanager) ;;
			*) echo "Unknown backup area '$area'."; return 1 ;;
		esac
	done
	if [ "$type" != custom ]; then
		return 0
	fi
	for area in $scope; do
		case "$area" in
			wireless) has_wireless=1 ;;
			network) has_network=1 ;;
		esac
	done
	case " $scope " in
		*" mlo "*) [ "$has_wireless" = 1 ] || {
			echo "The MLO area requires the Wireless area."
			return 1
		} ;;
	esac
	case " $scope " in
		*" mesh "*|*" backhaul "*)
			[ "$has_wireless" = 1 ] && [ "$has_network" = 1 ] || {
				echo "Mesh/backhaul restore needs the Wireless and Network areas."
				return 1
			}
			;;
	esac
	case " $scope " in
		*" roaming "*) [ "$has_wireless" = 1 ] || {
			echo "The Roaming area requires the Wireless area."
			return 1
		} ;;
	esac
	return 0
}

# Advisory findings for a custom selection.  They never stop a backup; the
# Create page shows the same warnings before the archive is made.
backup_scope_warnings() { # type scope
	local type="$1" scope="$2"

	[ "$type" = custom ] || return 0
	case " $scope " in
		*" dawn "*)
			case " $scope " in
				*" roaming "*) ;;
				*) echo "DAWN is selected without Roaming; the DAWN configuration and the wireless roaming options are restored together." ;;
			esac
			;;
	esac
	case " $scope " in
		*" dhcp "*|*" firewall "*)
			case " $scope " in
				*" network "*) ;;
				*) echo "DHCP/DNS or Firewall is selected without Network; those files are restored but the interfaces they refer to are not included." ;;
			esac
			;;
	esac
	return 0
}

# Physical network interfaces only.  The manifest records them so a restore on
# different hardware can report renamed ports (DESIGN §10.7); overlay devices
# are recreated from the configuration and are left out.
backup_physical_interfaces() {
	local n

	[ -d /sys/class/net ] || return 0
	for n in /sys/class/net/*; do
		n=${n##*/}
		case "$n" in
			''|lo|bat*|br-*|brlan*|brwan*|wlan*|phy*|mesh*|veth*|docker*|ifb*|sit*|gre*|tun*|tap*|wg*|ppp*|mlo*|.*)
				continue
				;;
		esac
		printf '%s\n' "$n"
	done
}

# Compatibility findings between an archive manifest and this device.  Every
# line is one advisory: a different firmware, radio count, radio path/band or
# network interface name.  They never block a restore by themselves; the
# restore page shows them before the operator acknowledges the scope.
backup_compat_warnings() { # manifest-json
	local manifest="$1" board cur_id cur_ver cur_target
	local m_id m_ver m_target r_count c_count radio band path cur_band cur_path ifname

	board=$(ubus call system board 2>/dev/null)
	cur_id=$(printf '%s' "$board" | jsonfilter -e '@.release.distribution' 2>/dev/null)
	cur_ver=$(printf '%s' "$board" | jsonfilter -e '@.release.version' 2>/dev/null)
	cur_target=$(printf '%s' "$board" | jsonfilter -e '@.release.target' 2>/dev/null)
	m_id=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.id' 2>/dev/null)
	m_ver=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.version' 2>/dev/null)
	m_target=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.target' 2>/dev/null)

	if [ -n "$m_id$m_ver$m_target" ] && [ -n "$cur_id$cur_ver$cur_target" ]; then
		if [ "$m_id" != "$cur_id" ] || [ "$m_ver" != "$cur_ver" ] ||
			[ "$m_target" != "$cur_target" ]; then
			printf 'The archive was created on %s %s (%s); this device runs %s %s (%s).\n' \
				"$m_id" "$m_ver" "$m_target" "$cur_id" "$cur_ver" "$cur_target"
		fi
	fi

	r_count=$(printf '%s' "$manifest" | jsonfilter -e '@.radios[*].name' 2>/dev/null | grep -c .)
	c_count=$(uci -q show wireless 2>/dev/null |
		sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p' | grep -c .)
	if [ "${r_count:-0}" -gt 0 ] && [ "${c_count:-0}" -gt 0 ] &&
		[ "$r_count" -ne "$c_count" ]; then
		printf 'The archive contains %s radios; this device has %s.\n' "$r_count" "$c_count"
	fi

	for radio in $(printf '%s' "$manifest" | jsonfilter -e '@.radios[*].name' 2>/dev/null); do
		case "$radio" in *[!A-Za-z0-9_-]*) continue ;; esac
		band=$(printf '%s' "$manifest" | jsonfilter -e "@.radios[@.name='$radio'].band" 2>/dev/null)
		path=$(printf '%s' "$manifest" | jsonfilter -e "@.radios[@.name='$radio'].path" 2>/dev/null)
		if ! uci -q get "wireless.$radio" >/dev/null 2>&1; then
			printf 'This device has no radio "%s" that the archive references.\n' "$radio"
			continue
		fi
		cur_band=$(radio_band "$radio")
		if [ -n "$band" ] && [ -n "$cur_band" ] && [ "$band" != "$cur_band" ]; then
			printf 'Radio "%s" is on %s in the archive but on %s on this device.\n' \
				"$radio" "$band" "$cur_band"
		fi
		cur_path=$(uci -q get "wireless.$radio.path")
		if [ -n "$path" ] && [ "$path" != "$cur_path" ]; then
			printf 'Radio "%s" uses path %s in the archive but %s on this device.\n' \
				"$radio" "$path" "${cur_path:-none}"
		fi
	done

	for ifname in $(printf '%s' "$manifest" | jsonfilter -e '@.interfaces[*]' 2>/dev/null); do
		case "$ifname" in *[!A-Za-z0-9_.-]*) continue ;; esac
		[ -e "/sys/class/net/$ifname" ] && continue
		printf 'Network interface "%s" from the archive does not exist on this device; interface names may have changed.\n' "$ifname"
	done
}

backup_write_manifest() { # dir id type scope description [name]
	local dir="$1" id="$2" type="$3" scope="$4" description="$5"
	local name="${6:-}" hostname fw radios radio band

	hostname=$(uci -q get system.@system[0].hostname)
	[ -n "$hostname" ] || hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)

	(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_int backup_format_version "$WM_BACKUP_FORMAT"
		json_add_string id "$id"
		json_add_string application "$WM_BACKUP_APP"
		json_add_string application_version "$WM_VERSION"
		json_add_string created_at "$(date '+%Y-%m-%dT%H:%M:%S%z')"
		json_add_string backup_type "$type"
		json_add_array backup_scope
		for fw in $scope; do json_add_string "" "$fw"; done
		json_close_array

		json_add_object firmware
		json_add_string id "$(ubus call system board 2>/dev/null | jsonfilter -e '@.release.distribution' 2>/dev/null)"
		json_add_string version "$(ubus call system board 2>/dev/null | jsonfilter -e '@.release.version' 2>/dev/null)"
		json_add_string target "$(ubus call system board 2>/dev/null | jsonfilter -e '@.release.target' 2>/dev/null)"
		json_close_object

		json_add_string hostname "$hostname"
		json_add_string description "$description"
		[ -n "$name" ] && json_add_string name "$name"
		json_add_array radios
		for radio in $(uci -q show wireless 2>/dev/null |
			sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p'); do
			json_add_object
			json_add_string name "$radio"
			json_add_string band "$(radio_band "$radio")"
			# The PHY path distinguishes radios when section names are reused
			# on different hardware (DESIGN §10.7, wireless chip differences).
			json_add_string path "$(uci -q get "wireless.$radio.path")"
			json_close_object
		done
		json_close_array
		json_add_array interfaces
		for fw in $(backup_physical_interfaces); do
			json_add_string "" "$fw"
		done
		json_close_array
		json_add_boolean encrypted 0
		json_add_array files
		for fw in $(files_for_scopes "$scope"); do
			[ -f "$WM_CONFIG_DIR/$fw" ] && json_add_string "" "etc/config/$fw"
		done
		json_close_array
		json_dump
	) >"$dir/manifest.json" || return 1
	[ -s "$dir/manifest.json" ]
}

backup_build_checksums() { # dir
	local dir="$1" rel
	: >"$dir/checksums.txt"
	for rel in "$dir"/etc/config/*; do
		[ -f "$rel" ] || continue
		sha256sum "$rel" | awk -v r="${rel#"$dir"/}" '{ print $1 "  " r }' >>"$dir/checksums.txt"
	done
	[ -s "$dir/checksums.txt" ]
}

# ---------------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------------

backup_prune() { # dir
	local dir="$1" count max_count max_size total retention now file size
	max_count=$(backup_conf max_count 10)
	max_size=$(backup_conf max_size_mb 64)
	retention=$(backup_conf retention_days 0)
	now=$(date +%s)

	# Age-based removal first (never touches legacy archives).  Encrypted
	# archives age like any other; their sidecar goes with them.
	if [ "${retention:-0}" -gt 0 ]; then
		local cutoff=$((now - retention * 86400))
		backup_list_files "$dir" | while read -r file; do
			size=$(date -r "$file" +%s 2>/dev/null)
			[ -n "$size" ] && [ "$size" -lt "$cutoff" ] && backup_remove_file "$file"
		done
	fi

	# Count limit.
	count=$(backup_list_files "$dir" | wc -l)
	if [ "${count:-0}" -gt "${max_count:-10}" ]; then
		backup_list_files "$dir" | head -n $((count - max_count)) | while read -r file; do
			backup_remove_file "$file"
		done
	fi

	# Size limit.
	total=0
	while read -r file; do
		size=$(du -k "$file" 2>/dev/null | awk '{ print $1 }')
		total=$((total + ${size:-0}))
	done <<EOF
$(backup_list_files "$dir")
EOF
	while [ "$total" -gt $((max_size * 1024)) ]; do
		file=$(backup_list_files "$dir" | head -n 1)
		[ -n "$file" ] || break
		size=$(du -k "$file" 2>/dev/null | awk '{ print $1 }')
		backup_remove_file "$file"
		total=$((total - ${size:-0}))
	done
}

# Core creator.  Prints only the archive id on stdout; all diagnostics go to
# the log, so callers can capture the id safely.
backup_create_core() { # type scope description [password] [name]
	local type="$1" scope="$2" description="$3" password="${4:-}" name="${5:-}"
	local dir stamp id tmp file archive free need fw rel archived=0 plain round

	dir=$(backup_dir)
	mkdir -p "$dir" 2>/dev/null || {
		wm_log "backup: cannot create $dir"
		return 1
	}
	chmod 700 "$dir" 2>/dev/null

	[ -n "$scope" ] || scope=$(default_scope "$type")
	[ -n "$scope" ] || scope="wireless mlo mesh backhaul roaming dawn network dhcp firewall system wifimanager"
	backup_validate_scope "$type" "$scope" >/dev/null || return 1

	# Prune before writing rather than after: the archive about to be created
	# must fit, and freeing the retention budget first means the free-space
	# check below sees the space the limits are going to make available.
	backup_prune "$dir"

	local cfg_kb=0
	cfg_kb=$(du -sk "$WM_CONFIG_DIR" 2>/dev/null | awk '{ print $1 }')
	[ -n "$cfg_kb" ] || cfg_kb=0
	need=$((2048 + cfg_kb))
	free=$(wm_free_kb "$dir")
	[ -n "$free" ] && [ "$free" -lt "$need" ] && {
		wm_log "backup: not enough free space in $dir (${free} KiB)"
		return 1
	}

	stamp=$(date '+%Y%m%d-%H%M%S')
	id="wifimanager-$stamp.tar"
	local n=1
	while [ -e "$dir/$id" ] || [ -e "$dir/$id.enc" ]; do
		id="wifimanager-$stamp-$n.tar"
		n=$((n + 1))
	done

	tmp=$(mktemp -d /tmp/wifimanager-backup.XXXXXX) || return 1
	mkdir -p "$tmp/etc/config"

	for fw in $(files_for_scopes "$scope"); do
		if [ -f "$WM_CONFIG_DIR/$fw" ]; then
			cp "$WM_CONFIG_DIR/$fw" "$tmp/etc/config/$fw" &&
				chmod 600 "$tmp/etc/config/$fw" && archived=1
		fi
	done
	# A scope such as Wireless contains no network file by design; require at
	# least one archived configuration, not one specific file.
	[ "$archived" = 1 ] || {
		wm_log "backup: no configuration file to archive for scope: $scope"
		rm -rf "$tmp"
		return 1
	}

	backup_write_manifest "$tmp" "$id" "$type" "$scope" "$description" "$name" || {
		rm -rf "$tmp"
		return 1
	}
	backup_build_checksums "$tmp" || {
		rm -rf "$tmp"
		return 1
	}

	archive="$dir/.tmp.$$"
	tar -cf "$archive" -C "$tmp" manifest.json checksums.txt etc/config 2>/dev/null || {
		rm -rf "$tmp" "$archive"
		return 1
	}

	if [ -n "$password" ]; then
		if ! command -v openssl >/dev/null 2>&1; then
			wm_log "backup: openssl missing, cannot encrypt"
			rm -rf "$tmp" "$archive"
			return 1
		fi
		if ! backup_encrypt_file "$archive" "$dir/.tmp.$$.enc" "$password"; then
			rm -rf "$tmp" "$archive" "$dir/.tmp.$$.enc"
			return 1
		fi
		# Prove the archive can be read back with the same passphrase before
		# the plaintext is deleted.  Hashing the decrypted stream avoids a
		# second full-size copy on flash.
		plain=$(sha256sum "$archive" 2>/dev/null | awk '{ print $1 }')
		round=$(printf '%s' "$password" |
			openssl enc -d -aes-256-cbc -pbkdf2 -iter "$WM_BACKUP_ENC_ITER" -md sha256 \
				-pass stdin -in "$dir/.tmp.$$.enc" 2>/dev/null | sha256sum | awk '{ print $1 }')
		if [ -z "$plain" ] || [ "$plain" != "$round" ]; then
			wm_log "backup: encryption round-trip verification failed"
			rm -rf "$tmp" "$archive" "$dir/.tmp.$$.enc"
			return 1
		fi
		rm -f "$archive"
		mv "$dir/.tmp.$$.enc" "$dir/${id}.enc" || {
			rm -rf "$tmp" "$dir/.tmp.$$.enc"
			return 1
		}
		id="$id.enc"
		# Keep a copy of the manifest beside the ciphertext: the list page
		# must describe the archive without being able to read it.
		cp "$tmp/manifest.json" "$dir/$id.meta.json" 2>/dev/null &&
			chmod 600 "$dir/$id.meta.json" 2>/dev/null
	else
		mv "$archive" "$dir/$id" || {
			rm -rf "$tmp" "$archive"
			return 1
		}
	fi

	chmod 600 "$dir/$id" 2>/dev/null
	sha256sum "$dir/$id" 2>/dev/null | awk '{ print $1 "  " $2 }' >"$dir/$id.sha256"
	chmod 600 "$dir/$id.sha256" 2>/dev/null
	rm -rf "$tmp"
	# The size budget includes the archive that was just written.  When that
	# archive alone is over the limit it cannot be kept, and the caller must
	# not be told a safety copy exists.
	backup_prune "$dir"
	[ -f "$dir/$id" ] || {
		wm_log "backup: $id exceeds the storage limit and was removed again"
		return 1
	}
	wm_log "backup: created $id ($type, scope: $scope)"
	printf '%s\n' "$id"
	return 0
}

# Record the outcome of the last automatic backup so the Overview can show
# whether it succeeded.  Only the fixed description is stored, never a key.
backup_record_auto_result() { # result epoch description id
	local result="$1" ts="$2" description="$3" id="$4"
	local file="$WM_RUNTIME_DIR/last-auto-result" tmp

	mkdir -p "$WM_RUNTIME_DIR" 2>/dev/null || return 0
	tmp="$file.$$"
	{
		printf 'result=%s\n' "$result"
		printf 'time=%s\n' "$ts"
		printf 'description=%s\n' "$(printf '%s' "$description" | tr '\n\r' '  ')"
		printf 'id=%s\n' "$id"
	} >"$tmp" 2>/dev/null || return 0
	chmod 600 "$tmp" 2>/dev/null
	mv "$tmp" "$file" 2>/dev/null || rm -f "$tmp"
	return 0
}

# Automatic / pre-change backup.  Never prints anything but the id.
backup_create_auto() { # type description
	local id now

	now=$(date +%s)
	id=$(backup_create_core "$1" "$(default_scope "$1")" "$2" "" 2>/dev/null)
	if [ -n "$id" ]; then
		backup_record_auto_result success "$now" "$2" "$id"
		printf '%s\n' "$id"
		return 0
	fi

	backup_record_auto_result failure "$now" "$2" ""
	return 1
}

backup_create_json() {
	local args="$1" type scope description password name id size scope_warning

	type=$(jget "$args" '@.type')
	[ -n "$type" ] || type=full
	case "$type" in full|wireless|mesh|roaming|custom) ;; *)
		echo '{"ok":false,"error":"E-INPUT","message":"Invalid backup type."}'
		return 1
		;; esac
	scope=$(jget "$args" '@.scope[*]')
	[ -n "$scope" ] || scope=$(default_scope "$type")
	description=$(jget "$args" '@.description')
	[ -n "$description" ] || description="WiFi Manager $type backup"
	password=$(jget "$args" '@.password')
	if [ -n "$password" ]; then
		[ "${#password}" -ge 12 ] || {
			wm_error E-INPUT "Use a passphrase of at least 12 characters."
			return 1
		}
		[ "${#password}" -le 128 ] || {
			wm_error E-INPUT "The passphrase is too long (128 characters maximum)."
			return 1
		}
		[ "$(printf '%s' "$password" | tr -d '[:cntrl:]')" = "$password" ] || {
			wm_error E-INPUT "The passphrase may not contain control characters."
			return 1
		}
	fi
	# The name is a display label stored in the manifest.  Archival ids stay
	# canonical so validation, pruning and restore keep one code path.
	name=$(jget "$args" '@.name')
	if [ -n "$name" ]; then
		[ -z "$(printf '%s' "$name" | tr -d 'A-Za-z0-9._ -')" ] || {
			wm_error E-INPUT "The backup name may only contain letters, digits, dots, dashes, underscores and spaces."
			return 1
		}
		[ "${#name}" -le 64 ] || {
			wm_error E-INPUT "The backup name is too long (64 characters maximum)."
			return 1
		}
	fi

	if ! msg=$(backup_validate_scope "$type" "$scope"); then
		wm_error E-SCOPE "$msg"
		return 1
	fi
	while IFS= read -r scope_warning; do
		[ -n "$scope_warning" ] && wm_log "backup: scope warning: $scope_warning"
	done <<EOF
$(backup_scope_warnings "$type" "$scope")
EOF

	id=$(backup_create_core "$type" "$scope" "$description" "$password" "$name")
	[ -n "$id" ] || {
		wm_error E-BACKUP "The backup could not be created; see the log."
		return 1
	}
	size=$(du -k "$(backup_dir)/$id" 2>/dev/null | awk '{ print $1 }')
	json_init
	json_add_boolean ok 1
	json_add_string id "$id"
	json_add_string type "$type"
	json_add_string scope "$scope"
	json_add_array warnings
	while IFS= read -r scope_warning; do
		[ -n "$scope_warning" ] && json_add_string "" "$scope_warning"
	done <<EOF
$(backup_scope_warnings "$type" "$scope")
EOF
	json_close_array
	json_add_int size_kb "${size:-0}"
	json_dump
	echo
}

backup_delete_json() {
	local id="$1" dir
	if ! validate_backup_id "$id"; then
		wm_error E-ID "Invalid backup id."
		return 1
	fi
	dir=$(backup_dir)
	[ -f "$dir/$id" ] && [ ! -L "$dir/$id" ] || {
		wm_error E-NOTFOUND "The backup does not exist."
		return 1
	}
	rm -f "$dir/$id" "$dir/$id.sha256" "$dir/$id.meta.json"
	wm_log "backup: deleted $id"
	json_init
	json_add_boolean ok 1
	json_dump
	echo
}

# ---------------------------------------------------------------------------
# Listing and details
# ---------------------------------------------------------------------------

backup_meta_json_fields() { # archive
	local archive="$1" manifest
	manifest=$(tar -xOf "$archive" manifest.json 2>/dev/null)
	if [ -n "$manifest" ]; then
		printf '%s\n' "$manifest"
		return 0
	fi
	# The archive is encrypted (or damaged); its manifest sits beside it so
	# the list can still show what was backed up.
	case "$archive" in
		*.enc)
			manifest=$(cat "$archive.meta.json" 2>/dev/null)
			if [ -n "$manifest" ]; then
				printf '%s\n' "$manifest"
				return 0
			fi
			;;
	esac
	tar -xOf "$archive" manifest 2>/dev/null | while IFS= read -r line; do
		case "$line" in
			created=*) printf '{"created_at":"%s"}\n' "${line#created=}" ;;
		esac
	done | head -n 1
}

backup_list_json() {
	local include_legacy="$1" dir file manifest id created type hostname desc scope size name
	local fw_ver fmt
	local legacy_dir="$WM_LEGACY_BACKUP_DIR" legacy_enabled

	dir=$(backup_dir)
	legacy_enabled=$(backup_conf legacy_enabled 1)

	json_init
	json_add_boolean ok 1
	json_add_array backups

	for file in $(backup_list_files "$dir"); do
		[ -f "$file" ] || continue
		id=$(basename "$file")
		manifest=$(backup_meta_json_fields "$file")
		if [ -z "$manifest" ]; then
			# An encrypted archive written before the sidecar existed has no
			# readable metadata; still list it so it can be restored or
			# deleted, and fall back to the file time.
			case "$id" in
				*.enc) manifest='{"encrypted":true}' ;;
				*) continue ;;
			esac
		fi
		created=$(printf '%s' "$manifest" | jsonfilter -e '@.created_at' 2>/dev/null)
		[ -n "$created" ] ||
			created=$(date -r "$file" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)
		type=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_type' 2>/dev/null)
		hostname=$(printf '%s' "$manifest" | jsonfilter -e '@.hostname' 2>/dev/null)
		desc=$(printf '%s' "$manifest" | jsonfilter -e '@.description' 2>/dev/null)
		name=$(printf '%s' "$manifest" | jsonfilter -e '@.name' 2>/dev/null)
		scope=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_scope[*]' 2>/dev/null | tr '\n' ' ')
		fw_ver=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.version' 2>/dev/null)
		fmt=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_format_version' 2>/dev/null)
		size=$(du -k "$file" 2>/dev/null | awk '{ print $1 }')

		json_add_object
		json_add_string id "$id"
		json_add_string type "$type"
		json_add_string created_at "$created"
		json_add_string hostname "$hostname"
		json_add_string description "$desc"
		json_add_string name "$name"
		json_add_string scope "$scope"
		json_add_int format "${fmt:-0}"
		json_add_string firmware_version "$fw_ver"
		json_add_int size_kb "${size:-0}"
		json_add_boolean legacy 0
		json_add_boolean encrypted "$(case "$id" in *.enc) echo 1 ;; *) echo 0 ;; esac)"
		json_close_object
	done

	if [ "$include_legacy" = 1 ] && [ "$legacy_enabled" = 1 ] && [ -d "$legacy_dir" ]; then
		for file in "$legacy_dir"/*.tar; do
			[ -f "$file" ] || continue
			id=$(basename "$file")
			validate_legacy_id "$id" || continue
			manifest=$(tar -xOf "$file" manifest 2>/dev/null)
			[ -n "$manifest" ] || continue
			json_add_object
			json_add_string id "$id"
			json_add_string type legacy
			json_add_string created_at "$(printf '%s\n' "$manifest" | sed -n 's/^created=//p' | head -n 1)"
			json_add_string hostname "$(printf '%s\n' "$manifest" | sed -n 's/^hostname=//p' | head -n 1)"
			json_add_string lan_ip "$(printf '%s\n' "$manifest" | sed -n 's/^lan_ip=//p' | head -n 1)"
			json_add_string role "$(printf '%s\n' "$manifest" | sed -n 's/^role=//p' | head -n 1)"
			json_add_string description "Legacy Mesh Assistant backup"
			json_add_string name ""
			json_add_int format 0
			json_add_string firmware_version ""
			json_add_int size_kb "$(du -k "$file" 2>/dev/null | awk '{ print $1 }')"
			json_add_boolean legacy 1
			json_add_boolean encrypted 0
			json_close_object
		done
	fi

	json_close_array
	json_dump
	echo
}

# Compare the configuration files stored in an archive with the live files.
# Prints the names whose content differs, one per line.  Returns 1 when the
# archive cannot be read (damaged or encrypted), so the caller reports the
# comparison as unknown instead of "unchanged".  A file that no longer exists
# counts as changed; files outside the archive's scope are not compared.
backup_compare_config() { # archive
	local archive="$1" manifest rel name current archived
	local changed=""

	manifest=$(tar -xOf "$archive" manifest.json 2>/dev/null) || return 1
	[ -n "$manifest" ] || return 1

	for rel in $(printf '%s' "$manifest" | jsonfilter -e '@.files[*]' 2>/dev/null); do
		case "$rel" in
			etc/config/*) name=${rel#etc/config/} ;;
			*) continue ;;
		esac
		case "$name" in
			''|*/*|*[!A-Za-z0-9_.-]*) continue ;;
		esac
		if [ ! -f "$WM_CONFIG_DIR/$name" ]; then
			changed="$changed $name"
			continue
		fi
		current=$(sha256sum "$WM_CONFIG_DIR/$name" 2>/dev/null | awk '{ print $1 }')
		[ -n "$current" ] || continue
		archived=$(tar -xOf "$archive" "$rel" 2>/dev/null | sha256sum | awk '{ print $1 }')
		[ "$current" = "$archived" ] || changed="$changed $name"
	done

	printf '%s\n' "${changed# }"
	return 0
}

backup_status_json() {
	local dir count total free last manifest created latest_id mount external=0 writable=0
	local config_changed=unknown changed_files file
	local auto_result="" auto_time=0 auto_description="" auto_id=""

	dir=$(backup_dir)
	count=$(backup_list_files "$dir" | wc -l)
	total=0
	while read -r file; do
		[ -n "$file" ] || continue
		total=$((total + $(du -k "$file" 2>/dev/null | awk '{ print $1 }')))
	done <<EOF
$(backup_list_files "$dir")
EOF
	free=$(wm_free_kb "$dir")
	last=$(backup_list_files "$dir" | tail -n 1)
	created=""
	latest_id=""
	changed_files=""
	if [ -n "$last" ]; then
		latest_id=$(basename "$last")
		manifest=$(backup_meta_json_fields "$last")
		created=$(printf '%s' "$manifest" | jsonfilter -e '@.created_at' 2>/dev/null)
		[ -n "$created" ] ||
			created=$(date -r "$last" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)
		# An encrypted archive cannot be compared without its passphrase;
		# the page then says the comparison is unavailable.
		case "$latest_id" in
			*.enc) config_changed=unknown ;;
			*)
				if changed_files=$(backup_compare_config "$last"); then
					if [ -z "$changed_files" ]; then
						config_changed=0
					else
						config_changed=1
					fi
				else
					config_changed=unknown
				fi
				;;
		esac
	fi

	if [ -f "$WM_RUNTIME_DIR/last-auto-result" ]; then
		auto_result=$(sed -n 's/^result=//p' "$WM_RUNTIME_DIR/last-auto-result" 2>/dev/null | head -n 1)
		case "$auto_result" in
			success|failure) ;;
			*) auto_result="" ;;
		esac
		auto_time=$(sed -n 's/^time=//p' "$WM_RUNTIME_DIR/last-auto-result" 2>/dev/null | head -n 1)
		case "$auto_time" in
			''|*[!0-9]*) auto_time=0 ;;
		esac
		auto_description=$(sed -n 's/^description=//p' "$WM_RUNTIME_DIR/last-auto-result" 2>/dev/null | head -n 1)
		auto_id=$(sed -n 's/^id=//p' "$WM_RUNTIME_DIR/last-auto-result" 2>/dev/null | head -n 1)
	fi

	mount=$(backup_mount_of "$dir")
	case "$mount" in /mnt/*|/media/*) external=1 ;; esac
	[ -w "$dir" ] 2>/dev/null && writable=1

	json_init
	json_add_boolean ok 1
	json_add_string path "$dir"
	json_add_string mount "$mount"
	json_add_boolean external "$external"
	json_add_boolean writable "$writable"
	json_add_int count "${count:-0}"
	json_add_int total_kb "${total:-0}"
	json_add_int free_kb "${free:-0}"
	json_add_string last_created "$created"
	json_add_int auto_last "$(cat "$WM_RUNTIME_DIR/last-auto" 2>/dev/null || echo 0)"
	json_add_string auto_result "$auto_result"
	json_add_int auto_result_time "${auto_time:-0}"
	json_add_string auto_result_description "$auto_description"
	json_add_string auto_result_id "$auto_id"
	json_add_string latest_id "$latest_id"
	json_add_string config_changed "$config_changed"
	json_add_array config_changed_files
	for file in $changed_files; do
		json_add_string "" "$file"
	done
	json_close_array
	json_dump
	echo
}

backup_validate_json() { # id [password]
	local id="$1" password="${2:-}" archive extracted manifest fmt app type
	local errors=0 warnings=0 legacy=0 syntax_msg line

	if ! backup_resolve "$id"; then
		wm_error E-NOTFOUND "The backup does not exist."
		return 1
	fi
	archive="$BACKUP_FILE"
	[ "$BACKUP_IS_LEGACY" = 1 ] && legacy=1

	extracted=$(backup_extract "$archive" "$password" 2>/dev/null)
	[ -n "$extracted" ] || {
		wm_error E-INVALID "The archive failed validation (damaged, encrypted, or unsafe entries)."
		return 1
	}

	manifest=$(cat "$extracted/manifest.json" 2>/dev/null)
	fmt=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_format_version' 2>/dev/null)
	app=$(printf '%s' "$manifest" | jsonfilter -e '@.application' 2>/dev/null)
	type=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_type' 2>/dev/null)
	[ -n "$manifest" ] || type=legacy

	json_init
	json_add_boolean ok 1
	json_add_string id "$id"
	json_add_string type "${type:-legacy}"
	json_add_int format "${fmt:-0}"
	json_add_string application "$app"
	json_add_boolean legacy "$legacy"

	json_add_array errors
	if [ -z "$manifest" ] && [ "$legacy" != 1 ]; then
		json_add_string "" "The archive has no manifest."
		errors=$((errors + 1))
	fi
	if [ -n "$manifest" ] && [ "${fmt:-0}" -gt "$WM_BACKUP_FORMAT" ] 2>/dev/null; then
		json_add_string "" "The archive format is newer than this package supports."
		errors=$((errors + 1))
	fi
	if [ -n "$manifest" ] && [ "$app" != "$WM_BACKUP_APP" ]; then
		json_add_string "" "The archive was created by another application ($app)."
		errors=$((errors + 1))
	fi
	# The restore path refuses these files too; reporting it here means the
	# operator sees the problem before a restore is attempted.
	syntax_msg=$(config_check_syntax "$extracted/etc/config" "The archive")
	if [ -n "$syntax_msg" ]; then
		json_add_string "" "$syntax_msg"
		errors=$((errors + 1))
	fi
	json_close_array

	# Firmware, radio and interface differences are warnings, not errors:
	# DESIGN §10.7 asks the operator to see them, not to be locked out.  They
	# are kept apart from the other warnings so the Restore page can label
	# them "Compatibility warnings" without repeating the encryption note.
	local compat_lines
	compat_lines=$(backup_compat_warnings "$manifest")

	json_add_array warnings
	if [ "$(printf '%s' "$manifest" | jsonfilter -e '@.encrypted' 2>/dev/null)" = true ]; then
		json_add_string "" "The archive is encrypted."
	fi
	while IFS= read -r line; do
		[ -n "$line" ] && json_add_string "" "$line"
	done <<EOF
$compat_lines
EOF
	json_close_array

	json_add_array compatibility
	while IFS= read -r line; do
		[ -n "$line" ] && json_add_string "" "$line"
	done <<EOF
$compat_lines
EOF
	json_close_array

	json_add_boolean valid "$([ "$errors" -eq 0 ] && echo 1 || echo 0)"
	json_dump
	echo

	rm -rf "$extracted"
}

backup_details_json() { # id [password]
	local id="$1" password="${2:-}" archive extracted manifest size type created hostname desc name
	local scope json_radios radio band fw fw_id fw_ver fw_target f files

	if ! backup_resolve "$id"; then
		wm_error E-NOTFOUND "The backup does not exist."
		return 1
	fi
	archive="$BACKUP_FILE"
	size=$(du -k "$archive" 2>/dev/null | awk '{ print $1 }')
	extracted=$(backup_extract "$archive" "$password" 2>/dev/null)
	if [ -z "$extracted" ]; then
		json_init
		json_add_boolean ok 1
		json_add_string id "$id"
		json_add_int size_kb "${size:-0}"
		json_add_boolean legacy "$([ "$BACKUP_IS_LEGACY" = 1 ] && echo 1 || echo 0)"
		json_add_boolean valid 0
		json_add_string error "The archive is encrypted (passphrase needed) or invalid."
		json_dump
		echo
		return 0
	fi

	manifest=$(cat "$extracted/manifest.json" 2>/dev/null)
	[ -n "$manifest" ] || manifest=$(backup_manifest_json "$extracted" "$id" 2>/dev/null)

	type=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_type' 2>/dev/null)
	[ -n "$type" ] || type=legacy
	created=$(printf '%s' "$manifest" | jsonfilter -e '@.created_at' 2>/dev/null)
	hostname=$(printf '%s' "$manifest" | jsonfilter -e '@.hostname' 2>/dev/null)
	desc=$(printf '%s' "$manifest" | jsonfilter -e '@.description' 2>/dev/null)
	name=$(printf '%s' "$manifest" | jsonfilter -e '@.name' 2>/dev/null)
	fw_id=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.id' 2>/dev/null)
	fw_ver=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.version' 2>/dev/null)
	fw_target=$(printf '%s' "$manifest" | jsonfilter -e '@.firmware.target' 2>/dev/null)
	scope=$(printf '%s' "$manifest" | jsonfilter -e '@.backup_scope[*]' 2>/dev/null)

	json_init
	json_add_boolean ok 1
	json_add_string id "$id"
	json_add_int size_kb "${size:-0}"
	json_add_boolean legacy "$([ "$BACKUP_IS_LEGACY" = 1 ] && echo 1 || echo 0)"
	json_add_boolean valid 1
	json_add_string type "$type"
	json_add_string created_at "$created"
	json_add_string hostname "$hostname"
	json_add_string description "$desc"
	json_add_string name "$name"
	json_add_array scope
	for f in $scope; do json_add_string "" "$f"; done
	json_close_array
	json_add_object firmware
	json_add_string id "$fw_id"
	json_add_string version "$fw_ver"
	json_add_string target "$fw_target"
	json_close_object
	json_add_array radios
	for radio in $(printf '%s' "$manifest" | jsonfilter -e '@.radios[*].name' 2>/dev/null); do
		band=$(printf '%s' "$manifest" | jsonfilter -e "@.radios[@.name='$radio'].band" 2>/dev/null)
		json_add_object
		json_add_string name "$radio"
		json_add_string band "$band"
		json_close_object
	done
	json_close_array
	json_add_array compatibility
	while IFS= read -r f; do
		[ -n "$f" ] && json_add_string "" "$f"
	done <<EOF
$(backup_compat_warnings "$manifest")
EOF
	json_close_array
	json_add_array files
	while read -r f; do
		[ -n "$f" ] && json_add_string "" "$f"
	done <<EOF
$(cd "$extracted" && find etc/config -type f 2>/dev/null | sort)
EOF
	json_close_array
	json_dump
	echo
	rm -rf "$extracted"
}

# Copy one backup into a fixed download directory.  The archive may live on
# any configured storage, but the LuCI file ACL only has to cover this single
# directory, so the browser never gets read access to the storage location
# itself.  The id is validated by backup_resolve(); the destination name is
# the id, never client input.
backup_export_json() { # id
	local id="$1" dir="/tmp/wifimanager-download" dest

	if ! backup_resolve "$id"; then
		wm_error E-NOTFOUND "The backup does not exist."
		return 1
	fi
	[ "$BACKUP_IS_LEGACY" = 1 ] && {
		wm_error E-ID "Legacy backups are not exported from the web interface."
		return 1
	}

	mkdir -p "$dir" 2>/dev/null || {
		wm_error E-IO "The download directory cannot be created."
		return 1
	}
	dest="$dir/$id"
	rm -f "$dir"/.tmp.*
	cp "$BACKUP_FILE" "$dir/.tmp.$$" || {
		rm -f "$dir/.tmp.$$"
		wm_error E-IO "The backup could not be prepared for download."
		return 1
	}
	chmod 600 "$dir/.tmp.$$" 2>/dev/null
	mv "$dir/.tmp.$$" "$dest" || {
		rm -f "$dir/.tmp.$$"
		wm_error E-IO "The backup could not be prepared for download."
		return 1
	}

	json_init
	json_add_boolean ok 1
	json_add_string id "$id"
	json_add_string path "$dest"
	json_dump
	echo
}

# ---------------------------------------------------------------------------
# Restore worker
# ---------------------------------------------------------------------------

# Snapshot all config files a restore may touch.
restore_snapshot() { # dir
	local snap="$1" cfg
	mkdir -p "$snap/etc/config"
	for cfg in $WM_BACKUP_KNOWN_FILES; do
		[ -f "$WM_CONFIG_DIR/$cfg" ] && cp "$WM_CONFIG_DIR/$cfg" "$snap/etc/config/$cfg"
	done
}

restore_rollback() { # snapdir
	local snap="$1" cfg
	for cfg in $WM_BACKUP_KNOWN_FILES; do
		if [ -f "$snap/etc/config/$cfg" ]; then
			cp "$snap/etc/config/$cfg" "$WM_CONFIG_DIR/$cfg"
		elif [ -f "$WM_CONFIG_DIR/$cfg" ]; then
			# The file did not exist when the snapshot was taken, so the restore
			# created it.  Rolling back means removing it, not leaving a
			# configuration the operator never had.
			rm -f "$WM_CONFIG_DIR/$cfg"
		fi
	done
	for cfg in network wireless dhcp firewall system meshassistant dawn wifimanager; do
		# uci commit on an absent config would recreate the file.
		[ -f "$WM_CONFIG_DIR/$cfg" ] || continue
		uci_commit "$cfg"
	done
}

restore_verify() { # touched_wireless touched_network
	local wireless="$1" network="$2" i=0 ip

	if [ "$network" = 1 ]; then
		while [ "$i" -lt 90 ]; do
			ip=$(lan_ipv4)
			[ -n "$ip" ] && break
			sleep 1
			i=$((i + 1))
		done
		[ -n "$ip" ] || {
			echo "The LAN interface did not come back within 90 seconds."
			return 1
		}
	fi
	if [ "$wireless" = 1 ]; then
		i=0
		while [ "$i" -lt 30 ]; do
			[ -n "$(iw dev 2>/dev/null | awk '/Interface/{ print $2; exit }')" ] && break
			sleep 1
			i=$((i + 1))
		done
		[ "$i" -lt 30 ] || {
			echo "No wireless interface came up after the restore."
			return 1
		}
	fi
	restore_verify_services "$wireless" || return 1
	return 0
}

# Apply the restore plan.  $1 extracted dir, $2 type, $3 scope.  Touched layers
# are returned through globals so log output does not corrupt the result.
restore_apply() {
	local src="$1" type="$2" scope="$3" area

	RESTORE_TOUCHED_WIRELESS=0
	RESTORE_TOUCHED_NETWORK=0

	has_scope() { case " $scope " in *" $1 "*) return 0 ;; esac; return 1; }

	case "$type" in
		full)
			for area in $WM_BACKUP_KNOWN_FILES; do
				[ -f "$src/etc/config/$area" ] || continue
				replace_config_file "$src" "$area"
				case "$area" in
					wireless) RESTORE_TOUCHED_WIRELESS=1 ;;
					network) RESTORE_TOUCHED_NETWORK=1 ;;
				esac
			done
			;;
		wireless)
			merge_wireless_nonmesh "$src"
			RESTORE_TOUCHED_WIRELESS=1
			;;
		mesh|legacy)
			merge_wireless_mesh "$src"
			merge_network_mesh "$src"
			merge_dhcp_mesh "$src"
			merge_firewall_mesh "$src"
			# A legacy archive covered the whole Mesh Assistant file, so it also
			# carries the roaming options; a Mesh backup does not.
			if [ "$type" = legacy ]; then
				merge_meshassistant_scope "$src" mesh backhaul roaming
			else
				merge_meshassistant_scope "$src" mesh backhaul
			fi
			RESTORE_TOUCHED_WIRELESS=1
			RESTORE_TOUCHED_NETWORK=1
			;;
		roaming)
			merge_wireless_roaming "$src"
			replace_config_file "$src" dawn
			merge_meshassistant_scope "$src" roaming
			RESTORE_TOUCHED_WIRELESS=1
			;;
		custom)
			if has_scope wireless; then
				merge_wireless_nonmesh "$src"
				RESTORE_TOUCHED_WIRELESS=1
			fi
			if has_scope roaming || has_scope dawn; then
				merge_wireless_roaming "$src"
				replace_config_file "$src" dawn
				RESTORE_TOUCHED_WIRELESS=1
			fi
			if has_scope mesh || has_scope backhaul; then
				merge_wireless_mesh "$src"
				merge_network_mesh "$src"
				merge_dhcp_mesh "$src"
				merge_firewall_mesh "$src"
				has_scope mesh && merge_meshassistant_scope "$src" mesh
				has_scope backhaul && merge_meshassistant_scope "$src" backhaul
				RESTORE_TOUCHED_WIRELESS=1
				RESTORE_TOUCHED_NETWORK=1
			fi
			has_scope network && { replace_config_file "$src" network; RESTORE_TOUCHED_NETWORK=1; }
			has_scope dhcp && replace_config_file "$src" dhcp
			has_scope firewall && replace_config_file "$src" firewall
			has_scope system && replace_config_file "$src" system
			has_scope roaming && merge_meshassistant_scope "$src" roaming
			has_scope wifimanager && replace_config_file "$src" wifimanager
			;;
	esac

	for area in network wireless dhcp firewall system meshassistant dawn wifimanager; do
		uci_commit "$area"
	done
}

backup_restore_worker() { # id [password_file]
	local id="$1" password_file="$2" password="" extracted type scope
	local verify_msg snap backup_id wireless network syntax_msg

	WM_OP_NAME=backup_restore
	wm_take_lock || {
		# Do not touch op.json: another operation owns it.
		wm_log "Operation refused: another operation is already running."
		return 1
	}
	wm_op_begin backup_restore "Restoring $id"

	if [ -n "$password_file" ] && [ -f "$password_file" ]; then
		password=$(cat "$password_file")
		rm -f "$password_file"
	fi

	if ! backup_resolve "$id"; then
		wm_op_finish failed "The backup does not exist."
		return 1
	fi

	extracted=$(backup_extract "$BACKUP_FILE" "$password" 2>&1)
	case "$extracted" in
		/*) ;;
		*) wm_op_finish failed "$extracted"; return 1 ;;
	esac

	# DESIGN §10.7: check the configuration syntax before anything is changed.
	# A file that does not parse would otherwise be committed silently.
	if ! syntax_msg=$(config_check_syntax "$extracted/etc/config" "The archive"); then
		rm -rf "$extracted"
		wm_op_finish failed "$syntax_msg Nothing was changed."
		wm_log "restore: rejected before any change: $syntax_msg"
		return 1
	fi

	type=$(jsonfilter -i "$extracted/manifest.json" -e '@.backup_type' 2>/dev/null)
	if [ -z "$type" ]; then
		# Legacy line manifest.
		type=legacy
	fi
	[ -n "$type" ] || type=mesh
	scope=$(jsonfilter -i "$extracted/manifest.json" -e '@.backup_scope[*]' 2>/dev/null | tr '\n' ' ')

	# DESIGN §10.7: firmware, radio count/path and interface differences are
	# advisory, but the operator must be able to find them after a restore.
	local compat_count=0 compat_line
	while IFS= read -r compat_line; do
		[ -n "$compat_line" ] || continue
		wm_log "restore: compatibility: $compat_line"
		compat_count=$((compat_count + 1))
	done <<EOF
$(backup_compat_warnings "$(cat "$extracted/manifest.json" 2>/dev/null)")
EOF

	snap=$(mktemp -d /tmp/wifimanager-snapshot.XXXXXX) || {
		wm_op_finish failed "Unable to create the restore snapshot."
		return 1
	}
	restore_snapshot "$snap"

	# DESIGN §10.7: every restore is preceded by a full archive.  The snapshot
	# alone lives in /tmp and disappears on a reboot, so the archive is not
	# optional and no setting can turn it off.
	backup_id=$(backup_create_auto full "Before restoring $id")
	if [ -z "$backup_id" ]; then
		rm -rf "$snap" "$extracted"
		wm_op_finish failed "The pre-restore backup failed; nothing was changed."
		return 1
	fi
	wm_log "restore: pre-restore backup $backup_id"

	restore_apply "$extracted" "$type" "$scope"
	wireless=$RESTORE_TOUCHED_WIRELESS
	network=$RESTORE_TOUCHED_NETWORK

	# The merged result must parse as well: a whole-file copy inside a full
	# restore or a custom scope still has to be a valid UCI file.
	if ! syntax_msg=$(config_check_syntax "$WM_CONFIG_DIR" "The restored configuration"); then
		restore_rollback "$snap"
		rm -rf "$extracted" "$snap"
		reload_config >/dev/null 2>&1
		wm_reload_network
		wm_reload_wifi
		wm_op_finish failed "$syntax_msg The previous configuration was restored." 0
		wm_event restore id "$id" result rolled-back
		wm_log "restore: post-apply syntax check failed; the snapshot was restored"
		return 1
	fi
	rm -rf "$extracted"

	# Bring the restored configuration into force before verifying it.  A
	# restored mesh section that is never applied would leave the runtime on the
	# old sections, so the device would look healthy while running the wrong
	# configuration.
	if ! verify_msg=$(restore_apply_runtime); then
		restore_rollback "$snap"
		rm -rf "$snap"
		reload_config >/dev/null 2>&1
		wm_reload_network
		wm_reload_wifi
		wm_op_finish failed "$verify_msg The previous configuration was restored." 0
		wm_event restore id "$id" result rolled-back
		wm_log "restore: applying the restored configuration failed; the snapshot was restored"
		return 1
	fi

	if verify_msg=$(restore_verify "$wireless" "$network"); then
		rm -rf "$snap"
		if [ "$compat_count" -gt 0 ]; then
			wm_op_finish done "Backup $id restored and verified with $compat_count compatibility warning(s)." 1
		else
			wm_op_finish done "Backup $id restored and verified." 1
		fi
		wm_event restore id "$id" result ok compatibility "$compat_count"
		wm_log "restore: $id applied and verified ($compat_count compatibility warnings)"
		return 0
	fi

	wm_log "restore: verification failed: $verify_msg; rolling back"
	restore_rollback "$snap"
	reload_config >/dev/null 2>&1
	wm_reload_network
	wm_reload_wifi
	rm -rf "$snap"
	wm_op_finish failed "$verify_msg The previous configuration was restored." 0
	wm_event restore id "$id" result rolled-back
	return 1
}

# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

backup_import() { # path [password-or-@file]
	local path="$1" password="${2:-}" dir base tmp src dec="" manifest id stamp n encrypted=0 size

	# rpcd hands the passphrase over in a 0600 file so it never appears in
	# the process list.
	case "$password" in
		@*) password=$(cat "${password#@}" 2>/dev/null) ;;
	esac

	case "$path" in
		/tmp/wifimanager-upload/*) ;;
		*) wm_error E-PATH "Uploads are only accepted from the upload directory."; return 1 ;;
	esac
	case "$path" in
		*..*|*\\*) wm_error E-PATH "Invalid upload path."; return 1 ;;
	esac
	[ -f "$path" ] && [ ! -L "$path" ] || {
		wm_error E-NOTFOUND "The uploaded file does not exist."
		return 1
	}
	size=$(wc -c <"$path" 2>/dev/null)
	case "${size:-0}" in ''|*[!0-9]*) size=0 ;; esac
	[ "$size" -le 16777216 ] || {
		wm_error E-INPUT "The uploaded archive is larger than 16 MiB."
		return 1
	}
	base=$(basename "$path")
	dir=$(backup_dir)

	# The browser stores every upload as upload.tar, so the name says nothing
	# about encryption.  openssl output cannot be listed by tar, which is the
	# signal that a passphrase is needed.
	if ! tar -tf "$path" >/dev/null 2>&1; then
		# openssl writes a "Salted__" marker; anything else that tar cannot
		# list is damaged, not encrypted.
		case "$(head -c 8 "$path" 2>/dev/null)" in
			Salted__) encrypted=1 ;;
			*) wm_error E-INVALID "The uploaded file is not a valid WiFi Manager backup."; return 1 ;;
		esac
		if [ -z "$password" ]; then
			wm_error E-PASS "This backup is encrypted; a passphrase is required."
			return 1
		fi
		if ! command -v openssl >/dev/null 2>&1; then
			wm_error E-PASS "openssl is not installed; the backup cannot be decrypted."
			return 1
		fi
		dec=$(mktemp /tmp/wifimanager-import.XXXXXX) || return 1
		if ! backup_decrypt_file "$path" "$dec" "$password"; then
			rm -f "$dec"
			wm_error E-PASS "The passphrase is wrong or the archive is damaged."
			return 1
		fi
		src="$dec"
	else
		src="$path"
	fi

	tmp=$(backup_extract "$src" "" 2>/dev/null)
	[ -n "$tmp" ] || {
		[ -n "$dec" ] && rm -f "$dec"
		wm_error E-INVALID "The uploaded file is not a valid WiFi Manager backup."
		return 1
	}
	if [ ! -s "$tmp/manifest.json" ]; then
		rm -rf "$tmp"
		[ -n "$dec" ] && rm -f "$dec"
		wm_error E-INVALID "The uploaded archive has no manifest."
		return 1
	fi
	manifest=$(cat "$tmp/manifest.json" 2>/dev/null)

	# Keep the uploaded name when it is a valid id; otherwise reuse the id
	# recorded in the manifest.  A conflict or a missing id gets a fresh one.
	id=""
	if validate_backup_id "$base" && [ "$encrypted" = 0 ]; then
		id="$base"
		[ -e "$dir/$id" ] && {
			rm -rf "$tmp"
			wm_error E-EXISTS "A backup with this name already exists."
			return 1
		}
	else
		id=$(printf '%s' "$manifest" | jsonfilter -e '@.id' 2>/dev/null)
		validate_backup_id "$id" || id=""
	fi
	if [ "$encrypted" = 1 ]; then
		case "$id" in
			*.enc) ;;
			'') ;;
			*) id="${id%.tar}.enc" ;;
		esac
	fi
	if [ -z "$id" ] || [ -e "$dir/$id" ]; then
		stamp=$(date '+%Y%m%d-%H%M%S')
		id="wifimanager-$stamp.tar"
		n=1
		while [ -e "$dir/$id" ] || [ -e "$dir/$id.enc" ]; do
			id="wifimanager-$stamp-$n.tar"
			n=$((n + 1))
		done
		[ "$encrypted" = 1 ] && id="$id.enc"
	fi

	mv "$path" "$dir/$id" && chmod 600 "$dir/$id" || {
		rm -rf "$tmp"
		[ -n "$dec" ] && rm -f "$dec"
		wm_error E-IO "The uploaded archive could not be stored."
		return 1
	}
	sha256sum "$dir/$id" | awk '{ print $1 "  " $2 }' >"$dir/$id.sha256"
	chmod 600 "$dir/$id.sha256" 2>/dev/null
	if [ "$encrypted" = 1 ]; then
		cp "$tmp/manifest.json" "$dir/$id.meta.json" 2>/dev/null &&
			chmod 600 "$dir/$id.meta.json" 2>/dev/null
	fi
	rm -rf "$tmp"
	[ -n "$dec" ] && rm -f "$dec"
	wm_log "backup: imported $id"
	json_init
	json_add_boolean ok 1
	json_add_string id "$id"
	json_dump
	echo
	return 0
}

# Copy a legacy archive into the new store with a converted manifest.  The
# original stays untouched.
backup_legacy_import() { # id
	local id="$1" src tmp stamp newid fw

	validate_legacy_id "$id" || {
		wm_error E-ID "Invalid legacy backup id."
		return 1
	}
	src="$WM_LEGACY_BACKUP_DIR/$id"
	[ -f "$src" ] && [ ! -L "$src" ] || {
		wm_error E-NOTFOUND "The legacy backup does not exist."
		return 1
	}

	tmp=$(backup_extract "$src" "" 2>/dev/null)
	[ -n "$tmp" ] || {
		wm_error E-INVALID "The legacy archive is invalid."
		return 1
	}

	stamp=$(date '+%Y%m%d-%H%M%S')
	newid="wifimanager-$stamp.tar"
	local n=1
	while [ -e "$(backup_dir)/$newid" ]; do
		newid="wifimanager-$stamp-$n.tar"
		n=$((n + 1))
	done

	rm -f "$tmp/manifest.json" "$tmp/checksums.txt"
	backup_write_manifest "$tmp" "$newid" legacy "mesh" "Imported legacy Mesh Assistant backup" || {
		rm -rf "$tmp"
		wm_error E-BACKUP "Unable to build the converted manifest."
		return 1
	}
	backup_build_checksums "$tmp" || {
		rm -rf "$tmp"
		wm_error E-BACKUP "Unable to build checksums."
		return 1
	}

	tar -cf "$(backup_dir)/.tmp.$$" -C "$tmp" manifest.json checksums.txt etc/config 2>/dev/null &&
		mv "$(backup_dir)/.tmp.$$" "$(backup_dir)/$newid" &&
		chmod 600 "$(backup_dir)/$newid"
	rm -rf "$tmp"
	[ -f "$(backup_dir)/$newid" ] || {
		wm_error E-BACKUP "Unable to store the imported backup."
		return 1
	}
	wm_log "backup: imported legacy $id as $newid"
	json_init
	json_add_boolean ok 1
	json_add_string id "$newid"
	json_dump
	echo
}

# ---------------------------------------------------------------------------
# Timer entry point
# ---------------------------------------------------------------------------

backup_tick() {
	local enabled freq last now due=0

	[ "$(backup_conf enabled 1)" = 1 ] || return 0
	freq=$(backup_conf frequency before_change)
	case "$freq" in
		daily|weekly) ;;
		*) return 0 ;;
	esac

	last=$(cat "$WM_RUNTIME_DIR/last-auto" 2>/dev/null)
	now=$(date +%s)
	if [ -z "$last" ]; then
		due=1
	else
		case "$freq" in
			daily) [ $((now - last)) -ge 86400 ] && due=1 ;;
			weekly) [ $((now - last)) -ge 604800 ] && due=1 ;;
		esac
	fi
	[ "$due" = 1 ] || return 0

	if [ -n "$(backup_create_auto full "Automatic $freq backup")" ]; then
		mkdir -p "$WM_RUNTIME_DIR"
		echo "$now" >"$WM_RUNTIME_DIR/last-auto"
		wm_log "backup: automatic $freq backup created"
	else
		wm_log "backup: automatic $freq backup failed"
	fi
}
