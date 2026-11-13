'use strict';

const lib = require('./lib');
const { test, ok, equal, includes, notIncludes, match } = lib;

const ROAMING = 'root/usr/lib/wifimanager/roaming.sh';

test('roaming: 802.11r stays off unless the operator enables it', function() {
	const source = lib.read(ROAMING);
	const mesh = lib.read('root/usr/lib/wifimanager/mesh.sh');
	const settings = lib.read('htdocs/luci-static/resources/view/wifimanager/roaming/settings.js');
	const ftOption = settings.slice(settings.indexOf("form.Flag, 'ft'"),
		settings.indexOf("form.Value, 'mobility_domain'"));

	includes(source, '[ -n "$ft" ] || ft=0');
	includes(mesh, '[ -n "$ft" ] || ft=0');
	lib.notMatch(source, /\|\| ft=1/);
	lib.notMatch(mesh, /\|\| ft=1/);
	includes(ftOption, "o.default = '0';");
	// The capability query already treats a missing option as off; the apply
	// path must agree, or the UI claims off while hostapd runs FT (DESIGN §8.3).
	includes(source, 'json_add_boolean ft "$([ "$(uci -q get meshassistant.config.ft)" = 1 ] && echo 1 || echo 0)"');
});

test('roaming: 802.11k/v/r is written only when the operator enables it', function() {
	const source = lib.read(ROAMING);

	includes(source, "uci set \"wireless.$section.ieee80211r=1\"");
	includes(source, "uci set \"wireless.$section.mobility_domain=");
	includes(source, "uci set \"wireless.$section.ieee80211k=1\"");
	includes(source, "uci set \"wireless.$section.bss_transition=1\"");
	includes(source, "uci -q del \"wireless.$section.ieee80211r\"");
	includes(source, 'wnm_supported');
});

test('roaming: applying k/v/r reloads Wi-Fi because hostapd reads it at start', function() {
	const source = lib.read(ROAMING);

	includes(source, 'hostapd only reads ieee80211k/v/r at start');
	includes(source, 'wm_reload_wifi');
	includes(source, 'setup_dawn');
});

test('roaming: DAWN is taken over only with a backup of the previous config', function() {
	const source = lib.read(ROAMING);

	includes(source, 'dawn_release()');
	includes(source, 'cp "$WM_DAWN_CONF" "$WM_DAWN_BACKUP"');
	includes(source, 'chmod 600 "$WM_DAWN_BACKUP"');
	includes(source, 'touch "$WM_DAWN_MARKER"');
	includes(source, 'cp "$WM_DAWN_BACKUP" "$WM_DAWN_CONF"');
});

test('roaming: DAWN stays stopped when wpad has no 802.11v support', function() {
	const source = lib.read(ROAMING);
	const setup = source.slice(source.indexOf('setup_dawn()'), source.indexOf('roaming_apply_internal'));

	includes(setup, 'if ! wnm_supported; then');
	includes(setup, 'dawn_release');
	includes(setup, 'DAWN left stopped');
});

test('roaming: the event sampler records joins, leaves, roams and mesh links', function() {
	const source = lib.read(ROAMING);

	includes(source, 'station_roams()');
	includes(source, 'roaming_event_emit');
	includes(source, 'roaming_events_sample()');
	includes(source, 'wm_event');
});

test('roaming: backups cover both the k/v/r options and DAWN', function() {
	const backup = lib.loadModule('htdocs/luci-static/resources/wifimanager/utils/backup.js');

	equal(backup.defaultScope('roaming'), [ 'roaming', 'dawn' ]);
	equal(backup.affectedFiles([ 'roaming' ]), [ 'dawn', 'meshassistant', 'wireless' ]);
	equal(backup.affectedFiles([ 'dawn' ]), [ 'dawn', 'wireless' ]);
	ok(backup.touchesConnectivity([ 'network' ]));
	ok(!backup.touchesConnectivity([ 'roaming' ]));
});

test('roaming: apply takes a global backup and a private snapshot first', function() {
	const source = lib.read(ROAMING);
	const apply = source.slice(source.indexOf('roaming_apply() {'));
	const backup = apply.indexOf('backup_create_auto roaming');
	const snap = apply.indexOf('roaming_apply_snapshot "$snap"');
	const internal = apply.indexOf('roaming_apply_internal');

	ok(backup !== -1, 'pre-change backup');
	ok(snap !== -1, 'private snapshot');
	ok(internal !== -1, 'apply');
	ok(backup < snap && snap < internal, 'order: backup < snapshot < apply');
	includes(apply, 'The pre-change backup failed; no roaming setting was written.');
	includes(source, '. /usr/lib/wifimanager/backup.sh');
});

