/**
 * The user profile: who the user is, in terms the financial advisor can reason
 * from. One row per user, mounted at /api/profile.
 *
 * Every field is optional. A profile with nothing in it still works, and the
 * advisor is told the profile is empty rather than answering as if it knew the
 * user. See routes/settings.js for the LLM connection config.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');
const { ProfileStore, PROFILE_FIELDS, NUMERIC_PROFILE_FIELDS } = require('../db/profile');

const db = firestore();
const store = new ProfileStore(db.raw());

const ownerOf = (req) => req.auth.userId;

/** Text fields are trimmed and length-capped; empty string means "not set". */
const MAX_TEXT = 500;

function cleanText(value) {
	if (value === undefined || value === null) return null;
	const text = String(value).trim();
	return text === '' ? null : text.slice(0, MAX_TEXT);
}

/** A numeric field that is absent, blank or not a number becomes null, not NaN. */
function cleanNumber(value, { min = 0, max = 200 } = {}) {
	if (value === undefined || value === null || value === '') return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

/* ------------------------------------------------------------------ profile */

// 🔹 Ambil profil user
router.get('/', (req, res) => {
	res.status(200).json(store.readProfile(ownerOf(req)));
});

// 🔹 Simpan profil user
router.put('/', (req, res) => {
	try {
		const userId = ownerOf(req);
		const body = req.body || {};

		const values = {};
		for (const field of PROFILE_FIELDS) values[field] = cleanText(body[field]);
		for (const field of NUMERIC_PROFILE_FIELDS) values[field] = cleanNumber(body[field]);

		res.status(200).json(store.writeProfile(userId, values));
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

/**
 * How much of the profile is filled in. The advisor is far less useful with an
 * empty profile, and the settings page shows this so the gap is visible instead
 * of the AI quietly answering with worse advice.
 */
router.get('/completeness', (req, res) => {
	const profile = store.readProfile(ownerOf(req));

	const present = PROFILE_FIELDS.filter((field) => profile[field]).length;
	const total = PROFILE_FIELDS.length + NUMERIC_PROFILE_FIELDS.length;
	const filled =
		present + NUMERIC_PROFILE_FIELDS.filter((field) => profile[field] !== null).length;

	const missing = [
		...PROFILE_FIELDS.filter((field) => !profile[field]),
		...NUMERIC_PROFILE_FIELDS.filter((field) => profile[field] === null)
	];

	res.status(200).json({
		filled,
		total,
		percent: Math.round((filled / total) * 100),
		missing,
		// The three that matter most for money advice.
		hasBasics: Boolean(profile.age || profile.occupation || profile.financial_goals)
	});
});

module.exports = router;
module.exports.store = store;
