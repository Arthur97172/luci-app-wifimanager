# 04 — Global Backup & Restore Design

## 1. Position in the product

Backup & Restore is a top-level menu (`admin/network/wifimanager/backup`) with four
pages: Overview, Create Backup, Restore, Settings. It is not part of Mesh and there
is no second backup implementation. `mesh_apply`, `mesh_disable`, dumb-AP changes,
restore itself, and the Wireless form (when auto backup is enabled) all call the
same `backup_create`.

## 2. Storage

```text
/etc/wifimanager/backup/                 (0700)
    wifimanager-20261112-100000.tar      (0600)
    wifimanager-20261112-100000.tar.sha256   (0600, optional sidecar)
    wifimanager-20261112-100000.tar.enc         (0600, encrypted archive)
    wifimanager-20261112-100000.tar.enc.sha256  (0600)
    wifimanager-20261112-100000.tar.enc.meta.json (0600, manifest copy)
    .tmp.XXXXXX                          temporary, never listed
/etc/wifimanager/config/                 dawn.orig, ownership originals
/etc/wifimanager/logs/                   wifimanager.log, roaming-events.jsonl
```

- Path is configurable (`backup.path`) but must match
  `^/(etc|mnt|media|tmp)/[A-Za-z0-9._/-]+$`, must not contain `..`, must not be a
  symlink, and must be writable. Default: `/etc/wifimanager/backup`.
- Mount awareness: a path under `/mnt` or `/media` is accepted only when a
  filesystem is actually mounted at that path or at one of its parents. The
  mount is resolved from `/proc/mounts` by longest prefix, so an unmounted
  directory cannot silently receive archives on the internal flash. The
  settings page lists usable mounts (`/`, `/tmp`, `/mnt/*`, `/media/*`) with
  filesystem, free space and writability, marks `/tmp` as lost on reboot, and
  copies a suggested path into the field without saving it.
- Status: `backup_status` reports the configured directory, its mount point,
  filesystem and `external`/`writable` flags next to the counts and free space.
- Creation: build in `<path>/.tmp.$$`, `tar`, compute checksums, write manifest,
  `sync`, `mv` to final name, `chmod 600`. A failure removes only the temp files.
- Budget: retention is enforced on both sides of creation. `backup_prune` runs
  before writing, so the archive about to be created fits and the free-space
  check sees the space the limits are about to free; it runs again after the
  archive is in place, now counting the new archive, so the store never exceeds
  `max_count`, `max_size_mb` or `retention_days`. If that second pass removes
  the new archive itself, creation is reported as failed instead of leaving a
  store over its limit. The free-space check needs `(current size + 2 MiB)`
  free and fails before anything is written.
- Unique id: timestamp name; same-second collisions get `-1`, `-2` …; the id is the
  basename, and `manifest.id` must equal it.

## 3. Archive format (format version 1)

```text
manifest.json
checksums.txt            "<sha256>  etc/config/<file>" per file
etc/config/network       (only the files in scope)
etc/config/wireless
etc/config/dhcp
etc/config/firewall
etc/config/system
etc/config/meshassistant
etc/config/dawn
etc/config/wifimanager
```

`manifest.json`:

```json
{
  "backup_format_version": 1,
  "id": "wifimanager-20261112-100000.tar",
  "application": "luci-app-wifimanager",
  "application_version": "2.0.0",
  "created_at": "2026-11-12T10:00:00+08:00",
  "backup_type": "full",
  "backup_scope": ["wireless","mlo","mesh","backhaul","roaming","dawn","network","dhcp","firewall","system","wifimanager"],
  "firmware": { "id": "OpenWrt", "version": "24.10.0", "target": "mediatek/filogic" },
  "hostname": "openwrt",
  "description": "Full WiFi Manager backup",
  "radios": [ { "name": "radio0", "band": "2g", "path": "platform/soc/.../mmc1:0001:1" },
              { "name": "radio1", "band": "5g", "path": "pci0000:00/0000:00:00.0" } ],
  "interfaces": ["lan1", "lan2", "wan"],
  "encrypted": false,
  "files": ["etc/config/network", "etc/config/wireless"]
}
```

