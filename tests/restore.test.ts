import { describe, it, expect } from "bun:test";
import { chrome } from "./mocks/chrome.js";
import { restoreSession, buildPlaceholderUrl } from "../src/lib/restore.js";
import type { Session, SavedTab } from "../src/lib/types.js";

globalThis.chrome = chrome;

function tab(url: string, overrides: any = {}): SavedTab {
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

function session(tabCount: number, url = "https://example.com"): Session {
  return {
    id: "sess-1",
    version: 2,
    source: "user",
    name: "S",
    createdAt: 1000,
    tabCount,
    windowCount: 1,
    groupCount: 0,
    windows: [{ index: 0, state: "normal", width: 800, height: 600, top: 0, left: 0, focused: true, tabs: Array.from({ length: tabCount }, (_, i) => tab(url, { index: i, active: i === 0 })) }],
    groups: [],
  };
}

const settings = (overrides: any = {}) => ({
  restoreMode: "auto" as const,
  autoDiscardEnabled: false,
  placeholderThreshold: 250,
  fastThreshold: 80,
  delayBetweenTabsMs: 1,
  delayBetweenWindowsMs: 0,
  batchSize: 1000,
  batchPauseMs: 0,
  restoreInNewWindow: true,
  ...overrides,
});

describe("restore", () => {
  it("buildPlaceholderUrl encodes sessionId and tabKey", () => {
    const savedTab: SavedTab = { url: "https://example.com", title: "T", index: 0, pinned: false, active: false, muted: false, groupId: -1, groupKey: null, favIconUrl: "", tabKey: "sess-1-w0-t0" };
    const url = buildPlaceholderUrl(savedTab, { id: "sess-1", windows: [], groups: [] } as Session);
    expect(url).toContain("sessionId=sess-1");
    expect(url).toContain("tabKey=sess-1-w0-t0");
    expect(url).toContain("src/pages/placeholder.html");
  });

  it("selects fast mode below the fast threshold", async () => {
    const report = await restoreSession(session(10), settings());
    expect(report.mode).toBe("fast");
  });

  it("selects placeholder mode above the placeholder threshold", async () => {
    const report = await restoreSession(session(300), settings());
    expect(report.mode).toBe("placeholder");
  });

  it("selects throttled mode between thresholds", async () => {
    const report = await restoreSession(session(150), settings());
    expect(report.mode).toBe("throttled");
  });

  it("restores all tabs and reports counts", async () => {
    const report = await restoreSession(session(5), settings({ restoreMode: "fast" }));
    expect(report.restoredTabs).toBe(5);
    expect(report.createdWindows.length).toBe(1);
    expect(report.placeholderCount).toBe(0);
  });

  it("skips non-restorable internal URLs when skipInternalPages is on", async () => {
    const report = await restoreSession(session(1, "edge://settings"), settings({ restoreMode: "fast", skipInternalPages: true }));
    expect(report.skippedTabs.length).toBe(1);
    expect(report.skippedTabs[0].reason).toBe("internal-page");
    expect(report.restoredTabs).toBe(0);
  });

  it("rejects a session with no windows", async () => {
    const report = await restoreSession({ ...session(5), windows: [] }, settings());
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.restoredTabs).toBe(0);
  });

  it("skips windows with no tabs without erroring", async () => {
    const report = await restoreSession(session(0), settings({ restoreMode: "fast" }));
    expect(report.restoredTabs).toBe(0);
    expect(report.createdWindows.length).toBe(0);
  });
});
