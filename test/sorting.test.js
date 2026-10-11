/**
 * Wallets: what kind they are, and the list controls that reorder every page.
 *
 * Both features are presentation, so most of the risk is not in the happy path.
 * It is in a wallet that predates the feature, a kind nobody recognises, or a
 * sort that reorders the array the page still holds a reference to.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const VIEW_DIR = path.join(PROJECT_ROOT, 'view');

// The sort helper and the wallet kinds live in app.js, which is an IIFE that
// assigns window.App. It is loaded the way the browser loads it rather than
// required, because that is the only way to reach what it actually exports.
// Elements a test wants the app to find are registered here before it boots.
const registry = new Map();

/** Put a stand-in for an element into the document app.js will search. */
function register(id, element) {
  registry.set(id, element);
}

function loadApp() {
  const fs = require('node:fs');
  const vm = require('node:vm');

  const source = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'js', 'app.js'), 'utf8');

  const window = { location: { pathname: '/home', href: 'http://localhost/home' } };

  // Enough of the DOM for app.js to boot: it reads the saved theme, wires the
  // nav and registers a click handler, all before it exports anything.
  const element = () => ({
    style: {},
    dataset: {},
    setAttribute: () => {},
    removeAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => {},
    addEventListener: () => {}
  });

  const document = {
    readyState: 'complete',
    getElementById: (id) => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: element,
    body: element(),
    documentElement: element()
  };

  window.localStorage = { getItem: () => null, setItem: () => {} };

  const sandbox = { window, document, console, setTimeout, Math, Date, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return window.App;
}

const App = loadApp();

/* ------------------------------------------------------------------- kinds */

test('every wallet kind has a label and an icon', () => {
  const kinds = Object.keys(App.WALLET_KINDS);

  assert.ok(kinds.length >= 5, 'expected several kinds, got ' + kinds.length);

  for (const key of kinds) {
    const entry = App.WALLET_KINDS[key];
    assert.ok(entry.label, key + ' has no label');
    assert.ok(entry.icon, key + ' has no icon');
  }
});

test('the icons are real drawings, not empty placeholders', () => {
  // An icon that renders as nothing is worse than no icon, because the tag then
  // claims to be showing something.
  const seen = new Set();

  for (const key of Object.keys(App.WALLET_KINDS)) {
    const svg = App.walletIcon(key);

    assert.match(svg, /^<svg\b/, key + ' did not produce an svg');
    assert.match(svg, /<\/svg>$/, key + ' left the svg unclosed');
    assert.match(svg, /viewBox="0 0 24 24"/, key + ' is not on the shared grid');
    // Decorative by default: the word beside it is the accessible name.
    assert.match(svg, /aria-hidden="true"/, key + ' is exposed to a screen reader twice');

    const body = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    assert.ok(body.trim().length > 20, key + ' has an empty body');
    assert.ok(!body.includes('undefined'), key + ' produced an undefined in its path data');

    seen.add(body);
  }

  assert.equal(seen.size, Object.keys(App.WALLET_KINDS).length, 'two kinds share an icon');
});

test('an unknown kind falls back to "other" instead of rendering nothing', () => {
  // Every wallet created before the feature existed arrives with no kind.
  assert.equal(App.walletKindLabel(undefined), App.WALLET_KINDS.other.label);
  assert.equal(App.walletKindLabel('crypto'), App.WALLET_KINDS.other.label);
  assert.equal(App.walletKindLabel(''), App.WALLET_KINDS.other.label);

  const svg = App.walletIcon('crypto');
  assert.match(svg, /^<svg\b/);
  assert.ok(!svg.includes('undefined'));
});

test('a wallet tag shows the icon and the word together', () => {
  const tag = App.walletKindTag('bank');

  assert.match(tag, /kind-tag/);
  assert.match(tag, /<svg\b/);
  assert.ok(tag.includes(App.WALLET_KINDS.bank.label));
});

test('a tag built from an unknown kind never carries that value through', () => {
  // The kind is validated on the server, so nothing hostile should reach the
  // page. The tag is built by string concatenation anyway, and the key it looks
  // up must never be interpolated into the markup.
  const tag = App.walletKindTag('<img src=x onerror=alert(1)>');

  assert.ok(!tag.includes('<img'), 'the unknown key was written into the markup');
  assert.ok(!tag.includes('onerror'));
  assert.ok(tag.includes(App.WALLET_KINDS.other.label));
});

/* --------------------------------------------------------------- sorting */

/**
 * A control needs two selects. The stand-in reports its value and records the
 * listeners it is given, so a test can do what a person does: pick a field,
 * then pick a direction.
 */
