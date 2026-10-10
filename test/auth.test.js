/**
 * Authentication, authorisation and regression tests for the bug fixes.
 *
 * Two things are being proven here:
 *  1. Sessions work: register, login, logout, expiry, bad credentials.
 *  2. The IDOR holes are closed: one signed-in user cannot read or write
 *     another user's wallets, transactions, budgets or goals, no matter what
 *     userId they put in the body or the URL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.SQLITE_FILE = path.join(
	fs.mkdtempSync(path.join(os.tmpdir(), 'money-tracker-auth-')),
	'test.db'
);

const request = require('supertest');
const app = require('../server');

let counter = 0;
function uniqueName(prefix = 'user') {
	counter += 1;
	return `${prefix}${counter}${Date.now() % 100000}`;
}

/** Registers a user and returns an agent holding that user's session cookie. */
async function signUp(username, password = 'supersecret123') {
	const agent = request.agent(app);
	const res = await agent.post('/api/auth/register').send({ username, password });
	assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
	return { agent, username, password, userId: res.body.user.userId };
}

function cookieOf(agent) {
	const jar = agent.jar;
	const cookies = jar.getCookies({ url: 'http://127.0.0.1' });
	return cookies.map((c) => c.value).join('; ');
}

// ---------------------------------------------------------------- auth basics

test('register creates a session and returns the user', async () => {
	const { agent, userId } = await signUp(uniqueName('reg'));

	const me = await agent.get('/api/auth/me');
	assert.equal(me.status, 200);
	assert.equal(me.body.user.userId, userId);
});

test('register rejects a duplicate username regardless of case', async () => {
	const name = uniqueName('dup');
	await signUp(name);

	const second = await request(app).post('/api/auth/register').send({ username: name.toUpperCase(), password: 'supersecret123' });
	assert.equal(second.status, 409);
});

test('register rejects a short password', async () => {
	const res = await request(app).post('/api/auth/register').send({ username: uniqueName('short'), password: 'abc' });
	assert.equal(res.status, 400);
	assert.match(res.body.error, /at least 8/);
});

test('register rejects an invalid username', async () => {
	for (const username of ['a', 'has space', 'x'.repeat(40), 'bad/slash']) {
		const res = await request(app).post('/api/auth/register').send({ username, password: 'supersecret123' });
		assert.equal(res.status, 400, `expected 400 for username ${JSON.stringify(username)}`);
	}
});

test('login with correct credentials returns a new session', async () => {
	const { username, password } = await signUp(uniqueName('login'));

	const res = await request(app).post('/api/auth/login').send({ username, password });
	assert.equal(res.status, 200);
	assert.ok(res.body.user.userId);
});

test('login with a wrong password is rejected', async () => {
	const { username } = await signUp(uniqueName('wrongpw'));

	const res = await request(app).post('/api/auth/login').send({ username, password: 'not-the-password' });
	assert.equal(res.status, 401);
});

test('login for an unknown user gives the same error as a wrong password', async () => {
	const unknown = await request(app)
		.post('/api/auth/login')
		.send({ username: uniqueName('ghost'), password: 'whatever123' });

	const known = await signUp(uniqueName('knownpw'));
	const badPassword = await request(app).post('/api/auth/login').send({ username: known.username, password: 'whatever123' });

	// Identical responses mean usernames cannot be enumerated.
	assert.equal(unknown.status, badPassword.status);
	assert.equal(unknown.body.error, badPassword.body.error);
});

test('logout revokes the session immediately', async () => {
	const { agent } = await signUp(uniqueName('logout'));

	assert.equal((await agent.get('/api/auth/me')).status, 200);
	await agent.post('/api/auth/logout');
	assert.equal((await agent.get('/api/auth/me')).status, 401);
});

test('a session cookie cannot be forged', async () => {
	const res = await request(app)
		.get('/api/auth/me')
		.set('Cookie', 'mt_session=not-a-real-token');
	assert.equal(res.status, 401);
});

test('the session cookie is HttpOnly and SameSite', async () => {
	const res = await request(app)
		.post('/api/auth/register')
		.send({ username: uniqueName('flags'), password: 'supersecret123' });

	const setCookie = res.headers['set-cookie'].join(';');
	assert.match(setCookie, /HttpOnly/i);
	assert.match(setCookie, /SameSite=Lax/i);
});

test('repeated failed logins are throttled', async () => {
	const { username } = await signUp(uniqueName('throttle'));

	let sawThrottle = false;
	for (let attempt = 0; attempt < 15; attempt += 1) {
		const res = await request(app).post('/api/auth/login').send({ username, password: `wrong-${attempt}` });
		if (res.status === 429) {
			sawThrottle = true;
			assert.ok(res.headers['retry-after']);
			break;
		}
	}
	assert.ok(sawThrottle, 'expected a 429 after repeated failed logins');
});

