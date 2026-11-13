'use strict';
'require view';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require wifimanager.utils.diagnosis as diagnosis';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const kv = widgets.kv;
const adminLink = widgets.adminLink;

const SERVICE_LABELS = {
	network: _('Network'),
	firewall: _('Firewall'),
	dnsmasq: _('dnsmasq (DHCP/DNS)'),
	odhcpd: _('odhcpd (DHCPv6)'),
	wpad: _('wpad (supplicant)'),
	hostapd: _('hostapd (access points)'),
	dawn: _('DAWN (roaming)'),
	meshassistant: _('meshassistant (legacy)'),
	wifimanager: _('wifimanager (this package)')
};

function isOn(value) {
	return value === true || value === 1 || value === '1';
}

function serviceState(entry) {
	if (!isOn(entry.installed))
		return badge(_('Not installed'), 'muted');

	if (isOn(entry.running))
		return badge(_('Running'), 'ok');

	if (isOn(entry.enabled))
		return badge(_('Enabled, stopped'), 'warn');

	return badge(_('Disabled'), 'muted');
}

function enabledBadge(entry) {
	if (!isOn(entry.installed))
		return '-';

	return isOn(entry.enabled) ? badge(_('Enabled'), 'ok') : badge(_('Disabled'), 'muted');
}

function usedMemory(memory) {
	const total = Number(memory.total_kb);
	const available = Number(memory.available_kb != null ? memory.available_kb : memory.free_kb);

	if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available))
		return '-';

	return '%.0f%%'.format(Math.max(0, Math.min(100, (total - available) / total * 100)));
}

return view.extend({
	load: function() {
		return Promise.all([
			rpc.diagnostics('system').catch(function(err) {
				return { ok: false, message: err && err.message };
			}),
			rpc.networkCheck().catch(function() { return null; }),
			rpc.meshStatus().catch(function() { return null; }),
			rpc.roamingAdvice().catch(function() { return null; })
		]).then(function(result) {
			return {
				diag: result[0],
				network: result[1] || {},
				mesh: result[2] || {},
				roaming: result[3] || {}
			};
		});
	},

	render: function(data) {
		const diag = data.diag;

		if (!diag || diag.ok === false)
			return widgets.page(_('System diagnostics'), null, [
				widgets.errorBox(new Error((diag && diag.message) ||
					_('The system information could not be read.')))
			]);

		const content = E('div', {});
		let current = diag;
		let networkReport = data.network || {};
		let meshStatus = data.mesh || {};
		let roamingReply = data.roaming || {};

		const renderContent = function() {
			const load = current.load || {};
			const memory = current.memory || {};
			const services = current.services || [];
			const interfaces = current.interfaces || [];

			const serviceRows = services.map(function(entry) {
				return [
					SERVICE_LABELS[entry.name] || entry.name,
					entry.name,
					isOn(entry.installed) ? badge(_('Yes'), 'ok') : badge(_('No'), 'muted'),
					enabledBadge(entry),
					serviceState(entry)
				];
			});

			const interfaceRows = interfaces.map(function(entry) {
				const addresses = (entry.addresses || []).filter(function(address) {
					return address;
				});

				return [
					entry.name,
					isOn(entry.up) ? badge(_('Up'), 'ok') : badge(_('Down'), 'error'),
					format.mac(entry.mac),
					addresses.length ? addresses.join(', ') : '-'
				];
			});

			const report = diagnosis.diagnose({
				system: current,
				network: networkReport,
				mesh: meshStatus,
				roaming: roamingReply
			});

			const reportRows = report.findings.map(function(finding) {
				return [
					badge(diagnosis.levelName(finding.level),
						finding.level === 'error' ? 'error' :
							(finding.level === 'warn' ? 'warn' : 'muted')),
					diagnosis.sourceName(finding.source),
					finding.code,
					finding.message
				];
			});

			const reportSummary = report.findings.length
				? alert(report.verdict === 'error' ? 'error' :
					(report.verdict === 'warn' ? 'warn' : 'info'),
					_('%s error(s), %s warning(s) and %s note(s) were found.').format(
						String(report.counts.error), String(report.counts.warn),
						String(report.counts.info)))
				: alert('success', _('No problem was found in the checked subsystems.'));

			const diagnosisCard = card(_('Unified diagnosis'), [
				reportSummary,
				report.findings.length
					? table([
						{ label: _('Severity') },
						{ label: _('Area') },
						{ label: _('Code') },
						{ label: _('Finding') }
					], reportRows)
					: '',
				E('p', { 'class': 'wm-muted' }, [
					_('Combines the system state, the configuration checks, the mesh runtime and the roaming advice. Values are read when the page loads and refreshed while it stays visible; nothing is probed actively.')
				])
			], { description: _('Errors first, then warnings and notes. The cards below keep the raw values a finding refers to.') });

			dom.content(content, [
				diagnosisCard,
				card(_('System'), [
					kv([
						[ _('Hostname'), format.dash(current.hostname) ],
						[ _('Firmware'), format.dash(current.release) ],
						[ _('Kernel'), format.dash(current.kernel) ],
						[ _('Uptime'), format.duration(current.uptime) ],
						[ _('Load (1 / 5 / 15 min)'), '%s / %s / %s'.format(
							format.dash(load.m1), format.dash(load.m5), format.dash(load.m15)) ]
					])
				], { description: _('Values are read at page load; the page refreshes while it stays visible.') }),
				card(_('Memory'), [
					kv([
						[ _('Total'), format.bytesFromKb(memory.total_kb) ],
						[ _('Available'), format.bytesFromKb(memory.available_kb) ],
						[ _('Free'), format.bytesFromKb(memory.free_kb) ],
						[ _('In use'), usedMemory(memory) ]
					])
				], { description: _('“Available” is the kernel estimate of memory that can be given to new workloads without swapping; “free” is unallocated memory.') }),
				card(_('Services'), [
					table([
						{ label: _('Service') },
						{ label: _('Init script') },
						{ label: _('Installed') },
						{ label: _('Enabled at boot') },
						{ label: _('Current state') }
					], serviceRows, { empty: _('No service information.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('“Not installed” means /etc/init.d has no matching script; it does not by itself indicate a fault.')
					])
				]),
				card(_('Interfaces'), [
					table([
						{ label: _('Interface') },
						{ label: _('State') },
						{ label: _('MAC') },
						{ label: _('IPv4 addresses') }
					], interfaceRows, { empty: _('No network interfaces were found.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('Only IPv4 addresses are listed. The state is the kernel operstate, which is down for interfaces that exist but carry no link.')
					])
				]),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs')),
						adminLink('admin/network/wifimanager/diagnostics/mesh', _('Mesh diagnostics')),
						adminLink('admin/status/overview', _('LuCI status overview'))
					])
				])
			]);
		};

		renderContent();

		widgets.autoRefresh(function() {
			return Promise.all([
				rpc.diagnostics('system').catch(function() { return current; }),
				rpc.networkCheck().catch(function() { return networkReport; }),
				rpc.meshStatus().catch(function() { return meshStatus; }),
				rpc.roamingAdvice().catch(function() { return roamingReply; })
			]).then(function(next) {
				if (next[0] && next[0].ok !== false)
					current = next[0];
				networkReport = next[1] || networkReport;
				meshStatus = next[2] || meshStatus;
				roamingReply = next[3] || roamingReply;
				renderContent();
			});
		}, 30000);

		return widgets.page(_('System diagnostics'),
			_('Router identity, load, memory, service state, network interfaces and configuration checks.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
