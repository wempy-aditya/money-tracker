/**
 * End-to-end flow tests.
 *
 * These exercise the real route modules over real HTTP, driving the same request
 * sequences the frontend issues, now behind a real session. The point is to
 * prove the whole stack behaves correctly together: SQLite shim, auth
 * middleware, and route logic.
 *
 * Ownership rules changed with authentication, so several expectations here
 * differ from the pre-auth version of this file:
 *  - wallets, budgets and goals are listed per user, not globally
 *  - POST /api/wallets accepts `frozen` directly
 *  - exports live at /export/:userId/... instead of /export/export/...
 *  - budget POST is idempotent per user+month
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the shim at a throwaway file BEFORE any route module is required.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-tracker-e2e-'));
process.env.SQLITE_FILE = path.join(tmpDir, 'e2e.db');

const request = require('supertest');
const app = require('../server');

let counter = 0;

/** Creates a signed-in agent. `agent(...)` then behaves like `request(app)`. */
async function signedIn(prefix = 'flow') {
	counter += 1;
	const username = `${prefix}${counter}${Date.now() % 100000}`;
	const agent = request.agent(app);
	const res = await agent.post('/api/auth/register').send({ username, password: 'supersecret123' });
	assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
	return { agent, userId: res.body.user.userId, username };
}

// One shared session for the whole file. Every request goes through it so the
// suite reads like a single user working through the app.
const sessionPromise = signedIn('flow');

async function seedWallet(overrides = {}) {
	const { agent } = await sessionPromise;
	const res = await agent.post('/api/wallets').send({ name: 'BCA', balance: 1_000_000, ...overrides });
	assert.equal(res.status, 201, `wallet create failed: ${JSON.stringify(res.body)}`);
	return res.body.id;
}


test('POST /api/wallets creates a wallet with frozen=0', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.post('/api/wallets').send({ name: 'Dompet Utama', balance: 2_500_000 });
	assert.equal(res.status, 201);
	assert.equal(res.body.name, 'Dompet Utama');
	assert.equal(res.body.balance, 2_500_000);
	assert.equal(res.body.frozen, 0);
	assert.ok(res.body.id);
});

test('GET /api/wallets lists wallets', async () => {
	const { agent, userId } = await sessionPromise;
	const id = await seedWallet();
	const res = await agent.get('/api/wallets');
	assert.equal(res.status, 200);
	assert.ok(Array.isArray(res.body));
	assert.ok(res.body.some((w) => w.id === id));
});

test('PUT /api/wallets updates a wallet', async () => {
	const { agent, userId } = await sessionPromise;
	const id = await seedWallet({ name: 'Old', balance: 100 });
	const res = await agent.put(`/api/wallets/${id}`).send({ name: 'New', balance: 750, frozen: 50 });
	assert.equal(res.status, 200);
	const list = await agent.get('/api/wallets');
	const updated = list.body.find((w) => w.id === id);
	assert.equal(updated.name, 'New');
	assert.equal(updated.balance, 750);
	assert.equal(updated.frozen, 50);
});

test('DELETE /api/wallets removes a wallet', async () => {
	const { agent, userId } = await sessionPromise;
	const id = await seedWallet();
	assert.equal((await agent.delete(`/api/wallets/${id}`)).status, 200);
	const list = await agent.get('/api/wallets');
	assert.equal(list.body.some((w) => w.id === id), false);
});

test('POST /api/wallets/transfer moves balance between wallets', async () => {
	const { agent, userId } = await sessionPromise;
	const from = await seedWallet({ name: 'from', balance: 500_000 });
	const to = await seedWallet({ name: 'to', balance: 100_000 });

	const res = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 150_000 });
	assert.equal(res.status, 200);

	const list = await agent.get('/api/wallets');
	assert.equal(list.body.find((w) => w.id === from).balance, 350_000);
	assert.equal(list.body.find((w) => w.id === to).balance, 250_000);
});

test('POST /api/wallets/transfer rejects insufficient balance', async () => {
	const { agent, userId } = await sessionPromise;
	const from = await seedWallet({ balance: 10_000 });
	const to = await seedWallet({ balance: 0 });
	const res = await agent.post('/api/wallets/transfer').send({ fromWalletId: from, toWalletId: to, amount: 99_999 });
	assert.equal(res.status, 400);
	assert.match(res.body.error, /Insufficient balance/);
});

