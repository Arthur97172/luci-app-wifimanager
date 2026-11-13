# 02 — Architecture Design (2.0.0)

## 1. Layers

```text
LuCI views (one file per menu node)
    overview · wifi/* · mesh/* · roaming/* · backup/* · diagnostics/*
                       |
             wifimanager/utils/*  (rpc, uci, radio, channel, validation, backup,
                                  mesh, format, wireless, wireless-form, network)
                       |
              ubus object "wifimanager"
                       |
        /usr/libexec/rpcd/wifimanager   (thin protocol shim)
                       |
   common.sh · capabilities.sh · radio.sh · channel.sh · wireless.sh · network.sh
   mesh.sh · roaming.sh · apscan.sh · backhaul.sh · restore.sh · diagnostics.sh
   backup.sh · migration.sh · peer.sh · worker.sh
                       |
      OpenWrt: uci · netifd · ubus · iwinfo · batctl · iw · hostapd/DAWN
```

The frontend never executes commands. Every state-changing action is a validated
ubus method; every runtime read is either a typed ubus method or an existing
read-only system object (`iwinfo`, `luci-rpc`, `network.interface`, `service`).

## 2. ubus API

Registered by `/usr/libexec/rpcd/wifimanager`. Every method returns JSON with
`ok: true|false`; failures carry `error` (machine code) and `message` (human text,
English msgid for translation). Ids and paths are validated before use.

### Read

| Method | Arguments | Returns |
|---|---|---|
| `status` | – | product/version, mesh state, radio count, backup summary, operation state |
| `radio_inventory` | – | radios (name, band, phy, channel, htmode, txpower, disabled, runtime), interface usage, conflicts; each interface also carries `runtime_ifname` resolved from netifd |
| `radio_check` | `{mode, device[], mlo, section}` | conflict list (error/warning/info) |
| `radio_advice` | – | read-only allocation facts: each radio's band, disabled/mesh state and enabled interfaces (`section`, `mode`, `mesh_owned`, `disabled`); the verdicts are computed in `utils/radio.js` |
| `channel_advice` | `{radio}` | driver candidates (`channel`, `freq`, `band`, `dfs`), one scan snapshot (`cells`: `freq`, `signal`), configured width, current channel and busy time; never writes and never scans without being called |
| `network_check` | – | configuration-level DHCP/DNS/IP/route/firewall/mesh findings |
| `roaming_advice` | – | roaming configuration facts (k/v/r flags per `wifi_ap_*` interface, mobility domains, DAWN state and thresholds) and per-band station-signal samples; the findings and suggestions are computed in `utils/roaming-advice.js` |
| `backup_list` | `{include_legacy}` | new + legacy archives with metadata |
| `backup_details` | `{id}` | manifest, file list, size, compatibility, validation |
| `backup_validate` | `{id}` | `valid`, `errors[]`, scope, checksums result, UCI syntax of the archive |
| `backup_status` | – | settings, count, bytes, free space, mount point, filesystem, `external`/`writable` flags, last backup, auto state |
| `backup_settings_get` | – | settings, including `encrypt_default` |
| `backup_storage` | – | mount table facts: configured directory, its mount point and filesystem, and candidate mounts (`path`, `suggested`, `device`, `filesystem`, `free_kb`, `external`, `volatile`, `writable`); read-only, never creates a directory |
| `migration_status` | – | legacy presence, pending/confirmed/declined, old-config validity, pre-migration backup, `mesh_running` (bat0 present after confirmation) and `checked_at` |
| `backhaul_status` | – | selected and available backhaul media, link speeds, automatic-switching state |
| `mesh_status` | – | `linkinfo`, `peers`, `neighbors`, `originators`, `clients`, `roaming` raw text for `utils/mesh.js` |
| `mesh_events` | `{limit}` | recent roaming/mesh events (JSONL) |
| `diagnostics` | `{section}` | `wireless` \| `mesh` \| `system` \| `roaming` |
| `logs` | `{name, lines}` | bounded log tail |
| `op_status` | – | current/last background operation |

### Write

