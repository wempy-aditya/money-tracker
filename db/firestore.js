/**
 * Firestore-compatible shim backed by SQLite.
 *
 * Goal: keep every route file's logic byte-for-byte identical while swapping the
 * storage engine. Firestore stores schemaless documents; SQLite does not. The
 * trick that avoids a per-collection schema mapping is to store each document as
 * a JSON blob and use SQLite's `json_extract` for `where` clauses.
 *
 * Only top-level scalar fields are ever filtered on in this codebase
 * (`userId`, `date`, `month`, `type`), which is exactly what `json_extract` does
 * well. Nested arrays (`budgets.categories[].subcategories[].used`) are always
 * read whole, mutated in JS, and written back whole — so they never need
 * querying and never need flattening.
 *
 * Supported Firestore surface (the complete set this repo uses):
 *   db.collection(name)
 *   collection.add(obj)            -> { id }
 *   collection.get()               -> QuerySnapshot
 *   collection.doc(id)             -> DocumentReference
 *   doc.get()                      -> DocumentSnapshot { exists, data(), id }
 *   doc.update(fields)             -> void
 *   doc.delete()                   -> void
 *   query.where(field, op, value)  op: '==' | '!=' | '>' | '<' | '>=' | '<='
 *   query.orderBy(field, dir)
 *   query.get()                    -> QuerySnapshot { docs, empty, size, forEach }
 */

const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_OPERATORS = new Set(['==', '!=', '>', '<', '>=', '<=']);

const SQL_OPERATOR = {
	'==': '=',
	'!=': '!=',
	'>': '>',
	'<': '<',
	'>=': '>=',
	'<=': '<='
};

/**
 * Firestore ids are 20-char URL-safe strings. Match that shape so nothing
 * downstream ever assumes a numeric key.
 */
function generateId() {
	return randomBytes(15).toString('base64url');
}

/** Guard against `where()` being handed a nested path we cannot index. */
function assertQueryable(field, operator) {
	if (!SUPPORTED_OPERATORS.has(operator)) {
		throw new Error(`[sqlite-firestore] unsupported operator "${operator}". Supported: ${[...SUPPORTED_OPERATORS].join(', ')}`);
	}
	if (field.includes('.')) {
		throw new Error(`[sqlite-firestore] cannot query nested field "${field}" — store it at the top level or filter in JS`);
	}
}

/** DocumentSnapshot — mirrors Firestore's shape. */
class DocumentSnapshot {
	constructor(id, data) {
		this.id = id;
		this._data = data;
	}

	get exists() {
		return this._data !== null;
	}

	/**
	 * Returns a freshly parsed object on every call. Firestore does the same:
	 * mutating the returned object must not silently mutate stored state, and
	 * routes here rely on reading, mutating, then writing back the whole document.
	 */
	data() {
		return this._data === null ? undefined : JSON.parse(JSON.stringify(this._data));
	}

	toJSON() {
		return this._data;
	}
}

/** QuerySnapshot — mirrors Firestore's shape. */
class QuerySnapshot {
	constructor(rows) {
		this.docs = rows;
		this.empty = rows.length === 0;
		this.size = rows.length;
	}

	forEach(callback) {
		this.docs.forEach(callback);
	}

	map(callback) {
		return this.docs.map(callback);
	}
}

class Query {
	constructor(database, collectionName) {
		this._db = database;
		this._collection = collectionName;
		this._filters = [];
		this._orderBy = null;
		this._limit = null;
		this._offset = null;
	}

	where(field, operator, value) {
		assertQueryable(field, operator);
		this._filters.push({ field, operator, value });
		return this;
	}

	orderBy(field, direction = 'asc') {
		if (field.includes('.')) {
			throw new Error(`[sqlite-firestore] cannot order by nested field "${field}"`);
		}
		this._orderBy = { field, direction };
		return this;
	}

	limit(count) {
		this._limit = count;
		return this;
	}

	offset(count) {
		this._offset = count;
		return this;
	}

	get() {
		const params = { collection: this._collection };
		const clauses = ['collection = :collection'];

		this._filters.forEach(({ field, operator, value }, index) => {
			const paramName = `p${index}`;
			clauses.push(`json_extract(data, '$.${field}') ${SQL_OPERATOR[operator]} :${paramName}`);
			params[paramName] = normalizeForSql(value);
		});

		let sql = `SELECT id, data FROM documents WHERE ${clauses.join(' AND ')}`;

		if (this._orderBy) {
			const direction = this._orderBy.direction === 'desc' ? 'DESC' : 'ASC';
			sql += ` ORDER BY json_extract(data, '$.${this._orderBy.field}') ${direction}`;
		} else {
			// Firestore returns documents in key order by default. Keeping a stable
			// order means list endpoints do not reshuffle between identical queries.
			sql += ' ORDER BY id ASC';
		}

		if (this._limit !== null) {
			sql += ' LIMIT :limit';
			params.limit = this._limit;
		}
		if (this._offset !== null) {
			sql += ' OFFSET :offset';
			params.offset = this._offset;
		}

		const rows = this._db.prepare(sql).all(params);
		return new QuerySnapshot(rows.map((row) => new DocumentSnapshot(row.id, JSON.parse(row.data))));
	}
}

