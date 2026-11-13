# 01 — Feature Migration Matrix

Legend for **Status**: `ported` = logic migrated into the new modules; `rewritten` =
same user-visible feature, new implementation; `new` = added in 2.0.0; `retired` =
intentionally not carried over; `待验证` = implemented but not verified on hardware.

## Wireless / MLO (WiFi Manager 1.0.0)

| Feature | Source | 2.0.0 location | Status |
|---|---|---|---|
| Wireless interface list + General/Security/Advanced tabs | `view/wifimanager.js` | `view/wifimanager/wifi/interfaces.js` + `utils/wireless-form.js` + `wireless.sh` | rewritten (one modal editor; 待验证 on hardware) |
| MLO flag, multi-radio validation, AP/STA quick add | same | `wifi/mlo.js` + `utils/wireless-form.js` + `wireless.sh` | ported / rewritten |
| Standalone MLO creation and editing without Mesh | old quick add | `wifi/mlo.js`, generated `mloN` section | rewritten; 待验证 |
| Unified DHCP/DNS/IP/route/firewall/mesh conflict check | none | `network.sh` + `utils/network.js` | new |
| Runtime status (MLD ifnames, stations, auth) | `flattenWirelessStatus`, `enrichRuntimeStations` | `wifimanager/utils/rpc.js` + `utils/radio.js` | ported |
| Theme-aware overview cells | palettes + `isDarkTheme` | `wifimanager/widgets.js` | ported |
| `L.keepConfiguredValue` | view | `wifimanager/utils/uci.js` | ported |
| Radio list with band/channel/htmode display | none | `view/wifimanager/wifi/radios.js` | new (read-only; changing a radio's channel, htmode or TX power stays in the stock Wireless page) |
| Radio capacity/conflict analysis (AP+STA, AP+11s, MLO+Mesh, channel) | none | `utils/radio.js` + `radio.sh radio_check` | new |
| Hardware capability probe (DESIGN §5.1) | none | `capabilities.sh` + `radio.sh capability_json_add` + `utils/radio.js` + Radios hardware-capability card and editor concurrency hint | new (bands, usable channels, interface modes and interface combinations exactly as `iw phy info` reports them; a band, mode or combination the driver does not report is shown as “not reported”, never inferred; per-driver output 待验证) |
| Radio allocation check before every interface save (DESIGN §5.2) | none | `utils/wireless-form.js` + `radio_check` | new (configuration conflicts and driver statements block the save: E-CAP-01..05 reject an unsupported mode, band, PHY mode, interface mix or channel; when the driver reports no usable capability the save needs explicit confirmation, W-CAP-01) |
| Smart radio allocation advice (per-radio verdict, free/possible/avoid, MLO pair suggestion) | none | `utils/radio.js advise()` + `radio.sh radio_advice_json` + `utils/wireless-form.js` | new (advisory only: uses configuration and mesh settings, never driver capabilities, and never changes the selection) |
| Automatic channel recommendation | none | `utils/channel.js` + `channel.sh channel_advice_json` + `view/wifimanager/wifi/radios.js` | new (candidates from `iw phy info`, one scan after explicit confirmation, ranked in the browser; 待验证 on hardware) |
| Connected clients across radios | none | `view/wifimanager/wifi/clients.js` | new |

## Mesh (Mesh Assistant 2.7.12)

| Feature | Source | 2.0.0 location | Status |
|---|---|---|---|
| Enable/disable mesh, apply engine | `enable_meshassistant`, `disable_meshassistant` | `mesh.sh mesh_apply/mesh_disable` | rewritten (split, same UCI effects) |
| Server / Node / Client roles | `create_batman_network` (`gw_mode`) | `mesh.sh apply_role` | ported; role set extended to server/node/client |
| Server DHCP/DNS switch | `server_dhcp`, `apply_server_dhcp_dns` | `mesh.sh` | ported |
| BATMAN-adv bat0 + BATMAN_V options | `create_batman_network` | `mesh.sh create_bat0` | ported |
| 802.11s mesh radio section | `setup_mesh_radio` | `mesh.sh setup_mesh_radio` | ported |
| AP radios, per-radio SSID, MLO AP | `setup_ap_radios` | `mesh.sh setup_ap_radios` | ported |
| Spectrum settings | `apply_spectrum_settings` | `mesh.sh apply_spectrum` | ported |
| Wired backhaul + automatic fallback | `apply_wired_backhaul`, `wired_link_speed` | `mesh.sh apply_wired_backhaul` + `backhaul.sh backhaul_monitor_once` | rewritten (carrier debounce; runtime-only netifd switch, no UCI rewrite; DESIGN §7.1 WAN/LAN conflict check: a port that carries the WAN uplink is refused by device — firewall zone `wan` plus wan/wan6/wwan, bridge devices expanded to their ports — and the editor keeps those devices out of the wired-port list) |
| LAN bridge membership / firewall zones | `bridge_*`, `firewall_*` | `mesh.sh` | ported |
| Node static address, hostname, watchdog rollback | `apply_node_lan`, `lan_watchdog_check` | `mesh.sh apply_node_lan` + `common.sh lan_watchdog` | ported |
| Automatic rollback of a failed apply | none (a failed `enable_meshassistant` left partial UCI) | `mesh.sh mesh_apply_snapshot/mesh_apply_rollback` | new (DESIGN §6.4) |
| Dumb AP mode | `set_apmode`, `disable_apmode` | `mesh.sh dumbap_enable/disable` | rewritten (no whole-file `*.meshbak` restore; uses global backup) |
| Peer announcements (UDP 47123, v1-v10) | `announce_*`, `record_peer` | `peer.sh` + `init.d/wifimanager` | ported (wire-compatible; v9 adds memory, client count and mesh parameters; v10 appends the key state and encryption name — the key itself is never sent) |
| Mesh status / neighbors | `link_info`, `batctl n` | `diagnostics.sh` + `utils/mesh.js` | ported |
| Connected devices with names | `client_info` | `diagnostics.sh clients` + `utils/mesh.js` | ported |
| Topology visualization | none (table only) | `view/wifimanager/mesh/topology.js` + SVG renderer | new |
| Mesh parameter consistency check | none | `utils/mesh.js consistencyFindings` + topology page | new (announced mesh ID, role, algorithm, channel and HT mode, plus the v10 key state and encryption name, whose mismatch is reported as an error; the mesh key is never transmitted) |
| Topology monitoring | none | `utils/topology.js monitor()` + topology page card | new (node state normal/weak/offline, stale announcements, memory pressure, weak wireless-only backhaul, incomplete announcements, duplicate hostnames and duplicate LAN MACs; sample-based signals are 待验证) |
| Runtime backhaul table with radio and station rates | none | `mesh/backhaul.js` + `link_info` radio/peer lines | new |
| Mesh Backup tab | `backup_*` + view tab | removed from Mesh; legacy archives listed in Backup & Restore | retired → migrated |
| Run log tab | `clearlog`, log file | `diagnostics/logs.js` + `logs` API | ported |

## Roaming / DAWN

| Feature | Source | 2.0.0 location | Status |
|---|---|---|---|
| 802.11k/v toggles with wpad capability probe | `configure_ap_iface`, `wnm_supported` | `roaming.sh apply_roaming` | ported |
| 802.11r + mobility domain | same | same | ported |
| DAWN managed config, release marker | `setup_dawn`, `dawn_release` | `roaming.sh` | ported |
| DAWN thresholds (global + per band) | form + `setup_dawn` | `roaming/settings.js` + `roaming/dawn.js` | ported |
| DAWN status / restarts | `capabilities`, `dawn_status` | `diagnostics.sh` | ported + extended |
| Roaming events | none persisted | `roaming.sh events` (bounded JSONL, honest gaps) | new |
| Hostapd transition counters | `roaming_report` | `diagnostics.sh roaming` | ported |
| Roaming advice | none | `roaming_advice` + `utils/roaming-advice.js` + Roaming settings card | new (read-only; checks k/v/r, mobility domain, BSSID validity/uniqueness for 802.11k, per-SSID authentication consistency for 802.11r (keys compared by an opaque group index) and DAWN state, reports measured signal statistics per band and suggests thresholds only for samples of five or more clients; real station sampling 待验证) |
| Neighbouring AP scan (DESIGN §8.1) | none | `apscan.sh roaming_neighbor_scan_json` + `utils/neighbors.js` + Roaming settings card | new (read-only, one radio at a time after an explicit confirmation that the scan takes the radio off its channel; `iw dev scan` with an iwinfo fallback; compares every BSSID with the configured APs — own BSSID, same SSID with a different security family, other networks — and labels the result a one-moment snapshot; scan coverage and duration 待验证) |

## Diagnostics

| Feature | Source | 2.0.0 location | Status |
|---|---|---|---|
| Wireless status | partial (view) | `diagnostics/wireless.js` | new |
| Mesh diagnostics | view status tab | `diagnostics/mesh.js` | rewritten |
| System (load, memory, uptime, services) | none | `diagnostics/system.js` + `diagnostics.sh` | new |
| Logs | run log tab | `diagnostics/logs.js` | ported |
| Config vs runtime vs service vs link distinction | partial | every diagnostics renderer labels the layer | new |
| Unified diagnosis | none | `utils/diagnosis.js` + System diagnostics page | new (aggregates system load/memory/services, `network_check`, mesh runtime and roaming advice into one ranked finding list; read-only and advisory, never blocks a save) |

## Backup & Restore

| Feature | Source | 2.0.0 location | Status |
|---|---|---|---|
| Create backup | `backup_create` | `backup.sh backup_create` | rewritten |
| List backups | `backup_list` | `backup_list` (JSON) | rewritten |
| Restore | `backup_restore` | `backup_restore` (scoped, pre-restore, verify, rollback) | rewritten |
| Delete / clear | `backup_delete`, `backup_clear` | same | ported |
| Automatic backup before apply | call in main dispatch | `mesh_apply`, restore worker | ported |
| Legacy mesh backups | whole archive | Legacy Backup Type, read-only, restorable via mesh merge | new compatibility |
| Retention | count only | count + size + optional age | rewritten |
| Metadata | line manifest | JSON manifest with format version, scope, checksums, firmware | new |
| Scoped restore (no whole `/etc/config`) | none | section merge per scope | new |
| Restore syntax validation | none | `common.sh config_check_syntax` in validate and before/after apply | new (DESIGN §10.7) |
| Upload / download | none | `backup_upload` / download URL with ACL-limited file read | new |
| External storage discovery | none | `backup_storage` + Backup settings storage card | new (mount table from `/proc/mounts`; candidate paths, filesystem, free space and writability; `/mnt`/`/media` paths are refused when nothing is mounted there; actual mounts on the target router 待验证) |
| Encryption | none | optional passphrase (openssl), AES-256-CBC + PBKDF2-SHA256 (200000 iterations), 12–128 character policy, round-trip verification before the archive is kept — **待验证** on the target OpenSSL build | new |
| Encryption default and compatibility | none | `encrypt_default` setting; decrypt falls back to the older KDF parameters | new (older archives still restore) |

## Migration & coexistence

| Feature | Source | 2.0.0 location | Status |
|---|---|---|---|
| Mesh Assistant daemon stopped on install | implicit (both packages enabled) | `migration.sh migration_prepare` + uci-defaults fallback | rewritten (never runs both managers) |
| Validate old and new configuration | none | `config_check_syntax` in prepare and confirm | new (DESIGN §15) |
| User confirmation before switching managers | none | Overview migration card + `migration_confirm`/`migration_restore_legacy` | new (DESIGN §15) |
| Pre-migration backup | none | `backup_create_auto full` in `migration_prepare` | new |
| Undo: restore the legacy service | manual `enable` | `migration_restore_legacy` (refused while the mesh is enabled) | new |
| Legacy configuration and archives stay readable | same files | read in place; never copied or deleted | ported |

## Localization

| Item | Before | After |
|---|---|---|
| zh_Hans menu/page title | WiFi管理 | WiFi管家 |
| English title | WiFi Manager | WiFi Manager |
| Overview heading zh | WiFi Manager 概览 | WiFi管家概览 |
| README (zh) | WiFi管理 | WiFi管家 |
| Package/JS/UCI/RPC identifiers | wifimanager | unchanged |

## Retired code

| Code | Reason |
|---|---|
| 3573-line `meshassistant.sh` as execution path | DESIGN §21 rule 7 (no monolith); replaced by modules |
| `fs.exec` on arbitrary script subcommands | DESIGN §14 (no arbitrary command surface); replaced by ubus methods |
| Mesh Backup tab and selection-file protocol | DESIGN §2.3/§10.1 (global backup, no per-module engine) |
| `*.meshbak` whole-file dumb-AP restore | unsafe whole-file overwrite; replaced by global pre-change backup + scoped undo |
| `WiFi管理` product name | DESIGN §2.1 |