| Method | Arguments | Notes |
|---|---|---|
| `backup_create` | `{type, scope[], name, description, password?}` | synchronous; atomic temp+rename |
| `backup_delete` | `{id}` | new-format only; legacy archives are never deleted |
| `backup_restore` | `{id, confirm:true}` | starts detached worker: unconditional full pre-restore backup, scoped apply, runtime apply of the restored mesh, hostapd/bat0/DAWN verification, rollback (including removal of files the restore created) on failure |
| `backup_settings_set` | settings object | validated, path whitelist |
| `backup_import` | `{path, password?}` | only `/tmp/wifimanager-upload/*`, re-validated; encrypted uploads need the passphrase |
| `backup_legacy_import` | `{id}` | copies a legacy archive into the new store with a converted manifest; original untouched |
| `migration_confirm` | `{confirm:true}` | validates the current configuration, records the switch, clears pending |
| `migration_restore_legacy` | `{confirm:true}` | re-enables Mesh Assistant; refused while the WiFi Manager mesh is enabled |
| `wireless_iface_save` | interface object | validated create/update; radio check, Wireless backup, snapshot, commit, reload, rollback |
| `wireless_iface_delete` | `{section, confirm:true}` | backup, commit, reload, rollback |
| `mesh_apply` | – | detached worker (`mesh.sh`), pre-change backup, private snapshot and automatic rollback on failure, verify |
| `mesh_disable` | – | detached worker |
| `mesh_dumbap` / `mesh_undumbap` | – | detached worker |
| `roaming_apply` | – | detached worker: pre-change Roaming backup, private snapshot, apply k/v/r + DAWN, verify DAWN, rollback on failure |

Long operations write `/var/run/wifimanager/op.json` atomically and append to
`/etc/wifimanager/logs/wifimanager.log`; the UI polls `op_status` and never hides a
failure behind a page reload.

## 3. Config ownership

| File | Owner | Notes |
|---|---|---|
| `/etc/config/wireless` | shared | interfaces page edits operator sections; the mesh engine alone edits `mesh_*`, `wifi_ap_*`, `wifi_ap_mlo` and any section carrying `mesh_id`; single run lock |
| `/etc/config/network` | shared | mesh engine edits `bat0`, `mesh_batman`, `mesh_wired`, lan bridge ports, node LAN |
| `/etc/config/dhcp` | shared | mesh engine edits `lan` options only |
| `/etc/config/firewall` | shared | mesh engine adds `bat0` to the lan zone, `meshassistant_lan_wan` forwarding |
| `/etc/config/system` | shared | hostname on node/client roles |
| `/etc/config/dawn` | conditional | managed by `roaming.sh` with marker `dawn.wifimanager-managed` and original saved at `/etc/wifimanager/config/dawn.orig` |
| `/etc/config/meshassistant` | retained | kept as the mesh settings store for compatibility with 2.7.x and mixed fleets |
| `/etc/config/wifimanager` | new | backup settings and product settings only |

The mesh settings file keeps its historic name deliberately: an existing
Mesh Assistant installation must find its configuration intact, and a mixed fleet
must stay interoperable (peer protocol, SSIDs, batman settings). The *product*
name is a UI/translation concern only (DESIGN §2.1).

## 4. Runtime data

```text
/etc/wifimanager/
    backup/        archives (0700 dir, 0600 files), uploads land in /tmp first
    logs/          wifimanager.log, roaming-events.jsonl (bounded)
    config/        dawn.orig and other ownership originals
    runtime/       last operation snapshot (persistent copy)
/var/run/wifimanager/
    op.json        current operation
    peers          peer announcements (tmpfs, pruned)
    names          announced client names
    lock           run lock (flock)
```

## 5. Radio Manager

`radio.sh` + `utils/radio.js` share one analysis model:

- Input: UCI `wireless` (devices + ifaces), `luci-rpc.getWirelessDevices` runtime,
  mesh config (`meshassistant.config.apRadio`, `wifi_radio`, `mlo`),
  `/sys/class/ieee80211` (PHY inventory), `iw phy` (bands when present).
