/**
 * Syncroll — Background Service Worker
 *
 * Central message router.  Uses two communication channels:
 *  • chrome.runtime.onMessage   — low-frequency control
 *    (START/STOP/GET_STATE/REQUEST_MAIN_INJECT)
 *  • chrome.runtime.onConnect   — high-frequency scroll data via persistent ports
 *
 * Persistent ports eliminate per-message connection overhead, giving
 * noticeably smoother sync than one-shot sendMessage.
 */

"use strict";

/** @type {number[]} IDs of the two tabs currently being synced */
let syncedTabs = [];

/** @type {Record<number, chrome.runtime.Port>} tabId → open port */
const tabPorts = {};

/** @type {Record<number, string>} tabId → scroll mode ("window"|"container"|"canvas") */
const tabModes = {};

/**
 * Tab IDs currently being moved into new windows by openSideBySide().
 * Chrome fires `chrome.tabs.onRemoved` with isWindowClosing:true when the
 * source window empties — even though the tab itself is alive in its new
 * window — which would otherwise reset syncedTabs and kill the relay.
 * @type {Set<number>}
 */
const movingTabIds = new Set();

// ── Control messages (popup ↔ background) ───────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "START_SYNC": {
      syncedTabs = message.tabIds;
      console.log("[SyncScroller] Syncing tabs:", syncedTabs);
      sendResponse({ status: "ok" });
      break;
    }

    case "STOP_SYNC": {
      console.log("[SyncScroller] Stopping sync for tabs:", syncedTabs);
      syncedTabs = [];
      sendResponse({ status: "stopped" });
      break;
    }

    // Popup asks for current state so it can restore its UI
    case "GET_STATE": {
      sendResponse({
        syncing: syncedTabs.length === 2,
        tabIds: [...syncedTabs],
      });
      break;
    }

    // Open two selected tabs into a pair of side-by-side windows.
    // Runs in the background so it survives popup closure (which happens
    // when the popup's anchor window empties after a tabs.move).
    case "OPEN_SIDE_BY_SIDE": {
      openSideBySide(message.tabIds, message.leftRect, message.rightRect)
        .then(() => sendResponse({ status: "ok" }))
        .catch((err) => {
          console.error("[Syncroll] OPEN_SIDE_BY_SIDE failed:", err);
          sendResponse({ status: "failed", error: err.message });
        });
      return true;  // Keep channel open for async response
    }

    // Content script requests MAIN world injection for canvas pages
    case "REQUEST_MAIN_INJECT": {
      const tabId = _sender.tab?.id;
      if (tabId == null) { sendResponse({ status: "no_tab" }); break; }
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-main.js"],
        world: "MAIN",
        injectImmediately: true,
      }).then(() => {
        sendResponse({ status: "ok" });
      }).catch((_) => {
        sendResponse({ status: "failed" });
      });
      return true;  // Keep channel open for async response
    }

    default:
      sendResponse({ status: "unknown_message" });
  }
});

// ── Side-by-side window opener (runs in background so it outlives the popup)

async function openSideBySide(tabIds, leftRect, rightRect) {
  console.log("[Syncroll] openSideBySide:",
    { tabIds, leftRect, rightRect });

  const [leftTab, rightTab] = await Promise.all([
    chrome.tabs.get(tabIds[0]).catch(() => null),
    chrome.tabs.get(tabIds[1]).catch(() => null),
  ]);
  if (!leftTab || !rightTab) {
    throw new Error("Selected tab not found — it may have been closed.");
  }

  // Mark these tabs as "in transit" so the onRemoved listener doesn't
  // tear down syncedTabs when their source window empties.
  tabIds.forEach((id) => movingTabIds.add(id));

  try {
    // chrome.windows.create({tabId}) rejects pinned tabs; unpin first.
    if (leftTab.pinned)  await chrome.tabs.update(tabIds[0], { pinned: false });
    if (rightTab.pinned) await chrome.tabs.update(tabIds[1], { pinned: false });

    await positionNewWindow(tabIds[0], leftRect,  false);
    const rightWin = await positionNewWindow(tabIds[1], rightRect, false);
    if (rightWin?.id != null) {
      await chrome.windows.update(rightWin.id, { focused: true }).catch(() => {});
    }
  } finally {
    // Grace period for any trailing onRemoved events that fire slightly
    // after the move completes.
    setTimeout(() => {
      tabIds.forEach((id) => movingTabIds.delete(id));
    }, 1000);
  }
}

