# Syncroll: Split View Sync Scroller

A Chrome extension that synchronizes scrolling between two tabs in Chrome's native Split View. Open two pages side-by-side, click sync, and they scroll together.

Landing page: [syncroll.jubayeramb.com](https://syncroll.jubayeramb.com/)

## What it does

When Chrome's Split View places two tabs side-by-side, this extension keeps them scroll-synced. It works across three types of pages:

- **Normal websites** — Scroll position syncs by percentage, so pages of different lengths stay aligned.
- **Chat UIs (ChatGPT, Gemini)** — These apps scroll inside an inner `<div>`, not the window. The extension detects the scrollable container automatically.
- **Canvas apps (Figma, Miro, Excalidraw)** — These render via WebGL with no DOM scrolling. The extension relays raw wheel deltas and dispatches synthetic wheel events on the target canvas.

Any combination works: a normal website on the left and Figma on the right, ChatGPT on both sides, etc.

## Install (Developer Mode)

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome (v145+)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon appears in the toolbar

## How to use

1. Open two tabs in Chrome's Split View (right-click a tab → "Split view" or drag a tab to the side)
2. Click the extension icon in the toolbar
3. The popup shows both detected panes
4. Click **Sync Split Panes**
5. Scroll either side — the other follows

To stop syncing, click the extension icon again and click **Stop Syncing**.

### Pane Detection

The extension finds your two Split View tabs using three strategies (in order):

1. **`splitViewId`** (Chrome 145+) — Native Split View identifier shared by both panes
2. **Highlighted tabs** — Both visible panes are highlighted in the tab strip
3. **Adjacent tab index** — Falls back to the tab immediately next to the active one

## Supported page types

| Page Type | Examples | Sync Method |
|---|---|---|
| Standard websites | Wikipedia, MDN, news sites | Proportional scroll percentage |
| Container-scroll SPAs | ChatGPT, Gemini, Slack | Percentage on detected inner `<div>` |
| Canvas/WebGL apps | Figma, Miro, Excalidraw | Wheel delta relay via synthetic events |

Cross-mode combinations are fully supported (e.g., normal website ↔ Figma canvas).

## How it works

```
popup.js            background.js          content.js           content-main.js
(Extension)         (Service Worker)       (ISOLATED world)     (MAIN world)
    │                     │                      │                     │
    │── START_SYNC ──►    │                      │                     │
    │── inject ──────►    │                      │                     │
    │                     │◄── port connect ─────│                     │
    │                     │◄── SET_MODE ─────────│                     │
    │                     │                      │                     │
    │                     │◄── SCROLL_UPDATE ────│                     │
    │                     │── DO_SCROLL ────────►│                     │
    │                     │                      │                     │
    │                     │◄── WHEEL_RELAY ──────│◄── WHEEL_CAPTURED ──│
    │                     │── DO_WHEEL ─────────►│── DISPATCH_WHEEL ──►│
```

- **Percentage sync**: `scrollPercent = scrollTop / (scrollHeight - clientHeight)`. Applied on the target as `targetY = percent * maxScroll`.
- **Wheel relay**: Raw `deltaX`/`deltaY` forwarded between tabs. On canvas pages, a MAIN world script dispatches synthetic `WheelEvent` at the canvas center.
- **Echo prevention**: Timestamp-based grace period (80ms) prevents scroll events from bouncing back and forth.

## File structure

```
split-view-sync/
├── manifest.json       Manifest V3 config
├── background.js       Service worker — message routing between tabs
├── content.js          Content script (ISOLATED) — scroll detection and relay
├── content-main.js     Content script (MAIN) — canvas wheel capture/dispatch
├── popup.html          Extension popup UI (inline CSS, dark theme)
├── popup.js            Popup logic — pane detection, injection, sync toggle
├── icons/
│   ├── icon.svg          Source icon — re-render PNGs from this
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── docs/                 Landing page (GitHub Pages from /docs)
    ├── index.html
    ├── icon.svg
    └── icon.png          Fallback for og:image
```

## Known limitations

- **Canvas sync is relative** — Wheel deltas are relayed, not absolute viewport positions. If you scroll one canvas independently then start syncing, they won't jump to the same position. They'll move in tandem from wherever they currently are.
- **Space+drag in Figma** — Hand-tool panning doesn't fire wheel events, so it can't be synced. Trackpad/scroll-wheel panning works.
- **chrome:// and Web Store pages** — Chrome blocks content script injection on these pages. The extension will show an error if you try to sync them.
- **Extension reload** — If you reload the extension from `chrome://extensions`, the content scripts in already-open tabs lose their connection. Re-click sync or refresh the tabs.

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Query tab info for Split View detection |
| `scripting` | Inject content scripts into both panes |
| `activeTab` | Access the currently focused tab |
| `<all_urls>` (host) | Allow injection on any standard webpage |

## Technical requirements

- Chrome v145+ (for Split View and `splitViewId` API)
- No build step, no dependencies — load the folder directly as an unpacked extension
