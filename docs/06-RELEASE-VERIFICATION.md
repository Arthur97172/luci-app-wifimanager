# WiFi Manager 2.0.0 — release verification runbook

Status: **not executed. Every item below is 待验证 (pending hardware
verification) until a real-device session records a result.** This file exists
so the release gate in DESIGN §19 and the acceptance list in DESIGN §22 can be
closed item by item with evidence. Passing the automated suite does not check
any box here.

Do not tag 2.0.0 or mark an item complete from source inspection alone. Record
for each row: date, device model, firmware image and version, kernel and driver,
`wpad` variant, `batctl` version, the command or UI action used, the observed
result and the evidence (command output, `logread -e wifimanager`, screenshot).

## 0. Test bed

Minimum setup:

- One x86 or ARM device on OpenWrt 24.10.x (opkg, `.ipk`).
- One device on OpenWrt 25.12.x (apk, `.apk`).
- Three mesh-capable devices for Server / Node / Client, with at least one
  wired and one wireless backhaul path.
- Serial or console access on every device used for restore and migration
  tests. A restore can change the LAN address and make LuCI unreachable.
- At least one client per band and one client that can roam between APs.
- At least one device with two or more radios and one single-radio device, so
  radio counts differ across the mesh.
- At least one radio set that supports MLO while the mesh runs on the same
  device.
- One layout where all three routers are cabled together and one mixed layout,
  in addition to the wireless mesh.
- Optional: one device on ImmortalWrt (a downstream of OpenWrt). It is not part
  of the minimum bed and no item in this file has been executed there; treat
  the same rows as the acceptance test if that platform is claimed. ImmortalWrt
  support is 待验证 (unverified) until such a session is recorded.

### Environment checklist (DESIGN §17.7)

Each environment below must be covered by at least one recorded session; the
tests that exercise it are named so the bed can be planned around them.

| ID | Environment | Exercised by | Status |
| --- | --- | --- | --- |
| ENV-1 | Single router | PKG-1/2, ROAM-1, BAK-1–16 | 待验证 |
| ENV-2 | Three routers, wireless mesh | MESH-1/2/4, ROAM-2/6 | 待验证 |
| ENV-3 | Three routers, wired backhaul | MESH-3 plus MESH-6 on an all-cabled run | 待验证 |
| ENV-4 | Three routers, mixed backhaul | MESH-5/6, MESH-13/14 | 待验证 |
| ENV-5 | Different radio counts | RAD-1, TOPO-4, MESH-10 | 待验证 |
| ENV-6 | MLO and mesh on the same device | RAD-2/8, BAK-14/15 | 待验证 |
| ENV-7 | DHCP served only by the main router | MESH-7 | 待验证 |
| ENV-8 | Node power-off and recovery | MESH-8, MESH-15 | 待验证 |
| ENV-9 | Full backup/restore flow | Section 6, FAIL-1–4 | 待验证 |

Record the baseline:

```sh
ubus call system board
uname -a
opkg list-installed | grep -E 'wifimanager|wpad|batman|batctl|dawn|openssl'   # 24.10
apk info -vv | grep -E 'wifimanager|wpad|batman|batctl|dawn|openssl'         # 25.12
batctl -v
openssl version
```

## 1. Package lifecycle

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| PKG-1 | Install the 24.10 `.ipk` with `opkg install` | Package installs, menu appears after LuCI reload, no missing dependency | 待验证 |
| PKG-2 | Install the 25.12 `.apk` with `apk add --allow-untrusted` | Same as PKG-1 | 待验证 |
| PKG-3 | Change a value in `/etc/config/wifimanager`, then upgrade the package | The changed file is preserved (conffile), no operator setting is reset | 待验证 |
| PKG-4 | Remove the package | Services and rpcd plugin stop; no manager process remains; no configuration file is deleted | 待验证 |
| PKG-5 | Reinstall after PKG-4 | Previous configuration is still present and usable | 待验证 |

