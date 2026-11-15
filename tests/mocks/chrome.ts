export class MockChrome {
  store = new Map<string, unknown>();
  storageListeners: any[] = [];
  storage = {
    local: {
      async get(keys: any) {
        const d = (this as any).owner.store;
        if (keys == null) return { ...Object.fromEntries(d) };
        if (typeof keys === "string") return { [keys]: d.has(keys) ? d.get(keys) : undefined };
        if (Array.isArray(keys)) { const r: any = {}; for (const k of keys) r[k] = d.has(k) ? d.get(k) : undefined; return r; }
        const r: any = {}; for (const [k, def] of Object.entries(keys)) r[k] = d.has(k) ? d.get(k) : def; return r;
      },
      async set(items: Record<string, unknown>) {
        const changes: any = {};
        for (const [k, v] of Object.entries(items)) { changes[k] = { newValue: v, oldValue: (this as any).owner.store.get(k) }; (this as any).owner.store.set(k, v); }
        for (const l of (this as any).owner.storageListeners) l(changes, "local");
      },
      async getBytesInUse() {
        let b = 0; for (const v of (this as any).owner.store.values()) b += new TextEncoder().encode(JSON.stringify(v)).length; return b;
      },
      addListener(l: any) { (this as any).owner.storageListeners.push(l); },
    }
  };
  tabStore: any[] = []; nextTabId = 1;
  windowStore: any[] = []; nextWindowId = 1;
  groupStore: any[] = [];
  alarmsMap = new Map<string, any>();
  alarmListeners: any[] = [];
  runtimeLastError: { message: string } | null = null;
  messageListeners: any[] = []; installedListeners: any[] = [];
  constructor(public owner: MockChrome) { (this.storage.local as any).owner = owner; }
  async tabsCreate(p: any) { const id = this.nextTabId++; const w = p.windowId ?? (this.windowStore[0]?.id ?? 1); const t = { id, windowId: w, url: p.url ?? "", title: "", active: !!p.active, pinned: !!p.pinned, groupId: -1 }; this.tabStore.push(t); return t; }
  async tabsDiscard(id: number) { }
  async tabsUpdate(id: number, p: any) { const t = this.tabStore.find((x: any) => x.id === id); if (t) { if (p.url !== undefined) t.url = p.url; if (p.active !== undefined) t.active = p.active; if (p.pinned !== undefined) t.pinned = p.pinned; } return t; }
  async tabsGroup(o: any) { const id = this.nextWindowId++ + 1000; this.groupStore.push({ id, windowId: o.createProperties?.windowId ?? 1, title: "", color: "grey", collapsed: false }); return id; }
  async windowsCreate(p: any) { const id = this.nextWindowId++; const w = { id, state: p.state ?? "normal", focused: p.focused ?? true }; this.windowStore.push(w); return w; }
  async windowsGetAll() { return this.windowStore.map((w: any) => ({ ...w, tabs: this.tabStore.filter((t: any) => t.windowId === w.id) })); }
  async windowsGet(id: number) { return this.windowStore.find((w: any) => w.id === id); }
  async windowsUpdate(id: number, p: any) { const w = this.windowStore.find((x: any) => x.id === id); if (w && p.state) w.state = p.state; return w; }
  async tabGroupsQuery() { return this.groupStore; }
  async tabGroupsUpdate(id: number, p: any) { const g = this.groupStore.find((x: any) => x.id === id); if (g) { if (p.title) g.title = p.title; if (p.color) g.color = p.color; if (p.collapsed !== undefined) g.collapsed = p.collapsed; } return g; }
  async scriptingExecuteScript(d: any) { return [{ result: d.func?.() }]; }
  async runtimeSendMessage(msg: any) { for (const l of this.messageListeners) l(msg, {}, () => { }); }
  addMessageListener(l: any) { this.messageListeners.push(l); }
  addInstalledListener(l: any) { this.installedListeners.push(l); }
  tabs = { query: async (q: any) => { let r = this.tabStore; if (q.active !== undefined) r = r.filter((t: any) => t.active === q.active); if (q.windowId !== undefined) r = r.filter((t: any) => t.windowId === q.windowId); return r; }, create: (p: any) => this.tabsCreate(p), discard: (id: number) => this.tabsDiscard(id), update: (id: number, p: any) => this.tabsUpdate(id, p), group: (o: any) => this.tabsGroup(o) };
  windows = { create: (p: any) => this.windowsCreate(p), getAll: async () => this.windowsGetAll(), get: (id: number) => this.windowsGet(id), update: (id: number, p: any) => this.windowsUpdate(id, p) };
  tabGroups = { query: async () => this.tabGroupsQuery(), update: (id: number, p: any) => this.tabGroupsUpdate(id, p) };
  scripting = { executeScript: (d: any) => this.scriptingExecuteScript(d) };
  runtime = { sendMessage: (msg: any) => this.runtimeSendMessage(msg), onInstalled: { addListener: (l: any) => this.installedListeners.push(l) }, onMessage: { addListener: (l: any) => this.messageListeners.push(l) }, getURL: (p: string) => p };
  alarms = { create: async (n: string, o?: any) => { this.alarmsMap.set(n, o ?? {}); }, clear: async (n: string) => { this.alarmsMap.delete(n); }, onAlarm: { addListener: (l: any) => this.alarmListeners.push(l) } };
  commands = { onCommand: { addListener: () => { } } };
}

export const chrome = new MockChrome({} as MockChrome);
(chrome.storage.local as any).owner = chrome;
globalThis.chrome = chrome;

declare global { var chrome: MockChrome; }
