/**
 * Static check over the served HTML pages.
 *
 * Every page wires its buttons through inline `onclick="fn()"` attributes and its
 * scripts reach into the markup with `getElementById`. Nothing at runtime complains
 * when either reference is dangling: the page still renders, and the control simply
 * does nothing when tapped. That is exactly how the "add transaction" button shipped
 * missing, so both directions are checked here.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const HTML_DIR = path.join(__dirname, '..', 'view', 'html');
const VIEW_DIR = path.join(__dirname, '..', 'view');

/**
 * Discovered, not listed. A hardcoded roster let a whole new page ship with zero
 * coverage: recurring.html was added and every test below still passed because it
 * was simply not in the array.
 */
const PAGES = fs.readdirSync(HTML_DIR).filter((name) => name.endsWith('.html')).sort();

/** The pages that live behind a session; login and the error page do not. */
const PUBLIC_PAGES = new Set(['login.html', '404.html']);

/**
 * Discovered too. Hardcoding this list meant insights.html could be built, routed
 * and then shipped with no assertion that anything about it worked.
 */
const ROUTED_PAGES = PAGES.filter((page) => !PUBLIC_PAGES.has(page));

function serverSource() {
	return fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
}

function readPage(name) {
	return fs.readFileSync(path.join(HTML_DIR, name), 'utf8');
}

/** Script src values are absolute (/assets/js/x.js); map them back to disk. */
function scriptPathFor(src) {
	// /assets/js/dashboard.js -> view/assets/js/dashboard.js
	return path.join(VIEW_DIR, src.replace(/^\/+/, ''));
}

function scriptsOf(html) {
	return [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
}

function globalFunctionsIn(js) {
	return new Set([...js.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]));
}

function inlineHandlerNames(html) {
	const names = new Set();
	for (const m of html.matchAll(/\son(?:click|change|submit|input)="([^"]*)"/g)) {
		const call = m[1].match(/^\s*(\w+)\s*\(/);
		if (call) names.add(call[1]);
	}
	return names;
}

function idsUsedInJs(js) {
	return new Set([...js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)].map((m) => m[1]));
}

function idsPresentInHtml(html) {
	return new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));
}

/** All scripts a page pulls in, concatenated, as loaded by the browser. */
function allScriptsFor(html) {
	return scriptsOf(html)
		.map((src) => fs.readFileSync(scriptPathFor(src), 'utf8'))
		.join('\n');
}

test('every page references only handlers its scripts define', () => {
	for (const page of PAGES) {
		const html = readPage(page);
		const defined = globalFunctionsIn(allScriptsFor(html));
		// App is always exposed by app.js and provides the shared helpers.
		defined.add('App');

		for (const name of inlineHandlerNames(html)) {
			assert.ok(
				defined.has(name),
				`${page} calls ${name}() in markup but no script assigns window.${name}`
			);
		}
	}
});

test('every element id the scripts read exists in the markup', () => {
	// An id the script builds at runtime is exempt only if the same script really
	// does create it. insights.js used to read #simulationError, which it also
	// wrote, so the test could not see the difference between "created later" and
	// "never exists" until the exemption itself became explicit.
	const offenders = [];

	for (const page of PAGES) {
		const html = readPage(page);
		const js = allScriptsFor(html);
		const needed = idsUsedInJs(js);
		const present = idsPresentInHtml(html);

		for (const id of needed) {
			if (present.has(id)) continue;

			const createdAtRuntime = new RegExp(`id=[\\"']${id}[\\"']`).test(js)
				|| new RegExp(`setAttribute\\(\\s*[\\"']id[\\"']\\s*,\\s*[\\"']${id}`).test(js);
			assert.ok(
				createdAtRuntime,
				`${page} scripts read #${id} but nothing in the markup or the script creates it`
			);
		}
	}

	assert.deepEqual(offenders, []);
});