## 2. Migration and co-existence

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| MIG-1 | Install WiFi Manager on a device running Mesh Assistant 2.7.12 | A full pre-migration backup is created, the legacy daemon is stopped and disabled, and the Overview page shows a pending decision | 待验证 |
| MIG-2 | Confirm the migration in the Overview page | Legacy configuration is adopted; no section is copied twice; no file is deleted | 待验证 |
| MIG-3 | Decline the migration | Mesh Assistant becomes the active manager again; WiFi Manager refuses to enable its mesh while the legacy service runs | 待验证 |
| MIG-4 | Uninstall WiFi Manager while the migration is pending or confirmed | Mesh Assistant service is re-enabled; its configuration and backups are untouched | 待验证 |
| MIG-5 | Upgrade from 1.0.0 | Existing wireless and MLO configuration survives; new pages open without a migration prompt loop | 待验证 |
| MIG-6 | Re-run the installation while the migration is pending | Preparation is idempotent; no second backup flood and no duplicated UCI | 待验证 |
| MIG-7 | Make the confirmation fail (corrupt `/etc/config/wireless` before confirming, or keep the legacy service running) | The confirmation is refused with `E-CONFIG` or `E-STATE`; the pending state, the legacy configuration and the pre-migration backup are unchanged; no UCI section is lost | 待验证 |
| MIG-8 | Restore the pre-migration backup after a failed or declined migration | The archive from MIG-1 is listed, validates and restores to the pre-migration state; the Mesh Assistant configuration is not touched by the restore | 待验证 |

## 3. Mesh and backhaul

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| MESH-1 | Apply Server role on node A, Node role on B and C | All three join one mesh; `batctl n` and `batctl o` agree with the UI | 待验证 |
| MESH-2 | Repeat with 802.11s instead of BATMAN-adv | Mesh forms; the selected routing mode is what the Status page reports | 待验证 |
| MESH-3 | Use a wired backhaul between A and B | Link is shown as Ethernet; no wireless-only warnings | 待验证 |
| MESH-4 | Use a wireless backhaul between B and C | Link is shown as Wireless; signal and rate match `iwinfo`/`iw` | 待验证 |
| MESH-5 | Give one node both wired and wireless backhaul, then pull the cable | Traffic switches to wireless; the UI converges after the debounce; no stale "in use" row | 待验证 |
| MESH-6 | Restore the cable | Traffic switches back; BATMAN-adv reconverges; events record both transitions | 待验证 |
| MESH-7 | Check DHCP, DNS and firewall on a Node | Clients receive addresses and DNS; LAN is reachable in both directions | 待验证 |
| MESH-8 | Power off a node and watch the topology page | The device is marked **Offline** after about two minutes and stays listed until the five-minute peer cache drops it; no silent disappearance before the offline state is shown | 待验证 |
| MESH-9 | Set one node's clock several minutes ahead or behind | Announcement ages remain usable because they are relative to the newest cached announcement; no false offline/online flapping | 待验证 |
| MESH-10 | Mix v9 and v10 (current) nodes, and one v8 node if an image can be built | Rows from an older announcement show empty optional fields instead of guessed ones; consistency findings list them as not announced, not as mismatches; on v10 nodes the key state and encryption are compared and a difference is reported as an error | 待验证 |
| MESH-11 | Force a mesh apply failure (invalid channel or unplugged radio) | The private snapshot is restored, UCI matches the pre-apply state, and the operation reports failure with a rollback event | 待验证 |
| MESH-12 | Apply the Client role on a device that is not meshing | The device joins the mesh as an uplink: bat0 exists but is not bridged into its LAN, and DHCP/DNS/firewall on the device are disabled; the Status page reports the Client role and clients on that LAN still reach the network through the uplink | 待验证 |
| MESH-13 | Change the configured backhaul priority on a node that has both paths | Traffic follows the new preference after the switch; the UI reports the active path; the change is recorded as an event | 待验证 |
| MESH-14 | Pull and restore the cable several times in a row (link flapping) | Debounce absorbs the flaps; no alternating event storm; no stale "in use" row; the final state matches the cable | 待验证 |
| MESH-15 | Power back on the node that was switched off in MESH-8 | The node rejoins the mesh, its row returns from offline to online, and both transitions are recorded; no duplicate row remains | 待验证 |

## 4. Roaming

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| ROAM-1 | Fresh install, do not touch 802.11r | FT is **off**; the settings page agrees with the applied hostapd configuration | 待验证 |
| ROAM-2 | Enable 802.11r explicitly, then roam | The client transitions without a full re-authentication; no connectivity gap beyond the configured timeout | 待验证 |
| ROAM-3 | Enable `ft_over_ds` with a wired DS, then with no wired path | Wired case works; the no-wired case documents the expected failure; the form warns about the requirement | 待验证 |
| ROAM-4 | Enable 802.11k and 802.11v with DAWN | Neighbor reports and BSS transition requests are visible in hostapd/DAWN logs; the UI reports the effective state | 待验证 |
| ROAM-5 | Stop DAWN while roaming settings are applied | The apply transaction reports `done` with verified=0, or restores the snapshot; it never reports plain success | 待验证 |
| ROAM-6 | Roam a client repeatedly and inspect Roaming events | Events name the interface and the relevant fields; samples are frequent enough to capture short roams | 待验证 |

