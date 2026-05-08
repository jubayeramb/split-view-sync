/**
 * Syncroll — MAIN World Bridge
 *
 * Injected into the page's MAIN world (not the extension's isolated world)
 * to intercept wheel events on <canvas> elements and dispatch synthetic
 * WheelEvents for scroll sync.
 *
 * Communication with the isolated-world content script uses
 * window.postMessage with a "SyncScroller" namespace.
 *
 * MAIN world constraints:
 *  • NO access to chrome.runtime or any Chrome extension APIs
 *  • Shares the JS heap with the page (Figma, Miro, etc.)
 *  • Must use postMessage to talk to the isolated-world script
 *
 * Message protocol (MAIN → ISOLATED):
 *  • { source: "SyncScroller", type: "WHEEL_CAPTURED", deltaX, deltaY,
 *      deltaMode, ctrlKey, shiftKey }
 *
 * Message protocol (ISOLATED → MAIN):
 *  • { source: "SyncScroller", type: "DISPATCH_WHEEL", deltaX, deltaY,
 *      deltaMode, ctrlKey, shiftKey }
 *  • { source: "SyncScroller", type: "CLEANUP" }
 */

"use strict";

(() => {
  // ── Cleanup previous injection ──────────────────────────────────────
  if (window.__splitViewSyncMainCleanup) {
    window.__splitViewSyncMainCleanup();
  }

  // ── Constants ───────────────────────────────────────────────────────
  const SOURCE = "SyncScroller";
  const GRACE_MS = 80;
  const MIN_DELTA = 0.5;

  // ── State ───────────────────────────────────────────────────────────
  let lastSyntheticTime = 0;
  let canvasEl = null;

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Find the largest <canvas> element on the page by bounding rect area.
   * Does NOT call getContext() — that would fail on an existing context.
   */
  function findPrimaryCanvas() {
    const canvases = document.querySelectorAll("canvas");
    let best = null;
    let bestArea = 0;
    for (const c of canvases) {
      const rect = c.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = c;
      }
    }
    return best;
  }

  // ── Outgoing: capture real wheel events on canvas ───────────────────

  function onCanvasWheel(e) {
    // Skip synthetic events we dispatched (echo prevention)
    if (!e.isTrusted) return;
    if (Date.now() - lastSyntheticTime < GRACE_MS) return;

    // Skip sub-pixel noise
    if (Math.abs(e.deltaX) < MIN_DELTA
        && Math.abs(e.deltaY) < MIN_DELTA) return;

    window.postMessage({
      source: SOURCE,
      type: "WHEEL_CAPTURED",
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
    }, "*");
  }

  // ── Incoming: dispatch synthetic WheelEvent on canvas ───────────────

  function onMessage(e) {
    if (e.source !== window) return;
    if (e.data?.source !== SOURCE) return;

    if (e.data.type === "DISPATCH_WHEEL") {
      if (!canvasEl || !canvasEl.isConnected) {
        canvasEl = findPrimaryCanvas();
        if (!canvasEl) return;
      }

      // Position at canvas center for consistent pan/zoom origin
      const rect = canvasEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      lastSyntheticTime = Date.now();

      const syntheticWheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: cx,
        clientY: cy,
        deltaX: e.data.deltaX,
        deltaY: e.data.deltaY,
        deltaMode: e.data.deltaMode || 0,
        ctrlKey: e.data.ctrlKey || false,
        shiftKey: e.data.shiftKey || false,
      });

      canvasEl.dispatchEvent(syntheticWheel);
      return;
    }

    if (e.data.type === "CLEANUP") {
      teardown();
    }
  }

  // ── Setup ───────────────────────────────────────────────────────────

  canvasEl = findPrimaryCanvas();

  if (canvasEl) {
    canvasEl.addEventListener("wheel", onCanvasWheel, {
      capture: true,
      passive: true,
    });
    console.log("[SyncScroller] MAIN world: canvas bridge attached");
  } else {
    console.warn("[SyncScroller] MAIN world: no canvas found");
  }

  window.addEventListener("message", onMessage);

  // ── Teardown ────────────────────────────────────────────────────────

  function teardown() {
    if (canvasEl) {
      canvasEl.removeEventListener("wheel", onCanvasWheel, {
        capture: true,
      });
    }
    window.removeEventListener("message", onMessage);
    canvasEl = null;
    window.__splitViewSyncMainCleanup = null;
    console.log("[SyncScroller] MAIN world: cleaned up");
  }

  window.__splitViewSyncMainCleanup = teardown;
})();
