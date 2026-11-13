# WiFi管家 2.0.0

`luci-app-wifimanager` 2.0.0 将原先的无线 / MLO 管理页与 `luci-app-meshassistant`
2.7.12 的 Mesh、回程与漫游能力合并为一个 LuCI 应用：**WiFi管家**（英文界面为
**WiFi Manager**）。软件包名、UCI 命名空间、RPC 对象、ACL 和内部代码路径仍为
`wifimanager`，不会因产品显示名称变化而改变。

> 本版本已通过源码级检查与自动化测试；无线驱动、6 GHz/320 MHz、具体 Mesh 固件
> 行为和真机升级路径仍需在真实设备上验证，见文末“验证状态”。

## 功能总览

- **无线**：Radio 清单、配置与运行时信道/TX 功率对照、接口创建与编辑、客户端、
  统一分配检查。接口页可编辑 AP/STA/ad-hoc 的通用、安全与高级字段；保存前先
  执行 radio_check，错误阻止保存、无法确认的并发需操作者明确确认，随后自动备份，
  重载失败时自动回滚；Mesh 管理的接口保持只读。接口编辑对话框还会根据配置中的
  接口占用给出电台分配建议（推荐/可用/避免）和 MLO 组合建议，仅作参考，不会自动
  改变选择。电台页可按需扫描并给出信道建议：扫描前需确认（运行中的 AP 会短暂
  离开信道），结果明确标为快照、假设带宽与 DFS 注意事项。电台页的“硬件能力”
  卡片直接列出驱动从 `iw phy info` 报告的频段、可用信道、接口模式与接口组合，
  驱动没有报告的项显示为“未报告”，不做推测；保存接口时，驱动明确不支持的接口
  模式、频段、PHY 模式、接口组合或信道会以 E-CAP-01…05 阻止保存，无法读取驱动
  能力时则要求操作者确认（W-CAP-01）。保存前还会检查 W-CHAN-01/02/03：Mesh 频谱
  覆盖与 Radio 信道不一致、两个 2.4 GHz Radio 信道重叠、MLO 链路使用 DFS 信道；
  被禁用的接口不计入并发统计。Radio 页的接口列显示段名、运行时接口名、模式以及
  MLO/Mesh 归属，不再只列段名。
- **MLO**：按频段和 PHY 模式校验多链路组合，检查同频段、同 Radio 冲突和
  Wi-Fi 7 / EHT 前提条件；可独立于 Mesh 创建和编辑 MLO 接口。
- **网络检查**：统一检查 DHCP 服务器与地址池、DNS、LAN IP、WAN/LAN 桥接、
  默认路由、防火墙 Zone 和 Mesh 桥接关系；只读，不修改配置。
- **Mesh**：`server` / `node` / `client` 三种角色；BATMAN-adv、802.11s 与混合回程；
  server 提供 DHCP/DNS，client 不桥接 `bat0`，避免形成环路。应用前自动备份并保存
  私有快照，应用失败时自动恢复快照并记录回滚。
- **回程**：以太网回程使用 `batadv_hardif`，不会抢占其他网桥的端口，也不会使用
  承载 WAN 上行的端口（按设备检查防火墙 `wan` 区以及 `wan`/`wan6`/`wwan`，
  桥接设备展开为实际端口，避免把上行设备移入 bat0 导致断网；编辑页同样不列出
  这些端口）；无线回程复用
  802.11s；可选自动切换（按载波状态去抖，断线超过回退延迟后切换，恢复稳定后回切，
  运行时经 netifd 切换且不改写配置，失败时保留当前回程）；优先级默认由 BATMAN-adv
  测量，也可手动写入吞吐量覆盖；运行表同时列出每个硬接口背后的 Radio 以及最佳
  站点的 TX/RX 速率；AP 模式会桥接 WAN 并关闭 WAN 防火墙/DHCP 角色。
