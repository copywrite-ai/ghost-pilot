/**
 * orchestrator.mjs — Core engine: Playwright orchestration + real mouse automation
 */

import { chromium } from 'playwright';
import { getBrowserChrome, toScreenCoords } from './coordinate.mjs';
import * as mouse from './mouse.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a scenario.
 * @param {object} scenario - Parsed scenario JSON
 * @param {object} opts - { speed, verbose }
 */
export async function runScenario(scenario, opts = {}) {
  const { speed = 1.0, verbose = true } = opts;

  if (verbose) console.log(`\n🛩️  ghost-pilot — ${scenario.name}`);
  if (verbose) console.log(`   URL: ${scenario.url}`);
  if (verbose) console.log(`   Steps: ${scenario.steps.length}\n`);

  // Launch browser (visible — required for screen recording)
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--window-position=0,0',
      `--window-size=${scenario.viewport?.width || 1440},${scenario.viewport?.height || 900}`,
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const context = await browser.newContext({
    viewport: {
      width: scenario.viewport?.width || 1440,
      height: scenario.viewport?.height || 900,
    },
    // No user agent override — keep it real
  });

  const page = await context.newPage();

  try {
    // Navigate
    if (verbose) console.log(`📄 Loading ${scenario.url}...`);
    await page.goto(scenario.url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for initial load if specified
    if (scenario.waitForLoad) {
      if (verbose) console.log(`⏳ Waiting for: ${scenario.waitForLoad}`);
      await page.waitForSelector(scenario.waitForLoad, { state: 'visible', timeout: 15000 });
    }

    // Initial settle delay
    await sleep(scenario.initialDelay || 1000);

    // Get browser chrome dimensions once
    let chrome = await getBrowserChrome(page);
    if (verbose) {
      console.log(`🖥️  Browser chrome: top=${chrome.chromeTop}px left=${chrome.chromeLeft}px`);
      console.log(`   Window: (${chrome.windowX}, ${chrome.windowY})\n`);
    }

    // Execute steps
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const label = step.label || `Step ${i + 1}`;
      const moveDuration = Math.round((step.duration || 800) / speed);
      const postDelay = Math.round((step.delay || 500) / speed);

      if (verbose) console.log(`  [${i + 1}/${scenario.steps.length}] ${label}`);

      // Wait for target element if specified
      const selector = step.waitFor || step.selector;
      if (selector) {
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
        } catch {
          console.error(`  ⚠️  Timeout waiting for: ${selector} — skipping step`);
          continue;
        }
      }

      // Refresh chrome offset (in case browser was resized/moved)
      chrome = await getBrowserChrome(page);

      switch (step.action) {
        case 'click': {
          const el = await page.$(step.selector);
          if (!el) {
            console.error(`  ⚠️  Element not found: ${step.selector} — skipping`);
            continue;
          }
          const box = await el.boundingBox();
          if (!box) {
            console.error(`  ⚠️  Element not visible: ${step.selector} — skipping`);
            continue;
          }
          const pos = toScreenCoords(chrome, box);
          if (verbose) console.log(`     → click at (${pos.x}, ${pos.y})`);
          mouse.moveAndClick(pos.x, pos.y, { duration: moveDuration });
          break;
        }

        case 'hover': {
          const el = await page.$(step.selector);
          if (!el) continue;
          const box = await el.boundingBox();
          if (!box) continue;
          const pos = toScreenCoords(chrome, box);
          if (verbose) console.log(`     → hover at (${pos.x}, ${pos.y})`);
          mouse.move(pos.x, pos.y, { duration: moveDuration });
          break;
        }

        case 'scroll': {
          // Use Playwright's mouse.wheel — CGEvent scroll doesn't reach Chromium.
          // Scroll doesn't involve cursor movement, so recordings look the same.
          const delta = step.delta || -3;
          const totalPixels = delta * 40;  // negative delta = scroll down = positive deltaY

          if (verbose) console.log(`     → scroll ${totalPixels}px`);

          // Smooth scroll: emit multiple small wheel events
          const scrollSteps = 10;
          const perStep = Math.round(-totalPixels / scrollSteps); // wheel deltaY: positive = down
          for (let s = 0; s < scrollSteps; s++) {
            await page.mouse.wheel(0, perStep);
            await sleep(40);
          }
          break;
        }

        case 'type': {
          // Click the input first, then type
          if (step.selector) {
            const el = await page.$(step.selector);
            if (el) {
              const box = await el.boundingBox();
              if (box) {
                const pos = toScreenCoords(chrome, box);
                mouse.moveAndClick(pos.x, pos.y, { duration: moveDuration });
                await sleep(300);
              }
            }
          }
          if (step.text) {
            mouse.type(step.text, { delay: step.typeDelay || 60 });
          }
          break;
        }

        case 'wait': {
          const waitMs = step.ms || 1000;
          if (verbose) console.log(`     → wait ${waitMs}ms`);
          await sleep(waitMs);
          break;
        }

        case 'navigate': {
          if (verbose) console.log(`     → navigate to ${step.url}`);
          await page.goto(step.url, { waitUntil: 'networkidle', timeout: 30000 });
          break;
        }

        default:
          console.error(`  ⚠️  Unknown action: ${step.action}`);
      }

      // Post-step delay
      await sleep(postDelay);
    }

    if (verbose) console.log(`\n✅ Scenario complete: ${scenario.name}\n`);

    // Keep browser open briefly so recording captures final state
    await sleep(scenario.endDelay || 2000);

  } finally {
    await browser.close();
  }
}

/**
 * Get current mouse position in screen coords (for scrolling at current pos).
 */
async function getCurrentMouseScreenPos(page, chrome) {
  // Fallback: center of viewport
  const vp = page.viewportSize();
  return [
    chrome.windowX + chrome.chromeLeft + (vp?.width || 720) / 2,
    chrome.windowY + chrome.chromeTop + (vp?.height || 450) / 2,
  ];
}
