const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();
const walletsCollection = db.collection('wallets');

// 🔹 Tambah dompet baru
router.post('/', async (req, res) => {
  try {
    const { name, balance } = req.body;
    const docRef = await walletsCollection.add({ name, balance, frozen: 0 });
    res.status(201).json({ id: docRef.id, name, balance, frozen: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Ambil semua dompet
router.get('/', async (req, res) => {
  try {
    const snapshot = await walletsCollection.get();
    const wallets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(wallets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Edit dompet
router.put('/:id', async (req, res) => {
  try {
    const { name, balance, frozen } = req.body;
    await walletsCollection.doc(req.params.id).update({ name, balance, frozen });
    res.status(200).json({ message: "Wallet updated" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Hapus dompet
router.delete('/:id', async (req, res) => {
  try {
    await walletsCollection.doc(req.params.id).delete();
    res.status(200).json({ message: "Wallet deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Transfer saldo antar dompet
router.post('/transfer', async (req, res) => {
  try {
    const { fromWalletId, toWalletId, amount } = req.body;

    const fromWalletRef = walletsCollection.doc(fromWalletId);
    const toWalletRef = walletsCollection.doc(toWalletId);

    const fromWallet = (await fromWalletRef.get()).data();
    const toWallet = (await toWalletRef.get()).data();

    if (!fromWallet || !toWallet) return res.status(404).json({ error: "Wallet not found" });

    if ((fromWallet.balance-fromWallet.frozen) < amount) return res.status(400).json({ error: "Insufficient balance" });

    await fromWalletRef.update({ balance: fromWallet.balance - amount });
    await toWalletRef.update({ balance: toWallet.balance + amount });

    res.status(200).json({ message: "Transfer successful" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
