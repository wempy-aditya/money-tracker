const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();
const transactionsCollection = db.collection('transactions');
const walletsCollection = db.collection('wallets');
const budgetsCollection = db.collection('budgets');

// 🔹 Tambah transaksi (income atau expense)
router.post('/', async (req, res) => {
  try {
    const { userId, date, amount, type, category, subcategory, walletId, description } = req.body;

    // Validasi input
    if (!userId || !date || !amount || !type || !walletId) {
      return res.status(400).json({ error: "Field tidak lengkap" });
    }

    // Periksa kecukupan saldo SEBELUM membuat transaksi
    const walletRef = walletsCollection.doc(walletId);
    const walletDoc = await walletRef.get();
    
    if (!walletDoc.exists) {
      return res.status(404).json({ error: "Wallet tidak ditemukan" });
    }

    const walletData = walletDoc.data();

    // Jika expense, periksa saldo terlebih dahulu
    if (type === "expense") {
      if ((walletData.balance - walletData.frozen) < amount) {
        return res.status(400).json({ error: "Saldo tidak mencukupi" });
      }
    }

    // Jika semua validasi berhasil, buat transaksi
    const newTransaction = { userId, date, amount, type, category, subcategory, walletId, description };
    const docRef = await transactionsCollection.add(newTransaction);

    // Update saldo wallet
    let updatedBalance = walletData.balance;
    updatedBalance = type === "income" ? 
      updatedBalance + amount : 
      updatedBalance - amount;

    await walletRef.update({ balance: updatedBalance });

    // Jika transaksi adalah expense, update anggaran
    if (type === "expense" && category && subcategory) {
      // Ekstrak bulan dari tanggal (format: YYYY-MM-DD)
      const month = date.substring(0, 7); // Mengambil YYYY-MM

      // Cari anggaran berdasarkan userId dan bulan
      const budgetQuerySnapshot = await budgetsCollection
        .where('userId', '==', userId)
        .where('month', '==', month)
        .get();

      if (!budgetQuerySnapshot.empty) {
        const budgetDoc = budgetQuerySnapshot.docs[0];
        const budgetData = budgetDoc.data();
        const budgetId = budgetDoc.id;

        // Cek apakah kategori ada dalam anggaran
        const categoryObj = budgetData.categories.find(cat => cat.name === category);
        if (categoryObj) {
          // Cek apakah subkategori ada dalam kategori
          const subcategoryObj = categoryObj.subcategories.find(sub => sub.name === subcategory);
          if (subcategoryObj) {
            // console.log('ditemukan');
            // Kurangi nilai anggaran sesuai dengan jumlah expense
            const currentAmount = subcategoryObj.amount;
            const currentUsed = subcategoryObj.used || 0;
            
            // Update nilai used pada subkategori
            subcategoryObj.used = currentUsed + amount;
            
            // Update anggaran di database
            await budgetsCollection.doc(budgetId).update({
              categories: budgetData.categories
            });
          } else {
            console.log('subkategori tidak ditemukan');
          }
        } else {
          console.log('kategori tidak ditemukan');
        }
      }
    }

    res.status(201).json({ id: docRef.id, ...newTransaction });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Ambil transaksi berdasarkan ID
router.get('/detail/:id', async (req, res) => {
    try {
        const trxRef = transactionsCollection.doc(req.params.id);
        const trxDoc = await trxRef.get();
    
        if (!trxDoc.exists) {
            return res.status(404).json({ error: "Transaksi tidak ditemukan" });
        }
    
        res.status(200).json({ id: trxDoc.id, ...trxDoc.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔹 Ambil daftar transaksi per bulan
router.get('/:userId/:month', async (req, res) => {
  try {
    const { userId, month } = req.params;

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
    const { userId, date, amount, type, category, subcategory, walletId, description } = req.body;

    const trxRef = transactionsCollection.doc(req.params.id);
    const trxDoc = await trxRef.get();

    if (!trxDoc.exists) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan" });
    }

    const oldTransaction = trxDoc.data();

    // Hitung perubahan saldo wallet
    const walletRef = walletsCollection.doc(walletId);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      return res.status(404).json({ error: "Wallet tidak ditemukan" });
    }

    const walletData = walletDoc.data();
    let updatedBalance = walletData.balance;

    // Kembalikan saldo awal sebelum update
    if (oldTransaction.type === "income") {
      updatedBalance -= oldTransaction.amount;
    } else {
      updatedBalance += oldTransaction.amount;
    }

    // Update saldo dengan transaksi baru
    if (type === "income") {
      updatedBalance += amount;
    } else {
      updatedBalance -= amount;
    }

    await walletRef.update({ balance: updatedBalance });

    // Update anggaran jika diperlukan
    // 1. Jika transaksi lama adalah expense, kembalikan nilai anggaran
    if (oldTransaction.type === "expense" && oldTransaction.category && oldTransaction.subcategory) {
      const oldMonth = oldTransaction.date.substring(0, 7);
      
      const oldBudgetQuerySnapshot = await budgetsCollection
        .where('userId', '==', oldTransaction.userId)
        .where('month', '==', oldMonth)
        .get();

      if (!oldBudgetQuerySnapshot.empty) {
        const oldBudgetDoc = oldBudgetQuerySnapshot.docs[0];
        const oldBudgetData = oldBudgetDoc.data();
        const oldBudgetId = oldBudgetDoc.id;

        // Cek apakah kategori ada dalam anggaran lama
        const oldCategoryObj = oldBudgetData.categories.find(cat => cat.name === oldTransaction.category);
        if (oldCategoryObj) {
          // Cek apakah subkategori ada dalam kategori
          const oldSubcategoryObj = oldCategoryObj.subcategories.find(sub => sub.name === oldTransaction.subcategory);
          if (oldSubcategoryObj) {
            // Kembalikan nilai used pada subkategori
            const oldUsed = oldSubcategoryObj.used || 0;
            
            // Kurangi nilai used dengan jumlah expense lama
            oldSubcategoryObj.used = Math.max(0, oldUsed - oldTransaction.amount);
            
            // Update anggaran lama di database
            await budgetsCollection.doc(oldBudgetId).update({
              categories: oldBudgetData.categories
            });
          }
        }
      }
    }

    // 2. Jika transaksi baru adalah expense, kurangi nilai anggaran
    if (type === "expense" && category && subcategory) {
      const newMonth = date.substring(0, 7);
      
      const newBudgetQuerySnapshot = await budgetsCollection
        .where('userId', '==', userId)
        .where('month', '==', newMonth)
        .get();

      if (!newBudgetQuerySnapshot.empty) {
        const newBudgetDoc = newBudgetQuerySnapshot.docs[0];
        const newBudgetData = newBudgetDoc.data();
        const newBudgetId = newBudgetDoc.id;

        // Cek apakah kategori ada dalam anggaran baru
        const newCategoryObj = newBudgetData.categories.find(cat => cat.name === category);
        if (newCategoryObj) {
          // Cek apakah subkategori ada dalam kategori
          const newSubcategoryObj = newCategoryObj.subcategories.find(sub => sub.name === subcategory);
          if (newSubcategoryObj) {
            // Ambil nilai used saat ini
            const currentUsed = newSubcategoryObj.used || 0;
            
            // Update nilai used pada subkategori
            newSubcategoryObj.used = currentUsed + amount;
            
            // Update anggaran baru di database
            await budgetsCollection.doc(newBudgetId).update({
              categories: newBudgetData.categories
            });
          }
        }
      }
    }

    // Simpan perubahan transaksi
    await trxRef.update({ userId, date, amount, type, category, subcategory, walletId, description });

    res.status(200).json({ message: "Transaksi diperbarui" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Hapus transaksi
router.delete('/:id', async (req, res) => {
  try {
    const trxRef = transactionsCollection.doc(req.params.id);
    const trxDoc = await trxRef.get();

    if (!trxDoc.exists) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan" });
    }

    const transaction = trxDoc.data();
    const walletRef = walletsCollection.doc(transaction.walletId);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      return res.status(404).json({ error: "Wallet tidak ditemukan" });
    }

    const walletData = walletDoc.data();
    const updatedBalance = transaction.type === "income"
      ? walletData.balance - transaction.amount
      : walletData.balance + transaction.amount;

    await walletRef.update({ balance: updatedBalance });

    // Jika transaksi yang dihapus adalah expense, kembalikan nilai anggaran
    if (transaction.type === "expense" && transaction.category && transaction.subcategory) {
      const month = transaction.date.substring(0, 7);
      
      const budgetQuerySnapshot = await budgetsCollection
        .where('userId', '==', transaction.userId)
        .where('month', '==', month)
        .get();

      if (!budgetQuerySnapshot.empty) {
        const budgetDoc = budgetQuerySnapshot.docs[0];
        const budgetData = budgetDoc.data();
        const budgetId = budgetDoc.id;

        // Cek apakah kategori ada dalam anggaran
        const categoryObj = budgetData.categories.find(cat => cat.name === transaction.category);
        if (categoryObj) {
          // Cek apakah subkategori ada dalam kategori
          const subcategoryObj = categoryObj.subcategories.find(sub => sub.name === transaction.subcategory);
          if (subcategoryObj) {
            // Ambil nilai used saat ini
            const currentUsed = subcategoryObj.used || 0;
            
            // Kurangi nilai used dengan jumlah expense yang dihapus
            subcategoryObj.used = Math.max(0, currentUsed - transaction.amount);
            
            // Update anggaran di database
            await budgetsCollection.doc(budgetId).update({
              categories: budgetData.categories
            });
          }
        }
      }
    }

    await trxRef.delete();

    res.status(200).json({ message: "Transaksi dihapus" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


module.exports = router;
