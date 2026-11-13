# 05 — Core Implementation (2.0.0)

This document describes how the core layers are built: the shared shell
backend, the single RPC surface, the radio and backup managers, the operation
model, the migration path and the test harness. It complements the designs in
`00`–`04` and records only what the current sources actually do.

## 1. Layers

```text
LuCI views (one file per menu node, 20 leaves)
  htdocs/luci-static/resources/view/wifimanager/**
        │
        ▼
Frontend utils (pure logic, no I/O)
  wifimanager.utils.{rpc,widgets,validation,radio,mesh,backup,format,uci,
                    wireless,wireless-form,network}
        │
        ▼
Single ubus object  "wifimanager"
  /usr/libexec/rpcd/wifimanager   (allowlisted dispatcher)
        │
        ▼
Shell backends
  common.sh   radio.sh   wireless.sh   network.sh   mesh.sh   peer.sh
  roaming.sh  backup.sh  diagnostics.sh
        │
        ▼
UCI (/etc/config/*) · /etc/wifimanager/* · ubus/iwinfo · ubus/network.interface
```

The browser never executes shell. The only privileged reads and writes go
through the methods declared below, and every view uses
`wifimanager.utils.rpc`; no view imports `fs` for writes and none uses
`fs.exec`.

## 2. Shell modules

| Module | Responsibility | Notable entry points |
| --- | --- | --- |
| `common.sh` | Paths, logging, JSON helpers, operation state, lock, reload helpers, UCI transaction helpers, the managed config-file list, the UCI syntax check and the shared FT-transport value | `wm_log`, `wm_error`, `wm_init_dirs`, `wm_op_begin`, `wm_op_finish`, `wm_take_lock`, `wm_reload_network`, `wm_reload_wifi`, `config_check_syntax`, `ft_over_ds_value` |
| `radio.sh` | Radio inventory, allocation/conflict checks, band/PHY parsing, runtime versus configured values, read-only facts for the allocation advisor | `radio_inventory_json`, `radio_check_json`, `radio_advice_json` |
| `channel.sh` | Read-only channel data for the recommendation: driver candidates, one scan snapshot, current-channel busy time; never writes UCI and never takes the operation lock | `channel_advice_json`, `channel_candidates`, `channel_scan_cells`, `channel_busy` |
| `capabilities.sh` | Driver capability data from `iw phy ... info` (bands, frequencies, interface modes, interface combinations); reports "not reported" instead of guessing | capability helpers used by `radio.sh` and `wireless.sh` |
| `wireless.sh` | AP/STA/ad-hoc and standalone MLO interface writes: field validation, radio check, Wireless-scope backup, private snapshot, commit, reload, runtime verification and rollback. Mesh-owned and 802.11s sections are refused | `wireless_iface_save_json`, `wireless_iface_delete_json` |
| `network.sh` | Read-only DHCP, DNS, IPv4, routing, firewall-zone and mesh/bridge checks over the current configuration | `network_check_json` |
| `mesh.sh` | Role handling, BATMAN-adv/802.11s setup, spectrum/htmode, wired and wireless backhaul, backhaul priority, AP mode; a failed apply restores the pre-apply snapshot | `mesh_apply`, `mesh_disable`, `apply_wired_backhaul`, `remove_wired_backhaul`, `mesh_apply_priority`, `dumbap_enable`, `dumbap_disable` |
| `backhaul.sh` | Carrier sampling, debounced automatic backhaul switching through netifd, runtime state and read-only status | `backhaul_monitor_once`, `backhaul_daemon`, `backhaul_switch_to`, `backhaul_status_json` |
| `peer.sh` | UDP peer announcements (wire format v1-v10), LAN identity/name exchange, peer cache, announcement daemon | `record_peer`, `peer_daemon`, `announce_identity`, `announce_names`, `mesh_hardif_radio` |
| `apscan.sh` | Neighbouring access point scan for the roaming page: `iw dev scan` with an `iwinfo` fallback, BSSID classification, read-only | `roaming_neighbor_scan_json` |
| `roaming.sh` | 802.11k/v/r writes, DAWN takeover/release, roaming event sampler; apply takes a Roaming-scope backup and a private snapshot and rolls back a failed commit or DAWN start | `roaming_apply`, `roaming_apply_snapshot`, `roaming_apply_rollback`, `roaming_apply_verify`, `setup_dawn`, `dawn_release`, `roaming_events_sample`, `roaming_events_json` |
| `restore.sh` | Scoped restore policies (file replace vs section merge per scope), runtime application of the restored configuration and hostapd/bat0/DAWN verification helpers; split out of `backup.sh` to keep every module below the size limit | `restore_apply_runtime`, `restore_verify_services`, `replace_config_file`, `merge_wireless_nonmesh`, `merge_wireless_mesh` |
| `backup.sh` | Global backup manager, scoped restore, syntax validation, restore compatibility warnings, legacy compatibility, import/export | `backup_create_core`, `backup_list_json`, `backup_validate_json`, `backup_compat_warnings`, `backup_restore_worker`, `backup_legacy_import` |
| `migration.sh` | Mesh Assistant migration state machine: validate the installed configuration, take a pre-migration backup, stop the legacy daemon, record pending/confirmed/declined, restore the legacy service on request | `migration_prepare`, `migration_status_json`, `migration_confirm_json`, `migration_restore_legacy_json` |
| `diagnostics.sh` | Read-only snapshots for the four diagnostics pages | `diagnostics_json`, `logs_json`, `mesh_status_json` |
| `worker.sh` | Detached operations, peer daemon, ticker, one-shot events, backup timer and migration preparation | `restore`, `mesh_apply`, `migrate_prepare`, `dumbap_enable`, `peer-daemon`, `ticker` |