- **漫游**：802.11k/v/r 与 DAWN；802.11r 可配置 Mobility Domain 和 FT 传输方式
  （空口或分发系统 DS，默认空口；hostapd 每个接口只支持一种传输方式），
  不允许无条件启用。每次应用前先经全局备份管理器创建 Roaming 作用域备份，
  并对 `wireless`、`dawn` 及 DAWN 接管文件做私有快照；提交或 DAWN 启动失败时全部
  回滚（包括服务运行状态）。写入成功但 DAWN 未启动时报告为“未验证”，而不是完成。
  接管 DAWN 前保存原配置，缺少 802.11v 时不启动 DAWN；
  漫游事件采样器记录加入、离开、漫游和 Mesh 链路变化；事件包含客户端 MAC、源/目标
  AP 与 RSSI 等可观察字段，无法观察的断开/重连时长与丢包率明确标为不可用。DAWN 的
  引导参数、看门狗状态与最近重启记录在漫游与 DAWN 页面。漫游设置页另有只读建议：
  检查 k/v/r、mobility domain、802.11k 的 BSSID 有效性（必须是单播非零地址且各 AP
  不重复）、同一 SSID 下各 AP 的认证一致性（加密方式、PMF、RADIUS 与密钥；密钥只按
  不透明分组比较，值不离开路由器）以及 DAWN 状态，统计各频段客户端信号的中位数和
  10% 分位，样本达到 5 个客户端时才给出阈值建议（强制至少 10 dB 间隔），且从不写入
  配置。接入点表同时显示正在使用的 BSSID 与接口运行状态。漫游设置页还可按
  Radio 扫描邻近 AP：每次扫描前需确认（运行中的 AP 会短暂离开信道）；扫描优先
  使用 `iw dev scan`，失败时回退到 `iwinfo`，把每个 BSSID 与已配置的 AP 对比
  （本机、同名但安全方式不同、其他网络），并明确标为某一时刻的快照；结论只作
  提示，不写入配置。
- **拓扑与邻居**：以实线表示以太网、虚线表示无线；邻居、originator 与可达设备分列，
  无法读取的运行时值明确显示为不可用，而不是猜测。通告协议 v9 增加内存使用率、
  客户端数和 mesh 参数（mesh ID、角色、路由算法、信道、HT 模式、频段），拓扑页
  显示这些列并对比各节点通告的 mesh 参数；mesh 密钥从不传输，因此不参与对比。
  每台设备一行显示主机名、节点状态（正常 / 信号较差 / 离线）、MAC 地址、IPv4、
  节点角色、CPU 负载、内存、WiFi 信道、客户端数、回程类型、链路状态、信号和
  速率；设备未通告的值保持空白，不做推测。节点状态由最新通告的时间、回程介质与
  最佳信号得出：仅无线回程且信号弱于 −75 dBm 为“信号较差”，超过两分钟没有通告
  为“离线”（节点在通告缓存中最多保留五分钟，之后不再列出）。
  拓扑页还汇总监控结果：通告过期（30 秒警告、120 秒错误）、内存占用过高、仅有
  无线回程且信号弱于 −75 dBm、通告字段不完整、不同设备重名、两台设备通告同一
  局域网 MAC 以及 Mesh 已启用但没有邻居；这些结论只作提示，不改变任何配置。
- **备份与恢复**：全局备份管理器，作用域 Full / Wireless / Mesh / Roaming / Custom；
  Wireless 类型始终包含 MLO，没有单独的 MLO 备份类型（界面标为“Wireless（包含
  MLO）”）。恢复前自动备份、失败回滚、完整性校验和只读的旧版 Mesh Assistant 备份
  兼容。备份权限位于独立的 ACL scope，可单独授予；概览页对比当前配置与最新备份并
  标出变更，同时显示最近一次自动备份的成功/失败结果、时间与操作名称；
  下载前提示归档含有明文 Wi-Fi 密码与 mesh 密钥。设置页从 `/proc/mounts` 读取挂载表，
  列出可用存储位置、文件系统、剩余空间与可写状态；选择 `/mnt`、`/media` 路径时若
  没有挂载卷会被拒绝，避免归档悄悄写入内部 flash。加密使用 AES-256-CBC 与
  PBKDF2-SHA256（200000 次迭代），口令至少 12 个字符且从不保存；创建后会解密并
  校验哈希，旧版本归档仍可用原口令恢复。创建时填写的描述随清单保存，并在概览与
  恢复列表中显示。概览、创建与恢复页明确区分 WiFi管家备份与 OpenWrt Sysupgrade
  备份：前者只覆盖所选配置文件，恢复会替换或合并这些文件并可能中断网络；后者由
  固件升级机制处理，本应用既不创建也不替换它，即使“完整备份”也不是系统镜像。
