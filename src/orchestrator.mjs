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

      // Refresh chrome offset (skip for moves — too slow for high-frequency replay)
      if (step.action !== 'moves') {
        chrome = await getBrowserChrome(page);
      }

      switch (step.action) {
        case 'moves': {
          // Merge this and all consecutive moves steps into one batch
          let allPoints = [...(step.points || [])];
          while (i + 1 < scenario.steps.length && scenario.steps[i + 1].action === 'moves') {
            i++;
            const nextStep = scenario.steps[i];
            // Add a gap point between batches using the delay
            const gap = (nextStep.delay || 0) / speed;
            if (gap > 0 && allPoints.length > 0) {
              // Insert a pause by adding delay to the last point
              // (the gap was the delay between the previous moves and this one)
            }
            allPoints.push(...(nextStep.points || []));
          }

          if (allPoints.length === 0) break;

          if (verbose) console.log(`     → replay ${allPoints.length} mouse positions (merged)`);

          // Convert viewport coords to screen coords and compute delays
          const screenPoints = allPoints.map((pt, idx) => {
            const delay = idx < allPoints.length - 1
              ? Math.max(0, Math.min(200, (allPoints[idx + 1].t - pt.t) / speed))
              : 0;
            return {
              x: chrome.windowX + chrome.chromeLeft + pt.x,
              y: chrome.windowY + chrome.chromeTop + pt.y,
              delay,
            };
          });

          mouse.batchMove(screenPoints);
          break;
        }

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

          // Check if previous step was a movement — cursor is already near target
          const prevStep = i > 0 ? scenario.steps[i - 1] : null;
          if (prevStep && prevStep.action === 'moves') {
            // Just click at the element position (cursor should be close)
            if (verbose) console.log(`     → click at (${pos.x}, ${pos.y})`);
            mouse.moveAndClick(pos.x, pos.y, { duration: 100, steps: 5 });
          } else {
            // No recorded movement before this — do a smooth move
            if (verbose) console.log(`     → move+click at (${pos.x}, ${pos.y})`);
            mouse.moveAndClick(pos.x, pos.y, { duration: moveDuration });
          }
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
          // Support both new `pixels` field and legacy `delta` field
          let totalPixels;
          if (step.pixels != null) {
            totalPixels = step.pixels;  // new format: actual pixel value
          } else {
            totalPixels = (step.delta || -3) * 40;  // legacy: line-based delta
          }

          if (verbose) console.log(`     → scroll ${totalPixels}px`);

          // Smooth scroll: emit multiple small wheel events
          const scrollSteps = Math.max(5, Math.round(Math.abs(totalPixels) / 60));
          const perStep = Math.round(totalPixels / scrollSteps);
          for (let s = 0; s < scrollSteps; s++) {
            await page.mouse.wheel(0, perStep);
            await sleep(30);
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

      // Post-step delay (skip for moves — timing is embedded in the points)
      if (step.action !== 'moves') {
        await sleep(postDelay);
      } else if (postDelay > 50) {
        // Only apply delay between moves if there's a real gap (e.g. user paused)
        await sleep(Math.min(postDelay, 100));
      }
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