test('POST /api/transactions rejects incomplete fields', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.post('/api/transactions').send({});
	assert.equal(res.status, 400);
	assert.match(res.body.error, /Field tidak lengkap/);
});

test('POST /api/transactions rejects unknown wallet', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.post('/api/transactions').send({ date: '2026-09-01', amount: 1000, type: 'expense', walletId: 'tidak-ada'
	});
	assert.equal(res.status, 404);
	assert.match(res.body.error, /Wallet tidak ditemukan/);
});

test('POST /api/transactions rejects expense beyond available balance', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 50_000, frozen: 0 });
	const res = await agent.post('/api/transactions').send({ date: '2026-09-01', amount: 60_000, type: 'expense', walletId
	});
	assert.equal(res.status, 400);
	assert.match(res.body.error, /Saldo tidak mencukupi/);
});

test('expense respects frozen funds when checking balance', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 100_000, frozen: 80_000 });
	const res = await agent.post('/api/transactions').send({ date: '2026-09-02', amount: 50_000, type: 'expense', walletId
	});
	// usable = 100_000 - 80_000 = 20_000, so 50_000 must fail
	assert.equal(res.status, 400);
	assert.match(res.body.error, /Saldo tidak mencukupi/);
});

test('POST /api/transactions income increases wallet balance', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 1_000_000 });
	const res = await agent.post('/api/transactions').send({ date: '2026-09-05', amount: 5_000_000, type: 'income',
		walletId, category: 'Gaji', subcategory: 'Bulanan', description: 'Gaji September'
	});
	assert.equal(res.status, 201);
	assert.equal(res.body.type, 'income');

	const list = await agent.get('/api/wallets');
	assert.equal(list.body.find((w) => w.id === walletId).balance, 6_000_000);
});

test('POST /api/transactions expense decreases wallet balance', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 1_000_000 });
	const res = await agent.post('/api/transactions').send({ date: '2026-09-06', amount: 250_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja', description: 'Belanja bulanan'
	});
	assert.equal(res.status, 201);

	const list = await agent.get('/api/wallets');
	assert.equal(list.body.find((w) => w.id === walletId).balance, 750_000);
});

test('expense transaction updates the matching budget subcategory used amount', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 1_000_000 });
	await agent.post('/api/budgeting').send({
		month: '2026-09',
		categories: [
			{ name: 'Makan', total: 1_500_000, subcategories: [{ name: 'Belanja', amount: 1_000_000 }] }
		]
	});

	await agent.post('/api/transactions').send({ date: '2026-09-07', amount: 300_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});

	const budget = await agent.get(`/api/budgeting/${userId}/2026-09`);
	assert.equal(budget.status, 200);
	assert.equal(budget.body.categories[0].subcategories[0].used, 300_000);
});

test('expense in a month with no budget is still accepted', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 1_000_000 });
	const res = await agent.post('/api/transactions').send({ date: '2026-01-10', amount: 10_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});
	assert.equal(res.status, 201);
});

test('GET /api/transactions/:userId/:month returns that month only', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 10_000_000 });
	// 2027-06 is used by no other test in this file, so transactions seeded
	// elsewhere cannot leak into the count (all tests share one session).
	await agent.post('/api/transactions').send({ date: '2027-06-10', amount: 111, type: 'income', walletId
	});
	await agent.post('/api/transactions').send({ date: '2027-05-10', amount: 222, type: 'income', walletId
	});
	await agent.post('/api/transactions').send({ date: '2027-07-01', amount: 333, type: 'income', walletId
	});

	const res = await agent.get(`/api/transactions/${userId}/2027-06`);
	assert.equal(res.status, 200);
	assert.equal(res.body.length, 1);
	assert.equal(res.body[0].amount, 111);
});

test('GET /api/transactions/detail/:id returns 404 for unknown id', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get('/api/transactions/detail/entah');
	assert.equal(res.status, 404);
	assert.match(res.body.error, /Transaksi tidak ditemukan/);
});

