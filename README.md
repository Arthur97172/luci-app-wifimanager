[English](README.en.md) | **简体中文**

# luci-app-wifimanager

本包在 LuCI 的「网络」菜单里提供 **WiFi Manager** 页面，用于管理 Wi-Fi MLO（Multi-Link
Operation，Wi-Fi 7 / 802.11be 多链路）接口。

## 它解决什么问题

OpenWrt 里一个 MLO 接口就是带 `mlo=1`、并且 `device` 列表里列了**两个以上** radio 的
`wifi-iface`；驱动会把这些 radio 聚合成一个 MLD（multi-link device），自动生成
`ap-mld0` / `sta-mld0` 这样的接口名。手写这些 UCI 很容易出错，本包提供一个专门的页面。

## 位置与功能

**LuCI → 网络（Network）→ WiFi管理**（界面语言为英文时显示 **WiFi Manager**）

- **概览**：已配置的 radio 数、无线接口数、启用 MLO 的接口数，以及告警
  （radio 不足 2 个、MLO 接口选的 radio 太少、自定义 ifname 覆盖了自动命名等）。
- **快速添加**：`Quick Add AP MLO` / `Quick Add STA MLO` 一键生成可用的 MLO 接口，
  默认 WPA3-SAE + 管理帧保护（PMF）必需 —— 这是本代码树里最兼容的起点。
- **接口列表**：每个 `wifi-iface` 一行，附两列只读信息 —— `Profile`（概览）与
  `Runtime`（运行态，每 5 秒刷新）。

点击某一行进入编辑器，分三个标签页：

- **General** —— 启用、Enable MLO、模式（ap / sta / adhoc / mesh）、Radio devices（多选）、
  Attached network(s)、SSID、隐藏 SSID
- **Security** —— 加密方式、密码、802.11w 管理帧保护
- **Advanced** —— 接口名、MAC 地址、BSSID、WDS / 4 地址模式、U-APSD、OCV、低 ACK 断开


## 安装

> 包名中的版本号必须与 [Makefile](Makefile) 的 `PKG_VERSION` / `PKG_RELEASE` 保持一致
> （当前 `1.0.0-r1`）。

**最低支持 OpenWrt / ImmortalWrt 24.10**（更早的版本不在支持范围内）。

opkg（OpenWrt / ImmortalWrt 24.10 及更早）：

```bash
opkg install luci-app-wifimanager-*.ipk
```

apk（OpenWrt / ImmortalWrt 25.12+）：

```bash
apk add --allow-untrusted luci-app-wifimanager-*.apk
```

简体中文界面需要**单独安装**翻译包 —— 主包不含译文，未装时界面为英文：

```bash
opkg install luci-i18n-wifimanager-zh-cn*.ipk                 # 24.10 及更早
apk add --allow-untrusted luci-i18n-wifimanager-zh-cn*.apk    # 25.12+
```

## 需要留意

- **MLO 至少需要 2 个 radio。** 不足时页面会明确提示，快速添加也会拒绝。
- **802.11w 的默认值不会被写进配置。** 默认值按加密方式推导（SAE / OWE → 必需，
  sae-mixed → 可选，其余 → 关闭）；与默认值相同时不写 `ieee80211w`，避免给 psk2
  接口凭空加上 PMF，把不支持 PMF 的客户端挡在门外。
- **`ssid` / `wds` 不挂条件显示。** 两者在 ap 和 sta 下都有效，而 LuCI 保存时会删除
  当前不可见的选项 —— 挂一个恒真的 `depends` 会让模式不在 {ap, sta} 内的接口
  （stock 无线页还提供 adhoc）保存一次就丢掉 `ssid`。
- 本页提供 `ap` / `sta` / `adhoc` / `mesh` 四种模式；其他模式请用 stock 的无线页面。

## 依赖

- `luci-base` —— 页面模块与菜单父节点；自带 `rpcd-mod-luci`，提供 `luci-rpc` ubus 对象
- `rpcd-mod-iwinfo` —— 运行状态用 `iwinfo.assoclist` 读取关联终端

## 构建

```sh
make menuconfig      # LuCI -> Applications -> luci-app-wifimanager
make package/luci-app-wifimanager/compile V=s
```

产物：`luci-app-wifimanager_1.0.0-r1_all.ipk`。

## 测试

纯 `node` 脚本，无外部依赖：

```sh
node tests/i18n.test.js       # 译文目录与 _() 字面量是否一一对应
node tests/view.test.js       # 在迷你 DOM 沙箱里真加载 view 模块，跑行为断言
node tests/mutation.test.js   # 把修好的 bug 逐个塞回去，证明断言不是空的
```

`view.test.js` 里的 `form` / `uci` 替身是逐行照着 luci-base 的 `form.js`、`uci.js`
写的；改动它们时请保持这份忠实度，否则断言会因为错误的原因通过。

## 许可证

GPL-3.0-only，见 [LICENSE](LICENSE)。
