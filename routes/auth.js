/**
 * Session endpoints: register, login, logout, and "who am I".
 *
 * There is deliberately no password reset or email verification. This app is
 * meant to run on a local network for a single household, not as a public
 * service. Both credential endpoints are rate limited per IP to blunt online
 * password guessing.
 */

const express = require('express');
const { SESSION_COOKIE, parseCookies } = require('../db/auth');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function createAuthRouter(auth) {
	const router = express.Router();

	// Failed-login throttle. In-memory and per-process, which is enough for a
	// single-process LAN app; it would need shared storage to mean anything
	// across replicas.
	const attempts = new Map();

	function throttle(req, res, next) {
		const key = req.ip || 'unknown';
		const now = Date.now();
		const entry = attempts.get(key);

		if (entry && now - entry.first < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
			const waitSeconds = Math.ceil((WINDOW_MS - (now - entry.first)) / 1000);
			res.set('Retry-After', String(waitSeconds));
			return res.status(429).json({ error: `Too many attempts. Try again in ${waitSeconds} seconds.` });
		}

		if (!entry || now - entry.first >= WINDOW_MS) {
			attempts.set(key, { first: now, count: 0 });
		}
		next();
	}

	const cookieOptions = (expiresAt) => ({
		expires: expiresAt,
		httpOnly: true,
		sameSite: 'lax',
		path: '/',
		...(process.env.COOKIE_SECURE === 'true' ? { secure: true } : {})
	});

	const publicUser = (userId) => {
		const row = auth.db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
		return { userId, username: row ? row.username : null };
	};

	// 🔹 Daftar akun baru
	router.post('/register', async (req, res) => {
		try {
			const { username, password } = req.body || {};
			const session = await auth.register(username, password);
			attempts.delete(req.ip || 'unknown');
			res.cookie(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt));
			res.status(201).json({ user: publicUser(session.userId) });
		} catch (error) {
			res.status(error.status || 500).json({ error: error.message });
		}
	});

	// 🔹 Masuk
	router.post('/login', throttle, async (req, res) => {
		try {
			const { username, password } = req.body || {};
			const session = await auth.login(username, password);
			attempts.delete(req.ip || 'unknown');
			res.cookie(SESSION_COOKIE, session.token, cookieOptions(session.expiresAt));
			res.status(200).json({ user: publicUser(session.userId) });
		} catch (error) {
			const key = req.ip || 'unknown';
			if (attempts.has(key)) attempts.get(key).count += 1;
			res.status(error.status || 500).json({ error: error.message });
		}
	});

	// 🔹 Keluar
	router.post('/logout', (req, res) => {
		auth.logout(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
		res.clearCookie(SESSION_COOKIE, { path: '/' });
		res.status(200).json({ ok: true });
	});

	// 🔹 Session aktif (dipakai frontend untuk tahu sudah login atau belum)
	router.get('/me', (req, res) => {
		if (!req.auth) {
			return res.status(401).json({ error: 'Not signed in' });
		}
		res.status(200).json({ user: { userId: req.auth.userId, username: req.auth.username } });
	});

	return router;
}

module.exports = { createAuthRouter };