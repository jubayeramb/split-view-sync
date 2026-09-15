/**
 * Syncroll — Popup Script
 *
 * Lets the user pick any two open tabs (cross-window) and sync their
 * scrolling. By default the left and right panes are pre-filled from
 * Chrome's Split View detection (splitViewId / highlighted / index ± 1),
 * but both selections are user-overridable via custom dropdowns.
 *
 * "Scroll alignment" chooses how positions map between pages of different
 * lengths: relative percentage (default) or exact pixel offset. Stored in
 * chrome.storage.sync and read live by the content scripts, so it can be
 * changed while syncing.
 *
 * "Open in new window" moves the two selected tabs into a pair of
 * side-by-side windows positioned at the screen halves, then syncs —
 * for users who don't know about Chrome's native Split View.
 */

"use strict";

// ── DOM refs ───────────────────────────────────────────────────────────

const DOM = {
  triggers: {
    left:  document.getElementById("dd-left-trigger"),
    right: document.getElementById("dd-right-trigger"),
  },
  titles: {
    left:  document.getElementById("dd-left-title"),
    right: document.getElementById("dd-right-title"),
  },
  favicons: {
    left:  document.getElementById("dd-left-favicon"),
    right: document.getElementById("dd-right-favicon"),
  },
  lists: {
    left:  document.getElementById("dd-left-list"),
    right: document.getElementById("dd-right-list"),
  },
  hints: {
    left:  document.getElementById("dd-left-hint"),
    right: document.getElementById("dd-right-hint"),
  },
  syncByRadios:  document.querySelectorAll('input[name="sync-by"]'),
  syncByHint:    document.getElementById("sync-by-hint"),
  openNewWindow: document.getElementById("open-new-window"),
  btnSync:       document.getElementById("btn-sync"),
  status:        document.getElementById("status"),
};

// ── State ──────────────────────────────────────────────────────────────

let isSynced = false;
let pairedTabs = { left: null, right: null };
let allTabs = [];
let selection = { left: null, right: null };
const dropdownOpen = { left: false, right: false };

// ── Constants ──────────────────────────────────────────────────────────

const CANVAS_URL_PATTERNS = [
  /^https?:\/\/(www\.)?figma\.com\//,
  /^https?:\/\/(www\.)?miro\.com\//,
  /^https?:\/\/(www\.)?excalidraw\.com/,
];

const SYNC_BY_KEY = "syncBy";

const SYNC_BY_HINTS = {
  percent: "Pages of different lengths reach the end together.",
  pixel: "Same scroll distance; the shorter page stops at its end.",
};

// URLs we can't inject into — filter them out of the dropdown.
const SKIP_URL_RE = /^(chrome|chrome-extension|edge|about|view-source|devtools):|^https?:\/\/chromewebstore\.google\.com/;

// ── Helpers ────────────────────────────────────────────────────────────

function setStatus(text, type) {
  DOM.status.textContent = text;
  DOM.status.className = type;
}

function truncate(str, max) {
  if (!str) return "(untitled)";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function otherSide(side) {
  return side === "left" ? "right" : "left";
}

/**
 * Detect the two Split View panes and return them in geometric order.
 *
 * Strategy:
 *  1. (Chrome 145+) `splitViewId` — both panes share the same ID.
 *  2. `highlighted: true` — Split View highlights both visible tabs.
 *  3. Index ± 1 adjacency in the active window.
 *
 * Sorted by `tab.index` so the visually-left pane comes first.
 */
async function detectPanes() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!activeTab) return { left: null, right: null };

  let peer = null;

  if (activeTab.splitViewId != null && activeTab.splitViewId !== -1) {
    const splitTabs = await chrome.tabs.query({
      windowId: activeTab.windowId,
      splitViewId: activeTab.splitViewId,
    });
    peer = splitTabs.find((t) => t.id !== activeTab.id) || null;
  }

  if (!peer) {
    const highlighted = await chrome.tabs.query({
      highlighted: true,
      windowId: activeTab.windowId,
    });
    if (highlighted.length === 2) {
      peer = highlighted.find((t) => t.id !== activeTab.id) || null;
    }
  }

  if (!peer) {
    const winTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
    winTabs.sort((a, b) => a.index - b.index);
    peer = winTabs.find((t) => t.index === activeTab.index + 1)
        || winTabs.find((t) => t.index === activeTab.index - 1)
        || null;
  }

  if (!peer) return { left: activeTab, right: null };

  const [left, right] = [activeTab, peer].sort((a, b) => a.index - b.index);
  return { left, right };
}

