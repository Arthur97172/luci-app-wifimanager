# 00 — Source Audit

Audit date: 2026-11-12. Basis: the real local sources, not the READMEs.

- Main project (v1.0.0): `/home/arthur/claude/luci-app-wifimanager`
- Feature source (v2.7.12): `/home/arthur/claude/luci-app-meshassistant`
- Output of this work: `/home/arthur/claude/luci/luci-app-wifimanager` (new package tree)

Both source trees were on branch `main` with a clean working tree (`git status --short`
empty) when the audit ran. No git operation other than read-only inspection was
performed. GitHub was used only as a cross-check; the local copies were authoritative.

## 1. Directory structure

### 1.1 luci-app-wifimanager 1.0.0

```text
Makefile
LICENSE
README.md / README.en.md / screenshot.png
.github/workflows/build.yml
.gitignore
htdocs/luci-static/resources/view/wifimanager.js       877 lines, single view
po/templates/wifimanager.pot
po/zh_Hans/wifimanager.po
root/usr/share/luci/menu.d/luci-app-wifimanager.json
root/usr/share/rpcd/acl.d/luci-app-wifimanager.json
tests/i18n.test.js (339 lines), mutation.test.js (228), view.test.js (1869)
```

There is no shell backend, no init script and no UCI config file. All work is done
client-side: the view reads and writes UCI through the `uci` LuCI class, and only
two read-only ubus calls are used (`luci-rpc.getWirelessDevices`,
`iwinfo.assoclist`).

### 1.2 luci-app-meshassistant 2.7.12

```text
Makefile
README.md / README.en.md
htdocs/luci-static/resources/meshassistant/utils.js   1083 lines, pure parsers
htdocs/luci-static/resources/view/meshassistant.js   2235 lines, one view
root/etc/init.d/meshassistant                        procd, starts the peer daemon
root/etc/uci-defaults/luci-meshassistant             creates /etc/config/meshassistant
root/etc/meshassistant/shell/meshassistant.sh        3573 lines, monolith
root/usr/share/luci/menu.d/luci-app-meshassistant.json
root/usr/share/rpcd/acl.d/luci-app-meshassistant.json
po/templates/meshassistant.pot, po/zh_Hans/meshassistant.po
tests/{lib,run,utils,view,package,i18n,mutation,script}.test.js
```

## 2. Key files and functions

### 2.1 WiFi Manager view (`htdocs/.../view/wifimanager.js`)

- `callLuciWirelessDevices`, `callIwinfoAssoclist` — the only RPC calls.
- `L.keepConfiguredValue(option)` — seeds a ListValue from UCI instead of writing a
  form default; used for `mode` and `encryption` to avoid mutating legacy sections.
- `flattenWirelessStatus(status)` — turns `luci-rpc.getWirelessDevices` output into
  per-section runtime info (`ifnames`, `radios`, `up`, `stations`, `mldDetected`).
- `enrichRuntimeStations(runtime)` — refines station counts via `iwinfo.assoclist`.
- `collectSummary(runtime, radios)` — counts interfaces/MLO interfaces and produces
  the honest warnings shown in the overview box.
- `LIGHT_PALETTE` / `DARK_PALETTE`, `isDarkTheme()` — theme detection from computed
  body colors (Bootstrap vs Argon).
- `renderSummaryBox`, `renderSectionOverview`, `renderRuntimeCell` — custom cells.
- `form.Map('wireless', _('WiFi Manager'))` + `form.GridSection` on `wifi-iface`
  with tabs `general` / `security` / `advanced`. Options: `disabled`, `mlo`, `mode`
  (ap/sta/adhoc/mesh), `device` (MultiValue, ≥2 for MLO), `network`, `ssid`,
  `hidden`, `encryption` (sae/sae-mixed/psk2/psk-mixed/owe/none), `key`,
  `ieee80211w` (with per-encryption `defaults` and a write that removes the
  default), `ifname`, `macaddr`, `bssid`, `wds`, `uapsd`, `ocv`,
  `disassoc_low_ack`.
- Quick Add AP/STA MLO: creates `mloN` section, `mlo=1`, first two radios,
  `sae` + `ieee80211w=2`; AP gets SSID `OpenWrt-MLO`, STA gets `wwan`/`wan`.
- `refreshRuntime` on a 5-second `poll.add` interval; the summary box is
  re-inserted after every `m.renderContents()`.

### 2.2 Mesh Assistant view (`htdocs/.../view/meshassistant.js`)

