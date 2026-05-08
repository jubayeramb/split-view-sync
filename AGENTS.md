# Syncroll — Agent Implementation Guide

## 1. Project Objective

Create a Google Chrome Extension (Manifest V3) that synchronizes scrolling between two specific tabs.
**Context:** In early 2026, Chrome introduced a native "Split View" feature that places two tabs side-by-side in a single window. Existing sync-scroll extensions struggle with this UI or force the creation of entirely separate windows. This extension must keep the user in a single window, utilizing Chrome's native Split View, by passing scroll coordinates between the two active panes.

## 2. Technical Stack

- **Environment:** Google Chrome (v145+)
- **Framework:** Chrome Extensions API (Manifest V3 strictly)
- **Languages:** HTML, JavaScript (Vanilla), CSS

## 3. Architecture Overview

Because there is currently no dedicated `chrome.splitView` API to manipulate the scroll state of split panes directly, the extension uses standard message passing across **two execution worlds**:

### File Map

| File | World | Role |
|---|---|---|
| `popup.html` / `popup.js` | Extension | Trigger UI — detects panes, injects scripts, starts/stops sync |
| `background.js` | Service Worker | Central router — relays scroll data between tabs via persistent ports |
| `content.js` | ISOLATED | Injected per tab — detects scroll mode, captures/applies scroll events |
| `content-main.js` | MAIN | Injected per canvas tab — captures real wheel events, dispatches synthetic ones |

### Three Scroll Modes

The extension auto-detects which mode each tab requires:

1. **`"window"`** — Standard pages where the viewport scrolls (`window.scrollY > 0`). Syncs via **proportional percentage**.
2. **`"container"`** — SPAs (ChatGPT, Gemini) where an inner `<div>` scrolls while `window.scrollY` stays 0. Syncs via **proportional percentage** on the detected container.
3. **`"canvas"`** — Canvas-dominated apps (Figma, Miro, Excalidraw) where there is no DOM scrolling at all. Syncs via **wheel delta relay** — raw `deltaX`/`deltaY` values are forwarded and dispatched as synthetic `WheelEvent`s on the target canvas.

### Dual-World Communication (Canvas Mode)