async function positionNewWindow(tabId, rect, focused) {
  const win = await chrome.windows.create({ tabId, focused });
  console.log("[Syncroll] Created window", win.id, "state:", win.state);

  // Step 1: force "normal" state alone (combining with geometry is rejected
  // by some Chrome versions, silently dropping the geometry).
  try {
    await chrome.windows.update(win.id, { state: "normal" });
  } catch (err) {
    console.warn("[Syncroll] state:normal update failed:", err);
  }

  // Brief settle pause — state transitions on macOS can take a beat
  // before geometry updates are honored.
  await new Promise((r) => setTimeout(r, 60));

  // Step 2: apply geometry.
  try {
    await chrome.windows.update(win.id, rect);
  } catch (err) {
    console.warn("[Syncroll] geometry update failed:", err);
  }

  try {
    const after = await chrome.windows.get(win.id);
    console.log("[Syncroll] Final state for window", win.id, {
      state: after.state, left: after.left, top: after.top,
      width: after.width, height: after.height,
    });
  } catch (_) {}

  return win;
}

// ── High-frequency scroll relay (content script ↔ background) ───────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scroll-sync") return;

  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;

  // Store the port so we can forward messages TO this tab
  tabPorts[tabId] = port;

  port.onMessage.addListener((msg) => {
    // Store scroll mode reported by the content script
    if (msg.type === "SET_MODE") {
      tabModes[tabId] = msg.mode;
      return;
    }

    if (msg.type !== "SCROLL_UPDATE" && msg.type !== "WHEEL_RELAY") return;
    if (syncedTabs.length !== 2) return;

    const targetTabId =
      syncedTabs[0] === tabId ? syncedTabs[1] :
      syncedTabs[1] === tabId ? syncedTabs[0] :
      null;

    if (targetTabId == null) return;

    const targetPort = tabPorts[targetTabId];
    if (!targetPort) return;

    // Forward directly — no serialisation overhead of sendMessage
    try {
      if (msg.type === "SCROLL_UPDATE") {
        targetPort.postMessage({
          type: "DO_SCROLL",
          percent: msg.percent,
          top: msg.top,
        });
      } else if (msg.type === "WHEEL_RELAY") {
        // Only forward wheel deltas when at least one tab is canvas.
        // Avoids double-scrolling when both tabs are normal pages
        // (normal tabs already sync via SCROLL_UPDATE / DO_SCROLL).
        const senderMode = tabModes[tabId];
        const targetMode = tabModes[targetTabId];
        if (senderMode === "canvas" || targetMode === "canvas") {
          targetPort.postMessage({
            type: "DO_WHEEL",
            deltaX: msg.deltaX,
            deltaY: msg.deltaY,
            deltaMode: msg.deltaMode,
            ctrlKey: msg.ctrlKey,
            shiftKey: msg.shiftKey,
          });
        }
      }
    } catch (_) {
      // Target port died — clean up
      delete tabPorts[targetTabId];
    }
  });

  port.onDisconnect.addListener(() => {
    delete tabPorts[tabId];
    delete tabModes[tabId];
  });
});

// ── Clean up if either synced tab is closed ─────────────────────────────

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // Skip teardown for tabs we're actively moving into side-by-side
  // windows — Chrome fires onRemoved when the source window empties
  // even though the tab itself is alive in its new window.
  if (movingTabIds.has(tabId)) {
    console.log("[Syncroll] Ignoring onRemoved for in-transit tab:",
      tabId, "isWindowClosing:", removeInfo?.isWindowClosing);
    return;
  }
  delete tabPorts[tabId];
  delete tabModes[tabId];
  if (syncedTabs.includes(tabId)) {
    console.log("[SyncScroller] Synced tab closed:", tabId);
    syncedTabs = [];
  }
});
