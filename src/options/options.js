// src/options/options.js
const LIMITS = {
  autosaveIntervalMinutes: { min: 1, max: 120 },
  maxUserSessions: { min: 1, max: 1000 },
  maxAutoSessions: { min: 1, max: 1000 },
  placeholderThreshold: { min: 10, max: 1000 },
  fastThreshold: { min: 10, max: 200 },
};

const $ = (selector) => document.querySelector(selector);
const statusElement = $("#pageStatus");

function send(message) {
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

function showStatus(message, type = "info") {
  statusElement.textContent = message;
  statusElement.className = `status-message ${type}`;
  statusElement.hidden = false;
}

function hideStatus() {
  statusElement.textContent = "";
  statusElement.hidden = true;
}

function clamp(value, { min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function validateThresholds(fastThreshold, placeholderThreshold) {
  const error = $("#thresholdError");
  const valid = fastThreshold < placeholderThreshold;
  error.hidden = valid;
  $("#fastThreshold").setAttribute("aria-invalid", String(!valid));
  $("#placeholderThreshold").setAttribute("aria-invalid", String(!valid));
  return valid;
}

function updateModeDependencies() {
  const mode = $("#restoreMode").value;
  const automatic = mode === "auto";
  $("#fastThreshold").disabled = !automatic;
  $("#placeholderThreshold").disabled = !automatic;
  // Placeholder pages are already lightweight, so discard does not apply.
  $("#autoDiscardEnabled").disabled = mode === "placeholder";
  validateThresholds(
    Number($("#fastThreshold").value),
    Number($("#placeholderThreshold").value),
  );
}

function populateSettings(settings) {
  $("#autosaveEnabled").checked = settings.autosaveEnabled;
  $("#autosaveIntervalMinutes").value = settings.autosaveIntervalMinutes;
  $("#restorePinnedFirst").checked = settings.restorePinnedFirst;
  $("#skipInternalPages").checked = settings.skipInternalPages;
  $("#restoreMode").value = settings.restoreMode || "auto";
  $("#autoDiscardEnabled").checked = settings.autoDiscardEnabled !== false;
  $("#fastThreshold").value = settings.fastThreshold;
  $("#placeholderThreshold").value = settings.placeholderThreshold;
  $("#maxUserSessions").value = settings.maxUserSessions;
  $("#maxAutoSessions").value = settings.maxAutoSessions;
  updateModeDependencies();
}

function collectSettings() {
  const fastThreshold = clamp($("#fastThreshold").value, LIMITS.fastThreshold);
  const placeholderThreshold = clamp($("#placeholderThreshold").value, LIMITS.placeholderThreshold);
  return {
    autosaveEnabled: $("#autosaveEnabled").checked,
    autosaveIntervalMinutes: clamp($("#autosaveIntervalMinutes").value, LIMITS.autosaveIntervalMinutes),
    restorePinnedFirst: $("#restorePinnedFirst").checked,
    skipInternalPages: $("#skipInternalPages").checked,
    restoreMode: $("#restoreMode").value,
    autoDiscardEnabled: $("#restoreMode").value === "placeholder" ? false : $("#autoDiscardEnabled").checked,
    fastThreshold,
    placeholderThreshold,
    maxUserSessions: clamp($("#maxUserSessions").value, LIMITS.maxUserSessions),
    maxAutoSessions: clamp($("#maxAutoSessions").value, LIMITS.maxAutoSessions),
  };
}

async function loadSettings() {
  try {
    const response = await send({ type: "GetSettings" });
    if (!response.ok) throw new Error(response.error || "Unable to load settings.");
    populateSettings(response.settings);
  } catch (error) {
    console.error("[EdgeSessions] Failed to load options", { error });
    showStatus(`Unable to load settings: ${error.message}`, "error");
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

  const saveButton = $("#save");
  saveButton.disabled = true;
  try {
    const response = await send({ type: "UpdateSettings", patch });
    if (!response.ok) throw new Error(response.error || "Unable to save settings.");
    populateSettings(response.settings);
    showStatus("Settings saved.", "success");
  } catch (error) {
    console.error("[EdgeSessions] Failed to save options", { error });
    showStatus(`Unable to save settings: ${error.message}`, "error");
  } finally {
    saveButton.disabled = false;
  }
});

$("#restoreMode").addEventListener("change", updateModeDependencies);
$("#fastThreshold").addEventListener("input", () => {
  validateThresholds(Number($("#fastThreshold").value), Number($("#placeholderThreshold").value));
});
$("#placeholderThreshold").addEventListener("input", () => {
  validateThresholds(Number($("#fastThreshold").value), Number($("#placeholderThreshold").value));
});

$("#exportBtn").addEventListener("click", async () => {
  hideStatus();
  try {
    const response = await send({ type: "Export" });
    if (!response.ok) throw new Error(response.error || "Unable to export sessions.");
    const blob = new Blob([response.data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Edge-Sessions-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showStatus("Sessions exported.", "success");
  } catch (error) {
    console.error("[EdgeSessions] Failed to export sessions from options", { error });
    showStatus(`Unable to export sessions: ${error.message}`, "error");
  }
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  hideStatus();
  try {
    const json = await file.text();
    const response = await send({ type: "Import", json });
    if (!response.ok) throw new Error(response.error || "Unable to import sessions.");
    const rejected = response.rejected ? ` ${response.rejected} invalid session(s) were skipped.` : "";
    showStatus(`Imported ${response.count} session(s).${rejected}`, "success");
  } catch (error) {
    console.error("[EdgeSessions] Failed to import sessions from options", { error });
    showStatus(`Unable to import sessions: ${error.message}`, "error");
  } finally {
    event.target.value = "";
  }
});

document.addEventListener("DOMContentLoaded", loadSettings);
