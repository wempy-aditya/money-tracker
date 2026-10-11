/**
 * LLM settings form.
 *
 * The key field is write-only: after saving it is never sent back, so the input
 * stays empty and the page shows whether a key exists instead of its value. That
 * means the form must treat an untouched key field as "leave it alone" rather
 * than as "clear it", which is why the payload omits api_key entirely unless the
 * user actually typed something.
 */

(function () {
	'use strict';

	function showError(message) {
		var box = document.getElementById('settingsError');
		if (!box) return;
		box.textContent = message;
		box.hidden = !message;
	}

	function showSuccess(message) {
		var box = document.getElementById('settingsSuccess');
		if (!box) return;
		box.textContent = message;
		box.hidden = !message;
	}

	/** Human labels for the persona names the API returns. */
	var PERSONA_LABELS = {
		profesional: 'Profesional — lugas, netral',
		santai: 'Santai — hangat, santai',
		formal: 'Formal — baku, resmi',
		teknis: 'Teknis — istilah keuangan, dijelaskan',
		ringkas: 'Ringkas — beberapa kalimat saja',
		penjelas: 'Penjelas — menguraikan alasannya'
	};

	/**
	 * Built from the list the server sends rather than a hardcoded one, so a
	 * persona added on the backend shows up here without a second edit.
	 */
	function renderPersonas(available, selected) {
		var select = document.getElementById('persona');
		if (!select) return;

		select.innerHTML = '';
		var names = (available && available.length) ? available : Object.keys(PERSONA_LABELS);

		names.forEach(function (name) {
			var option = document.createElement('option');
			option.value = name;
			option.textContent = PERSONA_LABELS[name] || name;
			select.appendChild(option);
		});

		select.value = selected || names[0];
	}

	function setBadge(text, tone) {
		var badge = document.getElementById('connectionBadge');
		if (!badge) return;
		badge.textContent = text;
		badge.className = 'badge' + (tone ? ' badge--' + tone : '');
	}

	function applySettings(settings) {
		renderPersonas(settings.personas, settings.persona);
		document.getElementById('api_url').value = settings.api_url || '';
		document.getElementById('model').value = settings.model || '';
		document.getElementById('temperature').value =
			settings.temperature === null || settings.temperature === undefined ? 0.7 : settings.temperature;
		document.getElementById('max_tokens').value = settings.max_tokens || 1024;

		// Never prefill the key. Leaving it empty is the only safe default.
		var keyInput = document.getElementById('api_key');
		if (keyInput) keyInput.value = '';

		var hint = document.getElementById('keyHint');
		if (hint) {
			hint.textContent = settings.has_key
				? 'API key tersimpan. Tidak pernah dikirim kembali ke browser.'
				: 'Belum ada API key. Untuk layanan lokal boleh dikosongkan.';
		}

		var clearButton = document.getElementById('clearKeyButton');
		if (clearButton) clearButton.hidden = !settings.has_key;

		setBadge(settings.configured ? 'Sudah terhubung' : 'Belum lengkap', settings.configured ? 'ok' : 'muted');
	}

	function loadSettings() {
		showError('');
		return App.api('/api/settings')
			.then(applySettings)
			.catch(function (error) {
				showError(error.message || 'Pengaturan gagal dimuat');
			});
	}

	function saveSettings(event) {
		event.preventDefault();
		showError('');
		showSuccess('');

		var button = document.getElementById('saveSettingsButton');
		if (button) button.disabled = true;

		var body = {
			api_url: document.getElementById('api_url').value,
			model: document.getElementById('model').value,
			temperature: document.getElementById('temperature').value,
			max_tokens: document.getElementById('max_tokens').value,
			persona: document.getElementById('persona').value
		};

		// Only sent when the user actually typed one. An empty field must not
		// wipe the stored key.
		var typed = document.getElementById('api_key').value.trim();
		if (typed !== '') body.api_key = typed;

		return App.api('/api/settings', { method: 'PUT', body: body })
			.then(function (settings) {
				applySettings(settings);
				if (settings.configured) {
					showSuccess('Tersimpan. Uji koneksinya sebelum dipakai.');
				} else {
					showError('Masih kurang: ' + settings.missing.join(', ') + '.');
				}
			})
			.catch(function (error) {
				showError(error.message || 'Pengaturan gagal disimpan');
			})
			.then(function () {
				if (button) button.disabled = false;
			});
	}

	function testConnection() {
		showError('');
		showSuccess('');

		var button = document.getElementById('testConnectionButton');
		if (button) button.disabled = true;
		setBadge('Menguji...', 'muted');

		return App.api('/api/settings/test', { method: 'POST' })
			.then(function (result) {
				showSuccess('Terhubung. Model membalas: ' + (result.sample || result.model));
				setBadge('Terhubung', 'ok');
			})
			.catch(function (error) {
				showError(error.message || 'Koneksi gagal');
				setBadge('Gagal', 'danger');
			})
			.then(function () {
				if (button) button.disabled = false;
			});
	}

	function clearKey() {
		if (!window.confirm('Hapus API key yang tersimpan?')) return;
		showError('');

		return App.api('/api/settings', { method: 'PUT', body: { api_key: '' } })
			.then(function (settings) {
				applySettings(settings);
				showSuccess('API key dihapus.');
			})
			.catch(function (error) {
				showError(error.message || 'API key gagal dihapus');
			});
	}

	document.addEventListener('DOMContentLoaded', function () {
		var form = document.getElementById('settingsForm');
		if (form) form.addEventListener('submit', saveSettings);

		var testButton = document.getElementById('testConnectionButton');
		if (testButton) testButton.addEventListener('click', testConnection);

		var clearButton = document.getElementById('clearKeyButton');
		if (clearButton) clearButton.addEventListener('click', clearKey);

		loadSettings();
	});
})();