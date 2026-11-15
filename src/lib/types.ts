export type SessionSource = "user" | "auto";
export type RestoreMode = "auto" | "fast" | "throttled" | "placeholder";
export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export interface Settings {
  autosaveEnabled: boolean;
  autosaveIntervalMinutes: number;
  restoreInNewWindow: boolean;
  skipInternalPages: boolean;
  restorePinnedFirst: boolean;
  delayBetweenTabsMs: number;
  delayBetweenWindowsMs: number;
  maxUserSessions: number;
  maxAutoSessions: number;
  restoreMode: RestoreMode;
  autoDiscardEnabled: boolean;
  placeholderThreshold: number;
  fastThreshold: number;
  batchSize: number;
  batchPauseMs: number;
  placeholderAutoLoad: boolean;
}

export type SettingsPatch = Partial<Settings>;

export interface SavedTabMeta {
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  themeColor: string;
  domain: string;
  capturedAt: number;
  h1?: string;
}

export interface SavedTab {
  url: string;
  title: string;
  index: number;
  pinned: boolean;
  active: boolean;
  muted: boolean;
  audible?: boolean;
  groupId: number;
  groupKey: string | null;
  favIconUrl: string;
  tabKey: string;
  tabId?: number;
  meta?: SavedTabMeta;
}

export interface SavedGroup {
  key: string;
  originalGroupId: number;
  windowIndex: number;
  title: string;
  color: GroupColor | string;
  collapsed: boolean;
}

export interface SavedWindow {
  index: number;
  originalWindowId?: number;
  state: string;
  width: number;
  height: number;
  top: number;
  left: number;
  focused: boolean;
  incognito?: boolean;
  tabs: SavedTab[];
}

export interface Session {
  id: string;
  version: number;
  source: SessionSource;
  name: string;
  createdAt: number;
  updatedAt?: number;
  tabCount: number;
  restorableTabCount?: number;
  windowCount: number;
  groupCount: number;
  windows: SavedWindow[];
  groups: SavedGroup[];
}

export interface RestoreError {
  url?: string;
  group?: string;
  window?: number;
  error: string;
}

export interface RestoreReport {
  restoredTabs: number;
  skippedTabs: Array<{ url: string; reason: string }>;
  errors: RestoreError[];
  createdWindows: number[];
  mode: RestoreMode | "unknown";
  discardedCount: number;
  placeholderCount: number;
}