/** DocumentReference — mirrors Firestore's shape. */
class DocumentReference {
	constructor(database, collectionName, id) {
		this._db = database;
		this._collection = collectionName;
		this.id = id;
	}

	collection(name) {
		return new CollectionReference(this._db, name);
	}

	async get() {
		const row = this._db
			.prepare('SELECT data FROM documents WHERE collection = :collection AND id = :id')
			.get({ collection: this._collection, id: this.id });
		return new DocumentSnapshot(this.id, row ? JSON.parse(row.data) : null);
	}

	async update(fields) {
		const snapshot = await this.get();
		if (!snapshot.exists) {
			// Firestore's update() on a missing doc throws NOT_FOUND.
			const error = new Error(`5 NOT_FOUND: no document to update: ${this._collection}/${this.id}`);
			error.code = 5;
			throw error;
		}
		const merged = { ...snapshot.data(), ...fields };
		this._db
			.prepare('UPDATE documents SET data = :data, updated_at = :now WHERE collection = :collection AND id = :id')
			.run({
				data: JSON.stringify(merged),
				now: new Date().toISOString(),
				collection: this._collection,
				id: this.id
			});
	}

	async set(fields, options = {}) {
		const params = {
			data: JSON.stringify(fields),
			now: new Date().toISOString(),
			collection: this._collection,
			id: this.id
		};
		if (options.merge) {
			const snapshot = await this.get();
			const merged = snapshot.exists ? { ...snapshot.data(), ...fields } : { ...fields };
			params.data = JSON.stringify(merged);
			this._db
				.prepare(
					`INSERT INTO documents (collection, id, data, created_at, updated_at)
					 VALUES (:collection, :id, :data, :now, :now)
					 ON CONFLICT(collection, id) DO UPDATE SET data = :data, updated_at = :now`
				)
				.run(params);
			return;
		}
		this._db
			.prepare(
				`INSERT INTO documents (collection, id, data, created_at, updated_at)
				 VALUES (:collection, :id, :data, :now, :now)
				 ON CONFLICT(collection, id) DO UPDATE SET data = :data, updated_at = :now`
			)
			.run(params);
	}

	async delete() {
		this._db.prepare('DELETE FROM documents WHERE collection = :collection AND id = :id').run({
			collection: this._collection,
			id: this.id
		});
	}
}

/** CollectionReference — mirrors Firestore's shape. */
class CollectionReference {
	constructor(database, collectionName) {
		this._db = database;
		this._name = collectionName;
		this.id = collectionName;
	}

	doc(id) {
		return new DocumentReference(this._db, this._name, id);
	}

	async add(data) {
		const id = generateId();
		this._db
			.prepare(
				`INSERT INTO documents (collection, id, data, created_at, updated_at)
				 VALUES (:collection, :id, :data, :now, :now)`
			)
			.run({
				collection: this._name,
				id,
				data: JSON.stringify(data),
				now: new Date().toISOString()
			});
		return { id, path: `${this._name}/${id}` };
	}

	async get() {
		return new Query(this._db, this._name).get();
	}

	where(field, operator, value) {
		return new Query(this._db, this._name).where(field, operator, value);
	}

	orderBy(field, direction) {
		return new Query(this._db, this._name).orderBy(field, direction);
	}

	limit(count) {
		return new Query(this._db, this._name).limit(count);
	}
}

/**
 * Firestore stores every number as a float or int; SQLite's json_extract returns
 * whatever JSON type the value has. Booleans are the one real trap: SQLite has no
 * native boolean, so bind them as 1/0 and json_extract will surface them as ints.
 */
function normalizeForSql(value) {
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (value === undefined) return null;
	return value;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
	collection TEXT NOT NULL,
	id         TEXT NOT NULL,
	data       TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents (collection);
`;

class Firestore {
	constructor(filename = ':memory:') {
		if (filename !== ':memory:') {
			fs.mkdirSync(path.dirname(filename), { recursive: true });
		}
		this.filename = filename;
		this.db = new DatabaseSync(filename);
		// WAL keeps readers from blocking the writer; foreign_keys is off because
		// documents are intentionally schemaless.
		this.db.exec('PRAGMA journal_mode = WAL');
		this.db.exec(SCHEMA);
	}

	collection(name) {
		return new CollectionReference(this.db, name);
	}

	/** Run `fn` inside a SQLite transaction. Useful for multi-write operations. */
	async runTransaction(fn) {
		this.db.exec('BEGIN');
		try {
			const result = await fn();
			this.db.exec('COMMIT');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	/** Direct access for maintenance tasks (export, migrations, tests). */
	raw() {
		return this.db;
	}

	close() {
		this.db.close();
	}
}

let singleton = null;

/**
 * Drop-in replacement for `admin.firestore()`. Reuses one connection per process
 * so every route module shares the same database handle.
 */
function firestore(filename = process.env.SQLITE_FILE || 'data/money-tracker.db') {
	if (!singleton) singleton = new Firestore(filename);
	return singleton;
}

module.exports = { firestore, Firestore, DocumentSnapshot, QuerySnapshot, generateId };