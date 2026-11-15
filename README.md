# Edge Sessions

Save and restore browser sessions: all windows, tabs, and tab group names, colors, and order. Adaptive lazy restore prevents out-of-memory (OOM) failures on large sessions.

Manifest V3 extension for Chrome / Edge. Minimum browser version 116. No build step; load the directory as an unpacked extension.

## File layout

```
manifest.json
icons/
  edge-sessions-128.png
  edge-sessions-512.png
  edge-sessions.svg
src/
  styles/
    global.css            # Shared design system (tokens, buttons, inputs, cards, focus) loaded by every page
  background/
    service-worker.js     # Service worker, message API, alarms, keyboard commands
  lib/
    session-model.js      # Schema, defaults, validators, URL helpers, settings normalization
    storage.js            # chrome.storage.local wrappers (sessions, settings, autosave)
    capture.js            # Session capture + per-tab meta extraction + background enrichment
    restore.js            # Adaptive restore (auto / fast / throttled / placeholder)
  popup/
    popup.html            # Extension action popup
    popup.js              # Popup logic: list, save, restore, delete, rename, session search
    popup.css             # Popup-specific overrides (global.css loaded first)
  options/
    options.html          # Settings page
    options.js            # Settings read/write + session import/export
    options.css           # Settings-specific overrides (global.css loaded first)
  pages/
    placeholder.html      # Lazy placeholder page shown instead of loading a tab
    placeholder.js        # Loads saved meta (favicon, description, OG image) from storage
    placeholder.css       # Placeholder-specific overrides (global.css loaded first)
README.md
```

## Storage schema

- `SessionsV1`: array of `Session` objects. Each session carries a `source` ("user" or "auto") so user-saved and autosaved sessions share one list but are pruned independently.
- `SettingsV1`: settings object merged over `DefaultSettings` and normalized on read.
- `AutosaveSnapshotV1`: last autosaved session (isolated from `SessionsV1`)

Sessions are stamped with `SchemaVersion` (currently `2`). `getSessions()` drops any record whose `version` does not match, so a future schema migration can be added without crashing on stale data. Legacy sessions without `source` default to "user" on read.

## Save flow

Saving is split into two phases:

1. **Quick snapshot** — capture all windows, tabs, and group metadata with no per-tab page scripting. The session is written to storage immediately, so the save ends fast and the popup list reflects it right away.
2. **Background enrichment** — best-effort page meta (OG title, description, image, theme color, H1) is fetched per tab via `chrome.scripting.executeScript` with a hard per-tab timeout. Enrichment is fire-and-forget; tabs that block scripting (CSP, `edge://`, `chrome://`, PDF, closed tabs) are silently skipped, and the save remains durable without them.

## Limitations

- No build tooling or bundler; files are plain ES modules loaded directly by the browser.
- The background service worker is an ES module (`"type": "module"`), so it runs in strict mode. Popup, options, and
  placeholder pages are classic scripts and run in sloppy mode unless they opt in.
- Meta extraction requires page scripting permission and a loaded tab; discarded, sleeping, or script-blocked tabs store empty meta, so the placeholder may show no description or favicon.
- Internal browser pages (`edge://`, `chrome://`, `chrome-extension://`, `chrome-search://`, `about:`, `view-source:`, `data:`, `javascript:`) are preserved in the snapshot but skipped during restore.
- `chrome.storage.local` is subject to quota; `ensureQuota` trims old sessions automatically when storage exceeds ~8.5 MB.
- `web_accessible_resources` is not declared. Extension pages load their own assets relative to themselves, so no cross-site exposure is needed.
- Host permission `<all_urls>` is required because `chrome.scripting.executeScript` runs on arbitrary tabs and restore navigates to arbitrary URLs.

## Loading the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Click Load unpacked and select this directory.
4. Pin the extension action to the toolbar if desired.

No npm install, build, or test command exists in this repository.

## Manifest

MV3. Permissions: `tabs`, `tabGroups`, `windows`, `storage`, `alarms`, `scripting`. Host permission: `<all_urls>`. Background is a module service worker at `src/background/service-worker.js`. The extension action opens `src/popup/popup.html`. Options are provided via `options_ui` (`src/options/options.html`, `open_in_tab: true`). `quick-save` (Ctrl+Shift+S / Command+Shift+S) and `quick-restore-last` (Ctrl+Shift+R / Command+Shift+R) are registered keyboard commands.

## Background service worker (`src/background/service-worker.js`)

