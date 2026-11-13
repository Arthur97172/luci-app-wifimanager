'use strict';

const lib = require('./lib');
const { test, ok, equal, includes, notIncludes } = lib;

const VALIDATION = 'htdocs/luci-static/resources/wifimanager/utils/validation.js';
const RADIO = 'htdocs/luci-static/resources/wifimanager/utils/radio.js';
const CHANNEL = 'htdocs/luci-static/resources/wifimanager/utils/channel.js';
const FORM = 'htdocs/luci-static/resources/wifimanager/utils/wireless-form.js';
const RADIO_BACKEND = 'root/usr/lib/wifimanager/radio.sh';
const CHANNEL_BACKEND = 'root/usr/lib/wifimanager/channel.sh';

function view(rel) {
	return 'htdocs/luci-static/resources/view/wifimanager/' + rel + '.js';
}

test('wifi: IPv4 and netmask validation reject malformed input', function() {
	const validation = lib.loadModule(VALIDATION);

	ok(validation.isIPv4('192.168.1.1'));
	ok(validation.isIPv4('0.0.0.0'));
	ok(validation.isIPv4('255.255.255.255'));
	ok(!validation.isIPv4('256.1.1.1'));
	ok(!validation.isIPv4('192.168.1'));
	ok(!validation.isIPv4('192.168.1.1.1'));
	ok(!validation.isIPv4('192.168.1.a'));
	ok(!validation.isIPv4(''));

	ok(validation.isNetmask('255.255.255.0'));
	ok(validation.isNetmask('255.255.255.255'));
	ok(!validation.isNetmask('255.0.255.0'));
	ok(!validation.isNetmask('0.0.0.1'));
});

test('wifi: SSID and passphrase limits follow the driver byte limits', function() {
	const validation = lib.loadModule(VALIDATION);

	ok(validation.isSSID('Home'));
	ok(!validation.isSSID(''));
	ok(validation.isSSID('中'.repeat(10)), '30 UTF-8 bytes must pass');
	ok(!validation.isSSID('中'.repeat(11)), '33 UTF-8 bytes must fail');

	ok(validation.isKey('abcdefgh'));
	ok(validation.isKey('a'.repeat(63)));
	ok(!validation.isKey('abcdefg'));
	ok(!validation.isKey('a'.repeat(64)));
	ok(!validation.isKey('pass phrase with ünïcode'));
	ok(!validation.isKey('line\nbreak'));
});

test('wifi: mesh ID, MAC, mobility domain, hostname and port validation', function() {
	const validation = lib.loadModule(VALIDATION);

	ok(validation.isMeshId('backbone'));
	ok(!validation.isMeshId('   '));
	ok(validation.isMac('00:11:22:aa:BB:cc'));
	ok(!validation.isMac('00:11:22:33:44'));
	ok(validation.isMobilityDomain('abcd'));
	ok(!validation.isMobilityDomain('abcde'));
	ok(validation.isHostname('router-1'));
	ok(!validation.isHostname('-router'));
	ok(validation.isPortName('lan1'));
	ok(!validation.isPortName('lan port'));
	ok(validation.isDescription('A description'));
	ok(!validation.isDescription('bad\u0001value'));
	ok(!validation.isDescription('x'.repeat(201)));
});

test('wifi: radio vocabulary parses PHY modes and detects DFS channels', function() {
	const radio = lib.loadModule(RADIO);

	equal(radio.parseHtmode('EHT160'), { mode: 'EHT', width: 160 });
	equal(radio.parseHtmode('VHT80'), { mode: 'VHT', width: 80 });
	equal(radio.parseHtmode(''), { mode: '', width: null });
	equal(radio.parseHtmode('nonsense'), { mode: '', width: null });

	ok(radio.isDfsChannel('5g', 52));
	ok(radio.isDfsChannel('5g', 144));
	ok(!radio.isDfsChannel('5g', 36));
	ok(!radio.isDfsChannel('2g', 60));

	ok(radio.validSpectrumPair('6g', 'EHT', 320));
	ok(!radio.validSpectrumPair('5g', 'EHT', 320));
	ok(radio.validSpectrumPair('2g', 'HT', 40));
	ok(!radio.validSpectrumPair('2g', 'VHT', 80));

	equal(radio.bandNumber('6g'), 6);
	equal(radio.bandNumber('2g'), 2);
	equal(radio.bandNumber('unknown'), null);
	equal(radio.conflictTitle({ code: 'E-ALLOC-02' }), 'MLO needs two radios');
	equal(radio.conflictTitle({ code: 'E-UNKNOWN' }), 'E-UNKNOWN');
});

