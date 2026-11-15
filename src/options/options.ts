import type { RuntimeRequest, RuntimeResponse } from "../lib/messages.js";
import type { Settings, SettingsPatch } from "../lib/types.js";

interface Limit { min: number; max: number }

const LIMITS: Record<keyof Pick<Settings, "autosaveIntervalMinutes" | "maxUserSessions" | "maxAutoSessions" | "placeholderThreshold" | "fastThreshold">, Limit> = {
  autosaveIntervalMinutes: { min: 1, max: 120 },
  maxUserSessions: { min: 1, max: 1000 },
  maxAutoSessions: { min: 1, max: 1000 },
  placeholderThreshold: { min: 10, max: 1000 },
  fastThreshold: { min: 10, max: 200 },
};

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
};
const statusElement = $("#pageStatus");

function send(message: RuntimeRequest): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response) {
        reject(new Error("The background service worker did not respond."));
        return;
      }
      resolve(response);
    });
  });
}

function showStatus(message: string, type = "info") {
  statusElement.textContent = message;
  statusElement.className = `status-message ${type}`;
  statusElement.hidden = false;
}

function hideStatus() {
  statusElement.textContent = "";
  statusElement.hidden = true;
}

function clamp(value: string, { min, max }: Limit) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function validateThresholds(fastThreshold: number, placeholderThreshold: number) {
  const error = $("#thresholdError");
  const valid = fastThreshold < placeholderThreshold;
  error.hidden = valid;
  $("#fastThreshold").setAttribute("aria-invalid", String(!valid));
  $("#placeholderThreshold").setAttribute("aria-invalid", String(!valid));
  return valid;
}

function updateModeDependencies() {
  const mode = ($("#restoreMode") as HTMLSelectElement).value as Settings["restoreMode"];
  const automatic = mode === "auto";
  ($("#fastThreshold") as HTMLInputElement).toggleAttribute("disabled", !automatic);
  ($("#placeholderThreshold") as HTMLInputElement).toggleAttribute("disabled", !automatic);
  // Placeholder pages are already lightweight, so discard does not apply.
  ($("#autoDiscardEnabled") as HTMLInputElement).toggleAttribute("disabled", mode === "placeholder");
  validateThresholds(
    Number(($("#fastThreshold") as HTMLInputElement).value),
    Number(($("#placeholderThreshold") as HTMLInputElement).value),
  );
}

function populateSettings(settings: Settings) {
  ($("#autosaveEnabled") as HTMLInputElement).checked = settings.autosaveEnabled;
  ($("#autosaveIntervalMinutes") as HTMLInputElement).value = String(settings.autosaveIntervalMinutes);
  ($("#restorePinnedFirst") as HTMLInputElement).checked = settings.restorePinnedFirst;
  ($("#skipInternalPages") as HTMLInputElement).checked = settings.skipInternalPages;
  ($("#restoreMode") as HTMLSelectElement).value = settings.restoreMode ?? "auto";
  ($("#autoDiscardEnabled") as HTMLInputElement).checked = settings.autoDiscardEnabled !== false;
  ($("#fastThreshold") as HTMLInputElement).value = String(settings.fastThreshold);
  ($("#placeholderThreshold") as HTMLInputElement).value = String(settings.placeholderThreshold);
  ($("#maxUserSessions") as HTMLInputElement).value = String(settings.maxUserSessions);
  ($("#maxAutoSessions") as HTMLInputElement).value = String(settings.maxAutoSessions);
  updateModeDependencies();
}

