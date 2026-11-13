'use strict';
'require wifimanager.utils.widgets as widgets';

/*
 * Presentation for the read-only network checker.  Every finding is a
 * configuration fact; the checker does not probe the wire, so a clean result
 * is not a promise that DHCP or DNS currently answers.
 */

const TITLES = {
	'N-IP-01': _('Duplicate IPv4 address'),
	'N-IP-02': _('Overlapping IPv4 subnets'),
	'N-DHCP-01': _('Duplicate DHCP server'),
	'N-DHCP-02': _('DHCP server on a node/client'),
	'N-DHCP-03': _('DHCP disabled but still active'),
	'N-DHCP-04': _('DHCP expected but disabled'),
	'N-POOL-01': _('DHCP pool outside its subnet'),
	'N-POOL-02': _('Overlapping DHCP pools'),
	'N-DNS-01': _('Resolver points at itself'),
	'N-DNS-02': _('No upstream resolver'),
	'N-BRIDGE-01': _('WAN shares the LAN device'),
	'N-BRIDGE-02': _('WAN port inside the LAN bridge'),
	'N-ROUTE-01': _('Multiple default routes'),
	'N-FW-01': _('Interface outside every firewall zone'),
	'N-FW-02': _('bat0 missing from the LAN zone'),
	'N-FW-03': _('bat0 in the LAN zone on a client'),
	'N-MESH-01': _('bat0 not bridged into the LAN'),
	'N-MESH-02': _('bat0 bridged on a client'),
	'N-MESH-03': _('Mesh hard interface wiring'),
	'N-MESH-04': _('More than one 802.11s interface'),
	'N-MESH-05': _('Mesh interface network'),
	'N-MESH-06': _('Wired backhaul wiring')
};

function title(finding) {
	if (!finding)
		return '';

	return TITLES[finding.code] || finding.code || _('Network finding');
}

function severityBadge(finding) {
	return widgets.badge(finding && finding.severity === 'error' ? _('Error') : _('Warning'),
		finding && finding.severity === 'error' ? 'error' : 'warn');
}

function findingsCard(report, options) {
	options = options || {};

	const checks = (report && report.checks) || [];
	const errors = report && report.errors != null ? Number(report.errors) : 0;
	const warnings = report && report.warnings != null ? Number(report.warnings) : 0;
	const unavailable = !report || report.ok === false || report.available === false;

	const nodes = [];

	if (unavailable) {
		nodes.push(widgets.alert('warning',
			_('The network checks are unavailable. The rest of this page is unaffected.')));
	}
	else if (checks.length === 0) {
		nodes.push(widgets.alert('success',
			_('No DHCP, DNS, address, route, firewall-zone or mesh-bridge conflict was found in the configuration.')));
	}
	else {
		nodes.push(widgets.alert(errors > 0 ? 'error' : 'warning',
			_('%s error(s) and %s warning(s) were found.').format(String(errors), String(warnings))));
	}

	if (checks.length > 0) {
		nodes.push(widgets.table([
			{ label: _('Severity'), render: function(finding) { return severityBadge(finding); } },
			{ label: _('Code'), key: 'code' },
			{ label: _('Check'), render: function(finding) { return title(finding); } },
			{ label: _('Message'), className: 'wm-wrap', key: 'message' },
			{ label: _('Detail'), className: 'wm-wrap', key: 'detail' }
		], checks, { empty: _('No network finding.') }));
	}

	return widgets.card(options.title || _('Network checks'), nodes, {
		description: options.description ||
			_('Configuration-level checks across /etc/config/network, dhcp, firewall and wireless. Runtime reachability is not probed.')
	});
}

return {
	TITLES: TITLES,
	title: title,
	severityBadge: severityBadge,
	findingsCard: findingsCard
};
