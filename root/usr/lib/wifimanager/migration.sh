#!/bin/sh
# Migration from the standalone Mesh Assistant package.
#
# WiFi Manager reads the same /etc/config/meshassistant file, so the migration
# is a guarded state transition rather than a copy: detect the old package,
# validate the installed configuration, take a full backup, stop the legacy
# daemon so two managers never run at once, and record the switch as *pending*.
# Nothing is final until the operator confirms on the Overview page (DESIGN §15
# "User Confirmation"); the legacy configuration, its archives and the
# pre-migration backup are never deleted, and the legacy service can be
# restored instead.

. /usr/lib/wifimanager/common.sh
. /usr/lib/wifimanager/backup.sh

MIGRATION_LEGACY_INIT="/etc/init.d/meshassistant"
MIGRATION_LEGACY_CONF="$WM_CONFIG_DIR/meshassistant"

migration_legacy_present() {
	[ -f "$MIGRATION_LEGACY_CONF" ] || [ -x "$MIGRATION_LEGACY_INIT" ]
}

migration_conf() { uci -q get "wifimanager.settings.$1"; }

migration_legacy_enabled() {
	[ -x "$MIGRATION_LEGACY_INIT" ] || { echo 0; return; }
	"$MIGRATION_LEGACY_INIT" enabled >/dev/null 2>&1 && echo 1 || echo 0
}

migration_legacy_running() {
	[ -x "$MIGRATION_LEGACY_INIT" ] || { echo 0; return; }
	if command -v ubus >/dev/null 2>&1 &&
		ubus call service list 2>/dev/null | grep -q '"meshassistant"'; then
		echo 1
		return
	fi
	"$MIGRATION_LEGACY_INIT" status >/dev/null 2>&1 && echo 1 || echo 0
}

migration_ok_json() { # message
	(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_boolean ok 1
		json_add_string message "$1"
		json_dump
	)
	echo
}

# Install-time preparation, called from uci-defaults through worker.sh.
# Idempotent: a reinstall never reopens a decision the operator already made.
migration_prepare() {
	local old_valid=1 backup_id was_enabled msg
	local prev_pending prev_was prev_backup detected_at

	migration_legacy_present || {
		wm_log "migration: no legacy installation detected."
		return 0
	}

	case "$(migration_conf migration_confirmed)$(migration_conf migration_declined)" in
		*1*)
			wm_log "migration: the operator already decided; state left unchanged."
			return 0
			;;
	esac

	if ! msg=$(config_check_syntax "$WM_CONFIG_DIR" "The installed"); then
		old_valid=0
		wm_log "migration: $msg"
	fi

	# A reinstall or upgrade re-runs this while the decision is still pending.
	# By then this package has already disabled the legacy daemon, so its live
	# state no longer tells whether the operator had it enabled: keep the value
	# and the backup recorded when the switch was first detected, and do not
	# stack another pre-migration archive on top of the existing one.
	prev_pending=$(migration_conf migration_pending)
	prev_was=$(migration_conf migration_legacy_was_enabled)
	prev_backup=$(migration_conf migration_backup)

	backup_id=
	if [ "$prev_pending" != 1 ] || [ -z "$prev_backup" ]; then
		backup_id=$(backup_create_auto full "Before switching from Mesh Assistant")
	fi
	if [ -z "$backup_id" ]; then
		backup_id=$prev_backup
	fi
	if [ -z "$backup_id" ]; then
		wm_log "migration: the pre-migration backup failed; continuing without one."
	fi

	was_enabled=$(migration_legacy_enabled)
	if [ "$prev_pending" = 1 ] && [ -n "$prev_was" ]; then
		was_enabled=$prev_was
	fi

	detected_at=$(migration_conf migration_detected_at)
	if [ "$prev_pending" != 1 ] || [ -z "$detected_at" ]; then
		detected_at=$(date +%s)
	fi

	uci set wifimanager.settings.migration_pending=1
	uci set wifimanager.settings.migration_legacy_present=1
	uci set wifimanager.settings.migration_legacy_was_enabled="$was_enabled"
	uci set wifimanager.settings.migration_old_valid="$old_valid"
	uci set wifimanager.settings.migration_detected_at="$detected_at"
	[ -n "$backup_id" ] && uci set wifimanager.settings.migration_backup="$backup_id"

	# Coexistence: two managers must never run at the same time.  This is the
	# only change made before the operator confirms; postrm re-enables the
	# service when the package is removed.
	if [ "$was_enabled" = 1 ]; then
		"$MIGRATION_LEGACY_INIT" disable >/dev/null 2>&1
		"$MIGRATION_LEGACY_INIT" stop >/dev/null 2>&1
		uci set wifimanager.settings.legacy_service_disabled=1
	fi
	uci_commit wifimanager

	wm_log "migration: pending operator confirmation (backup ${backup_id:-none})."
	wm_event migration result pending backup "${backup_id:-none}"
	return 0
}