test('wifi: runtime interface names come from netifd, not the empty UCI ifname', function() {
	const source = lib.read(RADIO_BACKEND);

	includes(source, 'ubus call network.wireless status');
	includes(source, 'interfaces[*].section');
	includes(source, 'iface_runtime_forget');
	includes(source, 'iface_runtime_ifname');
	includes(source, 'json_add_string runtime_ifname');

	for (const rel of [ 'wifi/interfaces', 'wifi/mlo', 'diagnostics/wireless' ])
		includes(lib.read(view(rel)), 'runtime_ifname', rel + ' must show the runtime name');
});

test('wifi: all Wireless menu leaves point at existing views', function() {
	const menu = lib.menu();
	const leaves = [
		'admin/network/wifimanager/wireless/radios',
		'admin/network/wifimanager/wireless/interfaces',
		'admin/network/wifimanager/wireless/mlo',
		'admin/network/wifimanager/wireless/clients'
	];

	for (const leaf of leaves) {
		const entry = menu[leaf];

		ok(entry, 'menu entry ' + leaf);
		equal(entry.action.type, 'view');
		ok(lib.exists(view(entry.action.path.split('/').slice(1).join('/'))),
			'view file for ' + leaf);
	}

	includes(lib.read(view('wifi/radios')), 'rpc.radioInventory()');
	includes(lib.read(view('wifi/radios')), "card(_('Radio conflicts')");
	includes(lib.read(view('wifi/interfaces')), 'runtime');
	includes(lib.read(view('wifi/clients')), 'signal');
});

function sampleRadios() {
	return [
		{
			name: 'wifi0', band: '2g', disabled: false, mesh_radio: false,
			interfaces: [ { section: 'lan_2g', mode: 'ap', mesh_owned: false, disabled: false } ]
		},
		{
			name: 'wifi1', band: '5g', disabled: false, mesh_radio: true,
			interfaces: [
				{ section: 'mesh_radio0', mode: 'mesh', mesh_owned: true, disabled: false },
				{ section: 'lan_5g', mode: 'ap', mesh_owned: false, disabled: false }
			]
		},
		{
			name: 'wifi2', band: '6g', disabled: true, mesh_radio: false, interfaces: []
		}
	];
}

test('wifi: radio advice prefers a free radio and avoids the mesh radio for AP', function() {
	const radio = lib.loadModule(RADIO);

	let advice = radio.advise(sampleRadios(), { mode: 'ap', device: [], mlo: false, section: '' });

	equal(advice.verdicts[0].level, 'possible', 'an existing AP makes sharing possible, not free');
	ok(advice.verdicts[0].reasons.indexOf('W-USED') !== -1);
	equal(advice.verdicts[1].level, 'avoid');
	ok(advice.verdicts[1].reasons.indexOf('E-ALLOC-03') !== -1);
	equal(advice.verdicts[2].level, 'avoid');
	ok(advice.verdicts[2].reasons.indexOf('E-ALLOC-04') !== -1);
	equal(advice.suggestion.type, 'single');
	equal(advice.suggestion.device, [ 'wifi0' ]);

	advice = radio.advise(sampleRadios(), { mode: 'ap', device: [ 'wifi0' ], mlo: false, section: 'lan_2g' });

	equal(advice.verdicts[0].level, 'recommended', 'the edited section does not count as usage');
	ok(advice.verdicts[0].selected);

	advice = radio.advise(sampleRadios(), { mode: 'sta', device: [], mlo: false, section: '' });

	ok(advice.verdicts[1].reasons.indexOf('W-CONC-01') !== -1);
	ok(advice.verdicts[1].reasons.indexOf('W-MESH') !== -1);
	equal(advice.suggestion.device, [ 'wifi0' ]);
});

test('wifi: MLO advice picks two bands and reports when it cannot', function() {
	const radio = lib.loadModule(RADIO);

	let advice = radio.advise(sampleRadios(), { mode: 'ap', device: [], mlo: true, section: 'lan_2g' });

	equal(advice.suggestion.type, 'none', 'the mesh radio cannot carry an MLO AP link');
	ok(advice.suggestion.notes.indexOf('E-ALLOC-02') !== -1);

	const twoBands = [
		{ name: 'wifi0', band: '2g', disabled: false, mesh_radio: false, interfaces: [] },
		{ name: 'wifi1', band: '5g', disabled: false, mesh_radio: false, interfaces: [] }
	];

	advice = radio.advise(twoBands, { mode: 'ap', device: [], mlo: true, section: '' });

	equal(advice.suggestion.type, 'mlo');
	equal(advice.suggestion.device, [ 'wifi0', 'wifi1' ]);
	equal(advice.suggestion.notes, []);

	const sameBand = [
		{ name: 'wifi3', band: '5g', disabled: false, mesh_radio: false, interfaces: [] },
		{ name: 'wifi4', band: '5g', disabled: false, mesh_radio: false, interfaces: [] }
	];

	advice = radio.advise(sameBand, { mode: 'ap', device: [], mlo: true, section: '' });

	equal(advice.suggestion.type, 'mlo');
	equal(advice.suggestion.notes, [ 'W-SAME-BAND' ]);

	advice = radio.advise(sameBand.slice(0, 1), { mode: 'ap', device: [], mlo: true, section: '' });

	equal(advice.suggestion.type, 'none');
	ok(advice.suggestion.notes.indexOf('E-ALLOC-02') !== -1);

	equal(radio.adviceLevelName('recommended'), 'Recommended');
	equal(radio.adviceLevelName('avoid'), 'Avoid');
	includes(radio.adviceReason('I-FREE'), 'No enabled interface');
	includes(radio.adviceReason('E-ALLOC-03'), 'mesh radio');
});

