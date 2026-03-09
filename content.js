/**
 * Split View Sync Scroller — Content Script
 *
 * Injected dynamically into both synced tabs.
 * • Listens for native scroll events, calculates scroll PERCENTAGE, and
 *   forwards it to the background service worker.
 * • Listens for incoming DO_SCROLL commands, applies the scroll position,
 *   and prevents the echo loop via a timestamp-based grace period.
 *
 * Uses document.documentElement (not document.body) for robust height
 * calculations across all page layouts.
 */

"use strict";

(() => {
  // Guard against double-injection (popup may re-click)
  if (window.__splitViewSyncInjected) return;
  window.__splitViewSyncInjected = true;

  // ── Echo-loop prevention (timestamp-based) ───────────────────────────
  // A timestamp approach is more robust than a boolean flag because it
  // self-heals — after the grace period expires, scroll events flow again
  // without needing an explicit reset or cleanup timer.
  let lastProgrammaticScrollTime = 0;
  const PROGRAMMATIC_SCROLL_GRACE_MS = 100;

  // ── Throttle + debounce ──────────────────────────────────────────────
  // Scroll events fire at 60 fps+.  This utility gives us BOTH
  // responsiveness (first event fires immediately) and accuracy (the
  // final trailing event always fires so we land on the exact position).
  function throttleAndDebounce(fn, delay) {
    let timeoutId = null;
    let called = false;

    return function () {
      const args = arguments;
      if (timeoutId) clearTimeout(timeoutId);

      if (!called) {
        fn.apply(null, args);           // Immediate first call
        called = true;
        setTimeout(() => { called = false; }, delay);
      } else {
        timeoutId = setTimeout(() => {   // Guaranteed trailing call
          fn.apply(null, args);
        }, delay);
      }
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Returns true when the extension context is still alive.
   * After the extension is reloaded / updated, chrome.runtime.id becomes
   * undefined and any chrome.runtime.* call throws synchronously.
   */
  function isContextAlive() {
    return typeof chrome !== "undefined"
      && chrome.runtime
      && typeof chrome.runtime.id !== "undefined";
  }

  function getScrollInfo() {
    return {
      scrollTop: window.scrollY || document.documentElement.scrollTop,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    };
  }

  function getMaxScroll() {
    const info = getScrollInfo();
    return info.scrollHeight - info.clientHeight;
  }

  function getScrollRatio() {
    const maxScroll = getMaxScroll();
    return maxScroll > 0 ? getScrollInfo().scrollTop / maxScroll : 0;
  }

  // ── Outgoing: report our scroll position ─────────────────────────────
  function handleScroll() {
    // Extension was reloaded — detach ourselves so we stop firing.
    if (!isContextAlive()) {
      window.removeEventListener("scroll", throttledScroll);
      return;
    }

    // If this scroll was caused by an incoming DO_SCROLL, swallow it.
    const now = Date.now();
    if (now - lastProgrammaticScrollTime < PROGRAMMATIC_SCROLL_GRACE_MS) {
      return;
    }

    const maxScroll = getMaxScroll();
    if (maxScroll <= 0) return;            // Page fits in viewport

    const percent = getScrollRatio();

    try {
      chrome.runtime.sendMessage({
        type: "SCROLL_UPDATE",
        percent: percent,
      }).catch(() => {
        // Promise-level rejection (port closed, etc.) — ignore
      });
    } catch (_) {
      // Synchronous throw when extension context is invalidated.
      // Remove the listener so this never fires again.
      window.removeEventListener("scroll", throttledScroll);
    }
  }

  // 50 ms throttle ≈ ≤100 ms perceived sync latency
  const throttledScroll = throttleAndDebounce(handleScroll, 50);
  // Store reference so handleScroll can remove it on context death
  window.addEventListener("scroll", throttledScroll, { passive: true });

  // ── Incoming: apply scroll position from the other tab ───────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "DO_SCROLL") return;

    const maxScroll = getMaxScroll();

    if (maxScroll <= 0) {
      sendResponse({ status: "nothing_to_scroll" });
      return;
    }

    // Clamp to valid range to handle pages of wildly different lengths
    const targetY = Math.max(0, Math.min(maxScroll, message.percent * maxScroll));

    // Mark as programmatic scroll BEFORE scrolling — the timestamp
    // approach self-expires after PROGRAMMATIC_SCROLL_GRACE_MS.
    lastProgrammaticScrollTime = Date.now();

    window.scrollTo({ top: targetY, behavior: "auto" });

    sendResponse({ status: "scrolled" });
  });
})();
