/**
 * Wallets page.
 *
 * Reads and writes only this user's wallets. User identity comes from the
 * session, so nothing here sends or needs a userId.
 */

(function () {
	'use strict';

	var API = '/api/wallets';
	var selectedWalletId = null;
	var wallets = [];

	function renderSummary() {
		var totalBalance = 0;
		var totalFrozen = 0;

		wallets.forEach(function (wallet) {
			totalBalance += Number(wallet.balance) || 0;
			totalFrozen += Number(wallet.frozen) || 0;
		});

		var usable = totalBalance - totalFrozen;

		document.getElementById('walletSummary').innerHTML = [
			stat('Total saldo', App.formatRupiah(totalBalance), 'accent'),
			stat('Dana beku', App.formatRupiah(totalFrozen), 'warning'),
			stat('Saldo tersedia', App.formatRupiah(usable), 'positive'),
			stat('Jumlah dompet', String(wallets.length), '')
		].join('');
	}

	function stat(label, value, tone) {
		return '<div class="stat' + (tone ? ' stat--' + tone : '') + '">' +
			'<div class="stat__label">' + App.escapeHtml(label) + '</div>' +
			'<div class="stat__value">' + value + '</div>' +
			'</div>';
	}

	/**
	 * Sorted by what a wallet list is actually read for: which account is
	 * biggest, which is nearly empty, and which ones are cash.
	 */
	var sortControl = App.createSortControl({
		selectId: 'sortBy',
		directionId: 'sortDir',
		fields: [
			{ value: 'name', label: 'Nama', get: function (w) { return w.name || ''; }, defaultDirection: 'asc' },
			{ value: 'balance', label: 'Saldo', get: function (w) { return Number(w.balance) || 0; }, defaultDirection: 'desc' },
			{ value: 'usable', label: 'Saldo tersedia', get: function (w) {
				return (Number(w.balance) || 0) - (Number(w.frozen) || 0);
			}, defaultDirection: 'desc' },
			{ value: 'frozen', label: 'Dana beku', get: function (w) { return Number(w.frozen) || 0; }, defaultDirection: 'desc' },
			{ value: 'kind', label: 'Jenis', get: function (w) { return App.walletKindLabel(w.kind); }, defaultDirection: 'asc' }
		]
	});

	App.on('sort:changed', function () {
		if (wallets.length) renderWallets();
	});

	function renderWallets() {
		var host = document.getElementById('walletList');

		if (wallets.length === 0) {
			host.innerHTML = '<div class="card"><div class="card__body">' +
				'<div class="empty"><div class="empty__title">Belum ada dompet</div>' +
				'<p>Tambahkan dompet pertama Anda untuk mulai mencatat transaksi.</p>' +
				'</div></div></div>';
			return;
		}

		var sorted = sortControl ? sortControl.apply(wallets) : wallets;

		host.innerHTML = sorted.map(function (wallet) {
			var usable = (Number(wallet.balance) || 0) - (Number(wallet.frozen) || 0);
			var name = App.escapeHtml(wallet.name);

			return '<div class="card"><div class="card__body">' +
				'<div class="wallet-card__head">' +
				'<h2 class="wallet-card__name">' + name + '</h2>' +
				'<div class="table__actions">' +
				'<button class="icon-btn" type="button" onclick="openEditModal(' +
				JSON.stringify(wallet.id).replace(/"/g, '&quot;') + ',' +
				JSON.stringify(wallet.name).replace(/"/g, '&quot;') + ',' +
				escapeAttr(wallet.balance) + ',' + escapeAttr(wallet.frozen) +
				')" aria-label="Edit ' + name + '" title="Edit">&#9998;</button>' +
				'<button class="icon-btn icon-btn--danger" type="button" onclick="openDeleteModal(' +
				JSON.stringify(wallet.id).replace(/"/g, '&quot;') +
				')" aria-label="Hapus ' + name + '" title="Hapus">&#128465;</button>' +
				'</div></div>' +
				'<div class="wallet-card__tag">' + App.walletKindTag(wallet.kind) + '</div>' +
				'<div class="stats wallet-card__figures">' +
				'<div class="stat stat--accent"><div class="stat__label">Saldo</div>' +
				'<div class="stat__value">' + App.formatRupiahShort(wallet.balance) + '</div></div>' +
				'<div class="stat stat--warning"><div class="stat__label">Beku</div>' +
				'<div class="stat__value">' + App.formatRupiahShort(wallet.frozen) + '</div></div>' +
				'<div class="stat stat--positive"><div class="stat__label">Tersedia</div>' +
				'<div class="stat__value">' + App.formatRupiahShort(usable) + '</div></div>' +
				'</div></div></div>';
		}).join('');
	}

	function escapeAttr(value) {
		return App.escapeHtml(String(Number(value) || 0));
	}

	function populateDropdowns() {
		var options = wallets.map(function (wallet) {
			return '<option value="' + App.escapeHtml(wallet.id) + '">' +
				App.escapeHtml(wallet.name) + ' (' + App.formatRupiahShort(wallet.balance) + ')</option>';
		}).join('');

		['fromWallet', 'toWallet'].forEach(function (id) {
			var select = document.getElementById(id);
			// Keep whatever was selected across a refresh where possible.
			var previous = select.value;
			select.innerHTML = options;
			if (previous && wallets.some(function (w) { return w.id === previous; })) {
				select.value = previous;
			}
		});
	}

	function load() {
		return Promise.all([App.api(API), loadTransfers()])
			.then(function (results) {
				wallets = results[0] || [];
				renderSummary();
				renderWallets();
				populateDropdowns();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	}

	/* ------------------------------------------------------ transfer history */

	function renderTransfers(rows) {
		var host = document.getElementById('transferHistory');
		if (!host) return;

		if (!rows || rows.length === 0) {
			host.innerHTML = '<tr><td colspan="4" class="text-muted">' +
				'Belum ada transfer. Pindahkan dana antar dompet dan riwayatnya muncul di sini.' +
				'</td></tr>';
			return;
		}

		host.innerHTML = rows.map(function (row) {
			// Pad the time by hand: toLocaleString renders "11.48" here, which reads
			// like a range rather than a time.
			var label = '-';
			if (row.createdAt) {
				var when = new Date(row.createdAt);
				if (!isNaN(when)) {
					var pad = function (n) { return String(n).padStart(2, '0'); };
					label = App.formatDate(when.getFullYear() + '-' +
						pad(when.getMonth() + 1) + '-' + pad(when.getDate())) +
						' ' + pad(when.getHours()) + ':' + pad(when.getMinutes());
				}
			}

			return '<tr>' +
				'<td class="text-muted">' + App.escapeHtml(label) + '</td>' +
				'<td>' + App.escapeHtml(row.fromWalletName || '-') + '</td>' +
				'<td>' + App.escapeHtml(row.toWalletName || '-') + '</td>' +
				'<td class="table__num">' + App.formatRupiah(row.amount) + '</td>' +
				'</tr>';
		}).join('');
	}

	window.loadTransfers = function () {
		var host = document.getElementById('transferHistory');
		if (!host) return Promise.resolve();

		return App.api(API + '/transfers')
			.then(renderTransfers)
			.catch(function (error) {
				// A failure here must not take the wallet list down with it.
				host.innerHTML = '<tr><td colspan="4" class="text-negative">' +
					'Riwayat transfer gagal dimuat: ' + App.escapeHtml(error.message) +
					'</td></tr>';
			});
	};

	/* ---------------------------------------------------------- kind picker */

	/**
	 * The kind is a radio group rather than a select because each one has an
	 * icon, and the point of tagging a wallet with its kind is that the icon is
	 * what you recognise. A dropdown hides the pictures behind one line of text.
	 *
	 * Built from the same table the server validates against, so an option the
	 * server would reject cannot be picked.
	 */
	function buildKindPickers() {
		document.querySelectorAll('[data-kind-picker]').forEach(function (host) {
			host.innerHTML = Object.keys(App.WALLET_KINDS).map(function (key, index) {
				var entry = App.WALLET_KINDS[key];
				// One shared name across both pickers: they are in two different
				// forms, but a browser would let one radio group span both.
				return '<label class="wallet-kind-picker__option">' +
					'<input type="radio" name="walletKind" value="' + App.escapeHtml(key) + '"' +
					(index === 0 ? ' checked' : '') +
					' data-kind-radio />' +
					App.walletIcon(key) +
					'<span>' + App.escapeHtml(entry.label) + '</span></label>';
			}).join('');
		});
	}

	/** The kind currently chosen in a picker, or the default if none is. */
	function readKind(pickerSelector) {
		var checked = document.querySelector(pickerSelector + ' input:checked');
		return checked ? checked.value : App.WALLET_KINDS.other ? 'other' : 'other';
	}

	/** Preselect a kind when opening the edit form. */
	function setKind(pickerSelector, kind) {
		var host = document.querySelector(pickerSelector);
		if (!host) return;

		var wanted = kind && Object.prototype.hasOwnProperty.call(App.WALLET_KINDS, kind)
			? kind
			: 'other';

		var input = host.querySelector('input[value="' + wanted + '"]') ||
			host.querySelector('input');

		if (input) input.checked = true;
	}

	/* ------------------------------------------------------------- modals */

	window.openAddModal = function () {
		document.getElementById('addForm').reset();
		document.getElementById('walletFrozen').value = 0;
		// reset() clears a checked radio back to the markup default, which is the
		// first kind. Left alone it would silently reopen as a bank account.
		setKind('[data-kind-picker]', 'other');
		App.openModal('addModal');
	};

	window.closeAddModal = function () {
		App.closeModal('addModal');
	};

	window.openEditModal = function (id, name, balance, frozen, kindLabel) {
		// The card passes the label because it is what is on screen; the picker
		// needs the stored key. Matching on the label keeps the inline handler
		// readable instead of embedding a lookup table in an onclick attribute.
		var kind = Object.keys(App.WALLET_KINDS).filter(function (key) {
			return App.WALLET_KINDS[key].label === kindLabel;
		})[0] || 'other';

		selectedWalletId = id;
		document.getElementById('editWalletName').value = name;
		document.getElementById('editWalletBalance').value = balance;
		document.getElementById('editWalletFrozen').value = frozen;
		setKind('#editModal [data-kind-picker]', kind);
		App.openModal('editModal');
	};

	window.closeEditModal = function () {
		App.closeModal('editModal');
		selectedWalletId = null;
	};

	window.openDeleteModal = function (id) {
		var wallet = wallets.find(function (w) { return w.id === id; });
		selectedWalletId = id;
		document.getElementById('deleteWalletName').textContent = wallet
			? 'Dompet "' + wallet.name + '" akan dihapus. Tindakan ini tidak bisa dibatalkan.'
			: 'Tindakan ini tidak bisa dibatalkan.';
		App.openModal('deleteModal');
	};

	window.closeDeleteModal = function () {
		App.closeModal('deleteModal');
		selectedWalletId = null;
	};

	window.openTransferModal = function () {
		if (wallets.length < 2) {
			App.toast('Transfer butuh minimal dua dompet.', 'error');
			return;
		}
		document.getElementById('transferAmount').value = '';
		App.openModal('transferModal');
	};

	window.closeTransferModal = function () {
		App.closeModal('transferModal');
	};

	/* ------------------------------------------------------------- actions */

	function withBusy(button, work) {
		button.disabled = true;
		return work().finally(function () {
			button.disabled = false;
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		// Before anything else: the pickers are markup the forms submit, so they
		// have to exist before a form can be opened.
		buildKindPickers();

		App.api('/api/auth/me')
			.then(function (data) {
				document.getElementById('currentUser').textContent = data.user.username;
			})
			.catch(function () { /* App.api handles the redirect. */ });

		load();

		document.getElementById('addForm').addEventListener('submit', function (event) {
			event.preventDefault();
			var form = event.target;
			withBusy(form.querySelector('button[type=submit]'), function () {
				return App.api(API, {
					method: 'POST',
					body: {
						name: document.getElementById('walletName').value,
						balance: Number(document.getElementById('walletBalance').value),
						frozen: Number(document.getElementById('walletFrozen').value || 0),
						kind: readKind('#addModal [data-kind-picker]')
					}
				}).then(function () {
					App.closeModal('addModal');
					App.toast('Dompet ditambahkan.', 'success');
					return load();
				}).catch(function (error) {
					App.toast(error.message, 'error');
				});
			});
		});

		document.getElementById('editForm').addEventListener('submit', function (event) {
			event.preventDefault();
			var form = event.target;
			withBusy(form.querySelector('button[type=submit]'), function () {
				return App.api(API + '/' + encodeURIComponent(selectedWalletId), {
					method: 'PUT',
					body: {
						name: document.getElementById('editWalletName').value,
						balance: Number(document.getElementById('editWalletBalance').value),
						frozen: Number(document.getElementById('editWalletFrozen').value),
						kind: readKind('#editModal [data-kind-picker]')
					}
				}).then(function () {
					App.closeModal('editModal');
					App.toast('Dompet diperbarui.', 'success');
					return load();
				}).catch(function (error) {
					App.toast(error.message, 'error');
				});
			});
		});

		document.getElementById('transferForm').addEventListener('submit', function (event) {
			event.preventDefault();
			var form = event.target;
			withBusy(form.querySelector('button[type=submit]'), function () {
				return App.api(API + '/transfer', {
					method: 'POST',
					body: {
						fromWalletId: document.getElementById('fromWallet').value,
						toWalletId: document.getElementById('toWallet').value,
						amount: Number(document.getElementById('transferAmount').value)
					}
				}).then(function () {
					App.closeModal('transferModal');
					App.toast('Transfer berhasil.', 'success');
					return load();
				}).catch(function (error) {
					App.toast(error.message, 'error');
				});
			});
		});

		window.confirmDeleteWallet = function () {
			return App.api(API + '/' + encodeURIComponent(selectedWalletId), { method: 'DELETE' })
				.then(function () {
					App.closeModal('deleteModal');
					App.toast('Dompet dihapus.', 'success');
					return load();
				})
				.catch(function (error) {
					App.toast(error.message, 'error');
				});
		};
	});
})();