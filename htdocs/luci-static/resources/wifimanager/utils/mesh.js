'require baseclass';

const SPEED_RE = /^(\S+)\s+(\d+\.\d+s)\s+\(\s*([\d.]+)\s*\)\s+\[([^\]]+)\]$/;
const PLAIN_RE = /^(\S+)\s+(\S+)\s+(\d+\.\d+s)$/;

// The peer daemon drops an announcement once it is older than
// WM_PEER_MAX_AGE (300 s).  Reading the cache with the same window lets a
// device that stopped announcing stay in the table, where the topology view
// can mark it offline, until the cache itself forgets it.
const PEER_CACHE_SECONDS = 300;

function clean(s) {
	return String(s == null ? '' : s).trim();
}

function isMac(value) {
	return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(value);
}

function isIPv4(value) {
	const parts = String(value == null ? '' : value).split('.');

	if (parts.length !== 4)
		return false;

	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part) || Number(part) > 255)
			return false;
	}

	return value !== '0.0.0.0';
}

function firstValue(value) {
	if (Array.isArray(value))
		value = value[0];

	return clean(value).split(/\s+/)[0] || '';
}

// Status text may arrive either as the raw string the mesh_status RPC returns
// or as a legacy {code, stdout} exec reply.  Both are accepted so the parsers
// stay usable from diagnostics and from the topology page.
function textOf(reply) {
	if (reply == null)
		return '';

	if (typeof reply === 'string')
		return reply;

	return String(reply.stdout == null ? '' : reply.stdout);
}

function okOf(reply) {
	if (reply == null)
		return false;

	if (typeof reply === 'string')
		return true;

	return reply.code === 0;
}