- RPC: `lan` interface status, `iwinfo.freqlist`, `iwinfo.countrylist`;
  everything else goes through `fs.exec` on `/etc/meshassistant/shell/meshassistant.sh`.
- Constants: `BATCTL=/usr/sbin/batctl`, `SCRIPT`, `PEERS_FILE=/tmp/meshassistant_peers`,
  `LOG_FILE=/tmp/meshassistant.log`, `BACKUP_DIR=/etc/meshassistant/backup`,
  `BACKUP_SELECTION=/tmp/meshassistant_backup_selection`.
- `readMeshStatus()` = `batctl meshif bat0 neighbors` + peers file + `linkinfo` +
  `batctl originators`, then `utils.parseStatus`.
- Tabs on `form.Map('meshassistant')`: setup / spectrum / apmode / advanced, plus
  page tabs Mesh Settings / Mesh Status / Backup Management / Run Log.
- Backup UI: list (`backup list`), create (`backup create`), restore/delete/clear
  (selection file + `--detach backup restore|delete|clear`).
- `handleSaveApply` creates an automatic backup before saving the form.

### 2.3 Parser library (`htdocs/.../meshassistant/utils.js`)

Pure, testable parsers: `macKey`, `deviceKey`, `ipv4`, `prefixToNetmask`,
`latestPeers`, `parsePeers` (protocol v2-v7), `annotatePeers`, `parseMeshState`,
`parseLinkInfo`, `parseLocalInfo`, `parseLocalIdentity`, `annotateLinks`,
`parseNeighbors` (two batctl formats), `parseOriginators`, `annotateBackhaulState`,
`mergeAnnouncedRows`, `groupRemoteRows`, `strongestLink`, `parseLocalRows`,
`buildLocalRow`, `annotateLocalState`, `parseClients`, `parseRoaming`, `channelPlan`,
`channelSlots`, `parseStatus`. This is the highest-value reusable asset: it encodes
years of edge cases (stale/duplicate/incomplete rows, MLO MLD addresses, DAT).

### 2.4 Shell engine (`root/etc/meshassistant/shell/meshassistant.sh`)

Notable functions and semantics, with the UCI surface they touch:

| Area | Functions | Effect |
|---|---|---|
| Helpers | `uci_set_value`, `uci_set_optional`, `uci_commit`, `log_note` | never store empty options; log to `/tmp/meshassistant.log` |
| Bridge | `lan_bridge_section`, `bridge_add_port`, `bridge_del_port`, `wired_port_is_usable` | edits `network.<lan>.ports` list |
| Firewall | `firewall_zone_section`, `firewall_zone_add_network`, `firewall_remove_network_everywhere`, `ensure_lan_wan_forwarding` | zones by name, not index |
| DHCP/DNS | `save/restore_dhcp_lan_state`, `remove_dhcp_option6`, `apply_server_dhcp_dns`, `apply_dhcp_lan_dns` | option-level snapshots |
| Services | `disable_service_recorded`, `restore_service_if_disabled`, `restore_services` | records only what it disabled |
| Node LAN | `save/restore_node_lan_state`, `save/restore_hostname_state`, `apply_node_lan`, `lan_state_save/expect/restore`, `lan_watchdog_check` | static address with watchdog + rollback |
| Backhaul | `wired_backhaul_port`, `wired_link_speed`, `apply_wired_backhaul`, `remove_wired_backhaul` | `network.mesh_wired` (proto `batadv_hardif`, master `bat0`); port removed from LAN bridge and restored; optional carrier-based switching in `backhaul.sh`; `throughput_override` only in manual priority mode |
| Batman | `create_batman_network`, `disable_batman_interfaces` | `network.bat0` proto `batadv`, BATMAN_V, `gw_mode` server/off, `network.mesh_batman` |
| Radios | `process_radios`, `setup_ap_radios`, `setup_mesh_radio`, `configure_ap_iface`, `enable_eht_htmode`, `apply_spectrum_settings`, `valid_spectrum_htmode` | `wifi_ap_<radio>` / `wifi_ap_mlo` / `mesh_<radio>` sections; EHT for MLO; per-radio spectrum from `meshassistant.config.spectrum_*` |
| Roaming | `wnm_supported`, `setup_dawn`, `dawn_release`, `roaming_report`, `capabilities` | `ieee80211k`, `bss_transition` only if wpad has 802.11v, `ieee80211r`/`mobility_domain`/`ft_over_ds`/`ft_psk_generate_local`; writes `dawn.global` (`kicking=3`, `kicking_threshold=20`, `min_number_to_kick=3`, `set_hostapd_nr=1`, `duration=150`), per-band metrics, `@network[0].shared_key = md5("meshassistant:"+secret)`; stores original dawn config for release |
| Announce | `announce_identity`, `announce_names`, `record_peer`, `prune_peers`, `daemon_meshassistant` | UDP 47123 with `socat`, protocol versions `meshassistant/1..8` |
| Status | `link_info`, `client_info`, `roaming_report` | line-oriented output parsed in JS |
| Backup | `backup_create/list/validate_archive/restore/delete/clear`, `backup_read_selection` | see §3 |
| Modes | `enable_meshassistant`, `disable_meshassistant`, `set_apmode`, `disable_apmode` | orchestration + dumb AP mode (`*.meshbak`) |

