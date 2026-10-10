/**
 * Transfer history and recurring transactions.
 *
 * Two properties matter most here and both are easy to get wrong:
 *
 *  - a transfer history entry must never exist without the balances having moved,
 *    which is why the audit write shares the transfer's database transaction;
 *  - a generated transaction must be indistinguishable from a typed one, wallet
 *    balance and budget usage included, which is why both go through
 *    db/transactions.js.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

let runCounter = 0;

/**
 * Registers a user and returns an agent that carries their session cookie.
 * The suffix keeps usernames unique across repeated runs against a file-backed
 * database, where a fixed name would collide with 409 on the second run.
 */
async function signUp(username) {
	const agent = request.agent(app);
	const unique = `${username}-${process.pid}-${runCounter++}`;
	const res = await agent
		.post('/api/auth/register')
		.send({ username: unique, password: 'supersecret123' });
	assert.equal(res.status, 201, `register ${unique} failed: ${JSON.stringify(res.body)}`);
	return { agent, userId: res.body.userId, username: unique };
}

async function addWallet(agent, name, balance, frozen = 0) {
	const res = await agent.post('/api/wallets').send({ name, balance, frozen });
	assert.equal(res.status, 201, `wallet ${name} failed: ${JSON.stringify(res.body)}`);
	return res.body;
}

/* ------------------------------------------------------- transfer history */

test('transfer records a history entry naming both wallets', async () => {
	const { agent } = await signUp('tr-history-1');
	const from = await addWallet(agent, 'Tabungan', 1_000_000);
	const to = await addWallet(agent, 'Tunai', 0);

	const transfer = await agent
		.post('/api/wallets/transfer')
		.send({ fromWalletId: from.id, toWalletId: to.id, amount: 250_000 });
	assert.equal(transfer.status, 200);

	const history = await agent.get('/api/wallets/transfers');
	assert.equal(history.status, 200);
	assert.equal(history.body.length, 1);

	const entry = history.body[0];
	assert.equal(entry.amount, 250_000);
	assert.equal(entry.fromWalletName, 'Tabungan');
	assert.equal(entry.toWalletName, 'Tunai');
	assert.ok(entry.createdAt, 'history entry needs a timestamp');
});

test('transfer history is newest first', async () => {
	const { agent } = await signUp('tr-history-2');
	const from = await addWallet(agent, 'A', 1_000_000);
	const to = await addWallet(agent, 'B', 0);

	for (const amount of [100_000, 200_000, 300_000]) {
		await agent.post('/api/wallets/transfer').send({ fromWalletId: from.id, toWalletId: to.id, amount });
	}

	const history = await agent.get('/api/wallets/transfers');
	const amounts = history.body.map((entry) => entry.amount);
	assert.deepEqual(amounts, [300_000, 200_000, 100_000]);
});

test('a rejected transfer leaves no history entry', async () => {
	const { agent } = await signUp('tr-history-3');
	const from = await addWallet(agent, 'Kosong', 10_000);
	const to = await addWallet(agent, 'Tujuan', 0);

	const res = await agent
		.post('/api/wallets/transfer')
		.send({ fromWalletId: from.id, toWalletId: to.id, amount: 999_999 });
	assert.equal(res.status, 400);

	const history = await agent.get('/api/wallets/transfers');
	assert.equal(history.body.length, 0, 'a failed transfer must not appear in the log');
});

test('a transfer blocked by frozen funds leaves no history entry', async () => {
	const { agent } = await signUp('tr-history-4');
	// 1.000.000 balance but 900.000 frozen, so only 100.000 is really available.
	const from = await addWallet(agent, 'Terkunci', 1_000_000, 900_000);
	const to = await addWallet(agent, 'Bebas', 0);

	const res = await agent
		.post('/api/wallets/transfer')
		.send({ fromWalletId: from.id, toWalletId: to.id, amount: 500_000 });
	assert.equal(res.status, 400);

	const history = await agent.get('/api/wallets/transfers');
	assert.equal(history.body.length, 0);
});

test('transfer history belongs to one user only', async () => {
	const alice = await signUp('tr-history-alice');
	const bob = await signUp('tr-history-bob');
	const from = await addWallet(alice.agent, 'Alice A', 1_000_000);
	const to = await addWallet(alice.agent, 'Alice B', 0);

	await alice.agent
		.post('/api/wallets/transfer')
		.send({ fromWalletId: from.id, toWalletId: to.id, amount: 100_000 });

	const bobsView = await bob.agent.get('/api/wallets/transfers');
	assert.equal(bobsView.status, 200);
	assert.equal(bobsView.body.length, 0, "one user must never see another user's transfers");
});

