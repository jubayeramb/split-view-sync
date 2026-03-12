# Split View Sync Scroller - Agent Implementation Guide

## 1. Project Objective

Create a Google Chrome Extension (Manifest V3) that synchronizes scrolling between two specific tabs.
**Context:** In early 2026, Chrome introduced a native "Split View" feature that places two tabs side-by-side in a single window. Existing sync-scroll extensions struggle with this UI or force the creation of entirely separate windows. This extension must keep the user in a single window, utilizing Chrome's native Split View, by passing scroll coordinates between the two active panes.

## 2. Technical Stack

- **Environment:** Google Chrome (v145+)
- **Framework:** Chrome Extensions API (Manifest V3 strictly)
- **Languages:** HTML, JavaScript (Vanilla), CSS

## 3. Architecture Overview

Because there is currently no dedicated `chrome.splitView` API to manipulate the scroll state of split panes directly, the extension will rely on standard message passing:

1.  **Popup (`popup.html` & `popup.js`):** Acts as the trigger. It identifies the currently active tab and the adjacent tab (simulating the two sides of a split view) and injects the content script into both.
2.  **Background Service Worker (`background.js`):** Acts as the central router. It stores the IDs of the two synced tabs and listens for scroll updates from either one, forwarding the command to the other.
3.  **Content Script (`content.js`):** Injected dynamically. It listens to `window.addEventListener('scroll')` and calculates the scroll percentage. It also listens for incoming messages to adjust its own `window.scrollTo()`.

## 4. Core Requirements & Logic

### A. Proportional Scrolling

Pages might be different lengths. Do not sync absolute pixels. Sync the **percentage** of the scrollable area.

- **Formula:** `scrollPercent = window.scrollY / (document.body.scrollHeight - window.innerHeight)`
- **Target Formula:** `targetY = message.percent * (document.body.scrollHeight - window.innerHeight)`

### B. Echo Loop Prevention (Crucial)

If Tab A scrolls, it sends a message to Tab B. Tab B scrolls programmatically. This programmatic scroll will trigger Tab B's `scroll` event listener, which will send a message back to Tab A, creating an infinite loop.

- **Solution:** Use a local boolean flag `isSyncing` in the content script. When receiving a scroll command from the background, set `isSyncing = true` before calling `window.scrollTo()`, and ignore the next native scroll event if `isSyncing` is true.

### C. Permissions

Requires `"tabs"`, `"scripting"`, and `"activeTab"`. Host permissions should be `"<all_urls>"` to allow injection on any standard webpage being compared.

## 5. Implementation Steps for Agent

1.  **Initialize `manifest.json`:** Set up Manifest V3 structure with the required permissions and declare the background service worker and default popup.
2.  **Develop `background.js`:** \* Set up a listener for `chrome.runtime.onMessage`.
    - Handle a "START_SYNC" message to store the two target tab IDs in an array.
    - Handle a "SCROLL_UPDATE" message to identify the sender, find the _other_ tab ID in the array, and use `chrome.tabs.sendMessage` to forward the scroll percentage.
3.  **Develop `content.js`:**
    - Implement the `scroll` event listener to calculate percentage and send "SCROLL_UPDATE".
    - Implement `chrome.runtime.onMessage` listener to receive "DO_SCROLL" commands, apply the echo-prevention flag, and execute `window.scrollTo({ top: targetY, behavior: 'instant' })`.
4.  **Develop `popup.html` & `popup.js`:**
    - Create a simple UI with a "Sync Split Panes" button.
    - On click, query `chrome.tabs` to get the `active: true` tab.
    - Query all tabs in the current window to find the adjacent tab (`index === activeTab.index + 1` or `- 1`).
    - Use `chrome.scripting.executeScript` to inject `content.js` into both tab IDs.
    - Send the "START_SYNC" message to the background worker with the two IDs.
    - Update the UI to indicate success.

## 6. Edge Cases to Handle

- **Dynamic Page Loading:** If a page utilizes infinite scroll or dynamically loads content (changing `document.body.scrollHeight`), the percentage calculation will naturally adjust, but ensure the content script calculates the height dynamically on every scroll event, not just on load.
- **Missing Adjacent Tab:** The popup logic must gracefully handle the scenario where there is no adjacent tab to pair with and show an error in the popup UI.

---

## 7. Build, Lint & Test Commands

This is a **zero-build** Chrome Extension. No bundler, transpiler, or package manager.

| Action | Command |
|---|---|
| Load into Chrome | `chrome://extensions` → Enable Developer Mode → "Load unpacked" → select project root |
| Reload after changes | Click the refresh icon on the extension card, or Ctrl+R on `chrome://extensions` |
| View service worker logs | Click "service worker" link on the extension card in `chrome://extensions` |
| View popup logs | Right-click the extension icon → "Inspect Popup" |
| View content script logs | Open DevTools on the target page → Console (filter by extension name) |

**There is no `package.json`, no linter config, no test framework, and no build step.** All `.js` files are loaded raw by Chrome. Do not introduce build tools unless explicitly requested.

## 8. Code Style Guidelines

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
- `UPPER_SNAKE_CASE` for constants: `GRACE_MS`, `MIN_DELTA`
- Message type strings are `UPPER_SNAKE_CASE`: `"START_SYNC"`, `"SCROLL_UPDATE"`, `"DO_SCROLL"`, `"GET_STATE"`, `"STOP_SYNC"`
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

### Error Handling
- `try/catch` with underscore for unused error: `catch (_) { ... }`
- Graceful degradation — never throw or crash; fall through to fallback behavior
- Injection failures return `false`; callers check and show user-facing error
- Port disconnection triggers cleanup via `onDisconnect` listener
- Always clean up resources (event listeners, rAF handles, ports) in teardown functions

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
- Tab detection: 3-tier strategy — `splitViewId` → `highlighted` tabs → index ± 1 adjacency
- Popup state restoration: query background via `GET_STATE` on popup open
- **Never** use `chrome.storage` for transient sync state — keep it in service worker memory
