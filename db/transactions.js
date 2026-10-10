/**
 * Shared write path for transactions.
 *
 * Both the manual route and the recurring generator need the same behaviour:
 * validate, adjust the wallet balance, and roll the month's budget usage. Keeping
 * one implementation means a generated transaction is indistinguishable from a
 * typed one, including the budget side effect.
 */

const { firestore } = require('./firestore');

const db = firestore();

/**
 * Adds `delta` to a subcategory's running usage for the month of `date`.
 * Silently does nothing when the user has no budget, or no matching line.
 */
async function adjustBudgetUsed(userId, date, category, subcategory, delta) {
  if (!category || !subcategory) return;
  const month = String(date).substring(0, 7);

  const budgetsCollection = db.collection('budgets');
  const snapshot = await budgetsCollection
    .where('userId', '==', userId)
    .where('month', '==', month)
    .get();

  if (snapshot.empty) return;

  const budgetDoc = snapshot.docs[0];
  const budgetData = budgetDoc.data();
  const categories = Array.isArray(budgetData.categories) ? budgetData.categories : [];

  const categoryObj = categories.find((cat) => cat.name === category);
  if (!categoryObj) return;

  const subcategoryObj = (categoryObj.subcategories || []).find((sub) => sub.name === subcategory);
  if (!subcategoryObj) return;

  subcategoryObj.used = Math.max(0, (subcategoryObj.used || 0) + delta);
  await budgetsCollection.doc(budgetDoc.id).update({ categories });
}

/**
 * Validates and records a transaction, moving the wallet balance with it.
 *
 * All of it runs in one SQLite transaction so the ledger and the balance can
 * never disagree. Throws an Error carrying `status` for expected failures, which
 * the caller turns into a response.
 *
 * @param {object} input  date, amount, type, category, subcategory, walletId, description
 * @param {string} userId owner, always from the session
 * @returns {Promise<object>} the stored transaction
 */
async function recordTransaction(userId, input) {
  const { date, amount, type, category, subcategory, walletId, description } = input;

  if (!date || !amount || !type || !walletId) {
    throw Object.assign(new Error('Field tidak lengkap'), { status: 400 });
  }
  if (type !== 'income' && type !== 'expense') {
    throw Object.assign(new Error('Tipe harus income atau expense'), { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error('Amount harus lebih besar dari nol'), { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw Object.assign(new Error('Tanggal harus format YYYY-MM-DD'), { status: 400 });
  }

  const walletsCollection = db.collection('wallets');
  const transactionsCollection = db.collection('transactions');

  const walletRef = walletsCollection.doc(walletId);
  const walletDoc = await walletRef.get();

  if (!walletDoc.exists) {
    throw Object.assign(new Error('Wallet tidak ditemukan'), { status: 404 });
  }

  const walletData = walletDoc.data();
  if (walletData.userId !== userId) {
    // 404 rather than 403: confirming the wallet exists would leak its id.
    throw Object.assign(new Error('Wallet tidak ditemukan'), { status: 404 });
  }

  if (type === 'expense' && walletData.balance - walletData.frozen < amount) {
    throw Object.assign(new Error('Saldo tidak mencukupi'), { status: 400 });
  }

  return db.runTransaction(async () => {
    const ref = await transactionsCollection.add({
      userId,
      date,
      amount,
      type,
      category,
      subcategory,
      walletId,
      description,
    });

    const updatedBalance =
      type === 'income' ? walletData.balance + amount : walletData.balance - amount;
    await walletRef.update({ balance: updatedBalance });

    if (type === 'expense') {
      await adjustBudgetUsed(userId, date, category, subcategory, amount);
    }

    return { id: ref.id, userId, date, amount, type, category, subcategory, walletId, description };
  });
}

module.exports = { recordTransaction, adjustBudgetUsed };