Installs default settings and an empty session list on install, creates the autosave alarm, and registers `chrome.commands.onCommand` and `chrome.alarms.onAlarm` (autosave). Exposes a message API to popup and options:

- `SaveCurrent` — captures and persists the current session
- `GetSessions` — returns sessions and settings
- `Restore` — restores a session by id via `restore.js`
- `Delete`, `Rename`, `Export`, `Import`, `GetSettings`, `UpdateSettings`
- `CapturePreview` — returns a cached capture of the current session (re-captured only after a save)

### Concurrency and data safety

All storage read-modify-write mutations (`addSession`, `deleteSession`, `renameSession`, `ensureQuota`) are serialized through an in-memory mutex so concurrent saves (keyboard command + manual save, or autosave + manual save) cannot interleave and overwrite each other — `chrome.storage.local` has no transactions.

`quick-restore-last` prefers the most recent auto-saved session (`source === "auto"` in `SessionsV1`) and falls back to the most recent user-saved session (`SessionsV1[0]`) only when no autosave exists. Autosave writes share the same session list as manual saves but are pruned independently via `maxAutoSessions`.

`Import` validates every imported session with `validateSession()`, rejects records that fail, caps the payload at 2 MB, and reports how many sessions were accepted vs. rejected. Invalid records are never persisted.

`UpdateSettings` validates and normalizes settings via `normalizeSettings()` and `validateSettingsPatch()` in `session-model.js` before writing. Thresholds are cross-checked so `fastThreshold` must remain below `placeholderThreshold`.

## Libraries under `src/lib/`

### `session-model.js`

Defines `SchemaVersion` (currently `2`), `StorageKeys` (`SessionsV1`, `SettingsV1`, `AutosaveSnapshotV1`), `RestoreModes` (`auto`, `fast`, `throttled`, `placeholder`), `SettingLimits`, `DefaultSettings`, and JSDoc typedefs for `SavedTab`, `SavedWindow`, `SavedGroup`, and `Session`. Provides `createSessionId`, `validateSession`, `isRestorableUrl`, `sanitizeGroupColor`, `getDomainFromUrl`, `createTabKey`, `normalizeSettings()`, and `validateSettingsPatch()`.

`DefaultSettings` includes `restoreInNewWindow` (default `true`), `skipInternalPages`, `restorePinnedFirst`, `restoreMode` (default `"auto"`), `autoDiscardEnabled`, `placeholderThreshold` (250), `fastThreshold` (80), `batchSize` (20), `batchPauseMs` (50), `placeholderAutoLoad`, `maxUserSessions` (50), and `maxAutoSessions` (30).

`normalizeSettings()` repairs legacy/out-of-range persisted values (removing obsolete `maxSessions` and `adaptiveRestoreEnabled`), clamps every numeric setting to its canonical limit, and repairs `fastThreshold < placeholderThreshold`. `validateSettingsPatch()` cross-checks thresholds before a settings write is accepted.

Internal URLs (`edge://`, `chrome://`, `chrome-extension://`, `chrome-search://`, `about:`, `view-source:`, `data:`, `javascript:`) are not restorable and are skipped during restore.

### `storage.js`

Wrappers around `chrome.storage.local.get`/`set` for sessions, settings, quota, and autosave. `getSettings()` returns normalized settings via `normalizeSettings()`. `updateSettings()` validates and normalizes patches via `validateSettingsPatch()` before writing. `addSession()` prunes user-saved and auto-saved sessions independently via `maxUserSessions` and `maxAutoSessions`. `ensureQuota` trims the session list to 10 entries when storage exceeds 8.5 MB. `getAutosave()` reads the isolated `AutosaveSnapshotV1` key.

### `capture.js`

`captureCurrentSession(name, source, skipMeta)` enumerates all normal windows via `chrome.windows.getAll({ populate: true })`, queries tab groups, and builds `SavedWindow[]` with `SavedTab[]` per window. By default (`skipMeta = true`) it performs a quick snapshot with no per-tab page scripting so the save ends fast. Each saved tab persists its live `tabId` (not part of the restore contract) for later enrichment. For each http(s) tab it runs `extractPageMeta` through `chrome.scripting.executeScript` in the page context to capture `description`, `ogTitle`, `ogDescription`, `ogImage`, `themeColor`, `h1`, and `domain`. Meta extraction fails silently for discarded/sleeping tabs or sites that block scripting; those tabs store empty meta. Each tab receives a stable `tabKey` (`sessId-w{index}-t{index}`) used by the placeholder page for lookup.