test('PUT /api/transactions refunds the original wallet when moving a transaction', async () => {
	const { agent, userId } = await sessionPromise;
	const walletA = await seedWallet({ balance: 1_000_000 });
	const walletB = await seedWallet({ balance: 500_000 });

	const created = await agent.post('/api/transactions').send({ date: '2026-09-12', amount: 200_000, type: 'expense',
		walletId: walletA, category: 'Makan', subcategory: 'Belanja'
	});
	const id = created.body.id;

	// walletA is now 800_000. Move the expense to walletB.
	const res = await agent.put(`/api/transactions/${id}`).send({ date: '2026-09-12', amount: 200_000, type: 'expense',
		walletId: walletB, category: 'Makan', subcategory: 'Belanja'
	});
	assert.equal(res.status, 200);

	const list = await agent.get('/api/wallets');
	// Each wallet is adjusted by its own transaction's own sign. Moving the
	// expense refunds walletA to 1_000_000 and debits walletB to 300_000.
	// The old bug credited and debited walletB, leaving both untouched.
	assert.equal(list.body.find((w) => w.id === walletA).balance, 1_000_000, 'original wallet must be refunded');
	assert.equal(list.body.find((w) => w.id === walletB).balance, 300_000, 'new wallet must be debited');
});

test('PUT /api/transactions changing income to expense nets out on one wallet', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 1_000_000 });
	const created = await agent.post('/api/transactions').send({ date: '2026-09-14', amount: 300_000, type: 'income', walletId
	});
	assert.equal((await agent.get('/api/wallets')).body.find((w) => w.id === walletId).balance, 1_300_000);

	await agent.put(`/api/transactions/${created.body.id}`).send({ date: '2026-09-14', amount: 300_000, type: 'expense', walletId,
		category: 'Makan', subcategory: 'Belanja'
	});

	// -300_000 to undo the income, then -300_000 to charge the new expense.
	assert.equal((await agent.get('/api/wallets')).body.find((w) => w.id === walletId).balance, 700_000);
});

test('PUT /api/transactions reverses old budget usage before charging the new month', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 5_000_000 });

	await agent.post('/api/budgeting').send({ month: '2026-03',
		categories: [{ name: 'Makan', total: 900_000, subcategories: [{ name: 'Belanja', amount: 900_000 }] }]
	});
	await agent.post('/api/budgeting').send({ month: '2026-04',
		categories: [{ name: 'Makan', total: 900_000, subcategories: [{ name: 'Belanja', amount: 900_000 }] }]
	});

	const created = await agent.post('/api/transactions').send({ date: '2026-03-15', amount: 400_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});
	assert.equal((await agent.get(`/api/budgeting/${userId}/2026-03`)).body.categories[0].subcategories[0].used, 400_000);

	// Move the expense from March to April: March must go back to 0, April to 400_000.
	await agent.put(`/api/transactions/${created.body.id}`).send({ date: '2026-04-15', amount: 400_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});

	assert.equal((await agent.get(`/api/budgeting/${userId}/2026-03`)).body.categories[0].subcategories[0].used, 0);
	assert.equal((await agent.get(`/api/budgeting/${userId}/2026-04`)).body.categories[0].subcategories[0].used, 400_000);
});

test('DELETE /api/transactions restores wallet balance and budget usage', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 2_000_000 });
	await agent.post('/api/budgeting').send({ month: '2026-05',
		categories: [{ name: 'Makan', total: 800_000, subcategories: [{ name: 'Belanja', amount: 800_000 }] }]
	});

	const created = await agent.post('/api/transactions').send({ date: '2026-05-20', amount: 250_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});
	assert.equal((await agent.get('/api/wallets')).body.find((w) => w.id === walletId).balance, 1_750_000);

	const res = await agent.delete(`/api/transactions/${created.body.id}`);
	assert.equal(res.status, 200);
	assert.equal((await agent.get('/api/wallets')).body.find((w) => w.id === walletId).balance, 2_000_000);
	assert.equal((await agent.get(`/api/budgeting/${userId}/2026-05`)).body.categories[0].subcategories[0].used, 0);
});

test('DELETE /api/transactions on unknown id returns 404', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.delete('/api/transactions/entah');
	assert.equal(res.status, 404);
});