### 2.5 init / uci-defaults

- `root/etc/init.d/meshassistant`: procd, START=99, runs the script `daemon` when
  `meshassistant.config.enabled=1`; respawn 3600 5 0; `stop` removes peer files.
- `root/etc/uci-defaults/luci-meshassistant`: creates the config (`enabled=0`),
  registers `ucitrack`, restarts rpcd.

## 3. Legacy Mesh Backup — actual implementation

This is the part DESIGN §10.9 requires to be preserved.

- Storage: `/etc/meshassistant/backup/<YYYYMMDD-HHMMSS>[-n].tar`, directory 0700,
  files 0600, retention `MESHASSISTANT_BACKUP_KEEP` (default 20, lexical prune).
- Archive content: uncompressed tar with `manifest` + `etc/config/{network,wireless,
  dhcp,firewall,system,meshassistant}` (only files that exist).
- Manifest keys: `created`, `hostname`, `lan_ip`, `role`, `enabled`,
  `firewall`, `dnsmasq`, `odhcpd` (service enable states), one `key=value` per line.
- Creation: `backup_create` copies the configs to a mktemp dir, writes the manifest,
  builds a hidden `.backup.$$` tar in the backup dir, then `mv` (atomic), `chmod 600`.
  An automatic backup runs before every mesh apply (and before a restore).
- Listing: `backup_list` prints TSV `name, created, hostname, lan_ip, role`, one line
  per `*.tar`, skipping archives without a manifest.
- Restore: `backup_read_selection` reads `/tmp/meshassistant_backup_selection` and
  validates it (`''|.*|*/*|*\\*|*..*|*[!A-Za-z0-9._-]*` rejected, `.tar` suffix
  required), deletes the selection file, takes the run lock, creates a safety
  backup, validates the tar entry whitelist (`manifest`, `etc`, `etc/config`,
  the six config files), extracts, rejects symlinks, runs `uci -q -c tmp show` on
  every config to prove syntax, copies the files back, restores the three service
  states, restarts/stops meshassistant by `enabled`, then `reload_config`,
  `/etc/init.d/network reload`, `wifi reload`.
- Delete/clear: same selection protocol; `clear` removes every `*.tar`.

Compatibility risks for 2.0.0: the manifest has no JSON metadata, no scope, no
checksums; restore replaces whole config files (so it would clobber unrelated
Wireless/MLO changes). The new manager therefore treats these archives as
**Legacy Backup Type**: listed and validated as-is, restored through the mesh-scope
merge (never whole-file), and never deleted or rewritten during migration.

## 4. Architectural comparison

| Concern | WiFi Manager 1.0.0 | Mesh Assistant 2.7.12 | 2.0.0 decision |
|---|---|---|---|
| UI | one view, `wireless` map | one view + page tabs | split views per menu node |
| Backend | none (UCI client-side) | 3573-line shell via `fs.exec` | ubus object `wifimanager` (rpcd shell plugin) + modules |
| RPC/ACL | read-only ubus + uci wireless write | broad `file.exec` on the script, uci writes | least-privilege: ubus methods + uci read + narrow file access only for backup download/upload |
| Config | `wireless` | `meshassistant`, plus edits to `network`, `dhcp`, `firewall`, `system`, `dawn`, `wireless` | same files; `meshassistant` kept as the mesh config store for compatibility; new `wifimanager` config holds backup settings only |
| Backup | none | mesh-only tar | global Backup Manager under `/etc/wifimanager/` |
| Status data | ubus + iwinfo | batctl / iw / ubus, parsed in JS | same, parser library reused |
| MLO | iface-level `mlo=1` + ≥2 radios | AP MLD in mesh mode | both kept, unified conflict checks |