`worker.sh` is started with `setsid` and closed standard streams so an operation
survives the rpcd call. Progress is written to
`/var/run/wifimanager/op.json` and polled through `op_status`.

## 3. RPC surface

One plugin, one ubus object. Read-only methods are loaded without the mesh
module; actions take the operation lock and either answer synchronously
(backup settings, baseline reads) or queue a worker and return
`{"ok":true,"queued":true}`.

| Method | Access | Mode | Notes |
| --- | --- | --- | --- |
| `status` | read | sync | Version, role, service state |
| `radio_inventory` | read | sync | Radios, interfaces, conflicts |
| `radio_check` | read | sync | `mode`, `device[]`, `mlo`, `section`; called by the interface editor before every save |
| `radio_advice` | read | sync | Facts for the allocation advisor: band, disabled/mesh state and enabled interfaces per radio; no verdicts and no writes |
| `channel_advice` | read | sync | `radio`; driver candidates, one scan snapshot, width, current channel and busy time; never writes |
| `network_check` | read | sync | Configuration-level DHCP/DNS/IP/route/firewall/mesh findings; never writes |
| `backup_list` | read | sync | New store, optional legacy |
| `backup_details` | read | sync | Manifest fields (password for encrypted) |
| `backup_validate` | read | sync | Integrity and compatibility report |
| `backup_status` | read | sync | Last backup, settings, counts |
| `backup_settings_get` | read | sync | Backup settings |
| `backup_settings_set` | write | sync | Validated UCI write |
| `backup_create` | write | sync | Archive creation, returns id |
| `backup_delete` | write | sync | Deletes archive and checksum |
| `backup_export` | write | sync | Copies to `/tmp/wifimanager-download` |
| `backup_import` | write | sync | Upload path only, legacy refused |
| `backup_legacy_import` | write | sync | Copy with new manifest |
| `backup_restore` | write | async | Requires `confirm`; spawns worker |
| `migration_status` | read | sync | Legacy presence, pending/confirmed/declined, old-config validity, pre-migration backup |
| `migration_confirm` | write | sync | Requires `confirm`; validates the current configuration and records the switch |
| `migration_restore_legacy` | write | sync | Requires `confirm`; refused while the WiFi Manager mesh is enabled |
| `mesh_status` | read | sync | Role, links, peers, checks |
| `mesh_events` | read | sync | Roaming/mesh event list |
| `backhaul_status` | read | sync | Active medium, wired carrier and link rate, wireless health, priority, last switch/error |
| `diagnostics` | read | sync | `wireless`, `mesh`, `system` |
| `logs` | read | sync | `wifimanager`, `events`, `dawn`, `syslog` |
| `op_status` | read | sync | Current/last detached operation |
| `wireless_iface_save` | write | sync | Validated create/update of an AP/STA/ad-hoc or standalone MLO interface; backup, commit, reload and rollback |
| `wireless_iface_delete` | write | sync | Requires `confirm`; backup, commit, reload and rollback |
| `mesh_apply` | write | async | Worker |
| `mesh_disable` | write | async | Worker |
| `mesh_dumbap` | write | async | Worker |
| `mesh_undumbap` | write | async | Worker |
| `roaming_apply` | write | async | Worker |

Arguments arrive as JSON and are read with `jget` (jsonfilter). No method takes a
command name, a shell fragment or an arbitrary path. Backup ids and legacy ids
have their own character-set and shape validation, and uploads must live under
`/tmp/wifimanager-upload`.

## 4. Radio manager

The radio manager has one implementation in `radio.sh`; the Wireless and MLO
pages both call `radio_check`, so a link is never validated by two different
rules.

- `radio_inventory_json` reports, for each radio: band, configured channel/TX
  power, runtime channel/TX power, busy state, interfaces and conflicts. When
  runtime values cannot be read, it returns `-`, and the view labels them as
  unavailable instead of inventing a value. The Radios page joins each section
  name with its interface record, so the Interfaces column shows the runtime
  name, the mode and the MLO/Mesh-owned/disabled marks.
- `radio_check_json` accepts the real interface `mode` (`ap`, `sta` or
  `adhoc`), a device list, an MLO flag and an optional section. It returns
  conflicts with `severity`, `code`, `message` and `detail`; the view adds the
  human-readable title from the shared code table. A caller that still sends `mode=mlo` has the
  stored section mode recovered (AP for a new link), so MLO links receive the
  same driver capability and combination checks as other interfaces.
