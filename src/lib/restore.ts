import { isRestorableUrl, sanitizeGroupColor } from "./session-model.js";
import type { RestoreMode, RestoreReport, SavedTab, Session, Settings } from "./types.js";

const DEBUG = false;
function debug(...args: unknown[]) {
  if (DEBUG) console.log(...args);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Yield to event loop so popup / UI doesn't freeze
async function yieldToUI() {
  await new Promise((r) => setTimeout(r, 0));
}

export function buildPlaceholderUrl(savedTab: SavedTab, session: Session): string {
  const params = new URLSearchParams();
  params.set("sessionId", session.id);
  params.set("tabKey", savedTab.tabKey);
  // Fallback if storage lookup fails (e.g. session deleted)
  params.set("url", savedTab.url);
  params.set("title", savedTab.title || savedTab.url);
  return chrome.runtime.getURL(`src/pages/placeholder.html?${params.toString()}`);
}

export type RestoreProgress = (done: number, total: number, message: string) => void;

export async function restoreSession(session: Session, settings: Settings, onProgress: RestoreProgress = () => { }): Promise<RestoreReport> {
  const report: RestoreReport = {
    restoredTabs: 0,
    skippedTabs: [],
    errors: [],
    createdWindows: [],
    mode: "unknown",
    discardedCount: 0,
    placeholderCount: 0,
  };

  if (!session || !Array.isArray(session.windows) || session.windows.length === 0) {
    report.errors.push({ error: "Session has no windows. Save was empty." });
    return report;
  }

  const totalTabs = session.windows.reduce((s, w) => s + (w.tabs?.length || 0), 0);
  const requestedMode = settings.restoreMode || "auto";
  const placeholderThreshold = settings.placeholderThreshold;
  const fastThreshold = settings.fastThreshold;
  const batchSize = settings.batchSize ?? 20;
  const batchPauseMs = settings.batchPauseMs ?? 50;
  const restoreInNewWindow = settings.restoreInNewWindow !== false;

  // When restoreInNewWindow is off, restore the first window into the current
  // active window instead of spawning a new one. Later windows still spawn new.
  let currentWindowId = null;
  if (!restoreInNewWindow) {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentWindowId = currentTab?.windowId ?? null;
  }

  // Decide mode. Explicit user selection overrides automatic thresholds;
  // automatic mode preserves the original adaptive behavior.
  let mode: RestoreMode = requestedMode as RestoreMode;
  if (!["fast", "throttled", "placeholder"].includes(mode)) {
    if (totalTabs > placeholderThreshold) mode = "placeholder";
    else if (totalTabs > fastThreshold) mode = "throttled";
    else mode = "fast";
  }
  report.mode = mode;

  debug(`[EdgeSessions] Restore mode: ${mode} | totalTabs=${totalTabs} | threshold placeholder=${placeholderThreshold} fast=${fastThreshold}`);

  // Effective delays per mode
  const delayBetweenTabs =
    mode === "fast" ? 20
      : mode === "throttled" ? settings.delayBetweenTabsMs || 120
        : 10;
  const delayBetweenWindows = mode === "placeholder" ? 100 : settings.delayBetweenWindowsMs || 300;

  let done = 0;
  let tabsSinceYield = 0;

  for (let wIdx = 0; wIdx < session.windows.length; wIdx++) {
    const savedWin = session.windows[wIdx];
    if (!savedWin) continue;
    if (!savedWin.tabs || savedWin.tabs.length === 0) continue;

    // Filter
    let tabsToRestore = savedWin.tabs.filter((t) => {
      if (!t.url) {
        report.skippedTabs.push({ url: "(no url)", reason: "missing-url" });
        done++;
        return false;
      }
      if (settings.skipInternalPages && !isRestorableUrl(t.url)) {
        report.skippedTabs.push({ url: t.url, reason: "internal-page" });
        done++;
        return false;
      }
      return true;
    });

    if (tabsToRestore.length === 0) continue;

    if (settings.restorePinnedFirst) {
      tabsToRestore = [...tabsToRestore].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return a.index - b.index;
      });
    } else {
      tabsToRestore = [...tabsToRestore].sort((a, b) => a.index - b.index);
    }

    const first = tabsToRestore[0];
    if (!first) continue;

    // --- 1. CREATE WINDOW (minimal params, no bounds) ---
    let newWindow: chrome.windows.Window | undefined;
    let firstTabId: number | null = null;
    try {
      // For placeholder mode, first tab is also a placeholder
      let firstUrl = first.url;
      if (mode === "placeholder") {
        const firstGroup = (session.groups || []).find((g) => g.key === first.groupKey);
        firstUrl = buildPlaceholderUrl(first, session);
      }
      if (!restoreInNewWindow && wIdx === 0 && currentWindowId) {
        // Restore into the current active window instead of creating a new one
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
        if (activeTab) {
          await chrome.tabs.update(activeTab.id, { url: firstUrl, active: true });
          newWindow = await chrome.windows.get(currentWindowId);
          firstTabId = activeTab.id;
        } else {
          newWindow = await chrome.windows.create({ url: firstUrl, focused: true });
        }
      } else {
        newWindow = await chrome.windows.create({ url: firstUrl, focused: wIdx === 0 });
      }
    } catch (e) {
      console.error("[EdgeSessions] Failed to create restore window", {
        windowIndex: wIdx,
        url: first.url,
        error: e,
      });
      const message = e instanceof Error ? e.message : String(e);
      report.errors.push({ window: wIdx, url: first.url, error: message });
      const fallbackUrl = mode === "placeholder" ? buildPlaceholderUrl(first, session) : first.url;
      try {
        newWindow = await chrome.windows.create({ url: fallbackUrl, focused: wIdx === 0 });
      } catch (e2) {
        const message2 = e2 instanceof Error ? e2.message : String(e2);
        console.error("[EdgeSessions] Fallback restore window creation failed", {
          windowIndex: wIdx,
          url: fallbackUrl,
          error: message2,
        });
        report.errors.push({ window: wIdx, error: "Fallback failed: " + message2 });
        continue;
      }
    }

    if (!newWindow) continue;

    report.createdWindows.push(newWindow.id);

    // Apply bounds AFTER creation
    try {
      if (savedWin.state === "maximized") await chrome.windows.update(newWindow.id, { state: "maximized" });
      else if (savedWin.state === "minimized") await chrome.windows.update(newWindow.id, { state: "minimized" });
      else if (savedWin.state === "fullscreen") await chrome.windows.update(newWindow.id, { state: "fullscreen" });
      else if (savedWin.width && savedWin.height) {
        await chrome.windows.update(newWindow.id, { width: savedWin.width, height: savedWin.height, top: savedWin.top, left: savedWin.left });
      }
    } catch (e) {
      console.warn("[EdgeSessions] Failed to apply restored window bounds", {
        windowIndex: wIdx,
        windowId: newWindow.id,
        state: savedWin.state,
        error: e,
      });
    }

    // Resolve first tab ID (skip when already resolved for current-window restore)
    if (!firstTabId) {
      try {
        const tabsInNewWin = await chrome.tabs.query({ windowId: newWindow.id });
        const match = tabsInNewWin[0];
        firstTabId = match?.id ?? null;
      } catch (e) {
        console.warn("[EdgeSessions] Failed to resolve first restored tab", {
          windowIndex: wIdx,
          windowId: newWindow.id,
          error: e,
        });
      }
    }
    if (first.pinned && firstTabId) {
      try {
        await chrome.tabs.update(firstTabId, { pinned: true });
      } catch (e) {
        console.warn("[EdgeSessions] Failed to pin first restored tab", {
          windowIndex: wIdx,
          tabId: firstTabId,
          error: e,
        });
      }
    }
    // Do NOT discard first tab yet - we need it for grouping

    report.restoredTabs++;
    if (mode === "placeholder") report.placeholderCount++;
    done++;
    onProgress(done, totalTabs, `Window ${wIdx + 1}: ${first.title} [${mode}]`);

    const groupKeyToNewTabIds = new Map<string, number[]>();
    if (first.groupKey && firstTabId) groupKeyToNewTabIds.set(first.groupKey, [firstTabId]);

    // Track tabs to discard later (after grouping)
    const tabsToDiscard = [];
    // In placeholder mode, never discard - placeholders are already light
    // In normal/throttled, discard all except the originally active tab
    const activeTabUrl = tabsToRestore.find((t) => t.active)?.url;

    // --- 2. CREATE REMAINING TABS WITH BATCHING ---
    for (let i = 1; i < tabsToRestore.length; i++) {
      const tab = tabsToRestore[i];
      try {
        let urlToCreate = tab.url;
        if (mode === "placeholder") {
          const g = (session.groups || []).find((gr) => gr.key === tab.groupKey);
          urlToCreate = buildPlaceholderUrl(tab, session);
        }

        const newTab = await chrome.tabs.create({
          windowId: newWindow.id,
          url: urlToCreate,
          active: false,
          pinned: !!tab.pinned,
        });

        // Newly created tabs always receive an id in Chromium; guard
        // defensively so a missing id cannot break grouping or discard.
        const newTabId = newTab.id;
        if (newTabId === undefined) continue;

        if (tab.groupKey) {
          if (!groupKeyToNewTabIds.has(tab.groupKey)) groupKeyToNewTabIds.set(tab.groupKey, []);
          groupKeyToNewTabIds.get(tab.groupKey)?.push(newTabId);
        }

        // Mark for discard (only in non-placeholder modes)
        if (mode !== "placeholder" && settings.autoDiscardEnabled !== false) {
          // Don't discard if this is the active tab - user will land on it
          if (tab.url !== activeTabUrl) tabsToDiscard.push(newTabId);
        }

        report.restoredTabs++;
        if (mode === "placeholder") report.placeholderCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EdgeSessions] Failed to create restored tab", {
          windowIndex: wIdx,
          tabKey: tab.tabKey,
          url: tab.url,
          error: message,
        });
        report.errors.push({ url: tab.url, error: message });
        report.skippedTabs.push({ url: tab.url, reason: message });
      }

      done++;
      tabsSinceYield++;
      onProgress(done, totalTabs, `Restoring: ${tab.title} [${mode}]`);

      // Batch yield to prevent freeze
      if (tabsSinceYield >= batchSize) {
        tabsSinceYield = 0;
        await yieldToUI();
        await sleep(batchPauseMs);
      } else {
        await sleep(delayBetweenTabs);
      }
    }

    // --- 3. RE-CREATE GROUPS (BEFORE DISCARD) ---
    const groupsForWindow = (session.groups || []).filter((g) => g.windowIndex === savedWin.index);
    for (const group of groupsForWindow) {
      const tabIds = groupKeyToNewTabIds.get(group.key) || [];
      if (tabIds.length === 0) continue;
      try {
        const newGroupId = await chrome.tabs.group({
          tabIds: tabIds as [number, ...number[]],
          createProperties: { windowId: newWindow.id },
        });
        await chrome.tabGroups.update(newGroupId, {
          title: group.title || "",
          color: sanitizeGroupColor(group.color),
          collapsed: !!group.collapsed,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[EdgeSessions] Failed to restore tab group", {
          windowIndex: wIdx,
          groupKey: group.key,
          groupTitle: group.title,
          error: message,
        });
        report.errors.push({ group: group.title, error: message });
      }
      await sleep(30);
    }

    // --- 4. DISCARD INACTIVE TABS (Lazy Load) ---
    // This is what prevents OOM in normal/throttled modes.
    // Discarded tabs keep title/favicon/URL, load on click.
    if (mode !== "placeholder" && settings.autoDiscardEnabled !== false && tabsToDiscard.length > 0) {
      debug(`[EdgeSessions] Discarding ${tabsToDiscard.length} inactive tabs in window ${wIdx} to save memory`);
      // Discard in small batches, don't block restore
      for (let d = 0; d < tabsToDiscard.length; d += 10) {
        const batch = tabsToDiscard.slice(d, d + 10);
        for (const tabId of batch) {
          try {
            await chrome.tabs.discard(tabId);
            report.discardedCount++;
          } catch (e) {
            console.warn("[EdgeSessions] Failed to discard inactive restored tab", {
              windowIndex: wIdx,
              tabId,
              error: e,
            });
          }
        }
        await yieldToUI();
      }
    }

    // Also discard first tab if it's not the active one and not placeholder mode
    if (mode !== "placeholder" && settings.autoDiscardEnabled !== false && firstTabId && first.url !== activeTabUrl) {
      try {
        await chrome.tabs.discard(firstTabId);
        report.discardedCount++;
      } catch (e) {
        console.warn("[EdgeSessions] Failed to discard first restored tab", {
          windowIndex: wIdx,
          tabId: firstTabId,
          error: e,
        });
      }
    }

    // --- 5. ACTIVATE ORIGINAL ACTIVE TAB ---
    const activeTab = tabsToRestore.find((t) => t.active);
    if (activeTab) {
      try {
        const currentTabs = await chrome.tabs.query({ windowId: newWindow.id });
        // In placeholder mode, match by the tabKey embedded in the placeholder URL
        let match;
        if (mode === "placeholder") {
          match = currentTabs.find((t) => t.url && t.url.includes(activeTab.tabKey));
          if (!match) match = currentTabs[0];
        } else {
          match = currentTabs.find((t) => t.url === activeTab.url);
        }
        if (match) await chrome.tabs.update(match.id, { active: true });
      } catch (e) {
        console.warn("[EdgeSessions] Failed to activate original active tab", {
          windowIndex: wIdx,
          windowId: newWindow.id,
          url: activeTab.url,
          error: e,
        });
      }
    }

    await sleep(delayBetweenWindows);
  }

  console.log("[EdgeSessions] Restore finished:", report);
  return report;
}
