import type { Session, SavedTab } from "../lib/types.js";

(async function () {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("sessionId");
  const tabKey = params.get("tabKey");
  // Fallback from URL if storage fails
  let realUrl = params.get("url") || "";
  let realTitle = params.get("title") || realUrl;
  let meta = null;
  let groupTitle = "";
  let savedAt = "";
  let savedFavIconUrl = "";

  // 1. Try to load full session + tab from storage
  try {
    if (sessionId && tabKey && chrome.storage) {
      const data = await chrome.storage.local.get("SessionsV1");
      const sessions = (data.SessionsV1 ?? []) as Session[];
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        savedAt = String(session.createdAt);
        // Find tab by tabKey across all windows
        for (const win of session.windows) {
          const found = win.tabs.find((t: SavedTab) => t.tabKey === tabKey);
          if (found) {
            realUrl = found.url;
            realTitle = found.title;
            meta = found.meta || null;
            savedFavIconUrl = found.favIconUrl || "";
            if (found.groupKey) {
              const g = session.groups.find((gr: Session["groups"][number]) => gr.key === found.groupKey);
              if (g) groupTitle = g.title;
            }
            break;
          }
        }
      }
    }
  } catch (e) {
    console.warn("[EdgeSessions] Placeholder storage lookup failed, using URL fallback", {
      sessionId,
      tabKey,
      error: e,
    });
  }

  // 2. Render
  const required = <T extends Element = HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing required element: #${id}`);
    return element as unknown as T;
  };
  const titleEl = required("title");
  const urlEl = required("url");
  const domainEl = required("domain");
  const descEl = required("description");
  const groupEl = required("groupInfo");
  const favImg = required<HTMLImageElement>("faviconImg");
  const favFallback = required("faviconFallback");
  const ogWrap = required("ogImageWrap");
  const ogImg = required<HTMLImageElement>("ogImage");
  const savedAtEl = required("savedAt");
  const loadBtn = required<HTMLButtonElement>("loadBtn");
  const openInNewTabBtn = required<HTMLButtonElement>("openInNewTabBtn");
  const copyUrlBtn = required<HTMLButtonElement>("copyUrlBtn");

  document.title = `💤 ${realTitle}`;
  titleEl.textContent = realTitle;
  urlEl.textContent = realUrl;

  if (meta?.domain) domainEl.textContent = meta.domain;
  else if (realUrl) {
    try {
      domainEl.textContent = new URL(realUrl).hostname;
    } catch (e) {
      console.warn("[EdgeSessions] Failed to parse placeholder URL", { url: realUrl, error: e });
    }
  }

  // Description: prefer ogDescription > description > h1
  const desc = meta?.ogDescription || meta?.description || meta?.h1 || "";
  if (desc) {
    descEl.textContent = desc.slice(0, 280);
    descEl.classList.remove("hidden");
  }

  if (groupTitle) groupEl.textContent = `Tab Group: ${groupTitle}`;

  // Favicon: prefer the saved favIconUrl, then the Google favicon service for the page domain,
  // and finally the 🌐 fallback. A favicon failure never breaks the rest of the placeholder.
  const iconDomain =
    meta?.domain ||
    (() => {
      try {
        return new URL(realUrl).hostname.replace(/^www\./i, "");
      } catch (e) {
        console.warn("[EdgeSessions] Failed to derive favicon domain", { url: realUrl, error: e });
        return "";
      }
    })();

  function showFavicon(src: string) {
    favImg.src = src;
    favImg.onload = () => {
      favImg.style.display = "block";
      favFallback.style.display = "none";
    };
    favImg.onerror = () => {
      favImg.style.display = "none";
      favFallback.style.display = "block";
    };
  }

  if (savedFavIconUrl) {
    // 1. Try the real saved favicon first
    showFavicon(savedFavIconUrl);
    // 2. If it fails to load, fall back to the Google favicon service for the domain
    favImg.onerror = () => {
      if (iconDomain) {
        showFavicon(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(iconDomain)}&sz=64`);
      }
    };
  } else if (iconDomain) {
    showFavicon(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(iconDomain)}&sz=64`);
  } else {
    favImg.style.display = "none";
    favFallback.style.display = "block";
  }

  // OG Image: rich preview
  if (meta?.ogImage && meta.ogImage.startsWith("http")) {
    ogImg.src = meta.ogImage;
    ogImg.onload = () => ogWrap.classList.remove("hidden");
    ogImg.onerror = () => ogWrap.classList.add("hidden");
  }

  // Theme color accent
  if (meta?.themeColor) {
    const card = document.querySelector<HTMLElement>(".placeholder-card");
    if (card) card.style.borderTop = `4px solid ${meta.themeColor}`;
  }

  if (savedAt) {
    const d = new Date(savedAt);
    if (!isNaN(d.getTime())) savedAtEl.textContent = `Saved: ${d.toLocaleString()}`;
  }

  // 3. Actions
  let hasNavigated = false;
  function loadRealPage() {
    if (hasNavigated || !realUrl) return;
    hasNavigated = true;
    loadBtn.textContent = "Loading...";
    location.replace(realUrl);
  }

  loadBtn.addEventListener("click", loadRealPage);
  openInNewTabBtn.addEventListener("click", () => {
    window.open(realUrl, "_blank");
  });
  copyUrlBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(realUrl);
      copyUrlBtn.textContent = "Copied!";
    } catch (e) {
      console.warn("[EdgeSessions] Failed to copy placeholder URL to clipboard", { error: e });
    }
  });

  // Auto-load on activation
  let timer = null;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // timer = setTimeout(() => {
      //   if (!document.hidden) loadRealPage();
      // }, 350);
    } else if (timer) clearTimeout(timer);
  });
})();
