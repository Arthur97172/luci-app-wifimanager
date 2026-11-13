# WiFi Manager 2.0.0 — Release Notes

Release date: 2026-11-12

`luci-app-wifimanager` 2.0.0 turns the former wireless/MLO tool into a complete
wireless and mesh management application and absorbs the features of
`luci-app-meshassistant` 2.7.12. The package, UCI namespace, RPC object, ACL and
internal paths stay `wifimanager`. The English product name is **WiFi Manager**;
the Simplified Chinese product name is **WiFi管家** (replacing WiFi管理).

## Highlights

### Wireless and MLO

- Radio inventory with configured-versus-runtime channel and TX power; runtime
  values that cannot be read are shown as unavailable, not guessed.
- Interface and client pages, DFS and PHY mode handling, and unified radio
  allocation checks (`radio_check`) shared by the Wireless and MLO pages.
- Every interface save first runs the read-only `radio_check` (DESIGN §5.2):
  `E-*` findings block the save, `W-*` findings require an explicit "Save anyway"
  confirmation, and a failed check is itself shown before the operator decides.
- The interface editor shows advisory radio allocation: each radio is
  recommended (no other enabled interface), possible (shared with another
  interface or the mesh radio) or avoided (disabled, or an AP on the mesh
  radio), with an MLO pair suggestion across bands. It uses configuration and
  mesh settings only, never changes the selection, and never blocks a save.
- The Radios page offers an automatic channel recommendation. Candidates come
  from the driver (`iw phy info`), one scan is run only after the operator
  confirms that a running AP will briefly leave its channel, and the ranking
  weighs overlapping access points, DFS and the current utilization. The result
  is labelled as a snapshot with its assumed width; an empty scan is reported as
  no data. Nothing is applied automatically.
- A hardware-capability card on the Radios page lists the bands, usable
  channels, interface modes and interface combinations the driver reports
  through `iw phy info`; values the driver omits stay “not reported” instead of
  being inferred. `radio_check` uses the same data: a mode, band, PHY mode,
  interface mix or channel the driver explicitly refuses blocks the save
  (`E-CAP-01..05`), and a driver that reports no usable capability requires an
  explicit confirmation (`W-CAP-01`).
- The save path now runs the same channel rules as the inventory: `W-CHAN-01`
  (the Mesh spectrum profile disagrees with the radio channel), `W-CHAN-02`
  (overlapping 2.4 GHz channels) and, for MLO, `W-CHAN-03` (DFS link) are shown
  before saving. Disabled interfaces are excluded from concurrency counts, and
  MLO links send their real AP/STA mode so driver checks run for them too.
- The Radios page Interfaces column now shows each section's runtime name and
  mode with MLO, Mesh-owned and disabled marks instead of a bare section list.
- Interface create/edit for AP, STA, ad-hoc and standalone MLO, with a
  Wireless-scope pre-change backup, a private snapshot and rollback when
  commit or reload verification fails. Mesh-owned and 802.11s sections remain
  under the Mesh engine.
- Standalone MLO no longer depends on Mesh: it uses a generated `mloN` section
  and never edits the mesh-owned `wifi_ap_mlo`.
- MLO links are validated against band and PHY restrictions; same-band and
  same-radio conflicts are reported before they reach the driver.
- A read-only unified network check (`network_check`) for duplicate DHCP
  servers and pools, DNS conflicts, LAN IP/subnet conflicts, WAN/LAN bridging,
  duplicate default routes, firewall zones and mesh bridge membership. Results
  appear on the Overview and System diagnostics pages.

### Mesh and backhaul

- Roles `server`, `node` and `client` with explicit duties. The server provides
  DHCP/DNS; the client role is deliberately not bridged into the LAN.
- BATMAN-adv, 802.11s and hybrid backhaul. Ethernet backhaul is applied as a
  `batadv_hardif`; a port that belongs to another bridge or carries the WAN
  uplink is never taken over (checked by device through the firewall `wan`
  zone and the `wan`/`wan6`/`wwan` interfaces, with bridge devices expanded
  to their ports), and removing the backhaul restores the port and bridge
  state.
- Automatic backhaul switching (opt-in) follows the wired port carrier: the
  medium changes only after the configured fallback delay, returns only after
  the restore stability time, and switches at runtime through netifd without
  rewriting UCI. A failed switch keeps the current medium and is reported.
  Backhaul priority is measured by BATMAN-adv by default; manual per-hardif
  throughput overrides are also available.