function makeSelect(value) {
  return {
    value: value || '',
    disabled: false,
    innerHTML: '',
    listeners: {},

    addEventListener(event, handler) {
      (this.listeners[event] = this.listeners[event] || []).push(handler);
    },

    /** Stand in for the browser firing an event on this element. */
    fire(event) {
      (this.listeners[event] || []).forEach((handler) => handler());
    },

    /** The names a person sees in the menu. */
    labels() {
      return [...this.innerHTML.matchAll(/>([^<>]+)</g)].map((m) => m[1]);
    }
  };
}

/** Build a working control over two stand-in selects. */
function makeControl(overrides) {
  const select = makeSelect();
  const direction = makeSelect('desc');

  // app.js looks these up by id, so they have to exist in the document it sees.
  registry.set('sortBy', select);
  registry.set('sortDir', direction);

  const control = App.createSortControl(Object.assign({
    // The same ids the five pages use, so a rename in the markup breaks here.
    selectId: 'sortBy',
    directionId: 'sortDir',
    fields: [
      // Names read A to Z; an amount reads largest first. The helper uses these
      // to decide which way a field reads the first time it is chosen.
      { value: 'name', label: 'Nama', get: (row) => row.name, defaultDirection: 'asc' },
      { value: 'amount', label: 'Jumlah', get: (row) => row.amount, defaultDirection: 'desc' }
    ]
  }, overrides));

  return { select, direction, control };
}

const ROWS = [
  { name: 'Kas', amount: 300 },
  { name: 'Bank utama', amount: 100 },
  { name: 'Investasi', amount: 200 }
];

test('no field chosen means the list is left in the order it arrived', () => {
  const { select, control } = makeControl();

  assert.equal(control.state.key, '');
  assert.deepEqual(control.apply(ROWS), ROWS);
  // Guard against a comparator that happens to leave this particular array alone.
  assert.deepEqual(control.apply(ROWS).map((r) => r.name), ['Kas', 'Bank utama', 'Investasi']);

  assert.ok(select.labels().includes('Urutkan') || select.labels().includes('Urutkan'));
});

test('the field menu names every sortable field', () => {
  const { select } = makeControl();

  const labels = select.labels();
  assert.ok(labels.includes('Nama'), 'missing Nama: ' + labels);
  assert.ok(labels.includes('Jumlah'), 'missing Jumlah: ' + labels);
});

test('choosing a field sorts ascending, and the direction select says so', () => {
  const { select, direction, control } = makeControl();

  select.value = 'name';
  select.fire('change');

  assert.equal(control.state.key, 'name');
  assert.deepEqual(control.apply(ROWS).map((r) => r.name), ['Bank utama', 'Investasi', 'Kas']);

  // A field chosen without touching the direction gets the useful default: for
  // a name, A to Z is what someone means by "sort by name".
  assert.equal(direction.disabled, false);
});

test('the same field sorted the other way gives the reverse', () => {
  const { select, direction, control } = makeControl();

  // An amount reads largest first on its own, so both directions have to be
  // asked for explicitly here rather than one being inferred.
  select.value = 'amount';
  select.fire('change');
  assert.deepEqual(control.apply(ROWS).map((r) => r.amount), [300, 200, 100]);

  direction.value = 'asc';
  direction.fire('change');
  assert.deepEqual(control.apply(ROWS).map((r) => r.amount), [100, 200, 300]);
});

test('a field reads in its own way the first time it is chosen', () => {
  // Choosing "name" then "amount" and going back to "name" must give A to Z
  // again, not whatever direction amount was left at.
  const { select, direction, control } = makeControl();

  select.value = 'name';
  select.fire('change');
  assert.deepEqual(control.apply(ROWS).map((r) => r.name), ['Bank utama', 'Investasi', 'Kas']);

  select.value = 'amount';
  select.fire('change');
  assert.deepEqual(control.apply(ROWS).map((r) => r.amount), [300, 200, 100]);

  direction.value = 'asc';
  direction.fire('change');

  select.value = 'name';
  select.fire('change');
  assert.deepEqual(control.apply(ROWS).map((r) => r.name), ['Bank utama', 'Investasi', 'Kas']);
});

test('numbers sort as numbers, not as text', () => {
  // The bug this catches: "1000" < "900" as strings, so the biggest balance in
  // the list would appear second.
  const rows = [
    { name: 'a', amount: 1000 },
    { name: 'b', amount: 900 },
    { name: 'c', amount: 90 }
  ];

  const { select, direction, control } = makeControl();

  select.value = 'amount';
  select.fire('change');
  direction.value = 'asc';
  direction.fire('change');

  assert.deepEqual(control.apply(rows).map((r) => r.amount), [90, 900, 1000]);
});