Canvas apps render via WebGL/WASM. Wheel events must be captured and dispatched in the **MAIN** world (page's JS context), but Chrome extension APIs only exist in the **ISOLATED** world. A `window.postMessage` bridge connects them:

```
MAIN world (content-main.js)     ISOLATED world (content.js)     Background
        │                                  │                          │
        │──WHEEL_CAPTURED──►               │                          │
        │   (postMessage)                  │──WHEEL_RELAY──►          │
        │                                  │    (port)                │──DO_WHEEL──►
        │                                  │◄──DO_WHEEL───           │    (port)
        │               ◄──DISPATCH_WHEEL──│                          │
        │                   (postMessage)  │                          │
        ▼                                  ▼                          ▼
  dispatch synthetic              bridge / relay                 route to
  WheelEvent on canvas                                          other tab
```

### Cross-Mode Routing

The background stores each tab's scroll mode (`tabModes[tabId]`). This enables correct routing when tabs use different modes (e.g., Normal website ↔ Figma canvas):

- **`SCROLL_UPDATE`** → Always forwarded as `DO_SCROLL` (percentage-based)
- **`WHEEL_RELAY`** → Forwarded as `DO_WHEEL` **only when at least one tab is in `"canvas"` mode**. This prevents double-scrolling when both tabs are normal pages (which already sync via percentage).

## 4. Core Requirements & Logic

### A. Proportional Scrolling (Window & Container Modes)

Pages might be different lengths. Do not sync absolute pixels. Sync the **percentage** of the scrollable area.

- **Formula:** `scrollPercent = el.scrollTop / (el.scrollHeight - el.clientHeight)`
- **Target Formula:** `targetY = percent * (el.scrollHeight - el.clientHeight)`
- For `"window"` mode, `el` is `document.scrollingElement || document.documentElement`
- For `"container"` mode, `el` is the detected scrollable `<div>`

### B. Wheel Delta Relay (Canvas Mode)

Canvas apps (Figma, Miro) render via WebGL — `window.scrollY` is always 0 and `scrollTo()` is ignored. Instead, raw wheel deltas are relayed:

1. `content-main.js` captures real `wheel` events on `<canvas>` (MAIN world)
2. Sends `WHEEL_CAPTURED` via `postMessage` to `content.js` (ISOLATED world)
3. `content.js` forwards as `WHEEL_RELAY` via persistent port to `background.js`
4. Background routes as `DO_WHEEL` to the other tab's `content.js`
5. Target `content.js` bridges to its MAIN world via `DISPATCH_WHEEL`
6. Target `content-main.js` creates a synthetic `WheelEvent` and dispatches it on `<canvas>`

**Synthetic WheelEvent targeting:** Events are dispatched at the canvas center (`rect.width/2`, `rect.height/2`) for consistent pan/zoom origin.

### C. Echo Loop Prevention (Crucial)

If Tab A scrolls, it sends a message to Tab B. Tab B scrolls programmatically. This programmatic scroll must not echo back.

- **Solution:** Timestamp-based grace period (`GRACE_MS = 80ms`). Before any programmatic scroll/wheel dispatch, stamp `lastProgrammaticScrollTime = Date.now()`. Outgoing listeners ignore events within the grace window.
- **MAIN world echo prevention:** `content-main.js` maintains its own `lastSyntheticTime` timestamp and skips `!e.isTrusted` events.

### D. Container Scroll Detection

SPAs like ChatGPT and Gemini use `overflow-y: auto|scroll` on inner `<div>` elements while `window.scrollY` stays 0.

- **Lazy detection:** On first `wheel` event, `findScrollableAncestor(e.target)` walks up the DOM from the wheel target.
- **Eager detection:** On injection, `findLargestScrollable()` uses a `TreeWalker` scan (capped at 2000 elements) to find the largest scrollable container by bounding rect area.
- **SPA navigation:** On each scroll event, checks `container.isConnected`. If disconnected, re-runs `detectScrollMode()`.

### E. Canvas Detection

Two-tier strategy — pre-emptive and runtime:

1. **Pre-emptive (popup.js):** URL pattern matching against `CANVAS_URL_PATTERNS` (Figma, Miro, Excalidraw). If matched, injects `content-main.js` in MAIN world immediately.
2. **Runtime (content.js):** `detectCanvasPage()` checks if any `<canvas>` covers >50% of the viewport area (`CANVAS_COVERAGE = 0.5`). Does **NOT** call `getContext()` — that would fail on existing WebGL contexts.
3. **On-demand (content.js):** If a tab later detects canvas mode, it sends `REQUEST_MAIN_INJECT` to background, which injects `content-main.js` dynamically.

### F. Permissions

Requires `"tabs"`, `"scripting"`, and `"activeTab"`. Host permissions: `"<all_urls>"` to allow injection on any standard webpage.

## 5. Message Protocol

### Control Messages (`chrome.runtime.onMessage` — low frequency)

| Message Type | Direction | Data | Purpose |
|---|---|---|---|
| `START_SYNC` | popup → background | `{ tabIds: [id1, id2] }` | Begin syncing two tabs |
| `STOP_SYNC` | popup → background | `{}` | Stop syncing |
| `GET_STATE` | popup → background | Response: `{ syncing, tabIds }` | Restore popup UI state |
| `REQUEST_MAIN_INJECT` | content → background | Response: `{ status }` | Inject content-main.js into sender tab |

### Port Messages (`chrome.runtime.connect("scroll-sync")` — high frequency)

| Message Type | Direction | Data | Purpose |
|---|---|---|---|
| `SET_MODE` | content → background | `{ mode }` | Report tab's scroll mode |
| `SCROLL_UPDATE` | content → background | `{ percent }` | Outgoing scroll position (0..1) |
| `DO_SCROLL` | background → content | `{ percent }` | Apply scroll position |
| `WHEEL_RELAY` | content → background | `{ deltaX, deltaY, deltaMode, ctrlKey, shiftKey }` | Forward wheel deltas |
| `DO_WHEEL` | background → content | `{ deltaX, deltaY, deltaMode, ctrlKey, shiftKey }` | Apply wheel deltas |

### postMessage Bridge (`window.postMessage` — MAIN ↔ ISOLATED)

All messages use `source: "SyncScroller"` namespace.

| Message Type | Direction | Data | Purpose |
|---|---|---|---|
| `WHEEL_CAPTURED` | MAIN → ISOLATED | `{ deltaX, deltaY, deltaMode, ctrlKey, shiftKey }` | Real wheel event captured on canvas |
| `DISPATCH_WHEEL` | ISOLATED → MAIN | `{ deltaX, deltaY, deltaMode, ctrlKey, shiftKey }` | Dispatch synthetic WheelEvent on canvas |
| `CLEANUP` | ISOLATED → MAIN | `{}` | Tear down MAIN world listeners |

## 6. Implementation Details

### A. Popup — Pane Detection (`popup.js`)

3-tier strategy to find the two Split View tabs:

1. **`splitViewId`** (Chrome 145+) — Both tabs in a Split View share the same `splitViewId`. Query all tabs with matching `splitViewId` in the same window.
2. **`highlighted`** — In Split View, both panes are highlighted in the tab strip. Query `highlighted: true` tabs.
3. **Index ± 1** — Last resort adjacency heuristic.

### B. Content Script — Mode Lifecycle (`content.js`)

```
Injection
  └→ detectScrollMode()
       ├→ getMaxScroll(null) > 0?  →  "window" mode
       ├→ detectCanvasPage()?      →  "canvas" mode  →  requestMainWorldInjection()
       └→ findLargestScrollable()? →  "container" mode
            └→ null?               →  defer to onWheel() lazy detection
```

### C. MAIN World Bridge (`content-main.js`)

- Wrapped in IIFE to avoid global pollution
- `findPrimaryCanvas()` — finds largest `<canvas>` by area (never calls `getContext()`)
- `onCanvasWheel()` — captures trusted wheel events, posts `WHEEL_CAPTURED`
- `onMessage()` — receives `DISPATCH_WHEEL`, creates synthetic `WheelEvent` at canvas center
- Cleanup exposed via `window.__splitViewSyncMainCleanup`

### D. Background — State Management (`background.js`)

- `syncedTabs[]` — IDs of the two synced tabs
- `tabPorts{}` — `tabId → chrome.runtime.Port` for persistent connections
- `tabModes{}` — `tabId → "window"|"container"|"canvas"` for cross-mode routing
- Cleanup on tab close (`chrome.tabs.onRemoved`) and port disconnect (`onDisconnect`)

## 7. Edge Cases to Handle

- **Dynamic Page Loading:** Height changes from infinite scroll or lazy loading are handled because percentage is recalculated on every scroll event (not cached on load).
- **Missing Adjacent Tab:** Popup gracefully shows error in UI when no adjacent tab is found.
- **SPA Navigation:** Container scroll mode checks `container.isConnected` on every scroll event. If the DOM node was removed (page navigation), re-runs `detectScrollMode()`.
- **Canvas Re-detection:** `content-main.js` re-queries `findPrimaryCanvas()` if the cached canvas element becomes disconnected.
- **Extension Context Death:** `isContextAlive()` checks `chrome.runtime.id` before every Chrome API call. Falls back to `teardown()` if the extension was reloaded.
- **Re-injection Cycle:** `window.__splitViewSyncCleanup` (ISOLATED) and `window.__splitViewSyncMainCleanup` (MAIN) allow clean stop → re-start without page reload.

---

## 8. Build, Lint & Test Commands

This is a **zero-build** Chrome Extension. No bundler, transpiler, or package manager.

| Action | Command |
|---|---|
| Load into Chrome | `chrome://extensions` → Enable Developer Mode → "Load unpacked" → select project root |
| Reload after changes | Click the refresh icon on the extension card, or Ctrl+R on `chrome://extensions` |
| View service worker logs | Click "service worker" link on the extension card in `chrome://extensions` |
| View popup logs | Right-click the extension icon → "Inspect Popup" |
| View content script logs | Open DevTools on the target page → Console (filter by extension name) |

**There is no `package.json`, no linter config, no test framework, and no build step.** All `.js` files are loaded raw by Chrome. Do not introduce build tools unless explicitly requested.

## 9. Code Style Guidelines

### File Structure
- Every JS file starts with `"use strict";`
- File-level JSDoc block comment describing purpose and architecture
- Section dividers: `// ── Section Name ──────────────────────` (em-dash style)

### Formatting
- **2-space indentation** (spaces, not tabs)
- **Double quotes** for all strings — never single quotes
- **Semicolons** required on every statement
- **Trailing commas** in multi-line objects/arrays/parameters
- **Max line length**: ~80 chars soft limit (comments may exceed)
- **Blank line** between logical sections; no consecutive blank lines

### Naming Conventions
- `camelCase` for variables and functions: `syncedTabs`, `detectPanes`, `getScrollRatio`
- `UPPER_SNAKE_CASE` for constants: `GRACE_MS`, `MIN_DELTA`, `CANVAS_COVERAGE`, `BRIDGE_SOURCE`
- Message type strings are `UPPER_SNAKE_CASE`: `"START_SYNC"`, `"SCROLL_UPDATE"`, `"DO_SCROLL"`, `"WHEEL_RELAY"`, `"DO_WHEEL"`, `"SET_MODE"`, `"GET_STATE"`, `"STOP_SYNC"`, `"REQUEST_MAIN_INJECT"`, `"WHEEL_CAPTURED"`, `"DISPATCH_WHEEL"`, `"CLEANUP"`
- DOM element cache objects named `DOM`: `DOM.btnSync`, `DOM.status`
- Console log prefix: `"[SyncScroller]"` for all debug output

### JavaScript Patterns
- **Vanilla JS only** — no frameworks, no TypeScript, no modules
- **Async/await** for all Chrome API calls (never raw `.then()` chains)
- **IIFE** wrapping for content scripts to avoid global pollution: `(() => { ... })()`
- **`document.documentElement`** for scroll measurements (not `document.body`)
- **Loose null checks** with `== null` to catch both `null` and `undefined`
- **Underscore `_`** for intentionally unused parameters: `catch (_) {}`, `(_sender, ...)`
- **Guard clauses** (early return) over deeply nested if/else
- **`{ passive: true }`** on scroll event listeners
- **`window.postMessage`** with `source: "SyncScroller"` namespace for MAIN ↔ ISOLATED bridge

### Error Handling
- `try/catch` with underscore for unused error: `catch (_) { ... }`
- Graceful degradation — never throw or crash; fall through to fallback behavior
- Injection failures return `false`; callers check and show user-facing error
- Port disconnection triggers cleanup via `onDisconnect` listener
- Always clean up resources (event listeners, rAF handles, ports) in teardown functions
- `isContextAlive()` guard before every Chrome API call in content scripts

### CSS
- All styles inline in `popup.html` within a `<style>` tag — no external CSS files
- Dark theme palette: `#1a1a2e` background, `#e0e0e0` text, `#533483` primary, `#e94560` danger
- System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...`
- `box-sizing: border-box` via universal reset
- Status colors: `.success` = `#2ecc71`, `.error` = `#e94560`, `.info` = `#8888aa`

### Chrome Extension Conventions
- **Manifest V3 only** — service workers, not background pages
- Communication: `chrome.runtime.onMessage` for low-frequency control; `chrome.runtime.connect` (persistent ports) for high-frequency scroll data
- Content script cleanup: expose `window.__splitViewSyncCleanup` for re-injection cycles
- MAIN world cleanup: expose `window.__splitViewSyncMainCleanup`
- Tab detection: 3-tier strategy — `splitViewId` → `highlighted` tabs → index ± 1 adjacency
- Popup state restoration: query background via `GET_STATE` on popup open
- **Never** use `chrome.storage` for transient sync state — keep it in service worker memory
- MAIN world injection: `chrome.scripting.executeScript` with `world: "MAIN"` and `injectImmediately: true`
- Canvas URL patterns in `popup.js`: `figma.com`, `miro.com`, `excalidraw.com`
- Canvas detection: never call `getContext()` — it fails on existing WebGL contexts
