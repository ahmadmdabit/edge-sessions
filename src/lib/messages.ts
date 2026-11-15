import type { RestoreReport, Session, Settings, SettingsPatch } from "./types.js";

export type RuntimeRequest =
  | { type: "SaveCurrent"; name?: string }
  | { type: "GetSessions" }
  | { type: "Restore"; id: string }
  | { type: "Delete"; id: string }
  | { type: "Rename"; id: string; name: string }
  | { type: "Export" }
  | { type: "Import"; json: string }
  | { type: "GetSettings" }
  | { type: "UpdateSettings"; patch: SettingsPatch }
  | { type: "CapturePreview" };

export type RuntimeNotification =
  | { type: "SessionSaved"; session: Session }
  | { type: "SessionEnriched"; sessionId: string }
  | { type: "RestoreProgress"; done: number; total: number; msg: string }
  | { type: "SaveFailed"; error: string };

export type RuntimeResponse = {
  ok: boolean;
  error?: string;
  session?: Session;
  sessions?: Session[];
  settings?: Settings;
  report?: RestoreReport;
  data?: string;
  count?: number;
  rejected?: number;
};
