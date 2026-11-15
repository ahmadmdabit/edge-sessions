import type { GroupColor, RestoreMode, Session, Settings, SettingsPatch } from "./types.js";

export const SchemaVersion = 2;
export const StorageKeys = {
  SESSIONS: "SessionsV1",
  SETTINGS: "SettingsV1",
  AUTOSAVE: "AutosaveSnapshotV1",
} as const;

export const RestoreModes = Object.freeze({
  AUTO: "auto",
  FAST: "fast",
  THROTTLED: "throttled",
  PLACEHOLDER: "placeholder",
} as const);

export const SettingLimits = Object.freeze({
  autosaveIntervalMinutes: { min: 1, max: 120, default: 15 },
  maxUserSessions: { min: 1, max: 1000, default: 50 },
  maxAutoSessions: { min: 1, max: 1000, default: 30 },
  placeholderThreshold: { min: 10, max: 1000, default: 250 },
  fastThreshold: { min: 10, max: 200, default: 80 },
});

export const DefaultSettings: Settings = {
  autosaveEnabled: true,
  autosaveIntervalMinutes: 15,
  restoreInNewWindow: true,
  skipInternalPages: true,
  restorePinnedFirst: true,
  delayBetweenTabsMs: 120,
  delayBetweenWindowsMs: 400,
  maxUserSessions: 50,
  maxAutoSessions: 30,
  restoreMode: RestoreModes.AUTO,
  autoDiscardEnabled: true,
  placeholderThreshold: 250,
  fastThreshold: 80,
  batchSize: 20,
  batchPauseMs: 50,
  placeholderAutoLoad: true,
};

interface SettingLimit { min: number; max: number; default: number }

function clampSetting(value: unknown, limit: SettingLimit): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return limit.default;
  return Math.min(limit.max, Math.max(limit.min, Math.round(number)));
}

/**
 * Normalize persisted or user-supplied settings to the canonical schema.
 * This also repairs legacy/out-of-range values before they reach the UI.
 */
export function normalizeSettings(settings: SettingsPatch & Record<string, unknown> = {}): Settings {
  const merged = { ...DefaultSettings, ...settings } as Settings & Record<string, unknown>;
  delete merged.maxSessions;
  delete merged.adaptiveRestoreEnabled;

  for (const [key, limit] of Object.entries(SettingLimits)) {
    merged[key] = clampSetting(merged[key], limit);
  }

  if (!Object.values(RestoreModes).includes(merged.restoreMode as RestoreMode)) {
    merged.restoreMode = RestoreModes.AUTO;
  }

  if (merged.fastThreshold >= merged.placeholderThreshold) {
    merged.placeholderThreshold = Math.min(
      SettingLimits.placeholderThreshold.max,
      merged.fastThreshold + 1,
    );
  }

  return merged;
}

/**
 * Validate a settings patch before persistence. Thresholds are cross-checked
 * so a user cannot save an ambiguous or unreachable restore range.
 */
export function validateSettingsPatch(patch: SettingsPatch & Record<string, unknown> = {}) {
  const errors: string[] = [];
  const fastLimit = SettingLimits.fastThreshold;
  const placeholderLimit = SettingLimits.placeholderThreshold;
  const fastValue = clampSetting(patch.fastThreshold, fastLimit);
  const placeholderValue = clampSetting(patch.placeholderThreshold, placeholderLimit);

  if (fastValue >= placeholderValue) {
    errors.push("Fast mode threshold must be lower than the placeholder threshold.");
  }

  return {
    valid: errors.length === 0,
    errors,
    settings: normalizeSettings(patch),
  };
}

/**
 * @typedef {Object} SavedTabMeta
 * @property {string} description
 * @property {string} ogTitle
 * @property {string} ogDescription
 * @property {string} ogImage
 * @property {string} themeColor
 * @property {string} domain
 * @property {number} capturedAt
 */

/**
 * @typedef {Object} SavedTab
 * @property {string} url
 * @property {string} title
 * @property {number} index
 * @property {boolean} pinned
 * @property {boolean} active
 * @property {boolean} muted
 * @property {number} groupId
 * @property {string|null} groupKey
 * @property {string} favIconUrl
 * @property {string} tabKey - NEW: stable key for placeholder lookup: sessId-wIdx-tabIdx
 * @property {SavedTabMeta} meta - NEW: rich page meta for placeholder
 */

/**
 * @typedef {Object} SavedGroup
 * @property {string} key - Stable key: `${windowIndex}-${originalGroupId}`
 * @property {number} originalGroupId
 * @property {number} windowIndex
 * @property {string} title
 * @property {string} color - grey|blue|red|yellow|green|pink|purple|cyan|orange
 * @property {boolean} collapsed
 */

/**
 * @typedef {Object} SavedWindow
 * @property {number} index
 * @property {string} state - normal|maximized|minimized|fullscreen
 * @property {number} width
 * @property {number} height
 * @property {number} top
 * @property {number} left
 * @property {boolean} focused
 * @property {SavedTab[]} tabs
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {number} version
 * @property {string} name
 * @property {number} createdAt
 * @property {number} tabCount
 * @property {number} windowCount
 * @property {number} groupCount
 * @property {"user"|"auto"} source - Who/what created the session. "user" for
 *   manual saves, "auto" for autosave snapshots. Legacy v1 sessions default to
 *   "user" on read.
 * @property {SavedWindow[]} windows
 * @property {SavedGroup[]} groups
 */

export function createSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function validateSession(session: unknown): session is Session {
  if (!session || typeof session !== "object") return false;
  const candidate = session as Partial<Session>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.version === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "number" &&
    Array.isArray(candidate.windows) &&
    Array.isArray(candidate.groups)
  );
}

export function isRestorableUrl(url: unknown): url is string {
  if (!url || typeof url !== "string") return false;
  const blockedPrefixes = ["edge://", "chrome://", "chrome-extension://", "chrome-search://", "about:", "view-source:", "data:", "javascript:"];
  return !blockedPrefixes.some((prefix) => url.startsWith(prefix));
}

export function sanitizeGroupColor(color: string): GroupColor {
  const valid: GroupColor[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  return valid.includes(color as GroupColor) ? (color as GroupColor) : "grey";
}

export function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch (error) {
    console.warn("[EdgeSessions] Failed to extract domain from URL", { url, error });
    return "";
  }
}

export function createTabKey(sessionId: string, windowIndex: number, tabIndex: number): string {
  return `${sessionId}-w${windowIndex}-t${tabIndex}`;
}
