/**
 * Profile, LLM settings, and the advisor chat.
 *
 * The provider is stubbed at the fetch boundary, so these tests never touch the
 * network. The stub records exactly what was sent, which is the only way to
 * assert the two things that matter most here: that the model receives real
 * numbers from the database, and that it never receives the API key.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');
const { ProfileStore, PROFILE_FIELDS } = require('../db/profile');

let runCounter = 0;

async function signUp(username) {
	const agent = request.agent(app);
	const unique = `${username}-${process.pid}-${runCounter++}`;
	const res = await agent
		.post('/api/auth/register')
		.send({ username: unique, password: 'supersecret123' });
	assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
	return { agent, username: unique };
}

/**
 * Replaces global fetch and records every call. Returns the captured requests so
 * a test can assert on the request body the provider would have received.
 */
function stubProvider(handler) {
	const calls = [];
	const original = global.fetch;
	global.fetch = async (url, options = {}) => {
		calls.push({ url: String(url), options, body: safeParse(options.body) });
		return handler(url, options, calls.length);
	};
	return {
		calls,
		async restore() {
			global.fetch = original;
		}
	};
}

function safeParse(text) {
	if (typeof text !== 'string') return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function providerReply(content) {
	return new Response(
		JSON.stringify({
			model: 'stub-model',
			choices: [{ message: { role: 'assistant', content } }],
			usage: { total_tokens: 42 }
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

/** Fills in a profile and a working LLM config in one step. */
async function configure(agent, overrides = {}) {
	await agent.put('/api/profile').send({
		display_name: 'Wempy',
		age: 27,
		occupation: 'Software engineer',
		financial_goals: 'Beli rumah',
		monthly_commitments: 'Sewa 2 juta',
		...overrides.profile
	});

	await agent.put('/api/settings').send({
		api_url: 'http://127.0.0.1:11434/v1',
		model: 'llama3',
		api_key: overrides.api_key || 'sk-test-secret-value',
		...overrides.settings
	});
}

/* ------------------------------------------------------------------ profile */

test('a new user gets an empty profile, not an error', async () => {
	const { agent } = await signUp('prof-empty');
	const res = await agent.get('/api/profile');

	assert.equal(res.status, 200);
	assert.equal(res.body.display_name, null);
	assert.equal(res.body.age, null);
	assert.equal(res.body.updated_at, null);
});

test('the profile saves and reloads intact', async () => {
	const { agent } = await signUp('prof-save');

	const saved = await agent.put('/api/profile').send({
		display_name: 'Wempy Aditya',
		age: 27,
		occupation: 'Software engineer',
		education: 'S1 Informatika',
		position: 'Backend engineer',
		background: 'Bekerja sejak 2021, freelance di sela',
		hobbies: 'Gitar, membaca',
		dependents: 1,
		monthly_commitments: 'Sewa 2jt, listrik, internet',
		financial_goals: 'Beli rumah dan dana darurat 6 bulan',
		risk_tolerance: 'Menengah',
		notes: 'Hindari utang'
	});
	assert.equal(saved.status, 200);

	const read = await agent.get('/api/profile');
	assert.equal(read.body.display_name, 'Wempy Aditya');
	assert.equal(read.body.age, 27);
	assert.equal(read.body.dependents, 1);
	assert.equal(read.body.risk_tolerance, 'Menengah');
});

test('every profile field survives a save', async () => {
	const { agent } = await signUp('prof-fields');

	const payload = {};
	for (const field of PROFILE_FIELDS) payload[field] = `nilai ${field}`;
	payload.age = 30;
	payload.dependents = 2;

	await agent.put('/api/profile').send(payload);
	const read = await agent.get('/api/profile');

	for (const field of PROFILE_FIELDS) {
		assert.equal(read.body[field], `nilai ${field}`, `${field} was lost`);
	}
});

test('bad profile values are cleaned rather than stored broken', async () => {
	const { agent } = await signUp('prof-bad');

	await agent.put('/api/profile').send({
		display_name: '   ',
		age: 'bukan angka',
		dependents: -5,
		background: 'x'.repeat(900)
	});

	const read = await agent.get('/api/profile');
	assert.equal(read.body.display_name, null, 'blank becomes unset');
	assert.equal(read.body.age, null, 'a non-number becomes unset, not NaN');
	assert.equal(read.body.dependents, 0, 'negative clamps to zero');
	assert.ok(read.body.background.length <= 500, 'long text is capped');
});

test('saving twice updates one profile rather than stacking', async () => {
	const { agent } = await signUp('prof-upsert');

	await agent.put('/api/profile').send({ display_name: 'A', age: 20 });
	await agent.put('/api/profile').send({ display_name: 'B', age: 30 });

	const read = await agent.get('/api/profile');
	assert.equal(read.body.display_name, 'B');
	assert.equal(read.body.age, 30);

	const { ProfileStore } = require('../db/profile');
	const { firestore } = require('../db/firestore');
	const raw = new ProfileStore(firestore().raw());
	const rows = raw.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?')
		.get((await agent.get('/api/auth/me')).body.user.userId);
	assert.equal(rows.n, 1, 'a user must have exactly one profile row');
});

test('profile completeness reports what is missing', async () => {
	const { agent } = await signUp('prof-complete');

	const empty = await agent.get('/api/profile/completeness');
	assert.equal(empty.body.percent, 0);
	assert.ok(empty.body.missing.length > 0);
	assert.equal(empty.body.hasBasics, false);

	await agent.put('/api/profile').send({ age: 27, occupation: 'Engineer', financial_goals: 'Rumah' });
	const filled = await agent.get('/api/profile/completeness');
	assert.ok(filled.body.percent > 0);
	assert.equal(filled.body.hasBasics, true);
});

/* ----------------------------------------------------------------- settings */

test('the api key is never returned by any read', async () => {
	const { agent } = await signUp('set-key');

	const saved = await agent.put('/api/settings').send({
		api_url: 'https://api.example.com/v1',
		model: 'gpt-4o-mini',
		api_key: 'sk-super-secret-12345'
	});
	assert.equal(saved.status, 200);

	// The write response
	assert.equal(JSON.stringify(saved.body).includes('sk-super-secret'), false, 'write response leaked the key');
	// has_key is the only trace
	assert.equal(saved.body.has_key, true);

	// The read
	const read = await agent.get('/api/settings');
	assert.equal(JSON.stringify(read.body).includes('sk-super-secret'), false, 'read leaked the key');
	assert.equal(read.body.has_key, true);
	assert.equal(read.body.api_url, 'https://api.example.com/v1');
	assert.equal(read.body.model, 'gpt-4o-mini');

	// And the profile page's other endpoint must not leak it either
	const completeness = await agent.get('/api/profile/completeness');
	assert.equal(JSON.stringify(completeness.body).includes('sk-super-secret'), false);
});

test('saving another field keeps the stored key', async () => {
	const { agent } = await signUp('set-keep');

	await agent.put('/api/settings').send({
		api_url: 'https://api.example.com/v1',
		model: 'gpt-4o-mini',
		api_key: 'sk-keep-me'
	});

	// The form sends no api_key field at all when the user did not retype it.
	const updated = await agent.put('/api/settings').send({
		api_url: 'https://api.example.com/v1',
		model: 'gpt-4o-mini',
		temperature: 0.2
	});

	assert.equal(updated.body.has_key, true, 'an untouched key field must not erase the key');

	const stub = stubProvider(() => providerReply('ok'));
	try {
		const chat = await agent.post('/api/chat').send({ message: 'halo' });
		assert.equal(chat.status, 200);
		assert.equal(
			stub.calls[0].options.headers.Authorization,
			'Bearer sk-keep-me',
			'the stored key must still be used'
		);
	} finally {
		await stub.restore();
	}
});

test('an explicit empty key clears it', async () => {
	const { agent } = await signUp('set-clear');

	await agent.put('/api/settings').send({ api_url: 'https://x.test/v1', model: 'm', api_key: 'sk-gone' });
	const cleared = await agent.put('/api/settings').send({ api_key: '' });

	assert.equal(cleared.body.has_key, false);
});

test('a settings url must be http or https', async () => {
	const { agent } = await signUp('set-url');

	for (const bad of ['file:///etc/passwd', 'ftp://x.test', 'bukan-url']) {
		const res = await agent.put('/api/settings').send({ api_url: bad, model: 'm' });
		assert.equal(res.status, 400, `${bad} should be rejected`);
	}

	const ok = await agent.put('/api/settings').send({ api_url: 'https://ok.test/v1', model: 'm' });
	assert.equal(ok.status, 200);
});

test('connection status names exactly what is missing', async () => {
	const { agent } = await signUp('set-status');

	let res = await agent.get('/api/settings');
	assert.equal(res.body.configured, false);
	assert.deepEqual(res.body.missing, ['api_url', 'model', 'api_key']);

	await agent.put('/api/settings').send({ api_url: 'https://x.test/v1' });
	res = await agent.get('/api/settings');
	assert.deepEqual(res.body.missing, ['model', 'api_key']);
});

test('testing the connection reports provider failure instead of throwing', async () => {
	const { agent } = await signUp('set-test');
	await agent.put('/api/settings').send({ api_url: 'https://x.test/v1', model: 'm', api_key: 'sk' });

	const stub = stubProvider(() => new Response('nope', { status: 401 }));
	try {
		const res = await agent.post('/api/settings/test');
		assert.equal(res.status, 502);
		assert.match(res.body.error, /401/);
	} finally {
		await stub.restore();
	}

	// Unconfigured: refused before any network call.
	const { agent: bare } = await signUp('set-test-bare');
	const refused = await bare.post('/api/settings/test');
	assert.equal(refused.status, 400);
	assert.deepEqual(refused.body.missing, ['api_url', 'model', 'api_key']);
});

/* --------------------------------------------------------------------- chat */

test('chat refuses to answer when unconfigured but still records the question', async () => {
	const { agent } = await signUp('chat-unconfigured');

	const res = await agent.post('/api/chat').send({ message: 'berapa saldo saya?' });
	assert.equal(res.status, 409);
	assert.deepEqual(res.body.missing, ['api_url', 'model', 'api_key']);

	const history = await agent.get('/api/chat');
	assert.equal(history.body.messages.length, 2, 'question and refusal are both kept');
	// The list is newest-first, so the refusal leads.
	assert.equal(history.body.messages[0].role, 'assistant');
	assert.match(history.body.messages[0].content, /belum lengkap/i);
	assert.equal(history.body.messages[1].role, 'user');
	assert.equal(history.body.messages[1].content, 'berapa saldo saya?');
});

test('an empty question is rejected and not recorded', async () => {
	const { agent } = await signUp('chat-empty');

	assert.equal((await agent.post('/api/chat').send({ message: '   ' })).status, 400);
	assert.equal((await agent.post('/api/chat').send({})).status, 400);

	const history = await agent.get('/api/chat');
	assert.equal(history.body.total, 0, 'nothing should be stored for an empty question');
});

test('the model receives real numbers from the database', async () => {
	const { agent } = await signUp('chat-numbers');
	await configure(agent);

	// A wallet and a transaction, so there is something true to be accurate about.
	const wallet = (await agent.post('/api/wallets').send({ name: 'BCA', balance: 25_000_000 })).body;
	await agent.post('/api/transactions').send({
		date: '2026-10-05', amount: 4_000_000, type: 'expense',
		category: 'Tagihan', subcategory: 'Listrik', walletId: wallet.id
	});

	const stub = stubProvider(() => providerReply('Boleh.'));
	try {
		const res = await agent.post('/api/chat').send({ message: 'apakah cukup buat bayar?' });
		assert.equal(res.status, 200);

		const sent = stub.calls[0].body;
		const context = sent.messages.map((m) => m.content).join('\n');

		// 25.000.000 created, minus the 4.000.000 expense just recorded: recording a
		// transaction moves the balance, which is what the advisor should be told.
		assert.ok(context.includes('21.000.000'), 'the real balance must reach the model');
		assert.ok(context.includes('Listrik'), 'the recorded category must reach the model');
		assert.ok(context.includes('Wempy'), 'the profile must reach the model');
		assert.ok(context.includes('Software engineer'), 'the occupation must reach the model');
		assert.ok(context.includes('Beli rumah'), 'the stated goal must reach the model');

		// And it must be told the coverage is thin rather than assuming six months.
		assert.match(context, /hanya \d+ dari 6 bulan/);
	} finally {
		await stub.restore();
	}
});

test('the api key is sent to the provider and never into the conversation', async () => {
	const { agent } = await signUp('chat-key');
	await configure(agent, { api_key: 'sk-do-not-log-me' });

	const stub = stubProvider(() => providerReply('Baik.'));
	try {
		await agent.post('/api/chat').send({ message: 'halo' });

		// It is used for the Authorization header.
		assert.equal(stub.calls[0].options.headers.Authorization, 'Bearer sk-do-not-log-me');

		// But it never appears in the request body the provider was shown.
		assert.equal(stub.calls[0].body.messages.map((m) => m.content).join('\n').includes('sk-do-not-log-me'), false);

		// Nor in the history the user can read back.
		const history = await agent.get('/api/chat');
		assert.equal(JSON.stringify(history.body).includes('sk-do-not-log-me'), false);
	} finally {
		await stub.restore();
	}
});

test('a provider failure is recorded next to the question', async () => {
	const { agent } = await signUp('chat-fail');
	await configure(agent);

	const stub = stubProvider(() => new Response('rate limited', { status: 429 }));
	try {
		const res = await agent.post('/api/chat').send({ message: 'pertanyaan yang gagal' });
		assert.equal(res.status, 502);
		assert.match(res.body.error, /429/);
	} finally {
		await stub.restore();
	}

	const history = await agent.get('/api/chat');
	assert.equal(history.body.total, 2, 'a failed exchange is still history');
	assert.match(history.body.messages[0].content, /Gagal/);
	assert.equal(history.body.messages[1].content, 'pertanyaan yang gagal');
});

test('older turns are summarised rather than replayed whole', async () => {
	const { agent } = await signUp('chat-summary');
	await configure(agent);

	// Ask enough questions to push the conversation past the recent window.
	for (let i = 0; i < 24; i++) {
		const stub = stubProvider(() => providerReply(`Jawaban nomor ${i}`));
		try {
			await agent.post('/api/chat').send({ message: `Pertanyaan nomor ${i}` });
		} finally {
			await stub.restore();
		}
	}

	const stub = stubProvider(() => providerReply('Jawaban terakhir.'));
	try {
		await agent.post('/api/chat').send({ message: 'dan sekarang?' });

		const sent = stub.calls[0].body.messages;
		const text = sent.map((m) => m.content).join('\n');

		assert.ok(text.includes('RINGKASAN PERCAKAPAN SEBELUMNYA'), 'older turns are summarised');
		assert.ok(text.includes('Pertanyaan nomor 0'), 'the oldest question survives in the summary');

		// The recent turns are still verbatim, not summarised.
		assert.ok(text.includes('dan sekarang?'), 'the live question is present verbatim');

		// And the whole history was not resent: 50 messages would be the history.
		assert.ok(sent.length < 40, `expected a bounded context, got ${sent.length} messages`);
	} finally {
		await stub.restore();
	}
});

test('the advisor is told it cannot act, and gets no tools', async () => {
	const { agent } = await signUp('chat-readonly');
	await configure(agent);

	const stub = stubProvider(() => providerReply('Saya tidak bisa.'));
	try {
		await agent.post('/api/chat').send({ message: 'belikan saya laptop dong' });

		const sent = stub.calls[0].body;
		const system = sent.messages[0].content;

		assert.match(system, /HANYA memberi saran/);
		assert.match(system, /tidak dapat membuat transaksi/);
		// No tool definitions at all: the model cannot call anything.
		assert.equal(sent.tools, undefined);
		assert.equal(sent.functions, undefined);
	} finally {
		await stub.restore();
	}
});

test('an incomplete profile is disclosed to the model', async () => {
	const { agent } = await signUp('chat-thin');
	await agent.put('/api/settings').send({
		api_url: 'https://x.test/v1', model: 'm', api_key: 'sk'
	});
	// No profile filled in.

	const stub = stubProvider(() => providerReply('Bisa.'));
	try {
		await agent.post('/api/chat').send({ message: 'nasihat dong' });

		const system = stub.calls[0].body.messages[0].content;
		assert.match(system, /belum lengkap/);
		assert.match(stub.calls[0].body.messages[1].content, /profil belum diisi/);
	} finally {
		await stub.restore();
	}
});

test('a non-JSON provider response is reported, not crashed on', async () => {
	const { agent } = await signUp('chat-html');
	await configure(agent);

	const stub = stubProvider(() => new Response('<!DOCTYPE html><html>proxy error</html>', { status: 200 }));
	try {
		const res = await agent.post('/api/chat').send({ message: 'halo' });
		assert.equal(res.status, 502);
		assert.match(res.body.error, /bukan JSON/);
	} finally {
		await stub.restore();
	}
});

test('an empty assistant message is treated as a failure', async () => {
	const { agent } = await signUp('chat-blank');
	await configure(agent);

	const stub = stubProvider(() => providerReply('   '));
	try {
		const res = await agent.post('/api/chat').send({ message: 'halo' });
		assert.equal(res.status, 502);
		assert.match(res.body.error, /tidak memuat jawaban/);
	} finally {
		await stub.restore();
	}
});

/* ---------------------------------------------------------------- isolation */

test('one user cannot read another user chat, profile or settings', async () => {
	const alice = await signUp('iso-alice');
	const bob = await signUp('iso-bob');

	await configure(alice.agent, { api_key: 'sk-alice-key' });
	await alice.agent.put('/api/profile').send({ display_name: 'Alice', age: 30 });
	await alice.agent.post('/api/chat').send({ message: 'pertanyaan rahasia alice' });

	// Every read Bob makes must come back empty or absent.
	const bobChat = await bob.agent.get('/api/chat');
	assert.equal(bobChat.body.total, 0);
	assert.deepEqual(bobChat.body.messages, []);

	const bobProfile = await bob.agent.get('/api/profile');
	assert.equal(bobProfile.body.display_name, null);

	const bobSettings = await bob.agent.get('/api/settings');
	assert.equal(bobSettings.body.configured, false);
	assert.equal(JSON.stringify(bobSettings.body).includes('sk-alice-key'), false);

	// Clearing Bob's history must not touch Alice's.
	await bob.agent.delete('/api/chat');
	const aliceStill = await alice.agent.get('/api/chat');
	assert.equal(aliceStill.body.total, 2);
});

test('profile and settings require a session', async () => {
	for (const path of ['/api/profile', '/api/profile/completeness', '/api/settings', '/api/chat']) {
		assert.equal((await request(app).get(path)).status, 401, `${path} should require auth`);
	}
	assert.equal((await request(app).post('/api/chat').send({ message: 'x' })).status, 401);
	assert.equal((await request(app).post('/api/settings/test')).status, 401);
});

test('clearing the history empties it', async () => {
	const { agent } = await signUp('chat-clear');
	await configure(agent);

	const stub = stubProvider(() => providerReply('Siap.'));
	try {
		await agent.post('/api/chat').send({ message: 'pertanyaan' });
	} finally {
		await stub.restore();
	}

	assert.equal((await agent.get('/api/chat')).body.total, 2);

	const cleared = await agent.delete('/api/chat');
	assert.equal(cleared.body.removed, 2);
	assert.equal((await agent.get('/api/chat')).body.total, 0);
});