test('roaming: the snapshot covers wireless, DAWN and the takeover files', function() {
	const source = lib.read(ROAMING);
	const snapshot = source.slice(source.indexOf('roaming_apply_snapshot()'),
		source.indexOf('roaming_apply_rollback()'));
	const rollback = source.slice(source.indexOf('roaming_apply_rollback()'),
		source.indexOf('roaming_apply_verify()'));

	includes(snapshot, 'cp "$WM_CONFIG_DIR/wireless" "$snap/etc/config/wireless"');
	includes(snapshot, 'cp "$WM_CONFIG_DIR/dawn" "$snap/etc/config/dawn"');
	includes(snapshot, 'touch "$snap/state/dawn.absent"');
	includes(snapshot, 'touch "$snap/state/dawn.managed"');
	includes(snapshot, 'cp "$WM_DAWN_BACKUP" "$snap/state/dawn.orig"');
	includes(snapshot, 'touch "$snap/state/dawn.running"');

	includes(rollback, 'uci -q revert wireless');
	includes(rollback, 'restore_rollback "$snap"');
	includes(rollback, 'rm -f "$WM_DAWN_MARKER"');
	includes(rollback, 'chmod 600 "$WM_DAWN_BACKUP"');
	includes(rollback, 'wm_reload_wifi');
	includes(rollback, '/etc/init.d/dawn stop');
});

test('roaming: a failed apply rolls back and is reported as failed', function() {
	const source = lib.read(ROAMING);
	const apply = source.slice(source.indexOf('roaming_apply() {'));

	includes(source, 'if ! uci -q commit wireless; then');
	includes(source, 'The wireless configuration could not be committed.');
	includes(apply, 'if ! roaming_apply_internal; then');
	includes(apply, 'roaming_apply_rollback "$snap"');
	includes(apply, 'wm_op_finish failed "Applying roaming settings failed; the previous configuration was restored." 0');
	includes(apply, 'wm_event roaming-apply result failed rolled_back 1 backup "$backup_id"');
	includes(apply, 'return 1');
});

test('roaming: a DAWN that does not start finishes as unverified', function() {
	const source = lib.read(ROAMING);
	const apply = source.slice(source.indexOf('roaming_apply() {'));

	includes(source, 'roaming_apply_verify()');
	includes(source, 'Roaming settings applied, but DAWN did not start.');
	includes(apply, 'wm_event roaming-apply result unverified');
	includes(apply, 'if ! roaming_apply_verify; then');
});

test('roaming: settings, DAWN and events menu leaves exist', function() {
	const menu = lib.menu();

	for (const leaf of [ 'settings', 'dawn', 'events' ]) {
		const key = 'admin/network/wifimanager/roaming/' + leaf;
		const entry = menu[key];

		ok(entry, key);
		equal(entry.action.type, 'view');
		ok(lib.exists('htdocs/luci-static/resources/view/' + entry.action.path + '.js'), key);
	}
});

test('roaming: the events page states the gaps of the sampler honestly', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/roaming/events.js');

	includes(view, 'rpc.meshEvents');
	match(view, /roam|client-join|link-up/);
	includes(lib.read(ROAMING), 'Same MAC now seen on a different BSS is a roam.');
});

test('roaming: FT over air and FT over DS are configurable and default to air', function() {
	const common = lib.read('root/usr/lib/wifimanager/common.sh');
	const roaming = lib.read(ROAMING);
	const mesh = lib.read('root/usr/lib/wifimanager/mesh.sh');
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/roaming/settings.js');

	includes(common, 'ft_over_ds_value() {');
	includes(common, "[ \"$(uci -q get meshassistant.config.ft_over_ds)\" = 1 ]");
	includes(common, 'echo 0');
	// Both writers of AP sections must use the shared value instead of a literal.
	includes(roaming, 'wireless.$section.ft_over_ds=$(ft_over_ds_value)');
	includes(mesh, 'wireless.$section.ft_over_ds=$(ft_over_ds_value)');
	notIncludes(roaming, 'wireless.$section.ft_over_ds=0');
	notIncludes(mesh, 'wireless.$section.ft_over_ds=0');
	// The form follows Design 8.3: enable, mobility domain, air, DS.
	includes(view, "form.Flag, 'ft', _('Enable 802.11r fast transition')");
	includes(view, "form.Value, 'mobility_domain', _('Mobility domain')");
	includes(view, "form.Flag, 'ft_over_ds'");
	includes(view, "o.default = '0';");
	includes(view, 'FT over DS (fast transition over the distribution system)');
	includes(view, 'selects DS instead of air rather than both');
});

test('roaming: the access point table shows the FT transport', function() {
	const view = lib.read('htdocs/luci-static/resources/view/wifimanager/roaming/settings.js');
	const diag = lib.read('root/usr/lib/wifimanager/diagnostics.sh');

	includes(diag, 'json_add_boolean ft_over_ds');
	includes(view, "{ label: _('FT transport') }");
	includes(view, "entry.ft_over_ds ? _('Over DS') : _('Over the air')");
});

test('roaming: 802.11k and 802.11v are separate toggles with separate effects', function() {
	const source = lib.read(ROAMING);
	const common = lib.read('root/usr/lib/wifimanager/common.sh');
	const settings = lib.read('htdocs/luci-static/resources/view/wifimanager/roaming/settings.js');

	includes(common, 'roaming_option ieee80211k');
	includes(common, 'roaming_option ieee80211v');
	includes(source, 'if roaming_k_enabled; then');
	includes(source, 'if roaming_v_enabled && wnm_supported; then');
	includes(source, 'if roaming_v_enabled && ! roaming_k_enabled; then');
	includes(source, 'if ! roaming_v_enabled || ! wnm_supported; then');
	includes(settings, "form.Flag, 'ieee80211k'");
	includes(settings, "form.Flag, 'ieee80211v'");
});
