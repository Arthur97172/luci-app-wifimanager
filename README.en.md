# WiFi Manager 2.0.0

`luci-app-wifimanager` 2.0.0 merges the former wireless/MLO pages with the Mesh,
backhaul and roaming features of `luci-app-meshassistant` 2.7.12 into one LuCI
application: **WiFi Manager** (Simplified Chinese: **WiFi管家**). The package
name, UCI namespace, RPC object, ACL and internal paths remain `wifimanager`;
the display name does not change any identifier.

> The code is covered by source-level checks and an automated test suite. Radio
> driver behavior, 6 GHz / 320 MHz support, specific mesh firmwares and real
> device upgrade paths still need hardware verification; see "Verification
> status" below.

## Features

- **Wireless**: radio inventory, configured versus runtime channel and TX power,
  interfaces, clients and unified allocation checks. Interfaces can be created
  and edited (AP/STA/ad-hoc plus standalone MLO) with a pre-change backup and
  automatic rollback if reload verification fails; mesh-owned sections stay
  read-only. Every save first runs `radio_check`: errors block the save, and a
  combination that cannot be confirmed requires explicit acknowledgement. The
  editor also shows a per-radio allocation advice (recommended / possible /
  avoid) and an MLO pair suggestion based on the interfaces already configured;
  it never changes the selection. The Radios page ranks channels on request,
  after a confirmation that a scan briefly takes a running AP off-channel, and
  labels the result as a snapshot with its assumed width and DFS notes. It also
  has a hardware-capability card that lists the bands, usable channels,
  interface modes and interface combinations the driver reports through
  `iw phy info`; anything the driver does not report is shown as "not reported"
  rather than inferred. Every save also checks W-CHAN-01/02/03: a mesh
  spectrum override that disagrees with the radio channel, overlapping 2.4 GHz
  channels, and a DFS channel inside an MLO link. Disabled interfaces do not
  count as concurrent usage, and the Radios page shows each interface's
  section, runtime name, mode and MLO/Mesh ownership instead of a bare section
  list. Every interface save is checked against this data: a mode, band, PHY
  mode, interface mix or channel the driver explicitly does not
  support stops the save with E-CAP-01..05, and when the driver reports no
  usable capability the save needs an explicit confirmation (W-CAP-01).
- **MLO**: validates multi-link combinations per band and PHY mode, detects
  same-band or same-radio conflicts and checks Wi-Fi 7 / EHT prerequisites;
  standalone MLO interfaces can be created without enabling Mesh.
- **Network checks**: read-only DHCP server/pool, DNS, LAN IP, WAN/LAN bridge,
  default-route, firewall-zone and mesh-bridge consistency findings.
- **Mesh**: `server`, `node` and `client` roles; BATMAN-adv, 802.11s and hybrid
  backhaul. The server provides DHCP/DNS, the client role never bridges `bat0`
  into the LAN, which avoids loops. Every apply takes a pre-change backup and a
  private snapshot; a failed apply restores the snapshot and records the
  rollback.
- **Backhaul**: Ethernet backhaul is applied as a `batadv_hardif` and never
  steals a port from another bridge or uses a port that carries the WAN uplink:
  the engine checks the firewall `wan` zone and the `wan`/`wan6`/`wwan`
  interfaces by device (bridge devices are expanded to their ports), so moving
  a port to bat0 cannot take the uplink with it, and the editor leaves those
  devices out of the list. Wireless backhaul reuses 802.11s. Optional
  automatic switching follows the port carrier with a fallback delay and a
  restore stability time, switches at runtime through netifd without rewriting
  UCI, and keeps the current medium when a switch fails. Priority is measured
  by BATMAN-adv by default and can be overridden per hardif. AP mode bridges
  WAN and disables the WAN firewall/DHCP roles. The runtime table also names the
  radio behind each hardif and the TX/RX rates of the strongest station.
