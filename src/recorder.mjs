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

  // ── Mouse move listener (~120Hz sampling) ──────────────────────
  let lastMoveTime = 0;
  const MOVE_INTERVAL = 8; // ~120Hz for smooth trajectory
  let moveBatch = [];
  let moveFlushTimer = null;

  function flushMoves() {
    if (moveBatch.length === 0) return;
    pushStep({
      action: 'moves',
      points: moveBatch.slice(),
      _timestamp: moveBatch[moveBatch.length - 1].t,
    });
    moveBatch = [];
  }

  document.addEventListener('mousemove', (e) => {
    if (!rec.recording) return;
    const now = Date.now();
    if (now - lastMoveTime < MOVE_INTERVAL) return;
    lastMoveTime = now;

    moveBatch.push({
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      t: now,
    });

    // Flush every 20 points (~160ms worth)
    clearTimeout(moveFlushTimer);
    if (moveBatch.length >= 20) {
      flushMoves();
    } else {
      moveFlushTimer = setTimeout(flushMoves, 100);
    }
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

  // ── Visual feedback + Stop button ──────────────────────────────
  const badge = document.createElement('div');
  badge.id = '__ghostPilotBadge';
  badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;display:flex;align-items:center;gap:8px;background:rgba(30,30,30,0.92);color:#fff;padding:6px 10px 6px 14px;border-radius:10px;font:12px/1.4 -apple-system,sans-serif;pointer-events:auto;backdrop-filter:blur(8px);box-shadow:0 2px 12px rgba(0,0,0,0.3);';\

  const indicator = document.createElement('span');
  indicator.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#ff3b30;animation:__gp_pulse 1.5s ease infinite;';
  badge.appendChild(indicator);

  const timeLabel = document.createElement('span');
  timeLabel.textContent = '00:00';
  timeLabel.style.cssText = 'font-variant-numeric:tabular-nums;min-width:36px;';
  badge.appendChild(timeLabel);

  // Separator
  const sep1 = document.createElement('span');
  sep1.textContent = '·';
  sep1.style.cssText = 'opacity:0.4;';
  badge.appendChild(sep1);

  const fpsLabel = document.createElement('span');
  fpsLabel.textContent = '0 fps';
  fpsLabel.style.cssText = 'font-variant-numeric:tabular-nums;min-width:40px;color:#8e8e93;';
  badge.appendChild(fpsLabel);

  const sep2 = document.createElement('span');
  sep2.textContent = '·';
  sep2.style.cssText = 'opacity:0.4;';
  badge.appendChild(sep2);

  const stepsLabel = document.createElement('span');
  stepsLabel.textContent = '0 steps';
  stepsLabel.style.cssText = 'font-variant-numeric:tabular-nums;color:#8e8e93;';
  badge.appendChild(stepsLabel);

  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'Stop';
  stopBtn.style.cssText = 'background:#ff3b30;color:#fff;border:none;border-radius:6px;padding:3px 12px;font:12px/1.4 -apple-system,sans-serif;cursor:pointer;font-weight:600;margin-left:4px;';
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    rec.recording = false;
    timeLabel.textContent = 'Stopping...';
    indicator.style.background = '#34c759';
    stopBtn.disabled = true;
    stopBtn.style.opacity = '0.5';
    if (typeof flushMoves === 'function') flushMoves();
    if (window.__ghostPilotStop) window.__ghostPilotStop();
  });
  badge.appendChild(stopBtn);
  document.body.appendChild(badge);

  // Pulse animation
  const style = document.createElement('style');
  style.textContent = '@keyframes __gp_pulse{0%,100%{opacity:1}50%{opacity:0.3}}';
  document.head.appendChild(style);

  // ── Timer + FPS tracker ──────────────────────────────────────
  const recStart = Date.now();
  const mouseTimes = [];

  document.addEventListener('mousemove', () => {
    mouseTimes.push(Date.now());
  }, true);

  setInterval(() => {
    // Elapsed time
    const elapsed = Math.floor((Date.now() - recStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    timeLabel.textContent = mm + ':' + ss;

    // Mouse FPS (events in last 1s)
    const now = Date.now();
    while (mouseTimes.length && mouseTimes[0] < now - 1000) mouseTimes.shift();
    fpsLabel.textContent = mouseTimes.length + ' fps';

    // Steps
    stepsLabel.textContent = rec.stepCount + ' steps';
  }, 250);

  console.log('[ghost-pilot] Recording started. Interact with the page.');
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
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const context = await browser.newContext({ viewport: null }); // null = use full window size
  const page = await context.newPage();

  // Maximize window via CDP (fill screen, keep title bar + Dock)
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'maximized' },
    });
    await sleep(500); // wait for transition
  } catch (err) {
    console.error('  ⚠️  Could not fullscreen browser:', err.message);
  }

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
  console.log(`   Click the Stop button (top-right) to save.\n`);

  // Re-inject on navigation (exposeFunction persists across navigations)
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      try {
        await sleep(500);
        await page.evaluate(INJECTED_SCRIPT);
      } catch {}
    }
  });

  // Wait for stop (via Cmd+Option+C in browser or Ctrl+C in terminal)
  await new Promise((resolve) => {
    let stopping = false;
    const cleanup = async () => {
      if (stopping) return;
      stopping = true;
      console.log(`\n\n\u23f9  Stopping recording...`);

      // Steps are already in Node.js memory \u2014 no need to extract from page!

      // Clean up timestamps, compute delays
      const cleanSteps = [];
      for (let i = 0; i < steps.length; i++) {
        const step = { ...steps[i] };
        const nextTs = steps[i + 1]?._timestamp;
        // For moves, use actual gap (can be 0). For other actions, min 300ms.
        const minDelay = step.action === 'moves' ? 0 : 300;
        const delay = nextTs ? Math.min(2000, Math.max(minDelay, nextTs - step._timestamp)) : 800;
        delete step._timestamp;
        step.delay = delay;
        cleanSteps.push(step);
      }

      // Get actual viewport from fullscreen browser
      const actualViewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      })).catch(() => viewport);

      // Build scenario
      const scenario = {
        name: `Recorded: ${new URL(url).hostname}`,
        url,
        viewport: actualViewport,
        waitForLoad: 'body',
        initialDelay: 1500,
        endDelay: 2000,
        steps: cleanSteps,
      };

      // Save
      writeFileSync(output, JSON.stringify(scenario, null, 2));
      console.log(`\ud83d\udcbe Saved ${cleanSteps.length} steps \u2192 ${output}`);

      try {
        await browser.close();
      } catch {}

      resolve();
    };

    // Expose stop function to browser (for Cmd+Option+C)
    page.exposeFunction('__ghostPilotStop', cleanup).catch(() => {});

    // Also support Ctrl+C in terminal
    process.on('SIGINT', cleanup);
  });
}
