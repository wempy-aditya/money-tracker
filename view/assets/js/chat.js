/**
 * Advisor chat.
 *
 * The history is rendered newest-last for reading but the API returns it
 * newest-first, so the log is reversed before rendering. Assistant text is
 * escaped rather than injected: a provider response is untrusted content and can
 * legitimately contain characters that would otherwise become markup.
 */

(function () {
	'use strict';

	var sending = false;

	function log() {
		return document.getElementById('chatLog');
	}

	function bubble(role, content, timestamp) {
		var el = document.createElement('article');
		el.className = 'chat__msg chat__msg--' + (role === 'user' ? 'user' : 'ai');

		var who = document.createElement('span');
		who.className = 'chat__who';
		who.textContent = role === 'user' ? 'Anda' : 'Asisten';

		var body = document.createElement('div');

		if (role === 'user') {
			// What the user typed is shown verbatim. A message is not a document,
			// and rendering someone's own words back as markup is a surprise.
			body.className = 'chat__bubble';
			body.textContent = content;
		} else {
			// The advisor writes Markdown, so it is rendered. innerHTML is safe
			// here because renderMarkdown escapes the text before building any tag
			// and the only markup in the output is what that function emits.
			body.className = 'chat__bubble chat__bubble--md';
			body.innerHTML = App.renderMarkdown(content) || '<p class="md-p md-p--empty">(balasan kosong)</p>';
		}

		el.appendChild(who);
		el.appendChild(body);

		if (timestamp) {
			var time = document.createElement('span');
			time.className = 'chat__time';
			time.textContent = App.formatDate(timestamp);
			el.appendChild(time);
		}

		return el;
	}

	function render(messages) {
		var box = log();
		if (!box) return;
		box.innerHTML = '';

		if (!messages.length) {
			var empty = document.createElement('p');
			empty.className = 'empty__title';
			empty.textContent = 'Belum ada percakapan. Mulai dengan salah satu pertanyaan di bawah.';
			box.appendChild(empty);
			return;
		}

		// Oldest first, so the conversation reads downwards.
		messages.slice().reverse().forEach(function (message) {
			box.appendChild(bubble(message.role, message.content, message.created_at));
		});

		box.scrollTop = box.scrollHeight;
	}

	function renderSuggestions(items) {
		var box = document.getElementById('suggestions');
		if (!box) return;
		box.innerHTML = '';

		items.forEach(function (text) {
			var chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'chip';
			chip.textContent = text;
			chip.addEventListener('click', function () {
				var input = document.getElementById('chatInput');
				if (input) {
					input.value = text;
					input.focus();
				}
			});
			box.appendChild(chip);
		});
	}

	function setSetupNotice(visible, missing) {
		var notice = document.getElementById('setupNotice');
		var hint = document.getElementById('setupHint');
		if (!notice) return;

		notice.hidden = !visible;
		if (visible && hint) {
			var labels = { api_url: 'URL API', model: 'nama model', api_key: 'API key' };
			var names = (missing || []).map(function (key) {
				return labels[key] || key;
			});
			hint.textContent = 'Chat belum bisa menjawab karena belum diisi: ' + names.join(', ') + '.';
		}
	}

	function loadHistory() {
		return App.api('/api/chat')
			.then(function (data) {
				render(data.messages || []);
				return data;
			})
			.catch(function (error) {
				var box = log();
				if (box) box.textContent = 'Riwayat gagal dimuat: ' + (error.message || '');
			});
	}

	function loadSuggestions() {
		return App.api('/api/chat/suggestions')
			.then(renderSuggestions)
			.catch(function () {
				// Suggestions are a convenience; their absence should not block the page.
			});
	}

	function sendMessage(event) {
		event.preventDefault();
		if (sending) return;

		var input = document.getElementById('chatInput');
		var button = document.getElementById('chatSendButton');
		if (!input) return;

		var question = input.value.trim();
		if (question === '') return;

		// Every exit from here must release the flag. A throw between the guard
		// and the final handler would otherwise leave the composer dead for the
		// rest of the session, with no way to tell from the UI why.
		sending = true;
		if (button) button.disabled = true;
		input.value = '';

		try {
			runSend(question, button, input);
		} catch (error) {
			sending = false;
			if (button) button.disabled = false;
			App.toast('Gagal mengirim: ' + (error.message || 'galat tak diketahui'));
		}
	}

	function runSend(question, button, input) {

		// Show the question immediately rather than waiting for the round trip.
		var box = log();
		if (box) {
			var placeholder = box.querySelector('.empty__title');
			if (placeholder) placeholder.remove();
			box.appendChild(bubble('user', question));
			box.scrollTop = box.scrollHeight;
		}

		// Built with the DOM, not innerHTML: the same reason untrusted provider
		// text goes through textContent.
		var waiting = document.createElement('article');
		waiting.className = 'chat__msg chat__msg--ai';

		var waitingWho = document.createElement('span');
		waitingWho.className = 'chat__who';
		waitingWho.textContent = 'Asisten';

		var waitingBody = document.createElement('div');
		waitingBody.className = 'chat__bubble chat__bubble--pending';
		waitingBody.textContent = 'Menyusun jawaban...';

		waiting.appendChild(waitingWho);
		waiting.appendChild(waitingBody);

		// It has to be in the DOM before replaceChild can find it. Without this
		// the replace throws NotFoundError, the catch below swallows it, and the
		// answer only appears after a manual refresh because the history reload
		// is the only thing that redraws the log.
		if (box) {
			box.appendChild(waiting);
			box.scrollTop = box.scrollHeight;
		}

		App.api('/api/chat', { method: 'POST', body: { message: question } })
			.then(function (result) {
				if (box) box.replaceChild(bubble('assistant', result.answer.content, result.answer.created_at), waiting);
			})
			.catch(function (error) {
				var missing = (error.payload && error.payload.missing) || null;
				var configured = error.payload && error.payload.configured === false;

				if (configured) setSetupNotice(true, missing);

				if (box) {
					var failed = document.createElement('article');
					failed.className = 'chat__msg chat__msg--ai';

					var who = document.createElement('span');
					who.className = 'chat__who';
					who.textContent = 'Asisten';

					var body = document.createElement('div');
					body.className = 'chat__bubble chat__bubble--error';
					body.textContent = error.message || 'Gagal mengirim pertanyaan';

					failed.appendChild(who);
					failed.appendChild(body);
					box.replaceChild(failed, waiting);
					box.scrollTop = box.scrollHeight;
				}
			})
			.then(function () {
				sending = false;
				if (button) button.disabled = false;
				if (input) input.focus();
			}, function () {
				// A failure in the render path must not leave the form locked.
				sending = false;
				if (button) button.disabled = false;
			});
	}

	function clearHistory() {
		if (!window.confirm('Hapus seluruh riwayat percakapan?')) return;

		App.api('/api/chat', { method: 'DELETE' })
			.then(function () {
				render([]);
				App.toast('Riwayat dihapus');
			})
			.catch(function (error) {
				App.toast(error.message || 'Riwayat gagal dihapus');
			});
	}

	document.addEventListener('DOMContentLoaded', function () {
		var form = document.getElementById('chatForm');
		if (form) form.addEventListener('submit', sendMessage);

		var clearButton = document.getElementById('clearChatButton');
		if (clearButton) clearButton.addEventListener('click', clearHistory);

		// Enter submits, Shift+Enter makes a new line. A textarea alone would
		// need a modifier for the common case.
		var input = document.getElementById('chatInput');
		if (input) {
			input.addEventListener('keydown', function (event) {
				if (event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault();
					if (form) form.requestSubmit();
				}
			});
		}

		Promise.all([loadHistory(), loadSuggestions()]);
	});
})();