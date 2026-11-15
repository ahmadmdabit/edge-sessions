import { StorageKeys, DefaultSettings, SchemaVersion, normalizeSettings, validateSettingsPatch } from "./session-model.js";
import type { Session, Settings, SettingsPatch } from "./types.js";

// Serialize all read-modify-write storage mutations so concurrent saves
// (keyboard command + manual save, autosave + manual save) cannot interleave
// and overwrite each other. chrome.storage.local has no transactions.
let writeQueue = Promise.resolve();
function serializedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn);
  writeQueue = next.then(
    () => undefined,
    (error: unknown) => {
      console.error("[EdgeSessions] Serialized storage mutation failed", error);
      return undefined;
    },
  ); // keep the chain alive even if a mutation fails
  return next;
}

export async function getSessions(): Promise<Session[]> {
  const data = await chrome.storage.local.get(StorageKeys.SESSIONS);
  const sessions = (data[StorageKeys.SESSIONS] ?? []) as Session[];
  // Schema guard: drop sessions written by an unsupported schema version so a
  // future migration path can be added here without crashing on read.
  // Backward-compat: legacy sessions without `source` default to "user".
  return sessions.filter((s) => s && s.version === SchemaVersion).map((s) => ({ ...s, source: s.source ?? "user" }));
}

export async function saveSessionsList(sessions: Session[]): Promise<void> {
  await chrome.storage.local.set({ [StorageKeys.SESSIONS]: sessions });
}

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(StorageKeys.SETTINGS);
  return normalizeSettings((data[StorageKeys.SETTINGS] ?? DefaultSettings) as SettingsPatch);
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  const validation = validateSettingsPatch({ ...current, ...patch });
  if (!validation.valid) {
    throw new Error(validation.errors.join(" "));
  }
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [StorageKeys.SETTINGS]: next });
  return next;
}

export async function addSession(session: Session, maxUserSessions = 50, maxAutoSessions = 30): Promise<Session[]> {
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

export async function deleteSession(id: string): Promise<Session[]> {
  return serializedWrite(async () => {
    const sessions = await getSessions();
    const next = sessions.filter((s) => s.id !== id);
    await saveSessionsList(next);
    return next;
  });
}

export async function getSessionById(id: string): Promise<Session | null> {
  const sessions = await getSessions();
  return sessions.find((s) => s.id === id) || null;
}

export async function getAutosave(): Promise<Session | null> {
  const data = await chrome.storage.local.get(StorageKeys.AUTOSAVE);
  return (data[StorageKeys.AUTOSAVE] as Session | undefined) ?? null;
}

export async function renameSession(id: string, newName: string): Promise<Session | null> {
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

export async function ensureQuota(): Promise<boolean> {
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
