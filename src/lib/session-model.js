// Schema Version: 2
// Adds `source` ("user"|"auto") to every session so user-saved and
// auto-saved sessions share one list, can be filtered separately, and are
// pruned by independent retention caps.
// This file is imported by both background and popup via ES Modules.
// In MV3, service worker supports import.

export const SchemaVersion = 2;
export const StorageKeys = {
  SESSIONS: "SessionsV1",
  SETTINGS: "SettingsV1",
  AUTOSAVE: "AutosaveSnapshotV1",
};

export const RestoreModes = Object.freeze({
  AUTO: "auto",
  FAST: "fast",
  THROTTLED: "throttled",
  PLACEHOLDER: "placeholder",
});

export const SettingLimits = Object.freeze({
  autosaveIntervalMinutes: { min: 1, max: 120, default: 15 },
  maxUserSessions: { min: 1, max: 1000, default: 50 },
  maxAutoSessions: { min: 1, max: 1000, default: 30 },
  placeholderThreshold: { min: 10, max: 1000, default: 250 },
  fastThreshold: { min: 10, max: 200, default: 80 },
});

export const DefaultSettings = {
  autosaveEnabled: true,
  autosaveIntervalMinutes: 15,
  restoreInNewWindow: true,
  skipInternalPages: true,
  restorePinnedFirst: true,
  delayBetweenTabsMs: 120,
  delayBetweenWindowsMs: 400,

  // --- Session retention / auto-prune (isolated by save source) ---
  maxUserSessions: 50,
  maxAutoSessions: 30,

  // --- Restore processing ---
  restoreMode: RestoreModes.AUTO,
  autoDiscardEnabled: true,
  placeholderThreshold: 250,
  fastThreshold: 80,
  batchSize: 20,
  batchPauseMs: 50,
  placeholderAutoLoad: true,
};

function clampSetting(value, limit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return limit.default;
  return Math.min(limit.max, Math.max(limit.min, Math.round(number)));
}

/**
 * Normalize persisted or user-supplied settings to the canonical schema.
 * This also repairs legacy/out-of-range values before they reach the UI.
 */
export function normalizeSettings(settings = {}) {
  const merged = { ...DefaultSettings, ...settings };
  delete merged.maxSessions;
  delete merged.adaptiveRestoreEnabled;

  for (const [key, limit] of Object.entries(SettingLimits)) {
    merged[key] = clampSetting(merged[key], limit);
  }

  if (!Object.values(RestoreModes).includes(merged.restoreMode)) {
    merged.restoreMode = RestoreModes.AUTO;
  }

  // Automatic mode requires a non-empty fast range below placeholder mode.
  // Repair legacy/invalid stored values by raising the placeholder boundary;
  // this keeps the fast threshold inside its documented 10-200 range.
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
export function validateSettingsPatch(patch = {}) {
  const errors = [];
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

export function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function validateSession(session) {
  if (!session || typeof session !== "object") return false;
  if (!Array.isArray(session.windows)) return false;
  if (!Array.isArray(session.groups)) return false;
  return true;
}

export function isRestorableUrl(url) {
  if (!url || typeof url !== "string") return false;
  // Edge / Chrome internal pages cannot be recreated via tabs.create
  // We keep them in the snapshot but skip on restore, with a report.
  const blockedPrefixes = ["edge://", "chrome://", "chrome-extension://", "chrome-search://", "about:", "view-source:", "data:", "javascript:"];
  return !blockedPrefixes.some((p) => url.startsWith(p));
}

export function sanitizeGroupColor(color) {
  const valid = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  return valid.includes(color) ? color : "grey";
}

export function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch (e) {
    console.warn("[EdgeSessions] Failed to extract domain from URL", { url, error: e });
    return "";
  }
}

export function createTabKey(sessionId, windowIndex, tabIndex) {
  return `${sessionId}-w${windowIndex}-t${tabIndex}`;
}
