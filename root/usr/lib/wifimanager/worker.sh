#!/bin/sh
# Entry point for everything that runs outside the rpcd call: detached
# operations, the peer daemon, and the periodic sampler.
#
#   worker.sh peer                      record one received datagram (stdin)
#   worker.sh peer-daemon               announcement listener + sender
#   worker.sh ticker                    events every 15 s, timers once a minute
#   worker.sh events                    one roaming sampler pass
#   worker.sh dawn_watchdog             one DAWN recovery pass
#   worker.sh backup_tick               one backup timer pass
#   worker.sh migrate_prepare           detect and prepare a Mesh Assistant migration
#   worker.sh backhaul-daemon           automatic backhaul switching sampler
#   worker.sh backhaul_tick             one backhaul decision pass
#   worker.sh mesh_apply|mesh_disable
#   worker.sh dumbap_enable|dumbap_disable
#   worker.sh roaming_apply
#   worker.sh restore <id> [password-file]
#
# Detached callers start this with setsid and closed standard streams, so a
# long operation survives the rpcd call and the UI can poll op_status.

. /usr/lib/wifimanager/common.sh

cmd="$1"
[ -n "$cmd" ] || {
	echo "usage: worker.sh <command>" >&2
	exit 1
}
[ "$#" -gt 0 ] && shift

# The datagram path runs for every received announcement; keep it to the two
# files it needs instead of sourcing the whole backend.
if [ "$cmd" = peer ]; then
	. /usr/lib/wifimanager/peer.sh
	record_peer
	exit $?
fi

if [ "$cmd" = peer-daemon ]; then
	. /usr/lib/wifimanager/peer.sh
	peer_daemon
	exit $?
fi

. /usr/lib/wifimanager/radio.sh
. /usr/lib/wifimanager/roaming.sh
. /usr/lib/wifimanager/backup.sh
. /usr/lib/wifimanager/backhaul.sh

wm_init_dirs

case "$cmd" in
	events)
		roaming_events_sample
		dawn_watchdog_once
		;;
	dawn_watchdog)
		dawn_watchdog_once
		;;
	backup_tick)
		backup_tick
		;;
	migrate_prepare)
		. /usr/lib/wifimanager/migration.sh
		migration_prepare
		;;
	backhaul_tick)
		backhaul_monitor_once
		;;
	backhaul-daemon)
		backhaul_daemon
		;;
	ticker)
		# Roaming transitions are short-lived, so the station table is sampled
		# every 15 seconds.  DAWN recovery and the backup timer only need a
		# minute-scale cadence and run on every fourth pass.
		tick=0
		while true; do
			roaming_events_sample
			if [ "$tick" -eq 0 ]; then
				dawn_watchdog_once
				backup_tick
			fi
			tick=$((tick + 1))
			[ "$tick" -ge 4 ] && tick=0
			sleep 15 &
			wait $!
		done
		;;
	mesh_apply|mesh_disable|dumbap_enable|dumbap_disable|roaming_apply|restore)
		. /usr/lib/wifimanager/mesh.sh
		. /usr/lib/wifimanager/diagnostics.sh
		case "$cmd" in
			restore) backup_restore_worker "$@" ;;
			*) "$cmd" ;;
		esac
		;;
	*)
		echo "worker.sh: unknown command '$cmd'" >&2
		exit 1
		;;
esac
