#!/usr/bin/env node
/*
 * 变异测试：证明 view.test.js 的断言真的能抓住它声称能抓住的 bug。
 *
 * 为什么需要它：一个"从写出来就是绿的"测试是没有价值的 —— 它可能什么都没测。
 * 唯一能证明断言有效的方法，是把被修的 bug 一个一个塞回去，看测试是否变红。
 * 本文件对每一处修复做一次定点回退（mutation），把改坏的副本交给 view.test.js
 * 跑，要求它**必须失败**；如果某个变异体还能跑绿，说明对应的断言是空的。
 *
 * 每个变异体只改一处、且改法就是"回到修复前的写法"，所以它同时也在验证
 * 修复本身：修复前的代码确实有可观察的坏行为。
 *
 * 运行：node tests/mutation.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'htdocs/luci-static/resources/view/wifimanager.js');
const VIEW_TEST = path.join(__dirname, 'view.test.js');

let checks = 0, fails = 0;

function ok(cond, label, extra) {
	checks++;
	if (!cond) { fails++; console.log('FAIL  ' + label + (extra ? '\n      ' + extra : '')); }
}

// 每个变异体：把 find 换成 replace（必须恰好命中一次），期望 view.test.js 失败
const MUTATIONS = [
	{
		name: 'mlo 开关默认值回退成 enabled（BUG 1）',
		find: '\t\to.default = o.disabled;',
		replace: '\t\to.default = o.enabled;',
		why: 'form.Flag 会拿 default 当初值，于是每个老接口都被渲染成"已启用 MLO"，保存时还会把 mlo=1 写进 UCI'
	},
	{
		name: 'Quick Add 不登记 addedSection（BUG 2）',
		find: '\t\t\tprevMap.addedSection = sid;',
		replace: '\t\t\t/* mutation: addedSection 没有登记 */',
		why: '框架的 handleModalCancel 靠 prevMap.addedSection 回滚，没登记就会留下一个"取消不掉的空接口"'
	},
	{
		name: 'renderContents 之后不重插概览框（BUG 3）',
		find: [
			'\t\tm.renderContents = function() {',
			'\t\t\treturn renderContents().then(function(nodes) {',
			'\t\t\t\tensureSummaryBox(nodes);',
			'',
			'\t\t\t\treturn nodes;',
			'\t\t\t});',
			'\t\t};'
		].join('\n'),
		replace: '\t\tm.renderContents = renderContents;',
		why: '保存/取消都会让框架清空重建整个 map，概览框被丢掉后要等到下一次 poll 才回来'
	},
	{
		name: 'runtime.sections 用普通对象（BUG 5a）',
		find: '\t\tsections: Object.create(null),',
		replace: '\t\tsections: {},',
		why: 'section 名叫 valueOf/constructor 时会命中原型上的成员，读 .ifnames 直接抛异常'
	},
	{
		name: 'radioMap 用普通对象（BUG 5b）',
		find: '\tlet out = Object.create(null);',
		replace: '\tlet out = {};',
		why: 'device 引用了不存在的 radio 时，查表会命中原型成员（如 Object 构造函数），界面渲染出 undefined 而不是原样的名字'
	},
	{
		name: 'uniqueValues 的 seen 用普通对象（BUG 5c）',
		find: '\tlet seen = Object.create(null);',
		replace: '\tlet seen = {};',
		why: 'device 里的 constructor/toString 会被当成"已见过"而丢掉，去重退化成清空'
	},
	{
		name: 'macaddr 丢掉 random（BUG 4）',
		find: '\t\to.datatype = "or(\'random\',macaddr)";',
		replace: '\t\to.datatype = "macaddr";',
		why: 'macaddr=random 的接口过不了数据类型校验，整页都存不下去'
	},
	{
		name: 'ieee80211w 把默认值写进配置（BUG 6a）',
		find: [
			'\t\to.write = function(section_id, value) {',
			'\t\t\tif (value != this.default)',
			'\t\t\t\treturn form.ListValue.prototype.write.call(this, section_id, value);',
			'',
			'\t\t\treturn form.ListValue.prototype.remove.call(this, section_id);',
			'\t\t};'
		].join('\n'),
		replace: '\t\t/* mutation: 去掉 write 覆盖，默认值会被写进配置 */',
		why: 'psk2 接口保存后凭空多出 ieee80211w=2（PMF 强制），不支持 PMF 的客户端直接连不上'
	},
	{
		name: 'ieee80211w 用扁平的 default（BUG 6b）',
		find: [
			'\t\to.defaults = {',
			"\t\t\t'2': [ { encryption: 'sae' }, { encryption: 'owe' } ],",
			"\t\t\t'1': [ { encryption: 'sae-mixed' } ],",
			"\t\t\t'0': []",
			'\t\t};'
		].join('\n'),
		replace: '\t\t/* mutation: 去掉按加密方式解析的默认值 */',
		why: 'psk2 接口的界面会显示 PMF「Required」，与实际生效的 Disabled 不符'
	},
	{
		name: '零个 radio 时仍谎称"只有一个 radio"（BUG 7）',
		find: [
			"\tif (!radios.length)",
			"\t\tsummary.warnings.push(_('No radio is configured. MLO needs at least two radios.'));",
			"\telse if (radios.length < 2)",
			"\t\tsummary.warnings.push(_('Only one radio is configured. MLO needs at least two radios.'));"
		].join('\n'),
		replace: [
			"\tif (radios.length < 2)",
			"\t\tsummary.warnings.push(_('Only one radio is configured. MLO needs at least two radios.'));"
		].join('\n'),
		why: 'radios.length 为 0 时（有线设备、或 wifi 配置还没生成）会提示"只有一个 radio 已配置"，与事实相反'
	},
	{
		name: 'ssid 挂回恒真的 depends（BUG 8）',
		find: "\t\to.datatype = 'maxlength(32)';",
		replace: [
			"\t\to.datatype = 'maxlength(32)';",
			"\t\to.depends('mode', 'ap');",
			"\t\to.depends('mode', 'sta');"
		].join('\n'),
		why: 'depends 恒真却仍要走 isActive()，而 form.js 在保存时会 remove() 掉不可见的选项 —— mode 落在 {ap,sta} 之外的接口（stock 页支持 adhoc）保存一次就丢 ssid'
	},
	{
		name: 'wds 挂回恒真的 depends（BUG 8b）',
		find: "\t\to = s.taboption('advanced', form.Flag, 'wds', _('Enable WDS / 4-address mode'));",
		replace: [
			"\t\to = s.taboption('advanced', form.Flag, 'wds', _('Enable WDS / 4-address mode'));",
			"\t\to.depends('mode', 'ap');",
			"\t\to.depends('mode', 'sta');"
		].join('\n'),
		why: '同上：4-address 模式在 ap / sta 下都合法，恒真 depends 只会带来"保存即删除 wds"的风险'
	},
	{
		name: '模式候选表退回 ap / sta 两项（BUG 9）',
		find: [
			"\t\to.value('adhoc', _('Ad-Hoc'));",
			"\t\to.value('mesh', _('Mesh'));"
		].join('\n'),
		replace: '\t\t/* mutation: 候选表只剩 ap / sta，adhoc / mesh 不注册 */',
		why: '下拉菜单的项数就是候选表的项数（form.js:1772 transformChoices → ui.js:746 UISelect.render），' +
			'少注册两项，界面上就只剩"接入点 (AP)"和"客户端"，而且不报错。' +
			'这是 0.1.2 的实际写法；T14 抓不到它 —— keepConfiguredValue 会把配置里已有的 adhoc / mesh 补回候选表，' +
			'只有 T16 断言静态候选表本身'
	},
	{
		name: 'mode / encryption 挂回 default（BUG 9b）',
		find: '\toption.default = undefined;',
		replace: "\toption.default = 'ap';",
		why: '这正是 0.1.2 的写法（o.default = \'ap\'）。ListValue 挂了 default 之后，formvalue() 在' +
			'"控件值 == default"时返回 null（form.js:4994-4999）：mode=ap 的接口保存时会被当成"空值"，' +
			'parse() 直接抛 "must not be empty"；同时 depends(\'mode\',\'ap\') 也永远不满足，hidden 被删（T15）'
	}
];