`radios[].path` is the UCI PHY path and `interfaces` lists physical
`/sys/class/net` names only (bridges, VLANs, `bat*`, `wlan*` and other overlay
devices are recreated from the configuration and are omitted), so a restore on
other hardware can report renamed radios and ports.

No secrets are copied into the manifest; file contents carry the keys, protected by
0600. Logs record ids, sizes and scopes, never values.

## 4. Types and scopes

| Type | Default scope | Files | Restore policy |
|---|---|---|---|
| `full` | all areas | all listed existing configs | replace each file, only files present in the archive |
| `wireless` | wireless, mlo | wireless | restore matching `wifi-device` radios, then replace non-mesh interfaces; keep current mesh-owned sections |
| `mesh` | mesh, backhaul | wireless, network, dhcp, firewall, meshassistant | merge: replace mesh-owned wireless sections; network only `bat0`/`mesh_batman`/`mesh_wired` + lan bridge port membership; dhcp lan options; firewall mesh rules; meshassistant Mesh and Backhaul options only |
| `roaming` | roaming, dawn | wireless, dawn, meshassistant | merge roaming options on AP sections; dawn whole file; meshassistant Roaming options only |
| `custom` | user selection | union of area files | each area merged with the policy of its most specific scope |
| `pre_restore` | full | all | internal safety copy, listed but restore allowed with confirmation |
| `legacy` | mesh | old archive | mesh merge policy; never overwritten, never deleted |

Area → file mapping:

```text
wireless, mlo        -> wireless
mesh, backhaul       -> wireless, network, dhcp, firewall, meshassistant
roaming, dawn        -> wireless, dawn, meshassistant
network              -> network
dhcp                 -> dhcp
firewall             -> firewall
system               -> system
wifimanager          -> wifimanager
```

There is no separate MLO backup type. The `wireless` type always includes the
`mlo` area, so the "MLO Backup" called for in DESIGN §17.5, §18 and §22 is the
Wireless type; the Create form labels it "Wireless (includes MLO)" so the
mapping is visible instead of implied. The backend accepts exactly the five
types `full|wireless|mesh|roaming|custom`.

Dependency check for `custom` (enforced by `backup_validate_scope` and mirrored
by the Create form; advisory findings come from `backup_scope_warnings` and are
shown by the Create page before the archive is made):
- `mlo` without `wireless` → error.
- `mesh`/`backhaul` without `network` and `wireless` → error (would restore mesh
  sections referencing a missing bat0 or radio).
- `roaming` without `wireless` → error.
- `dawn` without `roaming` → warning. The DAWN area archives `wireless`, `dawn`
  and `meshassistant`; a restore merges the wireless roaming options and
  replaces the DAWN file, so a DAWN-only selection still changes `wireless`.
- `dhcp`/`firewall` without `network` → warning. Those files are replaced, but
  the interfaces they refer to are not part of the archive.

## 5. Mesh-owned section detection (used by merge policies)

A `wifi-iface` section is mesh-owned when any of:
- section name matches `mesh_radio[0-9]*`, `wifi_ap_*`, `mesh_*`;
- option `mesh_id` is set;
- option `network` contains `mesh_batman`.

`network` sections owned by mesh: `bat0`, `mesh_batman`, `mesh_wired`, plus the
`ports` list of the LAN bridge device (restored only if the archive contains the
exact port and it is not also used by another non-LAN bridge).

`dhcp`: only the `lan` section options `ignore`, `ra`, `dhcpv6`, `dns`, `dhcp_option`
are restored for mesh scope.

`firewall`: only sections named `meshassistant_lan_wan`, plus membership of
`bat0`/`mesh_batman` in any zone's `network` list.

## 5.1 Radio restore (Wireless and Custom wireless)

`wifi-device` sections are restored by `merge_wireless_radios` before the
interfaces, because a Wireless backup carries the channel, width and power that
belong to each radio (DESIGN §10.3 B). The file name of a radio is not stable
across firmware versions, so each archived radio is matched in this order:

