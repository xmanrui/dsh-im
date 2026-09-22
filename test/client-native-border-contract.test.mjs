import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';

/**
 * The client bundle ships its styles as template literals rather than .css
 * files, so the hairline contract the native stylesheets are held to has to be
 * asserted against the same text the browser receives.
 *
 * Mirrors packages/client/ui-theme/tests/elevation-styles.client.spec.ts, which
 * draws every solid neutral-token border under packages/ at 0.5px and forbids
 * pairing an elevation shadow with a neutral border. Buttons, inputs, cards and
 * separators share the hairline weight; dashed affordances, state-colored
 * borders and spinner ring tracks are out of scope.
 */

const CLIENT_DIR = new URL('../plugin-src/', import.meta.url);

/** Neutral border tokens; the state palette stays out of scope. */
const NEUTRAL_BORDER = /--dsw-alias-border-/;
/** Shadow-token references that mark a rule as an elevated surface. */
const ELEVATED_SHADOW = /--dsw-(?:shadow-lv|elevation-)/;
/** Border properties that carry a width in their shorthand. */
const BORDER_EDGE = /^border(?:-top|-bottom|-left|-right)?$/;
/** A spinner's border is the drawn graphic, not an outline. */
const RING_TRACK = /spinner/i;

/** Every .js file under plugin-src, as absolute paths. */
async function clientSources(dir = CLIENT_DIR) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) out.push(...(await clientSources(child)));
    else if (entry.name.endsWith('.js')) out.push(child);
  }
  return out;
}

/**
 * The CSS the module contributes: the bodies of its template literals. A module
 * that carries no template literal (plain JS) contributes nothing.
 * @param source - module text.
 * @returns the concatenated CSS.
 */