// ---------------------------------------------------------- unauthenticated

test('every data endpoint rejects an unauthenticated request', async () => {
	const endpoints = [
		['get', '/api/wallets'],
		['post', '/api/wallets'],
		['get', '/api/goals'],
		['post', '/api/goals'],
		['get', '/api/budgeting/me/2026-01'],
		['post', '/api/budgeting'],
		['get', '/api/transactions/me/2026-01'],
		['post', '/api/transactions'],
		['get', '/api/analytics/income-expense/me/2026-01'],
		['get', '/api/analytics/wallets/me'],
		['get', '/api/analytics/budget-vs-actual/me/2026-01'],
		['get', '/api/analytics/expense-by-category/me/2026-01'],
		['get', '/api/analytics/financial-trend/me'],
		['get', '/export/me/2026-01/csv'],
		['get', '/export/budget/me/2026-01/csv']
	];

	for (const [method, path] of endpoints) {
		const res = await request(app)[method](path).send({});
		assert.equal(res.status, 401, `${method.toUpperCase()} ${path} should require auth, got ${res.status}`);
	}
});

test('html pages redirect to login when signed out', async () => {
	for (const page of ['/home', '/wallet', '/budget', '/transactions', '/goals']) {
		const res = await request(app).get(page);
		assert.equal(res.status, 302, `${page} should redirect`);
		assert.equal(res.headers.location, '/login');
	}
});

test('the health endpoint stays open for a LAN reachability check', async () => {
	const res = await request(app).get('/api/health');
	assert.equal(res.status, 200);
	assert.equal(res.body.status, 'ok');
	assert.equal(res.body.authenticated, false);
});

// ----------------------------------------------------------------- IDOR: wallets

test('GET /api/wallets returns only the caller own wallets', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	await alice.agent.post('/api/wallets').send({ name: 'Alice Savings', balance: 1000 });
	await bob.agent.post('/api/wallets').send({ name: 'Bob Savings', balance: 2000 });

	const aliceView = await alice.agent.get('/api/wallets');
	assert.equal(aliceView.status, 200);
	assert.equal(aliceView.body.length, 1);
	assert.equal(aliceView.body[0].name, 'Alice Savings');
});

test('a user cannot edit or delete another user wallet', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const created = await alice.agent.post('/api/wallets').send({ name: 'Alice Wallet', balance: 500 });
	const walletId = created.body.id;

	const put = await bob.agent.put(`/api/wallets/${walletId}`).send({ name: 'Stolen', balance: 999999, frozen: 0 });
	assert.equal(put.status, 404);

	const del = await bob.agent.delete(`/api/wallets/${walletId}`);
	assert.equal(del.status, 404);

	// And the wallet is untouched.
	const stillThere = await alice.agent.get('/api/wallets');
	assert.equal(stillThere.body[0].balance, 500);
	assert.equal(stillThere.body[0].name, 'Alice Wallet');
});

test('a forged userId in the wallet body is ignored', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	await bob.agent.post('/api/wallets').send({ name: 'Bob Wallet', balance: 100 });
	// Alice tries to create a wallet inside Bob's ledger.
	await alice.agent.post('/api/wallets').send({ name: 'Sneaky', balance: 1, userId: bob.userId });

	const bobView = await bob.agent.get('/api/wallets');
	assert.equal(bobView.body.length, 1);
	assert.equal(bobView.body[0].name, 'Bob Wallet');
});

test('transfer cannot move money out of another user wallet', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const aliceWallet = (await alice.agent.post('/api/wallets').send({ name: 'Alice', balance: 1000 })).body.id;
	const bobWallet = (await bob.agent.post('/api/wallets').send({ name: 'Bob', balance: 10 })).body.id;

	const res = await bob.agent.post('/api/wallets/transfer').send({
		fromWalletId: aliceWallet,
		toWalletId: bobWallet,
		amount: 900
	});
	assert.equal(res.status, 404);

	const aliceView = await alice.agent.get('/api/wallets');
	assert.equal(aliceView.body[0].balance, 1000, "Alice's wallet must be untouched");
});

