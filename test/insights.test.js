/**
 * Advanced financial insights.
 *
 * The expected numbers below are chosen so each one can be checked by hand:
 * income is a flat 10.000.000 every month and spending rises 2jt to 6jt, which
 * makes the Engel ratio, the lifestyle-creep direction and the Pareto split
 * all exactly predictable.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../server');

let runCounter = 0;

async function signUp(username) {
	const agent = request.agent(app);
	const unique = `${username}-${process.pid}-${runCounter++}`;
	const res = await agent
		.post('/api/auth/register')
		.send({ username: unique, password: 'supersecret123' });
	assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
	return { agent, userId: (await agent.get('/api/auth/me')).body.user.userId };
}

async function addWallet(agent, balance) {
	const res = await agent.post('/api/wallets').send({ name: 'BCA', balance, frozen: 0 });
	assert.equal(res.status, 201);
	return res.body;
}

const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const INCOME = 10_000_000;
/** Rising spending, the shape a lifestyle creep produces. */
const EXPENSES = [2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000, 6_000_000];

/**
 * Seeds the fixture above: 40% needs, 60% wants each month, and labels the two
 * categories so Engel has a split to work with.
 */
async function seedKnownSeries(agent, walletId) {
	for (let i = 0; i < MONTHS.length; i++) {
		const month = MONTHS[i];
		const total = EXPENSES[i];
		const wants = Math.round(total * 0.6);
		const needs = total - wants;

		await agent.post('/api/transactions').send({
			date: `${month}-10`, amount: INCOME, type: 'income',
			category: 'Pemasukan', subcategory: 'Gaji', walletId,
		});
		await agent.post('/api/transactions').send({
			date: `${month}-12`, amount: needs, type: 'expense',
			category: 'Tagihan', subcategory: 'Listrik', walletId,
		});
		await agent.post('/api/transactions').send({
			date: `${month}-14`, amount: wants, type: 'expense',
			category: 'Hiburan', subcategory: 'Jalan', walletId,
		});
	}

	return agent.post('/api/budgeting').send({
		month: '2026-10',
		categories: [
			{ name: 'Tagihan', kind: 'needs', total: 500_000, subcategories: [{ name: 'Listrik', amount: 500_000, used: 0 }] },
			{ name: 'Hiburan', kind: 'wants', total: 500_000, subcategories: [{ name: 'Jalan', amount: 500_000, used: 0 }] },
		],
	});
}

/* ------------------------------------------------------------ budget label */

test('a budget category keeps its needs/wants label', async () => {
	const { agent } = await signUp('ins-kind');
	const budget = await agent.post('/api/budgeting').send({
		month: '2026-10',
		categories: [
			{ name: 'Tagihan', kind: 'needs', total: 100_000, subcategories: [{ name: 'Listrik', amount: 100_000 }] },
			{ name: 'Hiburan', kind: 'wants', total: 100_000, subcategories: [{ name: 'Jalan', amount: 100_000 }] },
		],
	});
	assert.equal(budget.status, 201);

	const saved = budget.body.categories;
	assert.equal(saved[0].kind, 'needs');
	assert.equal(saved[1].kind, 'wants');

	// And it survives a read, which is what the insights depend on.
	const uid = (await agent.get('/api/auth/me')).body.user.userId;
	const read = await agent.get(`/api/budgeting/${uid}/2026-10`);
	assert.equal(read.body.categories[0].kind, 'needs');
});

test('an unlabelled category stays unlabelled rather than being guessed', async () => {
	const { agent } = await signUp('ins-unset');
	const budget = await agent.post('/api/budgeting').send({
		month: '2026-10',
		categories: [{ name: 'Tagihan', total: 100_000, subcategories: [{ name: 'Listrik', amount: 100_000 }] }],
	});
	assert.equal(budget.status, 201);
	assert.equal(budget.body.categories[0].kind, null, 'no default may be invented');

	// A label that is not one of the two is rejected rather than stored as-is.
	const bad = await agent.post('/api/budgeting').send({
		month: '2026-11',
		categories: [{ name: 'X', kind: 'mungkin', total: 1, subcategories: [{ name: 'Y', amount: 1 }] }],
	});
	assert.equal(bad.body.categories[0].kind, null);
});

