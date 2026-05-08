/**
 * Syncroll — Popup Script
 *
 * Detects the two Split View panes using chrome.tabs.Tab.splitViewId
 * (Chrome 145+), injects the content script into both, and tells the
 * background service worker to start relaying scroll events.
 * Falls back to index ± 1 adjacency when splitViewId is unavailable.
 *
 * For canvas-dominated pages (Figma, Miro, Excalidraw), also injects
 * content-main.js in the MAIN world for synthetic wheel event dispatch.
 */

"use strict";

const DOM = {
  tabLeft:  document.getElementById("tab-left"),
  tabRight: document.getElementById("tab-right"),
  btnSync:  document.getElementById("btn-sync"),
  status:   document.getElementById("status"),
};

/** Currently syncing? Tracks toggle state. */
let isSynced = false;

/** Tab IDs for the two panes we're syncing. */
let pairedTabs = { left: null, right: null };

// ── Canvas URL patterns (pre-emptive MAIN world injection) ──────────────

const CANVAS_URL_PATTERNS = [
  /^https?:\/\/(www\.)?figma\.com\//,
  /^https?:\/\/(www\.)?miro\.com\//,
  /^https?:\/\/(www\.)?excalidraw\.com/,
];
// ── Helpers ────────────────────────────────────────────────────────────

function setStatus(text, type) {
  DOM.status.textContent = text;
  DOM.status.className = type;           // "success" | "error" | "info"
}

function truncate(str, max) {
  if (!str) return "(untitled)";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * Detect the two Split View panes and return them in geometric order.
 *
 * Strategy:
 *  1. (Chrome 145+) Use `splitViewId` — the native Split View identifier.
 *     Both tabs in a split view share the same splitViewId.
 *  2. Fallback: `highlighted: true` — in Split View both panes are typically
 *     highlighted in the tab strip.
 *  3. Last resort: index ± 1 adjacency heuristic.
 *
 * The returned `left`/`right` are sorted by `tab.index` — Chrome Split View
 * places the visually-left pane at the lower index in the tab strip.
 *
 * @returns {{ left: chrome.tabs.Tab, right: chrome.tabs.Tab | null }}
 */
async function detectPanes() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!activeTab) return { left: null, right: null };

  console.log("[SyncScroller] Active tab:", activeTab.id,
    "splitViewId:", activeTab.splitViewId,
    "index:", activeTab.index,
    "title:", activeTab.title);

  let peer = null;

  // ── Strategy 1: splitViewId (Chrome 145+) ───────────────────────────
  // Both tabs in a Split View share the same splitViewId.
  if (activeTab.splitViewId != null && activeTab.splitViewId !== -1) {
    const splitTabs = await chrome.tabs.query({
      windowId: activeTab.windowId,
      splitViewId: activeTab.splitViewId,
    });

    console.log("[SyncScroller] splitViewId", activeTab.splitViewId,
      "matched", splitTabs.length, "tabs");

    peer = splitTabs.find((t) => t.id !== activeTab.id) || null;
    if (peer) console.log("[SyncScroller] Split View peer:", peer.id, peer.title);
  }

  // ── Strategy 2: highlighted tabs ─────────────────────────────────────
  // In Split View both visible tabs are highlighted in the tab strip.
  if (!peer) {
    const highlighted = await chrome.tabs.query({
      highlighted: true,
      windowId: activeTab.windowId,
    });

    console.log("[SyncScroller] Highlighted tabs:", highlighted.length,
      highlighted.map((t) => `${t.id}:${t.title}`));

    if (highlighted.length === 2) {
      peer = highlighted.find((t) => t.id !== activeTab.id) || null;
      if (peer) console.log("[SyncScroller] Highlighted peer:", peer.id, peer.title);
    }
  }

  // ── Strategy 3: index ± 1 fallback ──────────────────────────────────
  if (!peer) {
    const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    allTabs.sort((a, b) => a.index - b.index);

    const after  = allTabs.find((t) => t.index === activeTab.index + 1) || null;
    const before = allTabs.find((t) => t.index === activeTab.index - 1) || null;
    peer = after || before;

    console.log("[SyncScroller] Index fallback:",
      peer ? `${peer.id}:${peer.title}` : "none found");
  }

  if (!peer) return { left: activeTab, right: null };

  // Sort by tab.index so the visually-left pane (lower index) is `left`.
  const [left, right] = [activeTab, peer].sort((a, b) => a.index - b.index);
  return { left, right };
}

/**
 * Inject content.js into a tab.  Returns true on success.
 */
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return true;
  } catch (err) {
    console.warn("[SyncScroller] Injection failed for tab", tabId, err.message);
    return false;
  }
}

/**
 * Inject content-main.js into a tab in the MAIN world.
 * Used for canvas-dominated pages that need synthetic wheel events.
 */