migration_status_json() {
	local old_valid confirmed declined

	old_valid=$(migration_conf migration_old_valid)
	[ -n "$old_valid" ] || old_valid=1
	confirmed=$(migration_conf migration_confirmed)
	[ -n "$confirmed" ] || confirmed=0
	declined=$(migration_conf migration_declined)
	[ -n "$declined" ] || declined=0

	(
		. /usr/share/libubox/jshn.sh
		json_init
		json_add_boolean ok 1
		json_add_boolean legacy_present "$(migration_legacy_present && echo 1 || echo 0)"
		json_add_boolean legacy_enabled "$(migration_legacy_enabled)"
		json_add_boolean legacy_running "$(migration_legacy_running)"
		json_add_boolean pending "$([ "$(migration_conf migration_pending)" = 1 ] && echo 1 || echo 0)"
		json_add_boolean confirmed "$confirmed"
		json_add_boolean declined "$declined"
		json_add_boolean old_valid "$old_valid"
		json_add_string detected_at "$(migration_conf migration_detected_at)"
		json_add_string backup "$(migration_conf migration_backup)"
		json_add_boolean mesh_enabled "$([ "$(uci -q get meshassistant.config.enabled)" = 1 ] && echo 1 || echo 0)"
		# Runtime state at the last confirmation, so the Overview can say
		# whether the mesh is actually up instead of only what the files say.
		json_add_boolean mesh_running "$([ -e /sys/class/net/bat0 ] && echo 1 || echo 0)"
		json_add_string checked_at "$(migration_conf migration_checked_at)"
		json_dump
	)
	echo
}

# The "Validate New Config" + "User Confirmation" steps of DESIGN §15.
migration_confirm_json() { # args
	local confirm msg i=0 mesh_running=0

	confirm=$(jget "$1" '@.confirm')
	if [ "$confirm" != true ] && [ "$confirm" != 1 ]; then
		wm_error E-CONFIRM "Confirming the migration requires explicit confirmation."
		return 1
	fi

	if migration_legacy_present &&
		! msg=$(config_check_syntax "$WM_CONFIG_DIR" "The current"); then
		wm_error E-CONFIG "$msg"
		return 1
	fi

	if [ "$(migration_legacy_enabled)" = 1 ]; then
		"$MIGRATION_LEGACY_INIT" disable >/dev/null 2>&1
		"$MIGRATION_LEGACY_INIT" stop >/dev/null 2>&1
		uci set wifimanager.settings.legacy_service_disabled=1
	fi

	# Stopping is asynchronous; confirming while the legacy daemon still runs
	# would leave two managers on one configuration.
	while [ "$i" -lt 5 ] && [ "$(migration_legacy_running)" = 1 ]; do
		sleep 1
		i=$((i + 1))
	done
	if [ "$(migration_legacy_running)" = 1 ]; then
		wm_error E-STATE "The Mesh Assistant service is still running; confirm the migration once it has stopped."
		return 1
	fi

	[ -e /sys/class/net/bat0 ] && mesh_running=1

	uci set wifimanager.settings.migration_pending=0
	uci set wifimanager.settings.migration_confirmed=1
	uci set wifimanager.settings.migration_new_valid=1
	uci set wifimanager.settings.migration_checked_at="$(date +%s)"
	uci set wifimanager.settings.migration_mesh_running="$mesh_running"
	uci -q delete wifimanager.settings.migration_declined 2>/dev/null
	uci_commit wifimanager

	wm_log "migration: confirmed by the operator; mesh runtime $mesh_running."
	wm_event migration result confirmed mesh_running "$mesh_running"
	if [ "$mesh_running" = 1 ]; then
		migration_ok_json "Migration confirmed. WiFi Manager manages the configuration; the Mesh Assistant service is stopped and bat0 is up."
	elif [ "$(uci -q get meshassistant.config.enabled)" = 1 ]; then
		migration_ok_json "Migration confirmed. WiFi Manager manages the configuration, but the mesh is enabled without bat0; apply the mesh settings to start it."
	else
		migration_ok_json "Migration confirmed. WiFi Manager manages the configuration; the Mesh Assistant service stays stopped."
	fi
}

# The way back: re-enable the legacy service.  Refused while the WiFi Manager
# mesh is applied, because then both engines would write the same sections.
migration_restore_legacy_json() { # args
	local confirm

	confirm=$(jget "$1" '@.confirm')
	if [ "$confirm" != true ] && [ "$confirm" != 1 ]; then
		wm_error E-CONFIRM "Restoring the legacy service requires explicit confirmation."
		return 1
	fi

	if ! migration_legacy_present; then
		wm_error E-NOTFOUND "The Mesh Assistant package is not installed."
		return 1
	fi

	if [ "$(uci -q get meshassistant.config.enabled)" = 1 ] ||
		[ "$(uci -q get meshassistant.config.running)" = 1 ]; then
		wm_error E-STATE "Disable the WiFi Manager mesh first; two managers must not run at the same time."
		return 1
	fi

	"$MIGRATION_LEGACY_INIT" enable >/dev/null 2>&1
	"$MIGRATION_LEGACY_INIT" start >/dev/null 2>&1

	uci set wifimanager.settings.legacy_service_disabled=0
	uci set wifimanager.settings.migration_pending=0
	uci set wifimanager.settings.migration_declined=1
	uci -q delete wifimanager.settings.migration_confirmed 2>/dev/null
	uci_commit wifimanager

	wm_log "migration: the operator restored the legacy service."
	wm_event migration result declined
	migration_ok_json "Mesh Assistant is enabled again; WiFi Manager records the migration as declined."
}
