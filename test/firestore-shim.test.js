const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Firestore, generateId } = require('../db/firestore');

function tempFirestore() {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-')), 'test.db');
	return new Firestore(file);
}

test('add() returns a Firestore-shaped reference with an id', async () => {
	const db = tempFirestore();
	const ref = await db.collection('wallets').add({ name: 'BCA', balance: 1000 });
	assert.equal(typeof ref.id, 'string');
	assert.equal(ref.id.length, 20, 'firestore ids are 20 chars');
	db.close();
});

test('doc.get() returns exists/data()/id', async () => {
	const db = tempFirestore();
	const { id } = await db.collection('wallets').add({ name: 'BCA', balance: 1000 });
	const snap = await db.collection('wallets').doc(id).get();
	assert.equal(snap.exists, true);
	assert.equal(snap.id, id);
	assert.equal(snap.data().name, 'BCA');
	db.close();
});

test('doc.get() on missing doc reports exists=false and data()=undefined', async () => {
	const db = tempFirestore();
	const snap = await db.collection('wallets').doc('does-not-exist').get();
	assert.equal(snap.exists, false);
	assert.equal(snap.data(), undefined);
	db.close();
});

test('doc.update() merges fields like Firestore, not replace', async () => {
	const db = tempFirestore();
	const { id } = await db.collection('wallets').add({ name: 'BCA', balance: 1000, frozen: 0 });
	await db.collection('wallets').doc(id).update({ balance: 2500 });
	const data = (await db.collection('wallets').doc(id).get()).data();
	assert.equal(data.balance, 2500, 'updated field changed');
	assert.equal(data.frozen, 0, 'untouched field preserved');
	assert.equal(data.name, 'BCA', 'untouched field preserved');
	db.close();
});

test('doc.update() on missing doc throws NOT_FOUND', async () => {
	const db = tempFirestore();
	await assert.rejects(
		() => db.collection('wallets').doc('nope').update({ balance: 1 }),
		(error) => error.code === 5
	);
	db.close();
});

test('doc.delete() removes the document', async () => {
	const db = tempFirestore();
	const { id } = await db.collection('wallets').add({ name: 'BCA', balance: 1000 });
	await db.collection('wallets').doc(id).delete();
	assert.equal((await db.collection('wallets').doc(id).get()).exists, false);
	db.close();
});

test('snapshot exposes docs/empty/size/forEach', async () => {
	const db = tempFirestore();
	const col = db.collection('wallets');
	await col.add({ name: 'a', balance: 1 });
	await col.add({ name: 'b', balance: 2 });

	const snap = await col.get();
	assert.equal(snap.size, 2);
	assert.equal(snap.empty, false);
	assert.equal(snap.docs.length, 2);

	const seen = [];
	snap.forEach((doc) => seen.push(doc.data().name));
	assert.deepEqual(seen.sort(), ['a', 'b']);

	const empty = await db.collection('goals').get();
	assert.equal(empty.empty, true);
	assert.equal(empty.size, 0);
	db.close();
});

test('where("==") filters on a top-level field', async () => {
	const db = tempFirestore();
	const col = db.collection('transactions');
	await col.add({ userId: 'u1', amount: 10, type: 'income' });
	await col.add({ userId: 'u2', amount: 20, type: 'expense' });

	const snap = await col.where('userId', '==', 'u1').get();
	assert.equal(snap.size, 1);
	assert.equal(snap.docs[0].data().amount, 10);
	db.close();
});

test('chained where() uses AND semantics', async () => {
	const db = tempFirestore();
	const col = db.collection('transactions');
	await col.add({ userId: 'u1', date: '2026-09-01', type: 'expense' });
	await col.add({ userId: 'u1', date: '2026-09-15', type: 'expense' });
	await col.add({ userId: 'u1', date: '2026-10-02', type: 'expense' });
	await col.add({ userId: 'u2', date: '2026-09-10', type: 'expense' });

	const snap = await col
		.where('userId', '==', 'u1')
		.where('date', '>=', '2026-09-01')
		.where('date', '<=', '2026-09-31')
		.get();

	assert.equal(snap.size, 2, 'only u1 in september');
	db.close();
});

test('date range comparison is lexicographic and works for YYYY-MM-DD', async () => {
	const db = tempFirestore();
	const col = db.collection('transactions');
	for (const date of ['2026-08-31', '2026-09-01', '2026-09-30', '2026-10-01']) {
		await col.add({ userId: 'u1', date });
	}
	const snap = await col.where('date', '>=', '2026-09-01').where('date', '<=', '2026-09-31').get();
	// No orderBy means key order (document id), same as Firestore — the range
	// filter itself is what matters here, so compare as a set.
	const dates = snap.docs.map((d) => d.data().date).sort();
	assert.deepEqual(dates, ['2026-09-01', '2026-09-30']);
	db.close();
});

