/**
 * mouse.mjs — Bridge to ghost-mouse-driver Swift binary
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DRIVER_PATH = resolve(__dirname, '..', 'ghost-mouse-driver-bin');

let driverPath = DEFAULT_DRIVER_PATH;

/**
 * Set custom path to the mouse driver binary.
 */
export function setDriverPath(path) {
  driverPath = path;
}

function ensureDriver() {
  if (!existsSync(driverPath)) {
    throw new Error(
      `Mouse driver not found at: ${driverPath}\n` +
      `Build it first: cd mouse-driver && swift build -c release && cp .build/release/ghost-mouse-driver ../ghost-mouse-driver-bin`
    );
  }
}

function exec(args) {
  ensureDriver();
  try {
    execFileSync(driverPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  } catch (err) {
    console.error(`[mouse] Command failed:`, args.join(' '));
    throw err;
  }
}

/**
 * Smoothly move to (x,y) and click.
 */
export function moveAndClick(x, y, opts = {}) {
  const args = ['move-click', '--x', String(x), '--y', String(y)];
  if (opts.duration) args.push('--duration', String(opts.duration));
  if (opts.steps) args.push('--steps', String(opts.steps));
  exec(args);
}

/**
 * Smoothly move to (x,y) without clicking.
 */
export function move(x, y, opts = {}) {
  const args = ['move', '--x', String(x), '--y', String(y)];
  if (opts.duration != null) args.push('--duration', String(opts.duration));
  if (opts.steps != null) args.push('--steps', String(opts.steps));
  exec(args);
}

/**
 * Replay a batch of mouse positions in one process call.
 * @param {Array<{x: number, y: number, delay: number}>} points
 */
export function batchMove(points) {
  ensureDriver();
  const json = JSON.stringify(points);
  try {
    execSync(`echo '${json.replace(/'/g, "'\\''")}' | "${driverPath}" batch-move`, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: true,
    });
  } catch (err) {
    console.error('[mouse] batch-move failed');
    throw err;
  }
}

/**
 * Click at (x,y) instantly.
 */
export function click(x, y) {
  exec(['click', '--x', String(x), '--y', String(y)]);
}

/**
 * Scroll at (x,y).
 * @param {number} delta - negative = scroll down, positive = scroll up
 */
export function scroll(x, y, delta) {
  exec(['scroll', '--x', String(x), '--y', String(y), '--delta', String(delta)]);
}

/**
 * Smooth pixel-based scroll at (x,y) — mimics trackpad gesture.
 * @param {number} pixels - total pixels (negative = down)
 * @param {object} opts - { duration, steps }
 */
export function smoothScroll(x, y, pixels, opts = {}) {
  const args = ['smooth-scroll', '--x', String(x), '--y', String(y), '--pixels', String(pixels)];
  if (opts.duration) args.push('--duration', String(opts.duration));
  if (opts.steps) args.push('--steps', String(opts.steps));
  exec(args);
}

/**
 * Type text using keyboard events.
 */
export function type(text, opts = {}) {
  const args = ['type', '--text', text];
  if (opts.delay) args.push('--delay', String(opts.delay));
  exec(args);
}

/**
 * Get screen dimensions.
 * @returns {{ width: number, height: number }}
 */
export function getScreenInfo() {
  ensureDriver();
  const output = execFileSync(driverPath, ['screen-info'], { encoding: 'utf-8' });
  return JSON.parse(output.trim());
}