- **诊断**：无线、Mesh、系统与日志四个页面，分别展示配置、运行时、服务与链路状态；
  无线页显示最佳站点的信号与 TX/RX 速率，Mesh 页内嵌回程运行状态。系统页新增
  “统一诊断”，把负载、内存、服务状态、网络配置检查、Mesh 运行时与漫游建议汇总为
  一个按严重程度排序的结论列表；它只读、只作提示，不阻止保存或恢复。

## 菜单结构

```text
网络 → WiFi管家
├── 概览
├── 无线
│   ├── 无线电
│   ├── 接口
│   ├── MLO
│   └── 客户端
├── Mesh
│   ├── 设置
│   ├── 拓扑
│   ├── 邻居
│   └── 回程
├── 漫游
│   ├── 设置
│   ├── DAWN
│   └── 事件
├── 备份与恢复
│   ├── 概览
│   ├── 创建备份
│   ├── 恢复
│   └── 设置
└── 诊断
    ├── 无线
    ├── Mesh
    ├── 系统
    └── 日志
```

备份与恢复是一级菜单，不再位于 Mesh 之下。

## 安装

### 从 Releases 安装

1. 打开 [Releases](https://github.com/Arthur97172/luci-app-wifimanager/releases)
   页面，下载与固件版本对应的安装包。
2. 把安装包上传到设备（例如 `/tmp`），然后安装：

   **OpenWrt / ImmortalWrt 24.10 及更早（opkg）**

   ```sh
   opkg install /tmp/luci-app-wifimanager_*.ipk

   #可选，安装简体中文语言包：
   opkg install /tmp/luci-i18n-wifimanager-zh-cn_*.ipk
   ```

   **OpenWrt / ImmortalWrt 25.12+（apk）**

   ```sh
   apk add --allow-untrusted /tmp/luci-app-wifimanager-*.apk

   #可选，安装简体中文语言包：
   apk add --allow-untrusted /tmp/luci-i18n-wifimanager-zh-cn-*.apk
   ```

3. 刷新 LuCI，入口出现在「网络 → WiFi管家」。

> 未安装语言包时界面显示英文（菜单为「WiFi Manager」）。安装包架构无关
> （ipk 记为 `all`，apk 记为 `noarch`），ARM / x86 / MIPS 等平台通用；
> `luci-base`、`rpcd-mod-iwinfo`、`kmod-cfg80211`、`kmod-batman-adv`、
> `batctl-default`、`luci-proto-batman-adv`、`iw`、`socat`、`flock`、`jshn`、
> `openssl-util`（加密备份）等依赖由软件源提供，固件源缺少其中任何一个时
> 安装会被拒绝。

### 从源码编译

```sh
cd openwrt
./scripts/feeds update -a
./scripts/feeds install -a
git clone https://github.com/Arthur97172/luci-app-wifimanager.git package/luci-app-wifimanager
make menuconfig     # LuCI → Applications → luci-app-wifimanager
make package/luci-app-wifimanager/compile V=s
```

编译产物位于 `bin/packages/<架构>/base/` 目录下，主包和
`luci-i18n-wifimanager-zh-cn` 会一并生成。

本包已用 OpenWrt 24.10.8 SDK（mediatek/filogic，gcc 13.3.0）和 25.12.5 SDK
（gcc 14.3.0）实际编译通过，分别产出 `luci-app-wifimanager_2.0.0-r1_all.ipk`
与 `luci-app-wifimanager-2.0.0-r1.apk`。产物检查确认依赖、文件清单和可执行位
（init.d、uci-defaults、rpcd 插件、worker.sh）正确，且 `/etc/config/wifimanager`
以 conffiles 声明，升级时会保留操作者已修改的配置。

ImmortalWrt 是 OpenWrt 的下游发行版，LuCI 与软件包接口一致，本包没有依赖仅在
OpenWrt 上才有的接口。但尚未在 ImmortalWrt 上编译或运行，因此对该平台的支持标记为
“待验证”：请用对应 ImmortalWrt SDK 编译，并按 `docs/06-RELEASE-VERIFICATION.md`
的检查清单验收后再视为可用。

安装或升级时 `90-luci-wifimanager` 只补齐缺失的默认项，不覆盖已有 UCI 值，也不删除
`/etc/config/meshassistant` 或旧备份。检测到 Mesh Assistant 时，安装过程会先校验旧配置、
创建迁移前完整备份并停止旧守护进程，然后把这步切换记录为“待确认”，不替操作者做决定：
概览页会显示迁移卡片，操作者可以“确认迁移”，或用“恢复旧服务”改回 Mesh Assistant
（WiFi管家 Mesh 启用期间拒绝恢复，避免两个管理器同时运行）。旧服务是在本包安装时
被停止的，卸载本包时由 `postrm` 恢复。

## 备份与恢复

状态目录：

| 路径 | 用途 |
| --- | --- |
| `/etc/wifimanager/backup` | 新格式备份归档（0600，目录 0700） |
| `/etc/wifimanager/logs` | WiFi管家日志与漫游事件（0600） |
| `/etc/wifimanager/runtime` | 操作锁、op 状态、邻居缓存 |
| `/etc/wifimanager/config` | DAWN 等第三方配置的原件 |

备份作用域：

| 类型 | 包含的区域 |
| --- | --- |
| Full | wireless、mlo、mesh、backhaul、roaming、dawn、network、dhcp、firewall、system、wifimanager |
| Wireless | wireless、mlo |
| Mesh | mesh、backhaul |
| Roaming | roaming、dawn |
| Custom | 由操作者逐项选择 |

安全约束：

- 每个归档包含 `manifest.json`、`checksums.txt` 和 `etc/config/*`；归档与校验文件
  权限为 0600，备份目录为 0700。
- 备份名称、ID 和存储路径均校验，拒绝 `..`、符号链接和存储目录之外的路径。
- 可选密码加密（`openssl enc -aes-256-cbc -pbkdf2`）；密码只通过 0600 临时文件传递，
  写入日志前即被删除，前端不回显。
- 恢复流程：校验归档 → 格式、兼容性与 UCI 语法检查 → 作用域确认 → 创建恢复前备份 →
  操作者勾选确认 → 应用 → 语法复检 → 验证网络/无线状态 → 失败时回滚快照。
- 兼容性提示会指出固件发行版/版本/目标平台不同、Radio 数量不同、Radio 缺失或频段/
  PHY 路径变化，以及归档中的物理接口名在本机不存在。提示会显示在确认页与归档详情中，
  恢复时写入日志并计入结果消息，但不会单独阻止恢复。
- 归档中或合并后有不合法 UCI 语法的文件不会被提交：应用前的语法检查直接终止并以
  “未做任何修改”结束，应用后的复检失败则恢复快照并记录回滚事件。
- 恢复只替换或合并备份清单内的配置文件，**不会默认覆盖整个 `/etc/config`**。
  不同作用域按 section 合并，避免无线恢复破坏 Mesh，反之亦然。
- 下载通过固定目录 `/tmp/wifimanager-download` 完成，ACL 只授予该目录的读权限。

旧版兼容：

- `/etc/meshassistant/backup` 中的归档以 Legacy 类型只读列出，可校验和恢复。
- Legacy 归档在读取时转换清单，原文件永不被改写、删除或“有损转换”。
- “复制旧版备份”会创建一个带新清单的副本，原归档保持不变；上传接口拒绝 Legacy
  类型，必须使用显式导入动作。

## 安全模型

- 所有特权操作只经过 rpcd 插件 `wifimanager` 的白名单方法；视图不能调用
  `fs.exec`、`child_process` 或任意命令。
- ACL 只授予只读方法和动作方法，读写分离；不授予 `/etc/config` 的通用文件访问。
- 后端参数通过 `jsonfilter` 读取，ID、路径、SSID、密钥和主机名在写入 UCI 前校验。
- 备份/恢复与 Mesh/漫游写入在同一个运行锁下串行化，避免并发修改。
- 日志和界面不输出密码、密钥或归档口令。

## 测试

```sh
node tests/run.js
```

或单独运行：

```sh
node tests/run.js backup
```

套件覆盖 `wifi`、`wireless`、`mlo`、`network`、`mesh`、`backhaul`、`roaming`、
`diagnosis`、`backup`、`restore`、`migration`、`i18n`、`package`。测试使用 Node 内置 `vm`
加载 LuCI 模块，不需要 OpenWrt 构建树；同时检查菜单、ACL、RPC 方法一致性、
JSON、Shell/JS 语法、备份权限、密码处理和中文翻译目录。

## 验证状态

已在源码层面实现并通过自动化测试：

- 菜单、视图、RPC、ACL、UCI 默认值和翻译目录一致。
- 备份权限、原子写入、加密路径、只读 Legacy 兼容和恢复回滚逻辑。
- 恢复作用域选择与 section 合并规则。
- 恢复的 UCI 语法检查：应用前检查归档、应用后复检合并结果，失败时恢复快照。
- Mesh 应用前的私有快照与失败回滚（Shell 仿真与源码契约）。
- 漫游应用事务：Roaming 作用域备份、wireless/DAWN/接管文件快照、提交或 DAWN
  启动失败时回滚，以及 DAWN 启动验证（源码契约）。
- 恢复兼容性提示：固件、Radio 数量、Radio 频段/路径与接口名差异，覆盖校验、
  详情与恢复日志（源码契约）。
- Mesh Assistant 迁移的校验、迁移前备份、待确认状态、确认与恢复旧服务的限制，
  以及 RPC/ACL/概览页的对应入口。
- 无线接口编辑的字段校验、独立 MLO 规则、Mesh 接口保护和失败回滚分支
  （Shell 仿真与源码契约）。
- 网络冲突检查的每一类代码、只读属性、DSA/旧式桥接识别与角色判断
  （Shell 仿真与源码契约）。
- 回程自动切换的载波判断、回退/恢复去抖、配置操作锁、失败时保留当前回程与
  事件记录（Shell 仿真与源码契约）。
- 有线回程的 WAN 设备识别（防火墙 `wan` 区、`wan`/`wan6`/`wwan`、桥接设备展开）
  与端口保护，以及编辑页候选列表和已保存端口告警（Shell 仿真与源码契约）。
- 通告协议 v9 的发送与解析校验、mesh 参数一致性对比、回程运行表的 Radio 与
  站点速率、无线诊断的信号与收发速率（源码契约）。
- DAWN 参数映射与看门狗状态、漫游事件字段与不可观察字段的标记。
- 备份的独立 ACL、变更指示、下载明文警告，以及保存前的只读 radio_check。
- 电台分配建议的判定规则（推荐/可用/避免、编辑中的接口不计入占用、MLO 跨频段
  组合与同频段提示）和信道评分的排序规则（频段过滤、重叠权重、DFS 惩罚、
  当前占用率、空扫描与保留当前信道）；两个接口均为只读 RPC，ACL 只授读权限。
- 漫游建议、拓扑监控与统一诊断的规则（阈值对、mobility domain、k/v/r、DAWN
  看门狗、样本统计与 5 客户端下限、通告过期与内存阈值、设备分组、负载/内存/
  服务严重程度、findings 排序与计数）；三个模块都是纯分类层，只读且不写 UCI。
- `iw phy info` 能力解析：频段、可用信道、接口模式与接口组合的解析，组合语义
  （同一组内模式相加；组合未提及的模式不允许）以及 E-CAP-01…05 与 W-CAP-01
  只在驱动明确报告或明确缺失时触发；电台页“硬件能力”与接口编辑器并发提示的
  展示规则（Shell 仿真与源码契约）。
- 邻近 AP 扫描：iw 与 iwinfo 输出归一化、安全方式按家族比较、同名 SSID 但安全
  不一致的判定、空扫描与失败扫描不产生结论，以及扫描 RPC 的只读 ACL 与视图
  契约（Shell 仿真与源码契约）。
- 外部存储发现使用模拟挂载表验证；加密使用源码契约验证 PBKDF2-SHA256、
  200000 次迭代、12 字符口令下限、解密回退与创建后的哈希校验。
- 打包：24.10.8 SDK 的 .ipk 与 25.12.5 SDK 的 .apk 实际编译通过，产物中的依赖
  列表、文件清单、可执行位与 conffiles 声明逐项检查（`/etc/config/wifimanager`
  已声明为 conffile，升级不覆盖操作者设置）。

**待验证（需要在真实设备上确认）**：

- 产出的 .ipk / .apk 在真实设备上的安装、卸载与升级（编译与产物检查已在本机
  SDK 完成）。
- 无线接口创建/编辑在真实驱动上的重载、运行时接口名、独立 MLO 的 EHT 行为，
  以及重载失败时的回滚效果。
- 网络冲突检查在真实 DHCP/DNS/防火墙配置上的结果。
- 不同驱动（mt76、ath11k、ath10k 等）下的 MLO、6 GHz 和 320 MHz 行为。
- 具体固件上 BATMAN-adv / 802.11s 的吞吐、收敛时间与漫游体验。
- 真实驱动上的载波抖动、bat0 硬接口分离/重新附加延迟，以及回程切换后的
  BATMAN-adv 收敛时间。
- wpad 的 802.11v 支持与 DAWN 的配合，以及大量客户端时的事件采样精度。
- 从 1.0.0 / Mesh Assistant 2.7.12 升级的完整安装、卸载和回退路径。
- 恢复过程中 LAN 地址变化导致页面暂时不可达时的实际表现。
- radio_check 与电台页“硬件能力”卡片在真实驱动（mt76、ath11k、ath10k 等）
  `iw phy info` 输出上的解析结果，以及驱动无法报告能力时，操作者看到的
  E-CAP / W-CAP-01 流程是否符合预期。
- iw station dump 的速率字段在不同驱动上的单位与可用性，以及 DAWN 参数写入
  后 hostapd/dawn 的实际行为与看门狗重启。
- 混合版本节点网络中 v9 通告的一致性对比结果，以及备份变更指示对正在进行
  中的修改的判断。
- 真实驱动与固件上信道扫描的耗时和客户端中断长度，以及扫描快照、配置带宽
  假设和空闲信道判断在实际环境中的准确性；电台分配建议在驱动不支持所建议
  并发组合时的实际表现。
- 邻近 AP 扫描在不同驱动上的耗时、可扫描信道覆盖与结果准确性（包括 iw 不可用
  时回退 iwinfo 的行为），以及扫描对在线客户端的影响。
- 真实客户端信号采样、时钟偏差下的通告新鲜度，以及漫游建议和拓扑监控阈值
  在实际 Mesh 中的表现。
- 节点断电或停止通告后，拓扑页是否在约两分钟标记“离线”、并在五分钟通告缓存
  窗口内保持列出，之后才随缓存删除。
- 目标路由器实际的挂载布局，以及备份路径保存后存储卷消失时的行为。
- 固件所用 OpenSSL 构建上 PBKDF2、解密回退和加密后哈希校验的实际结果。

## 文档

- `docs/00-SOURCE-AUDIT.md` — 源码审计
- `docs/01-FEATURE-MIGRATION-MATRIX.md` — 功能迁移矩阵
- `docs/02-ARCHITECTURE-DESIGN.md` — 架构设计
- `docs/03-RISK-ANALYSIS.md` — 风险清单
- `docs/04-BACKUP-DESIGN.md` — 备份与恢复设计
- `docs/05-CORE-IMPLEMENTATION.md` — 核心实现说明
- `docs/06-RELEASE-VERIFICATION.md` — 2.0.0 发布验收清单（真机执行，当前待验证）
- `RELEASE-NOTES-2.0.0.md` — 版本说明
- `README.en.md` — English README

## 许可证

GPL-3.0-only，见 `LICENSE`。
