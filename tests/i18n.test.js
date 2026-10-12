#!/usr/bin/env node
/*
 * i18n 回归测试：把「会被扫描到的文案」和「po 里的译文」对成一条可执行的断言。
 *
 * 为什么需要它：_() 的查表是「精确匹配 + trim」，任何一处 msgid 对不上都会静默
 * 退回英文（不报错、不警告）。页面上少一行中文，构建日志里不会有任何痕迹，只有
 * 用户会看到。本文件把这条链路变成 CI 能拦住的东西。
 *
 * 与 luci-app-ledcontrol/tests/i18n.test.js 的差别（不是随意加的）：
 *   1. 解析器必须支持多行 msgid 续行。本包的 po 里大量 msgid 被 xgettext 折成
 *      "..." 续行（例如 "At least two configured radios are required before an MLO
 *      interface can be created." 那条），单行解析器会把它截断成半句，
 *      于是「漏翻」检查会全部误报。这里按 po 规范拼接续行。
 *   2. 被扫描的字符串不止 view 的 _() 字面量。luci-base 的 i18n 扫描同时抽取
 *      menu.d 的 title 和 acl.d 的 description —— 本包的 po 自己就带着这两类
 *      条目（"Grant access to LuCI app WiFi Manager" 来自 acl.d，"WiFi Manager" 来自
 *      menu.d），所以「孤儿条目」检查必须把它们算进「源码里真实存在的字符串」，
 *      否则合法条目会被判成陈旧。
 *   3. 额外加了 pot 侧的一致性：po 与 pot 的 msgid 集合必须相等、pot 的 msgstr
 *      必须全空、两边都不得有重复 msgid。po 与 pot 漂移时，构建不会报错，只会
 *      在下次 xgettext 重新生成 pot 时把差异冲掉 —— 事后无法复盘。
 *
 * 三件必须守住的事（沿用 ledcontrol 的约定）：
 *   1. po/ 下的语言目录名决定 luci.mk 生成哪个语言包（luci.mk:10 收集目录名，
 *      luci.mk:354 对命中 LUCI_LANG.* 的名字调 LuciTranslation）。改成不认识的
 *      名字，语言包就悄悄消失了 —— 所以这里把目录名钉死。
 *   2. po2lmo 的 extract_string 只反转义 \" 和 \\，不处理 \n。所以 msgid 必须是
 *      单行纯文本；po 的解析必须照此实现，不能用 JSON.parse（那会反转义 \n，
 *      恰好掩盖这类失效）。
 *   3. msgid 不得有首尾空白 —— _() 查表前会 trim。
 *
 * 注意：扫描 JS 源码用的正则也会命中注释里的 _('...') 示例，所以不要在 view 的
 * 注释里写这种例子。
 *
 * 运行：node tests/i18n.test.js
 */

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PO_ROOT = path.join(ROOT, 'po');
var JS_PATH = path.join(ROOT, 'htdocs/luci-static/resources/view/wifimanager.js');
var MENU_PATH = path.join(ROOT, 'root/usr/share/luci/menu.d/luci-app-wifimanager.json');
var ACL_PATH = path.join(ROOT, 'root/usr/share/rpcd/acl.d/luci-app-wifimanager.json');

// luci.mk 的 LUCI_LANG 表里叫 zh_Hans，LUCI_LC_ALIAS 把它映射成产物用的 zh-cn，
// 于是语言包名为 luci-i18n-wifimanager-zh-cn（luci.mk:75/325）。
var LANG_DIR = 'zh_Hans';
var LANG_TAG = 'zh-cn';
var PKG_BASENAME = 'wifimanager';
var I18N_PACKAGE = 'luci-i18n-' + PKG_BASENAME + '-' + LANG_TAG;

