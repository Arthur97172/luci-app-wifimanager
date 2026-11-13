'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.mesh as mesh';
'require wifimanager.utils.topology as topology';
'require wifimanager.utils.format as format';
'require dom';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const adminLink = widgets.adminLink;
const kv = widgets.kv;

const SVG_NS = 'http://www.w3.org/2000/svg';

function mediumName(medium) {
	return medium === 'wired' ? _('Ethernet') :
		(medium === 'wlan' ? _('Wireless') : _('Medium unknown'));
}

function svgEl(tag, attrs, children) {
	const el = document.createElementNS(SVG_NS, tag);

	for (const name of Object.keys(attrs || {}))
		el.setAttribute(name, attrs[name]);

	for (const child of (children || [])) {
		if (child)
			el.appendChild(child);
	}

	return el;
}

function svgText(x, y, text, className, anchor) {
	const el = svgEl('text', {
		x: x,
		y: y,
		'text-anchor': anchor || 'middle',
		'class': className || ''
	});

	el.textContent = text;

	return el;
}

function truncate(text, max) {
	text = String(text == null ? '' : text);

	return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function groupDevices(rows) {
	const order = [];
	const groups = {};

	for (const row of rows) {
		const key = mesh.deviceKey(row) || ('row:' + order.length);
		let group = groups[key];

		if (!group) {
			group = {
				key: key,
				name: row.hostname || row.neighbor || _('Unknown device'),
				named: !!row.hostname,
				ips: (row.ips || []).slice(),
				rows: []
			};
			groups[key] = group;
			order.push(group);
		}

		if (!group.named && row.hostname) {
			group.name = row.hostname;
			group.named = true;
		}

		for (const ip of (row.ips || [])) {
			if (group.ips.indexOf(ip) === -1)
				group.ips.push(ip);
		}

		group.rows.push(row);
	}

	for (const group of order) {
		group.rows.sort(function(a, b) {
			const rank = function(row) {
				return row.backhaul === 'wired' ? 0 : row.backhaul === 'wlan' ? 1 : 2;
			};

			return rank(a) - rank(b);
		});
	}

	return order;
}

function mediaOf(group) {
	const seen = {};

	for (const row of group.rows) {
		if (row.backhaul === 'wired' || row.backhaul === 'wlan')
			seen[row.backhaul] = true;
	}

	return Object.keys(seen);
}

function primaryRow(group) {
	return group.rows.find(function(row) {
		return row.backhaulState === 'inuse';
	}) || group.rows[0] || null;
}

// Values a device announces for itself repeat on every row of that device, so
// the first row that has one is authoritative.  A wired row may lack a
// channel the wireless row carries, which is why this scans instead of
// reading only the primary row.
function nodeValue(group, key) {
	for (const row of group.rows) {
		if (row[key] != null && row[key] !== '')
			return row[key];
	}

	return '';
}

function roleName(role) {
	switch (role) {
	case 'server': return _('Server (root node)');
	case 'node': return _('Node (mesh point)');
	case 'client': return _('Client (wireless client)');
	case 'off': return _('Mesh disabled');
	case '': return '-';
	default: return role;
	}
}

function channelName(row) {
	const channel = row ? row.channel : '';

	if (!channel)
		return '-';

	return row.band ? '%s (%s)'.format(String(channel), bandName(row.band)) : String(channel);
}

function groupChannel(group) {
	for (const row of group.rows) {
		if (row.channel)
			return channelName(row);
	}

	return '-';
}

function groupLoad(group) {
	const load = nodeValue(group, 'load');

	return load === '' ? '-' : String(load);
}

function groupState(group) {
	return group.rows.some(function(row) { return row.backhaulState === 'inuse'; })
		? 'inuse' : (group.rows.some(function(row) { return row.backhaulState === 'standby'; })
			? 'standby' : '');
}

function bestSignal(group) {
	let best = null;

	for (const row of group.rows) {
		const signal = Number(row.signal);

		if (row.signal === '' || row.signal == null || !Number.isFinite(signal))
			continue;
		if (best == null || signal > best)
			best = signal;
	}

	return best == null ? '-' : best + ' dBm';
}

function groupNodeState(group) {
	let signal = null;
	let seen = null;

	for (const row of group.rows) {
		const rowSignal = topology.parseSignal(row.signal);
		const age = topology.parseSeconds(row.lastSeen);

		if (rowSignal != null && (signal == null || rowSignal > signal))
			signal = rowSignal;
		if (age != null && (seen == null || age < seen))
			seen = age;
	}

	return topology.classifyState(seen, mediaOf(group), signal);
}

function nodeStateBadge(state) {
	if (state === 'offline')
		return badge(_('Offline'), 'error');
	if (state === 'weak')
		return badge(_('Weak signal'), 'warn');

	return badge(_('Normal'), 'ok');
}

/*
 * Edges of the mesh graph.  The direct neighbor rows connect this device to
 * its neighbours; the batman-adv originator table adds the paths beyond them,
 * because each selected originator names both the distant device and the next
 * hop used to reach it.  Mapping both MACs back to the device that announced
 * them turns that table into device-to-device edges, so a chain is drawn as a
 * chain instead of every remote device being attached to the centre.
 */
function topologyEdges(rows, originators) {
	const macToKey = {};
	const directKeys = {};
	const edges = [];
	const seen = {};

	for (const row of rows || []) {
		const mac = mesh.macKey(row.neighbor);
		const key = mesh.deviceKey(row);

		if (mac && key)
			macToKey[mac] = key;
		if (!row.announced && key)
			directKeys[key] = true;
	}

	function addEdge(a, b, medium) {
		if (!a || !b || a === b)
			return;

		const pair = a < b ? a + '\n' + b : b + '\n' + a;

		if (seen[pair]) {
			if (medium && !seen[pair].medium)
				seen[pair].medium = medium;
			return;
		}

		seen[pair] = { a: a, b: b, medium: medium || '' };
		edges.push(seen[pair]);
	}

	for (const row of rows || []) {
		// Only a live batctl neighbor is a direct link of this device.  A row
		// built from announcements describes a hardif of a remote device and
		// must not be turned into another centre line.
		if (row.announced)
			continue;

		addEdge('local', mesh.deviceKey(row), row.backhaul || '');
	}

	originators = originators || {};

	for (const mac of Object.keys(originators)) {
		const entry = originators[mac] || {};
		const target = macToKey[mac];

		if (!target)
			continue;

		let hop = macToKey[entry.nexthop];

		// A nexthop that no row names is only this device when the target is
		// itself a direct neighbour; otherwise the path beyond the next hop is
		// unknown and an invented centre line would misrepresent the mesh.
		if (!hop) {
			if (!directKeys[target])
				continue;

			hop = 'local';
		}

		addEdge(hop, target, '');
	}

	return edges;
}

/*
 * A ring layout around this device: level 1 holds the direct neighbours, level
 * 2 the devices behind them, and so on.  Every device the peer cache knows is
 * drawn; the canvas grows with the number of rings, so a larger mesh is
 * scaled instead of truncated.  The graph is built in the SVG namespace:
 * document.createElement() would create an HTML element that never renders.
 */
function topologyGraph(centerLabel, groups, rows, originators) {
	const byKey = {};
	const levels = { local: 0 };
	const order = [];

	for (const group of groups) {
		byKey[group.key] = group;
		order.push(group.key);
	}

	const edges = topologyEdges(rows, originators);
	const adjacency = { local: [] };

	for (const key of order)
		adjacency[key] = [];

	for (const edge of edges) {
		if (!adjacency[edge.a])
			adjacency[edge.a] = [];
		if (!adjacency[edge.b])
			adjacency[edge.b] = [];

		adjacency[edge.a].push(edge.b);
		adjacency[edge.b].push(edge.a);
	}

	const queue = [ 'local' ];
	let maxLevel = 0;

	while (queue.length) {
		const key = queue.shift();
		const level = levels[key];

		for (const next of adjacency[key] || []) {
			if (levels[next] != null)
				continue;

			levels[next] = level + 1;
			maxLevel = Math.max(maxLevel, level + 1);
			queue.push(next);
		}
	}

	// A device that announced itself but has no path (yet) is still shown, on
	// a ring beyond the reachable devices.
	for (const key of order) {
		if (levels[key] == null) {
			levels[key] = maxLevel + 1;
			maxLevel += 1;
		}
	}

	const rings = {};

	for (const key of order) {
		const level = levels[key] || 1;

		if (!rings[level])
			rings[level] = [];
		rings[level].push(key);
	}

	const radii = {};
	let maxRadius = 0;

	for (const level of Object.keys(rings)) {
		const radius = 170 + (Number(level) - 1) * 120;

		radii[level] = radius;
		maxRadius = Math.max(maxRadius, radius);
	}

	const width = 2 * (maxRadius + 180);
	const height = 2 * (maxRadius + 140);
	const cx = width / 2;
	const cy = height / 2;
	const root = svgEl('svg', {
		viewBox: '0 0 %d %d'.format(width, height),
		'class': 'wm-topo',
		role: 'img',
		'aria-label': _('Mesh topology')
	});

	const positions = { local: { x: cx, y: cy, key: 'local' } };

	for (const level of Object.keys(rings)) {
		const keys = rings[level];
		const radius = radii[level];
		// Offset every second ring so labels do not line up over each other.
		const start = -Math.PI / 2 + (Number(level) % 2 ? 0 : Math.PI / keys.length);

		keys.forEach(function(key, index) {
			const angle = start + index * 2 * Math.PI / keys.length;

			positions[key] = {
				key: key,
				x: cx + Math.cos(angle) * radius,
				y: cy + Math.sin(angle) * radius
			};
		});
	}

	function mediumOfEdge(edge) {
		if (edge.medium)
			return edge.medium;

		const media = [];

		for (const key of [ edge.a, edge.b ]) {
			const group = byKey[key];

			if (group)
				media = media.concat(mediaOf(group));
		}

		return media.indexOf('wired') !== -1 ? 'wired' :
			(media.indexOf('wlan') !== -1 ? 'wlan' : 'unknown');
	}

	for (const edge of edges) {
		const from = positions[edge.a];
		const to = positions[edge.b];

		if (!from || !to)
			continue;

		root.appendChild(svgEl('line', {
			x1: from.x,
			y1: from.y,
			x2: to.x,
			y2: to.y,
			'class': 'wm-topo-line wm-topo-line-' + mediumOfEdge(edge)
		}));
	}

	root.appendChild(svgEl('rect', {
		x: cx - 84,
		y: cy - 26,
		width: 168,
		height: 52,
		rx: 10,
		'class': 'wm-topo-center'
	}));
	root.appendChild(svgText(cx, cy - 2, truncate(centerLabel, 22), 'wm-topo-label'));
	root.appendChild(svgText(cx, cy + 16, _('This device'), 'wm-topo-muted'));

	for (const key of order) {
		const group = byKey[key];
		const position = positions[key];

		if (!group || !position)
			continue;

		const media = mediaOf(group);
		const kind = media.length === 1 ? media[0] :
			(media.length > 1 ? 'hybrid' : 'unknown');
		const anchor = position.x < cx - 10 ? 'end' :
			(position.x > cx + 10 ? 'start' : 'middle');
		const tx = position.x + (anchor === 'start' ? 14 :
			(anchor === 'end' ? -14 : 0));
		const ty = anchor === 'middle'
			? position.y + (position.y < cy ? -18 : 24)
			: position.y + 4;
		const primary = primaryRow(group);
		const detail = [];
		const nodeState = groupNodeState(group);

		detail.push(kind === 'hybrid' ? _('Ethernet + wireless') : mediumName(kind));

		if (primary && primary.speed)
			detail.push(format.rate(primary.speed));

		if (primary && primary.channel)
			detail.push(channelName(primary));

		if (nodeState !== 'normal')
			detail.push(topology.stateName(nodeState));

		root.appendChild(svgEl('circle', {
			cx: position.x,
			cy: position.y,
			r: 9,
			'class': 'wm-topo-node wm-topo-node-' + kind + ' wm-topo-node-state-' + nodeState
		}));
		root.appendChild(svgText(tx, ty, truncate(group.name, 20), 'wm-topo-label', anchor));
		root.appendChild(svgText(tx, ty + 14, detail.join(' · '), 'wm-topo-muted', anchor));
	}

	return root;
}

function linkBadge(row) {
	if (row.backhaul === 'wired')
		return badge(_('Ethernet'), 'ok');
	if (row.backhaul === 'wlan')
		return badge(_('Wireless'), 'info');

	return badge(_('Unknown'), 'muted');
}

function stateCell(state) {
	if (state === 'inuse')
		return badge(_('In use'), 'ok');
	if (state === 'standby')
		return badge(_('Standby'), 'muted');

	return '-';
}

function load() {
	return rpc.meshStatus().then(function(status) {
		const parsed = mesh.parseStatus(status.neighbors, status.peers,
			status.linkinfo, status.originators);
		const localInfo = mesh.parseLocalInfo(status.linkinfo);

		return {
			status: status,
			parsed: parsed,
			localInfo: localInfo,
			groups: groupDevices(parsed.rows),
			consistency: mesh.consistencyFindings(parsed.rows, localInfo),
			monitor: topology.monitor({
				rows: parsed.rows,
				localInfo: localInfo,
				configured: !!(status.state && status.state.active)
			})
		};
	});
}

function bandName(band) {
	return band === '2g' ? _('2.4 GHz') : (band === '5g' ? _('5 GHz') :
		(band === '6g' ? _('6 GHz') : String(band)));
}

function valuesText(values) {
	return (values || []).map(function(item) {
		return '%s (%s)'.format(item.device, item.value);
	}).join(', ');
}

/*
 * One line per finding, worded from the structured finding the comparison
 * returns.  A finding is only worded here, so the comparison itself stays
 * free of translated text.
 */
function findingText(finding) {
	switch (finding.code) {
	case 'mesh-id':
		return _('The mesh IDs announced by the devices differ. Nodes with different mesh IDs cannot form direct 802.11s links with each other.') +
			' ' + valuesText(finding.values);
	case 'routing-algo':
		return _('The batman-adv routing algorithm differs between nodes. Every node of one mesh must use the same algorithm.') +
			' ' + valuesText(finding.values);
	case 'key-state':
		return _('Some devices run the mesh with a key and others without one. Nodes with a different mesh protection cannot form direct links. The key itself is never announced, so its value is not compared.') +
			' ' + valuesText(finding.values);
	case 'encryption':
		return _('The mesh encryption differs between nodes. Every node must use the same 802.11s encryption.') +
			' ' + valuesText(finding.values);
	case 'band-disjoint':
		return _('The mesh radios have no frequency band in common. At least two nodes must run the mesh on the same band to link directly.') +
			' ' + valuesText(finding.values);
	case 'role-none':
		return _('No device announces the server role. One node has to be the mesh server.');
	case 'role-multiple':
		return _('More than one device announces the server role. Exactly one node should be the mesh server.') +
			' ' + valuesText(finding.values);
	case 'channel':
		return _('The mesh radios use different channels in the %s band.').format(bandName(finding.band)) +
			' ' + valuesText(finding.values);
	case 'htmode':
		return _('The mesh radios use different HT modes in the %s band.').format(bandName(finding.band)) +
			' ' + valuesText(finding.values);
	case 'not-announced':
		return _('These devices sent no mesh parameters, most likely because they run an older announcement version. They were not compared.') +
			' ' + finding.devices.join(', ');
	case 'auto-channel':
		return _('These devices use an automatic channel. The channel could not be compared.') +
			' ' + finding.devices.join(', ');
	default:
		return finding.code;
	}
}

function findingLevel(finding) {
	return finding.level === 'error' ? 'error' :
		(finding.level === 'warn' ? 'warn' : 'info');
}

return view.extend({
	load: function() {
		return load().catch(function(err) {
			return { error: err };
		});
	},

	render: function(data) {
		if (!data || data.error)
			return widgets.page(_('Mesh topology'), null,
				[ widgets.errorBox(data && data.error) ]);

		const content = E('div', {});
		let current = data;

		const renderContent = function() {
			const status = current.status || {};
			const parsed = current.parsed || { rows: [], local: [], ok: false };
			const state = status.state || {};
			const bat0 = status.bat0 || {};
			const local = (parsed.local && parsed.local[0]) || null;
			const localInfo = current.localInfo || null;
			const localLabel = (local && local.hostname) || state.mesh_id || _('This device');
			const applied = parsed.active;
			const configured = state.active;

			const summary = card(_('This device'), [
				kv([
					[ _('Hostname'), localLabel ],
					[ _('IPv4 address'), local && local.ips && local.ips[0] ? local.ips[0] : '-' ],
					[ _('MAC address'), bat0.mac ? format.mac(bat0.mac) : '-' ],
					[ _('Mesh role'), state.role || parsed.role || '-' ],
					[ _('Mesh ID'), state.mesh_id || '-' ],
					[ _('Mesh radio'), state.mesh_radio || '-' ],
					[ _('WiFi channel'), localInfo && localInfo.channel
						? channelName(localInfo) : '-' ],
					[ _('CPU load'), localInfo && localInfo.load ? String(localInfo.load) : '-' ],
					[ _('Memory in use'), localInfo && localInfo.memory != null
						? String(localInfo.memory) + '%' : '-' ],
					[ _('Connected clients'), localInfo && localInfo.clients != null
						? String(localInfo.clients) : '-' ],
					[ _('Mesh applied'), applied === null
						? badge(_('Unknown'), 'muted')
						: (applied ? badge(_('Active'), 'ok') : badge(_('Not applied'), 'muted')) ],
					[ _('Configured'), configured
						? badge(_('Enabled'), 'ok')
						: badge(_('Disabled'), 'muted') ],
					[ _('bat0 device'), bat0.exists
						? (bat0.up ? badge(_('Up'), 'ok') : badge(_('Down'), 'error'))
						: badge(_('Not present'), 'muted') ],
					[ _('Backhaul interfaces'), (bat0.hardifs || []).join(', ') || '-' ]
				])
			], { description: _('Memory and client values are measured on this device; the client count covers the access points of this device only and is not the number of clients of the whole mesh.') });

			const warnings = [];

			if (!parsed.ok)
				warnings.push(alert('warn',
					_('The neighbor table could not be read, so the topology may be incomplete.')));

			if (configured && applied === false)
				warnings.push(alert('warn',
					_('Mesh is configured but not applied yet. Open Mesh Settings and apply the configuration.')));

			const graph = current.groups.length
				? topologyGraph(localLabel, current.groups, parsed.rows, parsed.originators)
				: widgets.empty(_('No other mesh device is currently visible.'));

			const legend = E('div', { 'class': 'wm-muted' }, [
				E('p', {}, [
					E('span', { 'class': 'wm-topo-key wm-topo-key-wired' }, [ '────' ]),
					' ' + _('solid line: Ethernet backhaul') + '   ',
					E('span', { 'class': 'wm-topo-key wm-topo-key-wlan' }, [ '┄┄┄┄' ]),
					' ' + _('dashed line: wireless backhaul')
				]),
				E('p', {}, [
					E('span', { 'class': 'wm-topo-key wm-topo-key-weak' }, [ '●' ]),
					' ' + _('Weak signal') + '   ',
					E('span', { 'class': 'wm-topo-key wm-topo-key-offline' }, [ '●' ]),
					' ' + _('Offline')
				])
			]);

			const rows = [];

			for (const group of current.groups) {
				for (const row of group.rows) {
					rows.push([
						group.name,
						(group.ips || []).join(', ') || '-',
						linkBadge(row),
						row.iface || '-',
						stateCell(row.backhaulState),
						row.signal || '-',
						row.speed ? format.rate(row.speed) : '-',
						row.memory != null ? String(row.memory) + '%' : '-',
						row.clients != null ? String(row.clients) : '-',
						row.lastSeen || '-'
					]);
				}
			}

			const nodeRows = current.groups.map(function(group) {
				const primary = primaryRow(group) || {};
				const mac = nodeValue(group, 'lanMac') || nodeValue(group, 'neighbor');
				const memory = nodeValue(group, 'memory');
				const clients = nodeValue(group, 'clients');
				const media = mediaOf(group).map(function(medium) {
					return mediumName(medium);
				}).join(', ');

				return [
					group.name,
					nodeStateBadge(groupNodeState(group)),
					mac ? format.mac(mac) : '-',
					(group.ips || []).join(', ') || '-',
					roleName(nodeValue(group, 'peerRole')),
					groupLoad(group),
					memory === '' ? '-' : String(memory) + '%',
					groupChannel(group),
					clients === '' ? '-' : String(clients),
					media || '-',
					stateCell(groupState(group)),
					bestSignal(group),
					primary.speed ? format.rate(primary.speed) : '-'
				];
			});

			const findings = (current.consistency && current.consistency.findings) || [];

			const consistencyCard = card(_('Mesh consistency'), [
				findings.length
					? E('div', {}, findings.map(function(finding) {
						return alert(findingLevel(finding), findingText(finding));
					}))
					: alert('success', _('No mesh parameter mismatch was found among the devices that announced them.')),
				E('p', { 'class': 'wm-muted' }, [
					_('The announced mesh ID, routing algorithm, role, channel and HT mode are compared with this device. The mesh key is never transmitted, so it is not compared. Devices that announce none of these values or use an automatic channel are listed instead of being counted as a mismatch.')
				])
			], { description: _('Configuration drift between nodes is the usual reason a mesh stops forming a direct link.') });

			const monitor = current.monitor || topology.monitor({ rows: [] });
			const monitorLevel = { error: 'error', warn: 'warn', info: 'info' };
			const monitoringCard = card(_('Topology monitoring'), [
				kv([
					[ _('Visible devices'), String(monitor.summary.devices) ],
					[ _('Normal'), String(monitor.summary.normal) ],
					[ _('Weak signal'), String(monitor.summary.weak) ],
					[ _('Offline'), String(monitor.summary.offline) ],
					[ _('Ethernet backhaul'), String(monitor.summary.wired) ],
					[ _('Wireless backhaul'), String(monitor.summary.wireless) ],
					[ _('Hybrid backhaul'), String(monitor.summary.hybrid) ],
					[ _('Weakest backhaul signal'), monitor.summary.weakestSignal != null
						? monitor.summary.weakestSignal + ' dBm' : '-' ],
					[ _('Highest memory use'), monitor.summary.maxMemory != null
						? monitor.summary.maxMemory + '%' : '-' ]
				]),
				monitor.findings.length
					? E('div', {}, monitor.findings.map(function(finding) {
						return alert(monitorLevel[finding.level] || 'info',
							topology.findingText(finding));
					}))
					: alert('success', _('No runtime topology problem was detected.'))
			], { description: _('Reads the neighbor announcements of the devices currently visible. Stale announcements, memory pressure, a weak wireless-only backhaul, incomplete announcements and two devices announcing the same LAN MAC are reported. A device that stops announcing is marked offline once its announcement is two minutes old; the peer cache drops it after five minutes, after which it is no longer listed.') });

			dom.content(content, [
				E('div', {}, warnings),
				summary,
				monitoringCard,
				card(_('Topology'), [
					graph,
					legend
				], { description: _('Every visible device is drawn. The rings follow the routing hops from this device; a line runs from one device to the next hop on the path to it, using the medium the link was reported with. Two devices joined by both media are drawn with solid and dashed links.') }),
				card(_('Nodes'), [
					table([
						{ label: _('Device') },
						{ label: _('Node state') },
						{ label: _('MAC address') },
						{ label: _('IPv4 address') },
						{ label: _('Node role') },
						{ label: _('CPU load') },
						{ label: _('Memory') },
						{ label: _('WiFi channel') },
						{ label: _('Clients') },
						{ label: _('Backhaul') },
						{ label: _('Link status') },
						{ label: _('Signal') },
						{ label: _('Rate') }
					], nodeRows, { empty: _('No other mesh device is currently visible.') })
				], { description: _('One row per device. MAC address, role, CPU load, channel, memory and client count are the values that device announces for itself; a value an older announcement does not carry stays empty instead of being guessed. Signal is the strongest backhaul signal reported for that device. Node state is normal, weak signal (a wireless-only backhaul below -75 dBm) or offline (no announcement for two minutes).') }),
				card(_('Links'), [
					table([
						{ label: _('Device') },
						{ label: _('IPv4 address') },
						{ label: _('Backhaul') },
						{ label: _('Interface') },
						{ label: _('State') },
						{ label: _('Signal') },
						{ label: _('Rate') },
						{ label: _('Memory') },
						{ label: _('Clients') },
						{ label: _('Last seen') }
					], rows, { empty: _('No mesh link is currently visible.') })
				], { description: _('Signal is measured only on a wireless link this device terminates. Rows announced by another device show the values that device reports; a missing value stays empty instead of being guessed. Memory and client values repeat on every row of a device because the device announces them for itself.') }),
				consistencyCard,
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/mesh/neighbors', _('Neighbor details')),
						adminLink('admin/network/wifimanager/mesh/backhaul', _('Backhaul configuration')),
						adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return load().then(function(next) {
				current = next;
				renderContent();
			});
		}, 15000);

		return widgets.page(_('Mesh topology'),
			_('Devices reachable over the mesh and the medium each link uses.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