- AP mode bridges WAN and disables the WAN firewall/DHCP roles with a recorded
  rollback path.
- Every mesh apply first takes a pre-change backup and a private snapshot of the
  files it may touch; a failed apply reverts staged UCI, restores the snapshot,
  reloads and reports the rollback instead of leaving a half-written mesh.
- Peer announcements were extended to protocol v9 and then v10 (older versions
  are still sent). v9 carries memory use, the connected-client count and the
  mesh ID, role, routing algorithm, channel, HT mode and band; v10 appends
  whether a mesh key is configured (`set`/`unset`) and the encryption mode name
  — the key itself is never transmitted. Every field is validated before it is
  stored. Older nodes simply ignore the new lines.
- Topology (solid = Ethernet, dashed = wireless), neighbor and originator
  tables, and service/config/runtime/link state kept separate. The links table
  shows memory and clients per device, and a consistency card compares the
  announced mesh ID, role, algorithm, channel, HT mode, key state and
  encryption mode. A per-node table adds
  MAC address, node role, CPU load and WiFi channel (with band) next to memory,
  clients, backhaul, link status, signal and rate, plus a node state derived from
  the freshest announcement, the backhaul media and the best signal (normal /
  weak signal / offline); values an older announcement does not carry stay empty.
  The mesh key is never transmitted and is therefore
  not compared; devices that announce nothing, or use an automatic channel, are
  listed instead of being reported as a mismatch.
- The backhaul runtime table names the radio behind each hardif and shows the
  TX/RX rates of the strongest wireless station next to the batman link rate;
  wired hardifs leave those cells empty.
- Wireless diagnostics show the signal and TX/RX rates of the strongest station
  per interface, and mesh diagnostics embed the backhaul runtime object.

### Roaming

- 802.11k/v/r written only when enabled; Wi-Fi reloads because hostapd reads
  these options at start.
- 802.11r exposes the mobility domain and the FT transport. Over-the-air remains
  the default; enabling FT over DS writes `ft_over_ds=1` and is described as
  requiring a wired path between all APs of the mobility domain. Fast transition
  itself is off unless the operator enables it: a missing `ft` option no longer
  means yes, matching the capability display and DESIGN §8.3.
- Applying roaming settings is a transaction: a Roaming-scope backup through the
  global Backup Manager and a private snapshot of `wireless`, `dawn` and the
  DAWN takeover files come first. A failed commit or DAWN start restores all of
  them, including whether DAWN was running, and records a rolled-back event. A
  DAWN service that does not come up after a successful write is reported as
  unverified.
- DAWN takeover keeps a 0600 copy of the previous configuration and a marker;
  DAWN stays stopped when wpad lacks 802.11v.
- A roaming event sampler records joins, leaves, roams and mesh link changes.
  Events carry the client MAC, source/destination AP, source/destination RSSI and
  attempt count; disconnect duration, reconnect duration and packet loss are not
  observable from the station table and are shown as unavailable instead of
  being estimated. Its gaps are documented in the UI instead of being presented
  as complete history.
- DAWN settings expose the steering decision mode, RSSI threshold, minimum
  client count and evaluation interval, plus watchdog state and the last restart.
- The roaming settings page shows read-only advice: k/v/r and mobility-domain
  consistency, BSSID validity and uniqueness for 802.11k, authentication
  consistency between APs of the same SSID for 802.11r, DAWN
  installation/state/watchdog, and per-band signal statistics (median and 10th
  percentile). Keys are compared through an opaque group index assigned on the
  router; the key or a hash of it is never returned. The access point table
  shows the BSSID in use and the interface runtime state. Threshold suggestions
  require at least five clients and a 10 dB difference from the configured pair;
  small samples are informational only. No value is ever written by the advice.
- The roaming settings page can scan neighbouring access points, one radio at a
  time. Every scan is confirmed first because it briefly takes the radio off
  its channel; it uses `iw dev scan` with an iwinfo fallback and compares each
  BSSID with the configured APs (our own BSSID, the same SSID with a different
  security family, another network). The result is labelled a one-moment
  snapshot and the scan is read-only.

### Backup and restore

- Backup & Restore is a top-level menu with Overview, Create Backup, Restore and
  Settings.
- Scopes: Full, Wireless, Mesh, Roaming and Custom. Archives contain a manifest,
  checksums and the selected configuration files only. MLO has no separate
  type: the Wireless type always includes the `mlo` area and is labelled
  “Wireless (includes MLO)”, which is what the MLO Backup acceptance item means.
