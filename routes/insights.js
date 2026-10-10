/**
 * Advanced financial insights.
 *
 * Four analyses built entirely on what the app already stores. Nothing here is a
 * prediction and nothing invents data: every section reports how much history it
 * had and says plainly when there is not enough to conclude anything.
 *
 *  - Engel's law        expense / income over time, split into needs and wants
 *  - Parkinson's law     spending limit derived from the user's own baseline
 *  - Pareto 80/20       which categories carry the spending
 *  - Wealth simulator   compounding at the user's own saving rate, plus Rule of 72
 *
 * Engel only says something meaningful once spending is split into needs and
 * wants, and that split only exists where the user labelled their budget
 * categories. Unlabelled categories stay unlabelled rather than being guessed at,
 * and the coverage of the split is reported so a partial answer never reads as a
 * complete one.
 */

const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');

const db = firestore();
const transactionsCollection = db.collection('transactions');
const walletsCollection = db.collection('wallets');
const budgetsCollection = db.collection('budgets');

const ownerOf = (req) => req.auth.userId;

/** Minimum months of history before a trend is worth showing at all. */
const MIN_MONTHS_FOR_TREND = 3;
const TREND_MONTHS = 6;

/* ------------------------------------------------------------------ dates */

/** YYYY-MM for the month `offset` months before the current one (0 = now). */
function monthOffset(offset, base = new Date()) {
  const date = new Date(base.getFullYear(), base.getMonth() - offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Inclusive date bounds for a YYYY-MM month. */
function monthRange(month) {
  return { from: `${month}-01`, to: `${month}-31` };
}

const round = (value) => Math.round(value);
const sum = (list) => list.reduce((total, value) => total + value, 0);

/** Median, which ignores one odd month instead of averaging it into the baseline. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/* --------------------------------------------------------------- fetching */

/**
 * Transactions across a whole window, fetched in one query rather than one per
 * month. A range on `date` is the only index the shim can answer efficiently, so
 * the window spans the full range and the caller groups by month.
 */
async function transactionsBetween(userId, fromMonth, toMonth) {
  const { from } = monthRange(fromMonth);
  const { to } = monthRange(toMonth);
  const snapshot = await transactionsCollection
    .where('userId', '==', userId)
    .where('date', '>=', from)
    .where('date', '<=', to)
    .get();
  return snapshot.docs.map((doc) => doc.data());
}

/** Budget for one month, or null. */
async function budgetForMonth(userId, month) {
  const snapshot = await budgetsCollection
    .where('userId', '==', userId)
    .where('month', '==', month)
    .get();
  if (snapshot.empty) return null;
  const budget = snapshot.docs[0].data();
  return {
    ...budget,
    categories: (budget.categories || []).map((category) => ({
      name: category.name,
      kind: category.kind || null,
      total: Number(category.total || 0),
    })),
  };
}

/**
 * Latest budget that labels at least one category, searched backwards from
 * `month`. A month without a budget still gets classified when an older one
 * carries the labels, which is what keeps Engel populated month after month.
 */
async function nearestLabelledBudget(userId, month) {
  for (let back = 0; back < TREND_MONTHS + 6; back++) {
    const candidate = await budgetForMonth(userId, monthOffset(back));
    if (candidate && candidate.categories.some((category) => category.kind)) {
      return { budget: candidate, appliedFrom: monthOffset(back) };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ Engel */

/**
 * Engel coefficient per month, split by the needs/wants labels on the budget.
 * Returns the coverage of that split so the UI can show what it is not measuring.
 */
function buildEngel(monthly, kindByCategory) {
  const series = [];
  let markedCategories = new Set();
  let totalMarked = 0;
  let totalUnmarked = 0;

  for (const row of monthly) {
    const income = row.income;
    const expense = row.expense;

    let needs = 0;
    let wants = 0;
    let unmarked = 0;

    for (const item of row.byCategory) {
      const kind = kindByCategory[item.category] || null;
      if (kind === 'needs') needs += item.total;
      else if (kind === 'wants') wants += item.total;
      else unmarked += item.total;
    }

    const covered = needs + wants;
    totalMarked += covered;
    totalUnmarked += unmarked;

    series.push({
      month: row.month,
      income: round(income),
      expense: round(expense),
      // Gross Engel ratio: total spending against income, regardless of labels.
      ratio: income > 0 ? round((expense / income) * 1000) / 10 : null,
      needs: round(needs),
      wants: round(wants),
      unmarked: round(unmarked),
      // Share of spending the needs/wants split can actually explain.
      coverage: expense > 0 ? round((covered / expense) * 1000) / 10 : null,
    });
  }

  return {
    series,
    coverage: {
      markedCategories: [...markedCategories],
      markedTotal: round(totalMarked),
      unmarkedTotal: round(totalUnmarked),
      percent: totalMarked + totalUnmarked > 0
        ? round((totalMarked / (totalMarked + totalUnmarked)) * 1000) / 10
        : null,
    },
  };
}

/** Grade only from months that had income, and only if there are enough of them. */
function gradeEngel(series) {
  const usable = series.filter((row) => row.ratio !== null && row.income > 0);
  if (usable.length < MIN_MONTHS_FOR_TREND) {
    return { grade: null, reason: `Butuh ${MIN_MONTHS_FOR_TREND} bulan dengan pemasukan tercatat` };
  }

  const latest = usable[usable.length - 1];
  const earliest = usable[0];

  // Lifestyle creep: does the share of income spent keep rising?
  let rising = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i].ratio > usable[i - 1].ratio) rising++;
  }
  const creeping = rising >= Math.ceil(usable.length / 2);

  let band;
  let verdict;
  if (latest.ratio <= 30) {
    band = 'Sangat baik';
    verdict = 'Hampir seluruh pendapatan berubah jadi pengeluaran';
  } else if (latest.ratio <= 50) {
    band = 'Seimbang';
    verdict = 'Pengeluaran mengikuti pendapatan';
  } else if (latest.ratio <= 70) {
    band = 'Tinggi';
    verdict = 'Terlalu besar bagian pendapatan yang berubah jadi pengeluaran';
  } else {
    band = 'Berisiko';
    verdict = 'Pengeluaran mendekati atau melampaui pendapatan';
  }

  return {
    grade: band,
    verdict,
    creeping,
    change: round((latest.ratio - earliest.ratio) * 10) / 10,
    monthsMeasured: usable.length,
  };
}

/* -------------------------------------------------------------- Parkinson */

/**
 * A spending limit derived from the user's own history rather than an external
 * rule of thumb: the median of the last months' spending, with the current
 * month's pace compared against it.
 */
function buildParkinson(monthly, income) {
  const history = monthly.filter((row) => row.expense > 0).map((row) => row.expense);

  if (history.length < MIN_MONTHS_FOR_TREND) {
    return {
      baseline: null,
      ready: false,
      reason: `Butuh ${MIN_MONTHS_FOR_TREND} bulan dengan pengeluaran tercatat`,
    };
  }

  const recent = history.slice(-MIN_MONTHS_FOR_TREND);
  const baseline = median(recent);
  const current = monthly[monthly.length - 1].expense;

  // Spending that habitually fills the available room is the Parkinson pattern:
  // the more room there is, the more gets spent.
  const roomToSpend = Math.max(0, income - baseline);

  return {
    baseline: round(baseline),
    ready: true,
    current: round(current),
    monthsUsed: recent.length,
    // How far above the habit baseline the latest month sits.
    overBy: round(Math.max(0, current - baseline)),
    overByPercent: baseline > 0 ? round(((current - baseline) / baseline) * 1000) / 10 : null,
    roomToSpend: round(roomToSpend),
    // Spending above the habit already consumes more than half the remaining room.
    pressure: roomToSpend > 0 ? round(((current - baseline) / roomToSpend) * 1000) / 10 : null,
  };
}

/* ----------------------------------------------------------------- Pareto */

/** Which categories carry the spending, and how few it takes to reach 80%. */
function buildPareto(monthly, target = 80) {
  const totals = {};
  for (const row of monthly) {
    for (const item of row.byCategory) {
      totals[item.category] = (totals[item.category] || 0) + item.total;
    }
  }

  const grandTotal = sum(Object.values(totals));
  if (grandTotal === 0) {
    return { ready: false, reason: 'Belum ada pengeluaran untuk dianalisis', categories: [] };
  }

  const sorted = Object.entries(totals)
    .map(([name, total]) => ({
      name,
      total: round(total),
      percent: round((total / grandTotal) * 1000) / 10,
    }))
    .sort((a, b) => b.total - a.total);

  // The vital few is the smallest set whose cumulative share actually REACHES the
  // target, so the crossing category is counted. Counting only the entries that
  // fell short reported "one category covers 60%" as one, which is not a Pareto
  // answer at all and would label a still-essential category as trivial.
  let cumulative = 0;
  let vitalFew = 0;
  for (const entry of sorted) {
    cumulative += entry.percent;
    entry.cumulative = round(cumulative * 10) / 10;
    vitalFew++;
    if (cumulative >= target) break;
  }

  return {
    ready: true,
    total: round(grandTotal),
    months: monthly.length,
    target,
    categories: sorted,
    // The smallest number of categories that carries the target share.
    vitalFew,
    vitalFewShare: sorted[vitalFew - 1] ? sorted[vitalFew - 1].cumulative : null,
    // Trivial many: everything past the vital few, which is what Pareto says
    // deserves attention last.
    trivialMany: sorted.slice(vitalFew),
  };
}

/* ------------------------------------------------------------------ Wealth */

/**
 * Compounding at a chosen rate. The default rate is the user's own saving rate
 * annualised, not a market assumption, so the projection starts from what they
 * actually do rather than from what someone else earns.
 */
function buildWealth(currentWealth, monthlySaving, annualRatePercent) {
  const yearly = monthlySaving * 12;
  const rate = annualRatePercent / 100;

  // The future value of an annuity divides by the rate, which is 0/0 at a zero
  // rate. A user with nothing saved and no income hits exactly that, and every
  // milestone came back null: the page would then render "Rp null" five times.
  // At zero rate the interest term vanishes and only the deposits remain.
  const futureValue = (principal, years) => round(
    principal * Math.pow(1 + rate, years)
    + (rate === 0 ? yearly * years : yearly * ((Math.pow(1 + rate, years) - 1) / rate))
  );

  const milestones = [1, 5, 10, 20, 30].map((years) => ({
    years,
    amount: futureValue(currentWealth, years),
  }));

  return {
    current: round(currentWealth),
    monthlySaving: round(monthlySaving),
    yearly: round(yearly),
    annualRate: annualRatePercent,
    // Rule of 72: the rate at which the money doubles, in years.
    ruleOf72: annualRatePercent > 0 ? round((72 / annualRatePercent) * 10) / 10 : null,
    // The exact doubling time, shown next to the estimate so the gap is visible.
    exactDoubling: rate > 0 ? round((Math.log(2) / Math.log(1 + rate)) * 10) / 10 : null,
    milestones,
  };
}

/* ------------------------------------------------------------------ routes */

// 🔹 Ringkasan lengkap keempat analisis
router.get('/', async (req, res) => {
  try {
    const userId = ownerOf(req);

    const months = [];
    for (let i = TREND_MONTHS - 1; i >= 0; i--) months.push(monthOffset(i));
    const currentMonth = months[months.length - 1];

    const transactions = await transactionsBetween(userId, months[0], currentMonth);
    const labelled = await nearestLabelledBudget(userId, currentMonth);

    // Group into per-month totals and per-category totals in one pass.
    const byMonth = new Map(months.map((month) => [month, { income: 0, expense: 0, byCategory: new Map() }]));
    for (const transaction of transactions) {
      const month = String(transaction.date).slice(0, 7);
      const bucket = byMonth.get(month);
      if (!bucket) continue;

      if (transaction.type === 'income') {
        bucket.income += transaction.amount;
      } else {
        bucket.expense += transaction.amount;
        bucket.byCategory.set(
          transaction.category || 'Tanpa kategori',
          (bucket.byCategory.get(transaction.category || 'Tanpa kategori') || 0) + transaction.amount
        );
      }
    }

    const monthly = months.map((month) => {
      const bucket = byMonth.get(month);
      return {
        month,
        income: bucket.income,
        expense: bucket.expense,
        byCategory: [...bucket.byCategory.entries()].map(([category, total]) => ({ category, total })),
      };
    });

    const kindByCategory = {};
    if (labelled) {
      for (const category of labelled.budget.categories) {
        if (category.kind) kindByCategory[category.name] = category.kind;
      }
    }

    const engel = buildEngel(monthly, kindByCategory);
    const latest = monthly[monthly.length - 1];
    const averageIncome = sum(monthly.map((row) => row.income)) / TREND_MONTHS;
    const averageExpense = sum(monthly.map((row) => row.expense)) / TREND_MONTHS;

    const wallets = await walletsCollection.where('userId', '==', userId).get();
    const currentWealth = sum(wallets.docs.map((doc) => doc.data().balance || 0));

    // Saving rate from what the user actually did, used as the simulator default.
    // A rate above 30% is not a saving rate, it is a month where nothing unusual
    // was paid, and projecting thirty years off it produces a fantasy. The raw
    // figure is reported next to the capped one so the cap is never hidden.
    const rawSavingRate = averageIncome > 0
      ? Math.round(((averageIncome - averageExpense) / averageIncome) * 1000) / 10
      : 0;
    const MAX_PROJECTION_RATE = 30;
    const savingRatePercent = Math.min(rawSavingRate, MAX_PROJECTION_RATE);

    res.status(200).json({
      window: { from: months[0], to: currentMonth, months: TREND_MONTHS },
      dataQuality: {
        monthsWithIncome: monthly.filter((row) => row.income > 0).length,
        monthsWithExpense: monthly.filter((row) => row.expense > 0).length,
        monthsTotal: TREND_MONTHS,
        // Engel needs a steady income to mean anything; say so rather than
        // scoring a freelancer's noisy months.
        incomeStable: new Set(monthly.map((row) => row.income)).size <= 2,
        labelsFrom: labelled ? labelled.appliedFrom : null,
      },
      engel: { ...engel, assessment: gradeEngel(engel.series) },
      parkinson: buildParkinson(monthly, latest.income || averageIncome),
      pareto: buildPareto(monthly),
      wealth: {
        ...buildWealth(currentWealth, Math.max(0, averageIncome - averageExpense), savingRatePercent),
        savingRateRaw: rawSavingRate,
        savingRateCapped: savingRatePercent !== rawSavingRate,
        maxProjectionRate: MAX_PROJECTION_RATE,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Simulasi.what-if: ubah saldo awal, tabungan, dan tingkat bunga
router.get('/simulate', async (req, res) => {
  try {
    const userId = ownerOf(req);
    const wallets = await walletsCollection.where('userId', '==', userId).get();
    const storedWealth = sum(wallets.docs.map((doc) => doc.data().balance || 0));

    const currentWealth = Number(req.query.wealth ?? storedWealth);
    const monthlySaving = Number(req.query.monthlySaving ?? 0);
    const annualRate = Number(req.query.rate ?? 0);

    if (!Number.isFinite(currentWealth) || currentWealth < 0) {
      return res.status(400).json({ error: 'Wealth tidak valid' });
    }
    if (!Number.isFinite(monthlySaving) || monthlySaving < 0) {
      return res.status(400).json({ error: 'Tabungan bulanan tidak valid' });
    }
    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) {
      return res.status(400).json({ error: 'Tingkat bunga harus antara 0 dan 100' });
    }

    const years = Math.min(50, Math.max(1, Number(req.query.years ?? 30)));
    const result = buildWealth(currentWealth, monthlySaving, annualRate);

    // A year-by-year path, so the shape of compounding is visible and not just
    // the endpoint.
    const rate = annualRate / 100;
    const path = [];
    for (let year = 1; year <= years; year++) {
      path.push({
        year,
        amount: round(
          currentWealth * Math.pow(1 + rate, year) +
            (rate === 0
              ? monthlySaving * 12 * year
              : monthlySaving * 12 * ((Math.pow(1 + rate, year) - 1) / rate))
        ),
      });
    }

    res.status(200).json({ ...result, years, path, usingStoredWealth: req.query.wealth === undefined });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;