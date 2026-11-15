import { describe, it, expect, beforeEach, vi } from "bun:test";
import { chrome } from "./mocks/chrome.js";
import { handleRuntimeMessage } from "../src/background/service-worker.js";
import type { RuntimeRequest, RuntimeResponse } from "../src/lib/messages.js";

globalThis.chrome = chrome;

beforeEach(() => {
  chrome.store.clear();
  chrome.messageListeners = [];
});

async function sendMessage(msg: RuntimeRequest): Promise<RuntimeResponse> {
  return new Promise((resolve) => {
    void handleRuntimeMessage(msg, (response) => resolve(response as RuntimeResponse));
  });
}

describe("message router", () => {
  it("GetSessions returns empty list initially", async () => {
    const res = await sendMessage({ type: "GetSessions" });
    expect(res.ok).toBe(true);
    expect(res.sessions).toEqual([]);
  });

  it("SaveCurrent persists a session and GetSessions reflects it", async () => {
    const save = await sendMessage({ type: "SaveCurrent", name: "My Session" });
    expect(save.ok).toBe(true);
    expect(save.session?.name).toBe("My Session");
    expect(save.session?.source).toBe("user");

    const list = await sendMessage({ type: "GetSessions" });
    expect(list.ok).toBe(true);
    expect(list.sessions?.length).toBe(1);
    expect(list.sessions?.[0].name).toBe("My Session");
  });

  it("GetSettings returns normalized defaults", async () => {
    const res = await sendMessage({ type: "GetSettings" });
    expect(res.ok).toBe(true);
    expect(res.settings?.autosaveEnabled).toBe(true);
    expect(res.settings?.fastThreshold).toBe(80);
  });

  it("UpdateSettings updates and returns settings", async () => {
    const res = await sendMessage({ type: "UpdateSettings", patch: { autosaveIntervalMinutes: 30 } });
    expect(res.ok).toBe(true);
    expect(res.settings?.autosaveIntervalMinutes).toBe(30);

    const current = await sendMessage({ type: "GetSettings" });
    expect(current.settings?.autosaveIntervalMinutes).toBe(30);
  });

  it("UpdateSettings rejects inverted thresholds", async () => {
    const res = await sendMessage({ type: "UpdateSettings", patch: { fastThreshold: 200, placeholderThreshold: 10 } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("threshold");
  });

  it("Delete removes a session", async () => {
    await sendMessage({ type: "SaveCurrent", name: "ToDelete" });
    const list = await sendMessage({ type: "GetSessions" });
    const id = list.sessions?.[0].id;
    const del = await sendMessage({ type: "Delete", id });
    expect(del.ok).toBe(true);
    const after = await sendMessage({ type: "GetSessions" });
    expect(after.sessions?.length).toBe(0);
  });

  it("Rename updates a session name", async () => {
    await sendMessage({ type: "SaveCurrent", name: "Old" });
    const list = await sendMessage({ type: "GetSessions" });
    const id = list.sessions?.[0].id;
    const ren = await sendMessage({ type: "Rename", id, name: "New" });
    expect(ren.ok).toBe(true);
    const after = await sendMessage({ type: "GetSessions" });
    expect(after.sessions?.[0].name).toBe("New");
  });

  it("Export returns JSON with sessions array", async () => {
    await sendMessage({ type: "SaveCurrent", name: "Exported" });
    const res = await sendMessage({ type: "Export" });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.data ?? "{}");
    expect(payload.app).toBe("EdgeSessions");
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(payload.sessions.length).toBe(1);
  });

  it("Import adds sessions and reports count/rejected", async () => {
    const valid = [{ id: "imp-1", version: 2, source: "user", name: "Imported", createdAt: 1, tabCount: 0, windowCount: 0, groupCount: 0, windows: [], groups: [] }];
    const invalid = [{ id: "bad", source: "user", name: "Bad", createdAt: 2 }]; // missing version/windows/groups
    const payload = { sessions: [...valid, ...invalid] };
    const res = await sendMessage({ type: "Import", json: JSON.stringify(payload) });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(res.rejected).toBe(1);
    const list = await sendMessage({ type: "GetSessions" });
    expect(list.sessions?.length).toBe(1);
  });

  it("rejects oversized import", async () => {
    const big = { sessions: [{ id: "x", version: 2, source: "user", name: "Big", createdAt: 1, tabCount: 0, windowCount: 0, groupCount: 0, windows: [], groups: [], padding: "x".repeat(3_000_000) }] };
    const res = await sendMessage({ type: "Import", json: JSON.stringify(big) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("too large");
  });

  it("returns an error for unknown message types", async () => {
    const res = await sendMessage({ type: "Nope" as any });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unknown message type");
  });

  it("CapturePreview returns a session without hanging", async () => {
    const res = await sendMessage({ type: "CapturePreview" });
    expect(res.ok).toBe(true);
    expect(res.session?.tabCount).toBe(0);
  });
});