// ---------------------------------------------------------------------------
// 先跑一遍原文件：如果它本来就是红的，下面的结论全部无效
// ---------------------------------------------------------------------------

const original = fs.readFileSync(SRC, 'utf8');

console.log('--- 基线：未修改的源码必须通过 ---');
{
	const r = spawnSync(process.execPath, [ VIEW_TEST ], {
		cwd: ROOT, encoding: 'utf8', env: process.env
	});
	ok(r.status === 0, 'view.test.js 在未修改的源码上必须通过',
		'退出码 ' + r.status + '\n' + tail(r.stdout) + tail(r.stderr));
	console.log('      ' + (r.stdout || '').trim().split('\n').slice(-1)[0]);
}

// ---------------------------------------------------------------------------
// 逐个注入
// ---------------------------------------------------------------------------

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlo-mutation-'));

console.log('\n--- 变异体：每个都必须让 view.test.js 变红 ---');

for (let i = 0; i < MUTATIONS.length; i++) {
	const m = MUTATIONS[i];
	const hits = original.split(m.find).length - 1;

	ok(hits === 1, '变异体 ' + (i + 1) + ' 的锚点在源码里必须唯一（找到 ' + hits + ' 处）', m.find);

	if (hits !== 1) continue;

	const mutated = original.replace(m.find, m.replace);
	const file = path.join(tmpdir, 'mlo-' + (i + 1) + '.js');
	fs.writeFileSync(file, mutated);

	const r = spawnSync(process.execPath, [ VIEW_TEST ], {
		cwd: ROOT, encoding: 'utf8',
		env: Object.assign({}, process.env, { MLO_VIEW_JS: file })
	});

	const failed = r.status !== 0;
	ok(failed, '变异体 ' + (i + 1) + '：' + m.name + ' 必须被测试抓住', '测试仍然通过，说明断言是空的');

	if (failed) {
		const lines = (r.stdout || '').split('\n').filter(function(l) { return /^FAIL/.test(l); });
		console.log('      ✅ ' + m.name);
		console.log('         原因：' + m.why);
		console.log('         被抓住于：' + (lines[0] || '(见 stderr)').trim());
		console.log('         共 ' + lines.length + ' 条断言失败');
	}
}

fs.rmSync(tmpdir, { recursive: true, force: true });

function tail(s) {
	return (s || '').trim().split('\n').slice(-3).join('\n');
}

console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + (checks - fails) + '/' + checks +
	'（每个变异体都被对应的断言抓住）');
process.exit(fails ? 1 : 0);