async function injectMainWorldScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-main.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    console.log("[SyncScroller] MAIN world injected into tab", tabId);
    return true;
  } catch (err) {
    console.warn(
      "[SyncScroller] MAIN world injection failed for tab",
      tabId, err.message,
    );
    return false;
  }
}

/**
 * Check if a URL belongs to a known canvas-based application.
 */
function isCanvasUrl(url) {
  if (!url) return false;
  return CANVAS_URL_PATTERNS.some((re) => re.test(url));
}

// ── Init: restore state or detect panes ──────────────────────────────────

(async function init() {
  // ── First check if we're already syncing (popup may have been closed) ──
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });

    if (state && state.syncing && state.tabIds.length === 2) {
      // Restore UI from persisted background state.
      // Sort by tab.index so the visually-left pane (lower index) shows on the left,
      // independent of the order the tabs were stored in.
      const [tabA, tabB] = await Promise.all([
        chrome.tabs.get(state.tabIds[0]).catch(() => null),
        chrome.tabs.get(state.tabIds[1]).catch(() => null),
      ]);

      const sorted = [tabA, tabB]
        .filter(Boolean)
        .sort((a, b) => a.index - b.index);
      const leftTab  = sorted[0] || tabA;
      const rightTab = sorted[1] || tabB;

      pairedTabs.left  = leftTab?.id ?? state.tabIds[0];
      pairedTabs.right = rightTab?.id ?? state.tabIds[1];

      DOM.tabLeft.textContent  = truncate(leftTab?.title, 42);
      DOM.tabLeft.title        = leftTab?.url || "";
      DOM.tabRight.textContent = truncate(rightTab?.title, 42);
      DOM.tabRight.title       = rightTab?.url || "";

      isSynced = true;
      DOM.btnSync.textContent = "Stop Syncing";
      DOM.btnSync.classList.add("active");
      DOM.btnSync.disabled = false;
      setStatus("Synced — scroll either pane!", "success");
      return;
    }
  } catch (_) {
    // Background not ready — fall through to detection
  }

  // ── Not currently syncing — detect panes ───────────────────────────────
  const { left, right } = await detectPanes();

  if (!left) {
    DOM.tabLeft.textContent  = "No active tab found";
    DOM.tabLeft.classList.add("missing");
    setStatus("Cannot detect active tab.", "error");
    return;
  }

  DOM.tabLeft.textContent = truncate(left.title, 42);
  DOM.tabLeft.title       = left.url || "";

  if (!right) {
    DOM.tabRight.textContent = "No split view peer found";
    DOM.tabRight.classList.add("missing");
    setStatus("Enter Split View with two tabs first.", "error");
    DOM.btnSync.disabled = true;
    return;
  }

  DOM.tabRight.textContent = truncate(right.title, 42);
  DOM.tabRight.title       = right.url || "";

  pairedTabs.left  = left.id;
  pairedTabs.right = right.id;

  DOM.btnSync.disabled = false;
  setStatus("Ready — click to sync.", "info");
})();

// ── Sync / Unsync toggle ───────────────────────────────────────────────

DOM.btnSync.addEventListener("click", async () => {
  // ── UNSYNC ──
  if (isSynced) {
    await chrome.runtime.sendMessage({ type: "STOP_SYNC" });

    isSynced = false;
    DOM.btnSync.textContent = "Sync Split Panes";
    DOM.btnSync.classList.remove("active");
    setStatus("Sync stopped.", "info");
    return;
  }

  // ── SYNC ──
  DOM.btnSync.disabled = true;
  setStatus("Injecting scripts…", "info");

  const leftOk  = await injectContentScript(pairedTabs.left);
  const rightOk = await injectContentScript(pairedTabs.right);

  if (!leftOk || !rightOk) {
    setStatus(
      "Injection failed — can't sync chrome:// or Web Store pages.",
      "error",
    );
    DOM.btnSync.disabled = false;
    return;
  }

  // Pre-emptively inject MAIN world script for known canvas URLs
  const [leftTabInfo, rightTabInfo] = await Promise.all([
    chrome.tabs.get(pairedTabs.left).catch(() => null),
    chrome.tabs.get(pairedTabs.right).catch(() => null),
  ]);

  if (leftTabInfo && isCanvasUrl(leftTabInfo.url)) {
    await injectMainWorldScript(pairedTabs.left);
  }
  if (rightTabInfo && isCanvasUrl(rightTabInfo.url)) {
    await injectMainWorldScript(pairedTabs.right);
  }

  // Tell background which two tabs to relay between
  await chrome.runtime.sendMessage({
    type: "START_SYNC",
    tabIds: [pairedTabs.left, pairedTabs.right],
  });

  isSynced = true;
  DOM.btnSync.textContent = "Stop Syncing";
  DOM.btnSync.classList.add("active");
  DOM.btnSync.disabled = false;
  setStatus("Synced — scroll either pane!", "success");
});
