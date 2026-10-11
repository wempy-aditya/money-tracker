# Money Tracker

Personal finance tracker for a home network. Wallets, transactions, budgets, goals,
recurring rules, and four behavioural analyses over the data you already recorded.

Runs entirely on your own machine. No external services, no CDN, no telemetry.

---

## Requirements

```text
Node.js  22.5.0 or newer
```

The 22.5 floor is not cosmetic: storage uses the built-in `node:sqlite` module,
which is what removes the native dependency and the Firebase account entirely.

## Getting started

```bash
npm install
npm start
```

The server prints a LAN address on startup:

```text
Server running on http://localhost:5000
  http://192.168.1.19:5000   <- your machine's LAN address
```

Open the LAN address on a phone and the app works there. Binding to `0.0.0.0` is
what makes that possible; binding to `localhost` would lock it to this machine.

There is no seed account. Open `/login`, switch to the **Daftar** tab, and create
the first account.

### Environment variables

All optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address. Set to `127.0.0.1` to refuse LAN access. |
| `SQLITE_FILE` | `data/money-tracker.db` | Database location |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so `req.ip` is the real client and the login throttle does not key on the proxy for everyone |

## Scripts

```bash
npm start          # run the server
npm run dev        # run with --watch, restarts on change
npm test           # full suite
npm run test:clean # delete the test database
```

## Pages

| Path | Page | What it is for |
| --- | --- | --- |
| `/home` | Dashboard | Balances, month picker, income vs expense, budget progress |
| `/wallet` | Dompet | Wallets, frozen funds, transfers between wallets, transfer log |
| `/transactions` | Transaksi | Every transaction, filtered by month and type |
| `/budget` | Anggaran | Per-category limits for a month, and the needs/wants label |
| `/goals` | Target | Savings goals funded from frozen funds |
| `/recurring` | Aturan | Recurring rules as templates, run on demand |
| `/insights` | Advanced Financial Insights | The four analyses below |

## API

Every `/api` route except `/api/auth/*` requires a session cookie and is scoped to
the signed-in user. The user id always comes from the session, never from the
request, so one user cannot address another's documents even if they guess an id.

```text
POST   /api/auth/register        POST /api/auth/login
POST   /api/auth/logout          GET  /api/auth/me

GET    /api/wallets              POST /api/wallets
PATCH  /api/wallets/:id          POST /api/wallets/transfer
GET    /api/wallets/transfers

GET    /api/transactions         POST /api/transactions
DELETE /api/transactions/:id

GET    /api/budgeting/:userId/:month      POST /api/budgeting
PUT    /api/budgeting/:id                 DELETE /api/budgeting/:id

GET    /api/goals                POST /api/goals   (and update, delete)

GET    /api/recurring            POST /api/recurring
PATCH  /api/recurring/:id        DELETE /api/recurring/:id
POST   /api/recurring/run

GET    /api/insights             GET /api/insights/simulate

GET    /api/profile              PUT /api/profile
GET    /api/profile/completeness

GET    /api/settings              PUT /api/settings
POST   /api/settings/test

GET    /api/chat                  POST /api/chat
DELETE /api/chat                  GET  /api/chat/suggestions

GET    /api/analytics/income-expense/:userId/:month
GET    /api/analytics/wallets/:userId
GET    /api/analytics/budget-vs-actual/:userId/:month
GET    /api/analytics/expense-by-category/:userId/:month
GET    /api/analytics/financial-trend/:userId
```

## Storage

SQLite through a Firestore-compatible shim (`db/firestore.js`). Each document is
one JSON row in a single `documents` table, and `where` clauses compile to
SQLite's `json_extract`. That means a new collection needs no migration.

The shim covers only what this app uses:

```text
collection().where(field, op, value)   op: == != > < >= <=
orderBy(field, dir)   limit(n)   get()   add()   update()   delete()   doc()
runTransaction(fn)
```

Two limits worth knowing before you write a query:

- **No nested fields.** `where('a.b', ...)` throws. Store it flat and filter in JS.
- **One `and` chain.** Composed filters only; there is no `or`.

`NOTES.md` explains why the shim exists instead of rewritten queries.

## Security

What is implemented:

```text
Passwords   scrypt (N=16384, r=8, p=1), 16-byte random salt per user
Compare      timingSafeEqual
Sessions     32-byte random token, server-side, 30-day expiry
Cookie       HttpOnly, SameSite=Lax
Brute force  10 attempts per IP, then 429 with a wait time
Ownership    userId read from the session only; foreign ids get 403
Writes       transfers and transaction creation run inside runTransaction
```

What is deliberately missing, and why that is acceptable here:

```text
No HTTPS                 fine on a home LAN, wrong anywhere else
No password reset        an app for one household
No email verification     same reason
No scheduler             recurring rules are run by hand
Sessions in-process      restarting the server logs everyone out
```

Before exposing this beyond a LAN, you need TLS and a way to recover a lost
password.

## Recurring rules

A rule is a template, not a record. Nothing is written until you press **Jalankan
yang jatuh tempo**, and each card previews its next three dates so you can see what
a run would do first. There is no background scheduler: this app is expected to be
turned off, and a job that silently did not run for a week is worse than one you
trigger.

A failed occurrence never advances the watermark. If a month fails on insufficient
funds, the next run retries it rather than skipping past.

## The four analyses

Each one reports how much history it had and says plainly when that is not enough.
None of them predicts anything.

**Engel's law.** Spending over income across six months, with the trend direction
called out as lifestyle creep. The needs/wants split only exists where you labelled
your budget categories, so the page shows its own coverage percentage rather than
scoring only the labelled part as if it were everything. Unsteady income makes the
coefficient meaningless, so an unsteady month is labelled as a rough indication
instead of being given a grade.

**Parkinson.** A spending limit derived from your own median spending over the last
three months. The median, not the average, so one unusual month does not redefine
your baseline. The page names the mechanism: a baseline that rises with spending
stops feeling like a limit.

**Pareto.** Which categories carry the spending and the smallest set that reaches
80%. Categories past that point are grouped as the trivial many with their combined
total, which is where attention is usually wasted.

**Wealth simulator.** Compounding from your current balance at your own monthly
saving, with Rule of 72 next to the exact doubling time so the gap between the
estimate and reality is visible. The default rate is your measured saving rate,
capped at 30%: a very high rate comes from one month where nothing unusual was
paid, and projecting thirty years off that produces a fantasy. The raw figure is
shown next to the capped one so the cap is never hidden.

You can override every input and get a year-by-year path.

## Frontend

No build step. No framework. Native CSS with custom properties, hand-written ES5-ish
JavaScript, Chart.js vendored into `view/assets/vendor/`.

```text
Theme      one accent colour, one radius, light and dark via data-theme on <html>
Contrast   every token pair checked against WCAG AA in both themes
Motion     all animation respects prefers-reduced-motion
Input      16px minimum, because iOS Safari zooms on focus otherwise
Assets     zero CDN references, so it renders fully offline
```

A page and its script are checked against each other in the test suite: a button
wiring a handler nobody defines, or a script reading an element that does not exist,
fails the build. That check exists because the add-transaction button once shipped
with no handler and the page looked complete while doing nothing.

## Tests

```bash
npm test
```

```text
191 tests
```

| File | Covers |
| --- | --- |
| `firestore-shim.test.js` | The shim: queries, snapshots, transactions |
| `auth.test.js` | Registration, login, sessions, ownership, throttling |
| `api-flow.test.js` | Wallets, transactions, budgets, goals, exports |
| `recurring.test.js` | Date generation, retries, watermark, transfer history |
| `insights.test.js` | The four analyses, edge cases, cross-user isolation |
| `pages.test.js` | Every page against its script: handlers, ids, routes, CDN |
| `profile-chat.test.js` | Profile, settings, advisor chat, key handling, isolation |

The suite runs against its own database file (`data/test-run.db`) and with
`--test-concurrency=1`, because every test file opens the same file-backed SQLite
database and running them in parallel makes them fight over the write lock.

Fixture numbers in the insights and recurring tests are chosen so each expected
value can be checked by hand. Where a test asserts an exact figure, the comment
next to it shows the arithmetic.

## The AI advisor

