/**
 * Aturan (recurring transactions) page.
 *
 * A rule is a template, not a record. Nothing is written until "Jalankan yang jatuh
 * tempo" is pressed, and the preview on each card shows what the next run would
 * create, so a schedule is never a surprise.
 */

(function () {
	'use strict';

	var API = '/api/recurring';
	var today = new Date().toISOString().slice(0, 10);

	var rules = [];
	var wallets = [];
	var categories = [];
	var subcategories = [];
	var selectedType = 'expense';
	var editingId = null;
	var deletingId = null;

	function setText(id, value) {
		var el = document.getElementById(id);
		if (el) el.textContent = value;
	}

	/* --------------------------------------------------------------- render */

	function renderSummary() {
		var host = document.getElementById('ruleSummary');
		if (!host) return;

		var active = rules.filter(function (rule) { return rule.active; });
		var monthly = active.reduce(function (sum, rule) {
			if (rule.type !== 'income' && rule.type !== 'expense') return sum;

			var amount = Number(rule.amount) || 0;
			var interval = Math.max(1, Number(rule.interval) || 1);

			// Normalise every schedule to a monthly figure so the totals compare.
			var perMonth;
			if (rule.frequency === 'yearly') perMonth = amount / 12;
			else if (rule.frequency === 'monthly') perMonth = amount / interval;
			else if (rule.frequency === 'biweekly') perMonth = amount * 2 / interval;
			else perMonth = amount * 4.345 / interval; // weekly

			return rule.type === 'income' ? sum + perMonth : sum - perMonth;
		}, 0);

		host.innerHTML =
			stat('Aturan aktif', String(active.length), '') +
			stat('Pengeluaran per bulan', App.formatRupiah(Math.abs(Math.min(0, monthly))),
				monthly < 0 ? 'stat--negative' : '') +
			stat('Pemasukan per bulan', App.formatRupiah(Math.max(0, monthly)),
				monthly > 0 ? 'stat--positive' : '') +
			stat('Selisih', App.formatRupiah(monthly),
				monthly >= 0 ? 'stat--positive' : 'stat--negative');
	}

	function stat(label, value, extra) {
		return '<div class="stat ' + (extra || '') + '">' +
			'<div class="stat__label">' + label + '</div>' +
			'<div class="stat__value">' + value + '</div>' +
			'</div>';
	}

	function frequencyLabel(rule) {
		var base = {
			daily: 'Harian',
			weekly: 'Mingguan',
			biweekly: 'Dua mingguan',
			monthly: 'Bulanan',
			yearly: 'Tahunan'
		}[rule.frequency] || rule.frequency;

		var interval = Math.max(1, Number(rule.interval) || 1);
		if (interval > 1) base += ' setiap ' + interval;
		if ((rule.frequency === 'monthly' || rule.frequency === 'yearly') && rule.dayOfMonth) {
			base += ' tanggal ' + rule.dayOfMonth;
		}
		return base;
	}

	function scheduleLabel(rule) {
		var parts = [];
		if (rule.category) parts.push(rule.category);
		if (rule.subcategory) parts.push(rule.subcategory);
		return parts.length ? parts.join(' / ') : 'tanpa kategori';
	}

	function renderRules() {
		var host = document.getElementById('ruleList');
		if (!host) return;

		if (rules.length === 0) {
			host.innerHTML = '<div class="card"><div class="card__body">' +
				'<div class="empty"><div class="empty__title">Belum ada aturan</div>' +
				'<p>Buat aturan untuk gaji, listrik, atau sewa. Aturan hanya menghasilkan transaksi ' +
				'ketika Anda menekan tombol jalankan, jadi tidak ada transaksi mengejutkan.</p>' +
				'</div></div></div>';
			return;
		}

		host.innerHTML = rules.map(function (rule) {
			var walletName = walletNameOf(rule.walletId);
			var tone = rule.type === 'income' ? 'stat--positive' : 'stat--negative';
			var status = rule.active
				? '<span class="badge">aktif</span>'
				: '<span class="badge badge--muted">nonaktif</span>';

			var lastRun = rule.lastRunDate
				? 'terakhir ' + App.formatDate(rule.lastRunDate)
				: 'belum pernah jalan';

			var preview = '';
			if (rule.previewDates && rule.previewDates.length) {
				preview = rule.previewDates.slice(0, 3).map(function (date) {
					return App.formatDate(date);
				}).join(', ') +
					(rule.previewDates.length > 3 ? ' (+' + (rule.previewDates.length - 3) + ')' : '');
			} else {
				preview = 'tidak ada yang jatuh tempo';
			}

			return '<div class="card rule-card' + (rule.active ? '' : ' rule-card--paused') + '">' +
				'<div class="card__body">' +
				'<div class="rule-card__head">' +
				'<div>' +
				'<h3 class="rule-card__title">' + App.escapeHtml(rule.name) + '</h3>' +
				'<p class="rule-card__meta">' + frequencyLabel(rule) + ' · ' +
				App.escapeHtml(scheduleLabel(rule)) + '</p>' +
				'</div>' +
				'<div class="stat ' + tone + ' rule-card__amount">' +
				'<div class="stat__value">' +
				(rule.type === 'income' ? '+' : '-') + App.formatRupiah(rule.amount) +
				'</div></div>' +
				'</div>' +

				'<dl class="detail">' +
				'<dt>Dompet</dt><dd>' + App.escapeHtml(walletName) + '</dd>' +
				'<dt>Status</dt><dd>' + status + '</dd>' +
				'<dt>Riwayat</dt><dd class="text-muted">' + App.escapeHtml(lastRun) + '</dd>' +
				'<dt>Berikutnya</dt><dd class="text-muted">' + App.escapeHtml(preview) + '</dd>' +
				'</dl>' +

				'<div class="rule-card__actions">' +
				'<button class="btn btn--secondary" type="button" onclick="previewRule(\'' +
				rule.id + '\')">Lihat jadwal</button>' +
				'<button class="btn btn--ghost" type="button" onclick="toggleRule(\'' +
				rule.id + '\')">' + (rule.active ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
				'<button class="btn btn--ghost" type="button" onclick="openEditRuleModal(\'' +
				rule.id + '\')">Ubah</button>' +
				'<button class="btn btn--danger-ghost" type="button" onclick="askDeleteRule(\'' +
				rule.id + '\')">Hapus</button>' +
				'</div>' +
				'</div></div>';
		}).join('');
	}

	function walletNameOf(id) {
		for (var i = 0; i < wallets.length; i++) {
			if (wallets[i].id === id) return wallets[i].name;
		}
		return '-';
	}

	/* ----------------------------------------------------------------- load */

	function loadWallets() {
		return App.api('/api/wallets').then(function (data) {
			wallets = data || [];
			var select = document.getElementById('ruleWallet');
			if (select) {
				select.innerHTML = wallets.map(function (wallet) {
					return '<option value="' + App.escapeHtml(wallet.id) + '">' +
						App.escapeHtml(wallet.name) + ' (' + App.formatRupiahShort(wallet.balance) +
						')</option>';
				}).join('');
			}
		});
	}

	function loadRules() {
		return App.api(API)
			.then(function (data) {
				rules = data || [];
				// Fetch each preview so the "next run" line is never a guess.
				return Promise.all(rules.map(function (rule) {
					return App.api(API + '/' + encodeURIComponent(rule.id) + '/preview?throughDate=' +
						encodeURIComponent(horizon()))
						.then(function (data) {
							rule.previewDates = data.dates || [];
						})
						.catch(function () {
							rule.previewDates = [];
						});
			}));
			})
			.then(function () {
				renderSummary();
				renderRules();
			});
	}

	/** Six months out: enough to show a rhythm without listing a hundred dates. */
	function horizon() {
		var date = new Date();
		date.setMonth(date.getMonth() + 6);
		return date.toISOString().slice(0, 10);
	}

	function loadCategories() {
		var through = document.getElementById('throughDate');
		var month = (through && through.value ? through.value : today).slice(0, 7);

		return App.api('/api/budgeting/' + encodeURIComponent(currentUserId) + '/' + month)
			.then(function (budget) {
				categories = [];
				subcategories = [];
				((budget.categories || [])).forEach(function (category) {
					categories.push(category.name);
					(category.subcategories || []).forEach(function (sub) {
						subcategories.push(sub.name);
					});
				});
				applyCategoryOptions();
			})
			.catch(function () {
				// No budget for this month is normal; the fields stay optional.
				categories = [];
				subcategories = [];
				applyCategoryOptions();
			});
	}

	function applyCategoryOptions() {
		var categoryList = document.getElementById('categoryOptions');
		var subcategoryList = document.getElementById('subcategoryOptions');
		if (categoryList) {
			categoryList.innerHTML = categories.map(function (name) {
				return '<option value="' + App.escapeHtml(name) + '"></option>';
			}).join('');
		}
		if (subcategoryList) {
			subcategoryList.innerHTML = subcategories.map(function (name) {
				return '<option value="' + App.escapeHtml(name) + '"></option>';
			}).join('');
		}
	}

	function refresh() {
		return Promise.all([loadWallets(), loadRules()]).then(loadCategories);
	}

	/* --------------------------------------------------------------- modals */

	window.openAddRuleModal = function () {
		editingId = null;
		document.getElementById('ruleForm').reset();
		selectedType = 'expense';
		updateTypeButtons();
		document.getElementById('ruleInterval').value = '1';
		document.getElementById('ruleStartDate').value = today;
		document.getElementById('ruleDayOfMonth').value = String(Number(today.slice(8, 10)));
		document.getElementById('ruleModalTitle').textContent = 'Tambah aturan';
		document.getElementById('ruleSubmitButton').textContent = 'Simpan';
		clearFormError();
		App.openModal('ruleModal');
	};

	window.openEditRuleModal = function (id) {
		var rule = null;
		for (var i = 0; i < rules.length; i++) {
			if (rules[i].id === id) rule = rules[i];
		}
		if (!rule) return;

		editingId = id;
		selectedType = rule.type;
		updateTypeButtons();

		document.getElementById('ruleModalTitle').textContent = 'Ubah aturan';
		document.getElementById('ruleSubmitButton').textContent = 'Perbarui';
		document.getElementById('ruleName').value = rule.name || '';
		document.getElementById('ruleAmount').value = rule.amount;
		document.getElementById('ruleWallet').value = rule.walletId;
		document.getElementById('ruleFrequency').value = rule.frequency;
		document.getElementById('ruleInterval').value = rule.interval || 1;
		document.getElementById('ruleStartDate').value = rule.startDate;
		document.getElementById('ruleDayOfMonth').value = rule.dayOfMonth || '';
		document.getElementById('ruleCategory').value = rule.category || '';
		document.getElementById('ruleSubcategory').value = rule.subcategory || '';
		document.getElementById('ruleOccurrences').value = rule.occurrences || '';
		clearFormError();
		App.openModal('ruleModal');
	};

	window.closeRuleModal = function () {
		App.closeModal('ruleModal');
		editingId = null;
	};

	window.askDeleteRule = function (id) {
		deletingId = id;
		var rule = null;
		for (var i = 0; i < rules.length; i++) {
			if (rules[i].id === id) rule = rules[i];
		}
		document.getElementById('deleteRuleDescription').textContent = rule
			? 'Aturan "' + rule.name + '" akan dihapus. Transaksi yang sudah pernah dibuat tetap tersimpan.'
			: 'Aturan akan dihapus.';
		App.openModal('deleteRuleModal');
	};

	window.closeDeleteRuleModal = function () {
		App.closeModal('deleteRuleModal');
		deletingId = null;
	};

	window.confirmDeleteRule = function () {
		if (!deletingId) return Promise.resolve();
		return App.api(API + '/' + encodeURIComponent(deletingId), { method: 'DELETE' })
			.then(function () {
				App.closeModal('deleteRuleModal');
				App.toast('Aturan dihapus.', 'success');
				deletingId = null;
				return loadRules();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	};

	window.toggleRule = function (id) {
		var rule = null;
		for (var i = 0; i < rules.length; i++) {
			if (rules[i].id === id) rule = rules[i];
		}
		if (!rule) return Promise.resolve();

		return App.api(API + '/' + encodeURIComponent(id), { method: 'PUT', body: { active: !rule.active } })
			.then(function () {
				App.toast(rule.active ? 'Aturan dinonaktifkan.' : 'Aturan diaktifkan.', 'success');
				return loadRules();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	};

	window.previewRule = function (id) {
		return App.api(API + '/' + encodeURIComponent(id) + '/preview?throughDate=' +
			encodeURIComponent(horizon()))
			.then(function (data) {
				var dates = data.dates || [];
				if (dates.length === 0) {
					App.toast('Tidak ada jadwal yang jatuh tempo dalam 6 bulan ke depan.', 'info');
					return;
				}
				App.toast(dates.length + ' jadwal: ' +
					dates.slice(0, 5).map(App.formatDate).join(', ') +
					(dates.length > 5 ? ' (+' + (dates.length - 5) + ' lagi)' : ''), 'info');
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	};

	/* ----------------------------------------------------------------- run */

	window.runDueRules = function () {
		var button = document.getElementById('runRulesButton');
		var through = document.getElementById('throughDate');
		var body = { throughDate: through && through.value ? through.value : today };

		if (button.disabled) return Promise.resolve();
		button.disabled = true;
		button.textContent = 'Memproses...';

		return App.api(API + '/run', { method: 'POST', body: body })
			.then(function (result) {
				var created = (result.created || []).length;
				var failed = (result.failed || []).length;

				if (created === 0 && failed === 0) {
					App.toast('Tidak ada aturan yang jatuh tempo.', 'info');
				} else if (failed === 0) {
					App.toast(created + ' transaksi dibuat sampai ' + App.formatDate(body.throughDate) + '.', 'success');
				} else {
					App.toast(created + ' dibuat, ' + failed + ' gagal: ' +
						result.failed.map(function (row) {
							return row.ruleName + ' (' + row.reason + ')';
						}).join('; '), 'error');
				}

				return refresh();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			})
			.finally(function () {
				button.disabled = false;
				button.textContent = 'Jalankan yang jatuh tempo';
			});
	};

	/* ---------------------------------------------------------------- form */

	function clearFormError() {
		var box = document.getElementById('ruleFormError');
		if (box) box.hidden = true;
	}

	function updateTypeButtons() {
		document.querySelectorAll('[data-rule-type]').forEach(function (button) {
			button.setAttribute('aria-pressed', String(button.dataset.ruleType === selectedType));
		});
	}

	function collectBody() {
		var occurrences = document.getElementById('ruleOccurrences').value;
		var frequency = document.getElementById('ruleFrequency').value;
		var dayOfMonth = document.getElementById('ruleDayOfMonth').value;

		return {
			name: document.getElementById('ruleName').value.trim(),
			amount: Number(document.getElementById('ruleAmount').value),
			type: selectedType,
			frequency: frequency,
			interval: Number(document.getElementById('ruleInterval').value) || 1,
			startDate: document.getElementById('ruleStartDate').value,
			// Weekly rules step in days, so a day of month would be meaningless.
			dayOfMonth: frequency === 'weekly' || frequency === 'biweekly'
				? null
				: (Number(dayOfMonth) || Number(document.getElementById('ruleStartDate').value.slice(8, 10))),
			walletId: document.getElementById('ruleWallet').value,
			category: document.getElementById('ruleCategory').value.trim(),
			subcategory: document.getElementById('ruleSubcategory').value.trim(),
			occurrences: occurrences ? Number(occurrences) : 0,
			description: document.getElementById('ruleName').value.trim()
		};
	}

	function submitRule() {
		var body = collectBody();

		if (!body.name) {
			showFormError('Nama aturan wajib diisi.');
			return Promise.resolve();
		}
		if (!body.amount || body.amount <= 0) {
			showFormError('Jumlah harus lebih besar dari nol.');
			return Promise.resolve();
		}
		if (!body.walletId) {
			showFormError('Buat dompet dulu sebelum menambah aturan.');
			return Promise.resolve();
		}

		var request = editingId
			? App.api(API + '/' + encodeURIComponent(editingId), { method: 'PUT', body: body })
			: App.api(API, { method: 'POST', body: body });

		return request
			.then(function () {
				App.closeModal('ruleModal');
				App.toast(editingId ? 'Aturan diperbarui.' : 'Aturan dibuat.', 'success');
				editingId = null;
				return refresh();
			})
			.catch(function (error) {
				showFormError(error.message);
			});
	}

	function showFormError(message) {
		var box = document.getElementById('ruleFormError');
		if (box) {
			box.hidden = false;
			box.textContent = message;
		}
		App.toast(message, 'error');
	}

	/* ---------------------------------------------------------------- boot */

	var currentUserId = null;

	document.addEventListener('DOMContentLoaded', function () {
		var through = document.getElementById('throughDate');
		through.value = today;
		through.addEventListener('change', loadCategories);

		document.querySelectorAll('[data-rule-type]').forEach(function (button) {
			button.addEventListener('click', function () {
				selectedType = this.dataset.ruleType;
				clearFormError();
				updateTypeButtons();
			});
		});

		document.getElementById('ruleForm').addEventListener('submit', function (event) {
			event.preventDefault();
			var button = document.getElementById('ruleSubmitButton');
			var original = button.textContent;

			if (button.disabled) return;
			button.disabled = true;
			button.textContent = 'Menyimpan...';

			Promise.resolve(submitRule())
				.catch(function () { /* submitRule already surfaces the message. */ })
				.finally(function () {
					button.disabled = false;
					button.textContent = original;
				});
		});

		App.api('/api/auth/me')
			.then(function (data) {
				currentUserId = data.user.userId;
				document.getElementById('currentUser').textContent = data.user.username;
				return refresh();
			})
			.catch(function () { /* App.api handles the redirect. */ });
	});
})();