/**
 * Fetch every open tab across all windows, filter out URLs that can't
 * be injected (chrome://, Web Store, etc.), sort by [windowId, index].
 */
async function fetchSyncableTabs() {
  const tabs = await chrome.tabs.query({});
  const syncable = [];
  let hidden = 0;
  for (const t of tabs) {
    if (!t.url || SKIP_URL_RE.test(t.url)) { hidden++; continue; }
    syncable.push(t);
  }
  syncable.sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });
  allTabs = syncable;
  return { tabs: syncable, hiddenCount: hidden };
}

function isCanvasUrl(url) {
  if (!url) return false;
  return CANVAS_URL_PATTERNS.some((re) => re.test(url));
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return true;
  } catch (err) {
    console.warn("[Syncroll] Injection failed for tab", tabId, err.message);
    return false;
  }
}

async function injectMainWorldScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-main.js"],
      world: "MAIN",
      injectImmediately: true,
    });
    return true;
  } catch (err) {
    console.warn("[Syncroll] MAIN world injection failed for tab", tabId, err.message);
    return false;
  }
}

// ── Dropdown rendering & selection ─────────────────────────────────────

const TRANSPARENT_PIXEL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

function setFavicon(imgEl, src) {
  imgEl.src = src || TRANSPARENT_PIXEL;
}

function updateTriggerLabel(side) {
  const tabId = selection[side];
  const tab = allTabs.find((t) => t.id === tabId)
           || (tabId != null ? { id: tabId, title: "(closed tab)", url: "", favIconUrl: "" } : null);

  if (tab && allTabs.some((t) => t.id === tab.id)) {
    DOM.titles[side].textContent = truncate(tab.title || "(untitled)", 44);
    DOM.triggers[side].title = tab.url || "";
    setFavicon(DOM.favicons[side], tab.favIconUrl);
  } else {
    DOM.titles[side].textContent = "Choose a tab…";
    DOM.triggers[side].title = "";
    setFavicon(DOM.favicons[side], null);
  }
}

function renderDropdown(side) {
  const list = DOM.lists[side];
  const excludeId = selection[otherSide(side)];
  const selectedId = selection[side];

  list.innerHTML = "";

  if (allTabs.length === 0) {
    const li = document.createElement("li");
    li.className = "dropdown-option";
    li.textContent = "No syncable tabs open.";
    li.style.color = "#6a6a88";
    li.style.cursor = "default";
    list.appendChild(li);
    return;
  }

  for (const tab of allTabs) {
    if (tab.id === excludeId) continue;

    const li = document.createElement("li");
    li.className = "dropdown-option";
    li.setAttribute("role", "option");
    li.tabIndex = -1;
    li.dataset.tabId = String(tab.id);
    if (tab.id === selectedId) li.setAttribute("aria-selected", "true");

    const fav = document.createElement("img");
    fav.className = "favicon";
    fav.alt = "";
    fav.width = 16;
    fav.height = 16;
    fav.src = tab.favIconUrl || TRANSPARENT_PIXEL;
    fav.addEventListener("error", () => { fav.src = TRANSPARENT_PIXEL; });

    const text = document.createElement("span");
    text.className = "opt-text";
    const title = document.createElement("span");
    title.className = "opt-title";
    title.textContent = tab.title || "(untitled)";
    const url = document.createElement("span");
    url.className = "opt-url";
    url.textContent = getDomain(tab.url);
    text.append(title, url);

    li.title = tab.url || "";
    li.append(fav, text);
    li.addEventListener("click", () => onOptionClick(side, tab.id));
    list.appendChild(li);
  }
}

