import { describe, it, expect, beforeEach } from "bun:test";
import { chrome } from "./mocks/chrome.js";
import { captureCurrentSession, enrichSession } from "../src/lib/capture.js";
import { addSession, getSessions } from "../src/lib/storage.js";
import type { Session, SavedTab } from "../src/lib/types.js";

globalThis.chrome = chrome;

beforeEach(() => {
  chrome.store.clear();
  chrome.messageListeners = [];
  chrome.tabStore = [];
  chrome.windowStore = [];
  chrome.groupStore = [];
});

function tab(url: string, overrides: Partial<SavedTab> = {}): SavedTab {
  return {
    url,
    title: "T",
    index: 0,
    pinned: false,
    active: false,
    muted: false,
    groupId: -1,
    groupKey: null,
    favIconUrl: "",
    tabKey: "k",
    ...overrides,
  };
}

describe("capture", () => {
  it("captureCurrentSession returns a well-formed empty session with no windows", async () => {
    const session = await captureCurrentSession("Test Session", "user", true);
    expect(session).toMatchObject({
      id: expect.any(String),
      version: 2,
      source: "user",
      name: "Test Session",
      tabCount: 0,
      restorableTabCount: 0,
      windowCount: 0,
      groupCount: 0,
      windows: [],
      groups: [],
    });
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it("captureCurrentSession captures windows and tabs from chrome.windows.getAll", async () => {
    const win = await chrome.windows.create({ focused: true });
    await chrome.tabs.create({ windowId: win.id, url: "https://example.com", title: "Example", active: true, pinned: false });
    await chrome.tabs.create({ windowId: win.id, url: "https://example.org", title: "Org", active: false, pinned: false });

    const session = await captureCurrentSession("With Tabs", "user", true);
    expect(session.windowCount).toBe(1);
    expect(session.tabCount).toBe(2);
    expect(session.windows[0].tabs[0].url).toBe("https://example.com");
    expect(session.restorableTabCount).toBe(2);
  });

  it("captureCurrentSession skips non-restorable URLs in restorableTabCount", async () => {
    const win = await chrome.windows.create({ focused: true });
    await chrome.tabs.create({ windowId: win.id, url: "https://example.com", title: "Example", active: true });
    await chrome.tabs.create({ windowId: win.id, url: "edge://settings", title: "Settings", active: false });

    const session = await captureCurrentSession("Mixed", "user", true);
    expect(session.tabCount).toBe(2);
    expect(session.restorableTabCount).toBe(1);
  });

  it("enrichSession on an unknown session id resolves without error", async () => {
    await expect(enrichSession("does-not-exist")).resolves.toBeUndefined();
  });

  it("enrichSession persists enriched meta to storage", async () => {
    const session: Session = {
      id: "enrich-1",
      version: 2,
      source: "user",
      name: "Enrich",
      createdAt: 1000,
      updatedAt: 1000,
      tabCount: 1,
      restorableTabCount: 1,
      windowCount: 1,
      groupCount: 0,
      windows: [{
        index: 0,
        state: "normal",
        width: 800,
        height: 600,
        top: 0,
        left: 0,
        focused: true,
        tabs: [tab("https://example.com", { tabId: 1, tabKey: "enrich-1-w0-t0" })],
      }],
      groups: [],
    };
    await addSession(session);
    await enrichSession("enrich-1");
    const stored = await getSessions();
    const enriched = stored.find((s) => s.id === "enrich-1");
    expect(enriched?.windows[0]?.tabs[0]?.meta).toBeDefined();
    expect(enriched?.windows[0]?.tabs[0]?.meta?.domain).toBe("example.com");
  });
});
