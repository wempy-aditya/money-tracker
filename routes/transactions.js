const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');
const { recordTransaction, adjustBudgetUsed } = require('../db/transactions');

const db = firestore();
const transactionsCollection = db.collection('transactions');
const walletsCollection = db.collection('wallets');

const ownerOf = (req) => req.auth.userId;

// 🔹 Tambah transaksi (income atau expense)
router.post('/', async (req, res) => {
  try {
    // Writes go through the shared helper so a generated transaction from a
    // recurring rule is indistinguishable from a typed one, budget roll included.
    const created = await recordTransaction(ownerOf(req), req.body);
    res.status(201).json(created);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});


// 🔹 Ambil transaksi berdasarkan ID
router.get('/detail/:id', async (req, res) => {
  try {
    const trxDoc = await transactionsCollection.doc(req.params.id).get();

    if (!trxDoc.exists || trxDoc.data().userId !== ownerOf(req)) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }

    res.status(200).json({ id: trxDoc.id, ...trxDoc.data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Ambil daftar transaksi per bulan
router.get('/:userId/:month', async (req, res) => {
  try {
    const { month } = req.params;
    const userId = ownerOf(req);

    // The userId path segment is retained for URL compatibility, but it is only
    // honoured if it matches the signed-in user. Anything else is refused
    // rather than silently served, so a mismatched link fails loudly.
    if (req.params.userId !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const querySnapshot = await transactionsCollection
      .where('userId', '==', userId)
      .where('date', '>=', `${month}-01`)
      .where('date', '<=', `${month}-31`)
      .orderBy('date')
      .get();

    const transactions = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.status(200).json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Update transaksi
router.put('/:id', async (req, res) => {
  try {
    const { date, amount, type, category, subcategory, walletId, description } = req.body;
    const userId = ownerOf(req);

    if (!date || !amount || !type || !walletId) {
      return res.status(400).json({ error: 'Field tidak lengkap' });
    }
    if (type !== 'income' && type !== 'expense') {
      return res.status(400).json({ error: 'Tipe harus income atau expense' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount harus lebih besar dari nol' });
    }

    const trxRef = transactionsCollection.doc(req.params.id);
    const trxDoc = await trxRef.get();

    if (!trxDoc.exists || trxDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }

    const oldTransaction = trxDoc.data();

    const oldWalletRef = walletsCollection.doc(oldTransaction.walletId);
    const oldWalletDoc = await oldWalletRef.get();
    const newWalletRef = walletsCollection.doc(walletId);
    const newWalletDoc = await newWalletRef.get();

    if (!oldWalletDoc.exists || oldWalletDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Wallet tidak ditemukan' });
    }
    if (!newWalletDoc.exists || newWalletDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Wallet tidak ditemukan' });
    }

    const oldWallet = oldWalletDoc.data();
    const newWallet = newWalletDoc.data();

    // Bug #2 fixed. The original code read the sign from the OLD transaction
    // but applied both the refund and the new charge to whichever wallet the
    // REQUEST named, so moving an expense between wallets debited and credited
    // the same wallet and never refunded the original one. Each wallet is now
    // adjusted by its own transaction's own sign.
    await db.runTransaction(async () => {
      // Undo the old transaction against the wallet it actually belongs to.
      const revertOld =
        oldTransaction.type === 'income'
          ? oldWallet.balance - oldTransaction.amount
          : oldWallet.balance + oldTransaction.amount;
      await oldWalletRef.update({ balance: revertOld });

      // Apply the new transaction. When it is the same wallet, this reads the
      // value written a moment ago rather than the stale pre-update snapshot.
      const baseBalance = walletId === oldTransaction.walletId ? revertOld : newWallet.balance;
      const applyNew = type === 'income' ? baseBalance + amount : baseBalance - amount;
      await newWalletRef.update({ balance: applyNew });

      if (oldTransaction.type === 'expense') {
        await adjustBudgetUsed(userId, oldTransaction.date, oldTransaction.category, oldTransaction.subcategory, -oldTransaction.amount);
      }
      if (type === 'expense') {
        await adjustBudgetUsed(userId, date, category, subcategory, amount);
      }

      await trxRef.update({ date, amount, type, category, subcategory, walletId, description });
    });

    res.status(200).json({ message: 'Transaksi diperbarui' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Hapus transaksi
router.delete('/:id', async (req, res) => {
  try {
    const userId = ownerOf(req);
    const trxRef = transactionsCollection.doc(req.params.id);
    const trxDoc = await trxRef.get();

    if (!trxDoc.exists || trxDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }

    const transaction = trxDoc.data();
    const walletRef = walletsCollection.doc(transaction.walletId);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists || walletDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Wallet tidak ditemukan' });
    }

    const walletData = walletDoc.data();

    await db.runTransaction(async () => {
      const updatedBalance =
        transaction.type === 'income'
          ? walletData.balance - transaction.amount
          : walletData.balance + transaction.amount;
      await walletRef.update({ balance: updatedBalance });

      if (transaction.type === 'expense') {
        await adjustBudgetUsed(userId, transaction.date, transaction.category, transaction.subcategory, -transaction.amount);
      }

      await trxRef.delete();
    });

    res.status(200).json({ message: 'Transaksi dihapus' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;