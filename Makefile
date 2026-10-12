# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wifimanager
PKG_VERSION:=1.0.0
# 版本约定：每次提交 PKG_RELEASE +1（1.0.0-r1 ~ r9）；
# 达到 r10 时 PKG_VERSION 末位 +1（1.0.0 -> 1.0.1），PKG_RELEASE 重置为 1。
#
# 发布号由两个数字拼成：装 luci-app-wifimanager_1.0.0-r1_all.ipk 的那个 release
# 就叫 1.0.0-r1，tag 同名。包内容变了而上游版本没变时改本行、不改 PKG_VERSION，
# 这样一个发布号不会被重复使用 —— 每次推送都是一次新发布，而不是同一个名字
# 底下换了字节。改动本行就是切下一次发布。
#
# PKG_VERSION is written out above rather than read from a ./VERSION file, so
# "PKG_VERSION 末位 +1" means editing that line and setting this one back to 1.
PKG_RELEASE:=1

LUCI_TITLE:=LuCI Support for WiFi manager. Provides Network > WiFi Manager with an overview and General / Security / Advanced tabs per wireless interface.
# 依赖必须和 wifimanager.js 真正用到的东西一一对应，不能多也不能少：
#
# +luci-base 提供 'require' 的 view / form / uci / ui / dom / poll / rpc —— 其中
#   dom、view、poll 是 luci.js 里的内置类（luci.js:2236 起统一注册），不是独立
#   文件；它也提供菜单父节点 admin/network（luci-base 的 menu.d/luci-base.json:44，
#   不是 luci-mod-network 提供的），并传递依赖 rpcd-mod-luci，由后者注册
#   luci-rpc ubus 对象（wifimanager.js 的 getWirelessDevices 走这里）。
#
# +rpcd-mod-iwinfo 提供 iwinfo ubus 对象（rpcd 的 Makefile:106
#   "BuildPlugin,iwinfo,...Provides ubus calls for accessing iwinfo data"）。
#   wifimanager.js 调用 iwinfo.assoclist 读关联终端；少了它，"运行状态"面板会报错。
#   这一条以前漏了 —— acl.d 里 read.ubus 只声明了 iwinfo 和 luci-rpc 两个对象，
#   正好印证本包只需要这两个 ubus 提供者。
#
# 不再依赖 luci-mod-network：本包没有 require 它的任何资源，菜单父节点来自
#   luci-base，去掉它页面照常工作。
LUCI_DEPENDS:=+luci-base +rpcd-mod-iwinfo

# LUCI_MAINTAINER, not PKG_MAINTAINER: luci.mk defines Package/$(PKG_NAME) with
# MAINTAINER:=$(LUCI_MAINTAINER), and that block is evaluated after
# Package/Default's MAINTAINER:=$(PKG_MAINTAINER), so it wins. A PKG_MAINTAINER
# line here would be inert — the field would read "OpenWrt LuCI community".
LUCI_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>
PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