return baseclass.extend({
	// MAC addresses are compared case-insensitively: batctl prints them in
	// lower case while LuCI host hints may keep the case of the DHCP lease.
	macKey(mac) {
		const key = clean(mac).toLowerCase();

		return isMac(key) ? key : '';
	},

	// Key of the device an announcement or a row belongs to.  The LAN bridge
	// MAC is the only value that is unique across the mesh and shared by every
	// hardif of a device; its LAN address can be missing and its hostname can
	// be equal on two devices.  Both fallbacks keep older announcements usable.
	deviceKey(entry) {
		if (!entry)
			return '';

		const lanMac = this.macKey(entry.lanMac);

		if (lanMac)
			return lanMac;

		if (entry.ip)
			return entry.ip;

		if (entry.ips && entry.ips[0])
			return entry.ips[0];

		return clean(entry.hostname) || clean(entry.neighbor) || '';
	},

	ipv4(value) {
		const ip = clean(value);

		return isIPv4(ip) ? ip : '';
	},

	// Convert an IPv4 prefix length (the "mask" of network.interface status)
	// to the dotted netmask shown by LuCI.
	prefixToNetmask(prefix) {
		if (prefix == null || clean(prefix) === '')
			return '';

		const bits = Number(prefix);

		if (!Number.isInteger(bits) || bits < 0 || bits > 32)
			return '';

		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

		return [
			(mask >>> 24) & 0xff,
			(mask >>> 16) & 0xff,
			(mask >>> 8) & 0xff,
			mask & 0xff
		].join('.');
	},

	// Canonical dotted form of an IPv4 netmask, or an empty string when the
	// value is not a contiguous mask.  0.0.0.0 is rejected as well: a /0 LAN
	// would route the whole IPv4 space onto the bridge.  netifd reads a
	// missing netmask as /32 and an empty one as /0, so the AP Mode form must
	// never store a value that is not a real mask.
	netmask(value) {
		const parts = clean(value).split('.');

		if (parts.length !== 4)
			return '';

		const octets = [];

		for (const part of parts) {
			if (!/^(0|[1-9]\d{0,2})$/.test(part))
				return '';

			const octet = Number(part);

			if (octet > 255)
				return '';

			octets.push(octet);
		}

		const mask = ((octets[0] << 24) | (octets[1] << 16) |
			(octets[2] << 8) | octets[3]) >>> 0;

		if (mask === 0)
			return '';

		const host = (~mask) >>> 0;

		return (host & (host + 1)) === 0 ? octets.join('.') : '';
	},

	// Defaults for the node's static LAN settings.  They come from the LAN
	// interface as it is currently configured: the live status of
	// network.interface (DHCP lease or static address, route, DNS) is used
	// first and the UCI section is only a fallback, so the form never offers
	// an address that does not belong to this LAN.  An empty string means
	// that no value could be detected.
	lanDefaults(status, lan) {
		status = status || {};
		lan = lan || {};

		let ipaddr = '';
		let netmask = '';
		let gateway = '';
		let dns = '';

		const addresses = Array.isArray(status['ipv4-address'])
			? status['ipv4-address'] : [];

		for (const addr of addresses) {
			const ip = this.ipv4(addr && addr.address);

			if (ip) {
				ipaddr = ip;

				if (addr.mask != null)
					netmask = this.prefixToNetmask(addr.mask);
				break;
			}
		}

		const uciAddr = firstValue(lan.ipaddr);
		const cidr = uciAddr.split('/');

		if (!ipaddr)
			ipaddr = this.ipv4(cidr[0]);

		if (!netmask) {
			if (cidr[1])
				netmask = this.prefixToNetmask(cidr[1]);
			else
				netmask = this.ipv4(firstValue(lan.netmask));
		}

		const routes = Array.isArray(status.route) ? status.route : [];

		for (const route of routes) {
			if (clean(route && route.target) !== '0.0.0.0' ||
			    Number(route.mask) !== 0)
				continue;

			gateway = this.ipv4(route.nexthop);

			if (gateway)
				break;
		}

		if (!gateway)
			gateway = this.ipv4(firstValue(lan.gateway));

		const servers = Array.isArray(status['dns-server'])
			? status['dns-server'] : [];

		for (const server of servers) {
			dns = this.ipv4(server);

			if (dns)
				break;
		}

		if (!dns)
			dns = this.ipv4(firstValue(lan.dns));

		if (!dns)
			dns = gateway;

		return {
			ipaddr: ipaddr,
			netmask: netmask,
			gateway: gateway,
			dns: dns
		};
	},

	// The address a DHCP client currently holds on the LAN.  An empty string
	// means the interface is up but has no lease; null means the interface
	// status could not be read, so the caller must not treat the missing
	// lease as a fault.
	lanLeaseAddress(status) {
		if (!status || typeof status !== 'object')
			return null;

		const addresses = Array.isArray(status['ipv4-address'])
			? status['ipv4-address'] : [];

		for (const addr of addresses) {
			const ip = this.ipv4(addr && addr.address);

			if (ip)
				return ip;
		}

		return '';
	},

	// Newest announcement per MAC.  A device announces every few seconds, so
	// several lines for the same MAC can be fresh at the same time.
	latestPeers(entries) {
		const latest = {};

		for (const entry of entries || []) {
			const previous = latest[entry.mac];

			if (!previous || entry.time >= previous.time)
				latest[entry.mac] = entry;
		}

		return latest;
	},

	// Peer announcements written by the daemon.  Each line is
	// "<epoch> <mesh MAC> <IPv4|-> <hostname> <load|-> [<LAN MAC|->] [<state>]
	// [<kind>] [<speed>] [<iface>] [<memory>] [<clients>] [<mesh id>]
	// [<channel>] [<htmode>] [<band>] [<role>] [<routing algo>]
	// [<key set|unset>] [<encryption>]".  The load
	// field is missing in lines written before version 2 of the announcement,
	// the LAN MAC in lines written before version 3, the hardif state in lines
	// written before version 4, the hardif medium in lines written before
	// version 5, the link speed the owning device measures on that hardif in
	// lines written before version 6, the hardif name in lines written before
	// version 7, the memory, client and mesh values in lines written before
	// version 9, and the mesh key state and encryption in lines written before
	// version 10.  The age is measured against the newest entry in the file,
	// not the browser clock: a router without NTP can have a clock that is far
	// from the browser's.  Every returned entry carries that age so a row built
	// from an announcement can report how long the device has been silent.
	parsePeers(text, maxAge) {
		const entries = [];
		const limit = maxAge == null ? PEER_CACHE_SECONDS : Number(maxAge);
		let latest = null;

		for (let line of String(text == null ? '' : text).split(/\r?\n/)) {
			line = line.trim();

			if (!line)
				continue;

			const parts = line.split(/\s+/);

			if (parts.length < 4)
				continue;

			const time = Number(parts[0]);
			const mac = this.macKey(parts[1]);
			const ip = parts[2] === '-' ? '' : this.ipv4(parts[2]);
			const hostname = clean(parts[3]);
			const load = /^\d+(\.\d+)?$/.test(clean(parts[4])) ? clean(parts[4]) : '';
			const lanMac = this.macKey(parts[5]);
			const state = parts[6] === 'inuse' || parts[6] === 'standby' ? parts[6] : '';
			const kind = parts[7] === 'wlan' || parts[7] === 'wired' ? parts[7] : '';
			const speed = /^\d+(\.\d+)?$/.test(clean(parts[8])) ? clean(parts[8]) : '';
			const peerIface = clean(parts[9]);
			const iface = peerIface !== '-' && /^[A-Za-z0-9_.@-]{1,15}$/.test(peerIface)
				? peerIface : '';
			const rawMemory = clean(parts[10]);
			const memory = /^(100|\d{1,2})$/.test(rawMemory) ? Number(rawMemory) : null;
			const rawClients = clean(parts[11]);
			const clients = /^\d{1,6}$/.test(rawClients) ? Number(rawClients) : null;
			const rawMeshId = clean(parts[12]);
			const meshId = /^[A-Za-z0-9_.-]{1,32}$/.test(rawMeshId) ? rawMeshId : '';
			const rawChannel = clean(parts[13]);
			const channel = rawChannel === 'auto' || /^\d{1,4}$/.test(rawChannel)
				? rawChannel : '';
			const rawHtmode = clean(parts[14]);
			const htmode = /^[A-Za-z0-9]{1,10}$/.test(rawHtmode) ? rawHtmode : '';
			const rawBand = clean(parts[15]);
			const band = [ '2g', '5g', '6g' ].indexOf(rawBand) !== -1 ? rawBand : '';
			const rawRole = clean(parts[16]);
			const role = [ 'server', 'node', 'client', 'off' ].indexOf(rawRole) !== -1
				? rawRole : '';
			const rawAlgo = clean(parts[17]);
			const routingAlgo = /^BATMAN_(IV|V)$/.test(rawAlgo) ? rawAlgo : '';
			const rawKeyState = clean(parts[18]);
			const keyState = rawKeyState === 'set' || rawKeyState === 'unset'
				? rawKeyState : '';
			const rawMeshEnc = clean(parts[19]);
			const meshEnc = /^[A-Za-z0-9+_-]{1,20}$/.test(rawMeshEnc) ? rawMeshEnc : '';

			if (!Number.isFinite(time) || !mac || !hostname)
				continue;

			entries.push({ time: time, mac: mac, ip: ip, hostname: hostname,
				load: load, lanMac: lanMac, state: state, kind: kind,
				speed: speed, iface: iface, memory: memory, clients: clients,
				meshId: meshId, channel: channel, htmode: htmode, band: band,
				role: role, routingAlgo: routingAlgo,
				keyState: keyState, meshEnc: meshEnc });

			if (latest == null || time > latest)
				latest = time;
		}

		if (latest == null || !(limit >= 0))
			return entries.map(function(entry) {
				entry.age = latest == null ? null : Math.max(0, latest - entry.time);
				return entry;
			});

		const cutoff = latest - limit;

		return entries.filter(function(entry) {
			return entry.time >= cutoff;
		}).map(function(entry) {
			entry.age = Math.max(0, latest - entry.time);
			return entry;
		});
	},

	// Attach the announced identity to every neighbor row.  When a MAC was
	// announced several times, the newest announcement wins.
	//
	// The announced IPv4 address is the address of the neighbor router's LAN
	// bridge, which is the only address the "IP Address" column shows.  Client
	// devices behind the router are not the neighbor; listing their addresses
	// made the column grow whenever a wired terminal or a DHCP lease appeared.
	// An announcement without an address (a router whose LAN has no IPv4) leaves
	// the row without one instead of guessing from the neighbour table, where
	// abandoned addresses can linger.
	annotatePeers(rows, entries) {
		const latest = this.latestPeers(entries);

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const peer = mac ? latest[mac] : null;

			row.hostname = peer ? peer.hostname : '';
			row.load = peer ? (peer.load || '') : '';
			row.ips = peer && peer.ip ? [ peer.ip ] : [];
			row.lanMac = peer ? (peer.lanMac || '') : '';
		}

		return rows;
	},

	// "linkinfo" starts with the state the helper script reports for the
	// applied mesh:
	//   state active=0|1
	// The status page uses it to tell a mesh the user turned off from one it
	// simply cannot read.  A missing line (older script) or a failed read
	// leaves the state unknown.
	parseMeshState(reply) {
		for (let line of textOf(reply).split(/\r?\n/)) {
			const m = /^state\s+active=([01])\s*$/.exec(line.trim());

			if (m)
				return m[1] === '1';
		}

		return null;
	},

	// "linkinfo" output of the helper script.  The radio driver reports the
	// frequency, channel and width of a hardif and the signal of each
	// station; the app merges them with the neighbor rows by interface name
	// and MAC.  Missing values are simply absent, which is normal for a wired
	// backhaul.  The channel and width follow the frequency and may be
	// missing when the driver does not expose them:
	//   kind <hardif> wlan|wired
	//   radio <hardif> <radio device|->
	//   iface <hardif> <MHz> [<channel> <width MHz>]
	//   peer <hardif> <MAC> <dBm|-> <tx Mbit|-> <rx Mbit|->
	parseLinkInfo(reply) {
		const links = {};

		for (let line of textOf(reply).split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);

			if (parts[0] === 'radio' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const radio = clean(parts[2]);

				if (!iface || !radio || radio === '-')
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].radio = radio;
			}
			else if (parts[0] === 'iface' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const frequency = Number(parts[2]);
				const channel = Number(parts[3]);
				const width = Number(parts[4]);

				if (!iface || !Number.isFinite(frequency) || frequency <= 0)
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].frequency = frequency;
				if (Number.isInteger(channel) && channel > 0)
					links[iface].channel = channel;
				if (Number.isFinite(width) && width > 0)
					links[iface].width = width;
			}
			else if (parts[0] === 'busy' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const busy = Number(parts[2]);

				if (!iface || !Number.isFinite(busy) || busy < 0 || busy > 100)
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].busy = Math.round(busy);
			}
			else if (parts[0] === 'peer' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const mac = this.macKey(parts[2]);
				const signal = Number(parts[3]);
				const tx = /^\d+(\.\d+)?$/.test(clean(parts[4])) ? clean(parts[4]) : '';
				const rx = /^\d+(\.\d+)?$/.test(clean(parts[5])) ? clean(parts[5]) : '';

				if (!iface || !mac)
					continue;

				if (!links[iface])
					links[iface] = {};
				if (Number.isFinite(signal)) {
					if (!links[iface].signals)
						links[iface].signals = {};
					links[iface].signals[mac] = signal;
				}
				if (tx || rx) {
					if (!links[iface].rates)
						links[iface].rates = {};
					links[iface].rates[mac] = { tx: tx, rx: rx };
				}
			}
			else if (parts[0] === 'kind' && parts.length >= 3) {
				const iface = clean(parts[1]);
				const kind = clean(parts[2]);
				const mac = this.macKey(parts[3]);

				if (!iface || (kind !== 'wired' && kind !== 'wlan'))
					continue;

				if (!links[iface])
					links[iface] = {};
				links[iface].kind = kind;
				if (mac)
					links[iface].mac = mac;
			}
		}

		return links;
	},

	// "linkinfo" also prints one line identifying this device:
	//   local <hostname> <IPv4|-> <load|-> [<role>] [<memory|->] [<clients|->]
	//         [<mesh id|->] [<channel|->] [<htmode|->] [<band|->] [<algo|->]
	// The hostname and load are the same values the daemon announces to the
	// other mesh devices.  The role is the effective meshassistant role, it is
	// missing in output from versions before it was added, and the values
	// after it are missing in output from versions before the consistency
	// check was added.
	parseLocalInfo(reply) {
		for (let line of textOf(reply).split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);

			if (parts[0] !== 'local' || parts.length < 4)
				continue;

			const hostname = clean(parts[1]);
			const ip = this.ipv4(parts[2]);
			const load = /^\d+(\.\d+)?$/.test(clean(parts[3])) ? clean(parts[3]) : '';
			const role = clean(parts[4]);
			const rawMemory = clean(parts[5]);
			const memory = /^(100|\d{1,2})$/.test(rawMemory) ? Number(rawMemory) : null;
			const rawClients = clean(parts[6]);
			const clients = /^\d{1,6}$/.test(rawClients) ? Number(rawClients) : null;
			const rawMeshId = clean(parts[7]);
			const meshId = /^[A-Za-z0-9_.-]{1,32}$/.test(rawMeshId) ? rawMeshId : '';
			const rawChannel = clean(parts[8]);
			const channel = rawChannel === 'auto' || /^\d{1,4}$/.test(rawChannel)
				? rawChannel : '';
			const rawHtmode = clean(parts[9]);
			const htmode = /^[A-Za-z0-9]{1,10}$/.test(rawHtmode) ? rawHtmode : '';
			const rawBand = clean(parts[10]);
			const band = [ '2g', '5g', '6g' ].indexOf(rawBand) !== -1 ? rawBand : '';
			const rawAlgo = clean(parts[11]);
			const routingAlgo = /^BATMAN_(IV|V)$/.test(rawAlgo) ? rawAlgo : '';
			const rawKeyState = clean(parts[12]);
			const keyState = rawKeyState === 'set' || rawKeyState === 'unset'
				? rawKeyState : '';
			const rawMeshEnc = clean(parts[13]);
			const meshEnc = /^[A-Za-z0-9+_-]{1,20}$/.test(rawMeshEnc) ? rawMeshEnc : '';

			if (!hostname)
				continue;

			return {
				hostname: hostname,
				ip: ip,
				load: load,
				role: (role === 'server' || role === 'node' || role === 'client' || role === 'off') ? role : '',
				memory: memory,
				clients: clients,
				meshId: meshId,
				channel: channel,
				htmode: htmode,
				band: band,
				routingAlgo: routingAlgo,
				keyState: keyState,
				meshEnc: meshEnc
			};
		}

		return null;
	},

	// The "batctl n" header names the primary mesh interface and its MAC:
	// "[..., MainIF/MAC: mesh_radio0/02:58:28:12:81:52 (bat0/...)]".
	parseLocalIdentity(stdout) {
		const m = /MainIF\/MAC:\s*([^\/\s]+)\/([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/.exec(
			String(stdout == null ? '' : stdout));

		if (!m)
			return null;

		const iface = clean(m[1]);
		const mac = this.macKey(m[2]);

		if (!iface || !mac)
			return null;

		return { iface: iface, neighbor: mac };
	},

	// Attach the backhaul medium and the radio frequency, channel, width,
	// channel utilization and the peer signal to every neighbor row.  The
	// radio values all depend on the hardif named by "batctl n": a wired
	// backhaul has no radio settings and no station signal, so those cells
	// stay empty.
	annotateLinks(rows, links) {
		links = links || {};

		for (const row of rows) {
			const iface = clean(row.iface);
			const link = links[iface] || {};
			const mac = this.macKey(row.neighbor);
			const signal = mac && link.signals ? link.signals[mac] : null;

			row.backhaul = link.kind === 'wired' || link.kind === 'wlan' ? link.kind : '';
			row.frequency = link.frequency ? link.frequency + ' MHz' : '';
			row.channel = link.channel ? String(link.channel) : '';
			row.width = link.width ? link.width + ' MHz' : '';
			row.utilization = link.busy == null ? '' : link.busy + '%';
			row.signal = signal == null ? '' : signal + ' dBm';
		}

		return rows;
	},

	parseNeighbors(stdout) {
		const rows = [];

		for (let line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
			line = line.trim();

			if (!line)
				continue;

			let m = SPEED_RE.exec(line);

			if (m) {
				rows.push({
					neighbor: clean(m[1]),
					lastSeen: clean(m[2]),
					speed: clean(m[3]),
					iface: clean(m[4]),
					announced: false
				});
				continue;
			}

			m = PLAIN_RE.exec(line);

			if (m) {
				rows.push({
					iface: clean(m[1]),
					neighbor: clean(m[2]),
					lastSeen: clean(m[3]),
					speed: '',
					announced: false
				});
			}
		}

		return rows;
	},

	// "batctl o" originator table.  Every line names an originator, the
	// throughput of one candidate nexthop and that nexthop's outgoing
	// interface; the candidate batman currently uses is marked with "*":
	//   * 00:58:28:12:81:54  0.070s ( 100000.0) 00:58:28:12:81:50 [ lan2]
	// Only the selected candidate is kept, keyed by originator.
	parseOriginators(stdout) {
		const selected = {};
		const re = /^(\*)?\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+\S+\s+\(\s*([\d.]+)\s*\)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+\[\s*([^\]\s]+)\s*\]$/;

		for (let line of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
			const m = re.exec(line.trim());

			if (!m || !m[1])
				continue;

			const originator = this.macKey(m[2]);
			const nexthop = this.macKey(m[4]);
			const throughput = Number(m[3]);

			if (!originator || !nexthop || !Number.isFinite(throughput))
				continue;

			selected[originator] = {
				nexthop: nexthop,
				iface: clean(m[5]),
				throughput: throughput
			};
		}

		return selected;
	},

	// Mark each row's link as the one its device currently uses ("inuse") or
	// as a standby ("standby").  The row's MAC belongs to the remote hardif
	// that carries the link, so the state the remote device announces for that
	// hardif is the link's state as that device sees it.  An announcement
	// without the state (written before version 4 of the announcement) falls
	// back to this device's own routing: the announced MACs of one device form
	// a group; the group member that has a selected originator is that
	// device's originator, and the selected nexthop names the link used to
	// reach it.
	//
	// A row whose device cannot be identified keeps the empty state and the
	// view prints a dash.
	annotateBackhaulState(rows, originators, entries) {
		originators = originators || {};

		const latest = this.latestPeers(entries);
		const groupMacs = {};

		for (const mac of Object.keys(latest)) {
			const peer = latest[mac];
			const key = this.deviceKey(peer);

			if (!key)
				continue;

			if (!groupMacs[key])
				groupMacs[key] = [];
			groupMacs[key].push(mac);
		}

		const deviceState = {};

		for (const key of Object.keys(groupMacs)) {
			let best = null;

			for (const mac of groupMacs[key]) {
				const entry = originators[mac];

				if (entry && (!best || entry.throughput > best.throughput))
					best = entry;
			}

			if (best)
				deviceState[key] = best;
		}

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const peer = mac ? latest[mac] : null;

			// The remote device knows which of its hardifs it forwards over;
			// this device's originator table only knows which of its own links
			// it uses to reach that device.
			if (peer && peer.state) {
				row.backhaulState = peer.state;
				continue;
			}

			const key = peer ? this.deviceKey(peer) : this.deviceKey(row);
			const state = (key && deviceState[key]) || (mac && originators[mac]) || null;

			if (!state) {
				row.backhaulState = '';
				continue;
			}

			const iface = clean(row.iface);
			const sameNexthop = mac === state.nexthop;
			const sameIface = !iface || !state.iface || iface === state.iface;

			row.backhaulState = sameNexthop && sameIface ? 'inuse' : 'standby';
		}

		return rows;
	},

	// Add one row per hardif every other device announces.  "batctl n" only
	// lists the hardifs this device is a direct neighbor of, so a node that
	// reaches the server through the server's wired link never sees that link,
	// while the server's own table shows it.  The announcements describe every
	// hardif of every mesh device, so the remote table can show the same links
	// each remote device reports for itself.  The announced rows carry the
	// identity, medium, state and — since version 6 of the announcement — the
	// link rate its device measures on that hardif, which is the only rate
	// available for a link this device is not an endpoint of, and since
	// version 7 the hardif name, which "batctl n" only reports for direct
	// neighbors.  The other measured link columns (frequency, signal) stay
	// empty because this device does not run a link to them.
	//
	// An announced row reports the age of its newest announcement as lastSeen
	// and is marked "announced".  That keeps a device that went silent visible
	// in the table and lets the topology monitor mark it offline before the
	// peer cache drops it, instead of removing the row without a trace.
	//
	// The device also receives its own announcements.  They are dropped by the
	// MACs "linkinfo" reports for the local hardifs and, when those are not
	// available, by the local hostname and address; with no way to tell this
	// device apart no announced rows are added rather than list the device
	// twice.
	//
	// A device's rows are kept together, wired links before wireless ones, so
	// the table reads per device like the Local Host table of that device.
	mergeAnnouncedRows(rows, entries, links, identity) {
		const latest = this.latestPeers(entries);
		const localMacs = {};
		let localKnown = false;

		for (const iface of Object.keys(links || {})) {
			const mac = links[iface].mac;

			if (mac) {
				localMacs[mac] = true;
				localKnown = true;
			}
		}

		const localKey = this.deviceKey(identity);
		const present = {};

		for (const row of rows) {
			const mac = this.macKey(row.neighbor);
			const peer = mac ? latest[mac] : null;

			if (mac)
				present[mac] = true;

			// A receiver whose "linkinfo" has no kind lines can still name the
			// medium from the announcement of the hardif it reached.
			if (peer && peer.kind && !row.backhaul)
				row.backhaul = peer.kind;

			// The local measurement of a direct link is exact; only a row
			// whose table has no rate (an older batman or a hostname
			// neighbor) takes the rate the remote device announced.
			if (peer && peer.speed && !row.speed)
				row.speed = peer.speed;

			// "batctl n" names the receiving interface of a direct link.  A
			// row built from an announcement has no local interface, so it
			// shows the name the owning device gave that hardif.
			if (peer && peer.iface && !row.iface)
				row.iface = peer.iface;

			// Memory, client count and mesh parameters describe the whole
			// announcing device, so every row of that device carries them.
			if (peer) {
				if (peer.memory != null)
					row.memory = peer.memory;
				if (peer.clients != null)
					row.clients = peer.clients;
				if (!row.meshId && peer.meshId)
					row.meshId = peer.meshId;
				if (!row.channel && peer.channel)
					row.channel = peer.channel;
				if (!row.htmode && peer.htmode)
					row.htmode = peer.htmode;
				if (!row.band && peer.band)
					row.band = peer.band;
				if (!row.peerRole && peer.role)
					row.peerRole = peer.role;
				if (!row.routingAlgo && peer.routingAlgo)
					row.routingAlgo = peer.routingAlgo;
				if (!row.keyState && peer.keyState)
					row.keyState = peer.keyState;
				if (!row.meshEnc && peer.meshEnc)
					row.meshEnc = peer.meshEnc;
			}
		}

		if (localKnown || localKey) {
			for (const mac of Object.keys(latest)) {
				const peer = latest[mac];
				const key = this.deviceKey(peer);

				if (present[mac] || localMacs[mac])
					continue;
				if (localKey && key === localKey)
					continue;

				rows.push({
					hostname: peer.hostname,
					neighbor: mac,
					ips: peer.ip ? [ peer.ip ] : [],
					lanMac: peer.lanMac || '',
					iface: peer.iface || '',
					backhaul: peer.kind || '',
					frequency: '',
					channel: '',
					width: '',
					signal: '',
					load: peer.load || '',
					utilization: '',
					speed: peer.speed || '',
					lastSeen: peer.age == null ? '' : peer.age + 's',
					announced: true,
					backhaulState: peer.state || '',
					memory: peer.memory,
					clients: peer.clients,
					meshId: peer.meshId || '',
					channel: peer.channel || '',
					htmode: peer.htmode || '',
					band: peer.band || '',
					peerRole: peer.role || '',
					routingAlgo: peer.routingAlgo || '',
					keyState: peer.keyState || '',
					meshEnc: peer.meshEnc || ''
				});
			}
		}

		return this.groupRemoteRows(rows);
	},

	// Group the rows of one device together, keeping the order in which the
	// devices first appear.  Rows without an announcement fall back to the
	// neighbor column, which batctl prints either as the hardif MAC or, in an
	// older format, as the hostname.  Wired links come first so the rows of a
	// wired and a wireless hardif appear in the same order as in that device's
	// own table.
	groupRemoteRows(rows) {
		const groups = [];
		const byKey = {};

		function rank(row) {
			return row.backhaul === 'wired' ? 0 : row.backhaul === 'wlan' ? 1 : 2;
		}

		for (const row of rows) {
			const key = this.deviceKey(row);
			let group = key ? byKey[key] : null;

			if (!group) {
				group = { rows: [] };

				if (key)
					byKey[key] = group;

				groups.push(group);
			}

			group.rows.push(row);
		}

		const result = [];

		for (const group of groups) {
			group.rows.sort(function(a, b) { return rank(a) - rank(b); });

			for (const row of group.rows)
				result.push(row);
		}

		return result;
	},

	// Compare the mesh parameters every device announces (DESIGN §6.3): mesh
	// ID, routing algorithm, role, and the channel and HT mode per band.
	//
	// The comparison is deliberately conservative.  Only values a device
	// actually announced are compared: a peer running an announcement version
	// without these fields, an "auto" channel or a radio without a band
	// option is reported as not comparable instead of being counted as a
	// mismatch.  The mesh key is never announced; the keyed state ("set" or
	// "unset"), the encryption name and the bands in use are compared, so a
	// node with a different protection or a band no other node shares is
	// reported.  Two nodes with different passwords cannot form a link at all;
	// that shows up as a missing peer, not as a value mismatch.  Findings are
	// structured ({code, level, values, devices}) and the view supplies the
	// translated text.
	consistencyFindings(rows, local) {
		const devices = [];
		const byName = {};

		const device = function(name) {
			name = clean(name);

			if (!name)
				return null;

			if (!byName[name]) {
				byName[name] = { name: name, meshId: '', role: '',
					routingAlgo: '', keyState: '', meshEnc: '', bands: {},
					autoChannel: false };
				devices.push(byName[name]);
			}

			return byName[name];
		};

		const accept = function(entry, facts) {
			if (!entry || !facts)
				return;

			if (!entry.meshId && facts.meshId)
				entry.meshId = clean(facts.meshId);
			if (!entry.role && facts.role)
				entry.role = clean(facts.role);
			if (!entry.routingAlgo && facts.routingAlgo)
				entry.routingAlgo = clean(facts.routingAlgo);
			if (!entry.keyState && facts.keyState)
				entry.keyState = clean(facts.keyState);
			if (!entry.meshEnc && facts.meshEnc)
				entry.meshEnc = clean(facts.meshEnc);
			if (facts.channel === 'auto')
				entry.autoChannel = true;

			const band = clean(facts.band);

			if (!band || !facts.channel || facts.channel === 'auto')
				return;

			const slot = entry.bands[band] || { channels: [], htmode: '' };

			if (slot.channels.indexOf(clean(facts.channel)) === -1)
				slot.channels.push(clean(facts.channel));
			if (!slot.htmode && facts.htmode)
				slot.htmode = clean(facts.htmode);
			entry.bands[band] = slot;
		};

		if (local)
			accept(device(local.hostname), local);

		for (const row of rows || []) {
			accept(device(row.hostname), {
				meshId: row.meshId,
				channel: row.channel,
				htmode: row.htmode,
				band: row.band,
				role: row.peerRole,
				routingAlgo: row.routingAlgo,
				keyState: row.keyState,
				meshEnc: row.meshEnc
			});
		}

		const findings = [];
		const values = function(field) {
			const out = [];

			for (const entry of devices) {
				if (entry[field])
					out.push({ device: entry.name, value: entry[field] });
			}

			return out;
		};
		const distinct = function(field) {
			const seen = {};

			for (const entry of devices)
				if (entry[field])
					seen[entry[field]] = true;

			return Object.keys(seen);
		};

		const meshIds = distinct('meshId');
		const algos = distinct('routingAlgo');
		const roles = distinct('role');
		const servers = devices.filter(function(entry) { return entry.role === 'server'; });

		if (meshIds.length > 1)
			findings.push({ level: 'error', code: 'mesh-id', values: values('meshId') });

		if (algos.length > 1)
			findings.push({ level: 'error', code: 'routing-algo', values: values('routingAlgo') });

		const keyStates = distinct('keyState');
		if (keyStates.length > 1)
			findings.push({ level: 'error', code: 'key-state', values: values('keyState') });

		const encryptions = distinct('meshEnc');
		if (encryptions.length > 1)
			findings.push({ level: 'error', code: 'encryption', values: values('meshEnc') });

		if (roles.length && servers.length === 0)
			findings.push({ level: 'warn', code: 'role-none', values: values('role') });

		if (servers.length > 1)
			findings.push({ level: 'warn', code: 'role-multiple', values: values('role') });

		const bandNames = [ '2g', '5g', '6g' ];

		for (const band of bandNames) {
			const channels = [];
			const htmodeValues = [];

			for (const entry of devices) {
				const slot = entry.bands[band];

				if (!slot)
					continue;

				for (const channel of slot.channels) {
					if (!channels.some(function(item) { return item.value === channel; }))
						channels.push({ device: entry.name, value: channel });
				}

				if (slot.htmode)
					htmodeValues.push({ device: entry.name, value: slot.htmode });
			}

			if (new Set(channels.map(function(item) { return item.value; })).size > 1)
				findings.push({ level: 'warn', code: 'channel', band: band, values: channels });

			if (new Set(htmodeValues.map(function(item) { return item.value; })).size > 1)
				findings.push({ level: 'warn', code: 'htmode', band: band, values: htmodeValues });
		}

		const bandNamesAll = [ '2g', '5g', '6g' ];
		const banded = devices.filter(function(entry) {
			return Object.keys(entry.bands).length > 0;
		});
		if (banded.length > 1) {
			const shared = bandNamesAll.filter(function(band) {
				return banded.every(function(entry) { return !!entry.bands[band]; });
			});
			if (!shared.length)
				findings.push({ level: 'error', code: 'band-disjoint',
					values: banded.map(function(entry) {
						return { device: entry.name, value: Object.keys(entry.bands).join('+') };
					}) });
		}

		const blind = devices.filter(function(entry) {
			return !entry.meshId && !entry.role && !entry.routingAlgo &&
				!entry.keyState && !entry.meshEnc &&
				Object.keys(entry.bands).length === 0 && !entry.autoChannel;
		});
		const auto = devices.filter(function(entry) { return entry.autoChannel; });

		if (blind.length)
			findings.push({ level: 'info', code: 'not-announced',
				devices: blind.map(function(entry) { return entry.name; }) });

		if (auto.length)
			findings.push({ level: 'info', code: 'auto-channel',
				devices: auto.map(function(entry) { return entry.name; }) });

		return { devices: devices, findings: findings };
	},

	// The local device has no link to itself.  Its row mirrors the neighbor
	// link with the strongest signal, so the signal and link rate columns
	// carry the same kind of values as the remote rows.  A wired backhaul has
	// no signal; the first neighbor then supplies the link rate.
	strongestLink(rows) {
		let best = null;
		let bestSignal = -Infinity;

		for (const row of rows || []) {
			const signal = parseInt(row && row.signal, 10);

			if (!Number.isFinite(signal))
				continue;

			if (signal > bestSignal) {
				bestSignal = signal;
				best = row;
			}
		}

		return best || (rows && rows.length ? rows[0] : null);
	},

	// Build the "Local Host" rows: one row per hardif bat0 currently uses.  The
	// hostname, LAN address, load and role are the identity of this device and
	// repeat on each row; the hardif, its MAC and its medium come from the
	// "linkinfo" kind lines.  Signal and link rate are not measured for the
	// device itself, so they mirror its best neighbor on the same hardif.
	parseLocalRows(statusStdout, linkReply, rows, originators) {
		const info = this.parseLocalInfo(linkReply);

		if (!info)
			return [];

		const identity = this.parseLocalIdentity(statusStdout) || {};
		const links = this.parseLinkInfo(linkReply);
		const ifaces = Object.keys(links).filter(function(iface) {
			return links[iface].kind;
		});

		// Without kind lines (for example when batctl cannot list the
		// interfaces) keep the identity row that the old single-row layout
		// showed.
		if (ifaces.length === 0)
			ifaces.push(identity.iface || '');

		const local = ifaces.map(function(iface) {
			return this.buildLocalRow(info, identity, links, rows, iface);
		}, this);

		return this.annotateLocalState(local, originators);
	},

	buildLocalRow(info, identity, links, rows, iface) {
		const link = links[iface] || {};
		const mac = link.mac || (iface && iface === identity.iface ? identity.neighbor : '') || '';
		const peers = (rows || []).filter(function(row) {
			return clean(row.iface) === iface;
		});
		const peer = this.strongestLink(peers);
		let signal = peer ? (peer.signal || '') : '';
		const peerMac = peer ? this.macKey(peer.neighbor) : '';
		let rates = peerMac && link.rates ? link.rates[peerMac] : null;

		// The rates are per station rather than per interface; when the
		// strongest neighbor has no entry (for example because batman has not
		// listed it yet) use the strongest station that does have one.
		if (!rates && link.rates) {
			let best = null;

			for (const station of Object.keys(link.rates)) {
				const value = link.signals ? link.signals[station] : null;

				if (best == null || (value != null &&
					(link.signals[best] == null || value > link.signals[best])))
					best = station;
			}

			if (best != null)
				rates = link.rates[best];
		}

		// A radio can see stations that batman does not list as neighbors yet;
		// fall back to the strongest station signal of this hardif.
		if (!signal && link.signals) {
			let best = null;

			for (const station of Object.keys(link.signals)) {
				if (best == null || link.signals[station] > link.signals[best])
					best = station;
			}

			if (best != null)
				signal = link.signals[best] + ' dBm';
		}

		return {
			hostname: info.hostname,
			neighbor: mac,
			ips: info.ip ? [ info.ip ] : [],
			iface: iface,
			backhaul: link.kind || '',
			frequency: link.frequency ? link.frequency + ' MHz' : '',
			channel: link.channel ? String(link.channel) : '',
			width: link.width ? link.width + ' MHz' : '',
			signal: signal,
			radio: link.radio || '',
			txRate: rates && rates.tx ? rates.tx : '',
			rxRate: rates && rates.rx ? rates.rx : '',
			load: info.load || '',
			utilization: link.busy == null ? '' : link.busy + '%',
			speed: peer ? (peer.speed || '') : '',
			lastSeen: peer ? (peer.lastSeen || '') : '',
			backhaulState: '',
			memory: info.memory != null ? info.memory : null,
			clients: info.clients != null ? info.clients : null
		};
	},

	// Mark the local link "inuse" when batman selects its hardif as the
	// outgoing interface for at least one originator.  The other local hardifs
	// are standbys.  Without any selected originator the state is unknown and
	// the view prints a dash.
	annotateLocalState(rows, originators) {
		originators = originators || {};

		const inUse = {};
		let any = false;

		for (const mac of Object.keys(originators)) {
			const entry = originators[mac];

			if (!entry || !entry.iface)
				continue;

			any = true;
			inUse[clean(entry.iface)] = true;
		}

		for (const row of rows) {
			const iface = clean(row.iface);

			row.backhaulState = (!any || !iface) ? '' : (inUse[iface] ? 'inuse' : 'standby');
		}

		return rows;
	},

	/*
	 * "clients" prints one line per device attached to this router:
	 *   client <MAC> <iface> <hostname|-> <IPv4|-> <signal|dBm|->
	 * A device associated with more than one AP interface (MLO) is kept once,
	 * with the link that reports the strongest signal.  The section is sorted
	 * by interface, then hostname (unnamed devices last), then MAC, so the
	 * rows stay in place between refreshes.
	 */
	parseClients(reply) {
		const ok = okOf(reply);
		const text = ok ? textOf(reply) : '';
		const byMac = {};
		const macs = [];

		for (const line of text.split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);

			if (parts.length < 6 || parts[0] !== 'client')
				continue;

			const mac = this.macKey(parts[1]);

			if (!mac)
				continue;

			const signal = /^-?\d+$/.test(parts[5]) ? Number(parts[5]) : null;
			const entry = {
				mac: mac,
				iface: clean(parts[2]),
				hostname: clean(parts[3]) === '-' ? '' : clean(parts[3]),
				ip: parts[4] === '-' ? '' : this.ipv4(parts[4]),
				signal: signal
			};
			const previous = byMac[mac];

			if (!previous) {
				byMac[mac] = entry;
				macs.push(mac);
			}
			else if (signal != null &&
			         (previous.signal == null || signal > previous.signal)) {
				byMac[mac] = entry;
			}
		}

		const clients = macs.map(function(mac) {
			return byMac[mac];
		});

		clients.sort(function(a, b) {
			if (a.iface !== b.iface)
				return a.iface < b.iface ? -1 : 1;

			if (!!a.hostname !== !!b.hostname)
				return a.hostname ? -1 : 1;

			const ah = a.hostname.toLowerCase();
			const bh = b.hostname.toLowerCase();

			if (ah !== bh)
				return ah < bh ? -1 : 1;

			return a.mac < b.mac ? -1 : (a.mac > b.mac ? 1 : 0);
		});

		return { ok: ok, clients: clients };
	},

	/*
	 * "roaming" prints hostapd's transition counters per BSS:
	 *   bss <iface> <freq> <neighbor_report_tx> <bss_transition_request_tx> <bss_transition_response_rx>
	 * A counter hostapd does not expose is printed as "-" and stays null, so
	 * the view can show the interface without inventing a zero.
	 */
	parseRoaming(reply) {
		const ok = okOf(reply);
		const text = ok ? textOf(reply) : '';
		const rows = [];

		for (const line of text.split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);

			if (parts.length < 6 || parts[0] !== 'bss')
				continue;

			const number = function(value) {
				return /^\d+$/.test(value) ? Number(value) : null;
			};

			rows.push({
				iface: clean(parts[1]),
				freq: /^\d+$/.test(parts[2]) ? Number(parts[2]) : null,
				nr: number(parts[3]),
				btmTx: number(parts[4]),
				btmRx: number(parts[5])
			});
		}

		return rows;
	},

	channelPlan(nodes, localName, radios) {
		const names = (nodes || []).map(clean).sort();
		const self = clean(localName);
		const index = Math.max(0, names.indexOf(self));
		const count = Math.max(names.length, 1);
		const plan = [];

		for (const radio of (radios || [])) {
			const band = radio && radio.band;

			if (band !== '2g' && band !== '5g')
				continue;
			if (radio.mesh)
				continue;

			const slot = this.channelSlots(band, radio.width, count);

			plan.push({
				band: band,
				width: slot.width,
				channel: slot.channels[index % slot.channels.length],
				count: count,
				index: index
			});
		}

		return plan;
	},

	channelSlots(band, width, count) {
		const tables = band === '2g'
			? [
				{ width: 40, channels: [ '1', '11' ] },
				{ width: 20, channels: [ '1', '6', '11' ] }
			]
			: [
				{ width: 160, channels: [ '36', '100' ] },
				{ width: 80, channels: [ '36', '100', '149' ] },
				{ width: 40, channels: [ '36', '44', '149', '157' ] },
				{ width: 20, channels: [ '36', '44', '48', '149', '153', '157', '161' ] }
			];

		for (const table of tables) {
			if (table.width <= width && table.channels.length >= count)
				return table;
		}

		return tables[tables.length - 1];
	},

	parseStatus(reply, peerText, linkReply, originatorReply) {
		const active = this.parseMeshState(linkReply);
		const text = textOf(reply);

		if (!okOf(reply))
			return { ok: false, rows: [], local: [], role: '', active: active };

		const rows = this.parseNeighbors(text);
		const peers = this.parsePeers(peerText, PEER_CACHE_SECONDS);
		const links = this.parseLinkInfo(linkReply);
		const originators = this.parseOriginators(textOf(originatorReply));
		const info = this.parseLocalInfo(linkReply);

		this.annotatePeers(rows, peers);
		this.annotateLinks(rows, links);
		this.annotateBackhaulState(rows, originators, peers);

		const local = this.parseLocalRows(text, linkReply, rows, originators);

		return {
			ok: true,
			rows: this.mergeAnnouncedRows(rows, peers, links, info),
			local: local,
			role: info ? info.role : '',
			active: active,
			// The selected originator paths let the topology view draw the
			// links between remote devices, not only the star around this one.
			originators: originators
		};
	}
});