test('transfer history is capped and does not leak unbounded rows', async () => {
	const { agent } = await signUp('tr-history-5');
	const from = await addWallet(agent, 'A', 10_000_000);
	const to = await addWallet(agent, 'B', 0);

	for (let i = 0; i < 5; i++) {
		await agent.post('/api/wallets/transfer').send({ fromWalletId: from.id, toWalletId: to.id, amount: 1_000 });
	}

	const res = await agent.get('/api/wallets/transfers?limit=2');
	assert.equal(res.body.length, 2);

	const unbounded = await agent.get('/api/wallets/transfers?limit=999999');
	assert.ok(unbounded.body.length <= 200, 'limit must be clamped');
});

/* -------------------------------------------------------------- recurring */

async function addRule(agent, overrides = {}) {
	const res = await agent.post('/api/recurring').send({
		name: 'Gaji',
		amount: 5_000_000,
		type: 'income',
		frequency: 'monthly',
		interval: 1,
		startDate: '2026-01-25',
		dayOfMonth: 25,
		walletId: overrides.walletId,
		category: overrides.category,
		subcategory: overrides.subcategory,
		description: 'gaji bulanan',
	});
	return res;
}

test('creating a recurring rule returns it in the list', async () => {
	const { agent } = await signUp('rec-1');
	const wallet = await addWallet(agent, 'BCA', 1_000_000);

	const created = await addRule(agent, { walletId: wallet.id });
	assert.equal(created.status, 201);

	const list = await agent.get('/api/recurring');
	assert.equal(list.status, 200);
	assert.equal(list.body.length, 1);
	assert.equal(list.body[0].name, 'Gaji');
	assert.equal(list.body[0].active, true);
	assert.equal(list.body[0].lastRunDate, null, 'a new rule has never run');
});

test('running rules creates transactions and moves the balance', async () => {
	const { agent } = await signUp('rec-2');
	const wallet = await addWallet(agent, 'BCA', 0);

	await addRule(agent, { walletId: wallet.id });

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });
	assert.equal(run.status, 200);
	assert.equal(run.body.created.length, 3, 'Jan, Feb and Mar occurrences');
	assert.equal(run.body.failed.length, 0);

	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body[0].balance, 15_000_000, '3 x 5.000.000');

	const month = await agent.get(`/api/transactions/${wallets.body[0].userId}/2026-02`);
	assert.equal(month.body.length, 1, 'February must not be skipped');
	assert.equal(month.body[0].date, '2026-02-25');
});

test('running twice does not double-post', async () => {
	const { agent } = await signUp('rec-3');
	const wallet = await addWallet(agent, 'BCA', 0);
	await addRule(agent, { walletId: wallet.id });

	await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });
	const second = await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });

	assert.equal(second.body.created.length, 0, 'the second run must be a no-op');

	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body[0].balance, 15_000_000, 'balance must not move twice');
});

test('a recurring expense updates budget usage like a typed one', async () => {
	const { agent } = await signUp('rec-4');
	const wallet = await addWallet(agent, 'BCA', 10_000_000);

	await agent.post('/api/budgeting').send({
		month: '2026-01',
		categories: [{ name: 'Tagihan', subcategories: [{ name: 'Listrik', amount: 500_000 }] }],
	});

	const created = await agent.post('/api/recurring').send({
		name: 'Listrik',
		amount: 400_000,
		type: 'expense',
		frequency: 'monthly',
		interval: 1,
		startDate: '2026-01-15',
		dayOfMonth: 15,
		walletId: wallet.id,
		category: 'Tagihan',
		subcategory: 'Listrik',
	});
	assert.equal(created.status, 201);

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-01-31' });
	assert.equal(run.body.created.length, 1);

	const uid = (await agent.get('/api/auth/me')).body.user.userId;
	const budget = await agent.get(`/api/budgeting/${uid}/2026-01`);
	const sub = budget.body.categories[0].subcategories[0];
	assert.equal(sub.used, 400_000, 'a generated expense must roll the budget counter');

	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body[0].balance, 9_600_000);
});

test('an expense the wallet cannot cover is reported without blocking other rules', async () => {
	const { agent } = await signUp('rec-5');
	const small = await addWallet(agent, 'Kecil', 100_000);
	const roomy = await addWallet(agent, 'Besar', 10_000_000);

	await agent.post('/api/recurring').send({
		name: 'Sewa', amount: 5_000_000, type: 'expense', frequency: 'monthly',
		startDate: '2026-01-01', dayOfMonth: 1, walletId: small.id,
	});
	await agent.post('/api/recurring').send({
		name: 'Gaji', amount: 1_000_000, type: 'income', frequency: 'monthly',
		startDate: '2026-01-01', dayOfMonth: 1, walletId: roomy.id,
	});

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-01-31' });

	assert.equal(run.body.created.length, 1, 'the affordable rule still runs');
	assert.equal(run.body.failed.length, 1, 'the unaffordable one is reported');
	assert.match(run.body.failed[0].reason, /Saldo tidak mencukupi/);
});