- Both paths use the same channel helpers: `W-CHAN-01` (spectrum override
  disagrees with the radio channel), `W-CHAN-02` (overlapping 2.4 GHz
  channels) and `W-CHAN-03` (DFS channel in an MLO link) are reported by the
  inventory and by the save check for the radios being edited. Disabled
  sections are excluded from `radio_usage_collect`, so they cannot produce a
  W-CONC-01/02/03 warning.
- MLO requires two radios on distinct bands and a supported EHT htmode; sharing
  a radio between MLO and mesh is reported as `W-CONC-03`. The backend gates the
  MLO-specific checks on the `mlo` flag, and the frontend sends it explicitly.

### 4.1 Wireless interface editor

`utils/wireless.js`, `utils/wireless-form.js` and `wireless.sh` implement one
editor, opened from both `wifi/interfaces.js` and `wifi/mlo.js`:

- Fields: mode (AP/STA/adhoc), one radio (or two or more with MLO), network,
  SSID, encryption (open/WPA2/WPA mixed/WPA3/WPA2-WPA3 mixed/OWE), passphrase,
  hidden SSID, 802.11w, interface name, MAC/BSSID override, WDS, U-APSD, OCV,
  low-ACK disassociation and disabled.
- The stored passphrase is never sent to the browser; the inventory exposes
  only `has_key`, and a blank field keeps the existing key. A new WPA key must
  be 8–63 printable ASCII bytes; an SSID is limited to 32 UTF-8 bytes; the
  interface name is optional and, when set, at most 15 characters.
- The network must already exist; this editor does not create `network`
  sections. Additional network attachments are preserved when the primary
  network is not changed.
- MLO is AP or STA only, needs at least two distinct radios, writes `mlo=1`
  and switches the selected radios to an EHT htmode. A new standalone MLO
  interface gets a generated `mloN` section; the Mesh engine's `wifi_ap_mlo`
  is never touched. Mesh-owned sections and any 802.11s (`mode=mesh`) section
  are refused with `E-MESH-OWNED`.
- Write sequence: allowlisted RPC → validation → `radio_check` (errors block,
  warnings are returned) → operation lock → Wireless-scope backup → private
  0600 snapshot of `/etc/config/wireless` → UCI commit → Wi-Fi reload → bounded
  wait for the interface. Commit or verification failure restores the snapshot.
  The reply says `verified`, `config-only` (runtime name is driver-assigned) or
  `skipped` (interface disabled). Hardware behaviour is **待验证**.
- Modern mac80211 ignores an empty `ifname` and names the netdev itself, so the
  inventory resolves `runtime_ifname` from `ubus call network.wireless status`
  by section (`interfaces[*].section` / `interfaces[*].ifname`) and the views
  show that name; the edit form keeps the configured `ifname` so an edit never
  pins a driver-assigned name. Verification uses the runtime name: a delete is
  `verified` only when the section has left both netifd and UCI, and a save
  whose link is not up after the bounded wait is `config-only`, never
  `verified`. If a rollback cannot be restored, the reply names the retained
  recovery snapshot instead of claiming a successful restore.

### 4.2 Network conflict checks

`network.sh` answers the DESIGN §12 checks without writing UCI or restarting a
service. It returns `{ok, available, checks[], count, errors, warnings}`; each
finding has `code`, `severity`, `message` and `detail`. Overview and
Diagnostics → System render the same list through `utils/network.js`.

- Addressing: duplicate IPv4 addresses (`N-IP-01`), overlapping subnets
  (`N-IP-02`).
- DHCP: duplicate servers on one interface (`N-DHCP-01`), an active pool on a
  node/client (`N-DHCP-02`), `server_dhcp=0` with LAN DHCP still active
  (`N-DHCP-03`), or a server role with LAN DHCP disabled (`N-DHCP-04`). Pool
  outside its subnet (`N-POOL-01`) and overlapping pools (`N-POOL-02`).
  `start` and `limit` are read the way dnsmasq reads them: offsets from the
  network address (defaults 100 and 150), so the pool runs from
  `network + start` to `network + start + limit - 1`. The finding detail shows
  both the configured offset form and the derived subnet.
- DNS: resolver pointing at itself or loopback (`N-DNS-01`), `noresolv=1`
  without an upstream server (`N-DNS-02`).
- Bridging/routing: WAN using the LAN device (`N-BRIDGE-01`), a WAN device in
  the LAN bridge (`N-BRIDGE-02`), more than one default route (`N-ROUTE-01`).
- Firewall: network outside every zone (`N-FW-01`), `bat0` missing from the LAN
  zone on the server role (`N-FW-02`; nodes disable the firewall so the check
  does not apply to them), `bat0` in the LAN zone on a client
  (`N-FW-03`).
- Mesh wiring: `bat0` not bridged on server/node (`N-MESH-01`), bridged on a
  client (`N-MESH-02`), `mesh_batman` not attached to `bat0` (`N-MESH-03`),
  multiple 802.11s interfaces (`N-MESH-04`), an 802.11s interface outside
  `mesh_batman` (`N-MESH-05`), wired backhaul not attached (`N-MESH-06`).

Disabled network interfaces are skipped. Both the legacy swconfig bridge form
and the DSA `config device` form used by OpenWrt 21.02+ are recognised. These
are configuration-level findings: runtime reachability is not probed and the
UI says so.

