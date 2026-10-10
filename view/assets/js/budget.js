/**
 * Budget page.
 *
 * One budget per user per month. The form builds the whole category tree and
 * submits it in one request; the server is idempotent for a given month, so a
 * save replaces the plan rather than stacking duplicates.
 */

(function () {
	'use strict';

	var API = '/api/budgeting';
	var userId = null;
	var currentMonth = null;
	var currentBudgetId = null;
	var draft = [];

	function getCurrentMonth() {
		var now = new Date();
		return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
	}

	function setText(id, value) {
		var node = document.getElementById(id);
		if (node) node.textContent = value;
	}

	/* ------------------------------------------------------------ rendering */

	function fetchUsableMoney() {
		return App.api('/api/analytics/wallets/' + encodeURIComponent(userId))
			.then(function (wallets) {
				var balance = 0;
				var frozen = 0;
				wallets.forEach(function (wallet) {
					balance += Number(wallet.balance) || 0;
					frozen += Number(wallet.frozen) || 0;
				});
				var usable = balance - frozen;
				setText('usableMoney', App.formatRupiah(usable));
				// A rough guardrail: spending more than the whole usable balance
				// in one month is almost always a mistake.
				setText('usableMinBudget', App.formatRupiahShort(usable));
				return usable;
			})
			.catch(function () {
				return 0;
			});
	}

	function fetchBudget() {
		return App.api(API + '/' + encodeURIComponent(userId) + '/' + currentMonth)
			.then(function (budget) {
				currentBudgetId = budget.id;
				displayBudget(budget);
			})
			.catch(function (error) {
				currentBudgetId = null;
				if (error.status === 404) {
					document.getElementById('budgetOutput').innerHTML =
						'<div class="card"><div class="card__body">' +
						'<div class="empty"><div class="empty__title">Belum ada anggaran</div>' +
						'<p>Belum ada anggaran untuk bulan ini.</p></div></div></div>';
					setText('totalBudget', 'Rp0');
					setText('remainingBudget', 'Rp0');
					document.getElementById('saveBudgetButton').hidden = true;
					document.getElementById('deleteBudgetButton').hidden = true;
				} else {
					App.toast(error.message, 'error');
				}
			});
	}

	function displayBudget(budget) {
		var host = document.getElementById('budgetOutput');
		var categories = budget.categories || [];

		if (categories.length === 0) {
			host.innerHTML = '<div class="card"><div class="card__body">' +
				'<div class="empty"><div class="empty__title">Anggaran kosong</div>' +
				'<p>Kategori dan subkategori belum diisi.</p></div></div></div>';
			return;
		}

		var totalBudget = 0;
		var totalUsed = 0;

		var html = categories.map(function (category) {
			var subcategories = category.subcategories || [];
			var categoryTotal = 0;
			var categoryUsed = 0;

			var rows = subcategories.map(function (sub) {
				var amount = Number(sub.amount) || 0;
				var used = Number(sub.used) || 0;
				categoryTotal += amount;
				categoryUsed += used;

				var percentage = amount > 0 ? (used / amount) * 100 : 0;
				var remaining = amount - used;
				var tone = percentage > 100 ? 'negative' : percentage > 80 ? 'warning' : '';

				// Labelled explicitly: "sisa / dari batas" reads unambiguously,
				// where a bare number next to a bar could be read as spent.
				return '<div class="budget-sub">' +
					'<div class="budget-sub__name">' + App.escapeHtml(sub.name) + '</div>' +
					'<div class="budget-sub__figures">' +
					'<span class="' + (remaining < 0 ? 'text-negative' : '') + '">' +
					'<strong>' + App.formatRupiahShort(remaining) + '</strong> sisa' +
					'</span>' +
					'<div class="progress"><div class="progress__fill' +
					(tone ? ' progress__fill--' + tone : '') +
					'" style="width:' + Math.min(100, percentage) + '%"></div></div>' +
					'<span class="text-muted" style="white-space:nowrap">' +
					'dari ' + App.formatRupiahShort(amount) + '</span>' +
					'</div></div>';
			}).join('');

			return '<div class="budget-group">' +
				'<div class="budget-group__head">' +
				'<span class="budget-group__name">' + App.escapeHtml(category.name) + '</span>' +
				'<span class="budget-group__total">' + App.formatRupiahShort(categoryUsed) +
				' / ' + App.formatRupiahShort(categoryTotal) + '</span>' +
				'</div>' + rows + '</div>';
		}).join('');

		categories.forEach(function (category) {
			(category.subcategories || []).forEach(function (sub) {
				totalBudget += Number(sub.amount) || 0;
				totalUsed += Number(sub.used) || 0;
			});
		});

		host.innerHTML = html;

		setText('totalBudget', App.formatRupiah(totalBudget));
		setText('remainingBudget', App.formatRupiah(totalBudget - totalUsed));
		document.getElementById('saveBudgetButton').hidden = false;
		document.getElementById('deleteBudgetButton').hidden = false;
	}

	/* ---------------------------------------------------------------- form */

	function renderDraftForm() {
		document.getElementById('categories').innerHTML = draft.map(function (category, ci) {
			var rows = (category.subcategories || []).map(function (sub, si) {
				return '<div class="cat-row">' +
					'<input class="input" type="text" value="' + App.escapeHtml(sub.name) +
					'" oninput="updateSubName(' + ci + ',' + si + ', this.value)" ' +
					'placeholder="Nama subkategori" aria-label="Nama subkategori" />' +
					'<input class="input" type="number" style="max-width:150px" min="0" step="1" value="' +
					(sub.amount || 0) + '" oninput="updateSubAmount(' + ci + ',' + si +
					', this.value)" placeholder="Batas (Rp)" aria-label="Batas pengeluaran" />' +
					'<button class="icon-btn icon-btn--danger" type="button" onclick="removeSubcategory(' +
					ci + ',' + si + ')" aria-label="Hapus subkategori">&#128465;</button>' +
					'</div>';
			}).join('');

			return '<div class="budget-group" style="margin-bottom:12px">' +
				'<div class="budget-group__head">' +
				'<span class="budget-group__name">' + App.escapeHtml(category.name) + '</span>' +
				'<div class="kind-picker">' +
				'<span class="kind-picker__label">Jenis</span>' +
				'<button class="kind-picker__btn' + (category.kind === 'needs' ? ' is-on' : '') +
				'" type="button" onclick="updateCategoryKind(' + ci +
				', \'needs\')" aria-pressed="' + (category.kind === 'needs') + '">Kebutuhan</button>' +
				'<button class="kind-picker__btn' + (category.kind === 'wants' ? ' is-on' : '') +
				'" type="button" onclick="updateCategoryKind(' + ci +
				', \'wants\')" aria-pressed="' + (category.kind === 'wants') + '">Keinginan</button>' +
				'</div>' +
				'<button class="icon-btn icon-btn--danger" type="button" onclick="removeCategory(' + ci +
				')" aria-label="Hapus kategori">&#128465;</button>' +
				'</div>' +
				'<div style="padding:12px 14px">' +
				(rows || '<p class="text-muted" style="font-size:13px">Belum ada subkategori.</p>') +
				'<button class="btn btn--secondary btn--ghost" type="button" style="margin-top:8px" ' +
				'onclick="addSubcategory(' + ci + ')">+ Subkategori</button>' +
				'</div></div>';
		}).join('');
	}

	window.showBudgetForm = function () {
		// Editing an existing month starts from what is already stored.
		if (currentBudgetId) {
			App.api(API + '/' + encodeURIComponent(userId) + '/' + currentMonth)
				.then(function (budget) {
					draft = (budget.categories || []).map(function (category) {
						return {
							name: category.name,
							subcategories: (category.subcategories || []).map(function (sub) {
								return { name: sub.name, amount: Number(sub.amount) || 0 };
							})
						};
					});
					document.getElementById('budgetMonth').value = currentMonth;
					renderDraftForm();
					App.openModal('budgetModal');
				})
				.catch(function (error) {
					App.toast(error.message, 'error');
				});
			return;
		}

		draft = [];
		document.getElementById('newCategoryName').value = '';
		document.getElementById('budgetMonth').value = currentMonth;
		renderDraftForm();
		App.openModal('budgetModal');
	};

	window.closeModal = function () {
		App.closeModal('budgetModal');
	};

	function clearFormError() {
		var box = document.getElementById('budgetFormError');
		if (box) box.hidden = true;
	}

	window.addCategory = function () {
		clearFormError();
		var input = document.getElementById('newCategoryName');
		var name = input.value.trim();
		if (!name) {
			input.focus();
			return;
		}
		draft.push({ name: name, kind: null, subcategories: [] });
		input.value = '';
		renderDraftForm();
	};

	window.removeCategory = function (index) {
		draft.splice(index, 1);
		renderDraftForm();
	};

	/**
	 * Label a category as a need or a want. Clicking the active label again
	 * clears it, because an unlabelled category is a valid and honest state and
	 * the insights page treats it as "not classified" rather than guessing.
	 */
	window.updateCategoryKind = function (index, kind) {
		clearFormError();
		var category = draft[index];
		if (!category) return;

		if (category.kind === kind) {
			category.kind = null;
		} else {
			category.kind = kind;
		}

		renderDraftForm();
	};

	window.addSubcategory = function (categoryIndex) {
		clearFormError();
		// Adds an empty row to type into rather than using a browser prompt,
		// which would look and behave inconsistently with the rest of the form.
		draft[categoryIndex].subcategories.push({ name: '', amount: 0 });
		renderDraftForm();
		var inputs = document.querySelectorAll('#categories .cat-row input[type=text]');
		if (inputs.length > 0) inputs[inputs.length - 1].focus();
	};

	window.removeSubcategory = function (categoryIndex, subIndex) {
		draft[categoryIndex].subcategories.splice(subIndex, 1);
		renderDraftForm();
	};

	window.updateSubName = function (ci, si, value) {
		draft[ci].subcategories[si].name = value;
	};

	window.updateSubAmount = function (ci, si, value) {
		draft[ci].subcategories[si].amount = Number(value) || 0;
	};

	function submitBudget() {
		var month = document.getElementById('budgetMonth').value;
		if (!month) {
			App.toast('Pilih bulan terlebih dahulu.', 'error');
			return null;
		}

		// Drop empty subcategory names, then drop categories left with none.
		var categories = draft.map(function (category) {
			return {
				name: category.name,
				subcategories: category.subcategories
					.filter(function (sub) { return String(sub.name).trim(); })
					.map(function (sub) {
						return { name: sub.name.trim(), amount: Number(sub.amount) || 0 };
					})
			};
		}).filter(function (category) {
			return category.subcategories.length > 0;
		});

		if (categories.length === 0) {
			// The toast disappears in a second and the form looks untouched, so the
			// reason is also written next to the fields.
			document.getElementById('budgetFormError').hidden = false;
			document.getElementById('budgetFormError').textContent =
				'Setiap kategori harus punya minimal satu subkategori. ' +
				'Periksa juga kolom jumlah, boleh 0.';
			App.toast('Tambahkan minimal satu kategori dengan subkategori.', 'error');
			return null;
		}
		document.getElementById('budgetFormError').hidden = true;

		return App.api(API, { method: 'POST', body: { month: month, categories: categories } })
			.then(function () {
				App.closeModal('budgetModal');
				App.toast('Anggaran disimpan.', 'success');
				currentMonth = month;
				document.getElementById('month').value = month;
				return refresh();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	}

	/* --------------------------------------------------------------- delete */

	window.showDeleteConfirmation = function () {
		if (!currentBudgetId) return;
		document.getElementById('confirmMessage').textContent =
			'Anggaran bulan ini akan dihapus. Riwayat transaksi tidak terpengaruh.';
		App.openModal('confirmModal');
	};

	window.closeConfirmModal = function () {
		App.closeModal('confirmModal');
	};

	window.confirmDelete = function () {
		if (!currentBudgetId) return Promise.resolve();
		return App.api(API + '/' + encodeURIComponent(currentBudgetId), { method: 'DELETE' })
			.then(function () {
				App.closeModal('confirmModal');
				App.toast('Anggaran dihapus.', 'success');
				currentBudgetId = null;
				document.getElementById('saveBudgetButton').hidden = true;
				document.getElementById('deleteBudgetButton').hidden = true;
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
				'<option value="">Batal</option>';
			dropdown.focus();
			return;
		}

		var format = dropdown.value;
		dropdown.style.display = 'none';
		if (!format) return;

		window.location.href = '/export/budget/' + encodeURIComponent(userId) + '/' +
			currentMonth + '/' + format;
	};

	function refresh() {
		return Promise.all([fetchUsableMoney(), fetchBudget()]);
	}

	/* ----------------------------------------------------------------- boot */

	document.addEventListener('DOMContentLoaded', function () {
		document.getElementById('month').value = getCurrentMonth();
		currentMonth = document.getElementById('month').value;

		document.getElementById('month').addEventListener('change', function () {
			currentMonth = this.value;
			refresh();
		});

		document.getElementById('saveBudgetButton').addEventListener('click', function () {
			showBudgetForm();
		});

		document.getElementById('budgetForm').addEventListener('submit', function (event) {
			event.preventDefault();
			var button = event.target.querySelector('button[type=submit]');
			var original = button.textContent;

			// Guard against a second click while the first request is still running.
			// submitBudget() can return null on a validation failure, so the reset has
			// to happen in finally rather than in the success path only.
			if (button.disabled) return;
			button.disabled = true;
			button.textContent = 'Menyimpan...';

			Promise.resolve(submitBudget())
				.catch(function () { /* submitBudget already toasts. */ })
				.finally(function () {
					button.disabled = false;
					button.textContent = original;
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