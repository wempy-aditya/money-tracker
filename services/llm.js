/**
 * OpenAI-compatible LLM client and the context the advisor is given.
 *
 * Everything here is about being honest about what the model knows. The context
 * is assembled from the database, not from the user's prose, so the model can
 * cite real numbers instead of inventing them. Where a figure is unavailable the
 * context says so explicitly rather than omitting it, because a model given a
 * partial picture tends to fill the gap confidently.
 *
 * The advisor is read-only by design: it receives no tool definitions, so it
 * cannot create a transaction, move money, or change a setting no matter what the
 * user types into the chat. Advice it gives is advice the user acts on
 * themselves.
 */

'use strict';

const { firestore } = require('../db/firestore');

const db = firestore();
const transactionsCollection = db.collection('transactions');
const walletsCollection = db.collection('wallets');

/** How much of the recent conversation to send. Older turns are summarised. */
const RECENT_MESSAGE_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONTEXT_TRANSACTIONS = 40;

/* -------------------------------------------------------------- llm client */

/** Joins a base URL and a path without doubling or dropping the slash. */
function endpointFor(baseUrl, path) {
	const trimmed = String(baseUrl).replace(/\/+$/, '');
	return `${trimmed}${path}`;
}

/**
 * A local Ollama or LM Studio usually needs no key at all, so the Authorization
 * header is only sent when one is configured.
 */
function buildHeaders(apiKey) {
	const headers = { 'Content-Type': 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

/**
 * Calls the provider. Errors are returned rather than thrown so the chat route
 * can record what went wrong next to the question that caused it.
 */
async function callModel(settings, messages, { maxTokens, temperature } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(endpointFor(settings.api_url, '/chat/completions'), {
			method: 'POST',
			headers: buildHeaders(settings.api_key),
			signal: controller.signal,
			body: JSON.stringify({
				model: settings.model,
				messages,
				temperature: temperature ?? settings.temperature ?? 0.7,
				max_tokens: maxTokens ?? settings.max_tokens ?? 1024,
				stream: false
			})
		});

		const text = await response.text();

		if (!response.ok) {
			// The body may be HTML from a captive portal or a wrong path, so trim
			// it rather than passing the whole thing into the chat record.
			return {
				ok: false,
				status: response.status,
				error: `Provider menolak permintaan (HTTP ${response.status}): ${text.slice(0, 300)}`
			};
		}

		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { ok: false, status: response.status, error: 'Respons bukan JSON yang valid' };
		}

		const choice = parsed.choices && parsed.choices[0];
		const content = choice && choice.message && choice.message.content;

		if (typeof content !== 'string' || content.trim() === '') {
			return { ok: false, status: response.status, error: 'Respons tidak memuat jawaban' };
		}

		return { ok: true, content: content.trim(), usage: parsed.usage || null, model: parsed.model || settings.model };
	} catch (error) {
		if (error.name === 'AbortError') {
			return { ok: false, status: 0, error: `Provider tidak merespons dalam ${REQUEST_TIMEOUT_MS / 1000} detik` };
		}
		return { ok: false, status: 0, error: `Gagal menghubungi provider: ${error.message}` };
	} finally {
		clearTimeout(timer);
	}
}

/** A minimal round trip used by the settings page to verify the connection. */
async function testConnection(userId) {
	const { ProfileStore } = require('../db/profile');
	const store = new ProfileStore(db.raw());
	const status = store.connectionStatus(userId);

	if (!status.configured) {
		return { ok: false, error: 'Pengaturan belum lengkap', missing: status.missing };
	}

	const settings = store.readSettingsWithKey(userId);
	const result = await callModel(
		settings,
		[
			{ role: 'system', content: 'You reply with one short word.' },
			{ role: 'user', content: 'Reply with exactly: OK' }
		],
		{ maxTokens: 16, temperature: 0 }
	);

	if (!result.ok) return { ok: false, error: result.error, status: result.status };

	return { ok: true, model: result.model, sample: result.content.slice(0, 80) };
}

/* --------------------------------------------------------- context builder */

const rupiah = (value) =>
	new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Math.round(value || 0));

function monthLabel(month) {
	const parts = String(month).split('-');
	const names = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
	return `${names[Number(parts[1]) - 1]} ${parts[0]}`;
}

