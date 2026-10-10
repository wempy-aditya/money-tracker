# Money Tracker — SQLite rebuild notes

Storage backend swapped from **Firebase Firestore to SQLite**. Route logic, request
shapes, response shapes and the frontend are unchanged.

## Why a shim instead of rewriting the queries

Every route used the Firestore query API directly. Rewriting 6 route files by hand
would have meant touching the business logic — exactly what this rebuild must not do.
So `db/firestore.js` implements the small slice of the Firestore API this app uses,
backed by a single SQLite table.

```js
// routes/wallets.js — before
const admin = require('firebase-admin');
const db = admin.firestore();

// routes/wallets.js — after
const { firestore } = require('../db/firestore');
const db = firestore();
```

## The core trick

Firestore documents are schemaless; SQLite tables are not. Rather than write a schema
migration for every collection, each document is stored as a JSON blob and `where`
clauses compile to SQLite's `json_extract`:

```sql
SELECT id, data FROM documents
WHERE collection = 'transactions'
  AND json_extract(data, '$.userId') = :p0
  AND json_extract(data, '$.date')  >= :p1
```

Nested structures (`budgets.categories[].subcategories[].used`) never need querying —
routes read them whole, mutate in JS, and write the whole document back. So they stay
as nested JSON, untouched.

## Supported Firestore surface

The complete set this codebase uses. Anything else throws loudly rather than
silently returning wrong data.

| Firestore | SQLite shim |
|---|---|
| `db.collection(name)` | table discriminator in `documents` |
| `collection.add(obj)` | insert, returns `{ id }` |
| `collection.get()` | all rows in collection |
| `collection.doc(id)` | row by primary key |
| `doc.get()` | `{ exists, data(), id }` |
| `doc.update(fields)` | merge into existing JSON |
| `doc.set(obj, {merge})` | upsert |
| `doc.delete()` | delete row |
| `.where(field, op, value)` | `json_extract` comparison |
| `.orderBy(field, dir)` | `ORDER BY json_extract(...)` |
| `.limit(n)` / `.offset(n)` | `LIMIT` / `OFFSET` |
| `snapshot.docs` / `.empty` / `.size` / `.forEach` | same shape |
| `runTransaction(fn)` | `BEGIN`/`COMMIT`/`ROLLBACK` |

Document ids are 20-char base64url strings, matching Firestore's shape.

Operators: `== != > < >= <=`. Anything else (nested path, `in`, `array-contains`)
throws — those were never used here.

## Running

```bash
npm install
npm start          # http://127.0.0.1:5000
npm test           # 63 tests
```

No `.env` needed and no Firebase project. Optional:

```bash
PORT=5000
SQLITE_FILE=data/money-tracker.db   # default
```

## Tests

```bash
npm test                    # 63 unit + flow tests
node --test test/firestore-shim.test.js   # 20 shim contract tests
node --test test/api-flow.test.js         # 43 end-to-end HTTP tests
bash test/smoke.sh                       # 30 checks against a running server
```

The flow tests drive real HTTP through the real route modules using the same
request sequences the frontend issues. `smoke.sh` additionally verifies the running
server and that data survives a restart.

## Pre-existing bugs preserved on purpose

This rebuild was scoped to storage only. The following are in the original Firebase
version and were left untouched. They are recorded here so they are not mistaken for
regressions.

1. **Export paths are double-prefixed.** `server.js` mounts the router at `/export`
   while `routes/exports.js` declares `/export/...`, so the reachable path is
   `/export/export/...`. The frontend calls `/export/...` and always gets a 404.
   Fix would be dropping the prefix inside `exports.js`.

2. **`PUT /api/transactions` mis-attributes wallet refunds.** The route reads the
   sign from the *old* transaction but applies both the refund and the new charge to
   whichever wallet the *request* names. Moving an expense between wallets nets the
   new wallet to zero and never refunds the old one.

3. **`GET /api/wallets` and `GET /api/goals` ignore `userId`.** Every wallet and goal
   is returned regardless of owner. `analytics/wallets/:userId` has the same issue —
   the filter is commented out in the original.