test('a name that starts with a number sorts by that number, not by letter', () => {
  // Wallet names are the common case. Sorting these as plain characters puts
  // "10 Kas" between "1 Dana" and "2 Bank", because '1' sorts before '2' but
  // '1' also sorts before the '0' that follows it.
  const rows = [
    { name: '10 Kas', amount: 1 },
    { name: '2 Bank', amount: 2 },
    { name: '1 Dana', amount: 3 }
  ];

  const { select, control } = makeControl();

  select.value = 'name';
  select.fire('change');

  // Names default to A to Z, which is the direction this checks.
  assert.deepEqual(control.apply(rows).map((r) => r.name), ['1 Dana', '2 Bank', '10 Kas']);
});

test('the list handed in is not reordered underneath the caller', () => {
  const { select, control } = makeControl();
  const rows = [{ name: 'b', amount: 2 }, { name: 'a', amount: 1 }];

  select.value = 'name';
  select.fire('change');
  control.apply(rows);

  assert.deepEqual(rows.map((r) => r.name), ['b', 'a'], 'sort() mutated the caller\'s array');
});

test('a missing value sorts to the end instead of throwing', () => {
  const rows = [
    { name: 'b', amount: 2 },
    { amount: 1 },
    { name: null, amount: 3 }
  ];

  const { select, control } = makeControl();

  select.value = 'name';
  select.fire('change');

  const sorted = control.apply(rows);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[0].name, 'b');
});

test('the direction select stays disabled until a field is chosen', () => {
  // Offering a direction that does nothing is a control that lies.
  const { select, direction, control } = makeControl();

  assert.equal(direction.disabled, true);

  select.value = 'name';
  select.fire('change');
  assert.equal(direction.disabled, false);

  select.value = '';
  select.fire('change');
  assert.equal(direction.disabled, true);
  assert.deepEqual(control.apply(ROWS), ROWS);
});

test('reset puts the list back and tells the controls about it', () => {
  const { select, direction, control } = makeControl();

  select.value = 'amount';
  select.fire('change');
  direction.value = 'desc';
  direction.fire('change');

  control.reset();

  assert.equal(control.state.key, '');
  assert.equal(select.value, '');
  assert.equal(direction.disabled, true);
  assert.deepEqual(control.apply(ROWS), ROWS);
});

test('a control with no matching elements in the page is a no-op, not a crash', () => {
  // Every page script runs the same code; one of them not having the markup yet
  // must not take the others down.
  const control = App.createSortControl({ selectId: 'nope', directionId: 'alsoNope', fields: [] });

  assert.equal(control, null);
});

test('one page failing to sort does not stop the others', () => {
  const seen = [];

  App.on('sort:changed', () => {
    seen.push('first');
    throw new Error('this page is broken');
  });
  App.on('sort:changed', () => seen.push('second'));

  App.emit('sort:changed');

  assert.deepEqual(seen, ['first', 'second']);
});

/* ------------------------------------------------------------------ pages */

/**
 * Each of the five pages declares the same control. This walks them so a page
 * cannot quietly lose its sort, which is what happens when someone edits one
 * template and the other four are never looked at.
 */
const SORT_PAGES = [
  { file: 'transactions.html', script: 'transactions.js' },
  { file: 'budget.html', script: 'budget.js' },
  // The wallet page is served at /wallet but its file is index.html, so the
  // script is not named after it.
  { file: 'index.html', script: 'wallets.js' },
  { file: 'goals.html', script: 'goals.js' },
  { file: 'recurring.html', script: 'recurring.js' }
];

for (const page of SORT_PAGES) {
  test(page.file + ' offers both sort controls', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(path.join(VIEW_DIR, 'html', page.file), 'utf8');

    // Match the whole tag, not just up to the first quote, so a check on an
    // attribute actually looks inside the tag rather than at the next line.
    const tagFor = (id) => {
      const match = html.match(new RegExp('<select[^>]*id="' + id + '"[^>]*>'));
      return match ? match[0] : null;
    };

    assert.ok(tagFor(page.selectId || 'sortBy'), page.file + ' has no <select id="' + page.selectId || 'sortBy' + '">');
    assert.ok(tagFor(page.directionId || 'sortDir'), page.file + ' has no <select id="' + page.directionId || 'sortDir' + '">');

    // The direction control must start disabled, or it offers a choice before
    // there is a field to apply it to.
    assert.match(
      tagFor(page.directionId || 'sortDir'),
      /\bdisabled\b/,
      page.file + ': the direction select is not disabled on load'
    );
  });

  test(page.file + ' wires its sort control to a list', () => {
    const fs = require('node:fs');
    const script = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'js', page.script), 'utf8');

    assert.match(
      script,
      /createSortControl/,
      page.file + ': the markup has a sort control that nothing drives'
    );
  });
}

/* ------------------------------------------------------- balanced markup */