### 4.3 Hybrid backhaul switching and priority

DESIGN §7.3 and §7.4 are implemented in `backhaul.sh` (switching) and
`mesh_apply_priority` in `mesh.sh` (priority).

- **Carrier is the signal.** A configured Ethernet netdev exists whether or not
  a cable is plugged in, so the monitor reads
  `/sys/class/net/<port>/carrier` and falls back to `operstate`. A missing
  device is `absent`; a readable device without either file is `unknown`, and
  an `unknown` sample keeps the previous state instead of inventing a
  transition. The wireless side is healthy only when BATMAN-adv has a direct
  neighbor or a selected originator over a wireless hardif.
- **Switching is runtime-only.** `backhaul_switch_to` calls
  `ubus call network.interface.mesh_wired up|down`; no UCI file is rewritten,
  so a failed switch cannot leave a broken saved configuration. When `batctl`
  is available the post-condition is verified on the bat0 hardif list for up to
  10 seconds, and a timeout is reported as a failure.
- **Debounce.** The first pass after boot only records the current medium.
  Ethernet → wireless requires the wired link to be down for
  `backhaul_switch_delay` (default 30 s); wireless → Ethernet requires it to be
  up for `backhaul_stable_time` (default 60 s), so a flapping cable restarts
  the timer. `backhaul_pref` selects the preferred medium (`ethernet` by
  default, `wireless` for an operator who wants the cable only as fallback).
- **State and diagnostics.** Sampling state lives in
  `/var/run/wifimanager/backhaul.state` (0600, replaced atomically); it is
  runtime state, not UCI. Successes append a `backhaul-switch` event, failures
  append `backhaul-switch-failed` and keep the previous medium so the next
  pass retries. The last error is exposed by `backhaul_status`.
- **Cooperation.** The monitor is idle unless `meshassistant.config.enabled`
  and `running` are 1 and `network.mesh_wired` is a `batadv_hardif`. It takes
  the operation lock only while switching, so a configuration apply and the
  monitor never move the same hardif at once. The init script runs it as the
  procd instance `backhaul` with a 5 s poll; `worker.sh backhaul_tick` performs
  one pass for scripts.
- **Priority.** `backhaul_priority=auto` (default) deletes
  `throughput_override` from `mesh_wired` and `mesh_batman`, leaving BATMAN-adv
  to measure the links; the kernel-negotiated Ethernet speed is a link rate,
  not usable throughput and is never copied into the option.
  `backhaul_priority=manual` writes `backhaul_wired_mbit` and
  `backhaul_wireless_mbit` as `<n>mbit`, and an empty or non-numeric value
  removes that side's override. The values are applied by `mesh_apply`, not by
  the monitor.

Runtime behavior on real hardware — carrier debounce under driver-specific
link events, bat0 hardif detach/reattach timing and switch convergence — is
**pending verification (待验证)**.

### 4.4 Mesh apply failure and rollback

DESIGN §6.4 requires an automatic rollback when a configuration change fails.
`mesh_apply` therefore works in this order:

1. Take the operation lock and publish `op.json`.
2. Create the durable pre-change backup (`backup_create_auto`); the backup id is
   reported in the event and the failure message.
3. Copy every file the apply may touch (`wireless network dhcp firewall
   meshassistant dawn`) into a private temporary snapshot under
   `/tmp/wifimanager-mesh.XXXXXX`. If the snapshot cannot be created, the
   operation fails before any change is made.
4. Run `mesh_apply_config`.
5. On failure, `uci revert` every file (so a staged but uncommitted write cannot
   be committed later by another path), copy the snapshot back with
   `restore_rollback`, reload config, network and Wi-Fi, finish the operation
   as `failed` with "the previous configuration was restored", and append
   `mesh-apply result failed rolled_back 1 backup <id>`.
6. On success, remove the temporary snapshot and continue to reload and verify.

The temporary snapshot is private to the operation and removed on both paths;
the durable backup remains for the operator. A rollback that cannot restore a
file is reported by `restore_rollback` exactly as in the restore pipeline. A
simulated failure path is covered by tests; a real commit failure on hardware
is **待验证**.

### 4.5 Advisory allocation and channel recommendation

Both features are read-only and keep their decision logic in the browser, so it
can be tested without hardware and recomputed without another RPC.

- `radio_advice_json` reports, per radio, `band`, `disabled`, `mesh_radio` and
  the enabled interfaces with `section`, `mode`, `mesh_owned` and `disabled`.
  `utils/radio.js advise(radios, {mode, device, mlo, section})` excludes the
  section being edited and produces a verdict per radio:
  `recommended` (`I-FREE`), `possible` (`W-USED`, `W-MESH`, `W-CONC-01/02/03`)
  or `avoid` (`E-ALLOC-03`, `E-ALLOC-04`). For MLO it suggests two usable radios
  on different bands and adds `W-SAME-BAND` when only one band is usable; with
  fewer than two usable radios it reports `E-ALLOC-02`. The editor renders the
  verdicts next to the radio list and recomputes them on every mode/MLO/radio
  change. It is strictly advisory: no checkbox changes, no save is blocked,
  and a failed call leaves the editor unchanged. The save path still runs
  `radio_check` (DESIGN §5.2).
