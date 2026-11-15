import { captureCurrentSession, enrichSession } from "../lib/capture.js";
import { restoreSession } from "../lib/restore.js";
import { DefaultSettings, StorageKeys, validateSession } from "../lib/session-model.js";
import { addSession, getSessions, getSessionById, deleteSession, renameSession, getSettings, getAutosave, updateSettings, ensureQuota } from "../lib/storage.js";

// Cache for the popup's live preview capture. Invalidated whenever a session is saved
// so the preview never grows stale without re-capturing all tabs.
let cachedPreview = null;

// --- Install ---
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({
      [StorageKeys.SETTINGS]: DefaultSettings,
      [StorageKeys.SESSIONS]: [],
    });
    // Create autosave alarm
    await chrome.alarms.create("autosave", { periodInMinutes: DefaultSettings.autosaveIntervalMinutes });
  } else if (details.reason === "update") {
    // Ensure settings are seeded after an update. Sessions are version-guarded
    // on read in storage.getSessions so an older schema never crashes restore.
    const data = await chrome.storage.local.get([StorageKeys.SETTINGS, StorageKeys.SESSIONS]);
    if (!data[StorageKeys.SETTINGS]) {
      await chrome.storage.local.set({ [StorageKeys.SETTINGS]: DefaultSettings });
    }
  }
});

// --- Keyboard Commands ---
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "quick-save") {
    await handleSaveSession(`Quick Save ${new Date().toLocaleTimeString()}`);
  }
  if (command === "quick-restore-last") {
    // Prefer the most recent auto-saved session, fall back to the most recent
    // user-saved session. Both live in the same SessionsV1 list now.
    const sessions = await getSessions();
    const autoSession = sessions.find((s) => s.source === "auto");
    if (autoSession) {
      await runRestore(autoSession, await getSettings());
    } else if (sessions[0]) {
      await handleRestoreSession(sessions[0].id);
    }
  }
});

// --- Alarms: Autosave ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "autosave") {
    const settings = await getSettings();
    if (!settings.autosaveEnabled) return;
    try {
      const session = await captureCurrentSession(`Autosave ${new Date().toLocaleString()}`, "auto");
      const settings = await getSettings();
      await addSession(session, settings.maxUserSessions, settings.maxAutoSessions);
    } catch (e) {
      console.error("[EdgeSessions] Autosave failed", { alarm: alarm.name, error: e });
    }
  }
});

// --- Message API: Popup <-> Background ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "SaveCurrent": {
          // The quick snapshot no longer performs per-tab scripting, so the
          // capture is fast enough to complete within the message request.
          // Respond only after storage persistence to avoid a refresh race
          // where the popup reads the session list before the save exists.
          try {
            const session = await handleSaveSession(msg.name);
            sendResponse({ ok: true, session });
          } catch (e) {
            console.error("[EdgeSessions] SaveCurrent failed", { name: msg.name, error: e });
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case "GetSessions": {
          const sessions = await getSessions();
          const settings = await getSettings();
          sendResponse({ ok: true, sessions, settings });
          break;
        }
        case "Restore": {
          const report = await handleRestoreSession(msg.id);
          sendResponse({ ok: true, report });
          break;
        }
        case "Delete": {
          await deleteSession(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case "Rename": {
          const s = await renameSession(msg.id, msg.name);
          sendResponse({ ok: true, session: s });
          break;
        }
        case "Export": {
          const sessions = await getSessions();
          sendResponse({ ok: true, data: JSON.stringify({ app: "EdgeSessions", version: 1, exportedAt: Date.now(), sessions }, null, 2) });
          break;
        }
        case "Import": {
          const MaxImportBytes = 2 * 1024 * 1024;
          if (new TextEncoder().encode(msg.json).length > MaxImportBytes) throw new Error("Import file too large (max 2 MB)");
          const parsed = JSON.parse(msg.json);
          if (!parsed.sessions || !Array.isArray(parsed.sessions)) throw new Error("Invalid import file");
          const valid = parsed.sessions.filter(validateSession);
          const rejected = parsed.sessions.length - valid.length;
          const existing = await getSessions();
          const merged = [...valid, ...existing].slice(0, 100);
          await chrome.storage.local.set({ [StorageKeys.SESSIONS]: merged });
          sendResponse({ ok: true, count: valid.length, rejected });
          break;
        }
        case "GetSettings": {
          const settings = await getSettings();
          sendResponse({ ok: true, settings });
          break;
        }
        case "UpdateSettings": {
          const settings = await updateSettings(msg.patch || {});
          // Re-create alarm if interval changed
          await chrome.alarms.clear("autosave");
          if (settings.autosaveEnabled) {
            await chrome.alarms.create("autosave", { periodInMinutes: settings.autosaveIntervalMinutes });
          }
          sendResponse({ ok: true, settings });
          break;
        }
        case "CapturePreview": {
          if (cachedPreview) {
            sendResponse({ ok: true, session: cachedPreview });
            break;
          }
          // Preview is only for live counts (windows/tabs/groups) — skip the
          // expensive per-tab meta scripting so it never hangs the popup.
          const session = await captureCurrentSession("Preview", "auto", true);
          cachedPreview = session;
          sendResponse({ ok: true, session });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (e) {
      console.error("[EdgeSessions] Message handler failed", { messageType: msg.type, error: e });
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // Keep channel open for async
});

async function handleSaveSession(name) {
  await ensureQuota();
  // Phase 1: quick snapshot — no per-tab scripting, so the save ends fast.
  const session = await captureCurrentSession(name, "user", true);
  const settings = await getSettings();
  await addSession(session, settings.maxUserSessions, settings.maxAutoSessions);
  // Invalidate cached preview and notify popups so the list refreshes immediately.
  cachedPreview = null;
  chrome.runtime.sendMessage({ type: "SessionSaved", session }).catch((e) => {
    console.warn("[EdgeSessions] Failed to notify popup of saved session", { sessionId: session.id, error: e });
  });
  // Phase 2: background enrichment — add page meta via scripting, best effort.
  // Fire-and-forget; the save is already durable without it.
  enrichSession(session.id).catch((e) => {
    console.warn("[EdgeSessions] Background session enrichment failed", { sessionId: session.id, error: e });
  });
  return session;
}

// Core restore logic: accepts a session object directly, so it can serve both
// user-saved sessions (by id) and the isolated autosave snapshot.
async function runRestore(session, settings) {
  if (!session) throw new Error("Session not found");
  const report = await restoreSession(session, settings, (done, total, msg) => {
    chrome.runtime.sendMessage({ type: "RestoreProgress", done, total, msg }).catch((e) => {
      console.warn("[EdgeSessions] Failed to send restore progress", { done, total, error: e });
    });
  });
  return report;
}

async function handleRestoreSession(id) {
  const session = await getSessionById(id);
  const settings = await getSettings();
  return runRestore(session, settings);
}