1. a live radio with the same section name whose PHY `path` is empty or equal;
2. otherwise, a live radio with the same PHY `path` (this handles `radio0` and
   `radio1` swapping places);
3. otherwise the radio is skipped and reported.

A radio is also skipped when it carries a mesh interface in the archive or in
the live configuration, when the archived and live `band` disagree, or when the
section cannot be copied. Skipped radios keep their live settings; the Mesh
scope is the only one that may change a mesh radio.

The restored radio is recorded in an archive→live map (`WM_RADIO_MAP`). Each
non-mesh interface's `device` option is then translated through that map, so an
interface follows its radio when the section was renamed. An interface whose
radio was skipped is not restored, which keeps an AP from landing on a radio
that now serves another band. An archived radio without a `path` keeps the live
PHY path, so an old archive cannot unbind a radio from its hardware.

## 5.2 `meshassistant` scope merge

`/etc/config/meshassistant` holds the Mesh, Roaming and Backhaul settings in one
section, so restoring it whole would roll back one scope while restoring
another. `merge_meshassistant_scope` classifies every option:

- Mesh: `enabled`, `role`, `server_dhcp`, `dhcp_dns`, `wifi_id`, `wifi_radio`,
  `mlo`, `ssid_mode`, `apRadio`, `mesh_id`, `encryption`, `key`, `wifi_id_*`,
  `spectrum_*`;
- Roaming: `kvr`, `ft`, `mobility_domain`, `ft_over_ds`, `rssi_val`,
  `low_rssi_val`, the `dawn_*` options, `rssi_val_*`, `low_rssi_val_*`;
- Backhaul: `wired_backhaul*`, `backhaul_*`, `ipmode`, `ipaddr`, `netmask`,
  `gateway`, `dns`, `hostname`.

For the selected scopes it first removes live options the archive does not
contain (so the restored scope matches the archive) and then copies the archived
options, list-valued ones included. Unclassified options are runtime state
(`running`, `*_state_saved`, `lan_watchdog_pending`, `dumbap_*`,
`wired_backhaul_restore_port`, `ap_mode_enabled`, `ap_radios_managed`,
`svc_disabled_*`, ...); they are never restored, so a restore cannot make the
engine believe a service is running or a snapshot is pending.

A `legacy` archive was taken when the file belonged to the Mesh Assistant
project, so its restore applies all three scopes to preserve the old behaviour.

## 6. Restore pipeline

```text
backup_restore(id, confirm)
  └─ validate id, archive type, manifest, format version, checksums,
     entry whitelist (no absolute paths, no `..`, no symlinks/devices)
  └─ compatibility: application, format version <= 1, then warnings for a
     different firmware id/version/target, a different radio count, missing or
     renamed radios (band or PHY path), and physical interface names that no
     longer exist on this device (DESIGN §10.7). Warnings are returned by
     `backup_validate` and `backup_details`, shown before the confirmation
     checkbox and repeated in `backup_restore`'s log and op message; they never
     block a restore by themselves
  └─ syntax: every managed file under etc/config must parse (uci export)
  └─ compute scope and the exact files/sections to change, store as a plan
  └─ detached worker (run lock):
       0. re-check the archive syntax; a file that does not parse stops here
          with "Nothing was changed" before anything is touched
       1. snapshot every touched file to /tmp/wifimanager-restore.XXXX/
       2. create the pre_restore backup (full) — always, never optional;
          fail with "nothing was changed" if it cannot be created
       3. apply the plan (file replace or section merge), uci commit per file
       4. re-check the merged result: a file that no longer parses restores
          the snapshot, reloads and fails with a rolled-back event
       5. apply the restored configuration: reload_config, network reload,
          wifi reload; when the restored files enable the mesh it is applied
          through the same path as the Mesh Settings page, so bat0, the mesh
          radio and DAWN match the restored files instead of the runtime that
          was just replaced
       6. verify runtime, not just syntax: LAN interface up within 90 s; if
          wireless was touched, at least one radio up and hostapd running when
          APs are configured (20 s grace); bat0 present within 20 s when the
          restored config enables the mesh; DAWN running within 20 s when it is
          managed for this device
       7. success -> op done, verified=true
          failure -> restore the snapshot files, deleting files the restore
                     created, uci commit only the files that exist, reload,
                     op failed, rollback=true, message names the failing step
```

