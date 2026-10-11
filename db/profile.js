/**
 * Storage for the user profile, the LLM connection settings, and the chat record.
 *
 * These live in real relational tables rather than in the document store. Three
 * reasons, and the third is the one that matters:
 *
 *   - A profile is one row per user, not a document. Reading it should not mean
 *     parsing JSON to find out whether a setting exists.
 *   - The chat history is append-only and queried by recency, which is what an
 *     index is for.
 *   - The API key must never be returned by any read. A dedicated table makes
 *     that enforceable: the read query simply does not select that column, so no
 *     future edit to a route can leak it by accident the way a spread of a
 *     stored object would.
 *
 * DDL is idempotent, so an existing database picks these up on next start
 * without a migration step and without touching existing rows.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
	user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	display_name  TEXT,
	age           INTEGER,
	occupation    TEXT,
	education     TEXT,
	position      TEXT,
	background    TEXT,
	hobbies       TEXT,
	dependents    INTEGER,
	monthly_commitments TEXT,
	financial_goals      TEXT,
	risk_tolerance       TEXT,
	notes         TEXT,
	updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_settings (
	user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	api_url      TEXT,
	model        TEXT,
	api_key      TEXT,
	temperature  REAL,
	max_tokens   INTEGER,
	system_prompt TEXT,
	updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
	id         TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role       TEXT NOT NULL,
	content    TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_user_time ON chat_messages (user_id, created_at);
`;

/**
 * Free-text fields on the profile. Kept in one list so the route, the validation
 * and the prompt builder cannot drift apart: a field added to the form but not
 * here would silently never reach the AI.
 */
const PROFILE_FIELDS = [
	'display_name',
	'occupation',
	'education',
	'position',
	'background',
	'hobbies',
	'monthly_commitments',
	'financial_goals',
	'risk_tolerance',
	'notes'
];

const NUMERIC_PROFILE_FIELDS = ['age', 'dependents'];

/** Shape stored when a user has not filled the form in yet. */
function emptyProfile() {
	const profile = { age: null, dependents: null };
	for (const field of PROFILE_FIELDS) profile[field] = null;
	return profile;
}

function emptySettings() {
	return {
		api_url: null,
		model: null,
		has_key: false,
		temperature: 0.7,
		max_tokens: 1024
	};
}

class ProfileStore {
	constructor(raw) {
		this.db = raw;
		this.db.exec(SCHEMA);
	}

	/* -------------------------------------------------------------- profile */

	readProfile(userId) {
		const row = this.db
			.prepare('SELECT * FROM profiles WHERE user_id = ?')
			.get(userId);

		if (!row) return { ...emptyProfile(), updated_at: null };

		const profile = emptyProfile();
		for (const field of PROFILE_FIELDS) profile[field] = row[field] ?? null;
		for (const field of NUMERIC_PROFILE_FIELDS) {
			profile[field] = row[field] === null || row[field] === undefined ? null : Number(row[field]);
		}
		profile.updated_at = row.updated_at;
		return profile;
	}

	/**
	 * Upsert. SQLite's ON CONFLICT keeps this to one statement, so there is no
	 * window where two concurrent saves leave two rows for one user.
	 */
	writeProfile(userId, values) {
		const now = new Date().toISOString();
		const profile = { ...emptyProfile(), ...values };
		profile.updated_at = now;

		this.db
			.prepare(
				`INSERT INTO profiles (
					user_id, display_name, age, occupation, education, position,
					background, hobbies, dependents, monthly_commitments,
					financial_goals, risk_tolerance, notes, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET
					display_name = excluded.display_name,
					age = excluded.age,
					occupation = excluded.occupation,
					education = excluded.education,
					position = excluded.position,
					background = excluded.background,
					hobbies = excluded.hobbies,
					dependents = excluded.dependents,
					monthly_commitments = excluded.monthly_commitments,
					financial_goals = excluded.financial_goals,
					risk_tolerance = excluded.risk_tolerance,
					notes = excluded.notes,
					updated_at = excluded.updated_at`
			)
			.run(
				userId,
				profile.display_name,
				profile.age,
				profile.occupation,
				profile.education,
				profile.position,
				profile.background,
				profile.hobbies,
				profile.dependents,
				profile.monthly_commitments,
				profile.financial_goals,
				profile.risk_tolerance,
				profile.notes,
				now
			);

		return profile;
	}

	/* ------------------------------------------------------------- settings */

