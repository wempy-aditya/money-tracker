/**
 * Goals page.
 *
 * A goal is funded from frozen money, so the page always shows how much frozen
 * money is left before the user allocates any. The server enforces the same
 * rule; this is the friendly version of that check.
 */

(function () {
	'use strict';

	var API = '/api/goals';
	var goals = [];
	var totalFrozen = 0;
	var selectedGoalId = null;

	function setText(id, value) {
		var node = document.getElementById(id);
		if (node) node.textContent = value;
	}

	/* ------------------------------------------------------------ rendering */

	function daysLeft(targetDate) {
		var today = new Date();
		today.setHours(0, 0, 0, 0);
		var target = new Date(targetDate);
		target.setHours(0, 0, 0, 0);
		return Math.round((target - today) / 86400000);
	}

	function renderSummary() {
		var allocated = 0;
		goals.forEach(function (goal) {
			allocated += Number(goal.currentAmount) || 0;
		});

		setText('totalFrozen', App.formatRupiah(totalFrozen));
		setText('allocatedToGoals', App.formatRupiah(allocated));
		setText('remainingFrozen', App.formatRupiah(totalFrozen - allocated));
		setText('goalCount', String(goals.length));
	}

	/**
	 * Sortable fields are the ones a goal card actually shows: what it is called,
	 * how much is being saved, how close it is, and when it is due. Progress is
	 * derived per card, so it is offered as its own field rather than left out.
	 */
	var sortControl = App.createSortControl({
		selectId: 'sortBy',
		directionId: 'sortDir',
		fields: [
			{ value: 'name', label: 'Nama target', get: function (g) { return g.name || ''; }, defaultDirection: 'asc' },
			{ value: 'targetAmount', label: 'Nominal target', get: function (g) { return Number(g.targetAmount) || 0; }, defaultDirection: 'desc' },
			{ value: 'progress', label: 'Progres', get: function (g) {
				var target = Number(g.targetAmount) || 0;
				if (target <= 0) return -1;
				return ((Number(g.currentAmount) || 0) / target) * 100;
			}, defaultDirection: 'desc' },
			{ value: 'targetDate', label: 'Tenggat', get: function (g) { return g.targetDate || ''; }, defaultDirection: 'asc' }
		]
	});

	App.on('sort:changed', function () {
		if (goals.length) renderGoals();
	});

	function renderGoals() {
		var host = document.getElementById('goalsList');

		if (goals.length === 0) {
			host.innerHTML = '<div class="card"><div class="card__body">' +
				'<div class="empty"><div class="empty__title">Belum ada target</div>' +
				'<p>Buat target untuk menyimpan uang menuju tujuan tertentu.</p></div></div></div>';
			return;
		}

		var sorted = sortControl ? sortControl.apply(goals) : goals;

		host.innerHTML = sorted.map(function (goal) {
			var target = Number(goal.targetAmount) || 0;
			var current = Number(goal.currentAmount) || 0;
			var progress = target > 0 ? Math.min(100, (current / target) * 100) : 0;
			var remaining = daysLeft(goal.targetDate);
			var stillNeeded = Math.max(0, target - current);
			var perDay = Math.ceil(stillNeeded / Math.max(1, remaining));

			var tone = progress >= 100 ? 'positive' : progress >= 50 ? '' : 'accent';
			var status;
			if (progress >= 100) {
				status = '<span class="badge badge--positive">Tercapai</span>';
			} else if (remaining < 0) {
				status = '<span class="badge badge--negative">Lewat tanggal</span>';
			} else if (remaining <= 30) {
				status = '<span class="badge badge--warning">' + remaining + ' hari lagi</span>';
			} else {
				status = '<span class="badge">' + remaining + ' hari lagi</span>';
			}

			var name = App.escapeHtml(goal.name);
			var idAttr = JSON.stringify(goal.id).replace(/"/g, '&quot;');

			return '<div class="card"><div class="card__body">' +
				'<div class="goal-card__top">' +
				'<h2 class="goal-card__name">' + name + '</h2>' +
				'<div class="table__actions">' +
				'<button class="icon-btn" type="button" onclick="openEditModal(' + idAttr +
				')" aria-label="Edit ' + name + '" title="Edit">&#9998;</button>' +
				'<button class="icon-btn icon-btn--danger" type="button" onclick="openDeleteModal(' + idAttr +
				')" aria-label="Hapus ' + name + '" title="Hapus">&#128465;</button>' +
				'</div></div>' +

				'<div class="goal-card__figures">' +
				'<span class="goal-card__current">' + App.formatRupiah(current) + '</span>' +
				'<span class="goal-card__target">dari ' + App.formatRupiah(target) + '</span>' +
				'</div>' +

				'<div style="display:flex;align-items:center;gap:10px;margin-top:8px">' +
				'<div class="progress" style="flex:1"><div class="progress__fill' +
				(progress >= 100 ? '' : tone ? ' progress__fill--' + tone : '') +
				'" style="width:' + progress + '%"></div></div>' +
				'<span class="text-muted" style="font-size:12px;white-space:nowrap">' +
				progress.toFixed(0) + '%</span>' +
				'</div>' +

				'<div class="goal-card__meta">' + status +
				'<span>Target ' + App.escapeHtml(App.formatDate(goal.targetDate)) + '</span>' +
				'</div>' +

				(progress < 100 && stillNeeded > 0 && remaining > 0
					? '<p class="goal-card__desc">Perlu ' + App.formatRupiah(perDay) + ' per hari</p>'
					: '') +

				(goal.description
					? '<p class="goal-card__desc">' + App.escapeHtml(goal.description) + '</p>'
					: '') +

				'<button class="btn btn--secondary btn--block" type="button" style="margin-top:12px" ' +
				'onclick="openAddFundsModal(' + idAttr + ')">Tambah alokasi</button>' +
				'</div></div>';
		}).join('');
	}

	/* -------------------------------------------------------------- loading */

	function fetchWalletSummary() {
		return App.api('/api/wallets').then(function (wallets) {
			totalFrozen = 0;
			wallets.forEach(function (wallet) {
				totalFrozen += Number(wallet.frozen) || 0;
			});
		}).catch(function () {
			totalFrozen = 0;
		});
	}

	function fetchGoals() {
		return App.api(API).then(function (data) {
			goals = data || [];
			renderSummary();
			renderGoals();
		}).catch(function (error) {
			App.toast(error.message, 'error');
		});
	}

	function refresh() {
		return Promise.all([fetchWalletSummary(), fetchGoals()]);
	}

	/* --------------------------------------------------------------- modals */

	window.openAddModal = function () {
		var form = document.getElementById('addForm');
		form.reset();
		document.getElementById('initialAllocation').value = 0;

		var allocated = 0;
		goals.forEach(function (goal) { allocated += Number(goal.currentAmount) || 0; });
		var available = Math.max(0, totalFrozen - allocated);
		document.getElementById('allocationHint').textContent =
			'Maksimal ' + App.formatRupiah(available) + ' dari dana beku yang tersisa.';

		App.openModal('addModal');
	};

	window.closeAddModal = function () {
		App.closeModal('addModal');
	};

	window.openEditModal = function (id) {
		var goal = goals.find(function (item) { return item.id === id; });
		if (!goal) return;

		selectedGoalId = id;
		document.getElementById('editGoalName').value = goal.name;
		document.getElementById('editTargetAmount').value = goal.targetAmount;
		document.getElementById('editCurrentAmount').value = goal.currentAmount;
		document.getElementById('editTargetDate').value = goal.targetDate;
		document.getElementById('editGoalDescription').value = goal.description || '';
		App.openModal('editModal');
	};

	window.closeEditModal = function () {
		App.closeModal('editModal');
		selectedGoalId = null;
	};

	window.openAddFundsModal = function (id) {
		var goal = goals.find(function (item) { return item.id === id; });
		if (!goal) return;

		selectedGoalId = id;
		document.getElementById('addFundsAmount').value = '';

		var allocated = 0;
		goals.forEach(function (item) { allocated += Number(item.currentAmount) || 0; });
		var available = Math.max(0, totalFrozen - allocated);

		document.getElementById('addFundsDesc').textContent =
			'"' + goal.name + '" sekarang ' + App.formatRupiah(goal.currentAmount) +
			'. Bisa ditambah maksimal ' + App.formatRupiah(available) + ' dari dana beku.';

		App.openModal('addFundsModal');
	};

	window.closeAddFundsModal = function () {
		App.closeModal('addFundsModal');
		selectedGoalId = null;
	};

	window.openDeleteModal = function (id) {
		var goal = goals.find(function (item) { return item.id === id; });
		selectedGoalId = id;
		document.getElementById('deleteGoalName').textContent = goal
			? '"' + goal.name + '" akan dihapus dan ' + App.formatRupiah(goal.currentAmount) +
			' dialokasikan akan kembali ke dana beku.'
			: 'Alokasi dana beku akan dilepas kembali.';
		App.openModal('deleteModal');
	};

	window.closeDeleteModal = function () {
		App.closeModal('deleteModal');
		selectedGoalId = null;
	};

	window.confirmDeleteGoal = function () {
		return App.api(API + '/' + encodeURIComponent(selectedGoalId), { method: 'DELETE' })
			.then(function () {
				App.closeModal('deleteModal');
				App.toast('Target dihapus.', 'success');
				return refresh();
			})
			.catch(function (error) {
				App.toast(error.message, 'error');
			});
	};

	/* --------------------------------------------------------------- submit */

	function submitAdd(event) {
		event.preventDefault();
		var button = event.target.querySelector('button[type=submit]');
		button.disabled = true;

		App.api(API, {
			method: 'POST',
			body: {
				name: document.getElementById('goalName').value,
				targetAmount: Number(document.getElementById('targetAmount').value),
				currentAmount: Number(document.getElementById('initialAllocation').value || 0),
				targetDate: document.getElementById('targetDate').value,
				description: document.getElementById('goalDescription').value
			}
		}).then(function () {
			App.closeModal('addModal');
			App.toast('Target dibuat.', 'success');
			return refresh();
		}).catch(function (error) {
			App.toast(error.message, 'error');
		}).finally(function () {
			button.disabled = false;
		});
	}

	function submitEdit(event) {
		event.preventDefault();
		var button = event.target.querySelector('button[type=submit]');
		button.disabled = true;

		App.api(API + '/' + encodeURIComponent(selectedGoalId), {
			method: 'PUT',
			body: {
				name: document.getElementById('editGoalName').value,
				targetAmount: Number(document.getElementById('editTargetAmount').value),
				currentAmount: Number(document.getElementById('editCurrentAmount').value),
				targetDate: document.getElementById('editTargetDate').value,
				description: document.getElementById('editGoalDescription').value
			}
		}).then(function () {
			App.closeModal('editModal');
			App.toast('Target diperbarui.', 'success');
			return refresh();
		}).catch(function (error) {
			App.toast(error.message, 'error');
		}).finally(function () {
			button.disabled = false;
		});
	}

	function submitAddFunds(event) {
		event.preventDefault();
		var button = event.target.querySelector('button[type=submit]');
		var goal = goals.find(function (item) { return item.id === selectedGoalId; });
		if (!goal) return;

		button.disabled = true;

		var additional = Number(document.getElementById('addFundsAmount').value);

		App.api(API + '/' + encodeURIComponent(selectedGoalId), {
			method: 'PUT',
			body: {
				name: goal.name,
				targetAmount: goal.targetAmount,
				currentAmount: (Number(goal.currentAmount) || 0) + additional,
				targetDate: goal.targetDate,
				description: goal.description
			}
		}).then(function () {
			App.closeModal('addFundsModal');
			App.toast('Alokasi ditambahkan.', 'success');
			return refresh();
		}).catch(function (error) {
			App.toast(error.message, 'error');
		}).finally(function () {
			button.disabled = false;
		});
	}

	/* ----------------------------------------------------------------- boot */

	document.addEventListener('DOMContentLoaded', function () {
		document.getElementById('addForm').addEventListener('submit', submitAdd);
		document.getElementById('editForm').addEventListener('submit', submitEdit);
		document.getElementById('addFundsForm').addEventListener('submit', submitAddFunds);

		App.api('/api/auth/me')
			.then(function (data) {
				document.getElementById('currentUser').textContent = data.user.username;
				return refresh();
			})
			.catch(function () { /* App.api handles the redirect. */ });
	});
})();