4. **No authentication anywhere.** Every request trusts the `userId` it is given, so
   any caller can read or write another user's data. This is the most serious issue
   and it predates the rebuild.

5. **Multi-write operations are not atomic.** Creating a transaction writes the
   transaction and the wallet balance as two separate statements; transferring
   between wallets does the same. A failure between them corrupts the balance. SQLite
   supports real transactions — the shim exposes `runTransaction` — but wiring these
   up would change flow, so it was left out.

6. **Hardcoded `http://localhost:5000`** in `home.html` and `transactions.html`, so
   those pages break when opened from another machine.

7. **`POST /api/wallets` ignores `frozen`** and always stores `0`. A non-zero frozen
   amount can only be set through `PUT`.

## Next steps

Fixes 1 and 6 are one-liners. Fix 4 needs a real decision about identity. Fixes 2
and 5 are correctness work worth doing before any real data goes in.

---

# Update 2026-10-10 — bugs fixed, authentication added, UI rebuilt

All seven issues above were fixed in commit `e20c194`. They were left in place
originally only because the first brief was to change storage without changing
flow; the follow-up brief asked for them to be fixed.

| # | Issue | Status |
|---|---|---|
| 1 | Export 404 (double `/export/export`) | Route paths corrected, frontend updated to match |
| 2 | Refund applied to the new wallet | Each wallet now adjusted by its own transaction's sign |
| 3 | Ownership filter missing on lists | `where('userId','==',owner)` restored on wallets, goals, analytics |
| 4 | No authentication | scrypt + server-side sessions; `userId` comes from the session only |
| 5 | Non-atomic multi-write | Transfers and transaction writes run in a DB transaction |
| 6 | Hardcoded `localhost:5000` | All frontend paths are origin-relative |
| 7 | `POST /api/wallets` ignored `frozen` | Accepted directly |

## Authentication

- `db/auth.js` — scrypt hashing (per-user random salt), sessions stored in SQLite
  with a 30-day expiry, `httpOnly` `SameSite=Lax` cookie.
- `routes/auth.js` — `POST /api/auth/register|login|logout`, `GET /api/auth/me`.
- `requireAuth` guards every `/api/*` route and every app page. Only `/login`,
  `/api/auth/*` and static assets are public.
- Rate limiting on login: 10 attempts per username per 15 minutes.

**The important part:** `userId` is now derived from the session and never read
from a request body or trusted from a URL. Mismatched IDs return 403. Before this,
any caller could pass someone else's `userId` and read or write their ledger.

## Atomicity

`db/firestore.js` gained `runTransaction`. Wallet transfers, transaction creates,
transaction updates and deletes now wrap their multi-document writes in a real
SQLite transaction, so a mid-way failure rolls back instead of leaving a corrupted
balance.

## Frontend

Rebuilt from 3.669 lines of Tailwind/FontAwesome/Chart.js-from-CDN markup into
design tokens plus vanilla JS. Notable decisions:

- **Chart.js is vendored locally** (`view/assets/vendor/chart.umd.js`). The old
  pages loaded Tailwind, Font Awesome and Chart.js from public CDNs, so on a phone
  without internet the app rendered unstyled with no charts. Font Awesome was
  dropped in favour of unicode glyphs — no font files to load.
- Contrast is defined as a pair of tokens: `--accent` for links and `--accent-surface`
  for anything that carries white text. A single accent cannot satisfy both in dark
  mode (a light blue is readable as a link but fails as a button background).
- Inputs are 16px exactly, so iOS Safari does not zoom on focus.
- Verified WCAG AA for all 14 text/background pairs in both themes.

## Tests

102 pass: 20 shim behaviour, 43 flow over HTTP, 39 auth and authorisation
(including cross-user access attempts returning 403).

## Still open

- Password reset and email verification do not exist. Acceptable for a
  single-household LAN app; needed before any public deployment.
- Sessions are in-process, so restarting the server logs everyone out.
- There is no HTTPS. Fine on a trusted home LAN, not beyond it.