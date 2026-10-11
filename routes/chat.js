/**
 * Chat with the financial advisor.
 *
 * Two properties this route is built around:
 *
 *   1. Every exchange is recorded. Both the question and the answer, and also
 *      the failures, because a conversation where the assistant refused or the
 *      provider was unreachable is still part of the history the user will want
 *      to look back on.
 *
 *   2. The assistant is read-only. It gets no tools and no write endpoints are
 *      reachable from it, so "buy this for me" is answered with advice rather
 *      than performed. The user acts on it themselves, and the transactions they
 *      create afterwards are what the next conversation will see.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { firestore } = require('../db/firestore');
const { ProfileStore } = require('../db/profile');
const llm = require('../services/llm');

const db = firestore();
const store = new ProfileStore(db.raw());

const ownerOf = (req) => req.auth.userId;

const MAX_QUESTION_LENGTH = 4000;

/* ---------------------------------------------------------------- history */

// 🔹 Riwayat chat
router.get('/', (req, res) => {
	try {
		const userId = ownerOf(req);
		const limit = Math.min(Number(req.query.limit) || 50, 200);

		res.status(200).json({
			messages: store.listMessages(userId, { limit }),
			total: store.countMessages(userId)
		});
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// 🔹 Hapus riwayat chat
router.delete('/', (req, res) => {
	try {
		const removed = store.clearMessages(ownerOf(req));
		res.status(200).json({ removed, message: 'Riwayat chat dihapus' });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

/* ------------------------------------------------------------------- chat */

// 🔹 Tanya advisor
router.post('/', async (req, res) => {
	const userId = ownerOf(req);
	const body = req.body || {};
	const question = String(body.message || '').trim();

	if (question === '') {
		return res.status(400).json({ error: 'Pertanyaan tidak boleh kosong' });
	}
	if (question.length > MAX_QUESTION_LENGTH) {
		return res.status(400).json({ error: `Pertanyaan maksimal ${MAX_QUESTION_LENGTH} karakter` });
	}

	const status = store.connectionStatus(userId);
	if (!status.configured) {
		// The question is still recorded: the user asked something, and losing it
		// because the connection was not set up yet is the kind of thing that
		// makes a chat feel unreliable.
		store.appendMessage(userId, 'user', question);
		store.appendMessage(
			userId,
			'assistant',
			'Belum bisa menjawab karena pengaturan AI belum lengkap. Buka halaman Pengaturan dan isi URL API, nama model, dan API key.'
		);
		return res.status(409).json({
			error: 'AI belum dikonfigurasi',
			missing: status.missing,
			configured: false
		});
	}

	const settings = store.readSettingsWithKey(userId);
	const profile = store.readProfile(userId);

	// Recorded before the call, so a provider that never answers still leaves the
	// question in the history rather than losing it.
	const questionRecord = store.appendMessage(userId, 'user', question);

	try {
		const snapshot = await llm.financialSnapshot(userId);

		const history = store
			.listMessages(userId, { limit: 200, newestFirst: false })
			// The question just recorded is sent as the live turn, not as history.
			.filter((turn) => turn.id !== questionRecord.id);

		const messages = llm.buildMessages({
			settings: { ...settings, profileIncomplete: !hasUsefulProfile(profile) },
			profile,
			snapshot,
			history,
			question
		});
		messages.push({ role: 'user', content: question });

		const result = await llm.callModel(settings, messages);

		if (!result.ok) {
			store.appendMessage(userId, 'assistant', `[Gagal] ${result.error}`);
			return res.status(502).json({ error: result.error, providerStatus: result.status });
		}

		const answerRecord = store.appendMessage(userId, 'assistant', result.content);

		res.status(200).json({
			question: questionRecord,
			answer: answerRecord,
			model: result.model,
			usage: result.usage
		});
	} catch (error) {
		store.appendMessage(userId, 'assistant', `[Gagal] ${error.message}`);
		res.status(500).json({ error: error.message });
	}
});

/**
 * Enough profile to give advice that depends on stage of life. A profile with
 * nothing in it makes the assistant generic, and it should say so rather than
 * quietly answering as if it knew the user.
 */
function hasUsefulProfile(profile) {
	return Boolean(
		profile.age ||
		profile.occupation ||
		profile.financial_goals ||
		profile.monthly_commitments ||
		profile.dependents !== null
	);
}

/** A starter prompt list. The suggestions are questions the data can answer. */
router.get('/suggestions', (req, res) => {
	res.status(200).json([
		'Di mana pengeluaran saya paling besar bulan ini?',
		'Apakah saya bisa beli barang seharga Rp2.000.000 bulan ini?',
		'Kategori apa yang paling besar pengeluaranku?',
		'Kalau saya tambah tabungan Rp500.000 per bulan, dampaknya apa?',
		'Apakah pengeluaran saya sudah wajar dibanding penghasilan saya?',
		'Ke mana sebaiknya saya memusatkan penghematan dulu?'
	]);
});

module.exports = router;