#!/usr/bin/env node
/*
 * 视图回归测试：把 wifimanager.js 真的执行起来，断言它在 LuCI 框架里的可观察行为。
 *
 * 为什么需要它：本仓库没有 DOM 测试框架（没有 jsdom、没有 npm 依赖），所以
 * luci-app-online-upgrade 的 view.test.js 只能做「源码级」断言（正则匹配 + 花括号
 * 配平）。那种断言能挡住"这行代码被删了"，但挡不住"这行代码还在、行为却是错的"
 * —— 而 wifimanager.js 里的几个 bug 恰好都是后者：`o.default = o.enabled` 这行代码本身
 * 完全合法，只有把它放进 form.Flag 的 parse/renderWidget 语义里跑一遍，才能看出
 * 它会把 mlo=1 写到每一个老接口上。
 *
 * 所以本文件自带一个迷你 DOM 和一套框架替身，用 new Function 把 wifimanager.js 真的加载
 * 起来，然后走完整的 load() → render() → 保存/取消/轮询 流程。
 *
 * 替身不是"随便写的假对象"：每一个都逐行照抄 luci-base 里真正决定行为的实现，
 * 并在注释里标出源码行号。断言的对象是「wifimanager.js 在真实框架里的行为」，所以替身
 * 必须与框架同构 —— 比框架宽松的替身会让 bug 溜过去，比框架严格的替身会误报。
 *
 * 运行：node tests/view.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// MLO_VIEW_JS 是给 tests/mutation.test.js 用的注入点：把被测文件换成一份故意
// 改坏的副本，用来证明下面的断言真的能抓住对应的 bug。正常跑测试不需要设它。
const JS_PATH = process.env.MLO_VIEW_JS ||
	path.join(ROOT, 'htdocs/luci-static/resources/view/wifimanager.js');

let checks = 0, fails = 0, skips = 0;

// DOM 节点带 parentNode 反向引用，直接 JSON.stringify 会撞上循环结构
function show(v) {
	if (v === undefined) return 'undefined';
	if (v instanceof El) return '<' + v.tagName.toLowerCase() + '> ' + JSON.stringify(textOf(v));
	if (v instanceof TextNode) return JSON.stringify(v.textContent);
	try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function ok(cond, label, extra) {
	checks++;
	if (!cond) { fails++; console.log('FAIL  ' + label + (extra ? '\n      ' + extra : '')); }
}
function eq(got, want, label) {
	ok(got === want, label, 'got:  ' + show(got) + '\n      want: ' + show(want));
}
function skip(label, why) {
	skips++;
	console.log('SKIP  ' + label + (why ? '  (' + why + ')' : ''));
}

// ============================================================================
// 1. 迷你 DOM
//
// 只实现 wifimanager.js 用到的那部分：E() 建树、dom.content/append、replaceChild、
// insertBefore、firstChild，以及 [attr="value"] 形式的 querySelector。
// 任何超出范围的选择器都会抛错 —— 静默返回 null 会让断言变成永远通过。
// ============================================================================

function TextNode(text) {
	this.nodeType = 3;
	this.textContent = String(text);
	this.parentNode = null;
}

function El(tag) {
	this.nodeType = 1;
	this.tagName = String(tag).toUpperCase();
	this.childNodes = [];
	this.parentNode = null;
	this.attrs = Object.create(null);
	this._data = Object.create(null);
	this._handlers = Object.create(null);
}

Object.defineProperty(El.prototype, 'firstChild', {
	get: function() { return this.childNodes[0] || null; }
});

El.prototype.appendChild = function(node) {
	if (node.parentNode) node.parentNode.removeChild(node);
	node.parentNode = this;
	this.childNodes.push(node);
	return node;
};

El.prototype.insertBefore = function(node, ref) {
	if (!ref) return this.appendChild(node);
	const i = this.childNodes.indexOf(ref);
	if (i < 0) return this.appendChild(node);
	if (node.parentNode) node.parentNode.removeChild(node);
	node.parentNode = this;
	this.childNodes.splice(i, 0, node);
	return node;
};

El.prototype.replaceChild = function(node, old) {
	const i = this.childNodes.indexOf(old);
	if (i < 0) throw new Error('迷你 DOM: replaceChild 的旧节点不是子节点');
	if (node.parentNode) node.parentNode.removeChild(node);
	node.parentNode = this;
	old.parentNode = null;
	this.childNodes[i] = node;
	return old;
};

El.prototype.removeChild = function(node) {
	const i = this.childNodes.indexOf(node);
	if (i < 0) return node;
	this.childNodes.splice(i, 1);
	node.parentNode = null;
	return node;
};

El.prototype.setAttribute = function(k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k) { return (k in this.attrs) ? this.attrs[k] : null; };
El.prototype.removeAttribute = function(k) { delete this.attrs[k]; };
El.prototype.matches = function(sel) { return matchesSelector(this, sel); };

El.prototype.querySelector = function(sel) {
	for (const child of this.childNodes) {
		if (child.nodeType !== 1) continue;
		if (matchesSelector(child, sel)) return child;
		const found = child.querySelector(sel);
		if (found) return found;
	}
	return null;
};

function matchesSelector(node, sel) {
	const m = /^\[([^\]="]+)(?:="([^"]*)")?\]$/.exec(sel);
	if (!m) throw new Error('迷你 DOM 只支持 [attr="value"] 选择器，收到: ' + sel);
	if (!(m[1] in node.attrs)) return false;
	return m[2] === undefined || node.attrs[m[1]] === m[2];
}

function textOf(node) {
	if (node == null) return '';
	if (node.nodeType === 3) return node.textContent;
	let out = '';
	for (const child of node.childNodes) out += textOf(child);
	return out;
}

function walk(node, fn) {
	fn(node);
	for (const child of node.childNodes || []) walk(child, fn);
}

function countMatches(root, sel) {
	let n = 0;
	walk(root, function(node) { if (node.nodeType === 1 && matchesSelector(node, sel)) n++; });
	return n;
}

function findButtons(root) {
	const out = [];
	walk(root, function(node) {
		if (node.nodeType === 1 && typeof node._handlers.click === 'function')
			out.push({ text: textOf(node), click: node._handlers.click });
	});
	return out;
}

// renderMetric() 的结构是 div > [div(标签), div(数值)]，这里按这个形状取值。
function metricValue(box, label) {
	let value = null;
	walk(box, function(node) {
		if (node.nodeType !== 1 || node.tagName !== 'DIV' || node.childNodes.length !== 2) return;
		const a = node.childNodes[0], b = node.childNodes[1];
		if (a.nodeType !== 1 || b.nodeType !== 1) return;
		if (a.tagName !== 'DIV' || b.tagName !== 'DIV') return;
		if (a.childNodes.length !== 1 || b.childNodes.length !== 1) return;
		if (textOf(a) === label) value = textOf(b);
	});
	return value;
}

// ============================================================================
// 2. 全局替身：E() / dom / L / _ / String.prototype.format
// ============================================================================

function E(tag, attrib, children) {
	if (attrib == null || Array.isArray(attrib) || typeof attrib === 'string' ||
	    typeof attrib === 'number' || attrib instanceof El || attrib instanceof TextNode) {
		children = attrib;
		attrib = null;
	}

	const node = new El(tag);

	if (attrib) {
		for (const k of Object.keys(attrib)) {
			const v = attrib[k];
			if (typeof v === 'function') node._handlers[k] = v;
			else node.attrs[k] = String(v);
		}
	}

	dom.content(node, children === undefined ? null : children);

	return node;
}

const dom = {
	// luci.js:1728 bindClassInstance → data(node, '_class', inst)
	bindClassInstance(node, inst) { return this.data(node, '_class', inst); },
	// luci.js:1748 findClassInstance：从自身起沿 parentNode 向上找 _class。
	// 真实实现要求 inst instanceof Class，这里放宽为"任意真值" —— 替身里的
	// Map 实例不是真的 baseclass，放宽不会改变被测代码的行为。
	findClassInstance(node) {
		while (node) {
			const inst = this.data(node, '_class');
			if (inst) return inst;
			node = node.parentNode;
		}
		return null;
	},
	data(node, key, val) {
		if (!node) return null;
		node._data = node._data || Object.create(null);
		if (arguments.length > 2) { node._data[key] = val; return val; }
		return (key in node._data) ? node._data[key] : null;
	},
	content(node, children) {
		while (node.childNodes.length)
			node.removeChild(node.childNodes[0]);
		if (children != null)
			this.append(node, children);
	},
	append(node, children) {
		if (children == null) return;
		if (Array.isArray(children)) {
			for (const child of children) this.append(node, child);
		}
		else if (children instanceof El || children instanceof TextNode) {
			node.appendChild(children);
		}
		else if (children !== false) {
			node.appendChild(new TextNode(children));
		}
	}
};

const L = {
	// luci.js:3083
	toArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [ v ]); },
	// luci.js:3117：失败或 null 都退回默认值
	resolveDefault(promise, def) {
		return Promise.resolve(promise)
			.then(function(val) { return (val != null) ? val : def; })
			.catch(function() { return def; });
	},
	// luci.js:2246
	naturalCompare: new Intl.Collator(undefined, { numeric: true }).compare
};

// cbi.js:647 的 String.prototype.format：%s/%d/%j/%h/%%
String.prototype.format = function() {
	const args = arguments;
	let i = 0;
	return String(this).replace(/%(.)/g, function(m, c) {
		if (c === '%') return '%';
		const v = args[i++];
		switch (c) {
		case 's': return String(v);
		case 'd': return String(parseInt(v, 10));
		case 'j': return JSON.stringify(v);
		case 'h': return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		default: return m;
		}
	});
};

// luci-base 的 _()：查不到就原样返回。测试里断言的就是英文原文。
function _(s) { return String(s).trim(); }

function isEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 逐字照抄 uci.js:11-17。uci.js 用它在 set() 里判断"除了 ignore 这个键以外
// 还有没有别的键"，据此决定是删掉整张表还是只删一个键。这里必须一致，否则
// 待删标记会被兄弟选项的写入误清空（见下面 set() 的注释）。
function isEmpty(object, ignore) {
	for (const property in object)
		if (Object.prototype.hasOwnProperty.call(object, property) && property != ignore)
			return false;

	return true;
}

// ============================================================================
// 3. uci 替身（逐行镜像 uci.js）
// ============================================================================

function makeUci(files) {
	const state = {
		values: Object.create(null),
		creates: Object.create(null),
		changes: Object.create(null),
		deletes: Object.create(null),
		newidx: 1
	};

	for (const conf of Object.keys(files)) {
		state.values[conf] = Object.create(null);
		for (const sid of Object.keys(files[conf])) {
			const sec = Object.assign(Object.create(null), files[conf][sid]);
			sec['.name'] = sid;
			sec['.anonymous'] = sec['.anonymous'] || false;
			sec['.index'] = sec['.index'] || 0;
			state.values[conf][sid] = sec;
		}
	}

	const uci = {
		state: state,

		load(conf) { return Promise.resolve([ conf ]); },        // uci.js:231

		add(conf, type, name) {                                   // uci.js:295
			const n = state.creates;
			const sid = name || ('cfg' + state.newidx);
			n[conf] ??= Object.create(null);
			n[conf][sid] = {
				'.type': type, '.name': sid, '.create': name,
				'.anonymous': !name, '.index': 1000 + state.newidx++
			};
			return sid;
		},

		remove(conf, sid) {                                       // uci.js:367
			const v = state.values, n = state.creates, c = state.changes, d = state.deletes;
			if (n[conf]?.[sid]) {
				delete n[conf][sid];
			}
			else if (v[conf]?.[sid]) {
				if (c[conf]) delete c[conf][sid];
				d[conf] ??= Object.create(null);
				d[conf][sid] = true;
			}
		},

		sections(conf, type) {                                    // uci.js:455
			const sa = [];
			const v = state.values, n = state.creates, c = state.changes, d = state.deletes;
			if (!v[conf]) return sa;
			for (const s of Object.keys(v[conf])) {
				if (d[conf] && d[conf][s] === true) continue;
				if (type && v[conf][s]['.type'] !== type) continue;
				sa.push(Object.assign({}, v[conf][s], c[conf] ? c[conf][s] : null));
			}
			if (n[conf]) for (const s of Object.keys(n[conf])) {
				if (type && n[conf][s]['.type'] !== type) continue;
				sa.push(Object.assign({}, n[conf][s]));
			}
			sa.sort(function(a, b) { return a['.index'] - b['.index']; });
			for (let i = 0; i < sa.length; i++) sa[i]['.index'] = i;
			return sa;
		},

		get(conf, sid, opt) {                                     // uci.js:514
			const v = state.values, n = state.creates, c = state.changes, d = state.deletes;
			if (sid == null) return null;
			if (n[conf]?.[sid]) {
				if (opt == null) return n[conf][sid];
				return n[conf][sid][opt];
			}
			if (opt != null) {
				if (d[conf]?.[sid])
					if (d[conf][sid] === true || d[conf][sid][opt]) return null;
				if (c[conf]?.[sid]?.[opt] != null) return c[conf][sid][opt];
				if (v[conf]?.[sid]) return v[conf][sid][opt];
				return null;
			}
			if (d[conf]?.[sid] === true) return null;
			const s = v[conf]?.[sid];
			if (!s) return null;

			// uci.js:559-570：把 changes 合并进去、把"待删除"的选项真的删掉。
			// 注意它合并的是 v[conf][sid] 这个缓存对象本身（不是副本），真实
			// LuCI 就是这么写的 —— 不要"顺手修好"，否则测的就不是真框架了。
			if (c[conf]?.[sid])
				for (const opt in c[conf][sid])
					if (c[conf][sid][opt] != null) s[opt] = c[conf][sid][opt];
			if (d[conf]?.[sid])
				for (const opt in d[conf][sid]) delete s[opt];

			return s;
		},

		set(conf, sid, opt, val) {                                // uci.js:599
			const v = state.values, n = state.creates, c = state.changes, d = state.deletes;
			if (sid == null || opt == null || opt.charAt(0) === '.') return;
			if (n[conf]?.[sid]) {
				if (val != null) n[conf][sid][opt] = val;
				else delete n[conf][sid][opt];
			}
			else if (val != null && val !== '') {
				if (d[conf] && d[conf][sid] === true) return;
				if (!v[conf]?.[sid]) return;
				c[conf] ??= Object.create(null);
				c[conf][sid] ??= Object.create(null);
				// uci.js:629-634 "undelete option"：只有 opt 是**最后一个**待删
				// 项时才丢掉整张表，否则只丢掉 opt 这一项。早先这里写成了
				// "d[conf][sid][opt] 不存在就删掉整张表"，于是写 wds 会把待删的
				// ssid 标记一起清掉 —— 测试因此漏报过一个真实缺陷。
				if (d[conf]?.[sid]) {
					if (isEmpty(d[conf][sid], opt)) delete d[conf][sid];
					else delete d[conf][sid][opt];
				}
				c[conf][sid][opt] = val;
			}
			else {
				// uci.js:640-645：撤销该选项已有的改动，同样用 isEmpty 判断
				// 是否该丢掉整张表。
				if (c[conf]?.[sid]) {
					if (isEmpty(c[conf][sid], opt)) delete c[conf][sid];
					else delete c[conf][sid][opt];
				}
				// uci.js:648-653：只删存在的选项；整段已被标记删除时保持 true，
				// 不能被降级成 {opt:true}（那会让 sections() 以为这段还活着）。
				if (v[conf]?.[sid] && Object.prototype.hasOwnProperty.call(v[conf][sid], opt)) {
					d[conf] ??= Object.create(null);
					d[conf][sid] ??= Object.create(null);
					if (d[conf][sid] !== true) d[conf][sid][opt] = true;
				}
			}
		},

		unset(conf, sid, opt) { return uci.set(conf, sid, opt, null); }   // uci.js:675
	};

	return uci;
}

// ============================================================================
// 4. form 替身
// ============================================================================

function makeForm(env) {
	const uci = env.uci;
	const form = {};

	// ---- 选项基类：默认值照抄 form.js:1435-1439 ----
	function Option(section, opt, title, description) {
		this.section = section;
		this.map = section.map;
		this.config = section.map.config;
		this.option = opt;
		this.title = title;
		this.description = description;
		this.rmempty = true;
		this.default = null;
		this.optional = false;
		this.retain = false;
		this.modalonly = false;
		this.deps = [];
		this._input = Object.create(null);   // sid -> 控件里当前的输入值
		section.children.push(this);
	}
	Option.prototype.depends = function(o, v) { this.deps.push([ o, v ]); return this; };
	// 逐行照抄 form.js:4381-4387：keylist 是候选值（字符串），vallist 是对应标签。
	// 上游对标签还允许传 DOM 节点（dom.elem(val) 分支），本页只传字符串。
	Option.prototype.value = function(key, val) {
		(this.keylist ??= []).push(String(key));
		(this.vallist ??= []).push(String(val != null ? val : key));
		return this;
	};
	// 镜像 form.js:1878-1886 AbstractValue.load：读**原始配置值**（不是 cfgvalue）。
	// 上游把 load() 的返回值缓存进 cfgvalue（form.js:947-961），所以本替身让
	// cfgvalue 也走缓存 —— 否则 load() 写错（例如返回 undefined）测试看不出来。
	Option.prototype.load = function(sid) { return uci.get(this.config, sid, this.option); };
	Option.prototype.cfgvalue = function(sid, setValue) {
		if (arguments.length == 2) {
			this._loaded ??= Object.create(null);
			this._loaded[sid] = setValue;
			return setValue;
		}

		return this._loaded ? this._loaded[sid] : undefined;
	};
	// 通用 render：控件初值 = 配置值，没有配置值就取 default（form.js:1425-1439 的语义）
	Option.prototype.render = function(sid) {
		const cfgvalue = this.cfgvalue(sid);
		this._input[sid] = (cfgvalue != null) ? cfgvalue : this.default;
		return this._input[sid];
	};
	// 通用 formvalue：控件存在就读控件，控件不存在则退回配置值（Flag 会覆盖它）
	Option.prototype.formvalue = function(sid) {
		return (sid in this._input) ? this._input[sid] : this.cfgvalue(sid);
	};
	// 镜像 form.js:2091 isActive() + form.js:781-817 isDependencySatisfied()：
	// 没有 depends 的选项恒为可见（form.js:784-785 直接 return true）；多个
	// depends() 之间是"或"；被依赖的选项自身不可见时取 null（form.js:802）。
	//
	// 这一步必须忠实，否则测不出 T12：选项"不可见"不是无害的 ——
	// form.js:2171-2172 会在选项不可见时 remove() 掉它。
	Option.prototype.isActive = function(sid) {
		if (!this.deps.length)
			return true;

		return this.deps.some(function(dep) {
			const opt = this.section.children.filter(o => o.option === dep[0])[0];
			const val = (opt && opt.isActive(sid)) ? opt.formvalue(sid) : null;

			return val == dep[1];
		}, this);
	};
	Option.prototype.isValid = function() { return true; };
	// form.js:2200 / form.js:2224
	Option.prototype.write = function(sid, val) { return this.map.data.set(this.config, sid, this.option, val); };
	Option.prototype.remove = function(sid) { return this.map.data.unset(this.config, sid, this.option); };
	// 镜像 form.js:1790-1830 checkDepends()/updateDefaultValue()：选项可见时，
	// defaults 表里第一个条件满足的条目决定该 section 的 default；条件表为空的
	// 条目是兜底值。上游 wireless.js 的 ieee80211w 就是靠它按加密方式给默认值。
	Option.prototype.checkDepends = function(sid) {
		this.updateDefaultValue(sid);
		return this.isActive(sid);
	};
	// 镜像 form.js:1770 isDependencySatisfied()：条件比的是**另一个选项的
	// formvalue()**（即控件里的当前值），不是原始 UCI 值 —— 所以没在 UCI 里写过
	// encryption 的接口，比的是 encryption 自己的默认值 'sae'。
	Option.prototype.depValue = function(sid, name) {
		const opt = this.section.children.filter(o => o.option === name)[0];
		return opt ? opt.formvalue(sid) : uci.get(this.config, sid, name);
	};
	Option.prototype.updateDefaultValue = function(sid) {
		if (!this.defaults || typeof this.defaults !== 'object') return;

		const cfgvalue = L.toArray(this.cfgvalue(sid))[0];
		let fallback = null, satisfied = null;

		for (const value of Object.keys(this.defaults)) {
			const conds = this.defaults[value];
			if (!conds || conds.length === 0) { fallback = value; continue; }
			if (conds.some(c => Object.keys(c).every(k => this.depValue(sid, k) == c[k]))) {
				satisfied = value;
				break;
			}
		}

		if (satisfied == null) satisfied = fallback;

		if (satisfied != null && cfgvalue == null)
			this._input[sid] = satisfied;

		this.default = satisfied;
	};
	// 通用 parse：逐行镜像 form.js:2141
	Option.prototype.parse = function(sid) {
		if (this.isActive(sid)) {
			const cval = this.cfgvalue(sid);
			const fval = this.formvalue(sid);

			if (fval == null || fval == '' || (fval == this.default && (this.optional || this.rmempty))) {
				if (this.rmempty || this.optional)
					return Promise.resolve(this.remove(sid));

				return Promise.reject(new TypeError('Option "' + this.title + '" must not be empty.'));
			}
			else if (this.forcewrite || !isEqual(cval, fval)) {
				return Promise.resolve(this.write(sid, fval));
			}
		}
		else if (!this.retain) {
			return Promise.resolve(this.remove(sid));
		}

		return Promise.resolve();
	};
	form.Option = Option;

	// ---- Flag：镜像 form.js:5033 ----
	function Flag(section, opt, title, desc) {
		Option.call(this, section, opt, title, desc);
		this.enabled = '1';                 // form.js:5038
		this.disabled = '0';                // form.js:5039
		this.default = this.disabled;       // form.js:5040
	}
	Flag.prototype = Object.create(Option.prototype);
	Flag.prototype.constructor = Flag;

	// 渲染控件：镜像 form.js:5085 renderWidget —— cfgvalue 为 null 时拿 default 当初值
	Flag.prototype.render = function(sid) {
		const cfgvalue = this.cfgvalue(sid);
		const value = (cfgvalue != null) ? cfgvalue : this.default;
		this._input[sid] = (value == this.enabled) ? this.enabled : this.disabled;
		return this._input[sid];
	};
	// 镜像 form.js:5123 formvalue：读控件勾选状态；控件不存在时按未勾选算
	Flag.prototype.formvalue = function(sid) {
		return (sid in this._input) ? this._input[sid] : this.disabled;
	};
	// 镜像 form.js:5130 textvalue
	Flag.prototype.textvalue = function(sid) {
		let cval = this.cfgvalue(sid);
		if (cval == null) cval = this.default;
		return (cval == this.enabled) ? _('Yes') : _('No');
	};
	// parse：逐行镜像 form.js:5145
	Flag.prototype.parse = function(sid) {
		if (this.isActive(sid)) {
			const fval = this.formvalue(sid);

			if (fval == this.default && (this.optional || this.rmempty))
				return Promise.resolve(this.remove(sid));

			return Promise.resolve(this.write(sid, fval));
		}
		else if (!this.retain) {
			return Promise.resolve(this.remove(sid));
		}

		return Promise.resolve();
	};
	form.Flag = Flag;

	// ---- 其余选项类型：本页只用到 value()/default/datatype/validate，行为等价 ----
	function sub(cls) {
		function Sub(section, opt, title, desc) { Option.call(this, section, opt, title, desc); }
		Sub.prototype = Object.create(Option.prototype);
		Sub.prototype.constructor = Sub;
		form[cls] = Sub;
	}
	[ 'Value', 'MultiValue', 'DynamicList', 'DummyValue' ].forEach(sub);

	// ---- ListValue：镜像 form.js:4654 的 CBIListValue ----
	//
	// 这一份必须忠实，否则"配置里的取值不在候选表里"这类 bug 根本测不出来：
	//
	//   render    ← form.js:4706-4719 renderWidget 把 (cfgvalue ?? default) 交给
	//               ui.Select；ui.js:832-840 只给**候选键**加 selected，一个都没
	//               匹配上时没有任何 option 带 selected，而按 HTML 规范，非
	//               multiple 的 select 在无人带 selected 时把**第一个** option
	//               当作选中项。于是控件读到的是第一个候选，而不是配置里的值。
	//   formvalue ← form.js:4994-4999：控件值等于 default 时返回 null —— 上游把
	//               "和默认值一样"当作"没设置"，parse() 再据此决定删除还是报错。
	function ListValue(section, opt, title, desc) { Option.call(this, section, opt, title, desc); }
	ListValue.prototype = Object.create(Option.prototype);
	ListValue.prototype.constructor = ListValue;
	ListValue.prototype.render = function(sid) {
		const cfgvalue = this.cfgvalue(sid);
		const keys = this.keylist || [];
		const shown = (cfgvalue != null) ? cfgvalue : this.default;

		this._input[sid] = (keys.indexOf(shown) > -1) ? shown : keys[0];
		return this._input[sid];
	};
	ListValue.prototype.formvalue = function(sid) {
		if (!(sid in this._input))
			return null;

		const val = '' + this._input[sid];

		return (val === (this.default != null ? '' + this.default : undefined)) ? null : val;
	};
	form.ListValue = ListValue;

	// ---- GridSection ----
	function GridSection(map, type, title) {
		this.map = map;
		this.sectiontype = type;
		this.title = title;
		this.children = [];
		this.tabs = [];
		this.uciconfig = null;
		this.lastModal = null;
	}
	GridSection.prototype.tab = function(name, title) { this.tabs.push({ name, title }); };
	GridSection.prototype.taboption = function(tab, cls, opt, title, desc) {
		const o = new cls(this, opt, title, desc);
		o.tab = tab;
		return o;
	};
	GridSection.prototype.option = function(cls, opt, title, desc) {
		return new cls(this, opt, title, desc);
	};
	// form.js:3753
	GridSection.prototype.getPreviousModalMap = function() { return env.getPreviousModalMap(); };
	GridSection.prototype.renderMoreOptionsModal = function(sid) {
		this.lastModal = sid;
		return Promise.resolve();
	};
	// 逐行镜像 form.js:4030-4040（这正是 BUG 2 里 wifimanager.js 必须配合的那段框架逻辑）
	GridSection.prototype.handleModalCancel = function(modalMap, ev, isSaving) {
		const config_name = this.uciconfig ?? this.map.config;
		const mapNode = this.getPreviousModalMap();
		const prevMap = mapNode ? dom.findClassInstance(mapNode) : this.map;

		if (prevMap.addedSection != null && !isSaving)
			this.map.data.remove(config_name, prevMap.addedSection);

		delete prevMap.addedSection;
	};
	// 镜像 form.js:947-961 AbstractSection.load：渲染前按 section 逐个调用子选项的
	// load(sid)，再把返回值写进 cfgvalue 的缓存（上游就是靠这一步给控件喂初值）。
	// 少了它，在 load() 里补候选值的选项（wifimanager.js 用它保住配置里已有的取值）不生效。
	GridSection.prototype.load = function() {
		for (const sec of uci.sections(this.map.config, this.sectiontype)) {
			const sid = sec['.name'];
			for (const o of this.children)
				o.cfgvalue(sid, o.load(sid));
		}

		return Promise.resolve();
	};
	// 镜像 CBIGridSection.renderContents：每个 section 一行；modalonly=false 的
	// 选项渲染成表格单元（form.js:4085 renderTextValue 会直接 append textvalue()）
	GridSection.prototype.renderContents = function() {
		const el = E('div', { 'class': 'cbi-section' });
		for (const sec of uci.sections(this.map.config, this.sectiontype)) {
			const row = E('div', { 'class': 'tr', 'data-section': sec['.name'] });
			for (const o of this.children) {
				if (o.modalonly) continue;
				const td = E('div', { 'class': 'td' });
				dom.append(td, o.textvalue ? o.textvalue(sec['.name']) : '');
				row.appendChild(td);
			}
			el.appendChild(row);
		}
		return el;
	};
	// 打开编辑弹窗：镜像 renderMoreOptionsModal → m.render() 的流程。真实顺序是
	// CBIMap.render = load() → renderContents()（先渲染全部子控件，再 checkDepends），
	// 所以这里也按 load → render → checkDepends 走：
	//   load         —— form.js:947-961，补候选值 / 给 cfgvalue 建缓存；
	//   render       —— 建控件，初值 = cfgvalue ?? default（form.js:1425-1439）；
	//   checkDepends —— form.js:675-712 的收尾，按 defaults 解析出本 section 的
	//                   默认值并回填控件（上游是 setValue，这里是 _input）。
	GridSection.prototype.openModal = function(sid) {
		for (const o of this.children)
			o.cfgvalue(sid, o.load(sid));

		for (const o of this.children)
			if (typeof o.render === 'function') o.render(sid);

		for (const o of this.children)
			o.checkDepends(sid);

		return this.renderMoreOptionsModal(sid);
	};
	// 弹窗保存时走的是 CBINamedSection.parse()，即 form.js:976-987 的
	// AbstractSection.parse：**不分 editable/modalonly，逐个 parse 所有子选项**
	// （对比 CBIGridSection.parse 只处理 editable && !modalonly 的选项，
	// form.js:4115-4132 —— 所以 mode/encryption/ieee80211w 只在弹窗里被解析）。
	GridSection.prototype.parseModal = function(sid) {
		return Promise.all(this.children.map(function(o) {
			return (typeof o.parse === 'function') ? o.parse(sid) : Promise.resolve();
		}));
	};
	form.GridSection = GridSection;

	// ---- Map ----
	function Map(config, title) {
		this.config = config;
		this.title = title;
		this.data = uci;                  // form.js:400（this.data = uci）
		this.children = [];
		this.root = null;
		this.readonly = false;
	}
	Map.prototype.chain = function() { return this; };
	Map.prototype.section = function(cls, type, title) {
		const s = new cls(this, type, title);
		this.children.push(s);
		return s;
	};
	// 镜像 form.js:566-581 CBIMap.load：读完配置后逐个 load 子 section；section
	// 的 load 再往下 load 每个选项（见 GridSection.load）。
	Map.prototype.load = function() {
		return Promise.all(this.children.map(function(c) {
			return (typeof c.load === 'function') ? c.load() : Promise.resolve();
		}));
	};
	// 逐行镜像 form.js:675-712：root 只建一次，每次调用都清空重建子节点
	Map.prototype.renderContents = function() {
		this.root ??= E('div', { 'id': 'cbi-%s'.format(this.config), 'class': 'cbi-map' });
		dom.bindClassInstance(this.root, this);
		const nodes = this.children.map(function(c) { return c.renderContents(); });
		dom.content(this.root, null);
		if (this.title != null && this.title !== '')
			this.root.appendChild(E('h2', { 'name': 'content' }, this.title));
		dom.append(this.root, nodes);
		return Promise.resolve(this.root);
	};
	Map.prototype.render = function() { return this.load().then(() => this.renderContents()); };
	Map.prototype.reset = function() { return this.renderContents(); };
	form.Map = Map;

	return form;
}

// ============================================================================
// 5. 沙箱：真的把 wifimanager.js 加载起来
// ============================================================================

const view = {
	// 镜像 baseclass.extend 的最小形态：new View() → 实例上带 proto 的方法
	extend(proto) {
		function View(...args) {
			this.args = args;
			if (typeof this.__init__ === 'function') this.__init__(...args);
		}
		View.prototype = Object.create(view.prototype);
		Object.assign(View.prototype, proto);
		View.extend = view.extend;
		return View;
	}
};
view.prototype = {};   // baseclass 的 extend 以 view.prototype 为原型链起点

function makeEnv(fixture) {
	const env = {
		status: fixture.status || {},
		stations: fixture.stations || {},
		notifications: [],
		polls: [],
		assocCalls: [],
		maps: [],
		sections: [],
		modalMapNode: null,
		getPreviousModalMap() { return env.modalMapNode; }
	};

	env.uci = makeUci(fixture.uci);

	env.rpc = {
		declare(spec) {
			return function(...args) {
				if (spec.method === 'getWirelessDevices')
					return Promise.resolve(env.status);
				if (spec.method === 'assoclist') {
					env.assocCalls.push(args);
					return Promise.resolve(env.stations[args[0]] || []);
				}
				throw new Error('未预期的 rpc 调用: ' + spec.object + '/' + spec.method);
			};
		}
	};

	env.ui = {
		addNotification(type, node) {
			env.notifications.push({ type: type, node: node, text: textOf(node) });
		},
		showModal() {}, hideModal() {}
	};

	env.poll = { add(fn, interval) { env.polls.push({ fn: fn, interval: interval }); } };

	env.form = makeForm(env);

	// 记录 render() 里建出来的 Map / GridSection，供断言直接拿到实例
	const origMap = env.form.Map;
	env.form.Map = function(config, title) {
		const m = new origMap(config, title);
		env.maps.push(m);
		return m;
	};
	const origGrid = env.form.GridSection;
	env.form.GridSection = function(map, type, title) {
		const s = new origGrid(map, type, title);
		env.sections.push(s);
		return s;
	};

	env.dom = dom;

	return env;
}

function loadViewClass(env) {
	const src = fs.readFileSync(JS_PATH, 'utf8');
	// wifimanager.js 的模块体就是一个函数体：'require …' 是字符串表达式，return 返回视图类。
	const factory = new Function(
		'view', 'form', 'uci', 'ui', 'dom', 'poll', 'rpc', 'L', 'E', '_', src);

	return factory(view, env.form, env.uci, env.ui, env.dom, env.poll, env.rpc, L, E, _);
}

async function buildPage(fixture) {
	const env = makeEnv(fixture);
	const View = loadViewClass(env);
	const v = new View();

	await v.load();
	const root = await v.render([ null, null, fixture.status || {} ]);

	return { env: env, view: v, root: root, map: env.maps[0], section: env.sections[0] };
}

function optOf(section, name) {
	return section.children.filter(function(o) { return o.option === name; })[0];
}

// ============================================================================
// 6. 固件数据
// ============================================================================

function mkStatus(radios, ifaces) {
	const st = {};
	radios.forEach(function(r, i) {
		st[r] = {
			up: true,
			config: { band: i ? '5g' : '2g', channel: i ? '36' : '6' },
			interfaces: []
		};
	});
	(ifaces || []).forEach(function(it) {
		st[it.radio].interfaces.push({
			section: it.section,
			ifname: it.ifname,
			config: Object.assign({ device: it.device || [ it.radio ] }, it.config || {}),
			stations: it.stations || []
		});
	});
	return st;
}

// 两个 radio + 一个老接口（没有 mlo 选项）+ 一个确实开了 MLO 的接口
const FIXTURE_LEGACY = {
	uci: {
		wireless: {
			radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
			radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
			wifi0: { '.type': 'wifi-iface', mode: 'ap', device: [ 'radio0' ], network: [ 'lan' ], ssid: 'legacy' },
			wifi1: { '.type': 'wifi-iface', mode: 'ap', mlo: '1', device: [ 'radio0', 'radio1' ],
				network: [ 'lan' ], ssid: 'mlo', encryption: 'sae' }
		},
		network: {
			lan: { '.type': 'interface' },
			wwan: { '.type': 'interface' }
		}
	},
	status: mkStatus([ 'radio0', 'radio1' ], [
		{ radio: 'radio0', section: 'wifi0', ifname: 'wlan0', config: { mode: 'ap', ssid: 'legacy' } },
		{ radio: 'radio0', section: 'wifi1', ifname: 'wlan0-mld0', config: { mode: 'ap', ssid: 'mlo', device: [ 'radio0', 'radio1' ] } },
		{ radio: 'radio1', section: 'wifi1', ifname: 'wlan1-mld0', config: { mode: 'ap', ssid: 'mlo', device: [ 'radio0', 'radio1' ] } }
	])
};

// 干净的两 radio 环境，wifi0 是已开启的 MLO 接口
const FIXTURE_TWO_RADIOS = {
	uci: {
		wireless: {
			radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
			radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
			wifi0: { '.type': 'wifi-iface', mode: 'ap', mlo: '1', device: [ 'radio0', 'radio1' ],
				network: [ 'lan' ], ssid: 'test', encryption: 'sae' }
		},
		network: {
			lan: { '.type': 'interface' },
			wwan: { '.type': 'interface' }
		}
	},
	status: mkStatus([ 'radio0', 'radio1' ], [
		{ radio: 'radio0', section: 'wifi0', ifname: 'wlan0-mld0',
			config: { mode: 'ap', ssid: 'test', encryption: 'sae', device: [ 'radio0', 'radio1' ] },
			stations: [ { mac: 'AA:BB:CC:00:00:01' } ] },
		{ radio: 'radio1', section: 'wifi0', ifname: 'wlan1-mld0',
			config: { mode: 'ap', ssid: 'test', encryption: 'sae', device: [ 'radio0', 'radio1' ] },
			stations: [ { mac: 'AA:BB:CC:00:00:01' }, { mac: 'AA:BB:CC:00:00:02' } ] }
	])
};

const FIXTURE_THREE_RADIOS = {
	uci: FIXTURE_TWO_RADIOS.uci,
	status: mkStatus([ 'radio0', 'radio1', 'radio2' ], [
		{ radio: 'radio0', section: 'wifi0', ifname: 'wlan0-mld0',
			config: { mode: 'ap', ssid: 'test', device: [ 'radio0', 'radio1' ] } }
	])
};

// 只有一个 radio
const FIXTURE_ONE_RADIO = {
	uci: {
		wireless: {
			radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
			wifi0: { '.type': 'wifi-iface', mode: 'ap', device: [ 'radio0' ], network: [ 'lan' ] }
		},
		network: { lan: { '.type': 'interface' } }
	},
	status: mkStatus([ 'radio0' ], [])
};

// 有 radio 但一个接口都没有
const FIXTURE_NO_IFACE = {
	uci: {
		wireless: {
			radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
			radio1: { '.type': 'wifi-device', band: '5g', channel: '36' }
		},
		network: { lan: { '.type': 'interface' } }
	},
	status: mkStatus([ 'radio0', 'radio1' ], [])
};

// 一个 radio 都没有：有线设备，或者 wifi 配置还没生成
const FIXTURE_NO_RADIO = {
	uci: {
		wireless: {},
		network: { lan: { '.type': 'interface' } }
	},
	status: {}
};

// 已经存在 mlo0，Quick Add 必须顺延到 mlo1
const FIXTURE_WITH_MLO0 = {
	uci: {
		wireless: Object.assign({
			mlo0: { '.type': 'wifi-iface', mode: 'ap', mlo: '1', device: [ 'radio0', 'radio1' ] }
		}, FIXTURE_TWO_RADIOS.uci.wireless),
		network: FIXTURE_TWO_RADIOS.uci.network
	},
	status: FIXTURE_TWO_RADIOS.status
};

// section 名撞上 Object.prototype 的成员：constructor / toString / valueOf / hasOwnProperty
const FIXTURE_PROTO = {
	uci: {
		wireless: {
			'constructor': { '.type': 'wifi-device', band: '2g', channel: '6' },
			'toString': { '.type': 'wifi-device', band: '5g', channel: '36' },
			'valueOf': { '.type': 'wifi-iface', mode: 'ap', mlo: '1', device: [ 'constructor' ],
				network: [ 'lan' ], ssid: 'proto', encryption: 'sae' },
			'hasOwnProperty': { '.type': 'wifi-iface', mode: 'ap', mlo: '0',
				device: [ 'toString', 'toString' ], network: [ 'lan' ], ssid: 'dup' },
			// device 指向一个**不存在**的 radio，而这个名字恰好是 Object.prototype 的成员。
			// radioMap() 是写操作，赋值本身会盖掉原型成员，所以只有"查不到"的时候才会漏出来。
			'isPrototypeOf': { '.type': 'wifi-iface', mode: 'ap', mlo: '0',
				device: [ 'toLocaleString' ], network: [ 'lan' ], ssid: 'phantom' }
		},
		network: { lan: { '.type': 'interface' } }
	},
	status: mkStatus([ 'constructor', 'toString' ], [
		{ radio: 'constructor', section: 'valueOf', ifname: 'wlan0-mld0',
			config: { mode: 'ap', ssid: 'proto', device: [ 'constructor' ] } },
		{ radio: 'toString', section: 'hasOwnProperty', ifname: 'wlan1',
			config: { mode: 'ap', ssid: 'dup', device: [ 'toString', 'toString' ] } }
	])
};

// ============================================================================
// 7. 用例
// ============================================================================

async function main() {

// ---------- T0. 沙箱自检 ----------

console.log('--- T0. 沙箱自检 ---');
{
	const page = await buildPage(FIXTURE_LEGACY);

	ok(page.root != null, 'render() 必须返回 map 根节点');
	eq(page.root.tagName, 'DIV', 'map 根节点应当是 div');
	eq(page.env.maps.length, 1, 'render() 里应当恰好建出一个 form.Map');
	eq(page.env.sections.length, 1, 'render() 里应当恰好建出一个 GridSection');
	eq(page.env.sections[0].children.length, 19, '选项数量应当与源码一致（19 个）');

	const rows = countMatches(page.root, '[data-section]');
	eq(rows, 2, '两个 wifi-iface 应当渲染出两行');
	ok(page.root.querySelector('[data-mlo-overview-section="wifi0"]') != null,
		'表格里应当有 wifi0 的概览单元');
	ok(page.root.querySelector('[data-mlo-runtime-section="wifi1"]') != null,
		'表格里应当有 wifi1 的运行时单元');
}

// ---------- T1. mlo 开关的默认值（BUG 1）----------

console.log('--- T1. mlo 开关的默认值 ---');
{
	const page = await buildPage(FIXTURE_LEGACY);
	const mlo = optOf(page.section, 'mlo');

	eq(mlo.default, '0', 'mlo 的默认值必须是"未启用"');
	eq(mlo.default, mlo.disabled, 'mlo.default 必须等于 form.Flag 的 disabled');
	eq(mlo.rmempty, false, 'mlo 必须 rmempty=false（与上游 mounts.js:137-139 的 anon_swap 同构）');

	// 症状一：表格里那一列显示的是 textvalue()，老接口不得被显示成"已启用 MLO"
	eq(mlo.textvalue('wifi0'), 'No', '没有 mlo 选项的老接口必须显示 No');
	eq(mlo.textvalue('wifi1'), 'Yes', '确实开了 MLO 的接口必须显示 Yes');

	// 症状二：打开弹窗 → 控件按 default 初始化 → 保存写回的必须是 0
	page.section.openModal('wifi0');
	eq(mlo.formvalue('wifi0'), '0', '老接口的 mlo 复选框必须是未勾选状态');

	await mlo.parse('wifi0');
	eq(page.env.uci.get('wireless', 'wifi0', 'mlo'), '0',
		'保存后写入的必须是 mlo=0 —— 而不是把没开过 MLO 的接口写成 mlo=1');
	ok(page.env.uci.get('wireless', 'wifi0', 'mlo') !== '1',
		'绝不能把 mlo=1 写到从没开过 MLO 的接口上');

	// 反过来：真开了 MLO 的接口必须原样保留 1
	page.section.openModal('wifi1');
	eq(mlo.formvalue('wifi1'), '1', '开了 MLO 的接口复选框必须是勾选状态');
	await mlo.parse('wifi1');
	eq(page.env.uci.get('wireless', 'wifi1', 'mlo'), '1', '开了 MLO 的接口必须写回 mlo=1');
}

// ---------- T2. Quick Add 的账目登记（BUG 2）----------

console.log('--- T2. Quick Add 的账目登记 ---');
{
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const s = page.section, map = page.env.maps[0];

	await s.handleAdd({ preventDefault() {} });

	const sid = 'mlo0';
	ok(page.env.uci.get('wireless', sid) != null, 'Quick Add 应当建出 ' + sid);
	eq(page.env.uci.get('wireless', sid, 'mode'), 'ap', 'AP MLO 的 mode=ap');
	eq(page.env.uci.get('wireless', sid, 'mlo'), '1', '新接口必须写 mlo=1');
	eq(page.env.uci.get('wireless', sid, 'disabled'), '0', '新接口必须写 disabled=0');
	eq(JSON.stringify(page.env.uci.get('wireless', sid, 'device')), JSON.stringify([ 'radio0', 'radio1' ]),
		'默认选中前两个 radio');
	eq(JSON.stringify(page.env.uci.get('wireless', sid, 'network')), JSON.stringify([ 'lan' ]),
		'AP 默认绑 lan');
	eq(page.env.uci.get('wireless', sid, 'encryption'), 'sae', 'AP MLO 默认 WPA3-SAE');
	eq(page.env.uci.get('wireless', sid, 'ieee80211w'), '2', '默认要求管理帧保护');
	eq(page.env.uci.get('wireless', sid, 'ssid'), 'OpenWrt-MLO', 'AP 默认 SSID');
	eq(map.addedSection, sid, 'quickAdd 必须把新建的 section 记到 map.addedSection 上');
	eq(s.lastModal, sid, '应当为新建的 section 打开编辑弹窗');

	// 用户点"取消"：框架按 addedSection 回滚（form.js:4030-4040）
	s.handleModalCancel(s, null, false);
	ok(page.env.uci.get('wireless', sid) == null, '取消后新建的 section 必须被回滚');
	ok(map.addedSection === undefined, '回滚后必须清掉 addedSection');

	// 保存路径：isSaving=true 时不得回滚
	await s.handleAdd(null);
	const sid2 = map.addedSection;
	ok(sid2 != null, '第二次 Quick Add 也要登记 addedSection');
	s.handleModalCancel(s, null, true);
	ok(page.env.uci.get('wireless', sid2) != null, 'isSaving=true 时不得回滚');

	// 弹窗叠加：getPreviousModalMap() 返回被盖住的 map 节点时，账目要记在那个 map 上
	await s.handleAdd(null);
	const sid3 = map.addedSection;
	page.env.modalMapNode = map.root;
	map.addedSection = undefined;
	await s.handleAdd(null);
	eq(map.addedSection, 'mlo' + (parseInt(sid3.slice(3), 10) + 1),
		'弹窗叠加时，addedSection 必须记在 findClassInstance 找到的那个 map 上');
}

{
	// 少于 2 个 radio：必须提前返回，不能建 section、不能登记账目
	const page = await buildPage(FIXTURE_ONE_RADIO);
	const before = page.env.uci.sections('wireless', 'wifi-iface').length;

	await page.section.handleAdd(null);

	eq(page.env.uci.sections('wireless', 'wifi-iface').length, before, '少于 2 个 radio 时不得建 section');
	eq(page.env.notifications.length, 1, '必须弹出提示');
	ok(/At least two configured radios/.test(page.env.notifications[0].text),
		'提示文案应当是"至少需要两个 radio"', page.env.notifications[0].text);
	ok(page.env.maps[0].addedSection === undefined, '没建 section 就不能登记 addedSection');
}

{
	// 已经存在 mlo0：必须顺延
	const page = await buildPage(FIXTURE_WITH_MLO0);
	await page.section.handleAdd(null);
	eq(page.env.maps[0].addedSection, 'mlo1', '已存在 mlo0 时必须顺延到 mlo1');
}

{
	// 概览框上的 STA 按钮：走的是同一个 quickAdd，但模式与默认网络不同
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const box = page.root.querySelector('[data-mlo-summary-box="1"]');
	const sta = findButtons(box).filter(function(b) { return /Quick Add STA MLO/.test(b.text); })[0];

	ok(!!sta, '概览框里应当有 STA 按钮');
	await sta.click({ preventDefault() {} });

	const sid = page.env.maps[0].addedSection;
	ok(sid != null, 'STA 按钮也应当登记 addedSection');
	eq(page.env.uci.get('wireless', sid, 'mode'), 'sta', 'STA 按钮应当建出 mode=sta');
	eq(JSON.stringify(page.env.uci.get('wireless', sid, 'network')), JSON.stringify([ 'wwan' ]),
		'STA 默认绑 wwan');
	ok(page.env.uci.get('wireless', sid, 'ssid') == null, 'STA 不写 ssid');
}

// ---------- T3. 概览框的生命周期（BUG 3）----------

console.log('--- T3. 概览框的生命周期 ---');
{
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const box = function() { return page.root.querySelector('[data-mlo-summary-box="1"]'); };

	ok(!!box(), '渲染后概览框必须存在');
	eq(page.root.firstChild, box(), '概览框必须是 map 的第一个子节点');
	eq(countMatches(page.root, '[data-mlo-summary-box="1"]'), 1, '概览框只能有一个');

	// 保存、取消弹窗都会走 renderContents()，框架会把整个 map 清空重建
	const nodes = await page.env.maps[0].renderContents();
	eq(nodes, page.root, 'renderContents 必须返回同一个 map 根节点');
	ok(!!box(), 'renderContents 之后概览框必须已被重新插回（不能等到下一次 poll）');
	eq(page.root.firstChild, box(), '重新插回后仍应是第一个子节点');
	eq(countMatches(page.root, '[data-mlo-summary-box="1"]'), 1, '重新插回不得留下重复的概览框');

	// 轮询注册
	eq(page.env.polls.length, 1, '应当注册一个 poll');
	eq(page.env.polls[0].interval, 5, 'poll 间隔必须是 5 秒');

	// poll 回调：RPC 数据变了，指标必须跟着变
	eq(metricValue(box(), 'Configured radios'), '2', '指标初值应当是 2 个 radio');
	eq(metricValue(box(), 'Wireless interfaces'), '1', '指标初值应当是 1 个接口');
	eq(metricValue(box(), 'MLO-enabled'), '1', '指标初值应当是 1 个 MLO 接口');
	eq(metricValue(box(), 'Active MLD ifnames'), 'wlan0-mld0, wlan1-mld0', '活动的 MLD ifname');

	page.env.status = FIXTURE_THREE_RADIOS.status;
	await page.env.polls[0].fn();

	eq(metricValue(box(), 'Configured radios'), '3', 'poll 之后指标必须跟着 RPC 数据更新');
	eq(countMatches(page.root, '[data-mlo-summary-box="1"]'), 1, '反复刷新不得堆出多个概览框');
	ok(!!box(), 'poll 之后概览框仍然存在');

	// 运行时单元也要跟着刷新（站点数来自 iwinfo assoclist）
	const runtimeCell = page.root.querySelector('[data-mlo-runtime-section="wifi0"]');
	ok(runtimeCell != null, '运行时单元必须还在');
	ok(/Present|Active/.test(textOf(runtimeCell)), '运行时单元应当显示状态徽标', textOf(runtimeCell));
	ok(page.env.assocCalls.length > 0, '应当调用过 iwinfo assoclist 去数站点');
}

// ---------- T4. 原型链上的 section 名（BUG 5）----------

console.log('--- T4. 原型链上的 section 名 ---');
{
	let page = null, err = null;
	try { page = await buildPage(FIXTURE_PROTO); }
	catch (e) { err = e; }

	ok(err == null, 'section 名撞上 Object.prototype 成员时不得抛异常',
		err ? (err.constructor.name + ': ' + err.message) : '');

	if (page) {
		const overview = optOf(page.section, '_overview');
		const runtime = optOf(page.section, '_runtime');

		const t1 = textOf(overview.textvalue('valueOf'));
		ok(t1.indexOf('undefined') < 0, '概览单元里不得出现 undefined', t1);
		ok(t1.indexOf('constructor') >= 0,
			'uniqueValues 不得把 constructor 当成"已见过"而丢掉（那会退化成 none）', t1);

		const t2 = textOf(overview.textvalue('hasOwnProperty'));
		ok(t2.indexOf('undefined') < 0, '名为 hasOwnProperty 的 section 不得渲染出 undefined', t2);
		const hits = t2.split('toString |').length - 1;
		eq(hits, 1, 'device 里重复的 toString 必须被去重成一项', t2);

		const t3b = textOf(overview.textvalue('isPrototypeOf'));
		ok(t3b.indexOf('undefined') < 0,
			'引用不存在的 radio 时不得渲染出 undefined', t3b);
		ok(t3b.indexOf('toLocaleString') >= 0,
			'查不到的 radio 必须原样显示名字（而不是解析成 Object.prototype 上的成员）', t3b);

		const t3 = textOf(runtime.textvalue('valueOf'));
		ok(t3.indexOf('undefined') < 0, '运行时单元里不得出现 undefined', t3);
		ok(t3.indexOf('wlan0-mld0') >= 0, '运行时单元必须能查到名为 valueOf 的 section 的状态', t3);

		eq(metricValue(page.root.querySelector('[data-mlo-summary-box="1"]'), 'Configured radios'), '2',
			'名为 constructor / toString 的 radio 必须被算进去');
	}
}

// ---------- T5. macaddr 的数据类型（BUG 4）----------

console.log('--- T5. macaddr 的数据类型 ---');
{
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const mac = optOf(page.section, 'macaddr');
	const bssid = optOf(page.section, 'bssid');

	eq(mac.datatype, "or('random',macaddr)",
		'macaddr 必须接受 random（上游 wireless.js:1263 用的就是这一串）');
	eq(bssid.datatype, 'macaddr', 'bssid 只接受真正的 MAC');

	// 用真的 validation.js 跑一遍（需要本机有 luci-base 源码；没有就 SKIP）
	const baseDir = findLuciBaseDir();
	if (!baseDir) {
		skip('macaddr 数据类型的真实校验', '未找到 luci-base 源码，设置 LUCI_BASE_DIR 可启用');
	}
	else {
		const factory = loadValidatorFactory(baseDir);
		const accepts = function(dt, v) { return datatypeAccepts(factory, dt, v); };

		ok(accepts(mac.datatype, 'random') === true,
			"'random' 必须通过 macaddr 的数据类型校验（否则这种接口根本存不下去）");
		ok(accepts(mac.datatype, 'AA:BB:CC:DD:EE:FF') === true, '真正的 MAC 必须通过');
		ok(accepts(mac.datatype, 'not-a-mac') === false, '乱填的值必须被拒绝');
		ok(accepts(mac.datatype, 'ZZ:BB:CC:DD:EE:FF') === false, '非十六进制字符必须被拒绝');
		ok(accepts('macaddr', 'random') === false, '对照：裸 macaddr 会拒绝 random（这正是修复前的行为）');
	}
}

// ---------- T6. device 的 validate ----------

console.log('--- T6. device 的 validate ---');
{
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const dev = optOf(page.section, 'device');
	const mlo = optOf(page.section, 'mlo');

	page.section.openModal('wifi0');          // 弹窗里的控件才存在

	eq(dev.validate.call(dev, 'wifi0', [ 'radio0' ]),
		'MLO requires at least two radio devices', '开了 MLO 却只选一个 radio 必须报错');
	eq(dev.validate.call(dev, 'wifi0', [ 'radio0', 'radio1' ]), true, '两个 radio 合法');
	eq(dev.validate.call(dev, 'wifi0', []), 'Select at least one radio device', '一个都不选必须报错');
	eq(dev.validate.call(dev, 'wifi0', [ 'radio0', 'radio0' ]),
		'MLO requires at least two radio devices', '重复的同一个 radio 只能算一个');

	mlo._input.wifi0 = '0';                   // 关掉 MLO
	eq(dev.validate.call(dev, 'wifi0', [ 'radio0' ]), true, '没开 MLO 时单 radio 合法');
}

// ---------- T7. key 的 validate ----------

console.log('--- T7. key 的 validate ---');
{
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const key = optOf(page.section, 'key');
	const enc = optOf(page.section, 'encryption');

	// encryption 上不能挂 default：ListValue 的 formvalue() 在"控件值等于 default"
	// 时返回 null（form.js:4994-4999），而 parse() 拿到 null、且 rmempty 与 optional
	// 都不为真时会**拒绝**（form.js:2141-2176）—— 于是选着默认加密方式的接口
	// 根本存不下去。控件落在 WPA3-SAE 上靠的是"sae 是第一个候选值"
	// （ui.js:832-840 + HTML 规范：无人带 selected 时选第一个 option）。
	eq(enc.default, undefined, 'ListValue 上不得挂 default');
	eq(enc.keylist[0], 'sae', 'WPA3-SAE 必须是第一个候选值（控件在空配置上就落在它上面）');

	page.section.openModal('wifi0');
	eq(enc._input.wifi0, 'sae', '有 encryption=sae 的接口，控件必须落在 sae 上');
	eq(key.validate.call(key, 'wifi0', ''), 'Passphrase is required for the selected encryption',
		'sae 必须填密码');

	enc._input.wifi0 = 'none';
	eq(key.validate.call(key, 'wifi0', ''), true, '不加密时不需要密码');

	enc._input.wifi0 = 'psk2';
	eq(key.validate.call(key, 'wifi0', ''), 'Passphrase is required for the selected encryption',
		'psk2 也必须填密码');
	eq(key.validate.call(key, 'wifi0', 'secret123'), true, '填了密码就合法');
}

// ---------- T8. 概览框的告警文案 ----------

console.log('--- T8. 概览框的告警文案 ---');
{
	const boxText = async function(fixture) {
		const page = await buildPage(fixture);
		return textOf(page.root.querySelector('[data-mlo-summary-box="1"]'));
	};

	const t1 = await boxText(FIXTURE_ONE_RADIO);
	ok(t1.indexOf('Only one radio is configured') >= 0, '只有一个 radio 时必须提示', t1);

	const t2 = await boxText(FIXTURE_NO_IFACE);
	ok(t2.indexOf('No wireless interfaces are configured yet.') >= 0, '没有接口时必须提示', t2);
	ok(t2.indexOf('No MLO-enabled wireless interface') < 0, '没有接口时不应同时提示"没有 MLO 接口"', t2);

	const t3 = await boxText(FIXTURE_TWO_RADIOS);
	ok(t3.indexOf('Runtime detection looks healthy') >= 0, '一切正常时应当显示健康文案', t3);
	ok(t3.indexOf('Only one radio') < 0, '正常情况不应有告警', t3);

	// 开了 MLO 但只选了一个 radio
	const bad = JSON.parse(JSON.stringify(FIXTURE_TWO_RADIOS));
	bad.uci.wireless.wifi0.device = [ 'radio0' ];
	const t4 = await boxText(bad);
	ok(/1 MLO interface\(s\) still have fewer than two radios selected\./.test(t4),
		'MLO 接口的 radio 少于两个时必须计数提示', t4);

	// 自定义 ifname 覆盖了自动命名
	const custom = JSON.parse(JSON.stringify(FIXTURE_TWO_RADIOS));
	custom.uci.wireless.wifi0.ifname = 'my-mlo';
	const t5 = await boxText(custom);
	ok(/1 MLO interface\(s\) override the auto-generated MLD ifname\./.test(t5),
		'自定义 ifname 必须提示', t5);

	// 配了 MLO 但运行时没上报 MLD
	const idle = JSON.parse(JSON.stringify(FIXTURE_TWO_RADIOS));
	idle.status = mkStatus([ 'radio0', 'radio1' ], []);
	const t6 = await boxText(idle);
	ok(t6.indexOf('MLO is configured, but no active runtime MLD interface') >= 0,
		'配了 MLO 但运行时没有 MLD 时必须提示', t6);
}

// ---------- T9. 802.11w 的默认值不得落盘（BUG 6）----------

console.log('--- T9. 802.11w 的默认值不得写进配置 ---');
{
	const iface = function(extra) {
		return Object.assign({
			'.type': 'wifi-iface', mode: 'ap', device: [ 'radio0' ], network: [ 'lan' ], ssid: 'x'
		}, extra);
	};
	const fx = function(ifaceCfg) {
		return {
			uci: {
				wireless: {
					radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
					radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
					wifi0: iface(ifaceCfg)
				},
				network: { lan: { '.type': 'interface' } }
			},
			status: mkStatus([ 'radio0', 'radio1' ], [])
		};
	};
	const page = await buildPage(fx({ encryption: 'psk2' }));
	const pmf = optOf(page.section, 'ieee80211w');

	// psk2：默认必须是 Disabled（上游 wireless.js 的 defaults 兜底条目）
	page.section.openModal('wifi0');
	eq(pmf.default, '0', 'psk2 接口的 802.11w 默认值必须是 Disabled');
	eq(pmf._input.wifi0, '0', 'psk2 接口的控件必须落在 Disabled 上');
	// 控件停在默认值上时 formvalue() 返回 null（form.js:4994-4999），这是上游
	// "等于默认值就算没设置"的语义，o.write 正是靠它把默认值挡在配置之外。
	eq(pmf.formvalue('wifi0'), null, '停在默认值上的 802.11w 必须报 null（否则会被写进配置）');
	await pmf.parse('wifi0');
	ok(page.env.uci.get('wireless', 'wifi0', 'ieee80211w') == null,
		'psk2 接口保存后不得凭空多出 ieee80211w —— 那会把不支持 PMF 的客户端挡在门外');

	// sae：默认 Required，但同样不落盘（协议本身强制 PMF，无需写进配置）
	const page2 = await buildPage(fx({ encryption: 'sae' }));
	const pmf2 = optOf(page2.section, 'ieee80211w');
	page2.section.openModal('wifi0');
	eq(pmf2.default, '2', 'sae 接口的 802.11w 默认值必须是 Required');
	await pmf2.parse('wifi0');
	ok(page2.env.uci.get('wireless', 'wifi0', 'ieee80211w') == null,
		'sae 接口保存后也不得把默认值写进配置');

	// sae-mixed：默认 Optional
	const page3 = await buildPage(fx({ encryption: 'sae-mixed' }));
	const pmf3 = optOf(page3.section, 'ieee80211w');
	page3.section.openModal('wifi0');
	eq(pmf3.default, '1', 'sae-mixed 接口的 802.11w 默认值必须是 Optional');

	// 已有的显式取值必须原样保留
	const page4 = await buildPage(fx({ encryption: 'sae', ieee80211w: '1' }));
	const pmf4 = optOf(page4.section, 'ieee80211w');
	page4.section.openModal('wifi0');
	eq(pmf4.formvalue('wifi0'), '1', '已有的 ieee80211w 必须显示原值');
	await pmf4.parse('wifi0');
	eq(page4.env.uci.get('wireless', 'wifi0', 'ieee80211w'), '1',
		'已有的 ieee80211w 必须原样保留');

	// 用户显式改成一个非默认值时必须写下去
	const page5 = await buildPage(fx({ encryption: 'sae' }));
	const pmf5 = optOf(page5.section, 'ieee80211w');
	page5.section.openModal('wifi0');
	pmf5._input.wifi0 = '0';
	await pmf5.parse('wifi0');
	eq(page5.env.uci.get('wireless', 'wifi0', 'ieee80211w'), '0',
		'用户显式选择 Disabled 时必须写进配置');

	// BUG 6a mutation: 直接测试 write() 方法，确保传入默认值时调用 remove() 而非 write()
	// 如果有人把 wifimanager.js 里的自定义 write 函数删掉，这个测试会失败（会写进配置）
	{
		const page6 = await buildPage(fx({ encryption: 'psk2' }));
		const pmf6 = optOf(page6.section, 'ieee80211w');
		page6.section.openModal('wifi0');

		// psk2 下默认值是 '0'，传入 '0' 应该触发 remove()，不写入配置
		await pmf6.write('wifi0', '0');

		ok(page6.env.uci.get('wireless', 'wifi0', 'ieee80211w') == null,
			'传入默认值后配置里不得出现 ieee80211w（自定义 write 必须调用 remove）');
	}
}

// ---------- T10. 概览单元上的告警 ----------

console.log('--- T10. 概览单元上的告警 ---');
{
	const page = await buildPage(FIXTURE_TWO_RADIOS);
	const overview = optOf(page.section, '_overview');

	const t1 = textOf(overview.textvalue('wifi0'));
	ok(t1.indexOf('AP MLO is usually paired with WPA3-SAE or OWE') < 0,
		'sae 加密的 AP MLO 不应有告警', t1);

	const bad = JSON.parse(JSON.stringify(FIXTURE_TWO_RADIOS));
	bad.uci.wireless.wifi0.encryption = 'psk2';
	bad.uci.wireless.wifi0.device = [ 'radio0' ];
	bad.uci.wireless.wifi0.ifname = 'custom0';
	const page2 = await buildPage(bad);
	const t2 = textOf(optOf(page2.section, '_overview').textvalue('wifi0'));

	ok(t2.indexOf('Needs at least two radios') >= 0, 'radio 不足时必须提示', t2);
	ok(t2.indexOf('AP MLO is usually paired with WPA3-SAE or OWE') >= 0, '非 SAE/OWE 时必须提示', t2);
	ok(t2.indexOf('Custom ifname overrides the default ap-mldX / sta-mldX naming') >= 0,
		'自定义 ifname 不含 mld 时必须提示', t2);
}

// ---------- T11. 没有 radio 时的告警文案 ----------

console.log('--- T11. 没有 radio 时的告警文案 ---');
{
	const box = function(page) { return page.root.querySelector('[data-mlo-summary-box="1"]'); };

	// 零个 radio：说"只有一个 radio 已配置"是假的
	const page = await buildPage(FIXTURE_NO_RADIO);
	const text = textOf(box(page));

	eq(metricValue(box(page), 'Configured radios'), '0', '没有 wifi-device 时指标必须是 0');
	ok(text.indexOf('No radio is configured') >= 0,
		'一个 radio 都没有时必须说"没有 radio"', text);
	ok(text.indexOf('Only one radio is configured') < 0,
		'零个 radio 时不得谎称"只有一个 radio 已配置"', text);

	// 对照：真的只有一个 radio 时，仍用原来那句
	const one = await buildPage(FIXTURE_ONE_RADIO);
	const oneText = textOf(box(one));

	ok(oneText.indexOf('Only one radio is configured') >= 0,
		'恰好一个 radio 时仍应提示"只有一个 radio"', oneText);
	ok(oneText.indexOf('No radio is configured') < 0,
		'存在一个 radio 时不得说"没有 radio"', oneText);
}

// ---------- T12. ssid / wds 不得挂在恒真条件上 ----------

console.log('--- T12. ssid / wds 不得挂在恒真条件上 ---');
{
	// 本页的 mode 只提供 ap / sta（wifimanager.js 的 mode 选项），所以
	// depends('mode','ap') + depends('mode','sta') 是**恒真**的：它永远为真，
	// 却仍要走 isActive() 这条 DOM 判定，而 form.js:2171-2172 规定
	// "选项不可见 → parse() 就 remove() 掉它"。恒真不带来任何好处，
	// 只留下"保存一次就把 ssid / wds 删掉"的路径。
	//
	// 而 mode 落在 {ap, sta} 之外是**真实存在**的配置：stock Wireless 页
	// 就提供 adhoc（wireless.js:1083）。ssid 在 ap 与 sta 下都是必需的
	// （sta 下它是要连的 SSID），wds 在两种模式下都合法，所以它们对这两种
	// 模式都必须可见 —— 不该有任何 depends。
	const fx = {
		uci: {
			wireless: {
				radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
				radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
				wifi0: { '.type': 'wifi-iface', mode: 'adhoc', device: [ 'radio0' ],
					network: [ 'lan' ], ssid: 'adhoc-net', wds: '1' }
			},
			network: { lan: { '.type': 'interface' } }
		},
		status: mkStatus([ 'radio0', 'radio1' ], [])
	};

	const page = await buildPage(fx);
	const ssid = optOf(page.section, 'ssid');
	const wds = optOf(page.section, 'wds');

	eq(ssid.deps.length, 0, 'ssid 对 ap / sta 都必须可见，不得挂在恒真条件上');
	eq(wds.deps.length, 0, 'wds 对 ap / sta 都合法，不得挂在恒真条件上');

	page.section.openModal('wifi0');
	eq(ssid.isActive('wifi0'), true, 'mode=adhoc 的接口上 ssid 也必须可见');
	eq(wds.isActive('wifi0'), true, 'mode=adhoc 的接口上 wds 也必须可见');

	await ssid.parse('wifi0');
	await wds.parse('wifi0');
	eq(page.env.uci.get('wireless', 'wifi0', 'ssid'), 'adhoc-net',
		'mode 不在 {ap,sta} 里的接口，保存时不得被删掉 ssid');
	eq(page.env.uci.get('wireless', 'wifi0', 'wds'), '1',
		'mode 不在 {ap,sta} 里的接口，保存时不得被删掉 wds');

	// 仍然带 depends 的选项必须保持原样：它们是真的有条件，不是恒真
	eq(optOf(page.section, 'hidden').deps.length, 1, 'hide-SSID 只对 AP 有意义，必须保留 depends');
	eq(optOf(page.section, 'bssid').deps.length, 1, 'BSSID 只对客户端有意义，必须保留 depends');
}

// ---------- T13. 弹窗保存：停在默认取值上必须能存下去 ----------

console.log('--- T13. 弹窗保存不得因"等于默认值"而失败 ---');
{
	// ListValue 上挂 default 会让 formvalue() 在"控件值 == default"时返回 null
	//（form.js:4994-4999），而 parse() 拿到 null、且 rmempty 与 optional 都不为真
	// 时会**拒绝**（form.js:2141-2176）。弹窗保存走的是 AbstractSection.parse
	//（form.js:976-987，逐个 parse 所有子选项），于是"用户什么都没改，直接按保存"
	// 会整个失败；更糟的是 handleModalSave 用的是 save(null, true) 静默保存并把
	// 拒绝吞掉（form.js:3626 + 3640 `.catch(() => {})`），界面上既不报错也不保存。
	const page = await buildPage(FIXTURE_TWO_RADIOS);   // mode=ap, encryption=sae
	page.section.openModal('wifi0');

	await page.section.parseModal('wifi0');             // 不抛异常即通过

	eq(page.env.uci.get('wireless', 'wifi0', 'mode'), 'ap', 'mode 必须原样留在配置里');
	eq(page.env.uci.get('wireless', 'wifi0', 'encryption'), 'sae', 'encryption 必须原样留在配置里');
}

// ---------- T14. 配置里已有的取值不在候选表里，保存不得被改写 ----------

console.log('--- T14. 配置里已有的取值不在候选表里，保存不得被改写 ---');
{
	// ui.js:832-840 只给**候选键**加 selected，一个都没匹配上时没有任何 option
	// 带 selected，而按 HTML 规范，非 multiple 的 select 在无人带 selected 时
	// 把**第一个** option 当作选中项。于是一个本页不认识的取值会显示成第一个候选、
	// 保存时又被原样写回 —— 静默改掉配置。
	// 把配置里已有的取值补进候选表（在 load() 里），控件就显示真值、保存时原样写回。
	// stock 的 maclist 选项就是这么做的（在 load() 里补候选值）。

	// 1) mode=adhoc：stock Wireless 页就提供 adhoc（wireless.js:1083），本页现在
	//    也把它加进静态候选表（wifimanager.js 的 keepConfiguredValue 会在 load 里补上）。
	const fxAdhoc = {
		uci: {
			wireless: {
				radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
				radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
				wifi0: { '.type': 'wifi-iface', mode: 'adhoc', device: [ 'radio0', 'radio1' ],
					network: [ 'lan' ], ssid: 'adhoc-net', mlo: '1' }
			},
			network: { lan: { '.type': 'interface' } }
		},
		status: mkStatus([ 'radio0', 'radio1' ], [])
	};
	const pageAdhoc = await buildPage(fxAdhoc);
	pageAdhoc.section.openModal('wifi0');
	await pageAdhoc.section.parseModal('wifi0');
	eq(pageAdhoc.env.uci.get('wireless', 'wifi0', 'mode'), 'adhoc',
		'配置里是 adhoc，保存后必须仍是 adhoc（不能被改成 ap）');

	// 2) mode=mesh (802.11s)：同样是 stock 无线页的合法模式（wireless.js:1167-1170）
	const fxMesh = {
		uci: {
			wireless: {
				radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
				radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
				wifi0: { '.type': 'wifi-iface', mode: 'mesh', device: [ 'radio0', 'radio1' ],
					network: [ 'lan' ], ssid: 'mesh-net', mlo: '1' }
			},
			network: { lan: { '.type': 'interface' } }
		},
		status: mkStatus([ 'radio0', 'radio1' ], [])
	};
	const pageMesh = await buildPage(fxMesh);
	pageMesh.section.openModal('wifi0');
	await pageMesh.section.parseModal('wifi0');
	eq(pageMesh.env.uci.get('wireless', 'wifi0', 'mode'), 'mesh',
		'配置里是 mesh，保存后必须仍是 mesh');

	// 3) encryption=wpa2：stock 无线页会写 'wpa2'（或 psk2+ccmp 等组合），本页
	//    的静态候选表里没有，但 keepConfiguredValue 会在 load() 里把它补上。
	const fxWpa2 = {
		uci: {
			wireless: {
				radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
				radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
				wifi0: { '.type': 'wifi-iface', mode: 'ap', device: [ 'radio0', 'radio1' ],
					network: [ 'lan' ], ssid: 'wpa2-net', mlo: '1', encryption: 'wpa2' }
			},
			network: { lan: { '.type': 'interface' } }
		},
		status: mkStatus([ 'radio0', 'radio1' ], [])
	};
	const pageWpa2 = await buildPage(fxWpa2);
	pageWpa2.section.openModal('wifi0');
	await pageWpa2.section.parseModal('wifi0');
	eq(pageWpa2.env.uci.get('wireless', 'wifi0', 'encryption'), 'wpa2',
		'配置里是 wpa2，保存后必须仍是 wpa2（不能被改成 sae）');
}

// ---------- T15. hide-SSID 必须在 AP 接口上保存下去 ----------

console.log('--- T15. hide-SSID 必须在 AP 接口上保存下去 ---');
{
	// hidden 选项带有 depends('mode','ap')（form.js:781-815 isDependencySatisfied
	// 比的是依赖选项的 formvalue()）。若 mode 的 ListValue 挂 default，
	// formvalue 返回 null → depends 不满足 → hidden 不可见 → parse() remove() 掉它
	//（form.js:2171-2172）。结果：隐藏 SSID 的 AP 接口保存一次就变成不隐藏。
	// 修复 mode（去掉 default/rmempty）后，formvalue 返回 'ap'，depends 满足，
	// hidden 可见，parse() 写入它。
	const fx = {
		uci: {
			wireless: {
				radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
				radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
				wifi0: { '.type': 'wifi-iface', mode: 'ap', device: [ 'radio0', 'radio1' ],
					network: [ 'lan' ], ssid: 'hidden-ap', mlo: '1', hidden: '1' }
			},
			network: { lan: { '.type': 'interface' } }
		},
		status: mkStatus([ 'radio0', 'radio1' ], [])
	};
	const page = await buildPage(fx);
	page.section.openModal('wifi0');

	const hidden = optOf(page.section, 'hidden');
	eq(hidden.isActive('wifi0'), true, 'AP 接口上 hidden 必须可见');

	await page.section.parseModal('wifi0');
	eq(page.env.uci.get('wireless', 'wifi0', 'hidden'), '1',
		'AP 接口保存后 hidden 必须仍是 1（不能被删掉）');
}

// ---------- T16. 模式下拉菜单必须提供全部四种模式 ----------

console.log('--- T16. 模式下拉菜单必须提供全部四种模式 ---');
{
	// README.md:26,40 承诺本页提供 ap / sta / adhoc / mesh 四种模式。
	// 下拉菜单里出现哪几项，完全由 ListValue 的候选表决定，链路上没有第二处可以
	// 增减：
	//   transformChoices  form.js:1772 —— 把 keylist/vallist 拼成 choices；
	//   renderWidget      form.js:4706 —— 把 keylist 当 sort 传给 ui.Select；
	//   UISelect.render   ui.js:746-762 —— 对 choices 的每个键输出一个 <option>。
	// 所以候选表少一项，下拉菜单就少一项，且不报错、不留痕 —— 这正是 0.1.2 的症状
	// （源码里只注册了 ap / sta，界面上就只剩"接入点 (AP)"和"客户端"）。
	// T14 抓不到它：keepConfiguredValue 会把**配置里已有的**取值补进候选表，所以
	// adhoc / mesh 即便从静态表里被删掉，只要配置里正好是这个值，T14 仍然全绿。
	// 这里断言的是静态候选表本身，也就是"新建接口时下拉菜单里能选什么"。
	const page = await buildPage(FIXTURE_LEGACY);
	const mode = optOf(page.section, 'mode');

	const MODES = [ 'ap', 'sta', 'adhoc', 'mesh' ];
	const LABELS = [ 'Access Point', 'Client', 'Ad-Hoc', 'Mesh' ];

	eq(mode.keylist.length, 4, '下拉菜单必须有 4 项（不是 2 项）');
	MODES.forEach(function(v, i) {
		eq(mode.keylist[i], v, '下拉菜单第 ' + (i + 1) + ' 项必须是 ' + v);
	});

	// 键与标签一一对应：ui.js:746 遍历的是 choices（由 keylist 与 vallist 同下标配对）
	eq(mode.vallist.length, mode.keylist.length, 'keylist 与 vallist 必须等长');
	LABELS.forEach(function(v, i) {
		eq(mode.vallist[i], v, v + ' 的标签必须挂在 ' + MODES[i] + ' 上');
	});

	// 无重复：重复项会让 ui.Select 输出两个同值 option
	const seen = {};
	mode.keylist.forEach(function(v) {
		ok(!seen[v], '候选值 ' + v + ' 不得重复');
		seen[v] = true;
	});

	// 弹窗里的控件是 cloneOptions()（form.js:3765）逐项拷贝出来的，keylist 原样带过去，
	// 所以静态表有几项，用户点开某一行时看到的就是几项。
	page.section.openModal('wifi0');
	eq(mode.keylist.length, 4, '打开弹窗（load 会把配置里的 mode 补进候选表）后候选表不得变长');
	MODES.forEach(function(v, i) {
		eq(mode.keylist[i], v, '弹窗里第 ' + (i + 1) + ' 项必须仍是 ' + v);
	});

	// 顺带钉住 keepConfiguredValue 的补值行为本身：配置里的取值不在静态表里时，
	// 必须被补进去，否则控件会落到第一个候选上并把它写回（T14 测的是这条）。
	const fxMonitor = {
		uci: {
			wireless: {
				radio0: { '.type': 'wifi-device', band: '2g', channel: '6' },
				radio1: { '.type': 'wifi-device', band: '5g', channel: '36' },
				wifi0: { '.type': 'wifi-iface', mode: 'monitor', device: [ 'radio0', 'radio1' ],
					network: [ 'lan' ], ssid: 'mon', mlo: '1' }
			},
			network: { lan: { '.type': 'interface' } }
		},
		status: mkStatus([ 'radio0', 'radio1' ], [])
	};
	const pageMonitor = await buildPage(fxMonitor);
	pageMonitor.section.openModal('wifi0');
	const modeMonitor = optOf(pageMonitor.section, 'mode');
	eq(modeMonitor.keylist.length, 5, '配置里已有的取值必须被补进候选表');
	MODES.forEach(function(v, i) {
		eq(modeMonitor.keylist[i], v, '补值必须补在末尾，静态表第 ' + (i + 1) + ' 项仍是 ' + v);
	});
	eq(modeMonitor.keylist[4], 'monitor', 'monitor 必须被补在候选表末尾');
	await pageMonitor.section.parseModal('wifi0');
	eq(pageMonitor.env.uci.get('wireless', 'wifi0', 'mode'), 'monitor',
		'配置里是 monitor，保存后必须仍是 monitor（不能被改成 ap）');
}

// ---------- 汇总 ----------

console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + (checks - fails) + '/' + checks +
	(skips ? '（另有 ' + skips + ' 项 SKIP）' : ''));
process.exit(fails ? 1 : 0);

}

// ============================================================================
// 8. 可选：用真的 validation.js 校验数据类型
//
// 这一段需要本机有 luci-base 的源码。找不到就 SKIP（不判失败），因为本仓库
// 本身不携带框架源码，把测试写死成"必须找到某个绝对路径"会让它在别的机器上
// 直接红掉。找到时跑的是**框架自己的** compile/apply，不是我们复刻的版本。
// ============================================================================

function findLuciBaseDir() {
	const rel = 'feeds/luci/modules/luci-base/htdocs/luci-static/resources';
	const cands = [];

	if (process.env.LUCI_BASE_DIR)
		cands.push(process.env.LUCI_BASE_DIR);

	cands.push('/home/arthur/owrt');
	cands.push(path.join(process.env.HOME || '/root', 'owrt'));

	for (const base of cands) {
		if (base.endsWith(rel) && fs.existsSync(path.join(base, 'validation.js')))
			return base;

		let subs = [];
		try { subs = fs.readdirSync(base); } catch (e) { continue; }

		for (const sub of subs) {
			const dir = path.join(base, sub, rel);
			if (fs.existsSync(path.join(dir, 'validation.js')))
				return dir;
		}
	}

	return null;
}

function loadValidatorFactory(dir) {
	const src = fs.readFileSync(path.join(dir, 'validation.js'), 'utf8');

	// validation.js 只 require baseclass，这里给一个最小替身：
	// 构造时调 __init__，extend 生成子类。文件里没有用到 this.super。
	function baseclass() {}
	baseclass.extend = function(proto) {
		function Cls(...args) { if (typeof this.__init__ === 'function') this.__init__(...args); }
		Cls.prototype = Object.create(baseclass.prototype);
		Object.assign(Cls.prototype, proto);
		Cls.extend = baseclass.extend;
		return Cls;
	};

	const Lstub = {
		raise(type, msg, ...args) {
			throw new Error(type + ': ' + String(msg).format(...args));
		}
	};

	// findParent 只在 Validator.validate() 里用到，本测试不调用 validate()。
	const findParent = function() { return null; };

	// 模块返回的是 ValidatorFactory 这个**类**（validation.js 末行 `return ValidatorFactory`），
	// 而 compile() 定义在原型上，所以要 new 一个实例出来。
	const Factory = new Function('baseclass', 'L', '_', 'findParent', src)(baseclass, Lstub, _, findParent);

	return new Factory();
}

// 用框架自己的 compile()/apply() 判断一个数据类型是否接受某个值。
// 上下文对象以 factory 为原型，于是 types 里的 this.assert / this.value 都能用。
function datatypeAccepts(factory, datatype, value) {
	const stack = factory.compile(datatype);

	const ctx = Object.create(factory);
	ctx.factory = factory;
	ctx.value = value;
	ctx.error = null;
	ctx.optional = false;
	ctx.field = { classList: { add() {}, remove() {} } };
	ctx.assert = function(condition, message) {
		if (!condition) { this.error = message; return false; }
		this.error = null;
		return true;
	};

	return stack[0].apply(ctx, stack[1]) === true;
}

main().catch(function(e) {
	console.log('FAIL  测试自身抛异常: ' + (e && e.stack || e));
	process.exit(1);
});