UI shows the restore scope (files and areas) before the confirmation checkbox; the
confirmation text warns that a wrong config can require LAN/console recovery.
Legacy archives: same pipeline, `backup_type=legacy`, merge policy `mesh`.

## 7. Legacy compatibility

- Legacy archives are discovered in `/etc/meshassistant/backup/*.tar` and shown in
  the Restore list with type `legacy`, creation time/hostname/LAN/role from their
  line manifest.
- They are validated with the old whitelist (manifest + six known configs) and with
  the same symlink/entry checks.
- Restore uses the mesh merge policy, so a legacy restore does not clobber unrelated
  Wireless/MLO/network changes.
- `backup_legacy_import` copies an archive into the new store and writes a converted
  `manifest.json` (format 1, type `legacy`, scope mesh); the original stays where it
  is. Nothing is deleted during migration or import.

## 8. Settings (`/etc/config/wifimanager`)

```text
config backup 'backup'
    option enabled '1'            # automatic backups on/off
    option frequency 'before_change'  # before_change | daily | weekly | manual
    option max_count '10'
    option max_size_mb '64'
    option retention_days '0'     # 0 = keep by count/size only
    option path '/etc/wifimanager/backup'
    option legacy_enabled '1'
    option encrypt_default '0'    # preselects encryption on the Create page only
```

`require_pre_restore` is no longer a setting: every restore creates its full
pre-restore archive unconditionally, and `backup_settings_set` rewrites any
stored `require_pre_restore=0` back to `1` so an upgrade cannot keep restores
unprotected. The in-memory snapshot is not durable (it lives in `/tmp` and does
not survive a reboot), so the archive is the copy that remains; a restore that
cannot create it aborts before touching any configuration.

The `init.d/wifimanager` worker ticker calls the backup timer about once a
minute (every fourth 15 s pass) when frequency is `daily`/`weekly`, checks the
newest `auto` backup age, and creates one when due.
`before_change` is not a timer: it means “create before every apply/restore”, which
the workers already do.

Every automatic creation (timer, pre-change or pre-restore) records its outcome
in `runtime/last-auto-result` (`result=success|failure`, `time`, the fixed
`description`, and the archive id on success, mode 0600). `backup_status`
returns it as `auto_result`, `auto_result_time` and `auto_result_description`;
the Overview shows a Succeeded or Failed badge with the time and the operation
name, and a failure also raises a warning card. `runtime/last-auto` keeps its
old meaning — the last successful timer run used to decide when the next daily
or weekly backup is due — so a failure is retried on the next tick and is never
mistaken for a successful backup.

## 9. Upload / download / encryption

- Download: `backup_export` copies the archive into `/tmp/wifimanager-download/`
  with owner-only permissions, then LuCI `cgi-download` serves it with the session
  id. The ACL `file.read` is limited to `/etc/wifimanager/backup/*` and
  `/tmp/wifimanager-download/*`; legacy archives are imported as a copy by the
  backend instead of being read directly. Before the download the UI shows the
  warning that the archive contains Wi-Fi passphrases and the mesh key in clear
  text and must be kept private.
- Upload: the browser posts to `/cgi-bin/cgi-upload` into `/tmp/wifimanager-upload/`
  (ACL write limited to that directory, 16 MiB cap enforced by the backend), then
  `backup_import` re-validates the tar and moves it into the store atomically. The
  upload is always named `upload.tar`, so the backend decides the stored id from
  the uploaded name (when valid), then the manifest id, then a fresh timestamp.
  An encrypted upload cannot be listed by `tar`; the backend answers `E-PASS`,
  the UI asks for the passphrase and retries `backup_import` with it. The
  passphrase travels in a 0600 file so it never appears in the process list.