`enrichSession(sessionId)` runs best-effort background enrichment after a save: it fetches page meta per tab via `chrome.scripting.executeScript` with a hard per-tab timeout (`executeScriptWithTimeout`), skips tabs without a valid `tabId` (legacy sessions), skips tabs that already have meta, and persists only changed sessions back to storage. Enrichment is fire-and-forget — script-blocked or unresponsive tabs are skipped without affecting the already-durable save.

Info-level logging is gated behind a `DEBUG` flag (`const DEBUG = false;` at the top of the file) and is silent by default; only actual failures (`console.warn`) are logged.

### `restore.js`

`restoreSession(session, settings, onProgress)` supports an explicit `restoreMode` plus automatic threshold-based selection:

- `restoreMode: "auto"` (default) — chooses a mode from total tab count and thresholds (`placeholderThreshold`, `fastThreshold`):
  - `fast` (<= `fastThreshold`): immediate restore, short delay between tabs
  - `throttled` (between thresholds): delayed tab creation with batching and `yieldToUI`
  - `placeholder` (> `placeholderThreshold`): every tab opens `src/pages/placeholder.html?sessionId=&tabKey=&url=&title=` instead of the real URL, preventing OOM; the real page loads only when the user activates the placeholder tab
- `restoreMode: "fast"` — always fast
- `restoreMode: "throttled"` — always throttled
- `restoreMode: "placeholder"` — always placeholder

In placeholder mode, windows are created with placeholder URLs, groups are re-created after tabs exist, and tabs are never discarded. In normal/throttled modes, inactive tabs are discarded via `chrome.tabs.discard` after creation to bound memory. The original active tab is re-activated at the end (matched by `tabKey` in placeholder mode).

When `restoreInNewWindow` is `false`, the first saved window restores into the current active window instead of spawning a new one; later windows still spawn new. `fullscreen`, `maximized`, and `minimized` window states are all restored.

Returns a report with `mode`, `restoredTabs`, `createdWindows`, `discardedCount`, `placeholderCount`, `skippedTabs`, and `errors`.

## Popup (`src/popup/`)

`popup.html` lists saved sessions in cards. Each card shows name, timestamp, window/tab/group counts, group pills, a large-session warning when `tabCount > 250`, and action buttons: Restore, Rename, Delete. The Restore button requires confirmation before sending the `Restore` message. A progress bar shows live restore progress via `chrome.runtime.onMessage` (`RestoreProgress`). The popup provides Save Entire Session and an Open Settings action in its header. Session search matches session names as well as tab titles, URLs, and domains. `liveStats` shows a capture preview of the current session. Import and Export are available only on the Options page.

The session-name input has an associated `<label>`, icon buttons use `aria-label`, and all buttons show a visible `:focus-visible` outline (WCAG 2.2 AA).

## Options (`src/options/`)

Settings page for `autosaveEnabled`, `autosaveIntervalMinutes`, `restorePinnedFirst`, `skipInternalPages`, `restoreMode`, `autoDiscardEnabled`, `placeholderThreshold`, `fastThreshold`, `maxUserSessions`, and `maxAutoSessions`. Restore processing can be automatic or explicitly forced to fast, throttled, or placeholder mode. Settings are normalized and validated against canonical ranges in `session-model.js`; the fast threshold must remain below the placeholder threshold. The page also supports exporting and importing saved sessions.

## Placeholder page (`src/pages/`)

Loaded when a tab is restored in placeholder mode. Reads `sessionId` and `tabKey` from the query string, looks the tab up in `chrome.storage.local.get("SessionsV1")`, and renders the saved title, URL, domain, description (`ogDescription` > `description` > `h1`), saved favicon (with Google favicon service fallback keyed off domain), OG image, theme color accent, and saved timestamp. Buttons: Load This Page (navigates to the real URL), Open in New Tab, Copy URL. Falls back to URL-query title/URL if storage lookup fails.

## Styling

`src/styles/global.css` is the shared design system loaded first by every HTML page. It defines semantic tokens for colors, typography, borders, radii, and shadows; base body styles; shared `.app-header`, `.app-logo`, `.surface-card`, `.btn` variants, and `.form-control` controls; and a high-contrast `:focus-visible` treatment (WCAG 2.2 SC 2.4.11). Each page stylesheet contains only page-specific composition, layout, scrolling, and responsive rules.

## License

[MIT](./LICENSE)