function setSelection(side, tabId) {
  selection[side] = tabId;
  pairedTabs[side] = tabId;
  updateTriggerLabel(side);
  updateSyncButtonEnabled();
}

function updateSyncButtonEnabled() {
  if (isSynced) return;
  const ok = selection.left != null
          && selection.right != null
          && selection.left !== selection.right;
  DOM.btnSync.disabled = !ok;
}

function setControlsDisabled(disabled) {
  DOM.triggers.left.disabled = disabled;
  DOM.triggers.right.disabled = disabled;
  DOM.openNewWindow.disabled = disabled;
}

// ── Dropdown open/close ────────────────────────────────────────────────

function openDropdown(side) {
  const other = otherSide(side);
  if (dropdownOpen[other]) closeDropdown(other);

  renderDropdown(side);
  DOM.lists[side].hidden = false;
  DOM.triggers[side].setAttribute("aria-expanded", "true");
  dropdownOpen[side] = true;

  const selected = DOM.lists[side].querySelector('[aria-selected="true"]');
  const first = DOM.lists[side].querySelector('[role="option"]');
  (selected || first)?.focus();
}

function closeDropdown(side) {
  DOM.lists[side].hidden = true;
  DOM.triggers[side].setAttribute("aria-expanded", "false");
  dropdownOpen[side] = false;
}

function closeAllDropdowns() {
  closeDropdown("left");
  closeDropdown("right");
}

function onTriggerClick(side) {
  if (DOM.triggers[side].disabled) return;
  if (dropdownOpen[side]) closeDropdown(side);
  else openDropdown(side);
}

function onOptionClick(side, tabId) {
  setSelection(side, tabId);
  closeDropdown(side);
  DOM.triggers[side].focus();
}

function onDropdownKeydown(e, side) {
  const list = DOM.lists[side];
  const options = Array.from(list.querySelectorAll('[role="option"]'));
  if (options.length === 0) return;

  const current = document.activeElement?.closest('[role="option"]');
  const idx = current ? options.indexOf(current) : -1;

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      options[Math.min(idx + 1, options.length - 1)]?.focus();
      break;
    case "ArrowUp":
      e.preventDefault();
      options[Math.max(idx - 1, 0)]?.focus();
      break;
    case "Home":
      e.preventDefault();
      options[0]?.focus();
      break;
    case "End":
      e.preventDefault();
      options[options.length - 1]?.focus();
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      if (current) onOptionClick(side, Number(current.dataset.tabId));
      break;
    case "Escape":
      e.preventDefault();
      closeDropdown(side);
      DOM.triggers[side].focus();
      break;
    case "Tab":
      closeDropdown(side);
      break;
  }
}

// ── Scroll alignment preference ────────────────────────────────────────

function renderSyncBy(value) {
  const syncBy = value === "pixel" ? "pixel" : "percent";
  for (const radio of DOM.syncByRadios) {
    radio.checked = radio.value === syncBy;
  }
  DOM.syncByHint.textContent = SYNC_BY_HINTS[syncBy];
}

async function loadSyncBy() {
  try {
    const stored = await chrome.storage.sync.get(SYNC_BY_KEY);
    renderSyncBy(stored[SYNC_BY_KEY]);
  } catch (_) {
    renderSyncBy("percent");
  }
}

async function onSyncByChange(e) {
  renderSyncBy(e.target.value);
  try {
    await chrome.storage.sync.set({ [SYNC_BY_KEY]: e.target.value });
  } catch (err) {
    console.warn("[Syncroll] Saving scroll alignment failed:", err);
  }
}

// ── "Open in new window" — two side-by-side windows ────────────────────