- Checks:
  1. **E-ALLOC-01** one interface selected twice for the same iface.
  2. **E-ALLOC-02** MLO with fewer than two radios.
  3. **E-ALLOC-03** mesh radio also carrying a non-mesh AP in mesh mode.
  4. **E-ALLOC-04** radio disabled but referenced.
  5. **W-CONC-01** AP + STA on one radio (allowed by mac80211 with multi-vif, but
     driver-dependent; warning, not error).
  6. **W-CONC-02** AP + 802.11s on one radio (driver-dependent; warning).
  7. **W-CONC-03** MLO + mesh sharing a radio (hostapd/EHT constraints; warning).
  8. **W-CHAN-01** the mesh spectrum profile's channel differs from the radio's
     configured channel (the channel is radio-wide).
  9. **W-CHAN-02** 2.4 GHz adjacent-channel overlap between radios in the same
     device group; **W-CHAN-03** 5 GHz DFS channel used by an MLO link.
- The inventory and `radio_check` call the same channel and DFS helpers, so a
  save cannot introduce a conflict the inventory does not show. Disabled
  interfaces are not carried at runtime and are excluded from concurrency
  counts. The MLO page sends the link's real mode (`ap` or `sta`) together with
  `mlo=1`, so driver mode, EHT and interface-combination checks also run for
  MLO links.
- Unknown capability is reported as a warning, never silently accepted.
- Hardware claim: checks are heuristic (driver capability is not queryable in a
  portable way); marked 待验证 on real chipsets.

### 5.1 Wireless interface editor

The Interfaces and MLO pages open one modal (`utils/wireless-form.js`) backed by
`utils/wireless.js` for immediate validation and `wireless.sh` as the authority.
It creates and edits AP, STA, ad-hoc and standalone MLO interfaces; mesh-owned
sections and 802.11s sections are refused (`E-MESH-OWNED`), so the Mesh engine
stays the only writer of its sections.

Standalone MLO needs at least two radios, writes `mlo=1`, switches the selected
radios to EHT and uses a generated `mloN` section; it does not depend on Mesh
and never edits `wifi_ap_mlo`. Passphrases are write-only: the inventory reports
`has_key`, never the key. Every save takes the run lock, creates a
Wireless-scope backup, snapshots `/etc/config/wireless` (0600), commits,
reloads, waits for the interface and restores the snapshot if commit or
verification fails. Runtime effects are 待验证.

### 5.2 Network conflict checks

`network.sh` implements the DESIGN §12 checks as a read-only method
(`network_check`). It reads `network`, `dhcp`, `firewall`, `wireless` and the
mesh configuration, never writes UCI and never restarts a service. Findings are
grouped as N-IP, N-DHCP, N-POOL, N-DNS, N-BRIDGE, N-ROUTE, N-FW and N-MESH
codes with a severity, message and detail; Overview and Diagnostics → System
render the list. The server's `server_dhcp` option and the node/client roles are
honoured, disabled interfaces are skipped, and both swconfig and DSA bridge
layouts are recognised. The result is explicitly configuration-level; runtime
reachability is not probed.

### 5.3 Advisory allocation and channel recommendation

Two read-only additions build on the same model without changing the write path:

- **Smart radio allocation.** `radio_advice` reports only facts (band, disabled,
  mesh radio, enabled interfaces per radio). `utils/radio.js advise()` turns
  them into a per-radio verdict — `recommended` (no other enabled interface),
  `possible` (another interface shares the radio, or it is the mesh radio) and
  `avoid` (disabled radio, or an AP on the mesh radio). With MLO it suggests a
  pair across bands and says when only one band is available. The editor
  recomputes the verdicts locally when the mode, the radio selection or MLO
  changes, excludes the section being edited from usage, and treats the whole
  thing as advice: it never ticks a checkbox, a failed `radio_advice` call is
  ignored, and the save path still runs `radio_check`.
- **Channel recommendation.** `channel.sh` lists the channels the driver
  accepts (`iw phy info`, skipping `disabled`/`no IR`, deduplicated by
  frequency), takes one scan snapshot through `iwinfo`/`iw` and reads the busy
  time of the current channel from `iw survey dump`. `utils/channel.js rank()`
  scores each candidate by overlapping scan cells (stronger signal weighs
  more, co-channel counts twice), a DFS penalty and the current utilization,
  and reports the channel width it assumed. The Radios page asks for
  confirmation first because a scan briefly takes a running AP off-channel;
  an empty scan is reported as “no data”, never as free spectrum. Nothing is
  written and no channel is applied automatically.