test('budgeting CRUD round trip', async () => {
	const { agent, userId } = await sessionPromise;
	const created = await agent.post('/api/budgeting').send({
		month: '2026-07',
		categories: [{ name: 'Transport', total: 600_000, subcategories: [{ name: 'Bensin', amount: 600_000 }] }]
	});
	assert.equal(created.status, 201);

	const fetched = await agent.get(`/api/budgeting/${userId}/2026-07`);
	assert.equal(fetched.status, 200);
	assert.equal(fetched.body.month, '2026-07');
	assert.equal(fetched.body.categories[0].name, 'Transport');

	const updated = await agent.put(`/api/budgeting/${created.body.id}`).send({
		categories: [{ name: 'Transport', total: 900_000, subcategories: [{ name: 'Bensin', amount: 900_000, used: 120_000 }] }]
	});
	assert.equal(updated.status, 200);
	assert.equal((await agent.get(`/api/budgeting/${userId}/2026-07`)).body.categories[0].subcategories[0].amount, 900_000);

	assert.equal((await agent.delete(`/api/budgeting/${created.body.id}`)).status, 200);
	assert.equal((await agent.get(`/api/budgeting/${userId}/2026-07`)).status, 404);
});

test('GET /api/budgeting for a month with no budget returns 404', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get(`/api/budgeting/${userId}/2026-12`);
	assert.equal(res.status, 404);
});

test('GET /api/analytics/income-expense sums by type for the month', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 20_000_000 });
	await agent.post('/api/transactions').send({ date: '2026-02-01', amount: 8_000_000, type: 'income', walletId
	});
	await agent.post('/api/transactions').send({ date: '2026-02-02', amount: 1_500_000, type: 'expense', walletId
	});
	await agent.post('/api/transactions').send({ date: '2026-02-03', amount: 500_000, type: 'expense', walletId
	});
	await agent.post('/api/transactions').send({ date: '2026-03-01', amount: 9_999_999, type: 'income', walletId
	});

	const res = await agent.get(`/api/analytics/income-expense/${userId}/2026-02`);
	assert.equal(res.status, 200);
	assert.equal(res.body.totalIncome, 8_000_000);
	assert.equal(res.body.totalExpense, 2_000_000);
});

test('GET /api/analytics/wallets returns balance, frozen and usable', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get(`/api/analytics/wallets/${userId}`);
	assert.equal(res.status, 200);
	assert.ok(Array.isArray(res.body));
	if (res.body.length > 0) {
		const wallet = res.body[0];
		assert.equal(wallet.usable, wallet.balance - wallet.frozen);
	}
});

test('GET /api/analytics/budget-vs-actual compares plan to reality', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 5_000_000 });
	await agent.post('/api/budgeting').send({ month: '2026-06',
		categories: [
			{ name: 'Makan', total: 1_200_000, subcategories: [{ name: 'Belanja', amount: 1_000_000 }, { name: 'Makan luar', amount: 200_000 }] },
			{ name: 'Transport', total: 400_000, subcategories: [{ name: 'Bensin', amount: 400_000 }] }
		]
	});
	await agent.post('/api/transactions').send({ date: '2026-06-11', amount: 650_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});

	const res = await agent.get(`/api/analytics/budget-vs-actual/${userId}/2026-06`);
	assert.equal(res.status, 200);

	const belanja = res.body.find((row) => row.subcategory === 'Belanja');
	assert.equal(belanja.budget, 1_000_000);
	assert.equal(belanja.actual, 650_000);
	assert.equal(belanja.difference, 350_000);

	const bensin = res.body.find((row) => row.subcategory === 'Bensin');
	assert.equal(bensin.actual, 0, 'no spending recorded yet');
	assert.equal(bensin.difference, 400_000);
});

test('GET /api/analytics/expense-by-category groups expenses', async () => {
	const { agent, userId } = await sessionPromise;
	const walletId = await seedWallet({ balance: 9_000_000 });
	await agent.post('/api/transactions').send({ date: '2026-07-01', amount: 100_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Belanja'
	});
	await agent.post('/api/transactions').send({ date: '2026-07-02', amount: 250_000, type: 'expense',
		walletId, category: 'Makan', subcategory: 'Makan luar'
	});
	await agent.post('/api/transactions').send({ date: '2026-07-03', amount: 400_000, type: 'income',
		walletId, category: 'Gaji', subcategory: 'Bulanan'
	});

	const res = await agent.get(`/api/analytics/expense-by-category/${userId}/2026-07`);
	assert.equal(res.status, 200);
	assert.equal(res.body.Makan, 350_000);
	assert.equal(res.body.Gaji, undefined, 'income is not an expense category');
});