test('updating a budget preserves and can change the label', async () => {
	const { agent } = await signUp('ins-kind-edit');
	const created = await agent.post('/api/budgeting').send({
		month: '2026-10',
		categories: [{ name: 'Tagihan', kind: 'needs', total: 100, subcategories: [{ name: 'L', amount: 100 }] }],
	});

	const flipped = await agent.put(`/api/budgeting/${created.body.id}`).send({
		categories: [{ name: 'Tagihan', kind: 'wants', total: 100, subcategories: [{ name: 'L', amount: 100 }] }],
	});
	assert.equal(flipped.status, 200);

	const uid = (await agent.get('/api/auth/me')).body.user.userId;
	const read = await agent.get(`/api/budgeting/${uid}/2026-10`);
	assert.equal(read.body.categories[0].kind, 'wants');
});

/* ------------------------------------------------------------------- Engel */

test('Engel ratio and the needs/wants split match hand calculations', async () => {
	const { agent } = await signUp('ins-engel');
	const wallet = await addWallet(agent, 100_000_000);
	await seedKnownSeries(agent, wallet.id);

	const res = await agent.get('/api/insights');
	assert.equal(res.status, 200);

	const series = res.body.engel.series;
	assert.equal(series.length, 6);
	assert.equal(series[0].month, '2026-05');
	assert.equal(series[series.length - 1].month, '2026-10');

	// 2.000.000 / 10.000.000 = 20%
	assert.equal(series[0].ratio, 20);
	// 6.000.000 / 10.000.000 = 60%
	assert.equal(series[series.length - 1].ratio, 60);

	const october = series[series.length - 1];
	assert.equal(october.needs, 2_400_000, '40% of 6jt');
	assert.equal(october.wants, 3_600_000, '60% of 6jt');
	assert.equal(october.unmarked, 0);
	assert.equal(october.coverage, 100);

	assert.equal(res.body.engel.coverage.percent, 100);
});

test('Engel grades the month and detects lifestyle creep', async () => {
	const { agent } = await signUp('ins-engel-grade');
	const wallet = await addWallet(agent, 100_000_000);
	await seedKnownSeries(agent, wallet.id);

	const assessment = (await agent.get('/api/insights')).body.engel.assessment;

	assert.equal(assessment.grade, 'Tinggi', '60% sits in the 50-70 band');
	assert.equal(assessment.creeping, true, 'the ratio rose every month');
	assert.equal(assessment.change, 40, '60 - 20');
	assert.equal(assessment.monthsMeasured, 6);
});

test('Engel reports its own limits instead of scoring thin data', async () => {
	const { agent, userId } = await signUp('ins-engel-thin');
	const wallet = await addWallet(agent, 10_000_000);

	// One month only: below the three-month minimum.
	await agent.post('/api/transactions').send({
		date: '2026-10-10', amount: 1_000_000, type: 'income', walletId: wallet.id,
	});
	await agent.post('/api/transactions').send({
		date: '2026-10-12', amount: 500_000, type: 'expense', category: 'Tagihan', walletId: wallet.id,
	});

	const res = await agent.get('/api/insights');
	assert.equal(res.body.engel.assessment.grade, null);
	assert.match(res.body.engel.assessment.reason, /Butuh 3 bulan/);
	assert.equal(res.body.dataQuality.monthsWithIncome, 1);
	assert.ok(userId);
});

test('Engel marks spending it cannot classify instead of guessing', async () => {
	const { agent } = await signUp('ins-engel-unmarked');
	const wallet = await addWallet(agent, 100_000_000);
	await seedKnownSeries(agent, wallet.id);

	// A category the budget never mentions.
	for (const month of MONTHS) {
		await agent.post('/api/transactions').send({
			date: `${month}-20`, amount: 1_000_000, type: 'expense',
			category: 'Tak Dikenal', walletId: wallet.id,
		});
	}

	const body = (await agent.get('/api/insights')).body;
	assert.equal(body.engel.coverage.percent < 100, true, 'coverage must fall below 100%');
	assert.ok(body.engel.coverage.unmarkedTotal > 0);

	const october = body.engel.series.find((row) => row.month === '2026-10');
	assert.equal(october.unmarked, 1_000_000);
	// The gross ratio still counts every rupiah.
	assert.equal(october.ratio, 70, '6jt + 1jt over 10jt income');
});

test('Engel flags an unsteady income as unreliable', async () => {
	const { agent } = await signUp('ins-engel-unstable');
	const wallet = await addWallet(agent, 100_000_000);

	// Wildly varying income: Engel's law does not mean anything here.
	const incomes = [10_000_000, 4_000_000, 18_000_000, 7_000_000, 12_000_000, 9_000_000];
	for (let i = 0; i < MONTHS.length; i++) {
		await agent.post('/api/transactions').send({
			date: `${MONTHS[i]}-10`, amount: incomes[i], type: 'income', walletId: wallet.id,
		});
		await agent.post('/api/transactions').send({
			date: `${MONTHS[i]}-14`, amount: 2_000_000, type: 'expense', category: 'Tagihan', walletId: wallet.id,
		});
	}

	const body = (await agent.get('/api/insights')).body;
	assert.equal(body.dataQuality.incomeStable, false,
		'a freelance-style income must not be scored as if it were a salary');
});