## 6. Mesh engine

`mesh.sh` implements the same UCI effects as the audited 2.7.12 engine, split into
functions and called from a background worker (`wm_run_bg`). Roles:

| Role | bat0 gw_mode | LAN bridge | DHCP/DNS | AP | Backhaul |
|---|---|---|---|---|---|
| server | server | bat0 joined | provides (unless `server_dhcp=0`) | yes | wired + mesh |
| node | off | bat0 joined | none (services restored on disable) | yes | wired + mesh |
| client | client | **not** joined (no L2 loop into LAN) | none | optional (default on) | wired + mesh |

A single mesh radio is a deliberate limit, not an unfinished feature. The engine
takes exactly one radio (`mesh_apply` configures that one 802.11s interface) and
the UI enforces the choice with a single-value selector before apply; multi-radio
802.11s is not supported in 2.0.0.

`mesh_apply` itself is transactional (DESIGN §6.4): before `mesh_apply_config`
runs, every file the engine may touch (`wireless network dhcp firewall
meshassistant dawn`) is copied into a private `/tmp` snapshot. A failure reverts
staged UCI, restores the snapshot, reloads config, network and Wi-Fi, and
finishes the operation as `failed` with a `rolled-back` event; the durable
pre-change backup remains for the operator. If the snapshot cannot be created
the apply stops before changing anything.

## 7. Hybrid backhaul

- Wired: selected port leaves the LAN bridge (recorded), becomes `network.mesh_wired`
  (`proto batadv_hardif`, `master bat0`, mtu 1500). Removal restores the port. The
  kernel-negotiated speed (`/sys/class/net/<port>/speed`) is a link rate, not
  measured throughput, so it is not copied into `throughput_override`.
- Wireless: 802.11s via `mesh_<radio>` → `network.mesh_batman` (`mtu 1536`).
- Priority (DESIGN §7.4, `mesh_apply_priority`): `auto` (default) deletes
  `throughput_override` from both hardif sections so BATMAN-adv measures the links;
  `manual` writes the operator's `backhaul_wired_mbit` / `backhaul_wireless_mbit`
  as `<n>mbit`. Priority is applied with the mesh configuration, never by the
  monitor.
- Automatic switching (DESIGN §7.3, opt-in `backhaul_auto=1`, `backhaul.sh`):
  the wired port's carrier (not the netdev's existence) is sampled every 5 s. The
  wired hardif is detached from bat0 only after the link has been down for
  `backhaul_switch_delay` (default 30 s), and restored only after it has been up for
  `backhaul_stable_time` (default 60 s), so a flapping cable restarts the timer.
  Switches are runtime-only netifd calls (`ubus call network.interface.mesh_wired
  up|down`) and never rewrite UCI; the bat0 hardif list is checked afterwards when
  `batctl` exists. A failed switch keeps the current medium, records `last_error`
  and emits `backhaul-switch-failed`; successes emit `backhaul-switch`.
- Without automatic switching, medium choice is BATMAN-adv's own (hardif rates +
  `gw_mode`). The UI shows which hardif currently carries selected originators
  (`batctl o` `*`) and the switching state through the read-only `backhaul_status`.

## 8. Roaming

- 802.11k (`ieee80211k`) and 802.11v (`bss_transition`) have separate operator
  toggles (`roaming_k_enabled`, `roaming_v_enabled`); 802.11v additionally
  requires the `wnm_supported` whole-string probe; 802.11r (`ieee80211r`, `mobility_domain`,
  `ft_psk_generate_local=0`) with a configurable FT transport. hostapd accepts
  one transport per BSS, so `meshassistant.ft_over_ds` selects DS (`1`) instead
  of the air default (`0`); both the roaming apply and the mesh AP writer take
  the value from `ft_over_ds_value()`, and a missing option stays `0` so an
  upgrade does not silently change the running APs.