- **Roaming**: 802.11k/v/r and DAWN. 802.11r has a configurable mobility
  domain and FT transport (over the air or over the distribution system; the
  air default is kept, and hostapd accepts one transport per interface), and is
  never enabled unconditionally. Every apply first takes a Roaming-scope
  backup through the global Backup Manager and a private snapshot of
  `wireless`, `dawn` and the DAWN takeover files, and rolls all of them back
  (including the service state) when the commit or the DAWN start fails. A
  DAWN service that does not come up is reported as unverified rather than
  done. The previous DAWN configuration is kept before takeover, DAWN stays
  stopped when wpad lacks 802.11v, and the event
  sampler records joins, leaves, roams and mesh link changes; events carry the
  client MAC, source/destination AP and RSSI, while disconnect/reconnect duration
  and packet loss are shown as unavailable because they are not observable. DAWN
  steering parameters, watchdog state and the last restart are shown on the
  roaming and DAWN pages. The roaming settings page also shows read-only advice:
  it checks k/v/r, mobility domains, the 802.11k BSSID of every managed AP (it
  must be a unicast, non-zero address and must not be shared), the
  authentication settings of APs that share one SSID (encryption, PMF, RADIUS
  and key; keys are compared through an opaque group index and never leave the
  router) and DAWN state, summarises the per-band client signal median and 10th
  percentile, and suggests thresholds only for samples of five or more clients,
  always at least 10 dB apart. The access point table also shows the BSSID in
  use and whether the interface is up. Nothing is written. The same page can
  also scan neighbouring access points, one radio at a time: every scan needs a
  confirmation because it briefly takes the radio off its channel, it uses
  `iw dev scan` with an iwinfo fallback, and it compares each BSSID with the
  configured APs (our own BSSID, the same SSID with a different security family,
  another network) while labelling the result a one-moment snapshot. The scan
  and the comparison are read-only.
- **Topology and neighbors**: solid links are Ethernet, dashed links are
  wireless; neighbors, originators and reachable devices are listed separately,
  and unreadable runtime values are shown as unavailable rather than guessed.
  Announcement v9 adds memory use, client count and the mesh parameters (mesh ID,
  role, routing algorithm, channel, HT mode, band); the topology page shows them
  and compares the announced mesh parameters. The mesh key is never transmitted
  and is therefore not compared. One row per device shows hostname, node state
  (normal / weak signal / offline), MAC address, IPv4 address, node role, CPU
  load, memory, WiFi channel, client count, backhaul media, link status, signal
  and rate; a value the device did not announce stays empty instead of being
  guessed. The node state follows the freshest announcement, the backhaul media
  and the best signal: a wireless-only node weaker than −75 dBm is “weak signal”,
  and a node without an announcement for two minutes is “offline” while the peer
  cache keeps it (at most five minutes, after which it is no longer listed). The
  page also summarises monitoring findings: stale announcements (warning after
  30 s, error after 120 s), high memory use, a wireless-only backhaul weaker
  than −75 dBm, incomplete announcements, duplicate hostnames, two devices
  announcing the same LAN MAC, and an enabled mesh without peers. These are
  advisory and change no configuration.
- **Backup and restore**: global backup manager with Full / Wireless / Mesh /
  Roaming / Custom scopes. Wireless always includes MLO; there is no separate MLO
  backup type, and the form labels it “Wireless (includes MLO)”. Pre-restore
  backup, rollback on failure, integrity checks and read-only compatibility with
  legacy Mesh Assistant archives. Backup
  permissions live in an independent ACL scope that can be granted on its own;
  the overview marks files changed since the newest backup and shows whether the
  last automatic backup succeeded or failed, when, and for which operation; the download warns
  that an archive contains Wi-Fi passphrases and the mesh key in clear text. The
  settings page reads the mount table, lists usable storage locations with
  filesystem, free space and writability, and refuses a `/mnt` or `/media` path
  without a mounted volume so archives cannot silently land on the internal
  flash. Encryption uses AES-256-CBC with PBKDF2-SHA256 (200000 iterations); the
  passphrase needs at least 12 characters and is never stored. A new archive is
  decrypted and hash-checked before it is kept, and older archives still restore
  with their original passphrase. The description entered on the Create page is
  stored in the manifest and shown in the Overview and Restore lists. The
  Overview, Create and Restore pages distinguish a WiFi Manager backup from an
  OpenWrt Sysupgrade backup: the former covers only the selected configuration
  files and a restore can interrupt the network, while the latter is handled by
  the firmware upgrade mechanism and is neither created nor replaced here; even
  a Full archive is not a system image.