- `channel_advice_json` validates the radio name, maps it to a phy and a
  running interface from UCI/netifd, and refuses with `E-INPUT`, `E-NOIFACE`,
  `E-NOPHY` or `E-SCAN` rather than guessing. Candidates come from
  `iw phy <phy> info` (skipping `disabled` and `no IR`, deduplicated by
  frequency); the scan uses `iwinfo <if> scan` on the known band and falls back
  to `iw dev <if> scan`, where frequencies are parsed directly; `iw survey dump`
  supplies the busy time of the in-use channel. `utils/channel.js rank()` scores
  each candidate against every visible cell within
  `(width + 20) / 2` MHz (signal weight 4/3/2/1, co-channel counted twice),
  adds a DFS penalty and the current utilization, and reports the assumed
  width. The Radios page requires a confirmation because the scan briefly
  takes a running AP off-channel; it labels the result a snapshot, marks DFS
  and shows the empty-scan case as no data. No value is written or applied.

## 5. Backup manager

`backup.sh` is the only writer of the backup store.

**Format.** Each archive contains `manifest.json`, `checksums.txt` and
`etc/config/<file>`. The manifest records `backup_format_version`, `id`,
`application`, `application_version`, `created_at`, `backup_type`,
`backup_scope[]`, `firmware{id,version,target}`, `hostname`, `description`,
`name`, `radios[{name,band,path}]`, `interfaces[]` (physical `/sys/class/net`
names only), `encrypted` and `files[]`. Legacy archives from
`/etc/meshassistant/backup` have a line manifest and are converted to a
`legacy` object in memory with format 0.

**Storage.** The configured directory must be an absolute path under `/etc`,
`/mnt`, `/media` or `/tmp`, without `..`, and must not be a symlink. A path
under `/mnt` or `/media` additionally needs a filesystem mounted at or above
it: `backup_mount_of` matches the path against `/proc/mounts` by longest prefix
and refuses the setting otherwise, so an unmounted directory cannot silently
receive archives on the internal flash. `backup_storage_json` reports the
configured directory, its mount point, filesystem and `external`/`writable`
flags, plus the `/`, `/tmp` and `/mnt`/`/media` candidates with free space. The
directory is created 0700; archives, checksums and temporary files are 0600.
Creation writes `.tmp.$$`, verifies it exists, then renames atomically.
Encryption uses `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt
-pass stdin`, with the password fed on standard input; a new passphrase must be
12–128 characters without control characters, and creation decrypts the result
and compares its SHA-256 with the plaintext before keeping the archive.
`backup_decrypt_file` falls back to the older PBKDF2 defaults so archives from
an earlier build still restore.

**Scopes.** `default_scope` maps Full/Wireless/Mesh/Roaming to the area lists in
`docs/04-BACKUP-DESIGN.md`; Custom uses the operator selection.
`backup_validate_scope` rejects unknown areas and combinations that would break
connectivity (MLO without Wireless, Mesh/Backhaul without Wireless and
Network). `files_for_scopes` resolves areas to configuration files and
de-duplicates them.

**Retention.** `backup_prune` applies age, count and size limits. Age-based
removal skips `*.enc` because an encrypted archive cannot be checked without its
password; count and size limits still apply. Legacy archives are never pruned.

**Import/export.** `backup_import` accepts only files under
`/tmp/wifimanager-upload`, rejects `..`, backslashes and symlinks, and refuses
legacy archives (`E-ID`). `backup_legacy_import` copies a legacy archive into a
new archive with a rewritten manifest; the original is not touched.
`backup_export_json` copies an archive into the fixed download directory so the
ACL can grant read access to that directory only.

## 6. Restore pipeline

`backup_restore_worker` is the only apply path:

1. Take the operation lock, publish `op.json`.
2. Read and delete the 0600 password file, if one was provided.
3. Resolve the id; extract with entry validation (regular files, `etc/config`
   prefix, no symlinks, no device nodes) and verify checksums.
4. Check the archive syntax: every managed file under `etc/config` must parse
   with `uci -c <dir> export`. A file that does not parse stops the restore
   before the snapshot, the pre-restore backup or any live change; `op.json`
   reports it and nothing is modified. `backup_validate_json` performs the same
   check, so the operator sees the problem before starting a restore.
5. Read `backup_type`, `backup_scope`; `backup_compat_warnings` reports a
   different firmware id/version/target, radio count, missing or renamed radios
   (band or PHY path) and absent physical interface names. Each finding is
   logged, counted and named in the final op message; `backup_validate_json`
   returns the same list as warnings and `backup_details_json` as
   `compatibility[]`, so the Restore page can show them before the
   acknowledgement checkbox. None of them blocks the restore by itself.
6. Create a snapshot directory and copy every known configuration file into it.
7. Create a full pre-restore backup. This is unconditional — there is no
   setting to disable it, because the in-memory snapshot lives in `/tmp` and
   does not survive a reboot. If the backup fails, stop before touching any
   configuration.
