const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');

const db = firestore();
const walletsCollection = db.collection('wallets');
const transfersCollection = db.collection('transfers');

// Every wallet document carries the owner's userId. Previously this route
// returned every wallet in the database regardless of owner (NOTES.md bug #3),
// and accepted a userId from the request body, which any caller could forge
// (bug #4). The owner now comes from the session only.
const ownerOf = (req) => req.auth.userId;

/**
 * What a wallet can be for.
 *
 * The stored value is the key, not the label, so a label can be reworded later
 * without stranding every wallet already tagged with the old text. The same
 * table is exposed to the browser as App.WALLET_KINDS; if the two ever disagree,
 * the test that reads both fails rather than a user meeting an icon they cannot
 * click.
 *
 * Anything outside this list is rejected on write rather than quietly stored:
 * a wallet whose kind nothing recognises would render as a blank tag and sort
 * nowhere.
 */
const WALLET_KINDS = ['bank', 'ewallet', 'cash', 'savings', 'investment', 'credit', 'other'];
const DEFAULT_KIND = 'other';

/** The field is optional; omitting it means "other", never an error. */
function readKind(body, fallback) {
  const kind = body.kind === undefined || body.kind === null || body.kind === ''
    ? (fallback === undefined ? DEFAULT_KIND : fallback)
    : String(body.kind);

  if (!WALLET_KINDS.includes(kind)) return { error: `Unknown wallet kind: ${kind}` };
  return { kind };
}

// 🔹 Tambah dompet baru
router.post('/', async (req, res) => {
  try {
    const { name, balance } = req.body;
    // `frozen` used to be dropped on create, forcing a follow-up PUT just to
    // set it (NOTES.md bug #7). It is accepted here now, still defaulting to 0.
    const frozen = Number(req.body.frozen || 0);

    if (!Number.isFinite(frozen) || frozen < 0) {
      return res.status(400).json({ error: 'Frozen amount must be zero or more' });
    }

    const parsedKind = readKind(req.body);
    if (parsedKind.error) {
      return res.status(400).json({ error: parsedKind.error });
    }

    const userId = ownerOf(req);
    const docRef = await walletsCollection.add({
      userId, name, balance, frozen, kind: parsedKind.kind
    });
    res.status(201).json({ id: docRef.id, userId, name, balance, frozen, kind: parsedKind.kind });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Ambil semua dompet milik user yang sedang login
router.get('/', async (req, res) => {
  try {
    const snapshot = await walletsCollection.where('userId', '==', ownerOf(req)).get();
    const wallets = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        ...data,
        id: doc.id,
        // A wallet created before kinds existed has no `kind` at all. Sending it
        // through the default here means the browser never has to second-guess
        // whether the field is missing or empty.
        kind: data.kind || DEFAULT_KIND
      };
    });
    res.status(200).json(wallets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Edit dompet
router.put('/:id', async (req, res) => {
  try {
    const { name, balance, frozen } = req.body;
    const userId = ownerOf(req);
    const walletRef = walletsCollection.doc(req.params.id);
    const existing = await walletRef.get();

    // Ownership check on every write, not just on read.
    if (!existing.exists || existing.data().userId !== userId) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const update = {};
    if (name !== undefined) update.name = name;
    if (balance !== undefined) update.balance = balance;
    if (frozen !== undefined) update.frozen = frozen;

    if (req.body.kind !== undefined) {
      const parsedKind = readKind(req.body, existing.data().kind);
      if (parsedKind.error) {
        return res.status(400).json({ error: parsedKind.error });
      }
      update.kind = parsedKind.kind;
    }

    await walletRef.update(update);
    res.status(200).json({ message: 'Wallet updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Hapus dompet
router.delete('/:id', async (req, res) => {
  try {
    const walletRef = walletsCollection.doc(req.params.id);
    const existing = await walletRef.get();

    if (!existing.exists || existing.data().userId !== ownerOf(req)) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    await walletRef.delete();
    res.status(200).json({ message: 'Wallet deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Transfer saldo antar dompet
router.post('/transfer', async (req, res) => {
  try {
    const { fromWalletId, toWalletId, amount } = req.body;
    const userId = ownerOf(req);

    if (fromWalletId === toWalletId) {
      return res.status(400).json({ error: 'Source and destination wallet must differ' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than zero' });
    }

    // The two balance updates used to run as separate writes, so a failure
    // between them left money missing (NOTES.md bug #5). Wrapping them in one
    // SQLite transaction makes the pair all-or-nothing.
    const result = await db.runTransaction(async () => {
      const fromWalletRef = walletsCollection.doc(fromWalletId);
      const toWalletRef = walletsCollection.doc(toWalletId);

      const fromWallet = (await fromWalletRef.get()).data();
      const toWallet = (await toWalletRef.get()).data();

      if (!fromWallet || !toWallet || fromWallet.userId !== userId || toWallet.userId !== userId) {
        return { status: 404, error: 'Wallet not found' };
      }

      if (fromWallet.balance - fromWallet.frozen < amount) {
        return { status: 400, error: 'Insufficient balance' };
      }

      await fromWalletRef.update({ balance: fromWallet.balance - amount });
      await toWalletRef.update({ balance: toWallet.balance + amount });

      // The audit record shares the transfer's transaction, so a history entry can
      // never exist without the balances having moved, or vice versa.
      await transfersCollection.add({
        userId,
        fromWalletId,
        toWalletId,
        fromWalletName: fromWallet.name,
        toWalletName: toWallet.name,
        amount,
        createdAt: new Date().toISOString(),
      });

      return { status: 200, message: 'Transfer successful' };
    });

    res.status(result.status).json(result.status === 200 ? { message: result.message } : { error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Riwayat transfer
router.get('/transfers', async (req, res) => {
  try {
    const userId = ownerOf(req);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const snapshot = await transfersCollection.where('userId', '==', userId).get();
    const transfers = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      // Newest first, which is the only order a transfer log is read in.
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);

    res.status(200).json(transfers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;