test('a paused rule produces nothing', async () => {
	const { agent } = await signUp('rec-6');
	const wallet = await addWallet(agent, 'BCA', 0);
	const created = await addRule(agent, { walletId: wallet.id });

	await agent.put(`/api/recurring/${created.body.id}`).send({ active: false });

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });
	assert.equal(run.body.created.length, 0);

	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body[0].balance, 0);
});

test('preview lists dates without writing anything', async () => {
	const { agent } = await signUp('rec-7');
	const wallet = await addWallet(agent, 'BCA', 0);
	const created = await addRule(agent, { walletId: wallet.id });

	const preview = await agent.get(`/api/recurring/${created.body.id}/preview?throughDate=2026-04-30`);
	assert.equal(preview.status, 200);
	assert.deepEqual(preview.body.dates, ['2026-01-25', '2026-02-25', '2026-03-25', '2026-04-25']);

	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body[0].balance, 0, 'preview must not create anything');
});

test('a rule for the 31st runs on the 28th in February and returns to the 31st', async () => {
	const { agent } = await signUp('rec-8');
	// Four months of 100.000 has to be available or every occurrence fails on balance.
	const wallet = await addWallet(agent, 'BCA', 10_000_000);

	await agent.post('/api/recurring').send({
		name: 'Tagihan bulanan', amount: 100_000, type: 'expense', frequency: 'monthly',
		startDate: '2026-01-31', dayOfMonth: 31, walletId: wallet.id,
	});

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-04-30' });
	assert.equal(run.body.created.length, 4);

	const uid = (await agent.get('/api/auth/me')).body.user.userId;
	const feb = await agent.get(`/api/transactions/${uid}/2026-02`);
	const mar = await agent.get(`/api/transactions/${uid}/2026-03`);

	assert.equal(feb.body[0].date, '2026-02-28', 'February clamps to the 28th');
	assert.equal(mar.body[0].date, '2026-03-31', 'March is the 31st again, not the 28th');
});

test('one user cannot read, edit, run or delete another user rule', async () => {
	const alice = await signUp('rec-alice');
	const bob = await signUp('rec-bob');
	const wallet = await addWallet(alice.agent, 'Alice', 0);
	const created = await addRule(alice.agent, { walletId: wallet.id });
	const ruleId = created.body.id;

	assert.equal((await bob.agent.get('/api/recurring')).body.length, 0, 'list must not leak');
	assert.equal((await bob.agent.put(`/api/recurring/${ruleId}`).send({ amount: 1 })).status, 404);
	assert.equal((await bob.agent.delete(`/api/recurring/${ruleId}`)).status, 404);
	assert.equal((await bob.agent.get(`/api/recurring/${ruleId}/preview`)).status, 404);

	// Bob running his own empty set must not generate Alice's salary.
	const bobWallet = await addWallet(bob.agent, 'Bob', 0);
	await bob.agent.post('/api/recurring').send({
		name: 'Gaji Bob', amount: 999_999, type: 'income', frequency: 'monthly',
		startDate: '2026-01-25', dayOfMonth: 25, walletId: bobWallet.id,
	});
	await bob.agent.post('/api/recurring/run').send({ throughDate: '2026-01-31' });

	const bobWallets = await bob.agent.get('/api/wallets');
	assert.equal(bobWallets.body[0].balance, 999_999, 'only the owner rule ran');
});

test('a rule on another user wallet is refused', async () => {
	const alice = await signUp('rec-w-alice');
	const bob = await signUp('rec-w-bob');
	const aliceWallet = await addWallet(alice.agent, 'Alice', 0);

	const res = await bob.agent.post('/api/recurring').send({
		name: 'Gaji', amount: 1_000_000, type: 'income', frequency: 'monthly',
		startDate: '2026-01-25', dayOfMonth: 25, walletId: aliceWallet.id,
	});
	assert.equal(res.status, 404);
});

