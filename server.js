const express = require('express');
const os = require('node:os');
const path = require('node:path');

require('dotenv').config();

// Storage: SQLite via a Firestore-compatible shim (see db/firestore.js).
const { firestore } = require('./db/firestore');
const db = firestore();

// Authentication and sessions (see db/auth.js).
const { Auth, attachUser, requireAuth } = require('./db/auth');
const auth = new Auth(db.raw());

const app = express();

// Behind a reverse proxy, req.ip should reflect X-Forwarded-For or the login
// throttle keys on the proxy's address for everyone.
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Populates req.auth when a valid session cookie is present.
app.use(attachUser(auth));

const { createAuthRouter } = require('./routes/auth');
app.use('/api/auth', createAuthRouter(auth));

// Every data route below requires a signed-in user. Static assets stay public so
// the login page itself can load; the HTML pages are gated further down.
app.use('/api/wallets', requireAuth, require('./routes/wallets'));
app.use('/api/budgeting', requireAuth, require('./routes/budgeting'));
app.use('/api/transactions', requireAuth, require('./routes/transactions'));
app.use('/api/analytics', requireAuth, require('./routes/analytics'));
app.use('/api/goals', requireAuth, require('./routes/goals'));
app.use('/api/recurring', requireAuth, require('./routes/recurring'));
app.use('/api/insights', requireAuth, require('./routes/insights'));
app.use('/api/profile', requireAuth, require('./routes/profile'));
app.use('/api/settings', requireAuth, require('./routes/settings'));
app.use('/api/chat', requireAuth, require('./routes/chat'));
app.use('/export', requireAuth, require('./routes/exports'));

const PUBLIC_DIR = path.join(__dirname, './view');

// Static assets: CSS, JS, images. These are not sensitive and must load before
// the signed-in check so the login page can be styled.
app.use(express.static(PUBLIC_DIR, { index: false }));

// Health check stays open so a LAN reachability test does not need credentials.
app.get('/api/health', (req, res) => {
	res.json({ status: 'ok', authenticated: Boolean(req.auth) });
});

// Frontend pages require a session. Without one, send the browser to the login
// screen instead of rendering an app that would fail every request.
const PAGES = {
	'/home': 'home.html',
	'/wallet': 'index.html',
	'/budget': 'budget.html',
	'/transactions': 'transactions.html',
	'/goals': 'goals.html',
	'/recurring': 'recurring.html',
	'/insights': 'insights.html',
	'/chat': 'chat.html',
	'/profile': 'profile.html',
	'/settings': 'settings.html'
};

function requirePage(req, res, next) {
	if (!req.auth) {
		if (req.path.startsWith('/api/')) {
			return res.status(401).json({ error: 'Authentication required' });
		}
		return res.redirect('/login');
	}
	next();
}

Object.entries(PAGES).forEach(([route, file]) => {
	app.get(route, requirePage, (req, res) => {
		res.sendFile(path.join(PUBLIC_DIR, 'html', file));
	});
});

// Login page is public.
app.get('/login', (req, res) => {
	if (req.auth) return res.redirect('/home');
	res.sendFile(path.join(PUBLIC_DIR, 'html', 'login.html'));
});

// Unknown paths fall through to the login page when signed out, and 404 otherwise.
app.use((req, res) => {
	if (!req.auth && !req.path.startsWith('/api/')) return res.redirect('/login');
	res.status(404).sendFile(path.join(PUBLIC_DIR, 'html', '404.html'));
});

/**
 * LAN addresses worth showing: the ones a phone on the same Wi-Fi could
 * actually reach. Docker and other virtual bridges are filtered out, otherwise
 * the banner lists half a dozen addresses that no device can use.
 */
function lanAddresses() {
	const interfaces = os.networkInterfaces();
	const isVirtual = (name) => /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|cni|flannel|zt)/i.test(name);
	const isVirtualAddress = (address) =>
		address.startsWith('172.') || address.startsWith('10.214.') || address === '10.0.2.2';

	const candidates = [];

	for (const [name, entries] of Object.entries(interfaces)) {
		if (isVirtual(name)) continue;
		for (const entry of entries || []) {
			if (entry.family !== 'IPv4' || entry.internal) continue;
			if (isVirtualAddress(entry.address)) continue;
			candidates.push(entry.address);
		}
	}

	// Prefer 192.168.x (typical home LAN) over anything else.
	candidates.sort((a, b) => {
		const rank = (address) => (address.startsWith('192.168.') ? 0 : 1);
		return rank(a) - rank(b) || a.localeCompare(b);
	});

	return candidates;
}

const PORT = Number(process.env.PORT) || 5000;
// Binding to 0.0.0.0 is what makes this reachable from a phone on the same
// network. It also means the app is exposed to everyone on that network, which
// is why authentication is mandatory rather than optional.
const HOST = process.env.HOST || '0.0.0.0';

// Only start listening when run directly. Test suites require this file to get
// the app object; starting a listener there would keep the process alive forever.
if (require.main === module) {
	app.listen(PORT, HOST, () => {
		console.log(`Server running on http://localhost:${PORT}`);
		const lan = lanAddresses();
		if (lan.length === 0) {
			console.log('No LAN address found. Check your network connection.');
			return;
		}
		console.log('\nOpen on another device on the same network:');
		for (const address of lan) {
			console.log(`  http://${address}:${PORT}`);
		}
		console.log('');
	});
}

module.exports = app;
module.exports.auth = auth;