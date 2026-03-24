/**
 * recorder.mjs — Record user interactions and export as scenario JSON
 *
 * Opens a browser with injected listeners that capture clicks, scrolls,
 * and typing, then generates a scenario JSON with CSS selectors.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The JS to inject into the page.
 * Captures click, scroll, and input events with unique CSS selectors.
 */
const INJECTED_SCRIPT = `
(function() {
  if (window.__ghostPilotRecorder) return;
  window.__ghostPilotRecorder = { steps: [], recording: true };
  const rec = window.__ghostPilotRecorder;

  // ── Unique selector generator ──────────────────────────────────
  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';

    // 1. ID (if unique on page)
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 2. data-testid
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) {
      const sel = '[data-testid="' + testId + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 3. Tag + unique class combination
    const tag = el.tagName.toLowerCase();
    if (el.classList.length > 0) {
      const classes = Array.from(el.classList)
        .filter(c => !c.startsWith('__') && c.length < 60)
        .map(c => '.' + CSS.escape(c))
        .join('');
      if (classes) {
        const sel = tag + classes;
        try {
          if (document.querySelectorAll(sel).length === 1) return sel;
        } catch {}
      }
    }

    // 4. Aria labels
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const sel = tag + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
    }

    // 5. Text content for buttons/links (short text only)
    if (['button', 'a', 'span'].includes(tag)) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length < 40) {
        // Use xpath-style text selector via :has() or manual
        // Fallback: build parent path
      }
    }

    // 6. nth-child path (fallback)
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let seg = current.tagName.toLowerCase();
      if (current.id) {
        seg = '#' + CSS.escape(current.id);
        path.unshift(seg);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          seg += ':nth-of-type(' + idx + ')';
        }
      }
      // Add a class if available for readability
      if (current.classList.length > 0) {
        const cls = Array.from(current.classList)
          .filter(c => !c.startsWith('__') && c.length < 40)
          .slice(0, 2)
          .map(c => '.' + CSS.escape(c))
          .join('');
        if (cls) seg += cls;
      }
      path.unshift(seg);
      current = parent;
    }
    return path.join(' > ');
  }

  function getLabel(el) {
    // Try aria-label, title, textContent
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const title = el.getAttribute('title');
    if (title) return title;
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length < 60) return text;
    const tag = el.tagName.toLowerCase();
    const cls = el.className ? '.' + el.className.split(/\\s+/)[0] : '';
    return tag + cls;
  }

  // ── Click listener ─────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!rec.recording) return;
    const selector = getSelector(e.target);
    const label = getLabel(e.target);
    rec.steps.push({
      action: 'click',
      selector,
      label: 'Click: ' + label.substring(0, 50),
      _timestamp: Date.now(),
    });
    console.log('[ghost-pilot] click:', selector);
  }, true);

  // ── Scroll listener (debounced) ────────────────────────────────
  let scrollTimer = null;
  let scrollAccum = 0;
  window.addEventListener('scroll', () => {
    if (!rec.recording) return;
    scrollAccum += 1;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      rec.steps.push({
        action: 'scroll',
        delta: -Math.round(scrollAccum / 2),
        label: 'Scroll page',
        _timestamp: Date.now(),
      });
      console.log('[ghost-pilot] scroll delta:', -scrollAccum);
      scrollAccum = 0;
    }, 300);
  }, true);

  // ── Input listener (debounced per element) ─────────────────────
  const inputTimers = new WeakMap();
  document.addEventListener('input', (e) => {
    if (!rec.recording) return;
    const el = e.target;
    clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(() => {
      const selector = getSelector(el);
      rec.steps.push({
        action: 'type',
        selector,
        text: el.value,
        label: 'Type: ' + (el.value || '').substring(0, 30),
        _timestamp: Date.now(),
      });
      console.log('[ghost-pilot] type:', selector, el.value);
    }, 500));
  }, true);

  // ── Visual feedback ────────────────────────────────────────────
  const badge = document.createElement('div');
  badge.id = '__ghostPilotBadge';
  badge.innerHTML = '🛩️ ghost-pilot recording — <b>press Ctrl+Shift+S to stop</b>';
  badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;background:rgba(220,40,40,0.9);color:#fff;padding:6px 14px;border-radius:8px;font:12px/1.4 -apple-system,sans-serif;pointer-events:none;backdrop-filter:blur(4px);';
  document.body.appendChild(badge);

  // Step counter
  const counter = document.createElement('div');
  counter.id = '__ghostPilotCounter';
  counter.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999;background:rgba(0,0,0,0.7);color:#fff;padding:4px 10px;border-radius:6px;font:11px/1.4 monospace;pointer-events:none;';
  document.body.appendChild(counter);
  setInterval(() => {
    counter.textContent = rec.steps.length + ' steps recorded';
  }, 200);

  console.log('[ghost-pilot] 🔴 Recording started. Interact with the page.');
})();
`;

/**
 * Start recording user interactions.
 * @param {object} opts - { url, output, viewport }
 */
export async function startRecording(opts = {}) {
  const {
    url,
    output = 'scenario.json',
    viewport = { width: 1440, height: 900 },
  } = opts;

  console.log(`\n🛩️  ghost-pilot record`);
  console.log(`   URL: ${url}`);
  console.log(`   Output: ${output}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--window-position=0,0',
      `--window-size=${viewport.width},${viewport.height}`,
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  // Track navigation
  const navigations = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && navigations.length > 0) {
      // Record navigation as a step (will be merged later)
      navigations.push(frame.url());
    }
  });

  // Navigate
  console.log(`📄 Loading ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  navigations.push(url);

  // Inject recorder script
  await page.evaluate(INJECTED_SCRIPT);
  console.log(`🔴 Recording started. Interact with the page.`);
  console.log(`   Press Ctrl+C in terminal to stop and save.\n`);

  // Re-inject on navigation
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      try {
        await sleep(500);
        await page.evaluate(INJECTED_SCRIPT);
      } catch {}
    }
  });

  // Wait for Ctrl+C
  await new Promise((resolve) => {
    process.on('SIGINT', async () => {
      console.log(`\n⏹  Stopping recording...`);

      // Extract steps from page
      let steps = [];
      try {
        steps = await page.evaluate(() => window.__ghostPilotRecorder?.steps || []);
      } catch {
        console.log('   ⚠️  Could not extract steps from page (might have navigated).');
      }

      // Clean up internal timestamps, add delays
      const cleanSteps = [];
      for (let i = 0; i < steps.length; i++) {
        const step = { ...steps[i] };
        const nextTs = steps[i + 1]?._timestamp;
        const delay = nextTs ? Math.min(2000, Math.max(300, nextTs - step._timestamp)) : 800;
        delete step._timestamp;
        step.delay = delay;
        cleanSteps.push(step);
      }

      // Build scenario
      const scenario = {
        name: `Recorded: ${new URL(url).hostname}`,
        url,
        viewport,
        waitForLoad: 'body',
        initialDelay: 1500,
        endDelay: 2000,
        steps: cleanSteps,
      };

      // Save
      writeFileSync(output, JSON.stringify(scenario, null, 2));
      console.log(`\n💾 Saved ${cleanSteps.length} steps → ${output}`);

      await browser.close();
      resolve();
    });
  });
}