8. Apply the scope (`restore.sh`):
   - Full replaces each known file present in the archive.
   - Wireless restores the matching `wifi-device` radios (by section name, else
     by PHY path; mesh-owned, band-mismatched and unknown radios are skipped)
     and then replaces non-mesh interfaces, remapping each interface's `device`
     to the live radio name. An interface whose radio was skipped stays as it
     is.
   - Mesh/Legacy merges mesh-owned wireless sections, mesh network sections,
     DHCP/firewall Mesh rules and the Mesh Assistant Mesh/Backhaul options.
     Legacy also applies the Roaming options, which its older whole-file
     archives carried.
   - Roaming merges k/v/r options, replaces DAWN and merges the Mesh Assistant
     Roaming options.
   - Custom runs only the selected merges. A selected `roaming` area merges the
     Roaming options even without `dawn`, and a selected `dawn` area replaces
     the DAWN file and merges the roaming options even without `roaming`.
   - No scope replaces `/etc/config/meshassistant` whole. Its Mesh, Roaming and
     Backhaul options are merged by scope, and runtime bookkeeping
     (`running`, `*_state_saved`, `dumbap_*`, ...) is never restored.
9. Check the merged result again. A file that no longer parses (for example a
   whole-file copy inside a full restore) rolls the snapshot back, reloads and
   finishes `failed` with a `rolled-back` event.
10. Apply the restored configuration before verifying it: reload config, network
    and Wi-Fi, and when the restored files enable the mesh, run it through the
    same path as the Mesh Settings page so bat0, the mesh radio and DAWN exist
    even though the runtime was just replaced.
11. Verify runtime with bounded waits: the LAN address and a wireless interface
    when those layers were touched, hostapd when APs are configured, bat0 when
    the mesh is enabled, and DAWN when it is managed for this device.
12. On success remove the snapshot and finish `done`. On failure restore every
    snapshot file — deleting files the restore created — commit only files that
    exist, reload again, finish `failed` and record a `rolled-back` event.

The known-file list is `network wireless dhcp firewall system meshassistant dawn
wifimanager`. A restore never copies or replaces `/etc/config` as a directory.

## 7. Migration and coexistence

The migration from Mesh Assistant (DESIGN §15) is a state transition, not a
configuration copy: both packages read the same `meshassistant` UCI file, and
the migration only decides which program manages it. The state lives in
`wifimanager.settings` (`migration_pending`, `migration_confirmed`,
`migration_declined`, `migration_legacy_present`,
`migration_legacy_was_enabled`, `migration_old_valid`, `migration_new_valid`,
`migration_detected_at`, `migration_backup`,
`legacy_service_disabled`).

- `90-luci-wifimanager` creates the state directories and writes default
  options only where the option is absent; it is safe to re-run. When
  `/etc/config/meshassistant` exists it calls `worker.sh migrate_prepare`.
  A fallback block still disables and stops the legacy daemon if the worker is
  unavailable, so two managers never run at once, and it records
  `migration_pending=1` so the decision stays visible.
- `migration_prepare` follows DESIGN §15's order: check the installed
  configuration (`config_check_syntax`), create a full pre-migration backup,
  then disable and stop the legacy service and record the pending state plus
  `migration_legacy_was_enabled`. A failed backup or an invalid old
  configuration is recorded and shown on the card rather than hidden; the
  pending state is still recorded so the operator sees the decision. It is
  idempotent: once the operator has confirmed or declined, a re-run changes
  nothing. Installation does not overwrite or delete the Mesh Assistant
  configuration or its backups.
- The Overview page shows a "Migration from Mesh Assistant" card while
  `migration_pending=1`, with the detected time, the old configuration's
  validity, the legacy service state, the live bat0 state and the
  pre-migration backup id. It offers two explicit actions, each behind a
  confirmation dialog:
  - **Confirm migration** (`migration_confirm`) requires `confirm`, re-checks
    the current configuration syntax, waits up to 5 s for the legacy service to
    actually stop and refuses with `E-STATE` if it is still running, then
    records `migration_pending=0` / `migration_confirmed=1` /
    `migration_new_valid=1` together with `migration_checked_at` and
    `migration_mesh_running` (whether bat0 exists at that moment). The result
    message distinguishes "bat0 is up", "mesh enabled but bat0 missing" and the
    plain case, so a confirmed migration is never reported as a working mesh
    without evidence.
  - **Restore legacy service** (`migration_restore_legacy`) requires `confirm`
    and is refused with `E-STATE` while the WiFi Manager mesh is applied
    (`meshassistant.config.enabled=1` or `meshassistant.config.running=1`).
    Otherwise it re-enables and starts Mesh Assistant and records
    `migration_declined=1`.
- `Makefile`'s `postrm` re-enables the Mesh Assistant service only if WiFi
  Manager was the one that stopped it, and restores DAWN from its saved
  original when the marker exists.
- Legacy archives remain in `/etc/meshassistant/backup`; listing, validation
  and restore read them in place.

The install-time validation, pre-migration backup and state transitions are
covered by the test harness. Running the full coexistence sequence on real
firmware (1.0.0 plus Mesh Assistant 2.7.12 → 2.0.0, then uninstall) remains
**待验证**.

## 8. Diagnostics

