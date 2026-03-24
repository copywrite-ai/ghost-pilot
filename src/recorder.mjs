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

  // ── Helpers ────────────────────────────────────────────────────
  const INTERACTIVE_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'label', 'details', 'summary'];
  const INLINE_TAGS = ['span', 'svg', 'path', 'img', 'i', 'em', 'strong', 'b', 'small', 'use', 'circle', 'rect', 'line'];

  // Filter out CSS hash classes (e.g. css-1p3hq3p, ant-xxx-hash)
  function isStableClass(c) {
    if (c.startsWith('__')) return false;
    if (c.length > 50) return false;
    // CSS-in-JS hashes: css-XXXXX, e.g. css-1p3hq3p
    if (/^css-[a-z0-9]{4,}$/i.test(c)) return false;
    // Random hash suffixes: ant-space-css-var-xxx
    if (/[a-f0-9]{6,}$/i.test(c) && c.includes('-')) return false;
    return true;
  }

  // Bubble from inline element to nearest interactive parent
  function getInteractiveTarget(el) {
    let current = el;
    const tag = current.tagName.toLowerCase();
    // If it's an inline child of an interactive element, walk up
    if (INLINE_TAGS.includes(tag)) {
      const interactive = current.closest(INTERACTIVE_TAGS.map(t => t).join(','));
      if (interactive) return interactive;
    }
    // Also check if parent is interactive (e.g. span inside button)
    if (current.parentElement) {
      const parentTag = current.parentElement.tagName.toLowerCase();
      if (INTERACTIVE_TAGS.includes(parentTag)) return current.parentElement;
    }
    return current;
  }

  // ── Unique selector generator ──────────────────────────────────
  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';

    // 1. ID (if unique and not dynamic)
    if (el.id && !/^[0-9]/.test(el.id) && !el.id.includes(':')) {
      const sel = '#' + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
    }

    // 2. data-testid / data-test / data-cy
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = '[' + attr + '="' + val + '"]';
        try {
          if (document.querySelectorAll(sel).length === 1) return sel;
        } catch {}
      }
    }

    // 3. Tag + stable class combination (no CSS hashes)
    const tag = el.tagName.toLowerCase();
    if (el.classList.length > 0) {
      const stableClasses = Array.from(el.classList).filter(isStableClass);
      if (stableClasses.length > 0) {
        const classes = stableClasses.map(c => '.' + CSS.escape(c)).join('');
        const sel = tag + classes;
        try {
          if (document.querySelectorAll(sel).length === 1) return sel;
        } catch {}
        // Try with just the most specific class
        for (const c of stableClasses) {
          const sel2 = tag + '.' + CSS.escape(c);
          try {
            if (document.querySelectorAll(sel2).length === 1) return sel2;
          } catch {}
        }
      }
    }

    // 4. Aria labels
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length < 80) {
      const sel = tag + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
    }

    // 5. Text content for interactive elements (short text only)
    if (INTERACTIVE_TAGS.includes(tag)) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length < 30) {
        // Use Playwright text selector format
        const sel = tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
        // Can't verify in plain CSS, but it works in Playwright
      }
    }

    // 6. nth-child path (fallback) — skip CSS hash classes
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let seg = current.tagName.toLowerCase();
      if (current.id && !/^[0-9]/.test(current.id) && !current.id.includes(':')) {
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
      // Add stable classes only
      if (current.classList.length > 0) {
        const stableCls = Array.from(current.classList)
          .filter(isStableClass)
          .slice(0, 2)
          .map(c => '.' + CSS.escape(c))
          .join('');
        if (stableCls) seg += stableCls;
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
    return el.tagName.toLowerCase();
  }

  // ── Push step to Node.js (real-time sync) ──────────────────────
  function pushStep(step) {
    rec.stepCount++;
    if (window.__ghostPilotPushStep) {
      window.__ghostPilotPushStep(JSON.stringify(step));
    }
  }

  // ── Click listener — bubble to interactive element ─────────────
  document.addEventListener('click', (e) => {
    if (!rec.recording) return;
    if (e.target.closest('#__ghostPilotBadge, #__ghostPilotCounter')) return;
    const target = getInteractiveTarget(e.target);
    const selector = getSelector(target);
    const label = getLabel(target);
    pushStep({
      action: 'click',
      selector,
      label: 'Click: ' + label.substring(0, 50),
      _timestamp: Date.now(),
    });
    console.log('[ghost-pilot] click:', selector, '(' + label.substring(0, 30) + ')');
  }, true);

  // ── Scroll listener — track actual pixel delta ─────────────────
  let scrollTimer = null;
  let scrollStartY = window.scrollY;
  let scrolling = false;
  window.addEventListener('scroll', () => {
    if (!rec.recording) return;
    if (!scrolling) {
      scrollStartY = window.scrollY - (window.scrollY - scrollStartY); // capture start
      scrolling = true;
      scrollStartY = window.scrollY;
    }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const pixelsDelta = window.scrollY - scrollStartY;
      if (Math.abs(pixelsDelta) > 5) {
        pushStep({
          action: 'scroll',
          pixels: pixelsDelta,  // actual pixels scrolled (positive = down)
          label: 'Scroll ' + (pixelsDelta > 0 ? 'down' : 'up') + ' ' + Math.abs(pixelsDelta) + 'px',
          _timestamp: Date.now(),
        });
        console.log('[ghost-pilot] scroll:', pixelsDelta + 'px');
      }
      scrollStartY = window.scrollY;
      scrolling = false;
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