test('orderBy sorts numerically, not lexicographically', async () => {
	const db = tempFirestore();
	const col = db.collection('wallets');
	// Lexicographic sorting would put 1000 before 200 and 90.
	await col.add({ name: 'a', balance: 1000 });
	await col.add({ name: 'b', balance: 90 });
	await col.add({ name: 'c', balance: 200 });

	const snap = await col.orderBy('balance').get();
	const balances = snap.docs.map((d) => d.data().balance);
	assert.deepEqual(balances, [90, 200, 1000]);
	db.close();
});

test('orderBy desc reverses the order', async () => {
	const db = tempFirestore();
	const col = db.collection('wallets');
	await col.add({ name: 'a', balance: 10 });
	await col.add({ name: 'b', balance: 30 });
	await col.add({ name: 'c', balance: 20 });

	const snap = await col.orderBy('balance', 'desc').get();
	assert.deepEqual(snap.docs.map((d) => d.data().balance), [30, 20, 10]);
	db.close();
});

test('nested objects and arrays survive a round trip intact', async () => {
	const db = tempFirestore();
	const categories = [
		{ name: 'Makan', total: 1500000, subcategories: [{ name: 'Makan di luar', amount: 500000, used: 125000 }] },
		{ name: 'Transport', total: 400000, subcategories: [{ name: 'Bensin', amount: 400000, used: 0 }] }
	];
	const { id } = await db.collection('budgets').add({ userId: 'u1', month: '2026-09', categories });

	const data = (await db.collection('budgets').doc(id).get()).data();
	assert.deepEqual(data.categories, categories);

	// The budgets route mutates used, then writes the whole document back.
	data.categories[0].subcategories[0].used = 300000;
	await db.collection('budgets').doc(id).update({ categories: data.categories });
	const reread = (await db.collection('budgets').doc(id).get()).data();
	assert.equal(reread.categories[0].subcategories[0].used, 300000);
	assert.equal(reread.categories[1].subcategories[0].amount, 400000, 'sibling untouched');
	db.close();
});

test('data() returns a copy — mutating it does not corrupt stored state', async () => {
	const db = tempFirestore();
	const { id } = await db.collection('wallets').add({ name: 'BCA', balance: 100 });
	const snap = await db.collection('wallets').doc(id).get();
	snap.data().balance = 99999;
	const reread = (await db.collection('wallets').doc(id).get()).data();
	assert.equal(reread.balance, 100, 'store unaffected by caller mutation');
	db.close();
});

test('collections are isolated from each other', async () => {
	const db = tempFirestore();
	await db.collection('wallets').add({ name: 'x' });
	await db.collection('goals').add({ name: 'x' });
	assert.equal((await db.collection('wallets').get()).size, 1);
	assert.equal((await db.collection('goals').get()).size, 1);
	db.close();
});

test('data survives closing and reopening the file', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
	const file = path.join(dir, 'persist.db');

	const first = new Firestore(file);
	const { id } = await first.collection('wallets').add({ name: 'BCA', balance: 5000 });
	first.close();

	const second = new Firestore(file);
	const data = (await second.collection('wallets').doc(id).get()).data();
	assert.equal(data.balance, 5000);
	second.close();
});

test('generated ids are unique across many inserts', async () => {
	const db = tempFirestore();
	const col = db.collection('transactions');
	for (let i = 0; i < 200; i++) await col.add({ userId: 'u1', amount: i });
	const snap = await col.get();
	assert.equal(snap.size, 200);
	db.close();
});

test('generateId() produces url-safe 20-char ids', () => {
	const id = generateId();
	assert.equal(id.length, 20);
	assert.match(id, /^[A-Za-z0-9_-]+$/);
});

test('runTransaction commits on success and rolls back on throw', async () => {
	const db = tempFirestore();
	const col = db.collection('wallets');

	await db.runTransaction(async () => {
		await col.add({ name: 'a' });
		await col.add({ name: 'b' });
	});
	assert.equal((await col.get()).size, 2);

	await assert.rejects(() =>
		db.runTransaction(async () => {
			await col.add({ name: 'c' });
			throw new Error('boom');
		})
	);
	assert.equal((await col.get()).size, 2, 'rollback undid the insert');
	db.close();
});

test('where() rejects nested paths and unsupported operators', async () => {
	const db = tempFirestore();
	assert.throws(() => db.collection('x').where('a.b', '==', 1), /nested field/);
	assert.throws(() => db.collection('x').where('a', 'in', [1]), /unsupported operator/);
	db.close();
});