- A custom selection is checked before creation: MLO needs Wireless, Mesh and
  backhaul need Wireless and Network, and Roaming needs Wireless; those are
  errors. DAWN without Roaming, and DHCP/DNS or Firewall without Network, are
  warnings shown in the form. The DAWN area archives `wireless`, `dawn` and
  `meshassistant`; a DAWN-only restore merges the wireless roaming options and
  replaces the DAWN file, so it changes `wireless` as well. A custom Roaming
  selection also replaces the Mesh Assistant file.
- The description entered on the Create page is stored in the manifest and shown
  in the Overview and Restore lists, in the details dialog and in the restore
  confirmation.
- Overview, Create and Restore carry an explicit card that distinguishes a WiFi
  Manager backup (selected configuration files, restore can interrupt the
  network) from an OpenWrt Sysupgrade backup (whole-system configuration applied
  during a firmware upgrade). WiFi Manager neither creates nor replaces a
  Sysupgrade backup, and even a Full archive is not a system image.
- Archives 0600, backup directory 0700, atomic temp+rename, size and count
  retention, optional AES-256-CBC encryption.
- Restore validates, checks compatibility, confirms scope, creates a full
  pre-restore backup, applies, verifies and rolls back to a snapshot on failure.
  It never restores the whole `/etc/config` by default. The pre-restore backup
  is unconditional and is no longer a setting; a stored opt-out is rewritten to
  on the next time the backup settings are saved.
- After applying, the restored configuration is brought into force before it is
  checked: network and Wi-Fi are reloaded, and a restored mesh is applied through
  the same path as the Mesh Settings page, so bat0, the mesh radio and DAWN match
  the restored files instead of the runtime that was just replaced. Verification
  then waits for hostapd (when APs are configured), bat0 (when the mesh is
  enabled) and DAWN (when it is managed), and fails the restore if one of them
  does not come up.
- A rollback deletes configuration files the restore created that were absent
  from the snapshot and commits only files that still exist, so a failed restore
  cannot leave behind a file the pre-restore state did not have.
- Retention runs before and after creation: the first pass makes room and lets
  the free-space check see it, the second counts the new archive. If that second
  pass would remove the new archive itself, creation is reported as failed
  instead of leaving a store over its limit.
- Restore compatibility warnings cover a different firmware
  distribution/version/target, a different radio count, radios that are missing
  or moved to another band or PHY path, and physical interface names that no
  longer exist. They appear in validation, in the archive details and with the
  restore confirmation, are logged by the restore and counted in its result;
  they are advisory and never block a restore by themselves. New archives
  record `radios[].path` and the physical `interfaces[]` for these checks.
- Restore checks UCI syntax on the archive before any change (a file that does
  not parse stops with nothing modified) and on the merged result after apply
  (a failure restores the snapshot and records a rolled-back event). Validation
  reports the same archive syntax errors before a restore is attempted.
- Least-privilege download through `/tmp/wifimanager-download`, with an explicit
  warning that an unencrypted archive contains Wi-Fi passphrases and the mesh key
  in clear text.
- Backup access is an independent `luci-app-wifimanager-backup` ACL scope: it can
  be granted without the wireless/mesh write methods, and the main scope holds no
  backup method and no direct file access.
- The overview compares the current in-scope files with the newest unencrypted,
  intact backup and marks changed, unchanged and unknown files.
- The outcome of the last automatic backup (timer, pre-change or pre-restore) is
  recorded with its time and operation name. The Overview shows a Succeeded or
  Failed badge and raises a warning after a failure; the timer's next-run
  calculation still uses only the last successful run, so a failure is retried.
- Legacy Mesh Assistant archives are listed and restored read-only. The
  original is never modified, deleted or lossily converted. Legacy archives
  must be imported explicitly; the upload endpoint refuses them.
- External storage discovery reads `/proc/mounts` and lists usable locations
  with filesystem, free space and writability. A `/mnt` or `/media` path is
  refused while nothing is mounted there, so an archive cannot silently land on
  the internal flash; `/tmp` is marked as lost on reboot. The page copies a
  suggested path into the field and saves only when the operator does.
- Encryption is hardened: AES-256-CBC with PBKDF2-SHA256 and 200000 iterations,
  a random salt, a 12–128 character passphrase policy, and a decrypt-and-hash
  round-trip check before a new archive is kept. The passphrase is never stored
  or logged. Decryption falls back to the older KDF parameters, so archives from
  an earlier 2.0.0 build still restore. An `encrypt_default` setting preselects
  encryption on the Create page without rewriting existing archives.

