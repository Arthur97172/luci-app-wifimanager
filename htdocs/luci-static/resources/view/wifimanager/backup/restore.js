'use strict';
'require view';
'require fs';
'require wifimanager.utils.rpc as rpc';
'require wifimanager.utils.widgets as widgets';
'require wifimanager.utils.format as format';
'require wifimanager.utils.backup as backup';
'require dom';
'require ui';

const card = widgets.card;
const table = widgets.table;
const badge = widgets.badge;
const alert = widgets.alert;
const kv = widgets.kv;
const adminLink = widgets.adminLink;

const UPLOAD_PATH = '/tmp/wifimanager-upload/upload.tar';

function newerFirst(a, b) {
	const left = String(a.created_at || a.id || '');
	const right = String(b.created_at || b.id || '');

	return right.localeCompare(left);
}

function showInfo(title, nodes) {
	ui.showModal(title, (nodes || []).concat([
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn cbi-button', 'click': ui.hideModal }, [ _('Close') ])
		])
	]));
}

function askPassword(title, message, confirmLabel) {
	return new Promise(function(resolve) {
		const input = E('input', {
			'class': 'cbi-input-text',
			'type': 'password',
			'autocomplete': 'current-password'
		});

		const close = function(value) {
			ui.hideModal();
			resolve(value);
		};

		const submit = function() {
			if (input.value === '')
				return;

			close(input.value);
		};

		input.addEventListener('keydown', function(ev) {
			if (ev.key === 'Enter')
				submit();
		});

		ui.showModal(title, [
			E('p', {}, [ message ]),
			input,
			E('p', { 'class': 'wm-muted' }, [
				_('The passphrase is only sent to the router for this action and is not stored in the browser.')
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button', 'click': function() { close(null); } }, [ _('Cancel') ]),
				' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action important', 'click': submit },
					[ confirmLabel || _('Continue') ])
			])
		]);

		input.focus();
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			rpc.backupList(true).catch(function() { return null; }),
			rpc.backupStatus().catch(function() { return null; }),
			rpc.backupSettingsGet().catch(function() { return null; })
		]).then(function(result) {
			return {
				list: result[0] || {},
				status: result[1] || {},
				settings: result[2] || {}
			};
		});
	},

	render: function(data) {
		let backups = (data.list && data.list.backups) || [];
		let status = data.status || {};
		let settings = (data.settings && data.settings.settings) || {};

		const checks = {};
		const content = E('div', {});
		const resultBox = E('div', {});

		const withPassword = function(entry, action) {
			if (!entry.encrypted)
				return action('');

			return askPassword(_('Encrypted backup'),
				_('Enter the passphrase for %s.').format(entry.id),
				_('Use passphrase')).then(function(password) {
				if (password == null)
					return null;

				return action(password);
			});
		};

		const refreshList = function() {
			return Promise.all([
				rpc.backupList(true).catch(function() { return null; }),
				rpc.backupStatus().catch(function() { return null; }),
				rpc.backupSettingsGet().catch(function() { return null; })
			]).then(function(result) {
				if (result[0] && result[0].ok !== false)
					backups = result[0].backups || [];

				if (result[1])
					status = result[1];

				if (result[2] && result[2].settings)
					settings = result[2].settings;

				const present = {};

				for (const entry of backups)
					present[entry.id] = true;

				for (const id of Object.keys(checks)) {
					if (!present[id])
						delete checks[id];
				}

				renderContent();
			});
		};

		const checkEntry = function(entry) {
			return withPassword(entry, function(password) {
				checks[entry.id] = { state: 'checking' };
				renderContent();

				return rpc.backupValidate(entry.id, password).then(function(reply) {
					if (!reply || reply.ok === false) {
						checks[entry.id] = {
							state: 'error',
							messages: [ (reply && reply.message) || (reply && reply.error) ||
								_('The archive could not be checked.') ]
						};
					}
					else {
						checks[entry.id] = {
							state: reply.valid ? 'valid' : 'invalid',
							messages: reply.errors || [],
							warnings: reply.warnings || [],
							format: reply.format
						};
					}

					renderContent();
				}).catch(function(err) {
					checks[entry.id] = {
						state: 'error',
						messages: [ (err && err.message) || _('The archive could not be checked.') ]
					};
					renderContent();
				});
			});
		};

		const showDetails = function(entry) {
			return withPassword(entry, function(password) {
				return rpc.backupDetails(entry.id, password).then(widgets.check).then(function(details) {
					const nodes = [];

					if (!details.valid) {
						nodes.push(alert('warn', details.error ||
							_('The archive could not be opened; a passphrase may be required.')));
					}
					else {
						const firmware = [ details.firmware && details.firmware.id,
							details.firmware && details.firmware.version ].filter(Boolean).join(' ');

						nodes.push(kv([
							[ _('Archive'), details.id ],
							[ _('Name'), details.name || '-' ],
							[ _('Description'), details.description || '-' ],
							[ _('Type'), backup.typeName(details.type) ],
							[ _('Created'), format.date(details.created_at) ],
							[ _('Hostname'), details.hostname || '-' ],
							[ _('Firmware'), firmware || '-' ],
							[ _('Target'), (details.firmware && details.firmware.target) || '-' ],
							[ _('Size'), format.bytesFromKb(details.size_kb) ],
							[ _('Areas'), backup.scopeText(backup.scopeList(details)) ],
							[ _('Radios'), (details.radios || []).map(function(radio) {
								return radio.name + (radio.band ? ' (' + radio.band + ')' : '');
							}).join(', ') || '-' ]
						]));
						if ((details.compatibility || []).length) {
							nodes.push(E('h4', {}, [ _('Compatibility warnings') ]));
							nodes.push(widgets.list(details.compatibility));
						}
						nodes.push(E('h4', {}, [ _('Files in the archive') ]));
						nodes.push(widgets.list((details.files || []).map(function(file) {
							return '/etc/config/' + String(file).replace(/^etc\/config\//, '');
						}), true));

						if (details.legacy)
							nodes.push(alert('info',
								_('This archive was created by Mesh Assistant. It is read in place and is never rewritten by WiFi Manager.')));
					}

					showInfo(_('Backup details'), nodes);
				}).catch(function(err) {
					widgets.notify('error', (err && err.message) || _('The details could not be read.'));
				});
			});
		};

		const planRestore = function(entry) {
			return withPassword(entry, function(password) {
				ui.showModal(_('Checking the backup'), [
					widgets.spinner(_('The archive is validated before anything is changed…'))
				]);

				let warnings = [];

				return rpc.backupValidate(entry.id, password).then(widgets.check).then(function(report) {
					if (!report.valid) {
						const messages = (report.errors || []).join(' ');

						throw new Error(messages || _('The archive is not valid.'));
					}

					// Design §10.7: firmware, radio and interface differences are
					// reported here and again in the confirmation, never dropped.
					// Older responses only carried them inside warnings.
					warnings = report.compatibility || report.warnings || [];

					return rpc.backupDetails(entry.id, password);
				}).then(widgets.check).then(function(details) {
					ui.hideModal();

					if (!details.valid)
						throw new Error(details.error || _('The archive could not be opened.'));

					let scope = backup.scopeList(details);

					if (!scope.length)
						scope = backup.scopeList(entry);

					if (!scope.length)
						scope = details.legacy || entry.legacy ? [ 'mesh' ] : backup.defaultScope(entry.type);

					return { id: entry.id, password: password, details: details, scope: scope,
						warnings: warnings };
				}).catch(function(err) {
					ui.hideModal();
					widgets.notify('error', (err && err.message) || _('The backup could not be validated.'));
					return null;
				});
			});
		};

		const confirmRestore = function(entry, plan) {
			const files = backup.affectedFiles(plan.scope);
			const connectivity = backup.touchesConnectivity(plan.scope);
			const legacy = plan.details.legacy || entry.legacy;

			return new Promise(function(resolve) {
				const ack = E('input', { 'type': 'checkbox' });
				const close = function(value) {
					ui.hideModal();
					resolve(value ? plan : null);
				};

				const restoreButton = E('button', {
					'class': 'btn cbi-button cbi-button-negative important',
					'disabled': true,
					'click': function() {
						if (ack.checked)
							close(true);
					}
				}, [ _('Restore now') ]);

				ack.addEventListener('change', function() {
					restoreButton.disabled = !ack.checked;
				});

				const nodes = [
					kv([
						[ _('Backup'), backup.displayName(entry) ],
						[ _('Description'), plan.details.description || entry.description || '-' ],
						[ _('Type'), backup.typeName(plan.details.type || entry.type) ],
						[ _('Created'), format.date(plan.details.created_at || entry.created_at) ],
						[ _('Size'), format.bytesFromKb(plan.details.size_kb != null
							? plan.details.size_kb : entry.size_kb) ],
						[ _('Areas'), backup.scopeText(plan.scope) ]
					]),
					plan.warnings && plan.warnings.length
						? E('div', {}, [
							E('h4', {}, [ _('Compatibility warnings') ]),
							widgets.list(plan.warnings),
							alert('warn', _('These differences do not block the restore, but check them first: the archive may come from different hardware or firmware.'))
						])
						: '',
					E('h4', {}, [ _('Configuration files that will be modified') ]),
					widgets.list(files.map(function(file) { return '/etc/config/' + file; })),
					alert('info', _('Only these files are replaced or merged. A restore never replaces the whole /etc/config directory.')),
					plan.scope.indexOf('wireless') !== -1
						? alert('warn', _('Wireless settings are part of the restore; Wi-Fi clients will reconnect.'))
						: '',
					connectivity
						? alert('warn', _('The LAN address, firewall or DHCP configuration may change. This page can become unreachable; reconnect at the address in the restored configuration.'))
						: '',
					connectivity
						? alert('error', _('If the restored configuration cuts off the path to this router, the automatic rollback cannot reach it either. Be ready to reach the device over the local network, the serial console or failsafe mode.'))
						: '',
					alert('info', _('A full pre-restore backup is created before any configuration file is changed.')),
					legacy
						? alert('info', _('This legacy Mesh Assistant archive is read in place. It is not converted, rewritten or deleted by the restore.'))
						: '',
					E('div', { 'class': 'wm-restore-ack' }, [
						E('label', {}, [
							ack, ' ',
							_('I understand the scope above and want to restore this backup now.')
						])
					]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn cbi-button', 'click': function() { close(false); } },
							[ _('Cancel') ]),
						' ',
						restoreButton
					])
				];

				ui.showModal(_('Confirm restore'), nodes);
			});
		};

		const applyRestore = function(plan) {
			ui.showModal(_('Restoring backup'), [
				widgets.spinner(_('The configuration is being restored and verified…')),
				E('p', { 'class': 'wm-muted' }, [
					_('Network interfaces may restart. If the LAN configuration changes, this page can become unreachable and the restore still continues on the router.')
				])
			]);

			return rpc.backupRestore(plan.id, true, plan.password)
				.then(widgets.check)
				.then(function() {
					return widgets.waitForOperation(300000);
				})
				.then(function(op) {
					ui.hideModal();

					if (op.state !== 'done')
						throw new Error(op.message || _('The restore failed.'));

					dom.content(resultBox, [
						alert('success', op.message || _('The backup was restored and verified.'))
					]);
					widgets.notify('info', _('Backup restored and verified.'));

					return refreshList();
				})
				.catch(function(err) {
					ui.hideModal();

					const message = (err && err.message) || _('The restore failed.');

					dom.content(resultBox, [
						alert('error', message),
						E('p', { 'class': 'wm-muted' }, [
							_('If this page lost its connection, the restore may still have succeeded. Reconnect at the new address and check the last operation on the backup overview page.')
						])
					]);
					widgets.notify('error', message);
				});
		};

		const restoreEntry = function(entry) {
			return planRestore(entry).then(function(plan) {
				if (!plan)
					return null;

				return confirmRestore(entry, plan).then(function(confirmed) {
					if (!confirmed)
						return null;

					return applyRestore(confirmed);
				});
			});
		};

		const deleteEntry = function(entry) {
			return widgets.confirm(_('Delete backup'),
				_('Delete the archive %s? The file and its checksum are removed; this cannot be undone.').format(entry.id),
				_('Delete'), true).then(function(confirmed) {
				if (!confirmed)
					return null;

				return rpc.backupDelete(entry.id).then(widgets.check).then(function() {
					delete checks[entry.id];
					widgets.notify('info', _('Backup deleted.'));

					return refreshList();
				}).catch(function(err) {
					widgets.notify('error', (err && err.message) || _('The backup could not be deleted.'));
				});
			});
		};

		/*
		 * A backup is a copy of /etc/config.  It carries Wi-Fi passphrases,
		 * the mesh key and other credentials in clear text unless the archive
		 * was encrypted, so the operator is warned before a copy leaves the
		 * router (DESIGN §10.8).
		 */
		const downloadEntry = function(entry) {
			return widgets.confirm(_('Download backup'),
				_('The archive contains configuration files with Wi-Fi passphrases, the mesh key and other credentials. An unencrypted archive stores them in clear text. Keep the downloaded file private, do not send it over an untrusted channel, and delete it when it is no longer needed. The download is copied to /tmp/wifimanager-download first.'),
				_('Download'), false).then(function(confirmed) {
				if (!confirmed)
					return null;

				ui.showModal(_('Preparing download'), [
					widgets.spinner(_('Copying the archive to the download area…'))
				]);

				return rpc.backupExport(entry.id).then(widgets.check).then(function(reply) {
					return fs.read_direct(reply.path, 'blob');
				}).then(function(blob) {
					const url = window.URL.createObjectURL(blob);
					const link = E('a', {
						'href': url,
						'download': entry.id,
						'style': 'display:none'
					});

					document.body.appendChild(link);
					link.click();
					window.setTimeout(function() {
						window.URL.revokeObjectURL(url);
						link.remove();
					}, 60000);

					ui.hideModal();
					widgets.notify('info', _('Download started: %s').format(entry.id));
				}).catch(function(err) {
					ui.hideModal();
					widgets.notify('error', (err && err.message) || _('The archive could not be downloaded.'));
				});
			});
		};

		const uploadBackup = function() {
			if (typeof ui.uploadFile !== 'function') {
				widgets.notify('error',
					_('This LuCI version has no upload support; copy the archive over SSH and use "Import copy" for legacy archives.'));
				return null;
			}

			return ui.uploadFile(UPLOAD_PATH).then(function() {
				ui.showModal(_('Importing backup'), [
					widgets.spinner(_('The uploaded archive is checked and stored…'))
				]);

				return rpc.backupImport(UPLOAD_PATH).then(widgets.check).catch(function(err) {
					if (!err || err.code !== 'E-PASS')
						throw err;

					return askPassword(_('Encrypted backup'),
						_('Enter the passphrase of the uploaded archive.'),
						_('Use passphrase')).then(function(password) {
						if (password == null)
							return null;

						return rpc.backupImport(UPLOAD_PATH, password).then(widgets.check);
					});
				});
			}).then(function(reply) {
				ui.hideModal();

				if (!reply)
					return null;

				widgets.notify('info', _('Backup %s imported.').format(reply.id));

				return refreshList();
			}).catch(function(err) {
				ui.hideModal();

				if (err && String(err.message || '').toLowerCase().indexOf('cancel') !== -1)
					return null;

				widgets.notify('error', (err && err.message) || _('The backup could not be imported.'));
			});
		};

		const importLegacy = function(entry) {
			return widgets.confirm(_('Copy legacy backup'),
				_('A copy with a current manifest and checksums is created in the backup store. The original archive in /etc/meshassistant/backup stays untouched.'),
				_('Create copy'), false).then(function(confirmed) {
				if (!confirmed)
					return null;

				return rpc.backupLegacyImport(entry.id).then(widgets.check).then(function(reply) {
					widgets.notify('info', _('Legacy backup imported as %s.').format(reply.id));

					return refreshList();
				}).catch(function(err) {
					widgets.notify('error', (err && err.message) ||
						_('The legacy backup could not be imported.'));
				});
			});
		};

		const validationCell = function(entry) {
			const state = checks[entry.id];

			if (!state || state.state === 'idle')
				return widgets.button(_('Check'), function() { return checkEntry(entry); });

			if (state.state === 'checking')
				return E('span', { 'class': 'wm-muted' }, [ _('Checking…') ]);

			const ok = state.state === 'valid';
			const nodes = [
				badge(ok ? _('Valid') : (state.state === 'invalid' ? _('Invalid') : _('Error')),
					ok ? 'ok' : 'error')
			];

			for (const message of (state.messages || []).slice(0, 3))
				nodes.push(E('div', { 'class': 'wm-muted' }, [ String(message) ]));

			for (const message of (state.warnings || []).slice(0, 2))
				nodes.push(E('div', { 'class': 'wm-muted' }, [ String(message) ]));

			return E('div', {}, nodes);
		};

		const actionsCell = function(entry) {
			const nodes = [
				widgets.button(_('Details'), function() { return showDetails(entry); }),
				widgets.button(_('Restore'), function() { return restoreEntry(entry); }, 'negative')
			];

			if (entry.legacy) {
				nodes.push(widgets.button(_('Import copy'), function() { return importLegacy(entry); }, 'action'));
			}
			else {
				nodes.push(widgets.button(_('Download'), function() { return downloadEntry(entry); }));
				nodes.push(widgets.button(_('Delete'), function() { return deleteEntry(entry); }, 'negative'));
			}

			return widgets.toolbar(nodes);
		};

		const backupRows = function(entries) {
			return entries.map(function(entry) {
				return [
					E('div', {}, [
						E('strong', {}, [ backup.displayName(entry) ]),
						entry.name ? E('div', { 'class': 'wm-muted' }, [ entry.id ]) : ''
					]),
					entry.description
						? E('span', { 'class': 'wm-wrap' }, [ entry.description ])
						: '-',
					format.date(entry.created_at),
					E('div', {}, [
						badge(backup.typeName(entry.type), entry.legacy ? 'warn' : 'info'),
						entry.encrypted ? E('span', {}, [ ' ', badge(_('Encrypted'), 'muted') ]) : ''
					]),
					entry.format != null ? String(entry.format) : '-',
					entry.firmware_version || '-',
					format.bytesFromKb(entry.size_kb),
					validationCell(entry),
					actionsCell(entry)
				];
			});
		};

		const warnings = function() {
			const nodes = [];

			if (data.list.ok !== true)
				nodes.push(alert('warn', _('The backup list could not be read.')));

			if (status.free_kb != null && Number(status.free_kb) < 4096)
				nodes.push(alert('warn',
					_('Less than 4 MiB is free in the backup storage location; creating a backup may fail.')));

			return nodes;
		};

		const renderContent = function() {
			const owned = backups.filter(function(entry) { return !entry.legacy; }).sort(newerFirst);
			const legacy = backups.filter(function(entry) { return entry.legacy; }).sort(newerFirst);
			const entries = owned.concat(legacy);

			const toolbar = widgets.toolbar([
				widgets.button(_('Upload backup'), function() { return uploadBackup(); }, 'action'),
				widgets.button(_('Refresh'), function() { return refreshList(); }),
				E('span', { 'class': 'wm-grow' }),
				E('span', { 'class': 'wm-muted' }, [
					_('%d backup(s) in %s').format(entries.length, status.path || '-')
				])
			]);

			dom.content(content, [
				E('div', {}, warnings()),
				card(_('Backups'), [
					toolbar,
					table([
						{ label: _('Name') },
						{ label: _('Description') },
						{ label: _('Created') },
						{ label: _('Type') },
						{ label: _('Version') },
						{ label: _('Firmware') },
						{ label: _('Size') },
						{ label: _('Validation'), className: 'wm-wrap' },
						{ label: _('Actions') }
					], backupRows(entries), { empty: _('No backup is stored yet.') }),
					E('p', { 'class': 'wm-muted' }, [
						_('Validation extracts the archive and checks its checksums. It is required before a restore and is not repeated automatically.')
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('Uploads are accepted from the browser only. A legacy Mesh Assistant archive can be copied into the current store with "Import copy"; the original stays read-only.')
					])
				], { description: _('Every archive is listed with its metadata. Encrypted archives need their passphrase for validation, details and restore.') }),
				card(_('Restore safety'), [
					widgets.list([
						_('The archive is extracted into a temporary directory; unsafe entry names, symlinks and a failed checksum are rejected.'),
						_('The manifest format and application are checked before anything is applied.'),
						_('Only the areas in the archive scope are modified. A restore never copies the whole /etc/config directory.'),
						_('A full pre-restore backup is created before any configuration file is changed.'),
						_('The restored configuration is applied before it is verified: network, wireless, mesh and DAWN are started from the restored files and checked. If they do not come up, the previous files are restored from the snapshot, reloaded and the restore is reported as rolled back.'),
						_('Legacy Mesh Assistant archives are read in place and are never deleted or lossily converted.')
					], true)
				]),
				resultBox,
				card(_('WiFi Manager Backup or OpenWrt Sysupgrade Backup?'), [
					E('p', {}, [
						_('WiFi Manager Backup stores and restores only the configuration files in the selected scope. A restore replaces or merges those files, can restart the network, and can make this page unreachable.')
					]),
					E('p', {}, [
						_('OpenWrt Sysupgrade Backup is a separate mechanism: it covers the whole system configuration and is applied by the firmware during an upgrade. WiFi Manager neither creates nor replaces it.')
					]),
					E('p', { 'class': 'wm-muted' }, [
						_('Use a Sysupgrade backup before flashing firmware. Use a WiFi Manager backup to undo a WiFi, mesh or roaming change without touching the rest of the system.')
					])
				], { description: _('Even a Full backup is limited to the configuration files WiFi Manager knows about; it is not a system image.') }),
				card(_('Related pages'), [
					widgets.list([
						adminLink('admin/network/wifimanager/backup/overview', _('Backup overview')),
						adminLink('admin/network/wifimanager/backup/create', _('Create backup')),
						adminLink('admin/network/wifimanager/backup/settings', _('Backup settings')),
						adminLink('admin/network/wifimanager/diagnostics/logs', _('Logs'))
					])
				])
			]);
		};

		renderContent();

		return widgets.page(_('Restore backup'),
			_('Validate, inspect, download or restore a stored configuration archive.'),
			[ content ]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