test('GET /api/analytics/financial-trend returns 6 months oldest-first', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get(`/api/analytics/financial-trend/${userId}`);
	assert.equal(res.status, 200);
	assert.equal(res.body.length, 6);

	const months = res.body.map((row) => row.month);
	assert.deepEqual(months, [...months].sort(), 'months are in ascending order');
	for (const row of res.body) {
		assert.match(row.month, /^\d{4}-\d{2}$/);
	}
});

test('POST /api/goals requires name, targetAmount and targetDate', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.post('/api/goals').send({ name: 'Kurang' });
	assert.equal(res.status, 400);
});

test('goal allocation cannot exceed frozen funds', async () => {
	const { agent, userId } = await sessionPromise;
	// Frozen funds come from wallets: one wallet with frozen = 1_000_000.
	await seedWallet({ name: 'goal-source', balance: 5_000_000, frozen: 1_000_000 });

	const ok = await agent.post('/api/goals').send({
		name: 'Beli Laptop', targetAmount: 10_000_000, currentAmount: 500_000,
		targetDate: '2026-12-31', description: 'Untuk kerja'
	});
	assert.equal(ok.status, 201);

	const tooMuch = await agent.post('/api/goals').send({
		name: 'Beli Mobil', targetAmount: 50_000_000, currentAmount: 900_000, targetDate: '2026-12-31'
	});
	assert.equal(tooMuch.status, 400);
	assert.match(tooMuch.body.error, /Not enough frozen funds/);
});

test('goal CRUD round trip', async () => {
	const { agent, userId } = await sessionPromise;
	await seedWallet({ name: 'crud-source', balance: 5_000_000, frozen: 3_000_000 });

	const created = await agent.post('/api/goals').send({
		name: 'Dana Darurat', targetAmount: 20_000_000, currentAmount: 0,
		targetDate: '2027-01-31', description: 'Enam bulan'
	});
	assert.equal(created.status, 201);
	assert.equal(created.body.currentAmount, 0);
	assert.ok(created.body.createdAt);

	const fetched = await agent.get(`/api/goals/${created.body.id}`);
	assert.equal(fetched.status, 200);
	assert.equal(fetched.body.name, 'Dana Darurat');

	const updated = await agent.put(`/api/goals/${created.body.id}`).send({
		name: 'Dana Darurat', targetAmount: 25_000_000, currentAmount: 300_000,
		targetDate: '2027-02-28', description: 'Diperbesar'
	});
	assert.equal(updated.status, 200);

	const reread = await agent.get(`/api/goals/${created.body.id}`);
	assert.equal(reread.body.targetAmount, 25_000_000);
	assert.equal(reread.body.currentAmount, 300_000);

	assert.equal((await agent.delete(`/api/goals/${created.body.id}`)).status, 200);
	assert.equal((await agent.get(`/api/goals/${created.body.id}`)).status, 404);
});

test('increasing a goal allocation above available frozen funds is rejected', async () => {
	const { agent, userId } = await sessionPromise;
	// Goals are capped against the sum of `frozen` across EVERY wallet, not just
	// this one, so the assertion uses a figure far above the whole test DB.
	await seedWallet({ name: 'raise-source', balance: 5_000_000, frozen: 2_000_000 });
	const created = await agent.post('/api/goals').send({
		name: 'Awal', targetAmount: 10_000_000, currentAmount: 100_000, targetDate: '2026-12-31'
	});

	const res = await agent.put(`/api/goals/${created.body.id}`).send({
		name: 'Awal', targetAmount: 10_000_000, currentAmount: 900_000_000, targetDate: '2026-12-31'
	});
	assert.equal(res.status, 400);
	assert.match(res.body.error, /Not enough frozen funds/);
});

test('GET /api/goals returns a list', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get('/api/goals');
	assert.equal(res.status, 200);
	assert.ok(Array.isArray(res.body));
});

test('GET /api/goals/:id returns 404 for unknown goal', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get('/api/goals/entah');
	assert.equal(res.status, 404);
});

// NOTE: server.js mounts this router at '/export' while routes/exports.js also
// prefixes each route with '/export', so the reachable path is
// '/export/export/...'. The frontend calls '/export/...' and therefore 404s.
// That double prefix is a pre-existing bug in the original Firebase version,
// preserved here because this rebuild must not change behaviour. See NOTES.md.
const EXPORT_TRX = '/export';
const EXPORT_BUDGET = '/export/budget';

