import { describe, it, expect } from "bun:test";
import {
  SchemaVersion,
  StorageKeys,
  DefaultSettings,
  RestoreModes,
  normalizeSettings,
  validateSettingsPatch,
  validateSession,
  isRestorableUrl,
  sanitizeGroupColor,
  getDomainFromUrl,
  createTabKey,
} from "../src/lib/session-model.js";

describe("session-model", () => {
  it("exposes schema version 2 and storage keys", () => {
    expect(SchemaVersion).toBe(2);
    expect(StorageKeys.SESSIONS).toBe("SessionsV1");
    expect(StorageKeys.SETTINGS).toBe("SettingsV1");
    expect(StorageKeys.AUTOSAVE).toBe("AutosaveSnapshotV1");
  });

  it("normalizeSettings fills defaults and clamps numeric limits", () => {
    const settings = normalizeSettings({ autosaveIntervalMinutes: 999, fastThreshold: 50 });
    expect(settings.autosaveIntervalMinutes).toBe(120);
    expect(settings.fastThreshold).toBe(50);
    expect(settings.placeholderThreshold).toBeGreaterThan(settings.fastThreshold);
    expect(settings.restoreMode).toBe("auto");
  });

  it("normalizeSettings repairs an inverted fast/placeholder range", () => {
    const settings = normalizeSettings({ fastThreshold: 240, placeholderThreshold: 10 });
    expect(settings.fastThreshold).toBe(200);
    expect(settings.placeholderThreshold).toBe(201);
  });

  it("normalizeSettings rejects unknown restore modes", () => {
    const settings = normalizeSettings({ restoreMode: "bogus" as any });
    expect(settings.restoreMode).toBe("auto");
  });

  it("normalizeSettings removes legacy keys", () => {
    const settings = normalizeSettings({ maxSessions: 999, adaptiveRestoreEnabled: true } as any);
    expect(settings.maxUserSessions).toBe(50);
    expect((settings as any).maxSessions).toBeUndefined();
    expect((settings as any).adaptiveRestoreEnabled).toBeUndefined();
  });

  it("DefaultSettings matches documented defaults", () => {
    expect(DefaultSettings.autosaveEnabled).toBe(true);
    expect(DefaultSettings.autosaveIntervalMinutes).toBe(15);
    expect(DefaultSettings.maxUserSessions).toBe(50);
    expect(DefaultSettings.maxAutoSessions).toBe(30);
    expect(DefaultSettings.fastThreshold).toBe(80);
    expect(DefaultSettings.placeholderThreshold).toBe(250);
  });

  it("RestoreModes exposes the four modes", () => {
    expect(RestoreModes.AUTO).toBe("auto");
    expect(RestoreModes.FAST).toBe("fast");
    expect(RestoreModes.THROTTLED).toBe("throttled");
    expect(RestoreModes.PLACEHOLDER).toBe("placeholder");
  });

  it("validateSettingsPatch requires fast below placeholder", () => {
    const result = validateSettingsPatch({ fastThreshold: 100, placeholderThreshold: 50 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validateSettingsPatch accepts a valid range", () => {
    const result = validateSettingsPatch({ fastThreshold: 10, placeholderThreshold: 20 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validateSession accepts well-formed sessions", () => {
    expect(validateSession({ id: "sess-1", version: 2, name: "S", createdAt: 1000, windows: [], groups: [] })).toBe(true);
    expect(validateSession(null)).toBe(false);
    expect(validateSession({ windows: [] } as any)).toBe(false);
    expect(validateSession("not an object")).toBe(false);
    expect(validateSession({ id: "sess-1", version: 2, name: "S", createdAt: 1000, windows: [] } as any)).toBe(false);
    expect(validateSession({ id: "sess-1", version: 2, name: "S", windows: [], groups: [] } as any)).toBe(false);
  });

  it("isRestorableUrl blocks internal pages", () => {
    expect(isRestorableUrl("https://example.com")).toBe(true);
    expect(isRestorableUrl("edge://settings")).toBe(false);
    expect(isRestorableUrl("chrome://flags")).toBe(false);
    expect(isRestorableUrl("about:blank")).toBe(false);
    expect(isRestorableUrl("")).toBe(false);
  });

  it("sanitizeGroupColor falls back to grey", () => {
    expect(sanitizeGroupColor("blue")).toBe("blue");
    expect(sanitizeGroupColor("neon") as any).toBe("grey");
  });

  it("getDomainFromUrl strips www and handles errors", () => {
    expect(getDomainFromUrl("https://www.example.com/path")).toBe("example.com");
    expect(getDomainFromUrl("https://sub.example.com")).toBe("sub.example.com");
    expect(getDomainFromUrl("not-a-url")).toBe("");
  });

  it("createTabKey builds a stable key", () => {
    expect(createTabKey("sess-1", 0, 2)).toBe("sess-1-w0-t2");
    expect(createTabKey("sess-1", 3, 0)).toBe("sess-1-w3-t0");
  });
});
