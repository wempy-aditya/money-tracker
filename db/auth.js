/**
 * Authentication and sessions.
 *
 * Design notes:
 * - Passwords are hashed with scrypt (memory-hard, built into node:crypto, no
 *   native dependency) using a per-user random salt. Verification is a constant
 *   time comparison so a wrong password cannot be narrowed down by timing.
 * - Sessions are opaque random tokens stored server-side. Storing the token means
 *   logout can actually revoke access; a stateless JWT could not be revoked
 *   before expiry without a blocklist, which is the same as storing it.
 * - Every user-owned document carries a `userId`. Routes read that id from the
 *   session, never from the request body, which is what closes the IDOR hole the
 *   original app had (see NOTES.md bug #3 and #4).
 */

const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
	id            TEXT PRIMARY KEY,
	username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT NOT NULL,
	created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token      TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
`;

const SESSION_DAYS = 30;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

class Auth {
	constructor(raw) {
		this.db = raw;
		this.db.exec(SCHEMA);
		this.purgeExpired();
	}

	purgeExpired() {
		this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
	}

	static validateUsername(username) {
		if (typeof username !== 'string') return 'Username is required';
		if (!USERNAME_PATTERN.test(username)) {
			return 'Username must be 3-32 characters, letters, numbers, dot, dash or underscore';
		}
		return null;
	}

	static validatePassword(password) {
		if (typeof password !== 'string' || password.length === 0) return 'Password is required';
		if (password.length < MIN_PASSWORD_LENGTH) {
			return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
		}
		if (password.length > 200) return 'Password must be at most 200 characters';
		return null;
	}

	async hashPassword(password) {
		const salt = randomBytes(16);
		const derived = await new Promise((resolve, reject) => {
			scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, key) => (err ? reject(err) : resolve(key)));
		});
		return `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
	}

	async verifyPassword(password, stored) {
		const parts = String(stored).split('$');
		if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
		const [, N, r, p, saltB64, hashB64] = parts;

		let expected;
		try {
			expected = Buffer.from(hashB64, 'base64');
			const salt = Buffer.from(saltB64, 'base64');
			const derived = await new Promise((resolve, reject) => {
				scrypt(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) }, (err, key) =>
					err ? reject(err) : resolve(key)
				);
			});
			return derived.length === expected.length && timingSafeEqual(derived, expected);
		} catch {
			return false;
		}
	}

	async register(username, password) {
		const usernameError = Auth.validateUsername(username);
		if (usernameError) throw Object.assign(new Error(usernameError), { status: 400 });
		const passwordError = Auth.validatePassword(password);
		if (passwordError) throw Object.assign(new Error(passwordError), { status: 400 });

		const id = randomBytes(12).toString('base64url');
		const passwordHash = await this.hashPassword(password);

		try {
			this.db
				.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
				.run(id, username, passwordHash, new Date().toISOString());
		} catch (error) {
			if (String(error.message).includes('UNIQUE')) {
				throw Object.assign(new Error('Username already taken'), { status: 409 });
			}
			throw error;
		}
		return this.createSession(id);
	}

	async login(username, password) {
		const row = this.db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username);
		// Always run a verification so a missing user and a wrong password take
		// comparable time and cannot be told apart by an attacker enumerating names.
		const stored = row ? row.password_hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
		const ok = await this.verifyPassword(password, stored);

		if (!row || !ok) {
			throw Object.assign(new Error('Incorrect username or password'), { status: 401 });
		}
		return this.createSession(row.id);
	}

	createSession(userId) {
		const token = randomBytes(32).toString('base64url');
		const now = new Date();
		const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
		this.db
			.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
			.run(token, userId, now.toISOString(), expiresAt.toISOString());
		return { token, userId, expiresAt };
	}

	/** Resolves a session token to its user, or null. */
	resolveSession(token) {
		if (!token || typeof token !== 'string') return null;
		this.purgeExpired();
		const row = this.db
			.prepare(
				`SELECT s.user_id, u.username
				 FROM sessions s
				 JOIN users u ON u.id = s.user_id
				 WHERE s.token = ? AND s.expires_at > ?`
			)
			.get(token, new Date().toISOString());
		return row ? { userId: row.user_id, username: row.username } : null;
	}

	logout(token) {
		if (!token) return;
		this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
	}
}

const SESSION_COOKIE = 'mt_session';

function parseCookies(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index === -1) continue;
		const key = part.slice(0, index).trim();
		if (!key) continue;
		try {
			out[key] = decodeURIComponent(part.slice(index + 1).trim());
		} catch {
			out[key] = part.slice(index + 1).trim();
		}
	}
	return out;
}

/**
 * Attaches req.auth = { userId, username } when a valid session cookie is present.
 * Never rejects: routes that need a user use requireAuth on top of this.
 */
function attachUser(auth) {
	return (req, _res, next) => {
		const cookies = parseCookies(req.headers.cookie);
		req.cookies = cookies;
		req.sessionToken = cookies[SESSION_COOKIE] || null;
		req.auth = auth.resolveSession(req.sessionToken);
		next();
	};
}

function requireAuth(req, res, next) {
	if (!req.auth) {
		return res.status(401).json({ error: 'Authentication required' });
	}
	next();
}

function sessionCookieOptions(expiresAt) {
	const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
	if (process.env.COOKIE_SECURE === 'true') attrs.push('Secure');
	if (expiresAt) attrs.push(`Expires=${new Date(expiresAt).toUTCString()}`);
	return attrs.join('; ');
}

module.exports = {
	Auth,
	attachUser,
	requireAuth,
	parseCookies,
	sessionCookieOptions,
	SESSION_COOKIE,
	SESSION_DAYS,
	MIN_PASSWORD_LENGTH
};