/* --------------------------------------------------------------- Parkinson */

test('Parkinson baseline is the median of recent months, not the average', async () => {
	const { agent } = await signUp('ins-parkinson');
	const wallet = await addWallet(agent, 100_000_000);
	await seedKnownSeries(agent, wallet.id);

	const parkinson = (await agent.get('/api/insights')).body.parkinson;

	// Last three expenses are 3.5jt, 4jt, 6jt; the median is 4jt.
	// The average would be 4.5jt, and the outlier would be treated as normal.
	assert.equal(parkinson.baseline, 4_000_000);
	assert.equal(parkinson.monthsUsed, 3);
	assert.equal(parkinson.current, 6_000_000);
	assert.equal(parkinson.overBy, 2_000_000);
	assert.equal(parkinson.overByPercent, 50);
	assert.equal(parkinson.roomToSpend, 6_000_000);
});

test('Parkinson says it is not ready with too little history', async () => {
	const { agent } = await signUp('ins-parkinson-thin');
	const res = await agent.get('/api/insights');
	assert.equal(res.body.parkinson.ready, false);
	assert.match(res.body.parkinson.reason, /Butuh 3 bulan/);
});

/* ------------------------------------------------------------------ Pareto */

test('Pareto reports the smallest set that reaches the target', async () => {
	const { agent } = await signUp('ins-pareto');
	const wallet = await addWallet(agent, 100_000_000);
	await seedKnownSeries(agent, wallet.id);

	const pareto = (await agent.get('/api/insights')).body.pareto;

	assert.equal(pareto.ready, true);
	assert.equal(pareto.categories[0].name, 'Hiburan');
	assert.equal(pareto.categories[0].percent, 60);
	assert.equal(pareto.categories[1].name, 'Tagihan');
	assert.equal(pareto.categories[1].percent, 40);
	assert.equal(pareto.categories[1].cumulative, 100);

	// One category reaches only 60%, so it cannot be the whole answer. Reporting
	// it as the vital few would declare a still-essential category trivial.
	assert.equal(pareto.vitalFew, 2);
	assert.equal(pareto.vitalFewShare, 100);
	assert.deepEqual(pareto.trivialMany, []);
});

test('Pareto separates the trivial many once one category dominates', async () => {
	const { agent } = await signUp('ins-pareto-dominant');
	const wallet = await addWallet(agent, 100_000_000);

	for (const month of MONTHS) {
		await agent.post('/api/transactions').send({
			date: `${month}-10`, amount: INCOME, type: 'income', walletId: wallet.id,
		});
		// 90% in one category, the rest split three ways.
		for (const [category, amount] of [['Makan', 4_500_000], ['BBM', 300_000], ['Parkir', 150_000], ['Kopi', 50_000]]) {
			await agent.post('/api/transactions').send({
				date: `${month}-12`, amount, type: 'expense', category, walletId: wallet.id,
			});
		}
	}

	const pareto = (await agent.get('/api/insights')).body.pareto;
	assert.equal(pareto.categories[0].name, 'Makan');
	assert.equal(pareto.categories[0].percent, 90);
	assert.equal(pareto.vitalFew, 1, 'one category already passes the target');
	assert.equal(pareto.trivialMany.length, 3);
	assert.deepEqual(
		pareto.trivialMany.map((row) => row.name),
		['BBM', 'Parkir', 'Kopi']
	);
});

test('Pareto handles a user with no spending', async () => {
	const { agent } = await signUp('ins-pareto-empty');
	const res = await agent.get('/api/insights');
	assert.equal(res.body.pareto.ready, false);
	assert.ok(res.body.pareto.reason);
});

/* ------------------------------------------------------------------ Wealth */

test('the simulator defaults to the user own saving behaviour', async () => {
	const { agent } = await signUp('ins-wealth');
	const wallet = await addWallet(agent, 100_000_000);
	await seedKnownSeries(agent, wallet.id);

	const wealth = (await agent.get('/api/insights')).body.wealth;

	// Average income 10jt, average expense 3.5jt, so 6.5jt saved per month.
	assert.equal(wealth.monthlySaving, 6_500_000);
	assert.equal(wealth.savingRateRaw, 65);
	// A 65% saving rate is one unusual month, not a rate to project thirty years
	// from, so the projection is capped and the cap is disclosed.
	assert.equal(wealth.annualRate, 30);
	assert.equal(wealth.savingRateCapped, true);
	assert.equal(wealth.maxProjectionRate, 30);
	assert.equal(wealth.ruleOf72, 2.4);
});