test('transfer is atomic and rejects invalid moves', async () => {
	const { agent } = await signUp(uniqueName('xfer'));

	const from = (await agent.post('/api/wallets').send({ name: 'From', balance: 1000 })).body.id;
	const to = (await agent.post('/api/wallets').send({ name: 'To', balance: 0 })).body.id;

	const same = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: from, amount: 10 });
	assert.equal(same.status, 400);

	const zero = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 0 });
	assert.equal(zero.status, 400);

	const tooMuch = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 5000 });
	assert.equal(tooMuch.status, 400);

	// A rejected transfer must leave both wallets exactly as they were.
	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body.find((w) => w.id === from).balance, 1000);
	assert.equal(wallets.body.find((w) => w.id === to).balance, 0);

	const ok = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 250 });
	assert.equal(ok.status, 200);
	const after = await agent.get('/api/wallets');
	assert.equal(after.body.find((w) => w.id === from).balance, 750);
	assert.equal(after.body.find((w) => w.id === to).balance, 250);
});

test('transfer cannot spend frozen funds', async () => {
	const { agent } = await signUp(uniqueName('frozen'));

	const from = (await agent.post('/api/wallets').send({ name: 'From', balance: 1000, frozen: 900 })).body.id;
	const to = (await agent.post('/api/wallets').send({ name: 'To', balance: 0 })).body.id;

	const res = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 200 });
	assert.equal(res.status, 400, 'only 100 is usable, so 200 must fail');

	const ok = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 100 });
	assert.equal(ok.status, 200);
});

test('POST /api/wallets accepts a frozen amount at creation (bug 7)', async () => {
	const { agent } = await signUp(uniqueName('createfrozen'));

	const res = await agent.post('/api/wallets').send({ name: 'Frozen', balance: 5000, frozen: 1500 });
	assert.equal(res.status, 201);
	assert.equal(res.body.frozen, 1500, 'frozen must not be dropped on create');

	// No follow-up PUT needed.
	const list = await agent.get('/api/wallets');
	assert.equal(list.body[0].frozen, 1500);
});

// ------------------------------------------------------ IDOR: transactions

test('GET /api/transactions refuses a foreign userId in the path', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const res = await bob.agent.get(`/api/transactions/${alice.userId}/2026-01`);
	assert.equal(res.status, 403);
});

test('a user cannot record a transaction against another user wallet', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const aliceWallet = (await alice.agent.post('/api/wallets').send({ name: 'Alice', balance: 1000 })).body.id;

	const res = await bob.agent.post('/api/transactions').send({
		userId: alice.userId,
		date: '2026-01-05',
		amount: 900,
		type: 'expense',
		walletId: aliceWallet
	});
	assert.equal(res.status, 404);

	const aliceView = await alice.agent.get('/api/wallets');
	assert.equal(aliceView.body[0].balance, 1000, "Alice's balance must be untouched");
});

test('a user cannot edit or delete another user transaction', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const walletId = (await alice.agent.post('/api/wallets').send({ name: 'Alice', balance: 1000 })).body.id;
	const created = await alice.agent.post('/api/transactions').send({
		userId: alice.userId,
		date: '2026-01-05',
		amount: 100,
		type: 'expense',
		walletId,
		category: 'Makan',
		subcategory: 'Belanja'
	});

	const put = await bob.agent.put(`/api/transactions/${created.body.id}`).send({
		userId: bob.userId,
		date: '2026-01-05',
		amount: 999999,
		type: 'expense',
		walletId
	});
	assert.equal(put.status, 404);

	const del = await bob.agent.delete(`/api/transactions/${created.body.id}`);
	assert.equal(del.status, 404);

	// Alice's data is intact.
	const detail = await alice.agent.get(`/api/transactions/detail/${created.body.id}`);
	assert.equal(detail.body.amount, 100);
	const wallet = await alice.agent.get('/api/wallets');
	assert.equal(wallet.body[0].balance, 900);
});

// ------------------------------------------------ bug 2: refund to the right wallet

test('moving an expense between wallets refunds the original wallet (bug 2)', async () => {
	const { agent } = await signUp(uniqueName('move'));

	const a = (await agent.post('/api/wallets').send({ name: 'A', balance: 1000 })).body.id;
	const b = (await agent.post('/api/wallets').send({ name: 'B', balance: 500 })).body.id;

	const trx = await agent.post('/api/transactions').send({
		date: '2026-01-05',
		amount: 200,
		type: 'expense',
		walletId: a,
		category: 'Makan',
		subcategory: 'Belanja'
	});
	assert.equal(trx.status, 201);

	// A: 1000 - 200 = 800
	let wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body.find((w) => w.id === a).balance, 800);

	// Move the expense to wallet B.
	const put = await agent.put(`/api/transactions/${trx.body.id}`).send({
		date: '2026-01-05',
		amount: 200,
		type: 'expense',
		walletId: b,
		category: 'Makan',
		subcategory: 'Belanja'
	});
	assert.equal(put.status, 200);

	wallets = await agent.get('/api/wallets');
	// A must be refunded in full to 1000, B must be debited to 300.
	// The original bug left A at 800 and B at 500 (net zero on B).
	assert.equal(wallets.body.find((w) => w.id === a).balance, 1000, 'original wallet must be refunded');
	assert.equal(wallets.body.find((w) => w.id === b).balance, 300, 'new wallet must be debited');
});