- Independent permission scope: backup reads and writes live in the separate
  `luci-app-wifimanager-backup` ACL scope. An administrator can be granted the
  backup pages without the wireless/mesh write methods, and the main scope holds
  no backup method and no direct file access. The four Backup menu entries and
  their group depend on `luci-app-wifimanager-backup` alone; the section root
  has no ACL dependency, so either scope alone reaches the pages it may use.
- Change indicator: the backup overview compares the current in-scope files with
  the newest unencrypted, intact backup and reports changed/unchanged/unknown per
  file. It is a comparison of file content hashes, not a claim that the running
  system matches the configuration.
- Encryption (optional): when a passphrase is supplied and `openssl` exists, the
  archive is written as `<id>.tar.enc` with AES-256-CBC and PBKDF2-SHA256
  (200000 iterations, random salt); the manifest stays inside the encrypted
  payload and the id suffix marks it. `openssl-util` is a package dependency.
  Restore prompts for the passphrase; failure to decrypt aborts before touching
  config.
- Encrypted listing: the list cannot read the ciphertext, so creation writes a
  copy of the manifest to `<id>.meta.json` (0600) beside the archive. The list
  reads that sidecar; an encrypted archive from an older build without one is
  still listed with blank metadata and its file time, so it can be validated,
  restored, downloaded or deleted. Delete and every prune rule remove the
  archive, its checksum and its sidecar together; encrypted archives age out by
  their modification time like plain ones.
- Passphrase policy: 12–128 characters, no control characters, confirmed twice
  in the UI. It is read from the RPC request, fed to `openssl` on standard
  input and never written to a file, the manifest or the log. `backup_details`
  reports only that an archive is encrypted, never the passphrase.
- Verification: after encrypting, creation decrypts the new archive and compares
  its SHA-256 with the plaintext. A mismatch removes the half-written archive
  and fails the operation, so a broken or ancient OpenSSL build cannot yield an
  archive that looks valid but can never be restored.
- Compatibility: decryption first tries the current parameters and then the
  older PBKDF2 defaults, so archives created by an earlier 2.0.0 build still
  restore. **待验证** on the target OpenSSL build for both paths.
- Default: `encrypt_default` only preselects the checkbox on the Create page;
  it never rewrites existing archives and never changes the restore path.

## 10. WiFi Manager Backup and OpenWrt Sysupgrade Backup

These are two separate mechanisms and the product does not merge them
(DESIGN §10.11):

- **WiFi Manager Backup** stores the configuration files of the selected scope
  (`network`, `wireless`, `dhcp`, `firewall`, `system`, `meshassistant`, `dawn`,
  `wifimanager` — see §4). It is validated, restored and rolled back by WiFi
  Manager. A restore replaces or merges only those files, can restart the
  network, and can make the management page unreachable while it runs. Even a
  Full backup is a configuration archive, not a system image.
- **OpenWrt Sysupgrade Backup** (System → Backup / Flash Firmware) covers the
  whole system configuration and the files listed in `/etc/sysupgrade.conf`, and
  is applied by the firmware during an upgrade. WiFi Manager neither creates nor
  replaces it and never writes `/etc/sysupgrade.conf`.

The Overview, Create and Restore pages state this distinction in a dedicated
card, and the Create page notes that a Full backup is limited to the files WiFi
Manager knows about. The description entered on the Create page is stored in the
manifest and shown in the Overview and Restore lists, in the details dialog and
in the restore confirmation.

## 11. Tests

`tests/backup.test.js` and `tests/restore.test.js` exercise the pure decision layer
(scope → files, policies, id validation, manifest checks, legacy detection,
retention) in Node against fixtures; `tests/scripts.test.js` runs `bash -n` and
drives `wm_call` with a fake `uci`/`jsonfilter` environment where feasible.
`tests/restore.test.js` also concatenates the backend modules and runs the
scoped policies against a flat-file `uci` stub, covering radio matching by name
and PHY path, interface `device` remapping, skipped radios, and the
`meshassistant` scope merge with its runtime-state exclusions. Hardware restore
paths remain **待验证**.