test('handlers a script calls from generated markup are defined', () => {
	// budget.js builds its rows as strings containing onclick="fn(...)". The page
	// renders fine with a dangling name and the button simply does nothing, which
	// is the same silent failure these tests exist to catch.
	const offenders = [];

	for (const page of PAGES) {
		const html = readPage(page);
		const js = allScriptsFor(html);
		const defined = globalFunctionsIn(js);
		defined.add('App');

		// onclick="updateSubName(0, 1, this.value)" inside a template string.
		for (const m of js.matchAll(/onclick=\\?["']\s*(\w+)\s*\(/g)) {
			const name = m[1];
			if (!defined.has(name)) {
				offenders.push(`${page}: generated markup calls ${name}() which no script defines`);
			}
		}
	}

	assert.deepEqual(offenders, []);
});

test('every page pulls only scripts that exist on disk', () => {
	for (const page of PAGES) {
		for (const src of scriptsOf(readPage(page))) {
			assert.ok(
				fs.existsSync(scriptPathFor(src)),
				`${page} loads ${src} but that file is missing`
			);
		}
	}
});

test('the transactions page has a working way to add a transaction', () => {
	// Regression guard: the modal existed with no button wired to it, so the page
	// looked complete but had no way to create anything.
	const html = readPage('transactions.html');
	assert.match(html, /id="addTransactionButton"/, 'add-transaction button is missing');
	assert.match(html, /onclick="openModal\(\)"/, 'add-transaction button is not wired to openModal');
	assert.match(html, /id="transactionModal"/, 'the transaction modal itself is missing');
});

test('pages do not hardcode an origin or a user id', () => {
	// http://localhost:5000 broke every page when opened from a phone.
	const offenders = [];
	for (const page of PAGES) {
		const html = readPage(page);
		const js = allScriptsFor(html);
		// Scripts are checked whole: that is where a request would actually be
		// made. In markup, a literal address inside <code> is an instruction the
		// user copies (a local Ollama URL, for example), not an origin the page
		// will contact, so that text is excluded rather than the check weakened.
		const markup = html.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, '<code></code>');
		for (const [source, text] of [['markup', markup], ['scripts', js]]) {
			if (/https?:\/\/(localhost|127\.0\.0\.1)/.test(text)) {
				offenders.push(`${page} (${source}): hardcoded localhost`);
			}
			if (/\buser123\b|\bdemo\b\s*[:=]\s*['"]user/.test(text)) {
				offenders.push(`${page} (${source}): hardcoded user id`);
			}
		}
	}
	assert.deepEqual(offenders, []);
});

test('pages do not depend on public CDNs', () => {
	// The old pages loaded Tailwind, Font Awesome and Chart.js from CDNs, which
	// rendered unstyled with no charts on a phone without internet.
	const offenders = [];
	for (const page of PAGES) {
		const html = readPage(page);
		for (const m of html.matchAll(/(?:src|href)="https?:\/\/([^/"]+)[^"]*"/g)) {
			offenders.push(`${page}: ${m[1]}`);
		}
	}
	assert.deepEqual(offenders, []);
});
test('every app page is reachable through a route', () => {
	const server = serverSource();
	const routes = [...server.matchAll(/'\/(?:\w+)':\s*'([\w.]+\.html)'/g)].map((m) => m[1]);

	for (const page of ROUTED_PAGES) {
		assert.ok(routes.includes(page), `${page} has no route in server.js`);
	}
});

test('every served page appears in the discovered roster', () => {
	const server = serverSource();
	const routed = [...server.matchAll(/'\/\w+':\s*'([\w.]+\.html)'/g)].map((m) => m[1]);
	for (const page of routed) {
		assert.ok(PAGES.includes(page), `${page} is routed but not checked by these tests`);
	}
});

/* -------------------------------------------------------------------- nav */

/**
 * The navigation had no coverage at all, which is how a build could drop the
 * hamburger from every page and nothing noticed. These check the two properties
 * that matter: the same set of destinations on every page, and every one of them
 * actually routable.
 */

/** Every href the nav points at, across both the bar and the overflow menu. */
function navTargets(html) {
	const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
	if (nav === '') return [];
	return [...nav.matchAll(/class="nav__link"[^>]*href="\/([\w-]+)"/g)].map((m) => m[1]);
}

test('every page carries the same navigation', () => {
	const rosters = new Map();

	for (const page of PAGES) {
		if (PUBLIC_PAGES.has(page)) continue;
		const targets = navTargets(readPage(page));
		assert.ok(targets.length > 0, `${page} has no nav links`);
		rosters.set(page, targets.sort().join(','));
	}

	const distinct = new Set(rosters.values());
	assert.equal(
		distinct.size,
		1,
		`pages disagree about the navigation: ${[...rosters]
			.filter(([, v]) => v !== [...distinct][0])
			.map(([k, v]) => `${k}=[${v}]`)
			.join(' vs ')}`
	);
});

test('every nav destination is a real route', () => {
	const routes = [...serverSource().matchAll(/'\/(\w+)':\s*'[\w.]+\.html'/g)].map((m) => m[1]);

	for (const page of PAGES) {
		if (PUBLIC_PAGES.has(page)) continue;
		for (const target of navTargets(readPage(page))) {
			assert.ok(
				routes.includes(target),
				`${page} links to /${target}, which has no route`
			);
		}
	}
});

test('the overflow menu is a real button, not a hover trick', () => {
	// Hover alone does not exist on a touch screen, so the menu needs a button
	// that opens on click and reports its state.
	for (const page of PAGES) {
		if (PUBLIC_PAGES.has(page)) continue;
		const html = readPage(page);
		assert.match(html, /data-nav-group-toggle/);
		assert.match(html, /aria-expanded="false"/);
		assert.match(html, /aria-haspopup="true"/);
		assert.match(html, /data-nav-group-menu/);
	}
});

test('the hamburger is gone from every page', () => {
	for (const page of PAGES) {
		const html = readPage(page);
		assert.equal(/data-nav-toggle/.test(html), false, `${page} still has the hamburger button`);
		assert.equal(/nav__drawer/.test(html), false, `${page} still has the drawer`);
	}
});

test('the hamburger markup is gone from the script and the stylesheet too', () => {
	// A page with no toggle still loads wireNav, so leaving the old wiring in
	// place would be dead code that reads as if it still works.
	const js = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'js', 'app.js'), 'utf8');
	const css = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'css', 'app.css'), 'utf8');

	assert.equal(/nav-toggle|nav__drawer/.test(js), false);
	assert.equal(/\.nav__drawer|\.nav__toggle/.test(css), false);
});

