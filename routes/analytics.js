const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');

const db = firestore();
const transactionsCollection = db.collection('transactions');
const walletsCollection = db.collection('wallets');
const budgetsCollection = db.collection('budgets');

// Analytics are derived from user-owned documents, so every endpoint is scoped
// to the signed-in user rather than trusting the userId in the path.
const ownerOf = (req) => req.auth.userId;

function rejectForeignUserId(req, res) {
  if (req.params.userId !== ownerOf(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return true;
  }
  return false;
}

// 🔹 Total Pemasukan & Pengeluaran Per Bulan
router.get('/income-expense/:userId/:month', async (req, res) => {
  try {
    if (rejectForeignUserId(req, res)) return;
    const { month } = req.params;
    const userId = ownerOf(req);

    const querySnapshot = await transactionsCollection
      .where('userId', '==', userId)
      .where('date', '>=', `${month}-01`)
      .where('date', '<=', `${month}-31`)
      .get();

    let totalIncome = 0;
    let totalExpense = 0;

    querySnapshot.forEach(doc => {
      const transaction = doc.data();
      if (transaction.type === 'income') {
        totalIncome += transaction.amount;
      } else {
        totalExpense += transaction.amount;
      }
    });

    res.status(200).json({ totalIncome, totalExpense });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Saldo Akhir Per Wallet
router.get('/wallets/:userId', async (req, res) => {
  try {
    if (rejectForeignUserId(req, res)) return;
    const userId = ownerOf(req);

    // The ownership filter was commented out, so this returned every wallet
    // from every user (NOTES.md bug #3). Restored.
    const querySnapshot = await walletsCollection.where('userId', '==', userId).get();
    const wallets = querySnapshot.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      balance: doc.data().balance,
      frozen: doc.data().frozen,
      usable: doc.data().balance - doc.data().frozen
    }));

    res.status(200).json(wallets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Analisis Realisasi vs Rencana Anggaran
router.get('/budget-vs-actual/:userId/:month', async (req, res) => {
    try {
      if (rejectForeignUserId(req, res)) return;
      const { month } = req.params;
      const userId = ownerOf(req);
  
      // Ambil data budget berdasarkan userId dan bulan
      const budgetsSnapshot = await budgetsCollection
        .where('userId', '==', userId)
        .where('month', '==', month)
        .get();
  
      let budgetData = {};
      budgetsSnapshot.forEach(doc => {
        const data = doc.data();
        data.categories.forEach(category => {
          category.subcategories.forEach(subcategory => {
            budgetData[subcategory.name] = subcategory.amount;
          });
        });
      });
  
      // Ambil data transaksi untuk bulan tertentu
      const transactionsSnapshot = await transactionsCollection
        .where('userId', '==', userId)
        .where('date', '>=', `${month}-01`)
        .where('date', '<=', `${month}-31`)
        .get();
  
      let actualData = {};
      transactionsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.type === "expense") {
          if (!actualData[data.subcategory]) actualData[data.subcategory] = 0;
          actualData[data.subcategory] += data.amount;
        }
      });
  
      // Buat perbandingan antara budget dan pengeluaran sebenarnya
      let comparison = [];
      for (const subcategory in budgetData) {
        comparison.push({
          subcategory,
          budget: budgetData[subcategory],
          actual: actualData[subcategory] || 0,
          difference:  budgetData[subcategory] - (actualData[subcategory] || 0) 
        });
      }
  
      res.status(200).json(comparison);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
});


// 🔹 Pengeluaran Berdasarkan Kategori
router.get('/expense-by-category/:userId/:month', async (req, res) => {
  try {
    if (rejectForeignUserId(req, res)) return;
    const { month } = req.params;
    const userId = ownerOf(req);

    const querySnapshot = await transactionsCollection
      .where('userId', '==', userId)
      .where('date', '>=', `${month}-01`)
      .where('date', '<=', `${month}-31`)
      .where('type', '==', 'expense')
      .get();

    let categoryExpenses = {};
    querySnapshot.forEach(doc => {
      const transaction = doc.data();
      if (!categoryExpenses[transaction.category]) {
        categoryExpenses[transaction.category] = 0;
      }
      categoryExpenses[transaction.category] += transaction.amount;
    });

    res.status(200).json(categoryExpenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Tren Keuangan (Total per Bulan untuk 6 Bulan Terakhir)
router.get('/financial-trend/:userId', async (req, res) => {
  try {
    if (rejectForeignUserId(req, res)) return;
    const userId = ownerOf(req);

    let result = [];

    for (let i = 0; i < 6; i++) {
      let date = new Date();
      date.setMonth(date.getMonth() - i);
      let month = date.toISOString().split('T')[0].slice(0, 7); // YYYY-MM

      const querySnapshot = await transactionsCollection
        .where('userId', '==', userId)
        .where('date', '>=', `${month}-01`)
        .where('date', '<=', `${month}-31`)
        .get();

      let totalIncome = 0;
      let totalExpense = 0;

      querySnapshot.forEach(doc => {
        const transaction = doc.data();
        if (transaction.type === 'income') {
          totalIncome += transaction.amount;
        } else {
          totalExpense += transaction.amount;
        }
      });

      result.push({ month, totalIncome, totalExpense });
    }

    res.status(200).json(result.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