- Apply is transactional in the same way as Mesh: the Roaming scope of the
  global Backup Manager runs before any write, a private snapshot records
  `wireless`, `dawn` and the DAWN takeover files (`dawn.managed`, `dawn.orig`,
  whether the service was running), and a failed commit or DAWN start
  restores all of them and finishes the operation as failed with a
  `roaming-apply` event. A DAWN service that does not come up after a
  successful write finishes as *unverified* instead of being reported as done.
- DAWN: managed config with ownership marker; global metrics
  (`kicking=3`, `kicking_threshold=20`, `min_number_to_kick=3`,
  `set_hostapd_nr=1`, `duration=150`), per-band thresholds, shared key
  `md5("meshassistant:"+secret)` (kept for compatibility with 2.7.x peers).
- Events: the worker ticker samples `batctl o`/`iw station dump` deltas every
  15 s and appends bounded JSONL events (`roam`, `link-down`, `link-up`,
  `batman-error`). DAWN recovery and the backup timer only need a minute-scale
  cadence and run on every fourth pass (60 s). Fields that cannot be measured
  are `null`, never invented.
- Advice: `roaming_advice` returns configuration facts plus one station-signal
  sample per band, and `utils/roaming-advice.js` classifies them. It checks the
  k/v/r flags, mobility-domain consistency, DAWN installation/state/watchdog
  and the relationship between the configured good/bad thresholds (per band,
  with the global value as fallback). Signal statistics use the median for the
  suggested "good" value and the 10th percentile minus 5 dB for "bad", forced
  at least 10 dB apart; suggestions are reported only for samples of five or
  more clients and only when they differ by 10 dB from the configured pair.
  Small samples produce an informational note, never a recommendation. Nothing
  is written; the page shows the reasoning next to the fields the operator edits.
  For 802.11k the advice also validates every managed AP's BSSID (unicast,
  non-zero) and reports a BSSID shared by two APs, because a neighbor report
  cannot identify either. For 802.11r it compares the authentication settings of
  the APs that share one SSID: encryption, PMF mode, RADIUS server/port and the
  PSK. The backend compares keys by assigning an opaque group index to each
  distinct secret inside one call; the key and any hash of it never leave the
  router. The AP table shows the BSSID in use and whether the interface is up.

## 9. Topology

- Data: `batctl n`, `batctl o`, `batctl interface`, peers file, `iw` survey/station
  dumps, `iwinfo`, `ubus network.interface.status`, netifd device status.
- Renderer: SVG (no external JS), solid line = wired hardif, dashed = wireless;
  node state from announcement freshness (offline after 120 s while the
  five-minute peer cache retains the device); duplicates by device key (LAN
  MAC); incomplete nodes rendered with explicit "unknown" fields.
- Per-node table: one row per device with hostname, MAC address, IPv4 address,
  node role, CPU load, memory use, WiFi channel (with band), connected clients,
  backhaul media, link status, strongest backhaul signal and rate. The values a
  device announces for itself are repeated on every row of that device, so the
  table reads the first row that carries one; an older announcement that has no
  value leaves the cell empty instead of guessing it. The "This device" card
  shows the same fields from `linkinfo` and the bat0 MAC.
- JSON protocol: `{v:1, generated_at, self, nodes[], links[]}` documented in the page
  and produced in `utils/mesh.js`; consumers must ignore unknown fields.
- Announcement v9 adds memory use and the connected-client count (device-wide) and
  the mesh ID, role, routing algorithm, channel, HT mode and band (per hardif).
  Announcement v10 appends whether a mesh key is configured (`set`/`unset`) and
  the encryption mode name; the key itself is never transmitted. Every trailing
  field is validated before it is stored, so a malformed or hand-written
  datagram cannot inject text into the table.
- Consistency: the topology page compares only values a device actually
  announced. A difference in mesh ID, routing algorithm, key state or encryption
  mode is an error; a different role, channel or HT mode per band is a warning;
  peers that announce nothing, or use an automatic channel, are listed as
  information instead of being counted as a mismatch. The mesh key is never
  transmitted, so only its presence and the encryption mode are compared.