`/chat` talks to any OpenAI-compatible endpoint: hosted services, a local Ollama,
LM Studio, or a vLLM server. You enter the URL, model name and key yourself on
`/settings`; nothing is hardcoded and no request leaves the machine except the one
you configure.

The assistant is **read-only by design**. It receives no tool definitions and no
write endpoint is reachable from it, so it cannot create a transaction, move money,
or change a budget no matter what the conversation says. "Buy this laptop for me"
gets advice, and the purchase happens because you recorded it yourself.

### Language and tone

The advisor answers in the language the question was asked in. The question is
inspected first: a script range decides Chinese, Japanese, Korean, Arabic, Hindi or
Thai outright, and Indonesian versus English is decided by word frequency, where
words that are equally at home in both languages are ignored so they cannot break a
tie. When the result is genuinely ambiguous it returns nothing, and the standing
instruction in the prompt takes over.

Nothing forces Indonesian any more. The original prompt said "berbahasa Indonesia"
unconditionally, which is what let a Chinese-hosted model answer in Indonesian and
slip Mandarin into the same reply.

The tone is chosen on `/settings`: `profesional`, `santai`, `formal`, `teknis`,
`ringkas` or `penjelas`. The list comes from the API rather than being hardcoded in
the form. A tone only ever appends style rules; the hard rules (read-only, no
invented numbers) are never derived from user input, so no choice of tone can
weaken them.

### What it can actually see

Every question is answered with a context block assembled from the database, not
from your prose:

```text
PROFIL PENGGUNA            from /api/profile
KONDISI KEUANGAN SAAT INI  total balance, frozen funds, usable
TREN 6 BULAN TERAKHIR     income, expense, ratio and top categories per month
N TRANSAKSI TERBARU       the most recent ones, capped at 40
```

Each section states its own coverage. When only one month has transactions, the
context says so, because a model handed a six-row table tends to read it as six
months of activity. Where the profile is empty it is told the profile is empty
rather than being asked to answer as if it knew you.

### History and cost

Every question and answer is stored, including the ones that failed. Older turns
are summarised extractively (what was asked, what was answered) and only the last
20 are sent verbatim, so a long conversation does not grow without bound. The
summary is built in this codebase rather than by a second model call, which avoids
a second chance to invent something.

```text
GET /api/chat              newest first, limit 50 (max 200)
DELETE /api/chat           clears the whole history
```

### The API key

Stored in plain text in the local database, never encrypted. In exchange it is
write-only over HTTP: `readSettings()` never selects the column's value, only
whether it is set, so no route can return it by accident, and `GET /api/settings`
answers with `has_key: true` and nothing else. The settings form leaves the key field blank, and an untouched field
is not sent, so saving an unrelated value cannot clear it.

If this ever runs somewhere other than your own machine, encrypt the column with a
key from the environment, or stop storing it.

## Known gaps

```text
The AI advisor has never been run against a real provider. Every test stubs the
  HTTP call, so the request shape, the context block, the response parsing and the
  language detection are verified, but no real model has answered yet. Expect to
  adjust something on first real use, most likely the model name or the URL shape.

Language detection is a word list, not a model. It handles the clear cases; a
  short code-mixed question returns nothing and falls back to the instruction in
  the prompt. Tuning it means adding words, not retraining anything.

Layout on phones is not visually verified. The CSS collapses to one column and
  the inputs are 16px, but no automated check can resize a viewport. Worth one
  look on a real phone before trusting a layout change.

test/smoke.sh predates authentication and still checks the old unauthenticated
  contract. It is not part of npm test and will fail if run directly.

main has not been fast-forwarded to the feature branches. Everything is pushed,
  but the SQLite rebuild, authentication and these features live on branches.
```

## Layout

```text
server.js            mounts routes, serves pages, resolves LAN addresses
db/firestore.js      Firestore-compatible shim over SQLite
db/auth.js           scrypt, sessions, ownership
db/profile.js        profiles, LLM settings, chat history
db/transactions.js   the single write path shared by manual entry and rules
services/llm.js      OpenAI-compatible client and the context builder
routes/              one file per resource
view/html/           one file per page
view/assets/js/      one file per page
view/assets/css/     one stylesheet
test/                node:test, no framework
NOTES.md             why the storage layer looks like this
```