- **Diagnostics**: wireless, mesh, system and logs pages that separate
  configuration, runtime, service and link state. The wireless page shows the
  strongest station's signal and TX/RX rates, and the mesh page embeds the
  backhaul runtime. The system page adds a unified diagnosis that ranks system,
  configuration, mesh and roaming findings into one list. It is read-only and
  advisory; it never blocks a save or restore.

## Menu

```text
Network → WiFi Manager
├── Overview
├── Wireless
│   ├── Radios
│   ├── Interfaces
│   ├── MLO
│   └── Clients
├── Mesh
│   ├── Settings
│   ├── Topology
│   ├── Neighbors
│   └── Backhaul
├── Roaming
│   ├── Settings
│   ├── DAWN
│   └── Events
├── Backup & Restore
│   ├── Overview
│   ├── Create Backup
│   ├── Restore
│   └── Settings
└── Diagnostics
    ├── Wireless
    ├── Mesh
    ├── System
    └── Logs
```

Backup & Restore is a top-level menu, not a child of Mesh.

## Installation

### From Releases

1. Open the [Releases](https://github.com/Arthur97172/luci-app-wifimanager/releases)
   page and download the package for your firmware version.
2. Upload it to the device (for example `/tmp`), then install:

   **OpenWrt / ImmortalWrt 24.10 and older (opkg)**

   ```sh
   opkg install /tmp/luci-app-wifimanager_*.ipk

   #Optional, Simplified Chinese language pack:
   opkg install /tmp/luci-i18n-wifimanager-zh-cn_*.ipk
   ```

   **OpenWrt / ImmortalWrt 25.12+ (apk)**

   ```sh
   apk add --allow-untrusted /tmp/luci-app-wifimanager-*.apk

   #Optional, Simplified Chinese language pack:
   apk add --allow-untrusted /tmp/luci-i18n-wifimanager-zh-cn-*.apk
   ```

3. Refresh LuCI; the entry appears under **Network → WiFi Manager**.

> Without the language pack the interface stays in English. The package is
> architecture independent (`all` for ipk, `noarch` for apk), so one artifact
> works on ARM, x86, MIPS and every other platform; dependencies such as
> `luci-base`, `rpcd-mod-iwinfo`, `kmod-cfg80211`, `kmod-batman-adv`,
> `batctl-default`, `luci-proto-batman-adv`, `iw`, `socat`, `flock`, `jshn`
> and `openssl-util` (encrypted backups) come from the configured package
> feeds, and the install is refused if any of them is missing.

### From source

```sh
cd openwrt
./scripts/feeds update -a
./scripts/feeds install -a
git clone https://github.com/Arthur97172/luci-app-wifimanager.git package/luci-app-wifimanager
make menuconfig     # LuCI → Applications → luci-app-wifimanager
make package/luci-app-wifimanager/compile V=s
```

The built packages end up in `bin/packages/<arch>/base/`; both the main package
and `luci-i18n-wifimanager-zh-cn` are produced together.

The package compiles in practice with the OpenWrt 24.10.8 SDK
(mediatek/filogic, gcc 13.3.0) and the 25.12.5 SDK (gcc 14.3.0), producing
`luci-app-wifimanager_2.0.0-r1_all.ipk` and `luci-app-wifimanager-2.0.0-r1.apk`.
Artefact inspection confirms the dependencies, file list and executable bits
(init.d, uci-defaults, the rpcd plugin, `worker.sh`), and
`/etc/config/wifimanager` is declared as a conffile so an upgrade keeps the
operator's edited settings.

ImmortalWrt is a downstream of OpenWrt with the same LuCI and package
interfaces, and nothing here depends on an OpenWrt-only API. It has not been
built or run on ImmortalWrt, so support there is 待验证 (unverified): build
with the matching ImmortalWrt SDK and treat
`docs/06-RELEASE-VERIFICATION.md` as the acceptance test before relying on it.

On install or upgrade, `90-luci-wifimanager` only adds missing defaults. It
does not overwrite existing UCI values and never deletes
`/etc/config/meshassistant` or old backups. When Mesh Assistant is found, the
install validates the old configuration, creates a full pre-migration backup,
stops the legacy daemon and records the switch as *pending* rather than
deciding for the operator: the Overview page shows a migration card where the
operator can **Confirm migration**, or **Restore legacy service** to go back
(refused while the WiFi Manager mesh is enabled, so two managers never run at
once). `postrm` re-enables the service if this package was the one that stopped
it.

## Backup and restore

State directories:

| Path | Purpose |
| --- | --- |
| `/etc/wifimanager/backup` | New-format archives (0600, directory 0700) |
| `/etc/wifimanager/logs` | WiFi Manager log and roaming events (0600) |
| `/etc/wifimanager/runtime` | Operation lock, op state, peer cache |
| `/etc/wifimanager/config` | Pristine copies of third-party config (DAWN) |

Scopes:

| Type | Areas |
| --- | --- |
| Full | wireless, mlo, mesh, backhaul, roaming, dawn, network, dhcp, firewall, system, wifimanager |
| Wireless | wireless, mlo |
| Mesh | mesh, backhaul |
| Roaming | roaming, dawn |
| Custom | Selected by the operator |

Safety rules:

- Every archive contains `manifest.json`, `checksums.txt` and `etc/config/*`.
  Archives and checksum files are 0600; the backup directory is 0700.
- Backup names, IDs and storage paths are validated; `..`, symlinks and paths
  outside the storage directory are rejected.
- Optional encryption uses `openssl enc -aes-256-cbc -pbkdf2`. The passphrase is
  passed through a 0600 temporary file that the worker deletes before logging,
  and it is never echoed to the UI.
- Restore flow: validate the archive → format, compatibility and UCI syntax
  checks → scope confirmation → pre-restore backup → operator acknowledgement →
  apply → syntax re-check → verify network/wireless state → roll back the
  snapshot on failure.
- Compatibility warnings name a different firmware distribution/version/target,
  a different radio count, radios that are missing or moved to another band or
  PHY path, and physical interface names that no longer exist. They are shown
  with the confirmation and in the archive details, logged by the restore and
  counted in the result; they never block a restore by themselves.
- A file with invalid UCI syntax is never committed: the pre-apply check stops
  with "nothing was changed", and a post-apply failure restores the snapshot and
  records a rolled-back event.
- A restore only replaces or merges the configuration files in the backup
  manifest and **never restores the whole `/etc/config` by default**. Scopes
  merge at section level, so a wireless restore does not break the mesh and
  vice versa.
- Downloads are produced in the fixed directory `/tmp/wifimanager-download`;
  the ACL grants read access only there.

Legacy compatibility:

- Archives in `/etc/meshassistant/backup` are listed read-only as type Legacy
  and can be validated and restored.
- A legacy archive is converted in memory when read; the original file is never
  rewritten, deleted or lossily converted.
- "Copy legacy backup" creates a copy with a new manifest and leaves the
  original untouched. The upload endpoint refuses legacy archives; they must be
  imported explicitly.

## Security model

- Every privileged operation goes through the allowlisted rpcd plugin
  `wifimanager`. Views cannot call `fs.exec`, `child_process` or arbitrary
  commands.
- The ACL grants read-only and action methods separately and gives no general
  access to `/etc/config`.
- Backend arguments are read with `jsonfilter`; IDs, paths, SSIDs, keys and
  hostnames are validated before any UCI write.
- Backup/restore and mesh/roaming writes share one operation lock, so they
  cannot interleave.
- Passwords, keys and archive passphrases are never written to the log or
  displayed by the UI.

## Tests

```sh
node tests/run.js
```

Or one suite:

```sh
node tests/run.js backup
```

The suites are `wifi`, `wireless`, `mlo`, `network`, `mesh`, `backhaul`,
`roaming`, `diagnosis`, `backup`, `restore`, `migration`, `i18n` and `package`. They load
LuCI modules with Node's built-in `vm` and need no OpenWrt tree. They also check
menu, ACL and RPC consistency, JSON and shell/JS syntax, backup permissions,
password handling and the translation catalogs.

## Verification status

Implemented and covered by automated tests:

- Menu, views, RPC, ACL, UCI defaults and translation catalogs are consistent.
- Backup permissions, atomic writes, encryption path, read-only legacy
  compatibility and restore rollback logic.
- Restore scope selection and section merge rules.
- Restore UCI syntax checks: the archive is validated before apply, the merged
  result is re-checked, and a failure restores the snapshot.
- The private pre-apply snapshot and rollback of a failed mesh apply (shell
  simulation and source contracts).
- The roaming apply transaction: Roaming-scope backup, private snapshot of
  wireless/DAWN/takeover files, rollback on a failed commit or DAWN start, and
  DAWN verification (source contracts).
- Restore compatibility warnings for firmware, radio count, radio band/path and
  interface names, in validation, details and the restore log (source
  contracts).
- Mesh Assistant migration: install-time validation, pre-migration backup,
  pending/confirmed/declined state, the constraints on restoring the legacy
  service, and the matching RPC, ACL and Overview entries.
- Wireless editor validation, standalone MLO rules, mesh-owned section
  protection and rollback branches (shell simulation and source contracts).
- Every network-check code, its read-only property, DSA/legacy bridge detection
  and role handling (shell simulation and source contracts).
- Automatic backhaul switching: carrier sampling, fallback/restore debounce,
  the operation lock, keeping the current medium on failure and event
  recording (shell simulation and source contracts).
- WAN device discovery for the wired backhaul (firewall `wan` zone,
  `wan`/`wan6`/`wwan`, bridge devices expanded to their ports), the port guard
  it drives, and the editor's candidate list and saved-port warning (shell
  simulation and source contracts).
