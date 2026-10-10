/**
 * Recurring transactions.
 *
 * A rule describes a transaction that repeats on a schedule: salary on the 25th,
 * rent on the 1st, internet on the 5th. Rules never write anything by themselves.
 * They produce due entries on demand via POST /run, so a rule can be created,
 * paused or edited at any time without leaving orphan transactions behind.
 *
 * The generator reuses db/transactions.js, so a generated transaction has exactly
 * the same effects as a typed one: wallet balance moves and budget usage rolls.
 */

const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');
const { recordTransaction } = require('../db/transactions');

const db = firestore();
const rulesCollection = db.collection('recurring');

const ownerOf = (req) => req.auth.userId;

/* ------------------------------------------------------------------ dates */

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(year, month) {
  const table = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1];
}

function toIso(year, month, day) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Adds `count` months to a YYYY-MM string, clamping the day for short months. */
function addMonths(month, count, day) {
  const year = Number(month.substring(0, 4));
  const mon = Number(month.substring(5, 7));
  const zeroBased = mon - 1 + count;
  const nextYear = year + Math.floor(zeroBased / 12);
  const nextMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: nextYear, month: nextMonth, day: Math.min(day, daysInMonth(nextYear, nextMonth)) };
}

/** ISO date of occurrence `index` (0 = the first run) counted from `startMonth`. */
function occurrenceDate(startDate, frequency, interval, dayOfMonth, weekday, index) {
  if (frequency === 'weekly' || frequency === 'biweekly') {
    // Step in days from the real start date. Using the month alone made every
    // weekly rule anchor on the 1st instead of the day the user actually chose.
    const step = frequency === 'weekly' ? 7 : 14;
    return shiftDays(parseIso(startDate), step * interval * index);
  }

  const stepMonths = (frequency === 'yearly' ? 12 : 1) * interval;
  // The day always comes from the requested one and is clamped per month, never
  // carried over from a previously clamped month. Otherwise a rule for the 29th
  // would run on the 28th in February and never reach the 29th again.
  const startMonth = String(startDate).slice(0, 7);
  const { year, month } = addMonths(startMonth, stepMonths * index, 1);
  const day = frequency === 'yearly' ? dayOfMonth : Math.min(dayOfMonth, daysInMonth(year, month));
  return toIso(year, month, day);
}

function parseIso(date) {
  // Accepts YYYY-MM-DD or YYYY-MM with a day argument; clamps to the month length
  // so a rule for the 31st does not roll into the next month.
  const year = Number(String(date).substring(0, 4));
  const mon = Number(String(date).substring(5, 7));
  const rawDay = String(date).length > 7 ? Number(String(date).slice(8, 10)) : 1;
  return new Date(Date.UTC(year, mon - 1, Math.min(rawDay, daysInMonth(year, mon))));
}

function shiftDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Occurrence dates strictly after `lastRunDate`, up to and including `upTo`. */
function dueOccurrences(rule, upTo, options = {}) {
  const startDate = String(rule.startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return [];

  const interval = Math.max(1, Number(rule.interval) || 1);
  const dayOfMonth = Math.min(31, Math.max(1, Number(rule.dayOfMonth) || 1));
  const weekday = Number(rule.weekday) || 1;
  const limit = options.cap !== undefined ? options.cap : Number(rule.occurrences) || 0;
  // The first occurrence is the one on or after the start date, so a rule that has
  // never run starts counting from the day before it. Using the start date itself
  // as the exclusive lower bound silently dropped that first entry.
  const firstDate = occurrenceDate(startDate, rule.frequency, interval, dayOfMonth, weekday, 0);
  // Occurrences are counted from the day before the first one, otherwise the first
  // entry is skipped by the exclusive lower bound below. `inclusive` decides
  // whether an occurrence landing exactly on `from` is counted.
  //
  // `fromOverride` lets a caller measure from the beginning of the schedule instead
  // of from the last run, which is how the lifetime occurrence cap is worked out.
  // Without it, every count of "how many times did this already fire" came back 0.
  const from = options.fromOverride || rule.lastRunDate || shiftDays(parseIso(firstDate), -1);
  const includeLast = options.inclusive !== false;

  const dates = [];
  // Start from the occurrence just after `from` instead of scanning from zero and
  // discarding earlier ones. A rule run for a year would otherwise walk a hundred
  // dead occurrences before reaching the first due date, and the loop bound cut it
  // off before it got there.
  let index = 0;
  if (from) {
    let guard = 0;
    while (
      guard < 5000 &&
      occurrenceDate(startDate, rule.frequency, interval, dayOfMonth, weekday, index) <= from
    ) {
      index++;
      guard++;
    }
  }

  // 2000 is far beyond any realistic schedule and keeps a malformed rule bounded.
  for (let n = 0; n < 2000; n++, index++) {
    const date = occurrenceDate(startDate, rule.frequency, interval, dayOfMonth, weekday, index);
    if (date > upTo) break;
    if (date === from && !includeLast) break;
    dates.push(date);
    if (limit && dates.length >= limit) break;
  }
  return dates;
}

/* ----------------------------------------------------------------- routes */

// 🔹 Daftar aturan milik user
router.get('/', async (req, res) => {
  try {
    const snapshot = await rulesCollection.where('userId', '==', ownerOf(req)).get();
    const rules = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    res.status(200).json(rules);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Buat aturan baru
router.post('/', async (req, res) => {
  try {
    const userId = ownerOf(req);
    const {
      name,
      amount,
      type,
      frequency = 'monthly',
      interval = 1,
      startDate,
      dayOfMonth,
      weekday,
      walletId,
      category,
      subcategory,
      description,
      occurrences,
    } = req.body;

    if (!name || !amount || !type || !startDate || !walletId) {
      return res.status(400).json({ error: 'Field tidak lengkap' });
    }
    if (type !== 'income' && type !== 'expense') {
      return res.status(400).json({ error: 'Tipe harus income atau expense' });
    }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount harus lebih besar dari nol' });
    }
    if (!['daily', 'weekly', 'biweekly', 'monthly', 'yearly'].includes(frequency)) {
      return res.status(400).json({ error: 'Frequency tidak dikenal' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
      return res.status(400).json({ error: 'Tanggal mulai harus format YYYY-MM-DD' });
    }

    const walletDoc = await db.collection('wallets').doc(walletId).get();
    if (!walletDoc.exists || walletDoc.data().userId !== userId) {
      return res.status(404).json({ error: 'Wallet tidak ditemukan' });
    }

    const docRef = await rulesCollection.add({
      userId,
      name,
      amount: Number(amount),
      type,
      frequency,
      interval: Math.max(1, Number(interval) || 1),
      startDate,
      dayOfMonth:
        frequency === 'weekly' || frequency === 'biweekly'
          ? null
          : Math.min(31, Math.max(1, Number(dayOfMonth) || Number(startDate.slice(8, 10)))),
      weekday: frequency === 'weekly' || frequency === 'biweekly' ? Number(weekday) || 1 : null,
      walletId,
      category,
      subcategory,
      description: description || name,
      occurrences: occurrences ? Math.max(1, Number(occurrences)) : 0,
      active: true,
      lastRunDate: null,
      lastRunAt: null,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({ id: docRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Ubah aturan
router.put('/:id', async (req, res) => {
  try {
    const userId = ownerOf(req);
    const existing = await rulesCollection.doc(req.params.id).get();
    if (!existing.exists || existing.data().userId !== userId) {
      return res.status(404).json({ error: 'Aturan tidak ditemukan' });
    }

    const allowed = [
      'name', 'amount', 'type', 'frequency', 'interval', 'startDate',
      'dayOfMonth', 'weekday', 'walletId', 'category', 'subcategory',
      'description', 'occurrences', 'active',
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    // Amount and interval must stay numeric whatever the client sent.
    if (patch.amount !== undefined) {
      const amount = Number(patch.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Amount harus lebih besar dari nol' });
      }
      patch.amount = amount;
    }
    if (patch.interval !== undefined) patch.interval = Math.max(1, Number(patch.interval) || 1);

    // A watermark in the future, or one the new start has moved past, freezes the
    // rule: every run then reports "nothing due" and there is no way out short of
    // editing the document by hand. Reset it so the schedule is reachable again.
    if (existing.data().lastRunDate) {
      const lastRun = String(existing.data().lastRunDate).slice(0, 10);
      const startMovedPast = patch.startDate !== undefined &&
        String(patch.startDate).slice(0, 10) > lastRun;
      const watermarkAheadOfToday = lastRun > today();

      if (startMovedPast || watermarkAheadOfToday) {
        patch.lastRunDate = null;
        patch.lastRunAt = null;
      }
    }

    await rulesCollection.doc(req.params.id).update(patch);
    res.status(200).json({ message: 'Aturan diperbarui' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Hapus aturan
router.delete('/:id', async (req, res) => {
  try {
    const existing = await rulesCollection.doc(req.params.id).get();
    if (!existing.exists || existing.data().userId !== ownerOf(req)) {
      return res.status(404).json({ error: 'Aturan tidak ditemukan' });
    }
    await rulesCollection.doc(req.params.id).delete();
    res.status(200).json({ message: 'Aturan dihapus' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Jalankan semua aturan yang jatuh tempo
router.post('/run', async (req, res) => {
  try {
    const userId = ownerOf(req);
    const upTo = req.body && req.body.throughDate ? req.body.throughDate : today();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(upTo))) {
      return res.status(400).json({ error: 'Tanggal harus format YYYY-MM-DD' });
    }

    const snapshot = await rulesCollection.where('userId', '==', userId).get();
    const created = [];
    const failed = [];

    for (const doc of snapshot.docs) {
      const rule = doc.data();
      if (!rule.active) continue;

      // The cap is for the rule's lifetime, not for one run. Counting from the
      // start date is what makes a run after an earlier one behave correctly.
      // Count occurrences strictly before the last one that ran, so the last
      // one itself is not counted twice.
      const alreadyRun = rule.lastRunDate
        ? dueOccurrences(rule, rule.lastRunDate, {
            cap: 0,
            inclusive: false,
            fromOverride: shiftDays(parseIso(rule.startDate), -1),
          }).length
        : 0;
      const remaining = (Number(rule.occurrences) || 0)
        ? (Number(rule.occurrences) || 0) - alreadyRun
        : 0;
      if ((Number(rule.occurrences) || 0) && remaining <= 0) continue;

      const dates = dueOccurrences(rule, upTo, { cap: remaining || 0 });
      let lastRunDate = rule.lastRunDate;

      for (const date of dates) {
        try {
          const transaction = await recordTransaction(userId, {
            date,
            amount: rule.amount,
            type: rule.type,
            category: rule.category,
            subcategory: rule.subcategory,
            walletId: rule.walletId,
            description: rule.description || rule.name,
          });
          created.push({ ruleId: doc.id, ruleName: rule.name, transaction });
          // Only a transaction that actually landed moves the watermark. Advancing
          // it past a failed occurrence meant the next run skipped that month for
          // good: a salary rule on a card that happened to be short looked like it
          // had already been paid.
          lastRunDate = date;
        } catch (error) {
          // An expense with no balance left, for instance. Record why and move on
          // so one bad rule cannot block the rest. The date is deliberately not
          // recorded, so this occurrence is retried on the next run.
          failed.push({ ruleId: doc.id, ruleName: rule.name, date, reason: error.message });
          break;
        }
      }

      if (lastRunDate && lastRunDate !== rule.lastRunDate) {
        await rulesCollection.doc(doc.id).update({
          lastRunDate,
          lastRunAt: new Date().toISOString(),
        });
      }
    }

    res.status(200).json({ throughDate: upTo, created, failed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Pratinjau aturan tanpa menyimpan apa pun
router.get('/:id/preview', async (req, res) => {
  try {
    const existing = await rulesCollection.doc(req.params.id).get();
    if (!existing.exists || existing.data().userId !== ownerOf(req)) {
      return res.status(404).json({ error: 'Aturan tidak ditemukan' });
    }
    const through = req.query.throughDate || today();
    res.status(200).json({ dates: dueOccurrences(existing.data(), through) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;