test('moving a transaction within the same wallet nets out', async () => {
	const { agent } = await signUp(uniqueName('same'));

	const a = (await agent.post('/api/wallets').send({ name: 'A', balance: 1000 })).body.id;

	const expense = await agent.post('/api/transactions').send({
		date: '2026-01-05', amount: 300, type: 'expense', walletId: a
	});
	let balance = (await agent.get('/api/wallets')).body[0].balance;
	assert.equal(balance, 700);

	// Edit the amount on the same wallet: refund 300, charge 100.
	await agent.put(`/api/transactions/${expense.body.id}`).send({
		date: '2026-01-05', amount: 100, type: 'expense', walletId: a
	});
	balance = (await agent.get('/api/wallets')).body[0].balance;
	assert.equal(balance, 900);
});

test('changing income to expense nets out on one wallet', async () => {
	const { agent } = await signUp(uniqueName('flip'));

	const a = (await agent.post('/api/wallets').send({ name: 'A', balance: 1000 })).body.id;

	const income = await agent.post('/api/transactions').send({
		date: '2026-01-05', amount: 300, type: 'income', walletId: a
	});
	assert.equal((await agent.get('/api/wallets')).body[0].balance, 1300);

	await agent.put(`/api/transactions/${income.body.id}`).send({
		date: '2026-01-05', amount: 300, type: 'expense', walletId: a
	});
	// Refund the 300 income (1300 -> 1000), then charge 300 as an expense (1000 -> 700).
	// Net effect: +300 income followed by -300 expense = 700.
	assert.equal((await agent.get('/api/wallets')).body[0].balance, 700);
});

// ----------------------------------------------------------------- budget fixes

test('POST /api/budgeting is idempotent per user and month', async () => {
	const { agent, userId } = await signUp(uniqueName('budget'));

	const first = await agent.post('/api/budgeting').send({
		month: '2026-02',
		categories: [{ name: 'Makan', total: 1000, subcategories: [{ name: 'Belanja', amount: 1000 }] }]
	});
	assert.equal(first.status, 201);

	const second = await agent.post('/api/budgeting').send({
		month: '2026-02',
		categories: [{ name: 'Makan', total: 2500, subcategories: [{ name: 'Belanja', amount: 2500 }] }]
	});
	assert.equal(second.status, 200, 'a second POST for the same month updates rather than duplicating');
	assert.equal(second.body.id, first.body.id);

	const read = await agent.get(`/api/budgeting/${userId}/2026-02`);
	assert.equal(read.body.categories[0].total, 2500);
});

test('POST /api/budgeting validates the month format', async () => {
	const { agent } = await signUp(uniqueName('badmonth'));

	const res = await agent.post('/api/budgeting').send({
		month: 'not-a-month',
		categories: [{ name: 'Makan', total: 1, subcategories: [] }]
	});
	assert.equal(res.status, 400);
});

test('a user cannot read or delete another user budget', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const created = await alice.agent.post('/api/budgeting').send({
		month: '2026-03',
		categories: [{ name: 'Makan', total: 1000, subcategories: [{ name: 'Belanja', amount: 1000 }] }]
	});

	const read = await bob.agent.get(`/api/budgeting/${alice.userId}/2026-03`);
	assert.equal(read.status, 403);

	const del = await bob.agent.delete(`/api/budgeting/${created.body.id}`);
	assert.equal(del.status, 404);

	// Alice's budget still there.
	const aliceRead = await alice.agent.get(`/api/budgeting/${alice.userId}/2026-03`);
	assert.equal(aliceRead.status, 200);
});

// ------------------------------------------------------------------- goal fixes

