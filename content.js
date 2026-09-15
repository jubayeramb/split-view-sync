/**
 * Syncroll — Content Script
 *
 * Injected dynamically into both synced tabs (ISOLATED world).
 *
 * Supports three scroll modes, detected automatically:
 *  1. "window"    — standard pages where the viewport scrolls
 *  2. "container" — SPAs (ChatGPT, Gemini) where an inner <div> scrolls
 *  3. "canvas"    — canvas-based apps (Figma) with no DOM scrolling
 *
 * Scroll alignment (user preference, chrome.storage.sync "syncBy"):
 *  • "percent" - same fraction of the scrollable area (default)
 *  • "pixel"   - same scrollTop; the shorter page clamps at its end
 *  Outgoing updates carry both values; the receiving tab applies the one
 *  matching its current preference.
 *
 * Performance architecture:
 *  • Persistent port (chrome.runtime.connect) instead of one-shot
 *    sendMessage — eliminates per-message connection overhead.
 *  • requestAnimationFrame batching on BOTH send and receive —
 *    scroll events fire at 60 fps+ but we only process once per frame.
 *  • Minimum-change threshold prevents oscillation when both tabs
 *    show the same page (pixel rounding causes ±0.01 % drift).
 *  • "instant" scroll behavior bypasses any CSS scroll-behavior: smooth.
 *
 * Echo-loop prevention:
 *  • Timestamp-based grace period (self-healing, no stuck flags).
 *
 * Canvas mode:
 *  • Wheel events captured on <canvas> → relayed as WHEEL_RELAY
 *  • Incoming DO_WHEEL → bridged to MAIN world via postMessage
 *  • MAIN world script (content-main.js) dispatches synthetic WheelEvent
 */

"use strict";