/**
 * Every list in this app is built by string concatenation. An unbalanced tag
 * there does not throw: the browser repairs it by hoisting the stray element out
 * of its parent. The page still renders, still contains every value, and every
 * text check still passes. What changes is the width, because the hoisted
 * element loses its parent's padding and sizing.
 *
 * The wallet card hit exactly that. A card 369px wide was drawing its three
 * rupiah readouts into a 93px strip, one character per line, and no test could
 * see it: every amount was present in the DOM.
 */
const RENDER_SCRIPTS = [
  'transactions.js',
  'budget.js',
  'goals.js',
  'wallets.js',
  'recurring.js'
];

const TAG_NAMES = 'div|section|article|table|tbody|thead|tr|td|th|form|label|ul|ol|li|span|p|h[1-6]';

/**
 * A card is written as a run of string literals joined with +, one line per line
 * of markup, so an opening tag and its close land in different literals.
 * Counting inside a single literal measures nothing.
 *
 * Walk the file line by line instead, tracking how many tags are open. A run
 * ends when the count returns to zero on a line that closes a statement. The
 * last fragment is kept even if it never balances, so the test can report the
 * imbalance rather than quietly skipping it.
 */
function markupBlocks(source) {
  const blocks = [];
  const lines = source.split('\n');

  let run = [];
  let depth = 0;

  for (const line of lines) {
    if (!/[<>]/.test(line)) {
      if (depth > 0) run.push(line);
      continue;
    }

    run.push(line);

    for (const literal of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
      for (const tag of literal[1].matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
        const [, closing, , rest] = tag;
        // A tag that ends in "/>" opens nothing.
        if (closing) depth--;
        else if (!rest.trimEnd().endsWith('/')) depth++;
      }
    }

    if (depth <= 0 && /;\s*$/.test(line)) {
      if (run.some((l) => /<div|<tr|<td|<form|<table/.test(l))) blocks.push(run.join('\n'));
      run = [];
      depth = 0;
    }
  }

  if (run.length && run.some((l) => /<div|<tr|<td|<form|<table/.test(l))) {
    blocks.push(run.join('\n'));
  }

  return blocks;
}

function assertBalanced(html, where) {
  // Attribute values are stripped: a title may legally contain a "<".
  const stripped = html.replace(/="[^"]*"/g, '=""');

  const open = (stripped.match(new RegExp('<(' + TAG_NAMES + ')\\b', 'g')) || []).length;
  const close = (stripped.match(new RegExp('</(' + TAG_NAMES + ')>', 'g')) || []).length;

  assert.equal(open, close, where + ': ' + open + ' open vs ' + close + ' close');
}

for (const script of RENDER_SCRIPTS) {
  test(script + ' builds balanced markup', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(path.join(VIEW_DIR, 'assets', 'js', script), 'utf8');

    const blocks = markupBlocks(source);
    assert.ok(blocks.length > 0, script + ': found no markup to check');

    blocks.forEach((block, index) => {
      assertBalanced(block, script + ' block ' + (index + 1));
    });
  });
}

test('a row whose text field is empty sorts last, not first', () => {
  // An empty string is not null, so the "no value goes last" rule missed it.
  // Sorted ascending by category, every transaction saved without one landed
  // above the real categories, because "" precedes everything in a text sort.
  const { select, control } = makeControl();

  select.value = 'name';
  select.fire('change');

  const rows = [
    { name: 'Makan', amount: 100 },
    { name: '', amount: 200 },
    { name: 'Baju', amount: 300 },
    { name: '', amount: 400 }
  ];

  const names = control.apply(rows).map((row) => row.name);

  assert.deepEqual(names, ['Baju', 'Makan', '', ''], 'empty names belong at the end, not the top');
});

test('empty text sorts last in descending too', () => {
  const { select, direction, control } = makeControl();

  select.value = 'name';
  select.fire('change');
  direction.value = 'desc';
  direction.fire('change');

  const rows = [
    { name: 'Makan', amount: 100 },
    { name: '', amount: 200 },
    { name: 'Baju', amount: 300 }
  ];

  assert.deepEqual(control.apply(rows).map((row) => row.name), ['Makan', 'Baju', '']);
});

test('a zero amount is a real value and stays in place', () => {
  // Only an empty text counts as missing. A wallet with Rp0 frozen has to sort
  // by that zero rather than being pushed past every row that has one.
  const { select, control } = makeControl();

  select.value = 'amount';
  select.fire('change');

  const rows = [
    { name: 'A', amount: 500 },
    { name: 'B', amount: 0 },
    { name: 'C', amount: 100 }
  ];

  assert.deepEqual(control.apply(rows).map((row) => row.amount), [500, 100, 0]);
});