test('goals are scoped per user', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	await alice.agent.post('/api/wallets').send({ name: 'Alice', balance: 5000, frozen: 3000 });
	const created = await alice.agent.post('/api/goals').send({
		name: 'Alice Goal', targetAmount: 10000, currentAmount: 500, targetDate: '2026-12-31'
	});

	const bobList = await bob.agent.get('/api/goals');
	assert.equal(bobList.body.length, 0, 'Bob must not see Alice goal');

	const read = await bob.agent.get(`/api/goals/${created.body.id}`);
	assert.equal(read.status, 404);

	const del = await bob.agent.delete(`/api/goals/${created.body.id}`);
	assert.equal(del.status, 404);

	const put = await bob.agent.put(`/api/goals/${created.body.id}`).send({
		name: 'Hijacked', targetAmount: 1, currentAmount: 1, targetDate: '2026-12-31'
	});
	assert.equal(put.status, 404);

	const aliceList = await alice.agent.get('/api/goals');
	assert.equal(aliceList.body.length, 1);
	assert.equal(aliceList.body[0].name, 'Alice Goal');
});

test('a goal cannot be funded by another user frozen funds', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	// Only Alice has frozen money.
	await alice.agent.post('/api/wallets').send({ name: 'Alice', balance: 5000, frozen: 5000 });

	// Bob has none, so he must not be able to allocate against Alice's funds.
	const res = await bob.agent.post('/api/goals').send({
		name: 'Bob Goal', targetAmount: 10000, currentAmount: 1000, targetDate: '2026-12-31'
	});
	assert.equal(res.status, 400);
	assert.match(res.body.error, /frozen/i);
});

// --------------------------------------------------------------- export fixes

test('exports are reachable at the path the frontend actually calls (bug 1)', async () => {
	const { agent, userId } = await signUp(uniqueName('exp'));

	const walletId = (await agent.post('/api/wallets').send({ name: 'W', balance: 10000 })).body.id;
	await agent.post('/api/transactions').send({
		date: '2026-05-01', amount: 1234, type: 'income', walletId,
		category: 'Gaji', subcategory: 'Bulanan'
	});
	await agent.post('/api/budgeting').send({
		month: '2026-05',
		categories: [{ name: 'Makan', total: 500, subcategories: [{ name: 'Belanja', amount: 500 }] }]
	});

	// The single-prefix path the frontend uses.
	for (const format of ['json', 'csv', 'xlsx']) {
		const res = await agent.get(`/export/${userId}/2026-05/${format}`);
		assert.equal(res.status, 200, `/export/${userId}/2026-05/${format} should work`);
	}

	const budget = await agent.get(`/export/budget/${userId}/2026-05/csv`);
	assert.equal(budget.status, 200);
	assert.match(budget.text, /Belanja/);
});

test('exports refuse a foreign userId', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const res = await bob.agent.get(`/export/${alice.userId}/2026-05/csv`);
	assert.equal(res.status, 403);
});

test('an unauthenticated export is refused', async () => {
	const res = await request(app).get('/export/someone/2026-05/csv');
	assert.equal(res.status, 401);
});

// ------------------------------------------------------------------- analytics

test('analytics refuse a foreign userId in the path', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	const paths = [
		`/api/analytics/income-expense/${alice.userId}/2026-01`,
		`/api/analytics/wallets/${alice.userId}`,
		`/api/analytics/budget-vs-actual/${alice.userId}/2026-01`,
		`/api/analytics/expense-by-category/${alice.userId}/2026-01`,
		`/api/analytics/financial-trend/${alice.userId}`
	];

	for (const path of paths) {
		const res = await bob.agent.get(path);
		assert.equal(res.status, 403, `${path} should be forbidden for another user`);
	}
});

test('analytics wallets returns only the caller wallets (bug 3)', async () => {
	const alice = await signUp(uniqueName('alice'));
	const bob = await signUp(uniqueName('bob'));

	await alice.agent.post('/api/wallets').send({ name: 'Alice', balance: 111 });
	await bob.agent.post('/api/wallets').send({ name: 'Bob', balance: 222 });

	const res = await alice.agent.get(`/api/analytics/wallets/${alice.userId}`);
	assert.equal(res.status, 200);
	assert.equal(res.body.length, 1);
	assert.equal(res.body[0].name, 'Alice');
});

// ------------------------------------------------------------------ password

test('passwords are stored as salted scrypt hashes, never plaintext', async () => {
	const username = uniqueName('hash');
	const password = 'a-very-distinctive-password';
	await signUp(username, password);

	const row = app.auth.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username);
	assert.ok(row, 'user row should exist');
	assert.ok(!row.password_hash.includes(password), 'password must not appear in the stored hash');
	assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
});

test('two users with the same password get different hashes', async () => {
	const a = await signUp(uniqueName('same1'));
	const b = await signUp(uniqueName('same2'));

	const rowA = app.auth.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(a.username);
	const rowB = app.auth.db.prepare('SELECT password_hash FROM users WHERE username = ?').get(b.username);
	assert.notEqual(rowA.password_hash, rowB.password_hash, 'each user needs its own salt');
});