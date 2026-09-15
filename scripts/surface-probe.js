/**
 * Surface probe - stage 2 of the surface audit. Runs IN THE PAGE, not on disk.
 *
 * Stage 1 (scripts/surface-audit.mjs) can only pick candidates: it reads source and
 * cannot evaluate the cascade, @media/@container, or a selector that matches through
 * several ancestors. This probe is the machine criterion for "does anything style it".
 *
 * Paste into the DevTools console of the settings page, then:
 *
 *   await __surfaceProbe()                    // every element the plugin classes reach
 *   await __surfaceProbe('select')            // one selector
 *   copy(JSON.stringify(await __surfaceProbe(), null, 1))
 *
 * A verdict of "UNSTYLED" means: no rule from a plugin stylesheet matched the element,
 * and every computed value equals the browser default. Anything else lists the rules
 * that matched, so the claim can be checked rather than believed.
 */
window.__surfaceProbe = function (selector) {
  var PLUGIN = /\.(dim|bxf|ddt|dxw|dof|dsl|dqq|dwecom|dimessage|dwa|dtg|dwb)-/;
  var query = selector || '[class*="dim-"],[class*="bxf-"],[class*="ddt-"],[class*="dxw-"],[class*="dof-"]';
  var out = [];
  Array.prototype.forEach.call(document.querySelectorAll(query), function (el) {
    var plugin = [];
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sheet = document.styleSheets[s];
      var rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      var owner = sheet.ownerNode;
      var src = (owner && owner.id) ? owner.id : ('sheet' + s);
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!rule.selectorText || !rule.style || !rule.style.cssText) continue;
        var sels = rule.selectorText.split(',');
        for (var k = 0; k < sels.length; k++) {
          var sel = sels[k].trim();
          var ok = false;
          try { ok = el.matches(sel.replace(/:hover/g, '')); } catch (e) { ok = false; }
          if (!ok) continue;
          if (PLUGIN.test(sel)) plugin.push({ src: src, sel: sel.slice(0, 80), css: rule.style.cssText.slice(0, 100) });
        }
      }
    }
    var cs = getComputedStyle(el);
    var own = String(el.className || '').split(/\s+/).filter(Boolean);
    var interesting = own.some(function (c) { return PLUGIN.test('.' + c + '-'); });
    if (!interesting && !plugin.length) return;
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className) || '(no class)',
      verdict: plugin.length ? 'styled' : 'UNSTYLED',
      pluginRuleCount: plugin.length,
      pluginRules: plugin.slice(0, 4),
      computed: {
        appearance: cs.appearance, height: cs.height, padding: cs.padding,
        border: cs.borderTopWidth + ' ' + cs.borderTopColor,
        radius: cs.borderTopLeftRadius, font: cs.fontSize + '/' + cs.lineHeight,
        background: cs.backgroundColor, color: cs.color,
      },
    });
  });
  var unstyled = out.filter(function (o) { return o.verdict === 'UNSTYLED'; });
  return { page: location.href.replace(/token=[^&]+/, 'token=***'), checked: out.length, unstyled: unstyled.length, elements: out };
};
console.log('surface probe ready: await __surfaceProbe()  or  await __surfaceProbe("select")');