(() => {
  // ── Cleanup previous injection (supports stop → re-start cycle) ──────
  if (window.__splitViewSyncCleanup) {
    window.__splitViewSyncCleanup();
  }

  // ── Constants ────────────────────────────────────────────────────────
  const GRACE_MS = 80;              // Echo-prevention window (ms)
  const MIN_DELTA = 0.0005;         // ~0.05 % — ignore sub-pixel drift
  const CANVAS_COVERAGE = 0.5;      // >50 % viewport = canvas page
  const MIN_PX_DELTA = 1;           // Pixel alignment: ignore sub-pixel drift
  const WHEEL_MIN_DELTA = 0.5;      // Ignore sub-pixel wheel noise
  const BRIDGE_SOURCE = "SyncScroller";  // postMessage namespace
  const SYNC_BY_KEY = "syncBy";     // chrome.storage.sync preference key

  // ── State ────────────────────────────────────────────────────────────
  let lastProgrammaticScrollTime = 0;
  let lastSentPercent = -1;
  let lastSentTop = -1;
  let sendRafId = null;
  let applyRafId = null;
  let latestIncomingScroll = null; // { percent, top } from the other tab
  let syncBy = "percent";          // "percent" | "pixel"

  let scrollMode = null;           // "window" | "container" | "canvas"
  let scrollContainer = null;      // Cached scrollable <div> element
  let mainWorldReady = false;      // Whether content-main.js is injected

  // ── Helpers ──────────────────────────────────────────────────────────

  function isContextAlive() {
    return typeof chrome !== "undefined"
      && chrome.runtime
      && typeof chrome.runtime.id !== "undefined";
  }

  /**
   * Maximum scrollable distance for an element (or the document root).
   * @param {Element|null} el — scrollable element, or null for window
   */
  function getMaxScroll(el) {
    if (el) return el.scrollHeight - el.clientHeight;
    const de = document.scrollingElement || document.documentElement;
    return de.scrollHeight - de.clientHeight;
  }

  /**
   * Current scroll ratio (0..1) for an element (or the document root).
   * @param {Element|null} el — scrollable element, or null for window
   */
  function getScrollRatio(el) {
    const max = getMaxScroll(el);
    if (max <= 0) return 0;
    if (el) return el.scrollTop / max;
    return (window.scrollY || document.documentElement.scrollTop) / max;
  }

  /**
   * Current scrollTop in pixels for an element (or the document root).
   * @param {Element|null} el - scrollable element, or null for window
   */
  function getScrollTop(el) {
    if (el) return el.scrollTop;
    return window.scrollY || document.documentElement.scrollTop;
  }

  // ── Alignment preference ────────────────────────────────────────────

  function normalizeSyncBy(value) {
    return value === "pixel" ? "pixel" : "percent";
  }

  async function loadSyncBy() {
    if (!isContextAlive()) return;
    try {
      const stored = await chrome.storage.sync.get(SYNC_BY_KEY);
      syncBy = normalizeSyncBy(stored[SYNC_BY_KEY]);
    } catch (_) {}
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "sync" || !changes[SYNC_BY_KEY]) return;
    syncBy = normalizeSyncBy(changes[SYNC_BY_KEY].newValue);
  }

  // ── Scroll container detection ──────────────────────────────────────

  /**
   * Walk up the DOM from `el` to find the nearest scrollable ancestor.
   * Returns null if no scrollable ancestor exists (window scrolls instead).
   */
  function findScrollableAncestor(el) {
    let node = el;
    while (node && node !== document.body
        && node !== document.documentElement) {
      if (!node.isConnected) return null;
      const style = getComputedStyle(node);
      const ov = style.overflowY;
      if ((ov === "auto" || ov === "scroll")
          && node.scrollHeight > node.clientHeight + 10) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Scan for the largest scrollable container on the page.
   * Used for initial detection when no wheel event has fired yet.
   */
  function findLargestScrollable() {
    let best = null;
    let bestArea = 0;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      null,
    );
    let count = 0;
    let node = walker.nextNode();
    while (node && count < 2000) {
      count++;
      const style = getComputedStyle(node);
      const ov = style.overflowY;
      if ((ov === "auto" || ov === "scroll")
          && node.scrollHeight > node.clientHeight + 10) {
        const rect = node.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = node;
        }
      }
      node = walker.nextNode();
    }
    return best;
  }

  // ── Canvas detection ────────────────────────────────────────────────

  /**
   * Check if this page is dominated by a <canvas> element (>50 % viewport).
   * Does NOT call getContext() — that would fail on existing WebGL contexts.
   */
  function detectCanvasPage() {
    const viewportArea = window.innerWidth * window.innerHeight;
    if (viewportArea <= 0) return false;
    const canvases = document.querySelectorAll("canvas");
    for (const c of canvases) {
      const rect = c.getBoundingClientRect();
      if (rect.width * rect.height / viewportArea > CANVAS_COVERAGE) {
        return true;
      }
    }
    return false;
  }

  // ── Scroll mode management ──────────────────────────────────────────

  /**
   * Set the active scroll mode and attach mode-specific listeners.
   */
  function setMode(mode, container) {
    if (scrollMode === mode && scrollContainer === container) return;

    // Tear down previous container listener
    if (scrollMode === "container" && scrollContainer) {
      scrollContainer.removeEventListener("scroll", onScroll);
    }

    scrollMode = mode;
    scrollContainer = container;
    console.log("[SyncScroller] Scroll mode:", mode);

    // Notify background of our mode (for cross-mode routing)
    try {
      if (port) port.postMessage({ type: "SET_MODE", mode });
    } catch (_) {}

    if (mode === "container" && container) {
      container.addEventListener("scroll", onScroll, { passive: true });
    }

    if (mode === "canvas") {
      requestMainWorldInjection();
    }
  }

  /**
   * Auto-detect the scroll mode on injection.
   * Falls back to lazy detection on the first wheel event if unclear.
   */
  function detectScrollMode() {
    // 1. Does the document itself scroll?
    if (getMaxScroll(null) > 0) {
      setMode("window", null);
      return;
    }

    // 2. Is this a canvas-dominated page?
    if (detectCanvasPage()) {
      setMode("canvas", null);
      return;
    }

    // 3. Is there a scrollable container?
    const container = findLargestScrollable();
    if (container) {
      setMode("container", container);
      return;
    }

    // Mode stays null — will lazy-detect on first wheel event
  }

  // ── MAIN world injection request ────────────────────────────────────

  async function requestMainWorldInjection() {
    if (mainWorldReady) return;
    if (!isContextAlive()) return;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "REQUEST_MAIN_INJECT",
      });
      if (resp?.status === "ok") {
        mainWorldReady = true;
        console.log("[SyncScroller] MAIN world script injected");
      }
    } catch (_) {
      console.warn("[SyncScroller] MAIN world injection failed");
    }
  }

  // ── Establish persistent port ────────────────────────────────────────
  let port = null;
  try {
    port = chrome.runtime.connect({ name: "scroll-sync" });
  } catch (_) {
    return; // Extension context already dead
  }

  // ── Outgoing: report scroll position (rAF-batched) ──────────────────

  function onScroll() {
    if (sendRafId) return;          // one rAF per frame max

    sendRafId = requestAnimationFrame(() => {
      sendRafId = null;

      if (!isContextAlive()) { teardown(); return; }

      // Don't echo back a programmatic scroll
      if (Date.now() - lastProgrammaticScrollTime < GRACE_MS) return;

      // Re-check container is still connected (SPA navigation)
      if (scrollMode === "container" && scrollContainer
          && !scrollContainer.isConnected) {
        scrollContainer.removeEventListener("scroll", onScroll);
        scrollContainer = null;
        scrollMode = null;
        detectScrollMode();
        return;
      }

      const el = scrollMode === "container" ? scrollContainer : null;
      const max = getMaxScroll(el);
      if (max <= 0) return;

      const percent = getScrollRatio(el);
      const top = getScrollTop(el);

      // Skip if barely changed — prevents oscillation
      if (syncBy === "pixel") {
        if (Math.abs(top - lastSentTop) < MIN_PX_DELTA) return;
      } else if (Math.abs(percent - lastSentPercent) < MIN_DELTA) {
        return;
      }

      lastSentPercent = percent;
      lastSentTop = top;

      try {
        port.postMessage({ type: "SCROLL_UPDATE", percent, top });
      } catch (_) {
        teardown();
      }
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });

  // ── Wheel listener: lazy mode detection + canvas relay ──────────────

  function onWheel(e) {
    // Lazy mode detection if not yet determined
    if (!scrollMode) {
      const target = e.target;

      if (target?.tagName === "CANVAS" && detectCanvasPage()) {
        setMode("canvas", null);
      } else {
        const ancestor = findScrollableAncestor(target);
        if (ancestor) {
          setMode("container", ancestor);
        } else if (getMaxScroll(null) > 0) {
          setMode("window", null);
        }
      }
    }

    // Relay wheel deltas to the other tab (all modes)
    if (Math.abs(e.deltaX) < WHEEL_MIN_DELTA
        && Math.abs(e.deltaY) < WHEEL_MIN_DELTA) return;
    if (Date.now() - lastProgrammaticScrollTime < GRACE_MS) return;

    if (!isContextAlive() || !port) return;

    try {
      port.postMessage({
        type: "WHEEL_RELAY",
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
      });
    } catch (_) {
      teardown();
    }
  }

  document.addEventListener("wheel", onWheel, {
    capture: true,
    passive: true,
  });

  // ── Bridge: receive WHEEL_CAPTURED from MAIN world ──────────────────

  function onBridgeMessage(e) {
    if (e.source !== window) return;
    if (e.data?.source !== BRIDGE_SOURCE) return;
    if (e.data.type !== "WHEEL_CAPTURED") return;

    if (!isContextAlive() || !port) return;
    if (Date.now() - lastProgrammaticScrollTime < GRACE_MS) return;

    try {
      port.postMessage({
        type: "WHEEL_RELAY",
        deltaX: e.data.deltaX,
        deltaY: e.data.deltaY,
        deltaMode: e.data.deltaMode,
        ctrlKey: e.data.ctrlKey,
        shiftKey: e.data.shiftKey,
      });
    } catch (_) {
      teardown();
    }
  }

  window.addEventListener("message", onBridgeMessage);

  // ── Incoming: apply scroll or wheel (rAF-batched) ───────────────────

  let latestIncomingWheel = null;

  port.onMessage.addListener((msg) => {
    // ── Position-based scroll (window / container modes) ──────────────
    if (msg.type === "DO_SCROLL") {
      latestIncomingScroll = { percent: msg.percent, top: msg.top };

      if (!applyRafId) {
        applyRafId = requestAnimationFrame(() => {
          applyRafId = null;
          if (latestIncomingScroll == null) return;

          const el = scrollMode === "container" ? scrollContainer : null;
          const max = getMaxScroll(el);
          if (max <= 0) { latestIncomingScroll = null; return; }

          const { percent, top } = latestIncomingScroll;
          const desiredY = syncBy === "pixel" && top != null
            ? top
            : percent * max;
          const targetY = Math.max(0, Math.min(max, desiredY));

          // Stamp BEFORE scrolling so the scroll listener ignores this
          lastProgrammaticScrollTime = Date.now();

          if (el) {
            el.scrollTo({ top: targetY, behavior: "instant" });
          } else {
            window.scrollTo({ top: targetY, behavior: "instant" });
          }

          // The other tab now matches where we landed. Without this, a
          // user scroll back to the last position we sent is deduped away.
          lastSentPercent = getScrollRatio(el);
          lastSentTop = getScrollTop(el);

          latestIncomingScroll = null;
        });
      }
      return;
    }

    // ── Wheel relay (canvas mode or fallback) ─────────────────────────
    if (msg.type === "DO_WHEEL") {
      latestIncomingWheel = msg;

      if (!applyRafId) {
        applyRafId = requestAnimationFrame(() => {
          applyRafId = null;
          if (!latestIncomingWheel) return;

          const w = latestIncomingWheel;
          lastProgrammaticScrollTime = Date.now();

          if (scrollMode === "canvas" && mainWorldReady) {
            // Forward to MAIN world via postMessage bridge
            window.postMessage({
              source: BRIDGE_SOURCE,
              type: "DISPATCH_WHEEL",
              deltaX: w.deltaX,
              deltaY: w.deltaY,
              deltaMode: w.deltaMode,
              ctrlKey: w.ctrlKey,
              shiftKey: w.shiftKey,
            }, "*");
          } else {
            // Non-canvas: apply as scrollBy on container or window
            const el = scrollContainer
              || document.scrollingElement
              || document.documentElement;
            el.scrollBy({
              top: w.deltaY,
              left: w.deltaX,
              behavior: "instant",
            });
          }

          latestIncomingWheel = null;
        });
      }
    }
  });

  // ── Teardown ─────────────────────────────────────────────────────────

  function teardown() {
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("message", onBridgeMessage);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) {}

    if (scrollContainer) {
      scrollContainer.removeEventListener("scroll", onScroll);
    }

    // Signal MAIN world to clean up
    if (mainWorldReady) {
      window.postMessage({
        source: BRIDGE_SOURCE,
        type: "CLEANUP",
      }, "*");
    }

    if (sendRafId)  { cancelAnimationFrame(sendRafId);  sendRafId = null; }
    if (applyRafId) { cancelAnimationFrame(applyRafId); applyRafId = null; }
    try { port?.disconnect(); } catch (_) {}
    port = null;
    scrollContainer = null;
    scrollMode = null;
    mainWorldReady = false;
    window.__splitViewSyncCleanup = null;
  }

  port.onDisconnect.addListener(teardown);

  // Expose for re-injection cycle (stop → start without page reload)
  window.__splitViewSyncCleanup = teardown;

  // ── Init: load alignment preference, detect scroll mode ─────────────
  chrome.storage.onChanged.addListener(onStorageChanged);
  loadSyncBy();
  detectScrollMode();
})();
