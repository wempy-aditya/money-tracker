const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');

const db = firestore();
const budgetsCollection = db.collection('budgets');

const ownerOf = (req) => req.auth.userId;

/**
 * Budgets are scoped to the signed-in user. The userId used to come from the
 * request body and the path, either of which any caller could forge
 * (NOTES.md bug #4).
 */

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Whether a category covers a need or a want. Engel's law only says something
 * useful once that split exists, but an unlabelled category must stay unlabelled
 * rather than be guessed at: defaulting to either value would quietly turn the
 * score into a claim the data does not support.
 */
const CATEGORY_KINDS = ['needs', 'wants'];

function normalizeKind(value) {
	return CATEGORY_KINDS.includes(value) ? value : null;
}

function normalizeCategories(categories) {
	if (!Array.isArray(categories) || categories.length === 0) {
		throw Object.assign(new Error('Categories must be a non-empty array'), { status: 400 });
	}
	return categories.map((category) => {
		const total = Number(category.total ?? 0);
		const subcategories = Array.isArray(category.subcategories) ? category.subcategories : [];
		return {
			name: String(category.name || '').trim(),
			total,
			kind: normalizeKind(category.kind),
			subcategories: subcategories.map((sub) => ({
				name: String(sub.name || '').trim(),
				amount: Number(sub.amount ?? 0),
				used: Number(sub.used ?? 0)
			}))
		};
	});
}

// 🔹 Tambah rencana anggaran
router.post('/', async (req, res) => {
	try {
		const { month, categories } = req.body;
		const userId = ownerOf(req);

		if (!MONTH_PATTERN.test(String(month || ''))) {
			return res.status(400).json({ error: 'Month must be in YYYY-MM format' });
		}

		let normalized;
		try {
			normalized = normalizeCategories(categories);
		} catch (error) {
			return res.status(error.status || 400).json({ error: error.message });
		}

		const newBudget = { userId, month, categories: normalized };

		// A month holds exactly one budget per user. POST used to insert blindly,
		// so saving the same month twice left two rows and every read silently
		// picked the first. Make the create idempotent per user+month instead.
		const existing = await budgetsCollection
			.where('userId', '==', userId)
			.where('month', '==', month)
			.get();

		if (!existing.empty) {
			const budgetId = existing.docs[0].id;
			await budgetsCollection.doc(budgetId).update({ categories: normalized });
			return res.status(200).json({ id: budgetId, ...newBudget });
		}

		const docRef = await budgetsCollection.add(newBudget);
		res.status(201).json({ id: docRef.id, ...newBudget });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// 🔹 Ambil anggaran berdasarkan bulan
router.get('/:userId/:month', async (req, res) => {
	try {
		const { month } = req.params;
		const userId = ownerOf(req);

		if (req.params.userId !== userId) {
			return res.status(403).json({ error: 'Forbidden' });
		}

		const querySnapshot = await budgetsCollection
			.where('userId', '==', userId)
			.where('month', '==', month)
			.get();

		if (querySnapshot.empty) {
			return res.status(404).json({ message: 'Budget not found' });
		}

		const budget = querySnapshot.docs[0].data();
		res.status(200).json({ id: querySnapshot.docs[0].id, ...budget });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// 🔹 Update anggaran (ubah kategori/subkategori)
router.put('/:id', async (req, res) => {
	try {
		const { categories } = req.body;
		const userId = ownerOf(req);

		const existing = await budgetsCollection.doc(req.params.id).get();
		if (!existing.exists || existing.data().userId !== userId) {
			return res.status(404).json({ error: 'Budget not found' });
		}

		let normalized;
		try {
			normalized = normalizeCategories(categories);
		} catch (error) {
			return res.status(error.status || 400).json({ error: error.message });
		}

		await budgetsCollection.doc(req.params.id).update({ categories: normalized });
		res.status(200).json({ message: 'Budget updated' });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// 🔹 Hapus anggaran
router.delete('/:id', async (req, res) => {
	try {
		const userId = ownerOf(req);
		const existing = await budgetsCollection.doc(req.params.id).get();

		if (!existing.exists || existing.data().userId !== userId) {
			return res.status(404).json({ error: 'Budget not found' });
		}

		await budgetsCollection.doc(req.params.id).delete();
		res.status(200).json({ message: 'Budget deleted' });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

module.exports = router;