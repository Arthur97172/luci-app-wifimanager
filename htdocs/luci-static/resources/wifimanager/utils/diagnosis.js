'use strict';
'require baseclass';
'require wifimanager.utils.roaming-advice as roaming';

/*
 * Unified diagnosis.
 *
 * The individual diagnostics pages each own one domain.  This module collects
 * the same read-only payloads into one ranked list, so an operator starts from
 * "what is wrong" instead of comparing four pages.  It never probes anything
 * itself: every finding is derived from a value a page already shows, and the
 * wording names the measured value so it can be verified.
 */

const CORE_SERVICES = [ 'network', 'firewall', 'dnsmasq' ];
const AUX_SERVICES = [ 'odhcpd', 'wpad', 'hostapd', 'dawn' ];

const SOURCE_ORDER = [ 'system', 'network', 'mesh', 'roaming' ];

function isOn(value) {
	return value === true || value === 1 || value === '1';
}

function finite(value) {
	const n = Number(value);

	return Number.isFinite(n) ? n : null;
}

function usedPercent(memory) {
	const total = finite(memory && memory.total_kb);
	const available = finite(memory && (memory.available_kb != null ? memory.available_kb : memory.free_kb));

	if (total == null || total <= 0 || available == null)
		return null;

	return Math.max(0, Math.min(100, (total - available) / total * 100));
}

function serviceName(name) {
	switch (name) {
	case 'network': return _('Network');
	case 'firewall': return _('Firewall');
	case 'dnsmasq': return _('dnsmasq (DHCP/DNS)');
	case 'odhcpd': return _('odhcpd (DHCPv6)');
	case 'wpad': return _('wpad (supplicant)');
	case 'hostapd': return _('hostapd (access points)');
	case 'dawn': return _('DAWN (roaming)');
	default: return name;
	}
}

function diagnose(input) {
	input = input || {};

	const findings = [];

	function add(source, level, code, message, values) {
		findings.push({
			source: source,
			level: level,
			code: code,
			message: message,
			values: values || {}
		});
	}

	/* System ------------------------------------------------------------- */

	const system = input.system || {};

	if (system && system.ok !== false) {
		const cpus = finite(system.cpus);
		const load1 = finite(system.load && system.load.m1);
		const cores = cpus != null && cpus > 0 ? cpus : 1;

		if (load1 != null) {
			if (load1 >= cores * 3)
				add('system', 'error', 'D-LOAD-01',
					_('The 1-minute load average is %s on %d CPU(s). The router is heavily overloaded; Wi-Fi and routing may stall.')
						.format(String(load1), cores), { load: load1, cpus: cores });
			else if (load1 >= cores * 1.5)
				add('system', 'warn', 'D-LOAD-01',
					_('The 1-minute load average is %s on %d CPU(s), above the normal range.')
						.format(String(load1), cores), { load: load1, cpus: cores });
		}

		const used = usedPercent(system.memory);

		if (used != null && used >= 97)
			add('system', 'error', 'D-MEM-01',
				_('%d%% of the memory is in use. Services can be killed by the kernel at any moment.')
					.format(Math.round(used)), { percent: used });
		else if (used != null && used >= 90)
			add('system', 'warn', 'D-MEM-01',
				_('%d%% of the memory is in use. Free memory before enabling more services.')
					.format(Math.round(used)), { percent: used });

		for (const service of (system.services || [])) {
			if (!service || !isOn(service.installed) || !isOn(service.enabled) || isOn(service.running))
				continue;

			const core = CORE_SERVICES.indexOf(service.name) !== -1;
			const aux = AUX_SERVICES.indexOf(service.name) !== -1;

			if (!core && !aux)
				continue;

			add('system', core ? 'error' : 'warn', 'D-SVC-01',
				_('%s is enabled at boot but is not running. Run "/etc/init.d/%s restart" and check the system log.')
					.format(serviceName(service.name), service.name),
				{ service: service.name });
		}
	}

	/* Network ------------------------------------------------------------ */

	const network = input.network || {};

	if (network && network.ok !== false && network.available !== false) {
		for (const check of (network.checks || [])) {
			if (!check || !check.code)
				continue;

			add('network', check.severity === 'error' ? 'error' : 'warn', check.code,
				String(check.message || '') +
					(check.detail ? ' (' + check.detail + ')' : ''),
				{ severity: check.severity });
		}
	}

	/* Mesh --------------------------------------------------------------- */

	const mesh = input.mesh || {};
	const state = mesh.state || {};
	const bat0 = mesh.bat0 || {};
	const counts = mesh.counts || {};
	const service = mesh.service || {};

	if (state.active) {
		if (!isOn(bat0.exists))
			add('mesh', 'error', 'D-MESH-01',
				_('Mesh is enabled in the configuration but the bat0 interface does not exist. Apply the mesh configuration and check the system log.'));
		else if (!isOn(bat0.up))
			add('mesh', 'warn', 'D-MESH-02',
				_('The bat0 interface exists but is down. No mesh traffic can flow until it comes up.'));

		if (finite(counts.peers) === 0)
			add('mesh', 'info', 'D-MESH-03',
				_('No mesh peer is currently visible. This is expected on a single-node mesh; on a multi-node mesh check the backhaul and the mesh ID.'));
	}

	if (isOn(service.legacy_enabled) && isOn(service.legacy_running))
		add('mesh', 'warn', 'D-MESH-04',
			_('The legacy meshassistant service is still enabled and running. It can rewrite the mesh configuration that WiFi Manager applied; disable it.'));

	/* Roaming ------------------------------------------------------------ */

	const advice = roaming.advise(input.roaming || {});

	for (const finding of advice.findings) {
		const level = finding.level === 'error' ? 'error' :
			(finding.level === 'warn' ? 'warn' : 'info');

		add('roaming', level, finding.code, roaming.adviceText(finding), finding.values);
	}

	/* Ranking ------------------------------------------------------------ */

	const levelOrder = { error: 0, warn: 1, info: 2 };
	const sourceOrder = {};

	SOURCE_ORDER.forEach(function(name, index) {
		sourceOrder[name] = index;
	});

	findings.sort(function(a, b) {
		return (levelOrder[a.level] - levelOrder[b.level]) ||
			(sourceOrder[a.source] - sourceOrder[b.source]);
	});

	const counts2 = { error: 0, warn: 0, info: 0, total: findings.length };
	const sources = {};

	for (const finding of findings) {
		counts2[finding.level]++;
		sources[finding.source] = (sources[finding.source] || 0) + 1;
	}

	let verdict = 'ok';

	if (counts2.error > 0)
		verdict = 'error';
	else if (counts2.warn > 0)
		verdict = 'warn';

	return {
		findings: findings,
		counts: counts2,
		sources: sources,
		verdict: verdict
	};
}

function sourceName(source) {
	switch (source) {
	case 'system': return _('System');
	case 'network': return _('Network');
	case 'mesh': return _('Mesh');
	case 'roaming': return _('Roaming');
	default: return source;
	}
}

function levelName(level) {
	return level === 'error' ? _('Error') :
		(level === 'warn' ? _('Warning') : _('Information'));
}

return baseclass.extend({
	diagnose: diagnose,
	sourceName: sourceName,
	levelName: levelName,
	usedPercent: usedPercent
});
