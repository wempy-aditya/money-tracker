/**
 * Advanced Financial Insights page.
 *
 * Every panel is honest about what it does not know. A section with too little
 * history says so instead of drawing a chart, and the needs/wants split reports
 * its own coverage rather than quietly scoring only the labelled categories as if
 * they were the whole of the user's spending.
 */

(function () {
	'use strict';

	var API = '/api/insights';
	var data = null;
	var chart = null;

	/* -------------------------------------------------------------- helpers */

	function setText(id, value) {
		var el = document.getElementById(id);
		if (el) el.textContent = value;
	}

	function monthLabel(month) {
		var parts = String(month).split('-');
		var names = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
		return names[Number(parts[1]) - 1] + ' ' + parts[0];
	}

	function stat(label, value, tone, sub) {
		return '<div class="stat' + (tone ? ' ' + tone : '') + '">' +
			'<div class="stat__label">' + label + '</div>' +
			'<div class="stat__value">' + value + '</div>' +
			(sub ? '<div class="stat__sub">' + sub + '</div>' : '') +
			'</div>';
	}

	/** A section that cannot answer yet, with the reason attached. */
	function notReady(reason) {
		return '<div class="empty">' +
			'<div class="empty__title">Belum bisa dihitung</div>' +
			'<p>' + App.escapeHtml(reason || '') + '</p>' +
			'</div>';
	}

	function note(text, tone) {
		return '<p class="field__hint' + (tone ? ' ' + tone : '') + '">' + App.escapeHtml(text) + '</p>';
	}

	function card(title, subtitle, body, headExtra) {
		return '<div class="card">' +
			'<div class="card__head"><div><h2 class="panel__title">' + title + '</h2>' +
			(subtitle ? '<p class="rule-card__meta">' + App.escapeHtml(subtitle) + '</p>' : '') +
			'</div>' + (headExtra || '') + '</div>' +
			'<div class="card__body">' + body + '</div>' +
			'</div>';
	}

	/* ---------------------------------------------------------------- Engel */

	function renderEngel() {
		var engel = data.engel;
		var assessment = engel.assessment;

		if (!assessment.grade) {
			return card('Hukum Engel', 'Pengeluaran dibagi pendapatan', notReady(assessment.reason));
		}

		var tone = assessment.grade === 'Sangat baik' ? 'stat--positive'
			: assessment.grade === 'Seimbang' ? ''
			: assessment.grade === 'Tinggi' ? 'stat--negative' : 'stat--negative';

		var body = '<div class="stats">' +
			stat('Koefisien bulan ini', engel.series[engel.series.length - 1].ratio + '%', tone) +
			stat('Penilaian', assessment.grade, tone) +
			stat('Perubahan', (assessment.change > 0 ? '+' : '') + assessment.change + ' poin',
				assessment.creeping ? 'stat--negative' : 'stat--positive') +
			stat('Bulan diukur', String(assessment.monthsMeasured)) +
			'</div>' +
			note(assessment.verdict) +
			(assessment.creeping
				? note('Pola kenaikan berlanjut: pengeluaran naik lebih cepat dari pendapatan.', 'text-negative')
				: note('Tidak terlihat kenaikan konsisten dari pengeluaran terhadap pendapatan.', 'text-positive')) +
			'<div class="mt-24"><canvas id="engelChart" class="chart" height="200"></canvas></div>';

		// Coverage first: without it the needs/wants split below is unreadable.
		var coverage = engel.coverage;
		if (coverage.percent !== null && coverage.percent < 100) {
			body += '<div class="divider"></div>' +
				'<div class="stats">' +
				stat('Perlu vs ingin', coverage.percent + '% tertandai',
					coverage.percent < 60 ? 'stat--negative' : '',
					'Belum ditandai: ' + App.formatRupiah(coverage.unmarkedTotal)) +
				'</div>' +
				note('Sebagian pengeluaran tidak bisa diklasifikasi karena kategorinya belum diberi label ' +
					'kebutuhan atau keinginan di halaman Anggaran. Bagian di atas memakai seluruh pengeluaran, ' +
					'jadi angka ini tidak mengubah hasil koefisien.');
		} else if (coverage.percent === null) {
			body += '<div class="divider"></div>' +
				note('Belum ada kategori anggaran yang diberi label kebutuhan atau keinginan, jadi pemisahan ' +
					'kebutuhan dan keinginan belum bisa ditampilkan. Buka halaman Anggaran untuk menandainya.');
		}

		// The badge has to name which of the two separate findings it is talking
		// about. It used to read "Stabil" from the creep check alone, right beside
		// the data-quality card saying the income is unsteady, which reads as a
		// contradiction the user cannot resolve.
		var badge;
		if (!data.dataQuality.incomeStable) {
			badge = '<span class="badge badge--warning">Indikasi kasar</span>';
		} else if (assessment.creeping) {
			badge = '<span class="badge badge--negative">Lifestyle creep</span>';
		} else {
			badge = '<span class="badge badge--positive">Stabil</span>';
		}

		return card('Hukum Engel', 'Pengeluaran dibagi pendapatan', body, badge);
	}

	/* ------------------------------------------------------------ Parkinson */

	function renderParkinson() {
		var parkinson = data.parkinson;

		if (!parkinson.ready) {
			return card('Batas Belanja Aman', 'Hukum Parkinson & mental accounting',
				notReady(parkinson.reason));
		}

		var body = '<div class="stats">' +
			stat('Batas dari kebiasaan', App.formatRupiah(parkinson.baseline), '',
				'Median ' + parkinson.monthsUsed + ' bulan terakhir') +
			stat('Bulan ini', App.formatRupiah(parkinson.current),
				parkinson.overBy > 0 ? 'stat--negative' : 'stat--positive') +
			stat('Selisih', (parkinson.overBy > 0 ? '+' : '') + App.formatRupiah(parkinson.overBy),
				parkinson.overBy > 0 ? 'stat--negative' : 'stat--positive',
				parkinson.overByPercent !== null ? parkinson.overByPercent + '% di atas kebiasaan' : '') +
			stat('Ruang tersisa', App.formatRupiah(parkinson.roomToSpend)) +
			'</div>';

		if (parkinson.pressure !== null && parkinson.pressure > 50) {
			body += note('Pengeluaran bulan ini sudah memakai lebih dari ' +
				Math.round(parkinson.pressure) + '% dari ruang yang tersisa setelah kebutuhan pokok. ' +
				'Di sinilah pengeluaran tambahan sering terjadi: ruang kosong dianggap sebagai izin.',
				'text-negative');
		} else {
			body += note('Pengeluaran masih terkendali dibanding kebiasaan Anda.');
		}

		body += note('Batas ini diturunkan dari kebiasaan Anda sendiri, bukan aturan dari luar. ' +
			'Kalau pengeluaran naik terus selama berbulan-bulan, batas ikut naik — itu yang membuat ' +
			'seperti tidak terasa.');

		return card('Batas Belanja Aman', 'Hukum Parkinson & mental accounting', body);
	}

	/* --------------------------------------------------------------- Pareto */

	function renderPareto() {
		var pareto = data.pareto;

		if (!pareto.ready) {
			return card('Efisiensi 80/20', 'Prinsip Pareto', notReady(pareto.reason));
		}

		var rows = pareto.categories.map(function (row, index) {
			var isVital = index < pareto.vitalFew;
			var barWidth = Math.max(1, Math.round(row.percent));
			return '<tr>' +
				'<td>' + App.escapeHtml(row.name) + ' ' +
				(isVital ? '<span class="badge badge--accent">vital</span>' : '') + '</td>' +
				'<td class="table__num">' + App.formatRupiah(row.total) + '</td>' +
				'<td class="table__num">' + row.percent + '%</td>' +
				'<td>' +
				'<div class="progress"><div class="progress__fill' +
				(isVital ? '' : ' progress__fill--warning') +
				'" style="width:' + barWidth + '%"></div></div>' +
				'</td>' +
				'</tr>';
		}).join('');

		var body = '<p>' + pareto.vitalFew + ' dari ' + pareto.categories.length +
			' kategori membawa ' + pareto.vitalFewShare + '% dari total pengeluaran' +
			' (total ' + App.formatRupiah(pareto.total) + ').</p>' +
			'<div class="table-wrap mt-24"><table class="table">' +
			'<thead><tr><th>Kategori</th><th class="table__num">Total</th>' +
			'<th class="table__num">Porsi</th><th>Kumulatif</th></tr></thead>' +
			'<tbody>' + rows + '</tbody></table></div>';

		if (pareto.trivialMany.length) {
			body += note('Kategori di luar vital sering terlihat besar secara absolut tapi dampaknya ' +
				'kecil kalau digabung: totalnya ' +
				App.formatRupiah(pareto.trivialMany.reduce(function (sum, row) {
					return sum + row.total;
				}, 0)) + '.');
		}

		return card('Efisiensi 80/20', 'Prinsip Pareto', body);
	}

	/* --------------------------------------------------------------- Wealth */

	var simulator = { wealth: null, monthlySaving: null, rate: 10, years: 30 };

	function renderWealth() {
		var wealth = data.wealth;

		var body = '<div class="stats">' +
			stat('Kekayaan saat ini', App.formatRupiah(wealth.current)) +
			stat('Tabungan per bulan', App.formatRupiah(wealth.monthlySaving),
				wealth.monthlySaving > 0 ? 'stat--positive' : 'stat--negative') +
			stat('Rule of 72', wealth.ruleOf72 !== null ? wealth.ruleOf72 + ' tahun' : '-', '',
				wealth.annualRate > 0 ? 'untuk menjadi 2× pada ' + wealth.annualRate + '%' : '') +
			stat('Waktu sebenarnya', wealth.exactDoubling !== null ? wealth.exactDoubling + ' tahun' : '-') +
			'</div>';

		if (wealth.savingRateCapped) {
			body += note('Tingkat bunga default memakai ' + wealth.maxProjectionRate + '%, bukan ' +
				wealth.savingRateRaw + '%. Tingkat sebesar itu berasal dari satu bulan tanpa pengeluaran ' +
				'aneh, bukan kebiasaan yang bisa diproyeksikan puluhan tahun.');
		}

		body += '<div class="divider"></div>' +
			'<h3 class="panel__title mb-16">Simulasi</h3>' +
			'<div class="grid-2">' +
			'<div class="field"><label class="field__label" for="simWealth">Saldo awal</label>' +
			'<input class="input" type="number" id="simWealth" min="0" step="1000" value="' +
			simulator.wealth + '" /></div>' +
			'<div class="field"><label class="field__label" for="simSaving">Tabungan per bulan</label>' +
			'<input class="input" type="number" id="simSaving" min="0" step="1000" value="' +
			simulator.monthlySaving + '" /></div>' +
			'<div class="field"><label class="field__label" for="simRate">Bunga per tahun (%)</label>' +
			'<input class="input" type="number" id="simRate" min="0" max="100" step="0.1" value="' +
			simulator.rate + '" /></div>' +
			'<div class="field"><label class="field__label" for="simYears">Jangka waktu (tahun)</label>' +
			'<input class="input" type="number" id="simYears" min="1" max="50" step="1" value="' +
			simulator.years + '" /></div>' +
			'</div>' +
			'<button class="btn btn--primary" type="button" id="runSimulationButton" onclick="runSimulation()">Hitung</button>' +
			'<p class="form-error" id="simulationError" role="alert" hidden></p>' +
			'<div id="simulationResult"></div>';

		return card('Wealth Simulator', 'Compound interest & Rule of 72', body);
	}

	window.runSimulation = function () {
		var errorBox = document.getElementById('simulationError');
		errorBox.hidden = true;

		var button = document.getElementById('runSimulationButton');
		var wealth = Number(document.getElementById('simWealth').value);
		var saving = Number(document.getElementById('simSaving').value);
		var rate = Number(document.getElementById('simRate').value);
		var years = Number(document.getElementById('simYears').value);

		if (!Number.isFinite(wealth) || wealth < 0) {
			errorBox.hidden = false;
			errorBox.textContent = 'Saldo awal harus angka nol atau lebih.';
			return Promise.resolve();
		}
		if (!Number.isFinite(saving) || saving < 0) {
			errorBox.hidden = false;
			errorBox.textContent = 'Tabungan bulanan harus angka nol atau lebih.';
			return Promise.resolve();
		}
		if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
			errorBox.hidden = false;
			errorBox.textContent = 'Bunga harus antara 0 dan 100 persen.';
			return Promise.resolve();
		}

		simulator.wealth = wealth;
		simulator.monthlySaving = saving;
		simulator.rate = rate;
		simulator.years = years;

		if (button.disabled) return Promise.resolve();
		button.disabled = true;
		button.textContent = 'Menghitung...';

		var query = '?wealth=' + wealth + '&monthlySaving=' + saving + '&rate=' + rate + '&years=' + years;

		return App.api(API + '/simulate' + query)
			.then(function (result) {
				var last = result.path[result.path.length - 1];
				var rows = result.milestones.map(function (milestone) {
					return '<tr><td>' + milestone.years + ' tahun</td>' +
						'<td class="table__num">' + App.formatRupiah(milestone.amount) + '</td></tr>';
				}).join('');

				document.getElementById('simulationResult').innerHTML =
					'<div class="stats mt-24">' +
					stat('Setelah ' + result.years + ' tahun', App.formatRupiah(last.amount), 'stat--positive',
						'Tabungan ' + App.formatRupiah(saving) + '/bulan pada ' + rate + '%') +
					stat('Rule of 72', result.ruleOf72 !== null ? result.ruleOf72 + ' tahun' : '-') +
					'</div>' +
					'<div class="table-wrap mt-24"><table class="table"><tbody>' + rows + '</tbody></table></div>' +
					'<div class="mt-24"><canvas id="simChart" class="chart" height="200"></canvas></div>';

				drawSimulation(result);
			})
			.catch(function (error) {
				errorBox.hidden = false;
				errorBox.textContent = error.message;
			})
			.finally(function () {
				button.disabled = false;
				button.textContent = 'Hitung';
			});
	};

	/* --------------------------------------------------------------- charts */

	var NEEDS = '#0d9488';
	var WANTS = '#f59e0b';
	var INCOME = '#6366f1';

	function drawEngel(rows) {
		var canvas = document.getElementById('engelChart');
		if (!canvas || typeof Chart === 'undefined') return;
		if (chart) chart.destroy();

		chart = new Chart(canvas.getContext('2d'), {
			type: 'line',
			data: {
				labels: rows.map(function (row) { return monthLabel(row.month); }),
				datasets: [
					{
						label: 'Koefisien Engel (%)',
						data: rows.map(function (row) { return row.ratio; }),
						borderColor: INCOME,
						backgroundColor: 'rgba(99, 102, 241, 0.12)',
						fill: true,
						tension: 0.3
					},
					{
						label: 'Kebutuhan',
						data: rows.map(function (row) { return row.needs; }),
						borderColor: NEEDS,
						backgroundColor: 'transparent',
						tension: 0.3
					},
					{
						label: 'Keinginan',
						data: rows.map(function (row) { return row.wants; }),
						borderColor: WANTS,
						backgroundColor: 'transparent',
						tension: 0.3
					}
				]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: { legend: { labels: { boxWidth: 12 } } },
				scales: { y: { beginAtZero: true } }
			}
		});
	}

	function drawSimulation(result) {
		var canvas = document.getElementById('simChart');
		if (!canvas || typeof Chart === 'undefined') return;
		if (chart) chart.destroy();

		chart = new Chart(canvas.getContext('2d'), {
			type: 'line',
			data: {
				labels: result.path.map(function (row) { return row.year + ' th'; }),
				datasets: [{
					label: 'Kekayaan',
					data: result.path.map(function (row) { return row.amount; }),
					borderColor: NEEDS,
					backgroundColor: 'rgba(13, 148, 136, 0.12)',
					fill: true,
					tension: 0.25
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: { legend: { display: false } },
				scales: { y: { beginAtZero: true } }
			}
		});
	}

	/* ----------------------------------------------------------------- load */

	window.loadInsights = function () {
		return App.api(API)
			.then(function (result) {
				data = result;
				simulator.wealth = result.wealth.current;
				simulator.monthlySaving = result.wealth.monthlySaving;
				simulator.rate = result.wealth.annualRate > 0 ? result.wealth.annualRate : 10;

				var root = document.getElementById('insightsRoot');
				root.innerHTML = renderQuality() +
					'<div class="grid-2 mt-24">' +
					'<div>' + renderEngel() + '</div>' +
					'<div>' + renderParkinson() + '</div>' +
					'</div>' +
					'<div class="mt-24">' + renderPareto() + '</div>' +
					'<div class="mt-24">' + renderWealth() + '</div>';

				drawEngel(result.engel.series);
				if (typeof Chart !== 'undefined') {
					document.title = 'Advanced Financial Insights - Daily Money Tracker';
				}
			})
			.catch(function (error) {
				document.getElementById('insightsRoot').innerHTML =
					'<div class="card"><div class="card__body">' +
					'<div class="empty"><div class="empty__title">Gagal memuat</div>' +
					'<p>' + App.escapeHtml(error.message) + '</p></div></div></div>';
			});
	};

	/** Data quality first: the analyses below are only as good as this. */
	function renderQuality() {
		var quality = data.dataQuality;
		var warnings = [];

		if (!quality.incomeStable) {
			warnings.push('Pemasukan bulan ini berbeda-beda. Hukum Engel hanya bermakna kalau ' +
				'pendapatan relatif stabil, jadi angka di bawah baru indikasi kasar.');
		}
		if (quality.monthsWithIncome < 3) {
			warnings.push('Hanya ' + quality.monthsWithIncome + ' bulan dengan pemasukan tercatat. ' +
				'Minimal 3 bulan untuk melihat pola.');
		}
		if (quality.monthsWithExpense < 3) {
			warnings.push('Hanya ' + quality.monthsWithExpense + ' bulan dengan pengeluaran tercatat.');
		}

		var body = '<div class="stats">' +
			stat('Bulan dipantau', String(quality.monthsTotal)) +
			stat('Ada pemasukan', String(quality.monthsWithIncome) + '/6') +
			stat('Ada pengeluaran', String(quality.monthsWithExpense) + '/6') +
			stat('Pemasukan', quality.incomeStable ? 'Stabil' : 'Berubah-ubah',
				quality.incomeStable ? 'stat--positive' : 'stat--negative') +
			'</div>';

		if (warnings.length) {
			body += '<div class="divider"></div>' + warnings.map(function (text) {
				return '<p class="field__hint text-negative">' + App.escapeHtml(text) + '</p>';
			}).join('');
		}

		return card('Kualitas data', 'Dipakai semua analisis di bawah', body);
	}

	/* ----------------------------------------------------------------- boot */

	document.addEventListener('DOMContentLoaded', function () {
		loadInsights();

		App.api('/api/auth/me')
			.then(function (result) {
				setText('currentUser', result.user.username);
			})
			.catch(function () { /* App.api handles the redirect. */ });
	});
})();