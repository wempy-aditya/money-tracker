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

const PAGES = ['index.html', 'home.html', 'transactions.html', 'budget.html', 'goals.html', 'login.html'];

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
	for (const page of PAGES) {
		const html = readPage(page);
		const needed = idsUsedInJs(allScriptsFor(html));
		const present = idsPresentInHtml(html);

		// Ids the script creates at runtime (containers it fills in) are exempt
		// only when the script also declares them; anything else must exist.
		for (const id of needed) {
			assert.ok(
				present.has(id),
				`${page} scripts read #${id} but the markup has no such element`
			);
		}
	}
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
		for (const [source, text] of [['markup', html], ['scripts', js]]) {
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