function monthOffset(offset, base = new Date()) {
	const date = new Date(base.getFullYear(), base.getMonth() - offset, 1);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** The six-month money picture the advisor reasons from. */
async function financialSnapshot(userId) {
	const months = [];
	for (let i = 5; i >= 0; i--) months.push(monthOffset(i));
	const current = months[months.length - 1];

	const snapshot = await transactionsCollection
		.where('userId', '==', userId)
		.where('date', '>=', `${months[0]}-01`)
		.where('date', '<=', `${current}-31`)
		.get();

	const byMonth = new Map(months.map((m) => [m, { income: 0, expense: 0, byCategory: new Map() }]));

	for (const doc of snapshot.docs) {
		const tx = doc.data();
		const month = String(tx.date).slice(0, 7);
		const bucket = byMonth.get(month);
		if (!bucket) continue;

		if (tx.type === 'income') bucket.income += tx.amount;
		else {
			bucket.expense += tx.amount;
			const key = tx.category || 'Tanpa kategori';
			bucket.byCategory.set(key, (bucket.byCategory.get(key) || 0) + tx.amount);
		}
	}

	const wallets = await walletsCollection.where('userId', '==', userId).get();
	let total = 0;
	let frozen = 0;
	for (const doc of wallets.docs) {
		total += doc.data().balance || 0;
		frozen += doc.data().frozen || 0;
	}

	const rows = months.map((month) => {
		const bucket = byMonth.get(month);
		const categories = [...bucket.byCategory.entries()]
			.map(([name, amount]) => ({ name, amount: rupiah(amount) }))
			.sort((a, b) => Number(b.amount.replace(/\D/g, '')) - Number(a.amount.replace(/\D/g, '')));

		return {
			month,
			label: monthLabel(month),
			income: bucket.income,
			expense: bucket.expense,
			ratio: bucket.income > 0 ? Math.round((bucket.expense / bucket.income) * 1000) / 10 : null,
			categories
		};
	});

	const monthsWithIncome = rows.filter((r) => r.income > 0).length;
	const monthsWithExpense = rows.filter((r) => r.expense > 0).length;

	return {
		totalBalance: total,
		frozen,
		usable: total - frozen,
		months: rows,
		monthsWithIncome,
		monthsWithExpense,
		// The recent transactions, newest first, so a question about a specific
		// purchase can be checked against what was actually recorded.
		recentTransactions: snapshot.docs
			.map((doc) => doc.data())
			.sort((a, b) => String(b.date).localeCompare(String(a.date)))
			.slice(0, MAX_CONTEXT_TRANSACTIONS)
			.map((tx) => ({
				date: tx.date,
				type: tx.type,
				amount: rupiah(tx.amount),
				category: tx.category || null,
				subcategory: tx.subcategory || null,
				description: tx.description || null
			}))
	};
}

/** The profile, written as plain sentences rather than a JSON blob. */
function profileNarrative(profile) {
	const lines = [];
	const add = (label, value) => {
		if (value === null || value === undefined || value === '') return;
		lines.push(`- ${label}: ${value}`);
	};

	add('Nama', profile.display_name);
	add('Usia', profile.age !== null ? `${profile.age} tahun` : null);
	add('Pekerjaan', profile.occupation);
	add('Jabatan/posisi', profile.position);
	add('Pendidikan', profile.education);
	add('Latar belakang', profile.background);
	add('Hobi', profile.hobbies);
	add('Jumlah tanggungan', profile.dependents !== null ? `${profile.dependents} orang` : null);
	add('Komitmen bulanan', profile.monthly_commitments);
	add('Tujuan keuangan', profile.financial_goals);
	add('Profil risiko', profile.risk_tolerance);
	add('Catatan lain', profile.notes);

	return lines.length ? lines.join('\n') : '(profil belum diisi)';
}

/**
 * Turns the stored data into a context block. Every section states its own
 * coverage so the model does not read a six-month table as "six months of
 * activity" when it is really one month and five empty ones.
 */
function buildContextBlock(profile, snapshot) {
	const parts = [];

	parts.push('PROFIL PENGGUNA\n' + profileNarrative(profile));

	parts.push(
		'KONDISI KEUANGAN SAAT INI\n' +
			`Total saldo: Rp${rupiah(snapshot.totalBalance)}\n` +
			`Dana beku: Rp${rupiah(snapshot.frozen)}\n` +
			`Saldo bisa dipakai: Rp${rupiah(snapshot.usable)}`
	);

	const rows = snapshot.months
		.map((row) => {
			const parts2 = [`${row.label}: pemasukan Rp${rupiah(row.income)}, pengeluaran Rp${rupiah(row.expense)}`];
			if (row.ratio !== null) parts2.push(`rasio ${row.ratio}%`);
			if (row.categories.length) {
				const top = row.categories.slice(0, 4).map((c) => `${c.name} ${c.amount}`).join(', ');
				parts2.push(`kategori terbesar ${top}`);
			}
			return '- ' + parts2.join(', ');
		})
		.join('\n');

	parts.push(
		'TREN 6 BULAN TERAKHIR\n' +
			rows +
			`\nCatatan: hanya ${snapshot.monthsWithIncome} dari 6 bulan punya pemasukan tercatat, ` +
			`dan ${snapshot.monthsWithExpense} dari 6 bulan punya pengeluaran. ` +
			'Bulan tanpa data berarti tidak ada transaksi yang dicatat, bukan pengeluaran nol.'
	);

	if (snapshot.recentTransactions.length) {
		const lines = snapshot.recentTransactions
			.map((tx) => `${tx.date} ${tx.type} ${tx.amount}${tx.category ? ` (${tx.category}${tx.subcategory ? '/' + tx.subcategory : ''})` : ''}`)
			.join('\n');
		parts.push(
			`${snapshot.recentTransactions.length} TRANSAKSI TERBARU\n` +
				lines +
				'\nCatatan: daftar ini dipangkas, bukan seluruh riwayat.'
		);
	}

	return parts.join('\n\n');
}

/**
 * Summarises the older part of a conversation so it stays in view without the
 * token cost of replaying every turn. This is a plain extractive summary: it
 * keeps what was said rather than asking a model to compress it, which would mean
 * a second call on every question and a second chance to invent something.
 */
function summariseOlderMessages(messages) {
	if (messages.length === 0) return null;

	const questions = messages.filter((m) => m.role === 'user').slice(0, 12);
	const userTurns = questions
		.map((m, i) => `${i + 1}. ${m.content.replace(/\s+/g, ' ').slice(0, 140)}`)
		.join('\n');

	const decisions = messages
		.filter((m) => m.role === 'assistant')
		.map((m) => m.content.replace(/\s+/g, ' ').slice(0, 120))
		.slice(-6);

	const parts = [];
	if (userTurns) parts.push('Pertanyaan yang pernah diajukan:\n' + userTurns);
	if (decisions.length) {
		parts.push('Jawaban sebelumnya (ringkas):\n' + decisions.map((d, i) => `${i + 1}. ${d}`).join('\n'));
	}

	return parts.join('\n\n') || null;
}

/**
 * The system prompt. It states the read-only limit as a rule the model is asked
 * to respect, names the honesty requirement, and asks for advice that ends in
 * something the user can actually do.
 */
function systemPrompt(profileIncomplete) {
	const honesty = profileIncomplete
		? 'Profil pengguna belum lengkap. Sebutkan fakta yang belum ada secara terbuka dan jangan mengarang.'
		: 'Profil pengguna sudah terisi.';

	return [
		'Kamu adalah penasihat keuangan pribadi untuk satu pengguna, berbahasa Indonesia.',
		'',
		'Aturan yang wajib dijaga:',
		'1. Kamu HANYA memberi saran. Kamu tidak dapat membuat transaksi, memindahkan uang,',
		'   mengubah anggaran, atau melakukan tindakan apa pun pada aplikasi. Kalau pengguna',
		'   minta kamu melakukannya, katakan kamu tidak bisa dan sarankan langkah manualnya.',
		'2. Semua angka berasal dari KONTEKS yang diberikan. Jangan mengarang angka.',
		'   Kalau datanya tidak ada, katakan tidak ada, lalu tanyakan apa yang perlu dicatat.',
		'3. Bedakan dengan jelas antara fakta dari data dan perkiraanmu. Tulis "dari data"',
		'   untuk yang tercatat dan "perkiraan" untuk yang tidak.',
		'4. Ketika data tidak cukup untuk sesuatu, katakan tidak cukup. Jangan mengisi',
		'   kekosongan dengan angka yang terlihat masuk akal.',
		'',
		honesty,
		'',
		'Cara menjawab:',
		'- Mulai dari jawaban langsungnya, bukan dari basa-basi.',
		'- Pakai angka rupiah yang persis seperti di konteks.',
		'- Kalau ada keputusan yang perlu diambil (misal beli sesuatu), berikan rekomendasi',
		'  jelas dengan alasannya dari data, bukan daftar panjang tanpa kesimpulan.',
		'- Tutup dengan langkah konkret yang bisa dikerjakan hari ini.',
		'- Panjang secukupnya. Hindari mengulang isi konteks.'
	].join('\n');
}

/**
 * Builds the full message array: system prompt, the context block, a summary of
 * older turns, then the recent turns verbatim.
 */
function buildMessages({ settings, profile, snapshot, history }) {
	const messages = [
		{ role: 'system', content: systemPrompt(settings.profileIncomplete) },
		{ role: 'system', content: buildContextBlock(profile, snapshot) }
	];

	if (history.length > RECENT_MESSAGE_LIMIT) {
		const older = history.slice(0, history.length - RECENT_MESSAGE_LIMIT);
		const summary = summariseOlderMessages(older);
		if (summary) {
			messages.push({
				role: 'system',
				content: `RINGKASAN PERCAKAPAN SEBELUMNYA\n${summary}`
			});
		}
	}

	for (const turn of history.slice(-RECENT_MESSAGE_LIMIT)) {
		messages.push({ role: turn.role, content: turn.content });
	}

	return messages;
}

module.exports = {
	callModel,
	testConnection,
	buildMessages,
	buildContextBlock,
	financialSnapshot,
	summariseOlderMessages,
	systemPrompt,
	profileNarrative,
	RECENT_MESSAGE_LIMIT,
	endpointFor,
	buildHeaders
};