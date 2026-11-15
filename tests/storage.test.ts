import { describe, it, expect, beforeEach } from "bun:test";
import { chrome } from "./mocks/chrome.js";
import {
  StorageKeys,
  addSession,
  getSessions,
  deleteSession,
  getSessionById,
  renameSession,
  ensureQuota,
  getSettings,
  updateSettings,
  normalizeSettings,
} from "../src/lib/storage.js";
import { SchemaVersion, StorageKeys } from "../src/lib/session-model.js";

globalThis.chrome = chrome;

function freshSession(overrides: any = {}) {
  return {
    id: overrides.id ?? "sess-1",
    version: SchemaVersion,
    source: "user" as const,
    name: overrides.name ?? "Session",
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.createdAt ?? 1000,
    tabCount: 0,
    windowCount: 0,
    groupCount: 0,
    windows: [],
    groups: [],
    ...overrides,
  };
}

beforeEach(() => {
  chrome.store.clear();
});

describe("storage", () => {
  it("getSessions returns empty when nothing stored", async () => {
    expect(await getSessions()).toEqual([]);
  });

  it("getSessions drops unsupported schema versions", async () => {
    await chrome.storage.local.set({ [StorageKeys.SESSIONS]: [{ id: "old", version: 1, windows: [], groups: [] }] });
    expect(await getSessions()).toEqual([]);
  });

  it("getSessions defaults legacy source to user", async () => {
    await chrome.storage.local.set({ [StorageKeys.SESSIONS]: [{ id: "a", version: SchemaVersion, windows: [], groups: [] }] });
    const sessions = await getSessions();
    expect(sessions[0].source).toBe("user");
  });

  it("addSession prepends and prunes by source independently", async () => {
    const userSessions = Array.from({ length: 55 }, (_, i) => freshSession({ id: `u${i}`, source: "user", createdAt: i, name: `U${i}` }));
    for (const s of userSessions) await addSession(s);
    const sessions = await getSessions();
    const userCount = sessions.filter((s) => s.source === "user").length;
    expect(userCount).toBeLessThanOrEqual(50);
    expect(sessions[0].id).toBe("u54");
  });

  it("autosaves cannot evict user saves", async () => {
    const userSessions = Array.from({ length: 50 }, (_, i) => freshSession({ id: `u${i}`, source: "user", createdAt: i, name: `U${i}` }));
    for (const s of userSessions) await addSession(s);
    const autoSessions = Array.from({ length: 35 }, (_, i) => freshSession({ id: `a${i}`, source: "auto", createdAt: 1000 + i, name: `A${i}` }));
    for (const s of autoSessions) await addSession(s);
    const sessions = await getSessions();
    expect(sessions.filter((s) => s.source === "user").length).toBe(50);
    expect(sessions.filter((s) => s.source === "auto").length).toBeLessThanOrEqual(30);
  });

  it("deleteSession removes a session", async () => {
    await addSession(freshSession({ id: "keep" }));
    await addSession(freshSession({ id: "drop" }));
    await deleteSession("drop");
    const sessions = await getSessions();
    expect(sessions.map((s) => s.id)).toEqual(["keep"]);
  });

  it("renameSession updates name and timestamp", async () => {
    await addSession(freshSession({ id: "r", name: "Old", createdAt: 100 }));
    const result = await renameSession("r", "New");
    expect(result?.name).toBe("New");
    expect(result?.updatedAt).toBeGreaterThan(100);
  });

  it("getSessionById returns null for missing id", async () => {
    expect(await getSessionById("missing")).toBeNull();
  });

  it("updateSettings validates thresholds", async () => {
    await expect(updateSettings({ fastThreshold: 200, placeholderThreshold: 10 })).rejects.toThrow();
  });

  it("updateSettings persists and normalizes", async () => {
    const result = await updateSettings({ autosaveIntervalMinutes: 30 });
    expect(result.autosaveIntervalMinutes).toBe(30);
    const loaded = await getSettings();
    expect(loaded.autosaveIntervalMinutes).toBe(30);
  });

  it("ensureQuota prunes to 10 when over budget", async () => {
    // Force storage over the 8.5 MB threshold by storing a large blob.
    await chrome.storage.local.set({ [StorageKeys.SESSIONS]: [{ id: "big", version: SchemaVersion, windows: [], groups: [], data: "x".repeat(9_000_000) }] });
    const pruned = await ensureQuota();
    expect(pruned).toBe(true);
    const sessions = await getSessions();
    expect(sessions.length).toBeLessThanOrEqual(10);
  });
});
