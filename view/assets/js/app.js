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

	/* ------------------------------------------------------------- markdown */

	/**
	 * A small Markdown renderer, built here rather than pulled in as a library.
	 *
	 * The project ships no CDN dependency and no build step, and a general purpose
	 * Markdown parser is far larger than what an advisor reply needs: headings,
	 * lists, emphasis, inline code, links, quotes, rules and tables.
	 *
	 * Safety is structural rather than a sanitising pass afterwards. Every piece of
	 * text is run through escapeHtml before any tag is added, and the only HTML in
	 * the output is generated from this function. A model reply containing
	 * <img src=x onerror=...> therefore renders as visible text, never as markup.
	 * Only http, https and mailto links survive; javascript: URLs are dropped
	 * before the href attribute is ever written.
	 */

	/**
	 * Decides whether a link may become an href. Anything rejected here still
	 * shows its label, just not as a link.
	 *
	 * http, https and mailto are allowed outright. A same-origin path is allowed
	 * too, so the advisor can point at a page in the app. That exception stops at
	 * a second slash: "//evil.test" looks like a path but the browser reads it as
	 * another host, and "//evil.test" is exactly the kind of thing a reply is
	 * supposed to never be able to produce.
	 */
	function safeHref(url) {
		var trimmed = String(url || '').trim();

		if (/^https?:\/\//i.test(trimmed)) return trimmed;
		if (/^mailto:/i.test(trimmed)) return trimmed;

		// A path into this app: one leading slash, then not another slash.
		if (/^\/(?!\/)[^\s]*$/.test(trimmed)) return trimmed;

		return null;
	}

	/**
	 * Inline formatting, applied to already-escaped text.
	 *
	 * Code spans are extracted first and stashed, because their contents must not
	 * be processed further: `**` inside a code span is literal, and turning it
	 * bold would be wrong.
	 */
	function inlineMarkdown(escaped) {
		var code = [];

		var held = String(escaped).replace(/`([^`]+)`/g, function (match, body) {
			code.push(body);
			return '\u0000CODE' + (code.length - 1) + '\u0000';
		});

		// Bold before italic so ** is not read as two separate emphasis markers.
		held = held.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		held = held.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
		held = held.replace(/(^|[^_])__([^_]+)__/g, '$1<strong>$2</strong>');

		// Greedy on the href so a URL containing ")" does not leave a stray
		// bracket behind in the visible text.
		held = held.replace(/\[([^\]]+)\]\(([^\s]+)\)/g, function (match, label, href) {
			var target = safeHref(href);
			if (!target) return label;
			return '<a href="' + target + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
		});

		return held.replace(/\u0000CODE(\d+)\u0000/g, function (match, index) {
			return '<code>' + code[Number(index)] + '</code>';
		});
	}

	/**
	 * Renders Markdown to an HTML string. See the note above for why the output is
	 * safe to assign to innerHTML.
	 */
	function renderMarkdown(source) {
		var lines = App.escapeHtml(String(source === null || source === undefined ? '' : source)).split('\n');
		var html = [];
		var list = null;   // 'ul' | 'ol' | null
		var quote = [];
		var fence = null;
		var table = null;

		function closeList() {
			if (list) {
				html.push('</' + list + '>');
				list = null;
			}
		}

		function closeQuote() {
			if (quote.length) {
				html.push('<blockquote>' + inlineMarkdown(quote.join('<br>')) + '</blockquote>');
				quote = [];
			}
		}

		function closeTable() {
			if (!table) return;
			var head = table[0];
			var body = table.slice(2);
			html.push('<div class="table-wrap"><table><thead><tr>');
			head.forEach(function (cell) {
				html.push('<th>' + inlineMarkdown(cell.trim()) + '</th>');
			});
			html.push('</tr></thead><tbody>');
			body.forEach(function (row) {
				html.push('<tr>');
				row.forEach(function (cell) {
					html.push('<td>' + inlineMarkdown(cell.trim()) + '</td>');
				});
				html.push('</tr>');
			});
			html.push('</tbody></table></div>');
			table = null;
		}

		function closeAll() {
			closeList();
			closeQuote();
			closeTable();
		}

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var trimmed = line.trim();

			// A fenced code block is literal all the way through, no formatting.
			var fenceMatch = trimmed.match(/^```(\w*)\s*$/);
			if (fenceMatch) {
				if (fence === null) {
					closeAll();
					fence = [];
				} else {
					html.push('<pre class="md-code"><code>' + fence.join('\n') + '</code></pre>');
					fence = null;
				}
				continue;
			}
			if (fence !== null) {
				fence.push(line);
				continue;
			}

			if (!trimmed) {
				closeAll();
				continue;
			}

			// Table row: | a | b |  with a separator under the header.
			if (trimmed.charAt(0) === '|') {
				var cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
				var isDivider = /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(trimmed);

				if (!table) {
					// The header has to come first; a stray body row before any
					// header is not a table, so it stays a paragraph.
					if (isDivider) {
						closeTable();
						html.push('<p class="md-p">' + inlineMarkdown(trimmed) + '</p>');
					} else {
						table = [cells];
					}
					continue;
				}

				// Row two is the divider between header and body. Everything after
				// it is body, and rows after that are appended as they come.
				if (isDivider && table.length === 1) {
					table.push(cells);
					continue;
				}
				table.push(cells);
				continue;
			}
			closeTable();

			var heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
			if (heading) {
				closeAll();
				// Plain text nodes, not h1: a reply inside the page must not
				// compete with the page's own heading for the document outline.
				var level = heading[1].length;
				html.push('<div class="md-h md-h' + level + '">' + inlineMarkdown(heading[2]) + '</div>');
				continue;
			}

			if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
				closeAll();
				html.push('<hr class="md-rule">');
				continue;
			}

			if (/^&gt;\s?/.test(trimmed)) {
				closeList();
				quote.push(trimmed.replace(/^&gt;\s?/, ''));
				continue;
			}
			closeQuote();

			var bullet = trimmed.match(/^[-*+]\s+(.*)$/);
			if (bullet) {
				closeTable();
				if (list !== 'ul') {
					closeList();
					html.push('<ul class="md-list">');
					list = 'ul';
				}
				html.push('<li>' + inlineMarkdown(bullet[1]) + '</li>');
				continue;
			}

			var numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
			if (numbered) {
				closeTable();
				if (list !== 'ol') {
					closeList();
					html.push('<ol class="md-list">');
					list = 'ol';
				}
				html.push('<li>' + inlineMarkdown(numbered[2]) + '</li>');
				continue;
			}

			closeAll();
			html.push('<p class="md-p">' + inlineMarkdown(trimmed) + '</p>');
		}

		if (fence !== null) {
			// An unterminated fence should still show its contents, not swallow them.
			html.push('<pre class="md-code"><code>' + fence.join('\n') + '</code></pre>');
		}
		closeAll();

		return html.join('');
	}

