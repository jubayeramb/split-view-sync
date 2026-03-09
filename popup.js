/**
 * Split View Sync Scroller — Popup Script
 *
 * Detects the two Split View panes using chrome.tabs.Tab.splitViewId
 * (Chrome 145+), injects the content script into both, and tells the
 * background service worker to start relaying scroll events.
 * Falls back to index ± 1 adjacency when splitViewId is unavailable.
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
 * Detect the two Split View panes.
 *
 * Strategy:
 *  1. (Chrome 145+) Use `splitViewId` — the native Split View identifier.
 *     Both tabs in a split view share the same splitViewId.
 *  2. Fallback: `highlighted: true` — in Split View both panes are typically
 *     highlighted in the tab strip.
 *  3. Last resort: index ± 1 adjacency heuristic.
 *
 * @returns {{ active: chrome.tabs.Tab, adjacent: chrome.tabs.Tab | null }}
 */
async function detectPanes() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!activeTab) return { active: null, adjacent: null };

  console.log("[SyncScroller] Active tab:", activeTab.id,
    "splitViewId:", activeTab.splitViewId,
    "index:", activeTab.index,
    "title:", activeTab.title);

  // ── Strategy 1: splitViewId (Chrome 145+) ───────────────────────────
  // Both tabs in a Split View share the same splitViewId.
  if (activeTab.splitViewId != null && activeTab.splitViewId !== -1) {
    const splitTabs = await chrome.tabs.query({
      windowId: activeTab.windowId,
      splitViewId: activeTab.splitViewId,
    });

    console.log("[SyncScroller] splitViewId", activeTab.splitViewId,
      "matched", splitTabs.length, "tabs");

    const other = splitTabs.find((t) => t.id !== activeTab.id) || null;

    if (other) {
      console.log("[SyncScroller] Split View peer:", other.id, other.title);
      return { active: activeTab, adjacent: other };
    }
  }

  // ── Strategy 2: highlighted tabs ─────────────────────────────────────
  // In Split View both visible tabs are highlighted in the tab strip.
  const highlighted = await chrome.tabs.query({
    highlighted: true,
    windowId: activeTab.windowId,
  });

  console.log("[SyncScroller] Highlighted tabs:", highlighted.length,
    highlighted.map((t) => `${t.id}:${t.title}`));

  if (highlighted.length === 2) {
    const other = highlighted.find((t) => t.id !== activeTab.id) || null;
    if (other) {
      console.log("[SyncScroller] Highlighted peer:", other.id, other.title);
      return { active: activeTab, adjacent: other };
    }
  }

  // ── Strategy 3: index ± 1 fallback ──────────────────────────────────
  const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  allTabs.sort((a, b) => a.index - b.index);

  const right = allTabs.find((t) => t.index === activeTab.index + 1) || null;
  const left  = allTabs.find((t) => t.index === activeTab.index - 1) || null;
  const adjacent = right || left;

  console.log("[SyncScroller] Index fallback:",
    adjacent ? `${adjacent.id}:${adjacent.title}` : "none found");

  return { active: activeTab, adjacent };
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

// ── Init: restore state or detect panes ──────────────────────────────────

(async function init() {
  // ── First check if we're already syncing (popup may have been closed) ──
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });

    if (state && state.syncing && state.tabIds.length === 2) {
      // Restore UI from persisted background state
      pairedTabs.left  = state.tabIds[0];
      pairedTabs.right = state.tabIds[1];

      // Fetch tab details for display
      const [leftTab, rightTab] = await Promise.all([
        chrome.tabs.get(pairedTabs.left).catch(() => null),
        chrome.tabs.get(pairedTabs.right).catch(() => null),
      ]);

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
  const { active, adjacent } = await detectPanes();

  if (!active) {
    DOM.tabLeft.textContent  = "No active tab found";
    DOM.tabLeft.classList.add("missing");
    setStatus("Cannot detect active tab.", "error");
    return;
  }

  DOM.tabLeft.textContent = truncate(active.title, 42);
  DOM.tabLeft.title       = active.url || "";

  if (!adjacent) {
    DOM.tabRight.textContent = "No split view peer found";
    DOM.tabRight.classList.add("missing");
    setStatus("Enter Split View with two tabs first.", "error");
    DOM.btnSync.disabled = true;
    return;
  }

  DOM.tabRight.textContent = truncate(adjacent.title, 42);
  DOM.tabRight.title       = adjacent.url || "";

  pairedTabs.left  = active.id;
  pairedTabs.right = adjacent.id;

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