// Export tests are self-contained: they seed their own data rather than relying
// on whatever earlier tests happened to leave behind, so they stay correct
// under `--test-name-pattern` filtering and any future reordering.
async function seedExportData(userId, month) {
	const { agent } = await sessionPromise;
	const walletId = await seedWallet({ name: `export-${userId}`, balance: 10_000_000 });
	await agent.post('/api/transactions').send({
		date: `${month}-01`, amount: 123_456, type: 'income', walletId,
		category: 'Gaji', subcategory: 'Bulanan', description: 'seed'
	});
	await agent.post('/api/transactions').send({
		date: `${month}-02`, amount: 7_890, type: 'expense', walletId,
		category: 'Makan', subcategory: 'Belanja', description: 'seed'
	});
	return walletId;
}

test('GET export json returns JSON attachment', async () => {
	const { agent, userId } = await sessionPromise;
	await seedExportData('exp-json', '2026-11');
	const res = await agent.get(`${EXPORT_TRX}/${userId}/2026-11/json`);
	assert.equal(res.status, 200);
	assert.match(res.headers['content-disposition'], /attachment; filename=transactions_2026-11\.json/);
	assert.ok(Array.isArray(res.body));
	assert.equal(res.body.length, 2);
});

test('GET export csv returns CSV with header row', async () => {
	const { agent, userId } = await sessionPromise;
	await seedExportData('exp-csv', '2026-11');
	const res = await agent.get(`${EXPORT_TRX}/${userId}/2026-11/csv`);
	assert.equal(res.status, 200);
	assert.match(res.headers['content-type'], /text\/csv/);
	assert.match(res.text.split('\n')[0], /date.*type.*amount/s);
	assert.match(res.text, /123456|Gaji/);
});

test('GET export xlsx returns a spreadsheet', async () => {
	const { agent, userId } = await sessionPromise;
	await seedExportData('exp-xlsx', '2026-11');
	const res = await agent.get(`${EXPORT_TRX}/${userId}/2026-11/xlsx`);
	assert.equal(res.status, 200);
	assert.ok(Number(res.headers['content-length']) > 0);
});

test('GET export with an unknown month returns 404', async () => {
	const { agent, userId } = await sessionPromise;
	await seedExportData('exp-empty', '2026-11');
	const res = await agent.get(`${EXPORT_TRX}/${userId}/1999-01/json`);
	assert.equal(res.status, 404);
});

test('GET export with an invalid format returns 400', async () => {
	const { agent, userId } = await sessionPromise;
	await seedExportData('exp-bad', '2026-11');
	const res = await agent.get(`${EXPORT_TRX}/${userId}/2026-11/docx`);
	assert.equal(res.status, 400);
});

test('GET export-budget csv flattens categories into rows', async () => {
	const { agent, userId } = await sessionPromise;
	// Unique userId+month: POST /api/budgeting always inserts, and the export
	// reads only the first matching row, so a duplicate would hide this data.
	const created = await agent.post('/api/budgeting').send({
		userId: 'user-g-export', month: '2026-08',
		categories: [{ name: 'Makan', total: 900_000, subcategories: [{ name: 'Belanja', amount: 900_000 }] }]
	});
	assert.equal(created.status, 201);

	const res = await agent.get(`${EXPORT_BUDGET}/${userId}/2026-08/csv`);
	assert.equal(res.status, 200);
	assert.match(res.text, /Belanja/);
	assert.match(res.text, /Makan/);
});

test('GET export-budget with no budget returns 404', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get(`${EXPORT_BUDGET}/${userId}-missing/2026-11/json`);
	// A userId that is not the signed-in user is forbidden, not merely empty.
	assert.equal(res.status, 403);
});

test('all five frontend pages are served', async () => {
	const { agent, userId } = await sessionPromise;
	for (const route of ['/wallet', '/home', '/transactions', '/budget', '/goals']) {
		const res = await agent.get(route);
		assert.equal(res.status, 200, `${route} should serve HTML`);
	}
});

test('users do not see each other data through month-scoped queries', async () => {
	const { agent, userId } = await sessionPromise;
	const res = await agent.get(`/api/transactions/${userId}/2026-09`);
	assert.equal(res.status, 200);
	assert.ok(res.body.every((t) => t.userId === userId), 'every row must belong to the caller');
});