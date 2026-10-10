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