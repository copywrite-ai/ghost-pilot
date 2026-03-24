/**
 * recorder.mjs — Record user interactions and export as scenario JSON
 *
 * Opens a browser with injected listeners that capture clicks, scrolls,
 * and typing. Steps are synced to Node.js in real-time via exposeFunction,
 * so they survive even if the page navigates or the browser closes.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The JS to inject into the page.
 * Captures click, scroll, and input events with unique CSS selectors.
 * Sends each step to Node.js via __ghostPilotPushStep (exposed function).
 */
const INJECTED_SCRIPT = `
(function() {
  if (window.__ghostPilotRecorder) return;
  window.__ghostPilotRecorder = { recording: true, stepCount: 0 };
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

    // 5. nth-child path (fallback)
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
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const title = el.getAttribute('title');
    if (title) return title;
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length < 60) return text;
    const tag = el.tagName.toLowerCase();
    return tag;
  }

  // ── Push step to Node.js (real-time sync) ──────────────────────
  function pushStep(step) {
    rec.stepCount++;
    if (window.__ghostPilotPushStep) {
      window.__ghostPilotPushStep(JSON.stringify(step));
    }
  }

  // ── Click listener ─────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!rec.recording) return;
    // Ignore our own UI elements
    if (e.target.closest('#__ghostPilotBadge, #__ghostPilotCounter')) return;
    const selector = getSelector(e.target);
    const label = getLabel(e.target);
    pushStep({
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
      pushStep({
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
      pushStep({
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
  badge.innerHTML = '🛩️ ghost-pilot recording — <b>Ctrl+C in terminal to stop</b>';
  badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;background:rgba(220,40,40,0.9);color:#fff;padding:6px 14px;border-radius:8px;font:12px/1.4 -apple-system,sans-serif;pointer-events:none;backdrop-filter:blur(4px);';
  document.body.appendChild(badge);

  const counter = document.createElement('div');
  counter.id = '__ghostPilotCounter';
  counter.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999;background:rgba(0,0,0,0.7);color:#fff;padding:4px 10px;border-radius:6px;font:11px/1.4 monospace;pointer-events:none;';
  document.body.appendChild(counter);
  setInterval(() => {
    counter.textContent = rec.stepCount + ' steps recorded';
  }, 200);

  console.log('[ghost-pilot] 🔴 Recording started. Interact with the page.');
})();
`;

/**
 * Start recording user interactions.
 * Steps are synced to Node.js in real-time via exposeFunction,
 * so Ctrl+C always saves all captured steps.
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

  // ── Steps buffer (lives in Node.js, not in the browser) ────────
  const steps = [];

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

  // Expose function BEFORE navigation so it's available immediately
  await page.exposeFunction('__ghostPilotPushStep', (stepJson) => {
    try {
      const step = JSON.parse(stepJson);
      steps.push(step);
      process.stderr.write(`\r   📝 ${steps.length} steps captured`);
    } catch {}
  });

  // Navigate
  console.log(`📄 Loading ${url}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  // Inject recorder script
  await page.evaluate(INJECTED_SCRIPT);
  console.log(`🔴 Recording started. Interact with the page.`);
  console.log(`   Press Ctrl+C in terminal to stop and save.\n`);

  // Re-inject on navigation (exposeFunction persists across navigations)
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
    const cleanup = async () => {
      console.log(`\n\n⏹  Stopping recording...`);

      // Steps are already in Node.js memory — no need to extract from page!

      // Clean up timestamps, compute delays
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
      console.log(`💾 Saved ${cleanSteps.length} steps → ${output}`);

      try {
        await browser.close();
      } catch {}

      resolve();
    };

    process.on('SIGINT', cleanup);
  });
}