async function openInSideBySideWindows(leftTabId, rightTabId) {
  const availLeft   = window.screen.availLeft   ?? 0;
  const availTop    = window.screen.availTop    ?? 0;
  const availWidth  = window.screen.availWidth  || 1280;
  const availHeight = window.screen.availHeight || 800;
  const halfW = Math.floor(availWidth / 2);

  const leftRect  = { left: availLeft,         top: availTop, width: halfW,              height: availHeight };
  const rightRect = { left: availLeft + halfW, top: availTop, width: availWidth - halfW, height: availHeight };

  // Delegate the actual window creation + positioning to the background
  // service worker. The popup is anchored to one of the source windows,
  // which can empty (and therefore close) once we move its only tab to a
  // new window — that kills the popup mid-flow. The background service
  // worker is persistent, so it can finish positioning both windows
  // even after the popup dies.
  await chrome.runtime.sendMessage({
    type: "OPEN_SIDE_BY_SIDE",
    tabIds: [leftTabId, rightTabId],
    leftRect,
    rightRect,
  });
}

// ── Init: restore state or detect panes ────────────────────────────────

(async function init() {
  loadSyncBy();

  // If background is already syncing, restore that UI directly.
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (state?.syncing && state.tabIds?.length === 2) {
      const fetched = await Promise.all([
        chrome.tabs.get(state.tabIds[0]).catch(() => null),
        chrome.tabs.get(state.tabIds[1]).catch(() => null),
      ]);
      const valid = fetched.filter(Boolean).sort((a, b) => a.index - b.index);
      const leftTab  = valid[0] || fetched[0];
      const rightTab = valid[1] || fetched[1];

      allTabs = fetched.filter(Boolean);
      selection.left  = leftTab?.id  ?? state.tabIds[0];
      selection.right = rightTab?.id ?? state.tabIds[1];
      pairedTabs.left  = selection.left;
      pairedTabs.right = selection.right;

      updateTriggerLabel("left");
      updateTriggerLabel("right");

      isSynced = true;
      DOM.btnSync.textContent = "Stop Syncing";
      DOM.btnSync.classList.add("active");
      DOM.btnSync.disabled = false;
      setControlsDisabled(true);
      setStatus("Synced — scroll either pane!", "success");
      return;
    }
  } catch (_) {
    // Background not ready — fall through to fresh detection.
  }

  // Fresh state: fetch tabs and detect Split View panes in parallel.
  const [{ hiddenCount }, panes] = await Promise.all([
    fetchSyncableTabs(),
    detectPanes(),
  ]);

  DOM.triggers.left.disabled  = false;
  DOM.triggers.right.disabled = false;

  // Pre-fill from Split View detection if both tabs are syncable.
  if (panes.left && allTabs.some((t) => t.id === panes.left.id)) {
    selection.left  = panes.left.id;
    pairedTabs.left = panes.left.id;
  }
  if (panes.right && allTabs.some((t) => t.id === panes.right.id)) {
    selection.right  = panes.right.id;
    pairedTabs.right = panes.right.id;
  }

  // If no left selection yet, fall back to the active tab (when syncable).
  if (selection.left == null) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && allTabs.some((t) => t.id === active.id)) {
      selection.left  = active.id;
      pairedTabs.left = active.id;
    }
  }

  updateTriggerLabel("left");
  updateTriggerLabel("right");

  if (hiddenCount > 0) {
    DOM.hints.left.textContent =
      `${hiddenCount} system tab${hiddenCount === 1 ? "" : "s"} hidden (chrome://, Web Store).`;
  }

  updateSyncButtonEnabled();
  setStatus(
    selection.left != null && selection.right != null
      ? "Ready — click to sync."
      : "Choose two tabs to sync.",
    "info",
  );
})();

// ── Sync / Unsync toggle ───────────────────────────────────────────────