	/**
	 * The read used by the settings page. `api_key` is not in the column list,
	 * so it cannot be returned even if a caller spreads the result.
	 */
	readSettings(userId) {
		// `has_key` needs to know whether the column is set, but the value itself
		// is never selected. SQL cannot express "does this column exist without
		// reading it" directly, so a second query carries the check; that keeps the
		// secret out of this row entirely rather than relying on the return object
		// to drop it, which is one edit away from leaking.
		const row = this.db
			.prepare('SELECT api_url, model, temperature, max_tokens, updated_at FROM llm_settings WHERE user_id = ?')
			.get(userId);

		if (!row) return { ...emptySettings(), updated_at: null };

		const hasKey = Boolean(
			this.db
				.prepare('SELECT api_key IS NOT NULL AND api_key != \'\' AS present FROM llm_settings WHERE user_id = ?')
				.get(userId).present
		);

		return {
			api_url: row.api_url,
			model: row.model,
			has_key: hasKey,
			temperature: row.temperature === null ? 0.7 : Number(row.temperature),
			max_tokens: row.max_tokens === null ? 1024 : Number(row.max_tokens),
			updated_at: row.updated_at
		};
	}

	/** The full settings, including the key. Server-side use only. */
	readSettingsWithKey(userId) {
		const row = this.db
			.prepare('SELECT api_url, model, api_key, temperature, max_tokens FROM llm_settings WHERE user_id = ?')
			.get(userId);

		if (!row) return { ...emptySettings(), api_key: null };
		return {
			api_url: row.api_url,
			model: row.model,
			api_key: row.api_key,
			temperature: Number(row.temperature ?? 0.7),
			max_tokens: Number(row.max_tokens ?? 1024)
		};
	}

	writeSettings(userId, values) {
		const now = new Date().toISOString();
		const current = this.readSettingsWithKey(userId);

		// A blank key on the form means "keep the stored one", not "erase it", so
		// the page never has to round-trip the key through the browser to save
		// an unrelated field.
		const apiKey = values.api_key === undefined || values.api_key === null
			? current.api_key
			: String(values.api_key);

		this.db
			.prepare(
				`INSERT INTO llm_settings (user_id, api_url, model, api_key, temperature, max_tokens, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET
					api_url = excluded.api_url,
					model = excluded.model,
					api_key = excluded.api_key,
					temperature = excluded.temperature,
					max_tokens = excluded.max_tokens,
					updated_at = excluded.updated_at`
			)
			.run(
				userId,
				values.api_url ?? null,
				values.model ?? null,
				apiKey,
				values.temperature ?? 0.7,
				values.max_tokens ?? 1024,
				now
			);

		return this.readSettings(userId);
	}

	/** Only ever called when the user explicitly clears the field. */
	clearKey(userId) {
		const row = this.db.prepare('SELECT user_id FROM llm_settings WHERE user_id = ?').get(userId);
		if (row) this.db.prepare('UPDATE llm_settings SET api_key = NULL WHERE user_id = ?').run(userId);
	}

	/** A settings row is usable only when all three parts are present. */
	connectionStatus(userId) {
		const row = this.readSettingsWithKey(userId);
		const missing = [];
		if (!row.api_url) missing.push('api_url');
		if (!row.model) missing.push('model');
		if (!row.api_key) missing.push('api_key');
		return {
			configured: missing.length === 0,
			missing,
			api_url: row.api_url,
			model: row.model
		};
	}

	/* ----------------------------------------------------------------- chat */

	appendMessage(userId, role, content) {
		const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const createdAt = new Date().toISOString();

		this.db
			.prepare('INSERT INTO chat_messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
			.run(id, userId, role, String(content), createdAt);

		return { id, role, content: String(content), created_at: createdAt };
	}

	/** Most recent first when newestFirst, which is how the chat view reads. */
	listMessages(userId, { limit = 50, before = null, newestFirst = true } = {}) {
		const rows = this.db
			.prepare(
				`SELECT id, role, content, created_at FROM chat_messages
				WHERE user_id = ? AND (? IS NULL OR created_at < ?)
				ORDER BY created_at ${newestFirst ? 'DESC' : 'ASC'}
				LIMIT ?`
			)
			.all(userId, before, before, Math.min(Number(limit) || 50, 200));

		return rows.map((row) => ({
			id: row.id,
			role: row.role,
			content: row.content,
			created_at: row.created_at
		}));
	}

	countMessages(userId) {
		return this.db
			.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?')
			.get(userId).n;
	}

	clearMessages(userId) {
		const result = this.db.prepare('DELETE FROM chat_messages WHERE user_id = ?').run(userId);
		return result.changes;
	}
}

module.exports = { ProfileStore, PROFILE_FIELDS, NUMERIC_PROFILE_FIELDS, emptyProfile, emptySettings };