### Diagnostics and monitoring

- The system diagnostics page adds a unified diagnosis that combines load,
  memory, core/auxiliary service state, `network_check` findings, mesh runtime
  and roaming advice into one ranked list. Findings keep their source, code and
  severity; the raw cards stay below the report.
- The mesh topology page adds node states (normal, weak signal, offline) and
  monitoring findings: stale announcements, high memory use, a weak
  wireless-only backhaul, incomplete announcements from nodes older than v9,
  duplicate hostnames, two
  devices announcing the same LAN MAC, and an enabled mesh without peers. A node
  is offline once it has not announced for two minutes, while the peer cache
  keeps it for at most five minutes. All findings are advisory and never change
  configuration.
- Both are read-only and run only on page load and visible refresh.

### Platform

- One rpcd object with an allowlisted method list; no shell or command exposure
  to the browser. View code cannot use `fs.exec`, `child_process` or `eval`.
- Read and write ACLs are separate; no general `/etc/config` file grant.
- All privileged writes share one operation lock, with asynchronous operations
  reported through `op_status`.
- Simplified Chinese catalog with the product name WiFi管家 and English
  fallback for untranslated strings.
- Test suites for wifi, wireless, MLO, network, mesh, backhaul, roaming, backup,
  restore, migration, i18n and packaging, run with `node tests/run.js`.
- Builds verified with the OpenWrt 24.10.8 SDK (opkg, .ipk) and 25.12.5 SDK
  (apk, .apk): dependencies, file list, executable bits and the conffiles
  declaration were checked in the produced artefacts.

## Upgrade notes

- Existing `wifimanager` settings are preserved; only missing options are
  added. `/etc/config/wifimanager` is packaged as a conffile, so opkg and apk
  keep the operator's modified file across an upgrade.
- If Mesh Assistant is installed, the install validates its configuration,
  takes a full pre-migration backup, and stops and disables its daemon to avoid
  two managers writing the same UCI sections. The switch is recorded as a
  pending decision and shown on the Overview page, where the operator confirms
  it or restores the legacy service; restoring is refused while the WiFi
  Manager mesh is enabled. Its configuration and backups are untouched.
  Removing WiFi Manager re-enables the service.
- No configuration file is deleted during installation, upgrade or uninstall.
  DAWN is restored from its saved original only if WiFi Manager had taken it
  over.
- Old Mesh Assistant backups remain where they are and appear under Backup &
  Restore when legacy support is enabled.

## Compatibility

- OpenWrt LuCI 2.x (JavaScript views), `rpcd` with `jshn` and `jsonfilter`.
- BATMAN-adv requires `kmod-batman-adv`, `batctl-default` and
  `luci-proto-batman-adv`.

## Known limitations / verification status

The implementation is complete at source level and covered by automated tests,
but the following are **pending hardware verification**. The item-by-item gate
and the evidence to record for each item are in
`docs/06-RELEASE-VERIFICATION.md`; a release must not be tagged while any gate
row is still 待验证:

- Installing, uninstalling and upgrading the produced .ipk/.apk on a real
  device (the compile and the artefact inspection were done with local SDKs).
- Interface create/edit on real drivers (reload, driver-assigned names,
  standalone MLO EHT and rollback after failed verification) and network-check
  results on real DHCP/DNS/firewall configurations.
- MLO, 6 GHz and 320 MHz behavior on mt76, ath11k and ath10k.
- Mesh throughput, convergence and roaming on specific firmwares.
- wpad 802.11v support with DAWN and event sampling under load.
- The complete upgrade and rollback path from 1.0.0 / Mesh Assistant 2.7.12.
- Behavior when a restore changes the LAN address and the page becomes
  temporarily unreachable.
- `radio_check` and the Radios capability card against real driver `iw phy info`
  matrices (mt76, ath11k, ath10k and others), including the E-CAP / W-CAP-01
  flow when a driver cannot report its capability or concurrency limits.
- `iw station dump` rate units and availability across drivers, and DAWN
  parameter behavior and watchdog restarts on real wpad builds.
- v10 consistency comparisons in a mixed-version network (including key state
  and encryption mode), and the changed-file
  indicator while a modification is still in progress.
- The duration and client impact of a channel scan on real drivers, and how
  accurate a one-snapshot ranking with the configured width assumption is.
- The duration, client impact and channel coverage of a neighbouring AP scan on
  real drivers, including the iwinfo fallback when `iw` is unavailable.