/* ------------------------------------------------------------ sorting */

	/**
	 * Client-side sorting for the five list pages.
	 *
	 * Each page already loads its whole list into memory to render it, so sorting
	 * here costs nothing and keeps the API unchanged. Pushing it to the server
	 * would mean a second contract, and the sort would reset whenever the list
	 * was re-fetched, which is exactly when someone is trying to read it.
	 *
	 * A sort control is a select for the field and a second one for the
	 * direction. The direction control is disabled while no field is chosen, so
	 * it never offers a choice that has no effect.
	 */
	function createSortControl(options) {
		var config = options || {};
		var selectId = config.selectId;
		var directionId = config.directionId;
		var label = config.label || 'Urutkan';

		var select = document.getElementById(selectId);
		var direction = document.getElementById(directionId);
		if (!select || !direction) return null;

		var fields = config.fields || [];
		var keys = config.keys || fields.map(function (field) { return field.value; });

		// A field can declare which way it should read the first time it is
		// chosen. Names want A to Z; an amount or a date wants the largest or
		// the newest first. Defaulting everything to descending meant choosing
		// "sort by name" gave you Z to A, which nobody means.
		var defaultDirectionFor = function (key) {
			var index = keys.indexOf(key);
			if (index === -1) return config.defaultDirection || 'desc';
			if (fields[index].defaultDirection) return fields[index].defaultDirection;
			return config.defaultDirection || 'desc';
		};

		// Stored on the object so a page can re-render without re-reading the DOM.
		var state = {
			key: config.defaultKey || '',
			direction: config.defaultKey
				? defaultDirectionFor(config.defaultKey)
				: (config.defaultDirection || 'desc')
		};

		var accessorFor = function (key) {
			var index = keys.indexOf(key);
			return index === -1 ? null : fields[index].get;
		};

		function apply(rows) {
			var get = accessorFor(state.key);
			if (!get) return rows;

			var sign = state.direction === 'asc' ? 1 : -1;

			// A copy: sort() mutates, and callers keep passing their own array.
			return rows.slice().sort(function (a, b) {
				var left = get(a);
				var right = get(b);

				// A row with no value for this field goes last whichever way the
				// sort runs. Comparing it as an empty string would put it first
				// in an ascending sort, so a wallet with no name would sort above
				// every wallet that has one.
				//
				// An empty string counts as no value too. A transaction saved
				// without a category reads "-" in the table, and sorting by
				// category would otherwise park every one of those at the top,
				// above real categories, because "" precedes everything.
				var leftMissing = left == null || left === '';
				var rightMissing = right == null || right === '';

				if (leftMissing && rightMissing) return 0;
				if (leftMissing) return 1;
				if (rightMissing) return -1;

				// Numbers compare as numbers. Everything else compares as text,
				// so a wallet named "10 Kas" lands next to "2 Bank" by name rather
				// than by string length or by an accidental numeric coercion.
				if (typeof left === 'number' && typeof right === 'number') {
					return (left - right) * sign;
				}

				return String(left).localeCompare(String(right), 'id', { numeric: true }) * sign;
			});
		}

		// Field options. The first entry is the "no field" choice, and it is the
		// one the list starts on, so the page keeps the order the API gave.
		select.innerHTML = ['<option value="">' + escapeHtml(label) + '</option>'].concat(
			fields.map(function (field) {
				return '<option value="' + escapeHtml(field.value) + '">' +
					escapeHtml(field.label) + '</option>';
			})
		).join('');

		direction.disabled = true;

		select.addEventListener('change', function () {
			state.key = select.value;

			if (state.key) {
				// A new field starts in the direction that field reads best in,
				// rather than inheriting whatever the previous one was left at.
				state.direction = defaultDirectionFor(state.key);
				direction.value = state.direction;
			}

			direction.disabled = !state.key;
			emit('sort:changed');
		});

		direction.addEventListener('change', function () {
			state.direction = direction.value === 'asc' ? 'asc' : 'desc';
			emit('sort:changed');
		});

		return {
			apply: apply,
			state: state,
			reset: function () {
				state.key = config.defaultKey || '';
				state.direction = state.key
					? defaultDirectionFor(state.key)
					: (config.defaultDirection || 'desc');
				select.value = state.key;
				direction.value = state.direction;
				direction.disabled = !state.key;
			}
		};
	}

	/* ------------------------------------------------------- wallet kinds */

	/**
	 * What a wallet is for.
	 *
	 * A balance alone does not say whether money can leave the account at an ATM
	 * or whether it is money that is already spoken for, and the type is the
	 * difference between those two. The kind also drives the icon, so a list of
	 * wallets is scannable before a word is read.
	 *
	 * Keys are stored values and must stay stable: a rename would orphan every
	 * wallet already tagged with the old key. Labels are shown to the user.
	 *
	 * Icons are inline SVG rather than an icon font or an image request, for the
	 * same reason the rest of the app has no CDN dependency: one more thing to
	 * load, and one more thing that can fail to load. Each is drawn on a 24x24
	 * grid with a 1.75 stroke so they sit at the same weight as the rest of the
	 * interface.
	 */
	var WALLET_KINDS = {
		bank: { label: 'Rekening bank', icon: 'bank' },
		ewallet: { label: 'E-wallet', icon: 'phone' },
		cash: { label: 'Tunai', icon: 'cash' },
		savings: { label: 'Tabungan', icon: 'piggy' },
		investment: { label: 'Investasi', icon: 'chart' },
		credit: { label: 'Kartu kredit', icon: 'card' },
		other: { label: 'Lainnya', icon: 'wallet' }
	};

	function walletKindLabel(kind) {
		var entry = Object.prototype.hasOwnProperty.call(WALLET_KINDS, kind)
			? WALLET_KINDS[kind]
			: null;
		return entry ? entry.label : WALLET_KINDS.other.label;
	}

	var WALLET_ICONS = {
		bank: '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v8"/><path d="M10 10v8"/><path d="M14 10v8"/>' +
			'<path d="M19 10v8"/><path d="M3 20h18"/>',
		phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/>' +
			'<path d="M10.5 18.5h3"/>',
		cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/>' +
			'<circle cx="12" cy="12" r="2.75"/><path d="M6 9.5v5"/><path d="M18 9.5v5"/>',
		piggy: '<path d="M4 12.5c0-3.6 3.2-6 7.4-6 1 0 2 .15 2.9.44l2.4-1.5v2.5c1 .8 1.7 1.8 2 2.9' +
			'v2.4l-2.1.9c-.5.7-1.2 1.3-2 1.7v2.2h-2.5v-1.3c-.6.1-1.2.2-1.8.2h-1' +
			'v1.1H7.4v-1.6C5.2 13.9 4 13.3 4 12.5Z"/><circle cx="8" cy="11" r=".6" fill="currentColor"/>',
		chart: '<path d="M4 19.5V4.5"/><path d="M4 19.5h16"/><path d="M8 15.5V11"/>' +
			'<path d="M12 15.5V7.5"/><path d="M16 15.5v-3"/>',
		card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/>' +
			'<path d="M2.5 9.5h19"/><path d="M6 15h3.5"/>',
		wallet: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h11A2.5 2.5 0 0 1 19 7.5V9"/>' +
			'<path d="M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2.5"/>' +
			'<path d="M21 10.5h-4.25a2.25 2.25 0 0 0 0 4.5H21a1 1 0 0 0 1-1v-2.5a1 1 0 0 0-1-1Z"/>'
	};

	/**
	 * Wallet icon markup. `class` and `size` are callers' choices; the path set
	 * comes from a fixed table, so nothing from user data reaches the markup.
	 */
	function walletIcon(kind, extraClass) {
		// hasOwnProperty, not a plain lookup: WALLET_ICONS is an object literal,
		// so '__proto__' and 'constructor' are real inherited keys and would
		// otherwise resolve to something that is not a path.
		var iconName = WALLET_KINDS[kind] ? WALLET_KINDS[kind].icon : 'wallet';
		var path = Object.prototype.hasOwnProperty.call(WALLET_ICONS, iconName)
			? WALLET_ICONS[iconName]
			: WALLET_ICONS.wallet;
		return '<svg class="kind-icon' + (extraClass ? ' ' + extraClass : '') + '"' +
			' viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"' +
			' stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"' +
			' aria-hidden="true" focusable="false">' + path + '</svg>';
	}

	/**
	 * A small tag with its icon, used on a wallet card and in the list of kinds.
	 * An unknown key falls back to "Lainnya" rather than rendering an empty tag,
	 * which is what a wallet created before the feature existed will hit.
	 */
	function walletKindTag(kind) {
		var known = Object.prototype.hasOwnProperty.call(WALLET_KINDS, kind);
		return '<span class="kind-tag' + (known ? '' : ' kind-tag--unknown') + '">' +
			walletIcon(kind) +
			'<span>' + escapeHtml(walletKindLabel(kind)) + '</span></span>';
	}

	/* ------------------------------------------------------- tiny event bus */

	/**
	 * The sort controls live in app.js but the lists they reorder live in each
	 * page's own script, and neither file knows the other's variable names.
	 * One event is cheaper than five callbacks registered by hand.
	 */
	var listeners = {};

	function on(event, handler) {
		(listeners[event] = listeners[event] || []).push(handler);
	}

	function emit(event, payload) {
		(listeners[event] || []).forEach(function (handler) {
			try {
				handler(payload);
			} catch (error) {
				// One page's sort must not take the others down with it.
				console.error('handler for ' + event + ' failed', error);
			}
		});
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

	/**
	 * The overflow menu.
	 *
	 * Written as a small disclosure rather than a hover menu: hover alone does
	 * not exist on a touch screen, and a menu that only opens with a pointer is
	 * unreachable with a keyboard. Escape closes it, a click outside closes it,
	 * and choosing a destination lets the navigation happen.
	 */
	function wireNavGroup() {
		var button = document.querySelector('[data-nav-group-toggle]');
		var menu = document.querySelector('[data-nav-group-menu]');
		if (!button || !menu) return;

		function setOpen(open) {
			menu.hidden = !open;
			button.setAttribute('aria-expanded', open ? 'true' : 'false');
		}

		button.addEventListener('click', function (event) {
			event.stopPropagation();
			setOpen(menu.hidden);
		});

		// A click anywhere else dismisses it. Captured, because a click that lands
		// on another control would otherwise leave the menu open behind it.
		document.addEventListener('click', function (event) {
			if (!menu.hidden && !menu.contains(event.target)) setOpen(false);
		});

		document.addEventListener('keydown', function (event) {
			if (event.key === 'Escape' && !menu.hidden) {
				setOpen(false);
				// Focus goes back to the button, otherwise it drops to the top of
				// the document and keyboard users lose their place entirely.
				button.focus();
			}
		});

		setOpen(false);
	}

	function wireNav() {
		wireNavGroup();

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
		var activeInsideMenu = false;

		document.querySelectorAll('.nav__link[href]').forEach(function (link) {
			if (link.getAttribute('href') === path) {
				link.setAttribute('aria-current', 'page');
				if (link.closest('[data-nav-group-menu]')) activeInsideMenu = true;
			}
		});

		// The page you are on may well be behind the menu. Marking the link is not
		// enough on its own, because the menu is closed and the link is not
		// visible, so the button that opens it gets the indication as well.
		if (activeInsideMenu) {
			var button = document.querySelector('[data-nav-group-toggle]');
			if (button) {
				button.setAttribute('aria-current', 'true');
				button.classList.add('nav__link--contains-current');
			}
		}
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
		escapeHtml: escapeHtml,
		renderMarkdown: renderMarkdown,
		createSortControl: createSortControl,
		WALLET_KINDS: WALLET_KINDS,
		walletKindLabel: walletKindLabel,
		walletIcon: walletIcon,
		walletKindTag: walletKindTag,
		on: on,
		emit: emit
	};
})();