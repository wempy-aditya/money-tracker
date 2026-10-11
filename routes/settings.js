/**
 * LLM connection settings.
 *
 * The API key is write-only over HTTP. `GET` returns `has_key` and never the key
 * itself; the column is simply absent from the read query in db/profile.js, so
 * no future edit to a route can leak it the way spreading a stored object would.
 *
 * Mounted at /api/settings rather than sharing a router with the profile, so the
 * requireAuth guard cannot accidentally reach a public endpoint.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');
const { ProfileStore } = require('../db/profile');

const db = firestore();
const store = new ProfileStore(db.raw());

const ownerOf = (req) => req.auth.userId;

function cleanText(value) {
	if (value === undefined || value === null) return null;
	const text = String(value).trim();
	return text === '' ? null : text.slice(0, 500);
}

/** Clamped to a sane range and never NaN. */
function cleanNumber(value, { min = 0, max = 200, fallback = null } = {}) {
	if (value === undefined || value === null || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

/**
 * Validates the base URL shape now, so the first chat does not fail with an
 * opaque fetch error. Only http(s): this value is user-supplied and must never
 * reach a file:// or another local scheme.
 */
function validateUrl(value) {
	if (!value) return null;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return 'URL API tidak valid';
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return 'URL API harus diawali http:// atau https://';
	}
	return null;
}

// 🔹 Ambil pengaturan LLM (tanpa API key)
router.get('/', (req, res) => {
	const userId = ownerOf(req);
	const settings = store.readSettings(userId);
	const status = store.connectionStatus(userId);

	res.status(200).json({ ...settings, configured: status.configured, missing: status.missing });
});

// 🔹 Simpan pengaturan LLM
router.put('/', (req, res) => {
	try {
		const userId = ownerOf(req);
		const body = req.body || {};

		const urlError = validateUrl(cleanText(body.api_url));
		if (urlError) return res.status(400).json({ error: urlError });

		const values = {
			api_url: cleanText(body.api_url),
			model: cleanText(body.model),
			temperature: cleanNumber(body.temperature, { min: 0, max: 2, fallback: 0.7 }),
			max_tokens: cleanNumber(body.max_tokens, { min: 64, max: 32000, fallback: 1024 })
		};

		// An absent api_key keeps the stored one, so the form never has to
		// round-trip the secret through the browser. An explicit empty string
		// is how the user clears it.
		if (body.api_key !== undefined) {
			const key = String(body.api_key || '').trim();
			if (key === '') store.clearKey(userId);
			else values.api_key = key;
		}

		const saved = store.writeSettings(userId, values);
		const status = store.connectionStatus(userId);

		res.status(200).json({ ...saved, configured: status.configured, missing: status.missing });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// 🔹 Uji koneksi ke LLM
router.post('/test', async (req, res) => {
	try {
		const userId = ownerOf(req);
		const status = store.connectionStatus(userId);

		if (!status.configured) {
			return res.status(400).json({ error: 'Pengaturan belum lengkap', missing: status.missing });
		}

		const { testConnection } = require('../services/llm');
		const result = await testConnection(userId);

		res.status(result.ok ? 200 : 502).json(result);
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

module.exports = router;
module.exports.store = store;