- What the radio advice shows when the driver rejects an advised combination.
- Real station signal sampling and announcement freshness under clock skew for
  the roaming advice and topology monitoring thresholds, including whether a
  node that goes silent is shown offline after about two minutes and stays
  visible until the five-minute peer cache drops it.
- The actual mount layout of the target router and the behavior when a volume
  disappears after the backup path was saved.
- PBKDF2, the decrypt fallback and the round-trip check on the OpenSSL build the
  firmware ships.

## 简体中文摘要

WiFi管家 2.0.0 将无线 / MLO 管理升级为完整的无线与 Mesh 管理平台，并合并
Mesh Assistant 2.7.12 的 Mesh、回程和漫游功能。

- 新增 MLO 校验、统一 Radio 分配检查、Mesh 三角色、混合回程、DAWN 与漫游事件。
- 通告协议升级到 v9 并在 v10 追加 Mesh 密钥状态（已配置/未配置，密钥本身从不发送）
  与加密方式，携带内存、客户端数与 mesh 参数，拓扑页据此对比一致性（含密钥状态与
  加密方式）；回程运行表与无线诊断补充 Radio、信号和 TX/RX 速率。拓扑页每台设备
  新增 MAC 地址、节点角色、CPU 负载与 WiFi 信道列；旧通告没有的值留空，不做推测。
- 备份新增独立 ACL、变更指示与下载明文警告；概览显示最近一次自动备份的成功/失败
  结果、时间与操作名称，失败时给出警告。DAWN 新增引导参数与看门狗状态，
  漫游事件标明可观察与不可观察字段。备份类型仍为五种，Wireless 始终包含 MLO，
  没有单独的 MLO 类型。
- 漫游应用改为事务：先创建 Roaming 作用域备份并快照 wireless、DAWN 与接管文件，
  提交或 DAWN 启动失败时全部回滚（含 DAWN 运行状态）；写入成功但 DAWN 未启动时
  报告为未验证。802.11r 的 Mobility Domain 与 FT 传输方式（空口 / DS）可配置，
  默认仍为空口；FT over DS 需要漫游域内各 AP 之间存在有线路径。802.11r 本身默认
  关闭，只有显式启用才会写入，与管理页的能力显示一致（DESIGN §8.3）。
- 恢复新增兼容性提示：固件发行版/版本/目标平台、Radio 数量、Radio 缺失或频段/
  PHY 路径变化、物理接口名不存在；提示显示在校验、详情与确认页，并写入恢复日志，
  但不会单独阻止恢复。新归档记录 `radios[].path` 与物理 `interfaces[]`。
- 创建时填写的描述随清单保存，并在概览、恢复列表、详情与确认页显示；概览、创建与
  恢复页明确区分 WiFi管家备份与 OpenWrt Sysupgrade 备份：前者只覆盖所选配置文件，
  恢复可能中断网络；后者由固件升级机制处理，本应用既不创建也不替换，即使“完整备份”
  也不是系统镜像。
- 接口编辑新增电台分配建议（推荐/可用/避免与 MLO 组合，仅作参考、不改变选择）；
  电台页新增信道建议，扫描前需确认，结果标注快照、带宽假设与 DFS 注意事项。
- 电台页新增“硬件能力”卡片，直接列出驱动经 `iw phy info` 报告的频段、可用信道、
  接口模式与接口组合，驱动未报告的项显示为“未报告”；保存接口时，驱动明确不支持
  的接口模式、频段、PHY 模式、接口组合或信道以 E-CAP-01…05 阻止保存，无法读取
  驱动能力时需操作者明确确认（W-CAP-01）。保存路径现在与 Radio 清单使用同一套
  信道规则：Mesh 频谱覆盖与 Radio 信道不一致（W-CHAN-01）、2.4 GHz 邻道重叠
  （W-CHAN-02）以及 MLO 链路使用 DFS 信道（W-CHAN-03）都会在保存前提示；被禁用的
  接口不计入并发统计，MLO 接口按真实 AP/STA 模式执行驱动检查。Radio 页的接口列
  显示运行时接口名、模式以及 MLO、Mesh 归属和禁用标记。
- 漫游设置页新增邻近 AP 扫描，每次按 Radio 扫描前需确认（运行中的 AP 会短暂离开
  信道）；优先 `iw dev scan`，失败时回退 `iwinfo`，把每个 BSSID 与已配置 AP 对比
  （本机、同名但安全方式不同、其他网络），结果标注为某一时刻的快照，只读不写配置。
