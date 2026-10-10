/**
 * Transactions page.
 *
 * Lists one month of transactions grouped by date, with inline totals and
 * create/edit/delete. Category and subcategory suggestions come from the budget
 * for the same month, so a typo creates a new budget row rather than silently
 * splitting an existing one.
 */

(function () {
	'use strict';

	var API = '/api/transactions';
	var userId = null;
	var currentMonth = null;
	var editingId = null;
	var deletingId = null;
	var selectedType = 'expense';
	var wallets = [];
	var categories = [];
	var subcategories = [];

	function getCurrentMonth() {
		var now = new Date();
		return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
	}

	function setText(id, value) {
		var node = document.getElementById(id);
		if (node) node.textContent = value;
	}

	/* ------------------------------------------------------------ rendering */

	function renderTotals(transactions) {
		var income = 0;
		var expense = 0;

		transactions.forEach(function (transaction) {
			if (transaction.type === 'income') income += Number(transaction.amount) || 0;
			else expense += Number(transaction.amount) || 0;
		});

		setText('totalIncome', App.formatRupiah(income));
		setText('totalExpense', App.formatRupiah(expense));
		setText('transactionCount', String(transactions.length));

		var net = income - expense;
		var node = document.getElementById('netAmount');
		setText('netAmount', App.formatRupiah(net));
		node.className = 'stat__value ' + (net >= 0 ? 'text-positive' : 'text-negative');
	}

	function render(transactions) {
		var body = document.getElementById('transactionList');

		if (transactions.length === 0) {
			body.innerHTML = '<tr><td colspan="5">' +
				'<div class="empty"><div class="empty__title">Belum ada transaksi</div>' +
				'<p>Belum ada transaksi pada bulan ini.</p></div></td></tr>';
			return;
		}

		// Group by date so the list reads like a statement.
		var groups = {};
		var order = [];
		transactions.forEach(function (transaction) {
			if (!groups[transaction.date]) {
				groups[transaction.date] = [];
				order.push(transaction.date);
			}
			groups[transaction.date].push(transaction);
		});
		order.sort(function (a, b) { return b.localeCompare(a); });

		var html = '';
		order.forEach(function (date) {
			html += '<tr class="group-head"><td colspan="5">' +
				App.escapeHtml(App.formatDate(date)) + '</td></tr>';

			groups[date].forEach(function (transaction) {
				var isIncome = transaction.type === 'income';
				var category = [transaction.category, transaction.subcategory]
					.filter(Boolean).join(' / ') || '-';

				html += '<tr>' +
					'<td>' + App.escapeHtml(App.formatDate(transaction.date)) + '</td>' +
					'<td>' + App.escapeHtml(category) + '</td>' +
					'<td>' + App.escapeHtml(transaction.description || '-') + '</td>' +
					'<td class="table__num trx-amount--' + (isIncome ? 'income' : 'expense') + '">' +
					(isIncome ? '+' : '-') + App.formatRupiah(transaction.amount) + '</td>' +
					'<td><div class="table__actions">' +
					'<button class="icon-btn" type="button" onclick="editTransaction(' +
					JSON.stringify(transaction.id).replace(/"/g, '&quot;') +
					')" aria-label="Edit transaksi" title="Edit">&#9998;</button>' +
					'<button class="icon-btn icon-btn--danger" type="button" onclick="askDelete(' +
					JSON.stringify(transaction.id).replace(/"/g, '&quot;') + ')' +
					' aria-label="Hapus transaksi" title="Hapus">&#128465;</button>' +
					'</div></td></tr>';
			});
		});

		body.innerHTML = html;
	}

	/* -------------------------------------------------------------- loading */

	function loadWallets() {
		return App.api('/api/wallets').then(function (data) {
			wallets = data || [];
			var select = document.getElementById('walletId');
			var previous = select.value;
			select.innerHTML = wallets.map(function (wallet) {
				return '<option value="' + App.escapeHtml(wallet.id) + '">' +
					App.escapeHtml(wallet.name) + ' (' + App.formatRupiahShort(wallet.balance) + ')</option>';
			}).join('');
			if (previous) select.value = previous;
		});
	}

	/**
	 * Suggests categories from this month's budget. A 404 simply means no
	 * budget has been set, which is fine: the fields stay free text.
	 */
	// Categories come from the budget for the selected month, so a brand new account
	// has none yet. That used to leave the required category select empty and the
	// form silently refused to submit, with nothing explaining why. A transaction is
	// still a valid record without a category, so the field stays optional and the
	// hint points at the budget page instead.
	function loadCategories() {
		return App.api('/api/budgeting/' + encodeURIComponent(userId) + '/' + currentMonth)
			.then(function (budget) {
				categories = [];
				subcategories = [];

				(budget.categories || []).forEach(function (category) {
					categories.push(category.name);
					(category.subcategories || []).forEach(function (sub) {
						subcategories.push(sub.name);
					});
				});

				applyCategoryOptions();
			})
			.catch(function () {
				// 404 simply means "no budget for this month", which is normal.
				categories = [];
				subcategories = [];
				applyCategoryOptions();
			});
	}

	function applyCategoryOptions() {
		// The controls are <input list="..."> backed by a <datalist>, so the options
		// belong on the datalist element. Writing <option> into the input itself is
		// silently ignored, which is why the suggestions never appeared.
		document.getElementById('categoryOptions').innerHTML = categories.map(function (name) {
			return '<option value="' + App.escapeHtml(name) + '"></option>';
		}).join('');

		document.getElementById('subcategoryOptions').innerHTML = subcategories.map(function (name) {
			return '<option value="' + App.escapeHtml(name) + '"></option>';
		}).join('');

		var hint = document.getElementById('categoryHint');
		if (hint) {
			hint.hidden = categories.length > 0;
			hint.innerHTML = categories.length === 0
				? 'Kategori diambil dari anggaran bulan ini. ' +
				  '<a href="/budget">Buat anggaran</a> dulu, atau biarkan kosong.'
				: '';
		}
	}

	function loadTransactions() {
		return App.api(API + '/' + encodeURIComponent(userId) + '/' + currentMonth)
			.then(function (transactions) {
				renderTotals(transactions);
				render(transactions);
			})
			.catch(function (error) {
				document.getElementById('transactionList').innerHTML =
					'<tr><td colspan="5" class="text-muted">' +
					App.escapeHtml(error.message) + '</td></tr>';
			});
	}

	function refresh() {
		return Promise.all([loadWallets(), loadCategories(), loadTransactions()]);
	}

	/* --------------------------------------------------------------- modals */

	function resetForm() {
		document.getElementById('transactionForm').reset();
		selectedType = 'expense';
		editingId = null;
		updateTypeButtons();
		// Default the date to today so the common case needs no typing.
		var now = new Date();
		document.getElementById('date').value =
			now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') +
			'-' + String(now.getDate()).padStart(2, '0');
	}

	function updateTypeButtons() {
		document.querySelectorAll('.type-toggle__btn').forEach(function (button) {
			button.setAttribute('aria-pressed', String(button.dataset.type === selectedType));
		});
	}

	window.openModal = function () {
		resetForm();
		document.getElementById('transactionModalTitle').textContent = 'Tambah transaksi';
		document.getElementById('transactionModalDesc').textContent =
			'Saldo dompet diperbarui otomatis.';
		document.getElementById('submitButton').textContent = 'Simpan';
		App.openModal('transactionModal');
	};

	window.closeModal = function () {
		App.closeModal('transactionModal');
		editingId = null;
	};

	window.editTransaction = function (id) {
		App.api(API + '/detail/' + encodeURIComponent(id)).then(function (transaction) {
			editingId = transaction.id;
			selectedType = transaction.type;
			updateTypeButtons();

			document.getElementById('transactionModalTitle').textContent = 'Edit transaksi';
			document.getElementById('transactionModalDesc').textContent =
				'Dompet asal dikembalikan, lalu dompet baru dipotong. Semua perubahan dijalankan dalam satu transaksi.';
			document.getElementById('submitButton').textContent = 'Perbarui';
			document.getElementById('date').value = transaction.date;
			document.getElementById('amount').value = transaction.amount;
			document.getElementById('walletId').value = transaction.walletId;
			document.getElementById('category').value = transaction.category || '';
			document.getElementById('subcategory').value = transaction.subcategory || '';
			document.getElementById('description').value = transaction.description || '';
			App.openModal('transactionModal');
		}).catch(function (error) {
			App.toast(error.message, 'error');
		});
	};

	window.askDelete = function (id) {
		deletingId = id;
		document.getElementById('deleteDescription').textContent =
			'Transaksi ini akan dihapus dan saldo dompet dikembalikan. Tindakan ini tidak bisa dibatalkan.';
		App.openModal('deleteModal');
	};

	window.closeDeleteModal = function () {
		App.closeModal('deleteModal');
		deletingId = null;
	};

	window.confirmDelete = function () {
		return App.api(API + '/' + encodeURIComponent(deletingId), { method: 'DELETE' })
			.then(function () {
				App.closeModal('deleteModal');
				App.toast('Transaksi dihapus.', 'success');
				return refresh();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	};

	/* --------------------------------------------------------------- export */

	window.exportData = function () {
		var dropdown = document.getElementById('exportDropdown');
		if (dropdown.style.display === 'none') {
			dropdown.style.display = '';
			dropdown.innerHTML = '<option value="json">JSON</option>' +
				'<option value="csv">CSV</option>' +
				'<option value="xlsx">Excel</option>' +
				'<option value="">Batal</option>';
			dropdown.focus();
			return;
		}

		var format = dropdown.value;
		dropdown.style.display = 'none';
		if (!format) return;

		window.location.href = '/export/' + encodeURIComponent(userId) + '/' + currentMonth + '/' + format;
	};

	/* ----------------------------------------------------------------- boot */

	document.addEventListener('DOMContentLoaded', function () {
		document.getElementById('month').value = getCurrentMonth();
		currentMonth = document.getElementById('month').value;

		document.getElementById('month').addEventListener('change', function () {
			currentMonth = this.value;
			refresh();
		});

		document.querySelectorAll('.type-toggle__btn').forEach(function (button) {
			button.addEventListener('click', function () {
				selectedType = this.dataset.type;
				updateTypeButtons();
			});
		});

		document.getElementById('transactionForm').addEventListener('submit', function (event) {
			event.preventDefault();
			var button = document.getElementById('submitButton');
			button.disabled = true;

			var body = {
				date: document.getElementById('date').value,
				amount: Number(document.getElementById('amount').value),
				type: selectedType,
				walletId: document.getElementById('walletId').value,
				category: document.getElementById('category').value,
				subcategory: document.getElementById('subcategory').value,
				description: document.getElementById('description').value
			};

			var request = editingId
				? App.api(API + '/' + encodeURIComponent(editingId), { method: 'PUT', body: body })
				: App.api(API, { method: 'POST', body: body });

			request
				.then(function () {
					App.closeModal('transactionModal');
					App.toast(editingId ? 'Transaksi diperbarui.' : 'Transaksi ditambahkan.', 'success');
					return refresh();
				})
				.catch(function (error) {
					App.toast(error.message, 'error');
				})
				.finally(function () {
					button.disabled = false;
				});
		});

		App.api('/api/auth/me')
			.then(function (data) {
				userId = data.user.userId;
				document.getElementById('currentUser').textContent = data.user.username;
				return refresh();
			})
			.catch(function () { /* App.api handles the redirect. */ });
	});
})();