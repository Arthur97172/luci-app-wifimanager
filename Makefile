#
# Copyright (C) 2026 Arthur97172 <arthur97172@outlook.com>
#
# This is free software, licensed under the GNU General Public License v3.0
# (SPDX: GPL-3.0-only).
#

PKG_NAME:=luci-app-wifimanager
PKG_VERSION:=2.0.1
PKG_RELEASE:=1

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

LUCI_URL:=https://github.com/Arthur97172/luci-app-wifimanager
LUCI_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI WiFi Manager: wireless, MLO, mesh, roaming and backups
LUCI_DESCRIPTION:=Unified management of radios, MLO, mesh (BATMAN-adv/802.11s), \
	roaming (802.11k/v/r + DAWN), hybrid backhaul and global backups.
LUCI_DEPENDS:=+luci-base +rpcd-mod-iwinfo +kmod-cfg80211 +kmod-batman-adv \
	+batctl-default +luci-proto-batman-adv +iw +socat +flock +jshn +openssl-util

# The operator's settings must survive an upgrade: without this declaration
# opkg/apk would replace the file with the packaged defaults, which only the
# uci-defaults script is supposed to extend with missing values.
define Package/luci-app-wifimanager/conffiles
/etc/config/wifimanager
endef

define Package/luci-app-wifimanager/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${PKG_UPGRADE}" = "1" ] && exit 0

# Stop the daemons but keep every configuration file, every backup and the
# WiFi Manager state directory: the documented rollback path restores them.
if [ -x /etc/init.d/wifimanager ]; then
	/etc/init.d/wifimanager stop >/dev/null 2>&1 || true
fi
rm -rf /var/run/wifimanager 2>/dev/null || true

# Give DAWN back exactly as it was before WiFi Manager took it over.  Only a
# DAWN that WiFi Manager actually manages has the marker.
if [ -f /etc/wifimanager/config/dawn.managed ]; then
	if [ -x /etc/init.d/dawn ]; then
		/etc/init.d/dawn stop >/dev/null 2>&1 || true
		/etc/init.d/dawn disable >/dev/null 2>&1 || true
	fi
	if [ -f /etc/wifimanager/config/dawn.orig ]; then
		cp /etc/wifimanager/config/dawn.orig /etc/config/dawn 2>/dev/null || true
	else
		rm -f /etc/config/dawn
	fi
	rm -f /etc/wifimanager/config/dawn.managed /etc/wifimanager/config/dawn.orig
fi

# Re-enable the legacy daemon if this package was the one that stopped it.
legacy_disabled=$$(uci -q get wifimanager.settings.legacy_service_disabled)
if [ "$$legacy_disabled" = "1" ] && [ -x /etc/init.d/meshassistant ]; then
	/etc/init.d/meshassistant enable >/dev/null 2>&1 || true
	/etc/init.d/meshassistant restart >/dev/null 2>&1 || true
fi

rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -rf /tmp/luci-modulecache/* 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd restart >/dev/null 2>&1 || true
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
