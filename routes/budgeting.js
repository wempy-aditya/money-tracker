const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();
const budgetsCollection = db.collection('budgets');

// 🔹 Tambah rencana anggaran
router.post('/', async (req, res) => {
  try {
    const { userId, month, categories } = req.body;

    const newBudget = {
      userId,
      month,
      categories
    };

    const docRef = await budgetsCollection.add(newBudget);
    res.status(201).json({ id: docRef.id, ...newBudget });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Ambil anggaran berdasarkan bulan & userId
router.get('/:userId/:month', async (req, res) => {
  try {
    const { userId, month } = req.params;

    const querySnapshot = await budgetsCollection
      .where('userId', '==', userId)
      .where('month', '==', month)
      .get();

    if (querySnapshot.empty) {
      return res.status(404).json({ message: "Budget not found" });
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
    await budgetsCollection.doc(req.params.id).update({ categories });
    res.status(200).json({ message: "Budget updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Hapus anggaran
router.delete('/:id', async (req, res) => {
  try {
    await budgetsCollection.doc(req.params.id).delete();
    res.status(200).json({ message: "Budget deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
