const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.firestore();

const { Parser } = require('json2csv');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const transactionsCollection = db.collection('transactions');
const budgetCollection = db.collection('budgets');

router.get('/export/:userId/:month/:format', async (req, res) => {
  try {
    const { userId, month, format } = req.params;

    // Ambil data transaksi berdasarkan userId dan bulan
    const transactionsSnapshot = await transactionsCollection
      .where('userId', '==', userId)
      .where('date', '>=', `${month}-01`)
      .where('date', '<=', `${month}-31`)
      .get();

    let transactions = [];
    transactionsSnapshot.forEach(doc => {
      transactions.push(doc.data());
    });

    if (transactions.length === 0) {
      return res.status(404).json({ message: "No transactions found for the specified month." });
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=transactions_${month}.json`);
      return res.json(transactions);
    }

    if (format === 'csv') {
      const fields = ['date', 'type', 'amount', 'category', 'subcategory', 'wallet', 'description'];
      const parser = new Parser({ fields });
      const csv = parser.parse(transactions);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=transactions_${month}.csv`);
      return res.send(csv);
    }

    if (format === 'xlsx') {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(transactions);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Transactions');

      const filePath = path.join(__dirname, `transactions_${month}.xlsx`);
      XLSX.writeFile(workbook, filePath);

      res.download(filePath, `transactions_${month}.xlsx`, (err) => {
        if (err) {
          console.error("Error sending file:", err);
        }
        fs.unlinkSync(filePath); // Hapus file setelah dikirim
      });

      return;
    }

    return res.status(400).json({ message: "Invalid export format. Use json, csv, or xlsx." });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint untuk ekspor data anggaran
router.get('/export-budget/:userId/:month/:format', async (req, res) => {
  try {
    const { userId, month, format } = req.params;

    // Ambil data anggaran berdasarkan userId dan bulan
    const budgetSnapshot = await budgetCollection
      .where('userId', '==', userId)
      .where('month', '==', month)
      .get();

    let budgetData = null;
    budgetSnapshot.forEach(doc => {
      budgetData = {
        id: doc.id,
        ...doc.data()
      };
    });

    if (!budgetData) {
      return res.status(404).json({ message: "No budget found for the specified month." });
    }

    // Transformasi data anggaran untuk ekspor
    let exportData = [];
    
    // Flatten kategori dan subkategori untuk ekspor
    if (budgetData.categories && budgetData.categories.length > 0) {
      budgetData.categories.forEach(category => {
        if (category.subcategories && category.subcategories.length > 0) {
          category.subcategories.forEach(subcategory => {
            exportData.push({
              category: category.name,
              categoryTotal: category.total,
              subcategory: subcategory.name,
              amount: subcategory.amount,
              month: budgetData.month,
              userId: budgetData.userId
            });
          });
        } else {
          exportData.push({
            category: category.name,
            categoryTotal: category.total,
            subcategory: '',
            amount: 0,
            month: budgetData.month,
            userId: budgetData.userId
          });
        }
      });
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=budget_${month}.json`);
      return res.json(exportData);
    }

    if (format === 'csv') {
      const fields = ['category', 'categoryTotal', 'subcategory', 'amount', 'month', 'userId'];
      const parser = new Parser({ fields });
      const csv = parser.parse(exportData);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=budget_${month}.csv`);
      return res.send(csv);
    }

    if (format === 'xlsx') {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(exportData);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Budget');

      const filePath = path.join(__dirname, `budget_${month}.xlsx`);
      XLSX.writeFile(workbook, filePath);

      res.download(filePath, `budget_${month}.xlsx`, (err) => {
        if (err) {
          console.error("Error sending file:", err);
        }
        fs.unlinkSync(filePath); // Hapus file setelah dikirim
      });

      return;
    }

    return res.status(400).json({ message: "Invalid export format. Use json, csv, or xlsx." });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;