## 5. Topology and diagnostics

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| TOPO-1 | Compare the node table with `batctl n`, `batctl o` and each node's own view | Hostnames, LAN IP, LAN MAC, role, load, memory, channel and client count match the values that node announces | 待验证 |
| TOPO-2 | Disconnect a node's LAN and mesh radios | Rows move to offline before the cache expires; duplicate rows do not appear | 待验证 |
| TOPO-3 | Clone a LAN MAC on two devices | The duplicate/MAC-conflict finding is shown and the affected rows are explained | 待验证 |
| TOPO-4 | Leave one node on an announcement version without optional fields | Missing fields stay empty; the node is listed as incomplete, not guessed | 待验证 |
| TOPO-5 | Heavy memory use and a weak wireless-only link | Memory and weak-backhaul findings appear at the documented thresholds | 待验证 |
| TOPO-6 | Check the Diagnostics pages against `iwinfo`, `iw` and `ubus` | Signal, rate, channel, width, utilization and client counts are accurate and labelled with their source | 待验证 |

## 6. Global Backup & Restore

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| BAK-1 | Create a Full Backup | Archive is listed with the correct scope, size, checksum and timestamp | 待验证 |
| BAK-2 | Create Wireless, MLO, Mesh, Roaming and Custom backups | Each archive contains only its scope; the list labels it correctly | 待验证 |
| BAK-3 | Enable automatic backups and wait for two ticks | Both runs appear with `running`/`done`/`verified` states; a failure is visible instead of silent | 待验证 |
| BAK-4 | Download and re-upload a plain archive | Round trip succeeds; the stored copy passes the SHA-256 check | 待验证 |
| BAK-5 | Create an encrypted archive, download it, upload it on a clean device | Upload asks for the passphrase (`E-PASS` path), stores a `.tar.enc` with its sidecar and checksum, and the archive is listed, restorable, downloadable and deletable | 待验证 |
| BAK-6 | Upload a file larger than 16 MiB | The backend refuses it with a clear error; no partial file is stored | 待验证 |
| BAK-7 | Delete an archive and let age/count/size pruning run | Archive, `.sha256` and `.meta.json` are removed together; encrypted archives participate in pruning | 待验证 |
| BAK-8 | Restore each scope and check untouched scopes | Only the selected scope changes: restoring Mesh leaves the wireless and MLO interfaces as they were, restoring Wireless leaves the mesh backhaul interface and the mesh network intact, and a Full restore applies the complete network configuration; the pre-restore backup always exists | 待验证 |
| BAK-9 | Restore a Full Backup that changes the LAN address | The page may become unreachable; the worker still finishes and the device is reachable on the new address or the snapshot is restored | 待验证 |
| BAK-10 | Restore on intentionally incompatible hardware | Compatibility warnings are shown before confirmation and logged; the operator can cancel | 待验证 |
| BAK-11 | Upload an old Mesh Assistant archive | It is accepted under legacy support, listed with its legacy marker, and restorable without touching unrelated files | 待验证 |
| BAK-12 | Fill the backup volume and create an archive | The documented prune-first/insufficient-space behaviour is what the operator sees; no truncated archive is kept | 待验证 |
| BAK-13 | Corrupt an archive: truncate it, flip a byte inside the tarball, and separately edit the `.sha256` sidecar | Validation reports the checksum/size failure for the right archive; restore and delete-during-restore refuse it; the other archives and the current configuration are unaffected | 待验证 |
| BAK-14 | Change only mesh settings, then create a Full backup and inspect its manifest and file list | The archive covers every managed scope (wireless, MLO, mesh, backhaul, roaming and the network files), not only what changed; `backup_scope` in the manifest matches the files inside | 待验证 |
| BAK-15 | Change only an MLO link, then create a Full backup | The mesh configuration is present in the archive unchanged; restoring it leaves the mesh running with the MLO change intact | 待验证 |
| BAK-16 | Create and delete archives repeatedly (at least 30 cycles), then list the directory | No `.tmp.*` leftovers, no orphan `.sha256` or `.meta.json`, no archive listed that the filesystem does not contain, and the directory size returns to its baseline | 待验证 |