var fails = 0, checks = 0;
function ok(cond, label, extra) {
	checks++;
	if (!cond) { fails++; console.log('FAIL  ' + label + (extra ? '\n      ' + extra : '')); }
}
function eq(got, want, label) {
	ok(got === want, label, 'got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}

// ---------- A. 守卫：po/ 的语言目录名 ----------
//
// 目录名是整条打包链路唯一的开关：叫 zh_Hans 才会生成 luci-i18n-wifimanager-zh-cn；
// 叫别的（例如早期的 zh-cn）luci.mk 就不生成语言包，译文只能靠主包手工内联。

console.log('--- A. 守卫：po/ 语言目录名 ---');
var langDirs = fs.readdirSync(PO_ROOT).filter(function(d) {
	return d !== 'templates' && fs.statSync(path.join(PO_ROOT, d)).isDirectory();
});
eq(langDirs.length, 1, 'po/ 下应恰好有一个语言目录');
eq(langDirs[0], LANG_DIR, '语言目录名必须是 ' + LANG_DIR + '（否则 luci.mk 不生成 ' + I18N_PACKAGE + '）');

var POT_PATH = path.join(PO_ROOT, 'templates', PKG_BASENAME + '.pot');
ok(fs.existsSync(POT_PATH), '缺少 po/templates/' + PKG_BASENAME + '.pot');

var PO_PATH = path.join(PO_ROOT, LANG_DIR, PKG_BASENAME + '.po');
ok(fs.existsSync(PO_PATH), '缺少 ' + path.relative(ROOT, PO_PATH));

// ---------- B. 载入 po / pot ----------

// 复刻 po2lmo 的 extract_string：只反转义 \" 和 \\，其余原样保留。
function poUnescape(s) {
	var out = '', i = 0;
	while (i < s.length) {
		if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
			out += s[i + 1];
			i += 2;
		} else {
			out += s[i];
			i++;
		}
	}
	return out;
}

// 按 po 规范解析：msgid/msgstr 后跟若干行 "..." 续行时依次拼接。
// 返回 [{ msgid, msgstr, refs }]，含头部（msgid 为空串）的那一条。
function parsePo(text) {
	var entries = [];
	var cur = null, field = null, refs = [];

	text.split('\n').forEach(function(raw) {
		var line = raw.replace(/\r$/, ''), m;

		if (/^#/.test(line)) { refs.push(line); return; }
		if (line.trim() === '') {
			if (cur) { entries.push(cur); cur = null; field = null; }
			refs = [];
			return;
		}
		if ((m = /^msgid\s+"(.*)"$/.exec(line))) {
			if (cur) entries.push(cur);
			cur = { msgid: poUnescape(m[1]), msgstr: '', refs: refs.slice() };
			field = 'msgid';
			refs = [];
			return;
		}
		if ((m = /^msgstr\s+"(.*)"$/.exec(line))) {
			if (!cur) return;
			cur.msgstr = poUnescape(m[1]);
			field = 'msgstr';
			return;
		}
		if ((m = /^"(.*)"$/.exec(line))) {
			if (!cur || !field) return;
			cur[field] += poUnescape(m[1]);
			return;
		}
		// 其余行（如 "#~" 之外的异常语法）不应出现；出现即说明文件被写坏了。
		throw new Error('无法解析的 po 行: ' + JSON.stringify(line));
	});
	if (cur) entries.push(cur);

	return entries;
}

var poEntries = parsePo(fs.readFileSync(PO_PATH, 'utf8'));
var potEntries = parsePo(fs.readFileSync(POT_PATH, 'utf8'));

var poHeader = poEntries.filter(function(e) { return e.msgid === ''; })[0] || { msgstr: '' };
var TR = {};
poEntries.forEach(function(e) { if (e.msgid) TR[e.msgid] = e.msgstr; });

// 复刻 luci-base 的 _()：查表键会 trim，查不到就原样返回。
function _(s) {
	var k = String(s).trim();
	return TR[k] || s;
}

// ---------- C. 收集会被扫描到的字符串 ----------
//
// 三类：view 的 _() 字面量、menu.d 的 title、acl.d 的 description。

var jsSrc = fs.readFileSync(JS_PATH, 'utf8');
var jsLits = {};
(function collectLits() {
	var re = /_\(\s*(['"])((?:[^\\]|\\.)*?)\1\s*\)/g, m;
	while ((m = re.exec(jsSrc))) {
		try { jsLits[(0, eval)(m[1] + m[2] + m[1])] = 1; } catch (e) { /* 跨行拼接等，跳过 */ }
	}
})();

var menu = JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'));
var acl = JSON.parse(fs.readFileSync(ACL_PATH, 'utf8'));

var menuTitles = {}, aclDescriptions = {};
Object.keys(menu).forEach(function(k) { if (menu[k].title) menuTitles[menu[k].title] = 1; });
Object.keys(acl).forEach(function(k) { if (acl[k].description) aclDescriptions[acl[k].description] = 1; });

// 源码侧「真实存在」的字符串全集 —— 反向孤儿检查要用它当基准。
var scanned = {};
[ jsLits, menuTitles, aclDescriptions ].forEach(function(set) {
	Object.keys(set).forEach(function(k) { scanned[k.trim()] = 1; });
});

console.log('--- C. 扫描到的字符串 ---');
ok(Object.keys(jsLits).length > 0, 'view 里没有扫描到任何 _() 字面量（正则或路径失效？）');
console.log('      (_() 字面量 ' + Object.keys(jsLits).length +
	' 条，menu.d 标题 ' + Object.keys(menuTitles).length +
	' 条，acl.d 描述 ' + Object.keys(aclDescriptions).length + ' 条)');

// ---------- D. 守卫：每个 _() 字面量都必须能命中 po ----------

console.log('--- D. 守卫：_() 字面量 vs po ---');
var orphans = Object.keys(jsLits).filter(function(k) { return !TR[k.trim()]; });
ok(orphans.length === 0, '存在查表必然落空的 _() 字面量（会静默显示英文）',
	orphans.map(function(k) {
		var why = '';
		if (k !== k.trim()) why = '  ← 首尾有空白，_() 查表前会 trim';
		else if (/\n/.test(k)) why = '  ← 含真实换行：po2lmo 不反转义 \\n，键必然对不上';
		return JSON.stringify(k) + why;
	}).join('\n      '));

// ---------- E. 守卫：msgid 不得含 po2lmo 不处理的转义 ----------
//
// po2lmo 的 extract_string 只反转义 \" 和 \\。JS 源码里任何其他转义（\n \t \u …）
// 都会被 JS 解析器先变成真实字符，而 po 里存的是字面反斜杠序列 —— 两边哈希不同，
// 译文永远查不到。

var BAD_ESC = /\\(?![\\"])/;
var escLit = Object.keys(jsLits).filter(function(k) { return BAD_ESC.test(k); });
ok(escLit.length === 0, '_() 字面量含 po2lmo 不处理的转义（\\n 等），译文必然失效',
	escLit.map(function(k) { return JSON.stringify(k).slice(0, 80); }).join('\n      '));

// ---------- F. 守卫：msgid 不允许首尾带空白 ----------

console.log('--- F. 守卫：msgid 首尾空白 ---');
var padded = Object.keys(TR).filter(function(k) { return k !== k.trim(); });
ok(padded.length === 0, 'msgid 带首尾空格，_() 永远查不到',
	padded.map(function(k) { return JSON.stringify(k); }).join('\n      '));
console.log('      (' + Object.keys(TR).length + ' 条 msgid，无首尾空格)');

// ---------- G. 守卫：msgstr 不得为空 ----------

console.log('--- G. 守卫：msgstr 非空 ---');
var empty = Object.keys(TR).filter(function(k) { return !TR[k]; });
ok(empty.length === 0, '存在空 msgstr（该条会退回英文）',
	empty.map(function(k) { return JSON.stringify(k); }).join('\n      '));

// ---------- H. 守卫：menu.d 的标题被覆盖 ----------
//
// 菜单标题由服务端用同一个 catalog 翻译（dispatcher 的 menu_json），所以它必须在
// po 里，否则侧边栏永远是英文。

console.log('--- H. 守卫：menu.d 标题 ---');
Object.keys(menuTitles).forEach(function(title) {
	ok(!!TR[title.trim()], 'menu.d 标题 "' + title + '" 没有译文',
		'在 po 里补一条 msgid "' + title + '"');
});

// ---------- J. 守卫：acl.d 的 description 被覆盖 ----------
//
// 权限对话框里的说明同样走 catalog（po 里的 ref 直接指向 acl.d/*.json:3），
// 漏了它，「系统 - 权限」里这一条就永远是英文。

console.log('--- J. 守卫：acl.d 描述 ---');
Object.keys(aclDescriptions).forEach(function(desc) {
	ok(!!TR[desc.trim()], 'acl.d 描述 "' + desc + '" 没有译文',
		'在 po 里补一条 msgid "' + desc + '"');
});

// ---------- I. 反向：po 里不应有孤儿 msgid ----------

console.log('--- I. 守卫：po 孤儿条目 ---');
var orphanMsgs = Object.keys(TR).filter(function(k) { return !scanned[k.trim()]; });
ok(orphanMsgs.length === 0, 'po 里有源码用不到的 msgid（多半是文案改过、po 没跟着改）',
	orphanMsgs.map(function(k) {
		return JSON.stringify(k) + '\n      refs: ' + (poEntries.filter(function(e) { return e.msgid === k; })[0] || { refs: [] }).refs.join(' | ');
	}).join('\n      '));

// ---------- K. 守卫：po 与 pot 的 msgid 集合必须相等 ----------

console.log('--- K. 守卫：po / pot 一致性 ---');
var potIds = {};
potEntries.forEach(function(e) { if (e.msgid) potIds[e.msgid] = 1; });

var poOnly = Object.keys(TR).filter(function(k) { return !potIds[k]; });
var potOnly = Object.keys(potIds).filter(function(k) { return !TR[k]; });
ok(poOnly.length === 0, 'po 有、pot 没有的 msgid（pot 没跟着 xgettext 更新）',
	poOnly.map(function(k) { return JSON.stringify(k); }).join('\n      '));
ok(potOnly.length === 0, 'pot 有、po 没有的 msgid（新文案没翻译）',
	potOnly.map(function(k) { return JSON.stringify(k); }).join('\n      '));
eq(Object.keys(TR).length, Object.keys(potIds).length, 'po 与 pot 的条目数必须相等');
console.log('      (po ' + Object.keys(TR).length + ' 条，pot ' + Object.keys(potIds).length + ' 条)');

// pot 是模板：msgstr 必须全部为空，否则会被误当成已有译文。
var potFilled = potEntries.filter(function(e) { return e.msgid && e.msgstr !== ''; });
ok(potFilled.length === 0, 'pot 的 msgstr 必须为空（它是模板，不是译文）',
	potFilled.map(function(e) { return JSON.stringify(e.msgid); }).join('\n      '));

// 重复 msgid 会让后一条静默覆盖前一条：译文看起来「在」，实际取到的是另一条。
function dupes(entries) {
	var seen = {}, dup = [];
	entries.forEach(function(e) {
		if (!e.msgid) return;
		if (seen[e.msgid]) dup.push(e.msgid);
		seen[e.msgid] = 1;
	});
	return dup;
}
var poDup = dupes(poEntries), potDup = dupes(potEntries);
ok(poDup.length === 0, 'po 里有重复 msgid（后一条会静默覆盖前一条）',
	poDup.map(function(k) { return JSON.stringify(k); }).join('\n      '));
ok(potDup.length === 0, 'pot 里有重复 msgid',
	potDup.map(function(k) { return JSON.stringify(k); }).join('\n      '));

// ---------- L. 守卫：多行 msgid 续行被正确拼接 ----------
//
// 这是本文件解析器存在的理由。挑一条确定折行的条目，断言它拼接后的完整形态
// 确实在表里 —— 若解析器只读第一行，这条必然落空，D/G/I 的结论也就不可信了。
// 顺带钉住「po / pot 不带 #: ref 注释行」这条约定（见本段末尾）。

console.log('--- L. 守卫：多行 msgid 续行 ---');
var MULTILINE = 'At least two configured radios are required before an MLO interface can be created.';
ok(!!TR[MULTILINE], '多行 msgid 没有被正确拼接（解析器只读了第一行？）',
	'期望在 po 里找到 ' + JSON.stringify(MULTILINE));
// ref 注释行（'#: …'）已按约定从 po / pot 中删除：它们由 xgettext 重新生成，
// 留在库里只会随源码行号漂移而失效。这里把它钉成约定，防止有人再写回去。
var refEntries = poEntries.concat(potEntries).filter(function(e) { return e.refs.length > 0; });
ok(refEntries.length === 0, 'po / pot 不应再带 #: ref 注释行（由 xgettext 重新生成，行号会漂移）',
	refEntries.slice(0, 5).map(function(e) {
		return JSON.stringify(e.msgid) + ' ← ' + e.refs.join(' | ');
	}).join('\n      '));

// ---------- M. 守卫：po 头部声明了语言与复数形式 ----------

console.log('--- M. 守卫：po 头部 ---');
// 头部字段之间用「字面反斜杠 n」分隔（po 文件里写的是 "…\n"），而 poUnescape 刻意
// 不反转义 \n（要跟 po2lmo 的 extract_string 保持一致），所以这里先自己还原换行。
var headerText = poHeader.msgstr.replace(/\\n/g, '\n');
ok(/^Language:\s*zh_Hans\s*$/m.test(headerText),
	'po 头部缺少 "Language: zh_Hans"', JSON.stringify(poHeader.msgstr.slice(0, 200)));
ok(/Plural-Forms:\s*nplurals=1/.test(headerText),
	'po 头部缺少 nplurals=1 的 Plural-Forms（中文只有一个复数形式）');

// ---------- N. 回归：已删除的陈旧「页面说明」条目不得复活 ----------
//
// 这三条曾以 view 描述的形式存在，但源码里没有对应的 _() 调用（refs 指向的行号
// 也不存在）。它们只会在「孤儿条目」检查里露头；这里再钉一遍，防止回滚。

console.log('--- N. 回归：陈旧条目 ---');
[
	'A dedicated editor for OpenWrt Multi-Link Operation',
	'Edit all wireless interfaces here',
	'This page is focused on backend MLO settings'
].forEach(function(stale) {
	var hit = Object.keys(TR).filter(function(k) { return k.indexOf(stale) === 0; });
	ok(hit.length === 0, '陈旧的页面说明条目复活了：' + JSON.stringify(stale),
		hit.map(function(k) { return JSON.stringify(k); }).join('\n      '));
});

// ---------- 汇总 ----------

console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + (checks - fails) + '/' + checks);
process.exit(fails ? 1 : 0);
