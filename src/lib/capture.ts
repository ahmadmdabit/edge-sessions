import type { SavedTabMeta, Session, SessionSource } from "./types.js";

interface PageMeta {
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  themeColor: string;
  h1: string;
}

const DEBUG = false;
function debug(...args: unknown[]) {
  if (DEBUG) console.log(...args);
}

// Run scripting on a tab with a hard timeout so one unresponsive tab
// (chrome://, edge://, PDF, blocked page) cannot stall the whole capture.
interface ScriptResult<T> { result?: T }

async function executeScriptWithTimeout<T>(
  target: { tabId: number },
  func: () => T,
  timeoutMs = 3000,
): Promise<ScriptResult<T>[] | undefined> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timerId = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const script = chrome.scripting.executeScript({ target, func }).then((results) =>
    results as ScriptResult<T>[],
  ).catch((error: unknown) => {
    console.warn("[EdgeSessions] executeScript failed", { target, error });
    return undefined;
  });

  try {
    // A timeout is an expected, recoverable condition here. Resolve to an
    // empty result instead of rejecting so a stopped MV3 worker cannot leave
    // an unhandled timer rejection behind.
    return await Promise.race([script, timeout]);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

import { SchemaVersion, createSessionId, isRestorableUrl, createTabKey, getDomainFromUrl } from "./session-model.js";
import { getSessions, saveSessionsList, getSessionById } from "./storage.js";

// This function runs IN the page to extract meta. Must be self-contained, no imports.
// Separate lookups for name= and property=
function extractPageMeta(): PageMeta {
  try {
    const byName = (name: string) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || "";
    const byProp = (prop: string) => document.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") || "";
    const description = byName("description") || byProp("og:description") || "";
    const ogImage = byProp("og:image") || "";
    const themeColor = byName("theme-color") || "";
    let fallbackDesc = "";
    if (!description) {
      const p = document.querySelector<HTMLElement>("main p, article p");
      if (p) fallbackDesc = (p.innerText || p.textContent || "").trim().slice(0, 280);
    }
    return {
      description: description || fallbackDesc,
      ogTitle: byProp("og:title"),
      ogDescription: byProp("og:description"),
      ogImage,
      themeColor,
      h1: document.querySelector("h1")?.innerText?.slice(0, 120) || "",
    };
  } catch (e) {
    console.warn("[EdgeSessions] Page metadata extraction failed", { error: e });
    return { description: "", ogTitle: "", ogDescription: "", ogImage: "", themeColor: "", h1: "" };
  }
}

export async function captureCurrentSession(name: string, source: SessionSource = "user", skipMeta = false): Promise<Session> {
  const sessionId = createSessionId();
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  let allGroups: chrome.tabGroups.TabGroup[] = [];
  try {
    allGroups = await chrome.tabGroups.query({});
  } catch (e) {
    console.warn("[EdgeSessions] Failed to query tab groups during capture", { sessionId, error: e });
    allGroups = [];
  }
  const windowIdToIndex = new Map();
  windows.forEach((w, idx) => windowIdToIndex.set(w.id, idx));
  const groupIdToKey = new Map();
  const savedGroups = allGroups.map((g) => {
    const windowIndex = windowIdToIndex.get(g.windowId) ?? 0;
    const key = `w${windowIndex}-g${g.id}`;
    groupIdToKey.set(g.id, key);
    return {
      key,
      originalGroupId: g.id,
      windowIndex,
      title: g.title || "",
      color: g.color || "grey",
      collapsed: !!g.collapsed,
    };
  });
  const savedWindows = [];
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
    const win = windows[windowIndex];
    if (!win.tabs || win.tabs.length === 0) continue;
    const sortedTabs = [...win.tabs].sort((a, b) => a.index - b.index);
    const savedTabs = [];
    for (let i = 0; i < sortedTabs.length; i += 5) {
      const batch = sortedTabs.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(async (tab) => {
          let pageMeta: PageMeta = { description: "", ogTitle: "", ogDescription: "", ogImage: "", themeColor: "", h1: "" };
          if (!skipMeta) {
            if (tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
              try {
                const results = await executeScriptWithTimeout({ tabId: tab.id }, extractPageMeta);
                if (results?.[0]?.result) {
                  pageMeta = results[0].result;
                  debug(`[EdgeSessions] Meta for ${tab.url}:`, pageMeta.description?.slice(0, 60));
                }
              } catch (e) {
                console.warn("[EdgeSessions] Metadata capture failed", {
                  sessionId,
                  tabId: tab.id,
                  url: tab.url,
                  error: e,
                });
              }
            } else {
              debug(`[EdgeSessions] Skipped meta for non-http: ${tab.url}`);
            }
          }
          const tabKey = createTabKey(sessionId, windowIndex, tab.index);
          const domain = getDomainFromUrl(tab.url || "");
          return {
            // Live tab id is required for the later best-effort enrichment
            // pass. It is not part of the restore contract.
            tabId: tab.id,
            url: tab.url || "",
            title: tab.title || pageMeta.ogTitle || pageMeta.h1 || tab.url || "Untitled",
            index: tab.index,
            pinned: !!tab.pinned,
            active: !!tab.active,
            muted: !!tab.mutedInfo?.muted,
            audible: !!tab.audible,
            groupId: tab.groupId ?? -1,
            groupKey: tab.groupId !== -1 ? groupIdToKey.get(tab.groupId) || null : null,
            favIconUrl: tab.favIconUrl || "",
            tabKey,
            meta: {
              description: pageMeta.description || pageMeta.ogDescription || "",
              ogTitle: pageMeta.ogTitle || "",
              ogDescription: pageMeta.ogDescription || "",
              ogImage: pageMeta.ogImage || "",
              themeColor: pageMeta.themeColor || "",
              domain,
              h1: pageMeta.h1 || "",
              capturedAt: Date.now(),
            },
          };
        }),
      );
      savedTabs.push(...batchResults);
    }
    savedWindows.push({
      index: windowIndex,
      originalWindowId: win.id,
      state: win.state || "normal",
      width: win.width || 1200,
      height: win.height || 800,
      top: win.top || 0,
      left: win.left || 0,
      focused: !!win.focused,
      incognito: !!win.incognito,
      tabs: savedTabs,
    });
  }
  const tabCount = savedWindows.reduce((s, w) => s + w.tabs.length, 0);
  const restorableCount = savedWindows.reduce((s, w) => s + w.tabs.filter((t) => isRestorableUrl(t.url)).length, 0);
  return {
    id: sessionId,
    version: SchemaVersion,
    source,
    name: name || `Session ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tabCount,
    restorableTabCount: restorableCount,
    windowCount: savedWindows.length,
    groupCount: savedGroups.length,
    windows: savedWindows,
    groups: savedGroups,
  };
}

/**
 * Background enrichment: add page meta (OG title, description, image, etc.) to
 * a previously quick-saved session by running chrome.scripting.executeScript on
 * each tab. Runs fire-and-forget from the service worker. Tabs that block
 * scripting (CSP, chrome://, PDF, closed) are silently skipped; the save is
 * already durable without them.
 */
export async function enrichSession(sessionId: string): Promise<void> {
  const session = await getSessionById(sessionId);
  if (!session) return;

  let changed = false;

  for (const win of session.windows || []) {
    for (const tab of win.tabs || []) {
      if (!tab.url || !tab.url.startsWith("http")) continue;
      // Legacy sessions saved before tab ids were persisted cannot be enriched.
      const tabId = tab.tabId;
      if (!Number.isInteger(tabId) || tabId === undefined || tabId < 0) continue;
      // Skip tabs that already have meaningful meta (re-enrich guard)
      if (tab.meta?.description || tab.meta?.ogTitle) continue;

      try {
        const results = await executeScriptWithTimeout({ tabId }, extractPageMeta);
        if (results?.[0]?.result) {
          const meta = results[0].result;
          tab.meta = {
            description: meta.description || "",
            ogTitle: meta.ogTitle || "",
            ogDescription: meta.ogDescription || "",
            ogImage: meta.ogImage || "",
            themeColor: meta.themeColor || "",
            domain: getDomainFromUrl(tab.url || ""),
            h1: meta.h1 || "",
            capturedAt: Date.now(),
          };
          if (meta.ogTitle) tab.title = meta.ogTitle || tab.title;
          changed = true;
        }
      } catch (e) {
        console.warn("[EdgeSessions] Session enrichment failed for tab", {
          sessionId,
          tabId: tab.tabId,
          url: tab.url,
          error: e,
        });
      }
    }
  }

  if (!changed) return;

  // Persist enriched session back to storage
  await (async () => {
    const sessions = await getSessions();
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx !== -1) {
      sessions[idx] = session;
      await saveSessionsList(sessions);
    }
  })();

  // Notify popups so they can refresh meta display if open
  chrome.runtime.sendMessage({ type: "SessionEnriched", sessionId }).catch((e) => {
    console.warn("[EdgeSessions] Failed to notify popup of session enrichment", { sessionId, error: e });
  });
}