## 7. Driver and radio capability

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| RAD-1 | Open the Radios page on mt76, ath11k and ath10k | Bands, channels, widths and interface combinations match `iw phy info` | 待验证 |
| RAD-2 | Create a standalone MLO interface | EHT/MLO comes up with the expected links; a rejected combination rolls back cleanly | 待验证 |
| RAD-3 | Try 6 GHz and 320 MHz where the driver claims support | The UI and the driver agree; unsupported claims produce E-CAP/W-CAP rather than a false success | 待验证 |
| RAD-4 | Run a channel scan on a live AP | The confirmation names the radio; the measured interruption is recorded; the scan does not change configuration | 待验证 |
| RAD-5 | Scan neighbouring APs with `iw` unavailable | The iwinfo fallback produces usable results or a clear "unavailable" state | 待验证 |
| RAD-6 | Break a driver-reported capability on purpose (unsupported mode) | The pre-save check blocks or warns as documented; the save path still verifies the runtime interface | 待验证 |
| RAD-7 | Save an interface on a radio whose channel disagrees with the Mesh spectrum profile, and on two overlapping 2.4 GHz radios | W-CHAN-01/W-CHAN-02 appear in the pre-save confirmation; the Radios page reports the same codes and details | 待验证 |
| RAD-8 | Give two radios to an MLO link where one also carries an 802.11s interface, and put a link on a DFS channel | The save path reports W-CONC-03 and W-CHAN-03, not only the inventory; the MLO page shows the per-link checks with the real AP/STA mode | 待验证 |
| RAD-9 | Disable an interface that would otherwise clash, then open the Radios page | The disabled section does not produce a W-CONC warning; the Interfaces column shows the section, runtime name, mode and the MLO/Mesh-owned/disabled marks | 待验证 |
| RAD-10 | Create a STA (client) interface on a spare radio, associate it with an AP, then reboot and disconnect the AP | The interface saves and comes up in client mode as `iw`/`iwinfo` report; it re-associates after reboot; when the AP disappears the interface is reported as disconnected rather than as a configuration failure | 待验证 |

## 8. Restore and apply failure injection

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| FAIL-1 | Make a wireless commit fail during an interface save | The snapshot is restored; the interface list matches the pre-save state | 待验证 |
| FAIL-2 | Make a roaming apply fail after the UCI write | `wireless`, `dawn`, `dawn.managed`, `dawn.orig` and the DAWN running state are restored | 待验证 |
| FAIL-3 | Make a restore verification fail (no hostapd/DAWN/mesh) | The restore reports failure and rolls back from the snapshot; it does not claim success | 待验证 |
| FAIL-4 | Kill the worker during a backup or restore | The operation lock is released; a later run is not blocked; no half-written archive is listed | 待验证 |

## 9. Localization (DESIGN §17.8)

Switch the LuCI language in **System → System → Language and Style** and reload
the page; no package reinstall and no configuration edit may be needed.

| ID | Step | Expected result | Status |
| --- | --- | --- | --- |
| LOC-1 | Use the English interface | The menu entry, page titles and the Overview heading read **WiFi Manager** | 待验证 |
| LOC-2 | Switch to Simplified Chinese | The same places read **WiFi管家** | 待验证 |
| LOC-3 | Search the rendered zh-cn UI, menu definition and `po/zh_Hans` catalog for `WiFi管理` | It does not occur as a product name; `WiFi管家` is used consistently | 待验证 |
| LOC-4 | Compare the menu entry, every page title, the Overview heading and the in-page prompts | They all use the same product name; no page uses a different Chinese name | 待验证 |
| LOC-5 | Switch the language back and forth twice | The UI follows the language without reinstalling the package or changing `/etc/config/wifimanager`; the menu is correct after the LuCI reload | 待验证 |
| LOC-6 | After the switch, check the technical names | `ubus list` still shows the `wifimanager` namespace, `/etc/config/wifimanager` is unchanged, the package is still `luci-app-wifimanager` and module paths are untouched | 待验证 |

## 10. Sign-off

All of the following must be true before the 2.0.0 tag:

- [ ] Every P0 and core P1 item in the source audit is implemented.
- [ ] `node tests/run.js` passes with no failures.
- [ ] Every shell script passes `sh -n`.
- [ ] Both SDK builds (24.10 opkg and 25.12 apk) pass, and the artefacts were
      inspected for dependencies, file list, executable bits and conffiles.
- [ ] RPC / ACL review and shell safety review are recorded.
- [ ] README, both languages, release notes and the product-name check are
      complete.
- [ ] Every item in sections 0–9 above is either **passed with evidence** or
      explicitly accepted as a documented limitation by the release owner.
      Items still marked 待验证 block the release gate in DESIGN §19.

Sign-off record:

| Field | Value |
| --- | --- |
| Release owner | |
| Date | |
| Package version / release | 2.0.0-1 |
| Firmware images tested | |
| Result | |
| Open limitations accepted | |
