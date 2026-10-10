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

	function renderWallets() {
		var host = document.getElementById('walletList');

		if (wallets.length === 0) {
			host.innerHTML = '<div class="card"><div class="card__body">' +
				'<div class="empty"><div class="empty__title">Belum ada dompet</div>' +
				'<p>Tambahkan dompet pertama Anda untuk mulai mencatat transaksi.</p>' +
				'</div></div></div>';
			return;
		}

		host.innerHTML = wallets.map(function (wallet) {
			var usable = (Number(wallet.balance) || 0) - (Number(wallet.frozen) || 0);
			var name = App.escapeHtml(wallet.name);

			return '<div class="card"><div class="card__body">' +
				'<div style="display:flex;align-items:flex-start;gap:8px">' +
				'<h2 style="font-size:16px;margin-right:auto;min-width:0;overflow-wrap:anywhere">' + name + '</h2>' +
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
				'<div class="stats" style="margin-top:14px;grid-template-columns:repeat(3,minmax(0,1fr))">' +
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
		return App.api(API)
			.then(function (data) {
				wallets = data || [];
				renderSummary();
				renderWallets();
				populateDropdowns();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	}

	/* ------------------------------------------------------------- modals */

	window.openAddModal = function () {
		document.getElementById('addForm').reset();
		document.getElementById('walletFrozen').value = 0;
		App.openModal('addModal');
	};

	window.closeAddModal = function () {
		App.closeModal('addModal');
	};

	window.openEditModal = function (id, name, balance, frozen) {
		selectedWalletId = id;
		document.getElementById('editWalletName').value = name;
		document.getElementById('editWalletBalance').value = balance;
		document.getElementById('editWalletFrozen').value = frozen;
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
						frozen: Number(document.getElementById('walletFrozen').value || 0)
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
						frozen: Number(document.getElementById('editWalletFrozen').value)
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