test('a zero rate produces real milestones, not null', async () => {
	// Found against real data: a user with no wallet and no income has a zero
	// saving rate, and dividing by that rate turned every milestone into NaN, which
	// the page then rendered as "Rp null".
	const { agent } = await signUp('ins-zero-rate');

	const body = (await agent.get('/api/insights')).body.wealth;
	assert.equal(body.annualRate, 0);
	assert.equal(body.ruleOf72, null);

	for (const milestone of body.milestones) {
		assert.ok(Number.isFinite(milestone.amount), `milestone ${milestone.years} is ${milestone.amount}`);
		assert.equal(milestone.amount, 0);
	}

	// Same path through the simulator, with an explicit zero rate.
	const sim = await agent.get('/api/insights/simulate?wealth=0&monthlySaving=0&rate=0&years=5');
	for (const row of sim.body.path) {
		assert.ok(Number.isFinite(row.amount), `year ${row.year} is ${row.amount}`);
	}
});

test('deposits alone still compound into a balance at zero rate', async () => {
	const { agent } = await signUp('ins-zero-rate-deposit');
	// 1.000.000 a month for 10 years, no interest at all: 120.000.000.
	const sim = await agent.get('/api/insights/simulate?wealth=0&monthlySaving=1000000&rate=0&years=10');
	const year10 = sim.body.path.find((row) => row.year === 10);
	assert.equal(year10.amount, 120_000_000);
});

test('Rule of 72 doubles at 7.2 percent in ten years', async () => {
	const { agent } = await signUp('ins-rule72');
	const res = await agent.get('/api/insights/simulate?wealth=10000000&monthlySaving=0&rate=7.2&years=10');

	assert.equal(res.status, 200);
	assert.equal(res.body.ruleOf72, 10);
	assert.ok(Math.abs(res.body.exactDoubling - 9.97) < 0.1, `got ${res.body.exactDoubling}`);

	const year10 = res.body.path.find((row) => row.year === 10);
	assert.ok(Math.abs(year10.amount - 20_000_000) < 200_000, `got ${year10.amount}`);
});

test('the simulator validates its inputs', async () => {
	const { agent } = await signUp('ins-simulate-bad');

	assert.equal((await agent.get('/api/insights/simulate?rate=500')).status, 400);
	assert.equal((await agent.get('/api/insights/simulate?rate=-1')).status, 400);
	assert.equal((await agent.get('/api/insights/simulate?wealth=-5')).status, 400);
	assert.equal((await agent.get('/api/insights/simulate?monthlySaving=-1')).status, 400);

	const ok = await agent.get('/api/insights/simulate?rate=0');
	assert.equal(ok.status, 200, 'a zero rate must not divide by zero');
	assert.equal(ok.body.ruleOf72, null);
});

test('the simulator uses the stored balance when no override is given', async () => {
	const { agent } = await signUp('ins-simulate-stored');
	await addWallet(agent, 42_000_000);

	const stored = await agent.get('/api/insights/simulate?rate=0');
	assert.equal(stored.body.usingStoredWealth, true);
	assert.equal(stored.body.current, 42_000_000);

	const overridden = await agent.get('/api/insights/simulate?rate=0&wealth=1000000');
	assert.equal(overridden.body.usingStoredWealth, false);
	assert.equal(overridden.body.current, 1_000_000);
});

/* ---------------------------------------------------------- isolation */

test('insights never leak another user data', async () => {
	const alice = await signUp('ins-alice');
	const bob = await signUp('ins-bob');
	const wallet = await addWallet(alice.agent, 100_000_000);
	await seedKnownSeries(alice.agent, wallet.id);

	const bobView = await bob.agent.get('/api/insights');
	assert.equal(bobView.status, 200);
	assert.equal(bobView.body.pareto.ready, false, 'Bob has no spending of his own');
	assert.equal(bobView.body.wealth.current, 0, 'Bob sees none of Alice money');
	assert.equal(bobView.body.dataQuality.monthsWithExpense, 0);
});

test('insights require a session', async () => {
	const res = await request(app).get('/api/insights');
	assert.equal(res.status, 401);
	assert.equal((await request(app).get('/api/insights/simulate')).status, 401);
});