/**
 * Markdown rendering.
 *
 * The advisor replies in Markdown, and the reply is model output, so these tests
 * are as much about safety as about formatting. The renderer is loaded the same
 * way the browser loads it: no DOM, the IIFE and nothing else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Loads app.js the way the browser does and hands back App. */
function loadApp() {
	const source = fs.readFileSync(
		path.join(__dirname, '..', 'view', 'assets', 'js', 'app.js'),
		'utf8'
	);

	const document = {
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener: () => {},
		documentElement: {
			setAttribute: () => {},
			removeAttribute: () => {},
			getAttribute: () => null
		}
	};

	const sandbox = {
		console,
		setTimeout: () => {},
		document,
		localStorage: { getItem: () => null, setItem: () => {} },
		location: { pathname: '/chat', href: 'http://localhost/chat' }
	};
	sandbox.window = sandbox;

	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);

	return sandbox.window.App;
}

/** Only these tags may ever appear live in rendered output. */
const ALLOWED_TAGS = new Set([
	'p', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li',
	'blockquote', 'hr', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
]);

function assertNoLiveMarkup(html, label) {
	for (const match of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
		assert.ok(
			ALLOWED_TAGS.has(match[1].toLowerCase()),
			`${label}: unexpected live <${match[1]}> in ${html}`
		);
	}

	for (const match of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
		assert.equal(
			/\son\w+\s*=/i.test(match[0]),
			false,
			`${label}: event handler survived in ${match[0]}`
		);
		assert.equal(
			/href\s*=\s*["']?\s*(javascript|data|vbscript):/i.test(match[0]),
			false,
			`${label}: unsafe URL scheme in ${match[0]}`
		);
	}
}

const render = loadApp().renderMarkdown;

/* ------------------------------------------------------------------ safety */

test('model output cannot inject markup', () => {
	const attacks = [
		'<img src=x onerror=alert(1)>',
		'<script>alert(1)</script>',
		'<iframe src="//evil.test"></iframe>',
		'<svg/onload=alert(1)>',
		'**bold** <img src=x onerror=alert(1)>',
		'- item\n- <script>alert(1)</script>',
		'> quote with <img src=x onerror=alert(1)>',
		'```\n<img src=x onerror=alert(1)>\n```',
		'# <script>alert(1)</script>',
		'| a | <img src=x onerror=alert(1)> |\n|---|---|\n| 1 | 2 |'
	];

	for (const attack of attacks) {
		assertNoLiveMarkup(render(attack), JSON.stringify(attack));
	}
});

test('only http, https and mailto links survive', () => {
	// Dropped schemes render as their label text, with no anchor at all.
	for (const href of [
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		'  javascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox(1)',
		'file:///etc/passwd'
	]) {
		const html = render(`[label](${href})`);
		assert.equal(/<a\s/.test(html), false, `link was created for ${href}`);
		assertNoLiveMarkup(html, href);
	}

	// Real ones still work, and carry the opener protection.
	const good = render('[docs](https://example.com/x)');
	assert.match(good, /<a href="https:\/\/example\.com\/x"/);
	assert.match(good, /rel="noopener noreferrer"/);
	assert.match(render('[mail](mailto:a@b.test)'), /<a href="mailto:a@b\.test"/);
});

test('a protocol-relative link is refused even though it looks like a path', () => {
	// "//evil.test" starts with a slash but the browser reads it as another host,
	// so it must not become a clickable link.
	for (const href of ['//evil.test/x', '//evil.test', '///evil.test']) {
		const html = render(`[label](${href})`);
		assert.equal(/<a\s/.test(html), false, `link was created for ${href}`);
		assertNoLiveMarkup(html, href);
	}
});

test('the advisor can link to a page in the app', () => {
	const html = render('[ringkasan](/transactions)');
	assert.match(html, /<a href="\/transactions"/);
	// A same-origin link is not a new host, so it does not need a new tab.
	assertNoLiveMarkup(html, 'internal link');
});

test('a URL containing a bracket does not leave stray text behind', () => {
	const html = render('[wiki](https://en.wikipedia.org/wiki/Rp_(currency))');
	assert.match(html, /Rp_\(currency\)/);
	assert.equal(/\)\s*$/.test(html.replace(/<\/a><\/p>$/, '')), false);
});

/* --------------------------------------------------------------- formatting */