`diagnostics.sh` returns independent sections so the UI never collapses
configuration, runtime, service and link state into one indicator:

- `wireless`: radios with configured/runtime values, interfaces, configuration
  checks and a note when a runtime value is unavailable.
- `mesh`: service state, `bat0` state, peers, hardifs, selected interfaces and
  checks for config/runtime mismatch and legacy service conflict.
- `system`: hostname, release, kernel, uptime, load, memory, services and
  IPv4 interfaces.
- `logs`: bounded tails of the WiFi Manager log, roaming events, DAWN log and
  syslog. The log page states which files may not exist yet.

**Unified diagnosis.** `utils/diagnosis.js` combines the `system` section, the
`network_check` findings, the mesh status and `roaming_advice` into one ranked
list without replacing the raw cards. It adds checks the individual pages do
not: load per CPU (`D-LOAD-01`), memory pressure from the kernel available
estimate (`D-MEM-01`), a core or auxiliary service enabled at boot but stopped
(`D-SVC-01`), a missing or down `bat0` while the mesh is active (`D-MESH-01`,
`D-MESH-02`), an active mesh with no peers (`D-MESH-03`) and the legacy service
running next to WiFi Manager (`D-MESH-04`). Network findings keep their codes
and severity; roaming findings are included with their advice wording. Every
finding carries its source and the raw values stay visible below the report.
The report is advisory, runs only on page load and refresh, and never blocks a
save or restore.

**Roaming advice and topology monitoring.** `roaming_advice` returns the
configuration facts and per-band station-signal samples; `utils/roaming-advice.js`
classifies them (k/v/r, mobility domain, BSSID validity and uniqueness,
per-SSID authentication consistency, DAWN state/watchdog, threshold pairs,
sample statistics) and is rendered on the Roaming settings page. The key is
never returned: the backend assigns each distinct key an opaque group index and
the comparison only sees whether the indices match.
`utils/topology.js` groups announcement rows into devices, derives a node state
(normal, weak signal below −75 dBm for a wireless-only node, offline after 120 s
without an announcement), and reports stale, memory-heavy, weakly backhauled or
incomplete nodes, duplicate hostnames and a LAN MAC announced by two different
devices on the mesh topology page. The topology page renders one row per device
with its node state, MAC address, node role, CPU load and WiFi channel (with
band) in addition to memory, clients, backhaul, link status, signal and rate; the
values come from the peer announcement and the local `linkinfo` line, and a value
that was not announced stays empty. The peer cache drops a silent node after
five minutes, so the offline state cannot outlive it. `utils/mesh.js` reads the
cache with that same five-minute window and gives each announcement-only row the
age of its newest announcement as `lastSeen`; a silent device is therefore shown
offline before the cache drops it instead of vanishing without a trace. A device
present in `batctl n` keeps the direct link's last-seen value.
Both are pure classification layers over read-only data; neither writes UCI.

## 9. Localization

Views use `_()` for every user-facing string. Menu titles are extracted with the
view strings into `po/templates/luci-app-wifimanager.pot`; the Simplified
Chinese catalog is `po/zh_Hans/luci-app-wifimanager.po`. The product name is
`WiFi Manager` in English and `WiFi管家` in Chinese; `WiFi管理` is not used. UCI,
RPC, ACL, package and code identifiers stay ASCII and unchanged. Untranslated
entries fall back to English.

## 10. Tests

`tests/run.js` loads the suites `wifi`, `wireless`, `mlo`, `network`, `mesh`,
`backhaul`, `roaming`, `diagnosis`, `backup`, `restore`, `migration`, `i18n` and
`package`.

`tests/lib.js` turns a LuCI module into a function with Node's `vm`: leading
`'require ...'` lines become `__require()` calls, `baseclass` and
`wifimanager.utils.*` are provided, and `String.prototype.format` is polyfilled.
The tests therefore exercise real parsing and validation code, plus source
contracts that matter for safety:

- menu ↔ view path coverage and the 20-leaf guarantee;
- ACL ↔ rpcd ↔ `rpc.js` method consistency and read/write separation;
- backup permissions, atomic writes, prune behavior and legacy read-only rules;
- backup shell simulations (DESIGN §17.5): the real modules are sourced and run
  with `sh` against fixtures, covering a damaged archive (checksum mismatch) and
  an archive with unknown entries, which are both refused before any restore
  with no temporary directory left behind; a creation on a full filesystem that
  returns failure without disturbing existing archives or leaving temp files;
  and pruning by count, size and age that removes the matching `.sha256` files,
  skips `.enc` archives for the age rule, is idempotent and never orphans a
  checksum;
- restore confirmation, password-file handling, snapshot order and rollback;
- restore syntax checks: the archive is checked before the snapshot and the
  pre-restore backup, a merged result that does not parse is rolled back, and
  validation reports archive syntax errors;
- scoped restore policies run against a flat-file `uci` stub: radios are matched
  by name or PHY path, interfaces follow a renamed radio, interfaces on skipped
  radios are left alone, mesh radios and mesh interfaces keep their settings,
  and `meshassistant` restores only the options of the selected scope while
  leaving runtime bookkeeping untouched;
