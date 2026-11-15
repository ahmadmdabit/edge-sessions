// src/lib/storage.js - FIXED: Static imports only. No import() allowed in SW.
import { StorageKeys, DefaultSettings, SchemaVersion, normalizeSettings, validateSettingsPatch } from "./session-model.js";

// Serialize all read-modify-write storage mutations so concurrent saves
// (keyboard command + manual save, autosave + manual save) cannot interleave
// and overwrite each other. chrome.storage.local has no transactions.
let writeQueue = Promise.resolve();
function serializedWrite(fn) {
  const next = writeQueue.then(fn);
  writeQueue = next.catch((e) => {
    console.error("[EdgeSessions] Serialized storage mutation failed", e);
  }); // keep the chain alive even if a mutation fails
  return next;
}

export async function getSessions() {
  const data = await chrome.storage.local.get(StorageKeys.SESSIONS);
  const sessions = data[StorageKeys.SESSIONS] || [];
  // Schema guard: drop sessions written by an unsupported schema version so a
  // future migration path can be added here without crashing on read.
  // Backward-compat: legacy sessions without `source` default to "user".
  return sessions.filter((s) => s && s.version === SchemaVersion).map((s) => ({ ...s, source: s.source ?? "user" }));
}

export async function saveSessionsList(sessions) {
  await chrome.storage.local.set({ [StorageKeys.SESSIONS]: sessions });
}

export async function getSettings() {
  const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
  return normalizeSettings(data[StorageKeys.SETTINGS] || DefaultSettings);
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const validation = validateSettingsPatch({ ...current, ...patch });
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [StorageKeys.SETTINGS]: next });
  return next;
}

export async function addSession(session, maxUserSessions = 50, maxAutoSessions = 30) {
  return serializedWrite(async () => {
    const sessions = await getSessions();
    sessions.unshift(session);
    const safeMaxUser = Math.max(0, Number(maxUserSessions) || 50);
    const safeMaxAuto = Math.max(0, Number(maxAutoSessions) || 30);
    // Prune each source independently so auto-saves cannot evict user saves
    // (and vice versa), while keeping most-recent-first overall.
    const userSessions = sessions.filter((s) => s.source === "user").slice(0, safeMaxUser);
    const autoSessions = sessions.filter((s) => s.source === "auto").slice(0, safeMaxAuto);
    const trimmed = [...userSessions, ...autoSessions].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await saveSessionsList(trimmed);
    return trimmed;
  });
}

export async function deleteSession(id) {
  return serializedWrite(async () => {
    const sessions = await getSessions();
    const next = sessions.filter((s) => s.id !== id);
    await saveSessionsList(next);
    return next;
  });
}

export async function getSessionById(id) {
  const sessions = await getSessions();
  return sessions.find((s) => s.id === id) || null;
}

export async function getAutosave() {
  const data = await chrome.storage.local.get(StorageKeys.AUTOSAVE);
  return data[StorageKeys.AUTOSAVE] || null;
}

export async function renameSession(id, newName) {
  return serializedWrite(async () => {
    const sessions = await getSessions();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    sessions[idx].name = newName;
    sessions[idx].updatedAt = Date.now();
    await saveSessionsList(sessions);
    return sessions[idx];
  });
}

export async function ensureQuota() {
  try {
    const bytes = await chrome.storage.local.getBytesInUse();
    if (bytes > 85 * 100 * 1000) {
      return serializedWrite(async () => {
        const sessions = await getSessions();
        await saveSessionsList(sessions.slice(0, 10));
        return true;
      });
    }
  } catch (e) {
    console.warn("[EdgeSessions] Storage quota check failed", { error: e });
  }
  return false;
}