- Monitoring: `utils/topology.js` groups announcement rows into devices (LAN MAC,
  then first IP, then neighbour address, then hostname) and reports stale
  announcements (warning after 30 s, error after 120 s), memory use above 85 %
  (warning) or 95 % (error), a wireless-only backhaul weaker than −75 dBm,
  incomplete v9 announcements, duplicate hostnames on different devices,
  duplicate LAN MACs announced under different hostnames and an empty peer list
  while the mesh is enabled. Each device also carries a state: offline after 120 s
  without an announcement (still within the five-minute peer cache), weak for a
  wireless-only node below −75 dBm, otherwise normal. A row built only from an
  announcement reports the age of its newest announcement as its last-seen
  value, so a device that stops announcing remains visible and turns offline
  before the cache drops it instead of disappearing silently. Findings are
  advisory and sorted error → warning → info; a device with an Ethernet link is
  never flagged for a weak station signal. The thresholds are product choices,
  not measured limits; behaviour with real station sampling is 待验证.

## 10. Backup Manager

See `04-BACKUP-DESIGN.md`. It is the only backup implementation; every module calls
it (`mesh_apply` and restore call it directly; views call `backup_create`).

Storage discovery is read-only: `backup_storage` parses `/proc/mounts`, matches
the configured path to its longest mount prefix, and lists `/`, `/tmp` and the
`/mnt`/`/media` mounts with filesystem, free space and writability. Setting a
path under `/mnt` or `/media` is refused unless a volume is actually mounted at
or above it, so an archive cannot silently land on the internal flash. The UI
only copies a suggested path into the field; the operator still saves.

Encryption uses AES-256-CBC with PBKDF2-SHA256 (200000 iterations) and a random
salt. A new passphrase must have 12–128 printable characters and never leaves the
request; only the encrypted archive is written. Creation decrypts the result and
compares SHA-256 with the plaintext before the archive is kept, so a broken
OpenSSL build cannot produce an unreadable-but-apparently-valid backup. The
decrypt path first tries the current KDF parameters and then the older defaults,
so archives written by an earlier release remain restorable.

## 11. Migration and coexistence

`migration.sh` implements the DESIGN §15 sequence — validate the old
configuration, validate the new one, let the operator confirm — as a state
machine in `wifimanager.settings` (`migration_pending`,
`migration_confirmed`, `migration_declined`, plus the detected/backup fields).
The package reads the same `meshassistant` UCI file as the legacy package, so
migration changes who manages it; nothing is copied or deleted.

`root/etc/uci-defaults/90-luci-wifimanager`:

1. If `/etc/config/meshassistant` exists, keep it; never delete or rewrite it.
2. Call `worker.sh migrate_prepare`, which validates the installed
   configuration, takes a full pre-migration backup, disables and stops the
   legacy `meshassistant` init service (recorded in
   `wifimanager.settings.legacy_service_disabled=1`) so two managers cannot
   fight, and records `migration_pending=1`.
3. A fallback block repeats the disable/stop and the pending record if the
   worker is unavailable.
4. Create `/etc/config/wifimanager` defaults if missing.
5. Legacy backups are not copied — they stay in place and are surfaced
   read-only.
6. The Overview page shows the pending decision: **Confirm migration**
   (`migration_confirm`) re-validates the current configuration and records the
   switch; **Restore legacy service** (`migration_restore_legacy`) re-enables
   Mesh Assistant but is refused while the WiFi Manager mesh is enabled.
7. Idempotent: every step tests before acting; safe on reinstall and when both
   packages are installed. Once confirmed or declined, `migrate_prepare` changes
   nothing.

Uninstall (`postrm`): stop the service; do not delete `/etc/config/*` or
`/etc/wifimanager/backup`; re-enable the legacy meshassistant service if it was
disabled by us and still exists. This is the documented rollback path.

## 12. Localization

- Package, view paths, UCI names and ubus namespace stay `wifimanager`.
- Menu/page/Overview strings use `WiFi Manager` / `WiFi管家`; the translation is
  changed in `po/zh_Hans/wifimanager.po` only.
- All new views use `_()` for user-visible strings; a test scans every view and the
  menu/ACL files and requires a translation for each msgid.

## 13. File-size discipline

No view or shell module exceeds roughly 900 lines; responsibility boundaries match
menu nodes and shell domains. Shared rendering lives in `wifimanager/widgets.js`,
shared parsing in `wifimanager/utils/mesh.js` (ported from 2.7.12).
