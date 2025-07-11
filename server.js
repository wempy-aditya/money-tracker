const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// Buat objek kredensial dari variabel lingkungan
const firebaseCredentials = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

// Inisialisasi Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(firebaseCredentials)
});

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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
