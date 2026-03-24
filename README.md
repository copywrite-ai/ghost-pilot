# 🛩️ ghost-pilot

**Playwright orchestration × real OS-level mouse events — web automation built for screen recording.**

ghost-pilot solves a unique problem: automating interactions on real websites while producing **natural-looking mouse movements** visible to screen recording software. Unlike pure browser automation (Playwright/Puppeteer) which uses synthetic events invisible to screen recorders, ghost-pilot moves the actual OS cursor using macOS CGEvent API.

## How It Works

```
Playwright (orchestration)          ghost-mouse-driver (real mouse)
┌─────────────────────────┐        ┌──────────────────────────┐
│ 1. Open URL             │        │                          │
│ 2. Wait for elements    │──────►│ 4. Smooth CGEvent move   │
│ 3. Get screen coords    │        │ 5. Real OS click         │
│ 6. Verify result        │◄──────│                          │
└─────────────────────────┘        └──────────────────────────┘
```

## Quick Start

```bash
# 1. Build the mouse driver
cd mouse-driver && swift build -c release
cp .build/release/ghost-mouse-driver ../ghost-mouse-driver-bin
cd ..

# 2. Install dependencies
npm install
npx playwright install chromium

# 3. Run a scenario
node bin/ghost-pilot.mjs run scenarios/antdv-button.json
```

## Scenario Format

```json
{
  "name": "My Demo",
  "url": "https://example.com",
  "viewport": { "width": 1440, "height": 900 },
  "waitForLoad": ".main-content",
  "steps": [
    { "action": "click", "selector": ".btn-primary", "label": "Click button" },
    { "action": "scroll", "delta": -3, "label": "Scroll down" },
    { "action": "type", "selector": "#search", "text": "hello", "label": "Type in search" },
    { "action": "hover", "selector": ".menu-item", "label": "Hover menu" },
    { "action": "wait", "ms": 1000, "label": "Pause" },
    { "action": "navigate", "url": "https://example.com/page2", "label": "Go to page 2" }
  ]
}
```

## Supported Actions

| Action | Description |
|--------|-------------|
| `click` | Move to element and click |
| `hover` | Move to element without clicking |
| `scroll` | Scroll by delta lines (negative = down) |
| `type` | Click input then type text |
| `wait` | Pause for N milliseconds |
| `navigate` | Go to a different URL |

## Requirements

- macOS 12+ (uses CGEvent API)
- Swift 5.9+
- Node.js 18+
- Accessibility permissions for terminal (System Settings → Privacy → Accessibility)

## Architecture

- **`bin/ghost-pilot.mjs`** — CLI entry point
- **`src/orchestrator.mjs`** — Playwright + mouse driver coordination
- **`src/mouse.mjs`** — Node.js → Swift binary bridge
- **`src/coordinate.mjs`** — Viewport → screen coordinate conversion
- **`mouse-driver/`** — Swift CGEvent binary (move, click, scroll, type, record, replay)