- Announcement v9 emission and validated parsing, the mesh-parameter consistency
  card, the backhaul runtime radio/station rates and the wireless diagnostics
  signal/rate columns (source contracts).
- DAWN parameter mapping and watchdog state, roaming event fields and the
  explicit unavailable markers.
- The independent backup ACL, the changed-file indicator, the download warning
  and the read-only `radio_check` that precedes every interface save.
- The radio advice rules (recommended/possible/avoid, the edited section excluded
  from usage, MLO cross-band pairs and the same-band note) and the channel
  ranking (band filtering, overlap weights, DFS penalty, current utilization,
  empty scan and keep-current); both RPCs are read-only and the ACL grants read
  access only.
- Roaming advice, topology monitoring and unified diagnosis rules: threshold
  pairs, mobility domains, k/v/r, DAWN watchdog, sample statistics and the
  five-client minimum, stale/memory thresholds, device grouping, load/memory/
  service severity, and finding order and counts. All three modules are pure
  classification layers over read-only data.
- Driver capability parsing from `iw phy info`: bands, usable channels,
  interface modes and combinations, the combination semantics (modes of one
  group add up; a mode no combination mentions is not permitted) and
  E-CAP-01..05 / W-CAP-01 firing only on an explicit driver statement or its
  explicit absence; the Radios capability card and the editor concurrency hint
  (shell simulation and source contracts).