## 5. Local vs GitHub

The local trees were clean and matched their local `origin/main` refs; no
uncommitted work existed. No pull/reset/checkout was run. Where behaviour
documentation differed, the code was treated as authoritative (e.g. the README
mentions features that the shell implements only for a single mesh radio —
`enable_meshassistant` rejects a multi-value `apRadio`).

## 6. UCI surface

- WiFi Manager 1.0.0: reads `wireless`/`network`, writes `wireless`.
- Mesh Assistant: reads/writes `meshassistant`; writes `wireless`, `network`,
  `dhcp`, `firewall`, `system`, `dawn`; keeps `*.meshbak` and `*.dumbap` files.
- Conflicts to handle: two managers writing `wireless` (resolved by one engine);
  the meshassistant init service and ours both claiming the peer port (only one
  service may run); DAWN ownership (marker file + original config backup).

## 7. Duplication and conflict findings

1. **Two `wireless` writers.** Both plugins edit `wifi-iface`. 2.0.0 has exactly one
   backend, so writes are serialized by a single run lock.
2. **Two product names.** The menu title is `WiFi Manager`; the zh_Hans po maps it
   to `WiFi管理`, and README.md line 51 uses `WiFi管理`. This is the only place the
   old Chinese product name exists; it becomes `WiFi管家`.
3. **Two backup systems.** Mesh Assistant's own backups must not remain reachable
   as a parallel engine: its UI entry is removed and the files are surfaced as
   Legacy Backups inside the global manager.
4. **DAWN double management.** Both `setup_dawn` (meshassistant) and any future
   roaming page could write `dawn`. 2.0.0 centralizes it in `roaming.sh` with the
   same `dawn_release` ownership marker.
5. **802.11v capability.** Writing `bss_transition` on a wpad build without WNM
   makes hostapd fail and takes the radio down; the `wnm_supported` probe is kept.

## 8. Reuse classification

- **Reuse directly (ported):** `utils.js` parsers → `wifimanager/utils/mesh.js`;
  the interface/MLO form and its custom cells → `view/wifimanager/wifi/interfaces.js`;
  theme palette helpers; peer announcement protocol (must stay wire-compatible with
  existing 2.7.x nodes); legacy backup archive reading; UCI/bridge/DHCP helper
  semantics; DAWN configuration values.
- **Reuse with modification:** shell engine split into `common.sh`, `radio.sh`,
  `mesh.sh`, `roaming.sh`, `diagnostics.sh`, `backup.sh` — orchestration and
  logging change, semantics retained; init service renamed and guarded against the
  old one; ACL narrowed from broad `file.exec` to specific ubus methods.
- **Reimplement:** global Backup Manager (metadata, scopes, checksums, retention,
  legacy compatibility, scoped restore, rollback); Radio Manager conflict analysis;
  menu and navigation; product localization; tests.
- **Retire:** the 3573-line monolith as an execution path, the mesh-only backup UI,
  the `fs.exec` command strings, and `WiFi管理` as a product name. The old UCI file
  `meshassistant` and its options are *not* retired.

## 9. Product name / localization audit

| Location | Current | 2.0.0 |
|---|---|---|
| menu title | "WiFi Manager" | unchanged |
| po `WiFi Manager` | `WiFi管理` | `WiFi管家` |
| page title | `_('WiFi Manager')` | unchanged msgid, new translation |
| overview heading | `_('WiFi Manager Overview')` | `WiFi管家概览` |
| README.md | `WiFi管理` (line 51) | `WiFi管家` |
| README.en.md | `WiFi Manager` | unchanged |
| package/module/UCI/RPC names | wifimanager | unchanged |

No hard-coded Chinese product name exists in JS; translation happens only through
the po catalog, so the change is a po/menu/README change and does not touch code
paths.

## 10. Gaps found while auditing (honesty list)

- No hotplug handler exists in either project despite DESIGN mentioning hotplug.
- The mesh engine supports exactly one mesh radio (`apRadio` must contain one value).
- Roaming events are not persisted by either project (only live counters via
  `roaming_report`); 2.0.0 adds a bounded event log fed by the mesh/roaming engine.
- No test can exercise real radios in this environment; all hardware-dependent
  behaviour is marked **待验证 (unverified on hardware)** in docs and release notes.