test('the common formatting renders', () => {
	assert.match(render('**tebal**'), /<strong>tebal<\/strong>/);
	assert.match(render('*miring*'), /<em>miring<\/em>/);
	assert.match(render('__tebal__'), /<strong>tebal<\/strong>/);
	assert.match(render('`kode`'), /<code>kode<\/code>/);

	// Bold is read before italic, so ** is not two emphasis markers.
	const both = render('**a** dan *b*');
	assert.match(both, /<strong>a<\/strong>/);
	assert.match(both, /<em>b<\/em>/);

	assert.match(render('# Judul'), /<div class="md-h md-h1">Judul<\/div>/);
	assert.match(render('### Kecil'), /md-h3/);
});

test('lists render with the right tag and close correctly', () => {
	const ul = render('- satu\n- dua');
	assert.match(ul, /^<ul class="md-list"><li>satu<\/li><li>dua<\/li><\/ul>$/);

	const ol = render('1. satu\n2. dua');
	assert.match(ol, /^<ol class="md-list"><li>satu<\/li><li>dua<\/li><\/ol>$/);

	// Switching type closes the previous list rather than nesting.
	const mixed = render('- satu\n1. dua');
	assert.match(mixed, /<\/ul><ol/);
});

test('a table keeps its header and every body row', () => {
	const html = render('| Kategori | Jumlah |\n|---|---|\n| Makan | 1.200.000 |\n| Transport | 400.000 |');

	assert.match(html, /<th>Kategori<\/th>/);
	assert.match(html, /<th>Jumlah<\/th>/);
	// This is the regression: the rows were being dropped and an empty tbody
	// rendered, so the reply looked like a table with no data in it.
	assert.match(html, /<td>Makan<\/td>/);
	assert.match(html, /<td>1\.200\.000<\/td>/);
	assert.match(html, /<td>Transport<\/td>/);
	assert.match(html, /<td>400\.000<\/td>/);
	assert.equal(/<tbody>\s*<\/tbody>/.test(html), false, 'tbody must not be empty');
});

test('a stray divider is not treated as a table', () => {
	const html = render('|---|');
	assert.equal(/<table>/.test(html), false);
});

test('code fences stay literal, including their markdown markers', () => {
	const html = render('```js\nconst a = **b**;\n```');
	assert.match(html, /<pre class="md-code">/);
	// Inside a fence nothing is formatted, so the asterisks are literal.
	assert.match(html, /\*\*b\*\*/);
	assert.equal(/<strong>/.test(html), false);
});

test('an unterminated fence still shows its contents', () => {
	const html = render('```\nliteral text');
	assert.match(html, /<pre class="md-code"><code>literal text<\/code><\/pre>/);
});

test('inline code is not formatted either', () => {
	assert.match(render('`**not bold**`'), /<code>\*\*not bold\*\*<\/code>/);
	assert.equal(/<strong>/.test(render('`**not bold**`')), false);
});

test('quotes and rules render', () => {
	assert.match(render('> kutipan'), /<blockquote>kutipan<\/blockquote>/);
	assert.match(render('---'), /<hr class="md-rule">/);
});

test('a reply is never empty, whatever comes in', () => {
	assert.equal(typeof render(''), 'string');
	assert.equal(typeof render(null), 'string');
	assert.equal(typeof render(undefined), 'string');
	assert.equal(render(''), '');
});

test('a realistic advisor reply renders in full', () => {
	const reply = [
		'## Rekomendasi',
		'',
		'Berdasarkan data, **belum advisable** untuk sekarang.',
		'',
		'Alasannya:',
		'',
		'1. Pengeluaran bulan ini 3,1 juta (**92%** dari penghasilan)',
		'2. Dana darurat belum mencapai target 6 bulan',
		'',
		'> Angka ini dari data bulan ini, bukan perkiraan.',
		'',
		'| Langkah | Dampak |\n|---|---|\n| Tunda 1 minggu | Rp 150.000 |\n| Skip 2 langganan | Rp 300.000 |',
		'',
		'Catatan: lihat `Rp 2.000.000` di [ringkasan](/transactions).'
	].join('\n');

	const html = render(reply);
	assertNoLiveMarkup(html, 'realistic reply');
	assert.match(html, /md-h2/);
	assert.match(html, /<strong>belum advisable<\/strong>/);
	assert.match(html, /<ol class="md-list">/);
	assert.match(html, /<blockquote>/);
	assert.match(html, /<td>Rp 150\.000<\/td>/);
	assert.match(html, /<code>Rp 2\.000\.000<\/code>/);
	assert.match(html, /<a href="\/transactions"/);
});