/**
 * Profile form.
 *
 * Every field is optional and the page says so, because an incomplete profile is
 * the normal state rather than a mistake. The completeness bar is there to show
 * what is still missing, not to imply the form is unfinished.
 */

(function () {
	'use strict';

	var FIELDS = [
		'display_name', 'age', 'occupation', 'position', 'education', 'dependents',
		'hobbies', 'risk_tolerance', 'monthly_commitments', 'financial_goals',
		'background', 'notes'
	];

	function showError(message) {
		var box = document.getElementById('profileError');
		if (!box) return;
		box.textContent = message;
		box.hidden = !message;
	}

	function fillForm(profile) {
		for (var i = 0; i < FIELDS.length; i++) {
			var input = document.getElementById(FIELDS[i]);
			if (!input) continue;
			var value = profile[FIELDS[i]];
			input.value = value === null || value === undefined ? '' : value;
		}
	}

	function collect() {
		var payload = {};
		for (var i = 0; i < FIELDS.length; i++) {
			var field = FIELDS[i];
			var input = document.getElementById(field);
			if (input) payload[field] = input.value;
		}
		return payload;
	}

	function renderCompleteness(data) {
		var bar = document.getElementById('completenessBar');
		var line = document.getElementById('completenessLine');
		var hint = document.getElementById('completenessHint');
		if (bar) bar.style.width = data.percent + '%';
		if (line) line.textContent = data.filled + ' dari ' + data.total + ' terisi';

		if (!hint) return;
		if (data.percent === 100) {
			hint.textContent = 'Profil lengkap. Saran asisten akan jauh lebih spesifik.';
		} else if (!data.hasBasics) {
			hint.textContent = 'Isi usia, pekerjaan, atau tujuan keuangan dulu agar sarannya tidak terlalu umum.';
		} else {
			hint.textContent = 'Masih ada yang belum diisi: ' + data.missing.join(', ') + '.';
		}
	}

	function loadCompleteness() {
		return App.api('/api/profile/completeness')
			.then(renderCompleteness)
			.catch(function () {
				var hint = document.getElementById('completenessHint');
				if (hint) hint.textContent = 'Kelengkapan profil tidak bisa dimuat.';
			});
	}

	function loadProfile() {
		showError('');
		return App.api('/api/profile')
			.then(function (profile) {
				fillForm(profile);
				return loadCompleteness();
			})
			.catch(function (error) {
				showError(error.message || 'Profil gagal dimuat');
			});
	}

	function saveProfile(event) {
		event.preventDefault();
		showError('');

		var button = document.getElementById('saveProfileButton');
		if (button) button.disabled = true;

		return App.api('/api/profile', { method: 'PUT', body: collect() })
			.then(function (profile) {
				fillForm(profile);
				App.toast('Profil disimpan');
				return loadCompleteness();
			})
			.catch(function (error) {
				showError(error.message || 'Profil gagal disimpan');
			})
			.then(function () {
				if (button) button.disabled = false;
			});
	}

	document.addEventListener('DOMContentLoaded', function () {
		var form = document.getElementById('profileForm');
		if (form) form.addEventListener('submit', saveProfile);
		loadProfile();
	});

	window.loadProfile = loadProfile;
})();