test('the nav closes its menu on Escape and on an outside click', () => {
	const js = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'js', 'app.js'), 'utf8');

	assert.match(js, /key === 'Escape'/);
	assert.match(js, /menu\.contains\(event\.target\)/);
});

test('a page behind the overflow menu is still marked as current', () => {
	const js = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'js', 'app.js'), 'utf8');

	// Marking only the hidden link would leave the bar showing no indication at
	// all on, say, the settings page.
	assert.match(js, /closest\('\[data-nav-group-menu\]'\)/);
	assert.match(js, /nav__link--contains-current/);
});

/* ------------------------------------------------------------ dead classes */

/**
 * `muted` and `mt-8` were used on four pages before either had a rule in the
 * stylesheet, so both the spacing and the secondary text colour were being
 * dropped, silently, on every page that used them. Nothing rendered badly enough
 * to notice. This walks every class a page applies and reports the ones the
 * stylesheet never defines.
 */

test('every class a page applies is defined in the stylesheet', () => {
	const css = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'css', 'app.css'), 'utf8');

	// Class names that appear as a selector anywhere in the sheet.
	const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

	// The login page keeps its layout in an inline <style> block, so a class it
	// defines itself must count as defined. Reading only app.css called a
	// perfectly styled page unstyled, which is how this check would have been
	// quietly narrowed until it proved nothing.
	for (const page of PAGES) {
		for (const match of readPage(page).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
			for (const sel of match[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(sel[1]);
		}
	}

	// Names that are not styling decisions: hooks for behaviour and testing.
	const IGNORED = new Set([
		// Anything the script keys off, and anything a browser or vendor adds.
		'hide', 'show', 'active', 'open', 'loading', 'error', 'success',
		'is-active', 'is-open', 'is-loading', 'sr-only', 'visually-hidden'
	]);

	const missing = new Map();

	for (const page of PAGES) {
		const html = readPage(page);

		for (const match of html.matchAll(/class="([^"]+)"/g)) {
			for (const name of match[1].split(/\s+/)) {
				if (!name || defined.has(name) || IGNORED.has(name)) continue;
				if (!missing.has(name)) missing.set(name, []);
				missing.get(name).push(page);
			}
		}
	}

	assert.deepEqual(
		[...missing.entries()].map(([name, pages]) => `${name} (${pages.length} pages)`),
		[],
		'classes used in markup but never styled'
	);
});