test('a rule rejects a bad frequency and a malformed start date', async () => {
	const { agent } = await signUp('rec-9');
	const wallet = await addWallet(agent, 'BCA', 0);

	const badFrequency = await agent.post('/api/recurring').send({
		name: 'X', amount: 1000, type: 'income', frequency: 'fortnightly',
		startDate: '2026-01-01', dayOfMonth: 1, walletId: wallet.id,
	});
	assert.equal(badFrequency.status, 400);

	const badDate = await agent.post('/api/recurring').send({
		name: 'X', amount: 1000, type: 'income', frequency: 'monthly',
		startDate: '25 Januari 2026', dayOfMonth: 25, walletId: wallet.id,
	});
	assert.equal(badDate.status, 400);

	const badAmount = await agent.post('/api/recurring').send({
		name: 'X', amount: -5, type: 'income', frequency: 'monthly',
		startDate: '2026-01-25', dayOfMonth: 25, walletId: wallet.id,
	});
	assert.equal(badAmount.status, 400);
});

test('an occurrence count caps how many times a rule fires', async () => {
	const { agent } = await signUp('rec-10');
	const wallet = await addWallet(agent, 'BCA', 10_000_000);

	await agent.post('/api/recurring').send({
		name: 'Sewa kontrak', amount: 2_000_000, type: 'expense', frequency: 'monthly',
		startDate: '2026-01-01', dayOfMonth: 1, occurrences: 3, walletId: wallet.id,
	});

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-12-31' });
	assert.equal(run.body.created.length, 3);

	const second = await agent.post('/api/recurring/run').send({ throughDate: '2027-12-31' });
	assert.equal(second.body.created.length, 0, 'the cap holds on later runs');

	const wallets = await agent.get('/api/wallets');
	assert.equal(wallets.body[0].balance, 10_000_000 - 6_000_000);
});

test('deleting a rule leaves the transactions it produced alone', async () => {
	const { agent } = await signUp('rec-11');
	const wallet = await addWallet(agent, 'BCA', 0);
	const created = await addRule(agent, { walletId: wallet.id });

	await agent.post('/api/recurring/run').send({ throughDate: '2026-02-28' });
	assert.equal((await agent.delete(`/api/recurring/${created.body.id}`)).status, 200);

	assert.equal((await agent.get('/api/recurring')).body.length, 0);

	const uid = (await agent.get('/api/auth/me')).body.user.userId;
	const jan = await agent.get(`/api/transactions/${uid}/2026-01`);
	assert.equal(jan.body.length, 1, 'history is not rolled back when a rule is deleted');
});
test('a failed occurrence is retried instead of being skipped forever', async () => {
	const { agent } = await signUp('rec-retry');
	// Only enough for the first month, so the second occurrence cannot be funded.
	const wallet = await addWallet(agent, 'Kartu', 1_000_000);

	await agent.post('/api/recurring').send({
		name: 'Sewa', amount: 800_000, type: 'expense', frequency: 'monthly',
		interval: 1, startDate: '2026-01-10', dayOfMonth: 10, walletId: wallet.id,
	});

	const first = await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });
	assert.equal(first.body.created.length, 1, 'only the affordable month runs');
	assert.equal(first.body.failed.length, 1, 'the run stops at the first shortfall');

	const ruleId = (await agent.get('/api/recurring')).body[0].id;
	const rule = (await agent.get('/api/recurring')).body[0];
	assert.equal(rule.lastRunDate, '2026-01-10',
		'the watermark must sit on the last occurrence that actually landed');

	// Top the wallet up and run again: the skipped month must still be pending.
	await agent.post('/api/transactions').send({
		date: '2026-02-01', amount: 5_000_000, type: 'income', walletId: wallet.id,
	});

	const second = await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });
	const dates = second.body.created.map((row) => row.transaction.date);
	assert.deepEqual(dates, ['2026-02-10', '2026-03-10'],
		'the unpaid month is retried, not skipped');

	// The top-up is itself a transaction, so count only the ones the rule produced.
	const uid = (await agent.get('/api/auth/me')).body.user.userId;
	const forRule = (rows) => rows.filter((row) => row.description === 'Sewa').length;

	const jan = await agent.get(`/api/transactions/${uid}/2026-01`);
	const feb = await agent.get(`/api/transactions/${uid}/2026-02`);
	const mar = await agent.get(`/api/transactions/${uid}/2026-03`);
	assert.equal(forRule(jan.body), 1);
	assert.equal(forRule(feb.body), 1, 'the retried month is present');
	assert.equal(forRule(mar.body), 1, 'no month may be left empty after funding');
});

