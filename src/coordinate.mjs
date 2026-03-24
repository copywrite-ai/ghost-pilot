/**
 * coordinate.mjs — Convert Playwright viewport coords to macOS screen coords
 */

/**
 * Get browser chrome dimensions by evaluating in page context.
 * Returns { chromeTop, chromeLeft } — the pixel offset from window edge to viewport.
 */
export async function getBrowserChrome(page) {
  const dims = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));

  return {
    windowX: dims.screenX,
    windowY: dims.screenY,
    chromeTop: dims.outerHeight - dims.innerHeight,
    chromeLeft: Math.round((dims.outerWidth - dims.innerWidth) / 2),
  };
}

/**
 * Convert element center to macOS screen coordinates.
 * @param {object} chrome - { windowX, windowY, chromeTop, chromeLeft }
 * @param {object} box - Playwright boundingBox { x, y, width, height }
 * @returns {{ x: number, y: number }} screen coordinates
 */
export function toScreenCoords(chrome, box) {
  return {
    x: Math.round(chrome.windowX + chrome.chromeLeft + box.x + box.width / 2),
    y: Math.round(chrome.windowY + chrome.chromeTop + box.y + box.height / 2),
  };
}