- 漫游设置页新增只读建议：检查 k/v/r、mobility domain、802.11k BSSID 有效性
  （单播、非零且不重复）、同一 SSID 下各 AP 的认证一致性（密钥只按不透明分组比较）
  与 DAWN 状态；接入点表显示当前 BSSID 与接口运行状态；统计各频段
  信号中位数和 10% 分位；样本至少 5 个客户端且与现配置相差 10 dB 才给出阈值建议。
- 拓扑页新增节点状态（正常 / 信号较差 / 离线）与监控提示：通告过期、内存过高、
  仅无线回程信号偏弱、通告不完整、设备重名、两台设备通告同一局域网 MAC 与 Mesh
  已启用但无邻居；超过两分钟没有通告即标记为离线（缓存最多保留五分钟），只作提示，
  不改变配置。
- 系统诊断页新增统一诊断，汇总负载、内存、服务、网络配置、Mesh 运行时与漫游建议，
  按严重程度排序；只读且不阻止保存或恢复。
- 备份设置页读取挂载表并列出可用存储位置；`/mnt`、`/media` 路径在没有挂载卷时被
  拒绝，避免写入内部 flash。加密升级为 AES-256-CBC + PBKDF2-SHA256（200000 次
  迭代），口令至少 12 字符且从不保存，创建后解密校验哈希，旧归档仍可恢复。
- 混合回程新增 WAN/LAN 冲突检查：承载 WAN 上行的端口按设备识别（防火墙 `wan`
  区以及 `wan`/`wan6`/`wwan`，桥接设备展开为实际端口），不会被移入 bat0，
  编辑页也不列出这些端口。
- 混合回程新增可选的自动切换：按有线端口载波去抖，断线超过回退延迟后切换，
  恢复稳定后回切；切换在运行时经 netifd 完成，不改写配置，失败时保留当前回程。
  回程优先级默认由 BATMAN-adv 测量，也可按硬接口手动设置吞吐量覆盖。
- 无线接口页可创建和编辑 AP/STA/ad-hoc/独立 MLO 接口；保存前先执行只读的
  radio_check（错误阻止保存，无法确认的并发需明确确认），随后自动备份，失败
  回滚，Mesh 管理的接口保持只读。新增只读的 DHCP/DNS/IP/路由/防火墙/Mesh
  桥接冲突检查。
- 备份与恢复成为一级菜单，支持 Full/Wireless/Mesh/Roaming/Custom 作用域、
  每次恢复前强制创建完整备份（不可关闭，旧配置中的关闭项在保存设置时改回开启）、
  失败回滚和只读的旧版兼容；归档与应用后的配置都会检查 UCI 语法，
  语法错误不会被提交。恢复后先按恢复的配置重新加载网络与无线，Mesh 启用时走与
  Mesh 设置页相同的应用路径，再校验 hostapd、bat0 与 DAWN 确实运行；失败回滚会
  删除恢复过程中新建、快照中不存在的配置文件并重新加载。保留策略在创建前后各执行
  一次，新归档不会让存储超出数量、容量或保留期限；自定义作用域创建前检查依赖：
  MLO 需要无线，Mesh/回程需要无线与网络，漫游需要无线（错误）；只选 DAWN 或只选
  DHCP/防火墙时给出警告。
  DAWN 区域归档 wireless、dawn 与 meshassistant，仅选 DAWN 的恢复也会合并无线
  漫游选项并替换 DAWN 文件；自定义漫游还会替换 meshassistant。
- 检测到 Mesh Assistant 时，安装过程校验旧配置、创建迁移前备份并停止旧守护进程，
  切换记录为待确认，由操作者在概览页确认或恢复旧服务；Mesh 启用期间拒绝恢复。
- 旧配置与旧备份不会被删除或覆盖；安装时只补齐缺失项。
- 所有特权操作经过白名单 RPC 与最小权限 ACL，前端没有任意命令执行能力。
- 自动化测试覆盖无线、MLO、Mesh、回程、漫游、备份、恢复、迁移、本地化和打包。
- 已用 OpenWrt 24.10.8 SDK（opkg，.ipk）与 25.12.5 SDK（apk，.apk）实际编译，
  并检查产物中的依赖、文件清单、可执行位与 conffiles 声明；`/etc/config/wifimanager`
  声明为 conffile，升级不覆盖操作者配置。

真机驱动、`iw phy info` 能力解析、邻近 AP 扫描、6 GHz/320 MHz、具体 Mesh 固件升级路径，以及产物的安装/卸载/升级等仍需在设备上验证。