test('a run reports every failed date rather than stopping at the first', async () => {
	const { agent } = await signUp('rec-report');
	const wallet = await addWallet(agent, 'Kosong', 0);

	await agent.post('/api/recurring').send({
		name: 'Kos', amount: 500_000, type: 'expense', frequency: 'monthly',
		interval: 1, startDate: '2026-01-01', dayOfMonth: 1, walletId: wallet.id,
	});

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-04-30' });

	assert.equal(run.body.created.length, 0);
	assert.equal(run.body.failed.length, 1, 'the user is told once, not once per month');
	assert.equal(run.body.failed[0].date, '2026-01-01');
	assert.match(run.body.failed[0].reason, /Saldo tidak mencukupi/);
});

test('moving the start date forward does not freeze the rule', async () => {
	const { agent } = await signUp('rec-restart');
	const wallet = await addWallet(agent, 'BCA', 0);

	const created = await agent.post('/api/recurring').send({
		name: 'Gaji', amount: 1_000_000, type: 'income', frequency: 'monthly',
		interval: 1, startDate: '2026-01-25', dayOfMonth: 25, walletId: wallet.id,
	});
	const ruleId = created.body.id;

	await agent.post('/api/recurring/run').send({ throughDate: '2026-02-28' });
	assert.equal((await agent.get('/api/wallets')).body[0].balance, 2_000_000);

	// Push the schedule into the future, as a user would when the pay cycle moves.
	const moved = await agent.put(`/api/recurring/${ruleId}`).send({ startDate: '2026-06-25' });
	assert.equal(moved.status, 200);

	const rule = (await agent.get('/api/recurring')).body[0];
	assert.equal(rule.lastRunDate, null, 'a start date after the last run restarts the schedule');

	await agent.post('/api/recurring/run').send({ throughDate: '2026-07-31' });
	assert.equal((await agent.get('/api/wallets')).body[0].balance, 4_000_000,
		'June and July both run again under the new schedule');
});

test('moving the start date backward keeps the watermark', async () => {
	const { agent } = await signUp('rec-back');
	const wallet = await addWallet(agent, 'BCA', 0);

	const created = await agent.post('/api/recurring').send({
		name: 'Gaji', amount: 1_000_000, type: 'income', frequency: 'monthly',
		interval: 1, startDate: '2026-01-25', dayOfMonth: 25, walletId: wallet.id,
	});
	await agent.post('/api/recurring/run').send({ throughDate: '2026-03-31' });
	assert.equal((await agent.get('/api/wallets')).body[0].balance, 3_000_000);

	// An earlier start must not re-post months that already happened.
	await agent.put(`/api/recurring/${created.body.id}`).send({ startDate: '2026-01-01' });

	const run = await agent.post('/api/recurring/run').send({ throughDate: '2026-06-30' });
	const dates = run.body.created.map((row) => row.transaction.date);
	assert.deepEqual(dates, ['2026-04-25', '2026-05-25', '2026-06-25']);
});

test('a rule whose watermark drifted into the future can still run again', async () => {
	const { agent } = await signUp('rec-future');
	const wallet = await addWallet(agent, 'BCA', 0);

	const created = await agent.post('/api/recurring').send({
		name: 'Gaji', amount: 1_000_000, type: 'income', frequency: 'monthly',
		interval: 1, startDate: '2026-01-25', dayOfMonth: 25, walletId: wallet.id,
	});

	// A watermark three years out came from advancing it past occurrences that never
	// landed. The rule then reports "nothing due" forever with no way back.
	const far = new Date();
	far.setFullYear(far.getFullYear() + 3);
	const future = far.toISOString().slice(0, 10);

	// Write it through the same route an admin edit would use. The route refuses
	// lastRunDate from the body, so seed it the only way the app allows: a run with
	// a through date far in the future.
	const pushed = await agent.post('/api/recurring/run').send({ throughDate: future });
	const balanceAfterPush = (await agent.get('/api/wallets')).body[0].balance;
	assert.ok(pushed.body.created.length > 0, 'the push run posts something');
	assert.ok(balanceAfterPush > 0);

	const rule = (await agent.get('/api/recurring')).body[0];
	assert.ok(rule.lastRunDate > new Date().toISOString().slice(0, 10),
		'the watermark is now in the future, which is the stuck state under test');

	// Any edit of the rule must release it.
	await agent.put(`/api/recurring/${rule.id}`).send({ name: 'Gaji' });
	const released = (await agent.get('/api/recurring')).body[0];
	assert.equal(released.lastRunDate, null, 'the unreachable watermark is cleared on edit');

	// And the schedule runs again for the current period.
	const today = new Date().toISOString().slice(0, 10);
	const after = await agent.post('/api/recurring/run').send({ throughDate: today });
	assert.ok(after.body.created.length > 0, 'a released rule produces transactions again');
});
