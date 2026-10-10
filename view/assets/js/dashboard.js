/**
 * Dashboard page.
 *
 * Seven derived metrics, three charts and two tables, all scoped to the signed-in
 * user. The user id is fetched once from /api/auth/me and then used only to build
 * the analytics paths that require it in the URL.
 *
 * Charts are Chart.js, vendored locally so the dashboard still renders on a
 * device that has no internet access.
 */

(function () {
	'use strict';

	var userId = null;
	var currentMonth = null;
	var charts = {};

	// One palette, reused by all three charts, so the dashboard reads as a
	// single system rather than three separate widgets.
	var INCOME = '#047857';
	var EXPENSE = '#b91c1c';
	var TREND_INCOME = 'rgba(5, 150, 105, 0.75)';
	var TREND_EXPENSE = 'rgba(220, 38, 38, 0.7)';
	var SAVINGS = '#0d9488';
	var CATEGORY_COLORS = [
		'#2563eb', '#7c3aed', '#0891b2', '#c026d3',
		'#ea580c', '#65a30d', '#db2777', '#475569'
	];

	/* ------------------------------------------------------------ helpers */

	function getCurrentMonth() {
		var now = new Date();
		return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
	}

	function getLastMonth(month) {
		var parts = month.split('-');
		var date = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
		date.setMonth(date.getMonth() - 1);
		return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
	}

	function getDaysInMonth(month) {
		var parts = month.split('-');
		return new Date(Number(parts[0]), Number(parts[1]), 0).getDate();
	}

	function setText(id, value) {
		var node = document.getElementById(id);
		if (node) node.textContent = value;
	}

	/**
	 * Percentage change from last month. Returns null when there is no baseline,
	 * so callers can distinguish "unchanged" from "no data yet".
	 */
	function percentageChange(current, previous) {
		if (!previous) return null;
		return ((current - previous) / previous) * 100;
	}

	function formatChange(change) {
		// null means there is no previous month to compare against.
		if (change === null) return '-';
		return (change > 0 ? '+' : '') + App.formatPercent(change, 1);
	}

	/* ------------------------------------------------------------- charts */

	/** Destroys a chart before replacing it, so reloading never stacks canvases. */
	function upsertChart(id, config) {
		if (charts[id]) {
			charts[id].destroy();
			delete charts[id];
		}
		var canvas = document.getElementById(id);
		if (!canvas || typeof Chart === 'undefined') return;
		charts[id] = new Chart(canvas.getContext('2d'), config);
	}

	function readThemeColors() {
		var styles = getComputedStyle(document.documentElement);
		var read = function (name) {
			return styles.getPropertyValue(name).trim();
		};
		return {
			text: read('--text-muted'),
			grid: read('--border'),
			accent: read('--accent')
		};
	}

	function baseScales(colors) {
		return {
			y: {
				beginAtZero: true,
				ticks: {
					color: colors.text,
					callback: function (value) {
						return App.formatRupiahShort(value);
					}
				},
				grid: { color: colors.grid }
			},
			x: {
				ticks: { color: colors.text },
				grid: { display: false }
			}
		};
	}

	/* ------------------------------------------------------------- loaders */

	function loadWalletSummary() {
		return App.api('/api/analytics/wallets/' + encodeURIComponent(userId))
			.then(function (wallets) {
				var totalBalance = 0;
				var totalFrozen = 0;
				wallets.forEach(function (wallet) {
					totalBalance += Number(wallet.balance) || 0;
					totalFrozen += Number(wallet.frozen) || 0;
				});
				var totalUsable = totalBalance - totalFrozen;

				setText('totalBalance', App.formatRupiah(totalBalance));
				setText('usableBalance',
					'Tersedia ' + App.formatRupiah(totalUsable) + ' · Beku ' + App.formatRupiah(totalFrozen));
			})
			.catch(function (error) {
				App.toast('Gagal memuat ringkasan dompet: ' + error.message, 'error');
			});
	}

	function loadIncomeExpenseSummary() {
		return Promise.all([
			App.api('/api/analytics/income-expense/' + encodeURIComponent(userId) + '/' + currentMonth),
			App.api('/api/analytics/income-expense/' + encodeURIComponent(userId) + '/' + getLastMonth(currentMonth))
		]).then(function (results) {
			var current = results[0];
			var previous = results[1];

			var income = Number(current.totalIncome) || 0;
			var expense = Number(current.totalExpense) || 0;

			setText('monthlyIncome', App.formatRupiah(income));
			setText('monthlyExpense', App.formatRupiah(expense));

			var days = getDaysInMonth(currentMonth);
			setText('avgDailyIncome', 'Rata-rata harian ' + App.formatRupiahShort(income / days));
			setText('dailyAvgExpense', App.formatRupiahShort(expense / days));

			var incomeChange = percentageChange(income, Number(previous.totalIncome) || 0);
			var expenseChange = percentageChange(expense, Number(previous.totalExpense) || 0);
			setText('incomeVsLastMonth', formatChange(incomeChange) + ' dari bulan lalu');
			setText('expenseVsLastMonth', formatChange(expenseChange) + ' dari bulan lalu');

			// Savings rate: how much of income was not spent.
			var savings = income > 0 ? ((income - expense) / income) * 100 : 0;
			var savingsNode = document.getElementById('savingsRate');
			setText('savingsRate', App.formatPercent(savings, 1));
			savingsNode.className = 'stat__value ' + (savings >= 0 ? 'text-positive' : 'text-negative');

			var ratio = expense > 0 ? income / expense : null;
			setText('incomeExpenseRatio', ratio === null ? '-' : ratio.toFixed(2) + ' : 1');

			var colors = readThemeColors();
			upsertChart('incomeExpenseChart', {
				type: 'bar',
				data: {
					labels: ['Pemasukan', 'Pengeluaran'],
					datasets: [{
						label: 'Bulan ini',
						data: [income, expense],
						backgroundColor: [INCOME, EXPENSE],
						borderRadius: 6,
						maxBarThickness: 70
					}]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: {
						legend: { display: false },
						tooltip: {
							callbacks: {
								label: function (ctx) {
									return ctx.dataset.label + ': ' + App.formatRupiah(ctx.parsed.y);
								}
							}
						}
					},
					scales: baseScales(colors)
				}
			});
		}).catch(function (error) {
			App.toast('Gagal memuat pemasukan/pengeluaran: ' + error.message, 'error');
		});
	}

	function loadExpenseByCategory() {
		return App.api('/api/analytics/expense-by-category/' + encodeURIComponent(userId) + '/' + currentMonth)
			.then(function (data) {
				// The endpoint returns a flat { label: total } map keyed by
				// category, not a nested structure.
				var totals = Object.keys(data || {}).map(function (label) {
					return { name: label, total: data[label] };
				});

				// Keep the eight largest and roll the rest into one slice, so the
				// legend stays readable on a phone instead of listing 30 rows.
				totals.sort(function (a, b) {
					return (Number(b.total) || 0) - (Number(a.total) || 0);
				});

				if (totals.length > 9) {
					var top = totals.slice(0, 8);
					var rest = totals.slice(8);
					top.push({
						name: 'Lainnya (' + rest.length + ')',
						total: rest.reduce(function (sum, entry) { return sum + (Number(entry.total) || 0); }, 0)
					});
					totals = top;
				}

				var colors = readThemeColors();
				upsertChart('expenseCategoryChart', {
					type: 'doughnut',
					data: {
						labels: totals.map(function (entry) {
							return entry.name;
						}),
						datasets: [{
							data: totals.map(function (entry) {
								return Number(entry.total) || 0;
							}),
							backgroundColor: totals.map(function (_, index) {
								return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
							}),
							borderWidth: 0
						}]
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						cutout: '58%',
						plugins: {
							legend: {
								position: 'right',
								labels: { color: colors.text, boxWidth: 12, font: { size: 11 } }
							},
							tooltip: {
								callbacks: {
									label: function (ctx) {
										return ctx.label + ': ' + App.formatRupiah(ctx.parsed);
									}
								}
							}
						}
					}
				});

				// The "largest expense" tile uses the same data.
				if (totals.length > 0) {
					setText('topExpenseCategory', totals[0].name);
					setText('topExpenseAmount', App.formatRupiah(totals[0].total));
				} else {
					setText('topExpenseCategory', '-');
					setText('topExpenseAmount', '-');
				}
			})
			.catch(function (error) {
				App.toast('Gagal memuat pengeluaran per kategori: ' + error.message, 'error');
			});
	}

	function loadFinancialTrend() {
		var view = document.getElementById('trendChartView').value;

		return App.api('/api/analytics/financial-trend/' + encodeURIComponent(userId))
			.then(function (data) {
				var months = data || [];
				var labels = months.map(function (row) {
					var parts = row.month.split('-');
					var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
					return monthNames[Number(parts[1]) - 1] + ' ' + parts[0].slice(2);
				});

				var datasets = [];
				if (view === 'savings') {
					// Net savings per month: what is actually left over.
					datasets.push({
						label: 'Tabungan bersih',
						data: months.map(function (row) {
							return (Number(row.totalIncome) || 0) - (Number(row.totalExpense) || 0);
						}),
						borderColor: SAVINGS,
						backgroundColor: 'rgba(13, 148, 136, 0.7)',
						tension: 0.3,
						fill: true
					});
				} else if (view !== 'expense') {
					datasets.push({
						label: 'Pemasukan',
						// The endpoint names these totalIncome / totalExpense.
						data: months.map(function (row) { return Number(row.totalIncome) || 0; }),
						borderColor: INCOME,
						backgroundColor: TREND_INCOME,
						tension: 0.3,
						fill: true
					});
				}
				if (view !== 'income') {
					datasets.push({
						label: 'Pengeluaran',
						data: months.map(function (row) { return Number(row.totalExpense) || 0; }),
						borderColor: EXPENSE,
						backgroundColor: TREND_EXPENSE,
						tension: 0.3,
						fill: true
					});
				}

				var colors = readThemeColors();
				upsertChart('financialTrendChart', {
					type: 'line',
					data: { labels: labels, datasets: datasets },
					options: {
						responsive: true,
						maintainAspectRatio: false,
						interaction: { mode: 'index', intersect: false },
						plugins: {
							legend: { labels: { color: colors.text } },
							tooltip: {
								callbacks: {
									label: function (ctx) {
										return ctx.dataset.label + ': ' + App.formatRupiah(ctx.parsed.y);
									}
								}
							}
						},
						scales: baseScales(colors)
					}
				});
			})
			.catch(function (error) {
				App.toast('Gagal memuat tren: ' + error.message, 'error');
			});
	}

	function loadBudgetComparison() {
		return App.api('/api/analytics/budget-vs-actual/' + encodeURIComponent(userId) + '/' + currentMonth)
			.then(function (data) {
				var body = document.getElementById('budgetComparisonTable');
				// Flat array of { subcategory, budget, actual, difference }.
				var entries = Array.isArray(data) ? data : (data.subcategories || []);

				if (entries.length === 0) {
					body.innerHTML = '<tr><td colspan="5" class="text-muted">' +
						'Belum ada anggaran untuk bulan ini.</td></tr>';
					setText('budgetUsage', App.formatPercent(0, 0));
					return;
				}

				var totalBudget = 0;
				var totalUsed = 0;
				var rows = [];

				entries.forEach(function (entry) {
						var amount = Number(entry.budget) || 0;
						var used = Number(entry.actual) || 0;
						totalBudget += amount;
						totalUsed += used;

						var difference = amount - used;
						var percentage = amount > 0 ? (used / amount) * 100 : 0;
						var barTone = percentage > 100 ? 'negative' : percentage > 80 ? 'warning' : '';

						rows.push(
							'<tr>' +
							'<td>' + App.escapeHtml(entry.subcategory || '') + '</td>' +
							'<td class="table__num">' + App.formatRupiah(amount) + '</td>' +
							'<td class="table__num">' + App.formatRupiah(used) + '</td>' +
							'<td class="table__num ' + (difference < 0 ? 'text-negative' : '') + '">' +
							App.formatRupiah(difference) + '</td>' +
							'<td><div style="display:flex;align-items:center;gap:8px">' +
							'<div class="progress"><div class="progress__fill' +
							(barTone ? ' progress__fill--' + barTone : '') +
							'" style="width:' + Math.min(100, percentage) + '%"></div></div>' +
							'<span class="text-muted" style="font-size:12px;white-space:nowrap">' +
							App.formatPercent(percentage, 0) + '</span>' +
							'</div></td></tr>'
						);
				});

				body.innerHTML = rows.join('');
				var usage = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0;
				setText('budgetUsage', App.formatPercent(usage, 0));
			})
			.catch(function (error) {
				document.getElementById('budgetComparisonTable').innerHTML =
					'<tr><td colspan="5" class="text-muted">Belum ada anggaran untuk bulan ini.</td></tr>';
			});
	}

	function loadRecentTransactions() {
		return App.api('/api/transactions/' + encodeURIComponent(userId) + '/' + currentMonth)
			.then(function (transactions) {
				var body = document.getElementById('recentTransactionsTable');
				// Newest first, then only the ten most recent.
				var rows = transactions.slice().sort(function (a, b) {
					return String(b.date).localeCompare(String(a.date));
				}).slice(0, 10);

				if (rows.length === 0) {
					body.innerHTML = '<tr><td colspan="4" class="text-muted">Belum ada transaksi bulan ini.</td></tr>';
					return;
				}

				body.innerHTML = rows.map(function (transaction) {
					var isIncome = transaction.type === 'income';
					var category = [transaction.category, transaction.subcategory]
						.filter(Boolean).join(' / ') || '-';
					return '<tr>' +
						'<td>' + App.escapeHtml(App.formatDate(transaction.date)) + '</td>' +
						'<td>' + App.escapeHtml(category) + '</td>' +
						'<td>' + App.escapeHtml(transaction.description || '-') + '</td>' +
						'<td class="table__num ' + (isIncome ? 'text-positive' : 'text-negative') + '">' +
						(isIncome ? '+' : '-') + App.formatRupiah(transaction.amount) +
						'</td></tr>';
				}).join('');
			})
			.catch(function () {
				document.getElementById('recentTransactionsTable').innerHTML =
					'<tr><td colspan="4" class="text-muted">Belum ada transaksi bulan ini.</td></tr>';
			});
	}

	/* -------------------------------------------------------------- export */

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

		// A plain navigation: the server streams the file with the right headers.
		window.location.href = '/export/' + encodeURIComponent(userId) + '/' + currentMonth + '/' + format;
	};

	/* ---------------------------------------------------------------- boot */

	window.loadDashboard = function () {
		if (!userId) return;
		return Promise.all([
			loadWalletSummary(),
			loadIncomeExpenseSummary(),
			loadExpenseByCategory(),
			loadFinancialTrend(),
			loadBudgetComparison(),
			loadRecentTransactions()
		]);
	};

	document.addEventListener('DOMContentLoaded', function () {
		document.getElementById('month').value = getCurrentMonth();
		currentMonth = document.getElementById('month').value;

		document.getElementById('month').addEventListener('change', function () {
			currentMonth = this.value;
			loadDashboard();
		});

		// Redraw charts when the theme flips: Chart.js bakes in the axis colours
		// it was created with, so a straight swap would leave them unreadable.
		var observer = new MutationObserver(function () {
			if (userId) window.loadDashboard();
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

		App.api('/api/auth/me')
			.then(function (data) {
				userId = data.user.userId;
				document.getElementById('currentUser').textContent = data.user.username;
				return window.loadDashboard();
			})
			.catch(function () { /* App.api handles the redirect. */ });
	});
})();