- The neighbouring AP scan: iw/iwinfo output normalisation, security families,
  the same-SSID-different-security finding, empty and failed scans claiming
  nothing, and the read-only ACL and view contracts (shell simulation and
  source contracts).
- External storage discovery against a fixture mount table; encryption through
  source contracts: PBKDF2-SHA256, 200000 iterations, the 12-character minimum,
  the decrypt fallback and the round-trip hash check.
- Packaging: real builds with the 24.10.8 SDK (.ipk) and the 25.12.5 SDK
  (.apk), with the dependencies, file list, executable bits and conffiles
  declaration checked in each artefact (`/etc/config/wifimanager` is a
  conffile, so an upgrade does not overwrite the operator's settings).

**Pending hardware verification**:

- Installing, uninstalling and upgrading the produced .ipk/.apk on a real
  device (the compile and the artefact inspection were done with local SDKs).
- Interface create/edit on real drivers: reload behavior, driver-assigned
  runtime names, standalone MLO EHT behavior and rollback after a failed
  reload.
- Network-check results on real DHCP/DNS/firewall configurations.
- MLO, 6 GHz and 320 MHz behavior on different drivers (mt76, ath11k, ath10k).
- BATMAN-adv / 802.11s throughput, convergence time and roaming on specific
  firmwares.
- Carrier flaps on real drivers, bat0 hardif detach/reattach latency and
  BATMAN-adv convergence after a backhaul switch.
- wpad 802.11v support together with DAWN, and event sampling accuracy with
  many clients.
- `radio_check` and the Radios capability card against real driver `iw phy info`
  matrices (mt76, ath11k, ath10k and others), including the E-CAP / W-CAP-01
  flow when a driver cannot report its capability or concurrency limits.
- `iw station dump` rate units and availability across drivers, and what hostapd
  and DAWN actually do with the exposed parameters and watchdog restarts.
- v9 consistency comparisons in a mixed-version network, and the changed-file
  indicator while a modification is still in progress.
- The duration and client impact of a channel scan on real drivers and
  firmwares, the accuracy of a single-snapshot ranking with the configured
  width assumption, and what the radio advice looks like when the driver rejects
  a suggested combination.
- The duration, client impact and channel coverage of a neighbouring AP scan on
  real drivers, including the iwinfo fallback when `iw` is unavailable.
- Real station signal sampling and announcement freshness under clock skew for
  the roaming advice and topology monitoring thresholds.
- Whether a node that loses power or stops announcing is shown as offline after
  about two minutes and stays listed until the five-minute peer cache drops it.
- The actual mount layout of the target router and the behavior when a volume
  disappears after the backup path was saved.
- PBKDF2, the decrypt fallback and the round-trip check on the OpenSSL build the
  firmware ships.
- The full install, uninstall and rollback path from 1.0.0 / Mesh Assistant
  2.7.12.
- Behavior when a restore changes the LAN address and the page becomes
  temporarily unreachable.

## Documentation

- `docs/00-SOURCE-AUDIT.md` — source audit
- `docs/01-FEATURE-MIGRATION-MATRIX.md` — feature migration matrix
- `docs/02-ARCHITECTURE-DESIGN.md` — architecture
- `docs/03-RISK-ANALYSIS.md` — risks
- `docs/04-BACKUP-DESIGN.md` — backup and restore design
- `docs/05-CORE-IMPLEMENTATION.md` — core implementation
- `docs/06-RELEASE-VERIFICATION.md` — 2.0.0 release verification runbook
  (hardware execution; currently pending)
- `RELEASE-NOTES-2.0.0.md` — release notes
- `README.md` — Chinese README

## License

GPL-3.0-only; see `LICENSE`.