function collectSettings(): SettingsPatch {
  const fastThreshold = clamp($<HTMLInputElement>("#fastThreshold").value, LIMITS.fastThreshold);
  const placeholderThreshold = clamp($<HTMLInputElement>("#placeholderThreshold").value, LIMITS.placeholderThreshold);
  return {
    autosaveEnabled: ($("#autosaveEnabled") as HTMLInputElement).checked,
    autosaveIntervalMinutes: clamp($<HTMLInputElement>("#autosaveIntervalMinutes").value, LIMITS.autosaveIntervalMinutes),
    restorePinnedFirst: ($("#restorePinnedFirst") as HTMLInputElement).checked,
    skipInternalPages: ($("#skipInternalPages") as HTMLInputElement).checked,
    restoreMode: (($("#restoreMode") as HTMLSelectElement).value as Settings["restoreMode"]),
    autoDiscardEnabled: (($("#restoreMode") as HTMLSelectElement).value === "placeholder")
      ? false
      : ($("#autoDiscardEnabled") as HTMLInputElement).checked,
    fastThreshold,
    placeholderThreshold,
    maxUserSessions: clamp($<HTMLInputElement>("#maxUserSessions").value, LIMITS.maxUserSessions),
    maxAutoSessions: clamp($<HTMLInputElement>("#maxAutoSessions").value, LIMITS.maxAutoSessions),
  };
}

async function loadSettings() {
  try {
    const response = await send({ type: "GetSettings" });
    if (!response.ok) throw new Error(response.error || "Unable to load settings.");
    if (!response.settings) throw new Error("Unable to load settings.");
    populateSettings(response.settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EdgeSessions] Failed to load options", { error: message });
    showStatus(`Unable to load settings: ${message}`, "error");
  }
}

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  hideStatus();
  const patch = collectSettings();
  if (!validateThresholds(patch.fastThreshold, patch.placeholderThreshold)) {
    showStatus("Review the restore thresholds before saving.", "error");
    $("#fastThreshold").focus();
    return;
  }

  const saveButton = $<HTMLButtonElement>("#save");
  saveButton.disabled = true;
  try {
    const response = await send({ type: "UpdateSettings", patch });
    if (!response.ok) throw new Error(response.error || "Unable to save settings.");
    if (!response.settings) throw new Error("Unable to save settings.");
    populateSettings(response.settings);
    showStatus("Settings saved.", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EdgeSessions] Failed to save options", { error: message });
    showStatus(`Unable to save settings: ${message}`, "error");
  } finally {
    saveButton.disabled = false;
  }
});

($("#restoreMode") as HTMLSelectElement).addEventListener("change", updateModeDependencies);
($("#fastThreshold") as HTMLInputElement).addEventListener("input", () => {
  validateThresholds(Number(($("#fastThreshold") as HTMLInputElement).value), Number(($("#placeholderThreshold") as HTMLInputElement).value));
});
($("#placeholderThreshold") as HTMLInputElement).addEventListener("input", () => {
  validateThresholds(Number(($("#fastThreshold") as HTMLInputElement).value), Number(($("#placeholderThreshold") as HTMLInputElement).value));
});

$("#exportBtn").addEventListener("click", async () => {
  hideStatus();
  try {
    const response = await send({ type: "Export" });
    if (!response.ok) throw new Error(response.error || "Unable to export sessions.");
    if (!response.data) throw new Error("Unable to export sessions.");
    const blob = new Blob([response.data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Edge-Sessions-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showStatus("Sessions exported.", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EdgeSessions] Failed to export sessions from options", { error: message });
    showStatus(`Unable to export sessions: ${message}`, "error");
  }
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  hideStatus();
  try {
    const json = await file.text();
    const response = await send({ type: "Import", json });
    if (!response.ok) throw new Error(response.error || "Unable to import sessions.");
    const rejected = response.rejected ? ` ${response.rejected} invalid session(s) were skipped.` : "";
    showStatus(`Imported ${response.count ?? 0} session(s).${rejected}`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EdgeSessions] Failed to import sessions from options", { error: message });
    showStatus(`Unable to import sessions: ${message}`, "error");
  } finally {
    (event.target as HTMLInputElement).value = "";
  }
});

document.addEventListener("DOMContentLoaded", loadSettings);