test('wifi: channel ranking weighs overlap, DFS and current utilization', function() {
	const channel = lib.loadModule(CHANNEL);

	equal(channel.freqOf('2g', 1), 2412);
	equal(channel.freqOf('2g', 14), 2484);
	equal(channel.freqOf('5g', 36), 5180);
	equal(channel.freqOf('6g', 1), 5955);

	equal(channel.signalWeight(-40), 4);
	equal(channel.signalWeight(-55), 3);
	equal(channel.signalWeight(-65), 2);
	equal(channel.signalWeight(-80), 1);

	const ranked = channel.rank({
		band: '5g',
		width: 80,
		current_channel: '36',
		current_busy: 40,
		cells: [ { freq: 5180, signal: -40 } ],
		candidates: [
			{ channel: 36, freq: 5180, band: '5g', dfs: false },
			{ channel: 100, freq: 5500, band: '5g', dfs: true },
			{ channel: 149, freq: 5745, band: '5g', dfs: false },
			{ channel: 1, freq: 2412, band: '2g', dfs: false }
		]
	});

	equal(ranked.candidates.length, 3, 'candidates from another band are dropped');
	equal(ranked.best.channel, 149);
	ok(!ranked.keep);
	ok(ranked.hasData);
	equal(ranked.candidates[2].channel, 36, 'the busy current channel ranks last');
	ok(ranked.candidates[2].score > ranked.candidates[1].score);
});

test('wifi: an empty scan is reported as no data and keeps the current channel', function() {
	const channel = lib.loadModule(CHANNEL);

	const kept = channel.rank({
		band: '5g',
		width: 20,
		current_channel: '44',
		current_busy: 0,
		cells: [],
		candidates: [ { channel: 44, freq: 5220, band: '5g', dfs: false } ]
	});

	ok(kept.keep);
	ok(!kept.hasData);
	equal(kept.best.channel, 44);
});

test('wifi: radio and channel advice are read-only and wired end to end', function() {
	const advice = lib.read(RADIO_BACKEND);
	const channelSource = lib.read(CHANNEL_BACKEND);
	const rpcd = lib.read('root/usr/libexec/rpcd/wifimanager');
	const acl = lib.acl()['luci-app-wifimanager'];
	const form = lib.read(FORM);
	const radiosView = lib.read(view('wifi/radios'));

	includes(advice, 'radio_advice_json()');
	includes(advice, 'iface_is_mesh_owned');
	includes(advice, 'mesh_radio');

	includes(channelSource, 'channel_advice_json()');
	includes(channelSource, 'iw phy "$phy" info');
	includes(channelSource, 'survey dump');
	includes(channelSource, 'E-NOIFACE');
	notIncludes(channelSource, 'uci set');
	notIncludes(channelSource, 'uci commit');
	notIncludes(channelSource, 'wm_take_lock');

	includes(rpcd, 'radio_advice) radio_advice_json');
	includes(rpcd, 'channel_advice) channel_advice_json');
	ok(acl.read.ubus.wifimanager.indexOf('radio_advice') !== -1, 'radio_advice is readable');
	ok(acl.read.ubus.wifimanager.indexOf('channel_advice') !== -1, 'channel_advice is readable');
	ok(acl.write.ubus.wifimanager.indexOf('radio_advice') === -1, 'radio_advice is not writable');
	ok(acl.write.ubus.wifimanager.indexOf('channel_advice') === -1, 'channel_advice is not writable');

	includes(form, 'rpc.radioAdvice()');
	includes(form, 'radio.advise(');
	includes(form, 'advisory only');

	includes(radiosView, 'rpc.channelAdvice(entry.name)');
	includes(radiosView, "card(_('Channel recommendation')");
	includes(radiosView, 'The scan is read-only');
});

test('wifi: read-only pages do not offer a global save footer', function() {
	for (const rel of [ 'wifi/radios', 'wifi/interfaces', 'wifi/mlo', 'wifi/clients' ]) {
		const source = lib.read(view(rel));

		includes(source, 'handleSaveApply: null', rel + ' must not expose Save & Apply');
		includes(source, 'handleSave: null', rel + ' must not expose Save');
	}
});