DOM.btnSync.addEventListener("click", async () => {
  // ── UNSYNC ──
  if (isSynced) {
    await chrome.runtime.sendMessage({ type: "STOP_SYNC" });
    isSynced = false;
    DOM.btnSync.textContent = "Sync Split Panes";
    DOM.btnSync.classList.remove("active");
    setControlsDisabled(false);
    updateSyncButtonEnabled();
    setStatus("Sync stopped.", "info");
    return;
  }

  // ── SYNC ──
  if (selection.left == null
      || selection.right == null
      || selection.left === selection.right) {
    return;
  }

  DOM.btnSync.disabled = true;
  setStatus("Injecting scripts…", "info");

  const leftId  = selection.left;
  const rightId = selection.right;

  const [leftOk, rightOk] = await Promise.all([
    injectContentScript(leftId),
    injectContentScript(rightId),
  ]);

  if (!leftOk || !rightOk) {
    setStatus(
      "Injection failed — can't sync chrome:// or Web Store pages.",
      "error",
    );
    DOM.btnSync.disabled = false;
    return;
  }

  // Pre-emptive MAIN world injection for known canvas URLs.
  const [leftTabInfo, rightTabInfo] = await Promise.all([
    chrome.tabs.get(leftId).catch(() => null),
    chrome.tabs.get(rightId).catch(() => null),
  ]);
  if (leftTabInfo  && isCanvasUrl(leftTabInfo.url))  await injectMainWorldScript(leftId);
  if (rightTabInfo && isCanvasUrl(rightTabInfo.url)) await injectMainWorldScript(rightId);

  // Tell background which two tabs to relay between.
  await chrome.runtime.sendMessage({
    type: "START_SYNC",
    tabIds: [leftId, rightId],
  });

  isSynced = true;
  DOM.btnSync.textContent = "Stop Syncing";
  DOM.btnSync.classList.add("active");
  DOM.btnSync.disabled = false;
  setControlsDisabled(true);

  // Move tabs into side-by-side windows AFTER START_SYNC, because the
  // window-create call may steal focus from the popup.
  if (DOM.openNewWindow.checked) {
    setStatus("Opening side-by-side windows…", "info");
    try {
      await openInSideBySideWindows(leftId, rightId);
    } catch (err) {
      console.warn("[Syncroll] openInSideBySideWindows failed:", err);
      setStatus("Sync active — couldn't open new windows.", "info");
      return;
    }
  }

  setStatus("Synced — scroll either pane!", "success");
});

// ── Scroll alignment wiring ────────────────────────────────────────────

for (const radio of DOM.syncByRadios) {
  radio.addEventListener("change", onSyncByChange);
}

// ── Dropdown event wiring ──────────────────────────────────────────────

DOM.triggers.left.addEventListener("click",  () => onTriggerClick("left"));
DOM.triggers.right.addEventListener("click", () => onTriggerClick("right"));

DOM.lists.left.addEventListener("keydown",  (e) => onDropdownKeydown(e, "left"));
DOM.lists.right.addEventListener("keydown", (e) => onDropdownKeydown(e, "right"));

// Click outside any picker closes all dropdowns.
document.addEventListener("click", (e) => {
  if (e.target.closest(".pane-picker")) return;
  closeAllDropdowns();
});

// Esc from anywhere closes open dropdowns.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (dropdownOpen.left || dropdownOpen.right) {
    closeAllDropdowns();
  }
});

// ── Keep dropdown data in sync with tab events ─────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (isSynced) return;
  await fetchSyncableTabs();
  let changed = false;
  if (selection.left === tabId)  { selection.left  = null; pairedTabs.left  = null; updateTriggerLabel("left");  changed = true; }
  if (selection.right === tabId) { selection.right = null; pairedTabs.right = null; updateTriggerLabel("right"); changed = true; }
  if (dropdownOpen.left)  renderDropdown("left");
  if (dropdownOpen.right) renderDropdown("right");
  if (changed) updateSyncButtonEnabled();
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if (isSynced) return;
  if (!("title" in changeInfo) && !("url" in changeInfo) && !("favIconUrl" in changeInfo)) return;
  await fetchSyncableTabs();
  updateTriggerLabel("left");
  updateTriggerLabel("right");
  if (dropdownOpen.left)  renderDropdown("left");
  if (dropdownOpen.right) renderDropdown("right");
});
