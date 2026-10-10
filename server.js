const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

// Storage: SQLite via a Firestore-compatible shim (see db/firestore.js).
// Routes keep their original logic; only the engine underneath changed.
const { firestore } = require('./db/firestore');
const db = firestore();

const app = express();
app.use(cors());
app.use(express.json());

// Sajikan Frontend Statis
app.use(express.static(path.join(__dirname, './view')));

// Basic route untuk test
app.get("/wallet", (req, res) => {
    res.sendFile(path.join(__dirname, './view/html/index.html'));
});

// Import Routes
app.use('/api/wallets', require('./routes/wallets'));
app.use('/api/budgeting', require('./routes/budgeting'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/goals', require('./routes/goals'));
app.use('/export', require('./routes/exports'));

// Rute untuk halaman frontend
app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, './view/html/home.html'));
});
app.get('/budget', (req, res) => {
    res.sendFile(path.join(__dirname, './view/html/budget.html'));
});
app.get('/transactions', (req, res) => {
    res.sendFile(path.join(__dirname, './view/html/transactions.html'));
});
app.get('/goals', (req, res) => {
    res.sendFile(path.join(__dirname, './view/html/goals.html'));
});

const PORT = process.env.PORT || 5000;
// Only start listening when run directly. Test suites require this file to get
// the app object; starting a listener there would keep the process alive forever.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
