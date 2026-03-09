/**
 * Split View Sync Scroller — Background Service Worker
 *
 * Central message router that stores the two synced tab IDs and forwards
 * scroll-percentage updates from one tab to the other.
 */

"use strict";

/** @type {number[]} IDs of the two tabs currently being synced */
let syncedTabs = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    // ── Popup tells us which two tabs to sync ──────────────────────────
    case "START_SYNC": {
      syncedTabs = message.tabIds;                       // [tabA, tabB]
      console.log("[SyncScroller] Syncing tabs:", syncedTabs);
      sendResponse({ status: "ok" });
      break;
    }

    // ── A content script reports its current scroll % ──────────────────
    case "SCROLL_UPDATE": {
      if (syncedTabs.length !== 2 || sender.tab == null) {
        console.log("[SyncScroller] SCROLL_UPDATE ignored — syncedTabs:",
          syncedTabs.length, "sender.tab:", !!sender.tab);
        sendResponse({ status: "ignored" });
        break;
      }

      const senderTabId = sender.tab.id;
      const targetTabId = syncedTabs[0] === senderTabId
        ? syncedTabs[1]
        : syncedTabs[1] === senderTabId
          ? syncedTabs[0]
          : null;

      if (targetTabId === null) {
        console.warn("[SyncScroller] Sender", senderTabId,
          "not in syncedTabs", syncedTabs);
        sendResponse({ status: "sender_not_synced" });
        break;
      }

      // Forward the scroll percentage to the OTHER tab
      chrome.tabs.sendMessage(targetTabId, {
        type: "DO_SCROLL",
        percent: message.percent,
      }).catch((err) => {
        console.warn("[SyncScroller] Could not reach target tab",
          targetTabId, ":", err.message);
      });

      sendResponse({ status: "forwarded" });
      break;
    }

    // ── Popup (or elsewhere) asks us to stop syncing ───────────────────
    case "STOP_SYNC": {
      console.log("[SyncScroller] Stopping sync for tabs:", syncedTabs);
      syncedTabs = [];
      sendResponse({ status: "stopped" });
      break;
    }

    default:
      sendResponse({ status: "unknown_message" });
  }

  // Return true only if we plan to call sendResponse asynchronously.
  // All branches above are synchronous, so we return false (implicitly).
});

// Clean up if either synced tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (syncedTabs.includes(tabId)) {
    console.log("[SyncScroller] Synced tab closed:", tabId);
    syncedTabs = [];
  }
});
