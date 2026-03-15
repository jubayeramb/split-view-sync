/**
 * Split View Sync Scroller — Background Service Worker
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

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabPorts[tabId];
  delete tabModes[tabId];
  if (syncedTabs.includes(tabId)) {
    console.log("[SyncScroller] Synced tab closed:", tabId);
    syncedTabs = [];
  }
});
