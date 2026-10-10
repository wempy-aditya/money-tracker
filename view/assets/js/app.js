/**
 * Shared frontend runtime.
 *
 * Loaded by every page. Provides the theme switch, mobile navigation, toasts,
 * modal plumbing, and a fetch wrapper that always sends the session cookie and
 * turns an expired session into a redirect to /login.
 *
 * No build step and no framework: the app has always been plain HTML plus
 * vanilla JS, and this keeps it that way.
 */

(function () {
	'use strict';

	/* ----------------------------------------------------------------- theme */

	var THEME_KEY = 'money-tracker-theme';

	function applyTheme(theme) {
		if (theme === 'light' || theme === 'dark') {
			document.documentElement.setAttribute('data-theme', theme);
		} else {
			document.documentElement.removeAttribute('data-theme');
		}
	}

	function preferredTheme() {
		try {
			var stored = localStorage.getItem(THEME_KEY);
			if (stored === 'light' || stored === 'dark') return stored;
		} catch (error) {
			// Private browsing can throw on localStorage access.
		}
		return 'system';
	}

	function setTheme(theme) {
		if (theme === 'system') {
			try {
				localStorage.removeItem(THEME_KEY);
			} catch (error) {
				// Ignore: the attribute change below is what actually matters.
			}
			applyTheme('system');
		} else {
			try {
				localStorage.setItem(THEME_KEY, theme);
			} catch (error) {
				// Ignore.
			}
			applyTheme(theme);
		}
		document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
			button.textContent = theme === 'light' ? '\u25D1' : theme === 'dark' ? '\u25D0' : '\u25D1';
			button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
			button.title = button.getAttribute('aria-label');
		});
	}

	// Applied before first paint by the inline script in each page head, so the
	// stored theme is read here and the page never flashes the wrong one.
	setTheme(preferredTheme());

	// ------------------------------------------------------------- formatting */

	function formatRupiah(value) {
		var number = Number(value) || 0;
		var sign = number < 0 ? '-' : '';
		// id-ID gives "1.250.000" for thousands and "338,7" for decimals, which
		// is correct Indonesian. Round to whole rupiah so averages never show
		// long fractions on a card.
		return sign + 'Rp' + Math.round(Math.abs(number)).toLocaleString('id-ID');
	}

	function formatRupiahShort(value) {
		var number = Number(value) || 0;
		var abs = Math.abs(number);
		var sign = number < 0 ? '-' : '';
		if (abs >= 1e12) return sign + 'Rp' + (abs / 1e12).toFixed(1).replace('.', ',') + ' T';
		if (abs >= 1e9) return sign + 'Rp' + (abs / 1e9).toFixed(1).replace('.', ',') + ' M';
		if (abs >= 1e6) return sign + 'Rp' + (abs / 1e6).toFixed(1).replace('.', ',') + ' jt';
		if (abs >= 1e3) return sign + 'Rp' + Math.round(abs / 1e3) + ' rb';
		return formatRupiah(number);
	}

	/** Percentages use the Indonesian decimal comma: 12,6%. */
	function formatPercent(value, decimals) {
		var digits = decimals === undefined ? 1 : decimals;
		return String(Number(value).toFixed(digits)).replace('.', ',') + '%';
	}

	function formatDate(value) {
		if (!value) return '';
		var parts = String(value).split('-');
		if (parts.length < 3) return value;
		var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
		var monthIndex = Number(parts[1]) - 1;
		if (monthIndex < 0 || monthIndex > 11) return value;
		return parts[2] + ' ' + monthNames[monthIndex] + ' ' + parts[0];
	}

	function escapeHtml(value) {
		return String(value === null || value === undefined ? '' : value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	/* ---------------------------------------------------------------- toasts */

	function toastHost() {
		var host = document.querySelector('.toast-host');
		if (!host) {
			host = document.createElement('div');
			host.className = 'toast-host';
			host.setAttribute('role', 'status');
			host.setAttribute('aria-live', 'polite');
			document.body.appendChild(host);
		}
		return host;
	}

	function toast(message, kind) {
		var node = document.createElement('div');
		node.className = 'toast' + (kind ? ' toast--' + kind : '');
		node.textContent = message;
		toastHost().appendChild(node);
		setTimeout(function () {
			node.remove();
		}, 4000);
	}

	/* ------------------------------------------------------------------- api */

	/**
	 * Fetch wrapper. Sends cookies, parses JSON, and redirects to the login
	 * page when the session has expired rather than leaving the page in a
	 * half-broken state.
	 */
	function api(path, options) {
		var settings = options || {};
		var init = {
			method: settings.method || 'GET',
			headers: Object.assign({ Accept: 'application/json' }, settings.headers || {}),
			credentials: 'same-origin'
		};

		if (settings.body !== undefined) {
			init.headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(settings.body);
		}

		return fetch(path, init).then(function (response) {
			if (response.status === 401 && !settings.allowUnauthenticated) {
				window.location.href = '/login?expired=1';
				throw new Error('Session expired');
			}

			var contentType = response.headers.get('content-type') || '';
			var isJson = contentType.indexOf('application/json') !== -1;
			var parsed = isJson ? response.json() : response.text();

			return parsed.then(function (payload) {
				if (!response.ok) {
					var message = payload && payload.error ? payload.error : 'Permintaan gagal (' + response.status + ')';
					var error = new Error(message);
					error.status = response.status;
					error.payload = payload;
					throw error;
				}
				return payload;
			});
		});
	}

	/* ---------------------------------------------------------------- modals */

	function openModal(id) {
		var modal = document.getElementById(id);
		if (!modal) return;
		modal.setAttribute('data-open', 'true');
		document.body.style.overflow = 'hidden';
		var focusable = modal.querySelector('input, select, textarea, button');
		if (focusable) focusable.focus();
	}

	function closeModal(id) {
		var modal = document.getElementById(id);
		if (!modal) return;
		modal.removeAttribute('data-open');
		document.body.style.overflow = '';
	}

	// Clicking the backdrop closes, Escape closes, and focus stays trapped inside
	// the dialog so keyboard users cannot tab into the page behind it.
	function wireModal(id) {
		var modal = document.getElementById(id);
		if (!modal) return;

		modal.addEventListener('mousedown', function (event) {
			if (event.target === modal) closeModal(id);
		});

		var panel = modal.querySelector('.modal__panel');
		if (panel) {
			panel.addEventListener('keydown', function (event) {
				if (event.key !== 'Tab') return;
				var focusable = panel.querySelectorAll('button, input, select, textarea, [href]');
				if (focusable.length === 0) return;
				var first = focusable[0];
				var last = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			});
		}
	}

	document.addEventListener('keydown', function (event) {
		if (event.key !== 'Escape') return;
		document.querySelectorAll('.modal[data-open="true"]').forEach(function (modal) {
			closeModal(modal.id);
		});
	});

	/* ------------------------------------------------------------------- nav */

	function wireNav() {
		var toggle = document.querySelector('[data-nav-toggle]');
		var drawer = document.querySelector('[data-nav-drawer]');
		if (!toggle || !drawer) return;

		toggle.addEventListener('click', function () {
			var open = drawer.getAttribute('data-open') === 'true';
			drawer.setAttribute('data-open', open ? 'false' : 'true');
			toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
		});

		document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
			button.addEventListener('click', function () {
				var next = preferredTheme() === 'dark' ? 'light' : 'dark';
				setTheme(next);
			});
		});

		var signOut = document.querySelector('[data-sign-out]');
		if (signOut) {
			signOut.addEventListener('click', function () {
				api('/api/auth/logout', { method: 'POST' }).finally(function () {
					window.location.href = '/login';
				});
			});
		}
	}

	// Mark the active nav item so the current page is obvious on desktop.
	function markActiveNav() {
		var path = window.location.pathname;
		document.querySelectorAll('.nav__link[href]').forEach(function (link) {
			if (link.getAttribute('href') === path) {
				link.setAttribute('aria-current', 'page');
			}
		});
	}

	/* -------------------------------------------------------------- boot */

	function boot() {
		wireNav();
		markActiveNav();
		document.querySelectorAll('.modal').forEach(function (modal) {
			wireModal(modal.id);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}

	window.App = {
		api: api,
		toast: toast,
		openModal: openModal,
		closeModal: closeModal,
		setTheme: setTheme,
		formatRupiah: formatRupiah,
		formatRupiahShort: formatRupiahShort,
		formatPercent: formatPercent,
		formatDate: formatDate,
		escapeHtml: escapeHtml
	};
})();