- mesh apply rollback: the snapshot is taken before the apply, a failed apply
  reverts staged UCI, restores the snapshot, reloads and reports the failure,
  and a snapshot that cannot be created stops the apply before any change;
- roaming apply transaction: backup before snapshot before apply, the snapshot
  covers `wireless`, `dawn` and the takeover files/service state, a failed
  commit or DAWN start rolls back and reports failure, a DAWN that does not
  start finishes unverified, and the engine sources the shared Backup Manager;
- restore compatibility: firmware, radio count, radio band/path and interface
  names are collected into validation warnings and `compatibility[]`, shown by
  the Restore page, and logged and counted by the restore worker;
- migration: preparation validates and backs up before stopping the legacy
  daemon and records a pending decision, confirmation requires explicit
  approval and clears pending, restoring the legacy service is refused while
  the mesh is enabled, the install script calls the worker and keeps its
  fallback, and the RPC, ACL and Overview page expose the confirmation step;
- no `fs.exec`, `child_process`, `eval` or non-`wifimanager`/`iwinfo` ubus
  objects in views;
- JSON validity, `node --check` for every view/util and `sh -n` for every shell
  script;
- catalog coverage: every `_()` string is in the pot, menu titles are
  translatable, and the Chinese product name is correct;
- `wireless` suite: draft validation (radio count, MLO, SSID bytes, key,
  collisions, no stored key in the browser) and backend contracts (radio check,
  backup, snapshot, commit, rollback, mesh-owned refusal, no key logging,
  netifd runtime-name mapping, delete verification against netifd and UCI);
- `wifi` suite: radio allocation advice (free/possible/avoid, section
  exclusion, MLO pair, same-band and not-enough-radio cases) and channel
  ranking (band filtering, overlap weights, DFS penalty, current utilization,
  empty scan and keep-current), plus source contracts that `radio_advice` and
  `channel_advice` are read-only, ACL-granted for read only, and wired through
  the editor and the Radios page;
- `network` suite: every finding code, read-only source and RPC/ACL grant, DSA
  bridge detection, disabled interfaces and DHCP offsets/defaults;
- `diagnosis` suite: roaming advice rules (threshold pairs, mobility domains,
  r/k/v flags, DAWN watchdog, sample statistics and the five-client minimum),
  topology grouping and findings (stale, memory, weak wireless-only backhaul,
  duplicate hostname, empty mesh), and diagnosis aggregation (load/memory/
  service severity, network code retention, mesh runtime, roaming wording,
  ordering and counts);
- `backhaul` suite: runtime-only switching (netifd calls, no UCI writes),
  carrier-based detection, debounce configuration, switch and failure events,
  automatic/manual priority, worker/init wiring, read-only `backhaul_status`
  grant (read ACL only) and every switching/priority form field. A shell
  simulation with stub `uci`, `ubus`, `batctl` and clock validates: no switch
  before the fallback delay, a flapping cable restarting the timer, the switch
  after the delay, restore only after the stability time, a failed switch
  keeping the medium and recording the error, the lock blocking a switch, and
  the monitor staying idle when the mesh is not applied or automatic switching
  is off.

## 11. Deferred verification

The core is implemented at source level. Hardware-dependent behavior is marked
**pending verification (待验证)** in the READMEs: installing, uninstalling and
upgrading the produced packages on a real device, driver-specific MLO/6 GHz/
320 MHz support, mesh throughput and convergence, wpad 802.11v with DAWN, and
the full upgrade/rollback path from 1.0.0 and Mesh Assistant 2.7.12. The
compile itself is no longer deferred: the package was built with the OpenWrt
24.10.8 SDK (opkg, .ipk) and the 25.12.5 SDK (apk, .apk), and each artefact's
dependencies, file list, executable bits and conffiles declaration were
checked (`/etc/config/wifimanager` is a conffile).
The wireless editor and the network conflict checks are covered by the test
harness and by a shell simulation with fixture configurations, but their
runtime effects (interface appears, rollback on a real reload, driver-assigned
names) still need verification on hardware. The same applies to automatic
backhaul switching: the decision logic, debounce, lock and failure handling are
covered by a shell simulation, while carrier events on real drivers, the
netifd detach/reattach latency and BATMAN-adv convergence after a switch are
**待验证**. The same applies to the P2 additions: the roaming advice and
topology monitoring rules are tested against fixture JSON, but real station
signal sampling, announcement freshness under clock skew and the chosen
thresholds need observation on a running mesh; external storage discovery is
tested against a fixture mount table, while the actual mount layout of the
target router is **待验证**; and encryption is exercised through source
contracts only, so PBKDF2, the decrypt fallback and the round-trip check must
be confirmed on the OpenSSL build the firmware ships. The roaming apply
transaction is covered by source contracts; a commit failure and a DAWN start
failure on real hardware still need to be induced. The restore compatibility
warnings are derived from `ubus call system board`, UCI and `/sys/class/net`,
so their wording on a mixed-hardware fleet is **待验证**.

The release gate is tracked item by item, with the commands, expected results
and evidence to record, in `docs/06-RELEASE-VERIFICATION.md`. Nothing in this
document closes a hardware gate by itself.