function cssOf(source) {
  const bodies = [];
  const literal = /`([^`\\]|\\.)*`/gs;
  for (const match of source.matchAll(literal)) bodies.push(match[0].slice(1, -1));
  return bodies.join('\n');
}

/**
 * Flat `selector { declarations }` rules. At-rules are skipped: their inner
 * rules are matched on their own.
 * @param css - stylesheet text.
 * @returns the parsed rules.
 */
/**
 * CSS comments carry prose, not rules. Dropping them before parsing keeps a
 * comment that sits above a rule from being read as part of its selector.
 * @param css - stylesheet text.
 * @returns the same text without comments.
 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseRules(css) {
  const rules = [];
  const block = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(block)) {
    const selectors = match[1].split(',').map(s => s.trim()).filter(Boolean);
    if (!selectors.length || selectors.some(s => s.startsWith('@'))) continue;
    const declarations = match[2].split(';')
      .map(d => d.trim())
      .filter(Boolean)
      .map((d) => {
        const colon = d.indexOf(':');
        return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
      })
      .filter(([property]) => property);
    rules.push({ selectors, declarations });
  }
  return rules;
}

/** Load every client rule once; the assertions below all read from it. */
const rules = [];
for (const file of await clientSources()) {
  const css = stripComments(cssOf(await readFile(file, 'utf8')));
  if (!css) continue;
  const name = basename(file.pathname);
  for (const rule of parseRules(css)) rules.push({ file: name, ...rule });
}

test('every solid neutral-token border is drawn at the native 0.5px hairline', () => {
  const wide = [];
  for (const rule of rules) {
    const selectors = rule.selectors.join(', ');
    if (RING_TRACK.test(selectors)) continue;
    for (const [property, value] of rule.declarations) {
      if (!BORDER_EDGE.test(property)) continue;
      if (!value.includes('solid') || !NEUTRAL_BORDER.test(value)) continue;
      if (value.startsWith('0.5px ')) continue;
      wide.push(`${rule.file} ${selectors} ${property}: ${value}`);
    }
  }
  assert.deepEqual(wide, []);
});

test('every filled divider line is drawn at the native 0.5px hairline', () => {
  const wide = [];
  for (const rule of rules) {
    const paintsLine = rule.declarations.some(([property, value]) =>
      (property === 'background' || property === 'background-color') && NEUTRAL_BORDER.test(value));
    if (!paintsLine) continue;
    for (const [property, value] of rule.declarations) {
      if ((property === 'height' || property === 'width') && value === '1px') {
        wide.push(`${rule.file} ${rule.selectors.join(', ')} ${property}: ${value}`);
      }
    }
  }
  assert.deepEqual(wide, []);
});

test('no rule pairs an elevation shadow with a neutral border', () => {
  // An elevated surface draws its hairline inside the shadow: a border beside it
  // double-draws the outline and shifts layout by the border width.
  const paired = [];
  for (const rule of rules) {
    const elevated = rule.declarations.some(([property, value]) =>
      property === 'box-shadow' && ELEVATED_SHADOW.test(value));
    if (!elevated) continue;
    for (const [property, value] of rule.declarations) {
      if (!property.startsWith('border') || property.startsWith('border-radius')) continue;
      if (!NEUTRAL_BORDER.test(value)) continue;
      paired.push(`${rule.file} ${rule.selectors.join(', ')} ${property}: ${value}`);
    }
  }
  assert.deepEqual(paired, []);
});

/**
 * The host splits the translucent menu material into a fill token and a blur token
 * - design-platform.css:245 gives --dsw-specific-menu as rgba(248, 249, 250, 0.58)
 * and gradient-shadow-text.css:20 gives --dsw-menu-backdrop-filter as
 * blur(40px) saturate(150%) - and pairs them in one rule
 * (ui-primitives/src/Menu.module.css:17-18). docs/web-styling.md:25 states the
 * pairing as a rule; ui-theme/tests/elevation-styles.client.spec.ts enforces it over
 * the host's own packages. A fill without the blur is simply see-through, which is
 * what this plugin's portaled model list looked like. This is that predicate over
 * the plugin's sheets.
 *
 * A surface holding fixed-position descendants is the one exception, and it moves
 * the pair onto an isolated background pseudo-element instead of dropping the blur:
 * backdrop-filter would otherwise become those descendants' containing block.
 */
test('a translucent menu fill always carries the shared backdrop filter', () => {
  const MENU_FILL = /var\(--dsw-specific-menu[,)]/;
  const MENU_FILTER = /var\(--dsw-menu-backdrop-filter[,)]/;
  const missing = [];
  for (const rule of rules) {
    const filled = rule.declarations.some(([property, value]) =>
      (property === 'background' || property === 'background-color') && MENU_FILL.test(value));
    if (!filled) continue;
    const blurred = rule.declarations.some(([property, value]) =>
      property === 'backdrop-filter' && MENU_FILTER.test(value));
    if (!blurred) missing.push(rule.file + ' ' + rule.selectors.join(', '));
  }
  assert.deepEqual(missing, []);
});

test('the shared account chevron renders the vendored native glyph', async () => {
  // A CSS-drawn chevron (borders + rotate) is the one place the page still
  // invented an icon shape the native set already provides.
  const source = await readFile(
    new URL('client/channels/shared/collapsible-account.js', CLIENT_DIR), 'utf8');
  assert.match(source, /ChevronRightGlyph/);
  const css = cssOf(await readFile(new URL('client/styles.js', CLIENT_DIR), 'utf8'));
  const rule = parseRules(css).find(r => r.selectors.includes('.dim-collapsibleChevron'));
  assert.ok(rule, 'the chevron slot keeps its class');
  for (const [property] of rule.declarations) {
    assert.ok(
      !property.startsWith('border'),
      `the chevron slot draws no border of its own (found ${property})`,
    );
  }
});
test('the plugin token layer is declared on body, where the host publishes --dsw-*', () => {
  // Two constraints, and only body satisfies both. The layer cannot live on
  // .dim-page: five surfaces portal to <body>, outside that subtree, and would
  // see no token at all. It cannot live on :root either: a custom property is
  // substituted on the element that declares it, and the host publishes --dsw-*
  // on <body>, not on <html>, so every alias declared on :root substitutes
  // against a missing token and freezes to its literal fallback.
  //
  // Measured while it was on :root: --dim-field-border resolved to
  // rgb(0 0 0 / 16%), its fallback, while the host token was #00000029, and
  // redefining the host token on body changed nothing. Light mode still looked
  // correct because the fallbacks match the light values, which is why reading
  // the source did not catch it.
  const declaring = rules.filter(rule =>
    rule.declarations.some(([property]) => property.startsWith('--dim-')));
  assert.deepEqual(
    declaring.map(rule => rule.selectors.join(', ')),
    ['body'],
    "the --dim-* layer is declared once, on body",
  );
  const tokens = declaring[0].declarations
    .filter(([property]) => property.startsWith('--dim-'));
  assert.ok(
    tokens.length > 40,
    "the single declaring rule is the token layer",
  );
});
