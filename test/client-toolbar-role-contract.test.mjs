import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * One role, one author.
 *
 * The heading toolbar holds two buttons - a scan button and a credential
 * button - in the same row. Four separate defects in this plugin had the same
 * shape: a single role whose value had several authors, where the winner was
 * decided by something nobody chose. Here it was stylesheet injection order.
 *
 * These assertions read the role rules directly and hold them to one another,
 * because that is the property that keeps breaking - not any individual value.
 */

const SHARED = new URL('../plugin-src/client/styles.js', import.meta.url);
const styles = await readFile(SHARED, 'utf8');

/** The declaration block of a rule, by an exact selector prefix. */
function block(prefix) {
  const start = styles.indexOf(prefix);
  assert.notEqual(start, -1, prefix + ' keeps its rule');
  const open = styles.indexOf('{', start);
  const close = styles.indexOf('}', open);
  return styles.slice(open + 1, close);
}

test('the heading toolbar gives both of its buttons one padding', () => {
  const scan = block('.dim-panel .bxf-headingTools .dim-scanButton');
  const credential = block('.dim-panel .dim-credentialButton');
  const padding = (body) => (body.match(/padding:\s*([^;]+);/) || [])[1];
  assert.equal(padding(scan), '0 10px', 'the scan button takes the native .sm padding');
  assert.equal(padding(credential), '0 10px', 'and the credential button takes the same');
});

test('no other rule gives the toolbar buttons an inline padding', () => {
  // Three authors had it: the role rules, a container query, and every channel
  // sheet's own button class. Channel sheets inject after the shared one, so a
  // tie on specificity was resolved by load order - the two buttons in one row
  // rendered 8px and 10px, and feishu, the one channel with no override, kept
  // 8px where the other eleven rendered 10px.
  const offenders = [];
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, ' ').trim();
    if (!/dim-scanButton|dim-credentialButton/.test(selector)) continue;
    if (/padding-inline/.test(match[2])) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], 'the role rules are the only author of that padding');
});
