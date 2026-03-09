/**
 * Split View Sync Scroller — Content Script
 *
 * Injected dynamically into both synced tabs.
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
 */

"use strict";

(() => {
  // ── Cleanup previous injection (supports stop → re-start cycle) ──────
  if (window.__splitViewSyncCleanup) {
    window.__splitViewSyncCleanup();
  }

  // ── Constants ────────────────────────────────────────────────────────
  const GRACE_MS = 80;        // Echo-prevention window (ms)
  const MIN_DELTA = 0.0005;   // ~0.05 % — ignore sub-pixel drift

  // ── State ────────────────────────────────────────────────────────────
  let lastProgrammaticScrollTime = 0;
  let lastSentPercent = -1;
  let sendRafId = null;
  let applyRafId = null;
  let latestIncomingPercent = null;

  // ── Helpers ──────────────────────────────────────────────────────────

  function isContextAlive() {
    return typeof chrome !== "undefined"
      && chrome.runtime
      && typeof chrome.runtime.id !== "undefined";
  }

  function getMaxScroll() {
    return document.documentElement.scrollHeight
         - document.documentElement.clientHeight;
  }

  function getScrollRatio() {
    const max = getMaxScroll();
    return max > 0
      ? (window.scrollY || document.documentElement.scrollTop) / max
      : 0;
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

      const max = getMaxScroll();
      if (max <= 0) return;

      const percent = getScrollRatio();

      // Skip if barely changed — prevents oscillation
      if (Math.abs(percent - lastSentPercent) < MIN_DELTA) return;

      lastSentPercent = percent;

      try {
        port.postMessage({ type: "SCROLL_UPDATE", percent });
      } catch (_) {
        teardown();
      }
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });

  // ── Incoming: apply scroll position (rAF-batched) ───────────────────
  // Multiple DO_SCROLL messages within one frame → only the LAST applies.

  port.onMessage.addListener((msg) => {
    if (msg.type !== "DO_SCROLL") return;

    latestIncomingPercent = msg.percent;

    if (!applyRafId) {
      applyRafId = requestAnimationFrame(() => {
        applyRafId = null;
        if (latestIncomingPercent === null) return;

        const max = getMaxScroll();
        if (max <= 0) { latestIncomingPercent = null; return; }

        const targetY = Math.max(0, Math.min(max, latestIncomingPercent * max));

        // Stamp BEFORE scrolling so the scroll listener ignores this one
        lastProgrammaticScrollTime = Date.now();

        // "instant" bypasses CSS scroll-behavior: smooth on the page
        window.scrollTo({ top: targetY, behavior: "instant" });

        latestIncomingPercent = null;
      });
    }
  });

  // ── Teardown ─────────────────────────────────────────────────────────

  function teardown() {
    window.removeEventListener("scroll", onScroll);
    if (sendRafId)  { cancelAnimationFrame(sendRafId);  sendRafId = null; }
    if (applyRafId) { cancelAnimationFrame(applyRafId); applyRafId = null; }
    try { port?.disconnect(); } catch (_) {}
    port = null;
    window.__splitViewSyncCleanup = null;
  }

  port.onDisconnect.addListener(teardown);

  // Expose for re-injection cycle (stop → start without page reload)
  window.__splitViewSyncCleanup = teardown;
})();
