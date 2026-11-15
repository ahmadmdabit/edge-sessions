const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// --- Elements ---
const sessionList = $("#sessionList");
const template = $("#sessionTemplate");
const tabRowTemplate = $("#tabRowTemplate");

// Detail panel
const detailPanel = $("#detailPanel");
const detailEmpty = $("#detailEmpty");
const detailName = $("#detailName");
const detailSub = $("#detailSub");
const detailSourceBadge = $("#detailSourceBadge");
const detailRestoreBtn = $("#detailRestoreBtn");
const detailDeleteBtn = $("#detailDeleteBtn");
const detailTree = $("#detailTree");
const detailSearch = $("#detailSearch");

// List controls
const filterToggle = $("#filterToggle");
const listSearch = $("#listSearch");
const countLabel = $("#countLabel");

// --- State ---
let sessions = [];
let selectedId = null;
let filter = "all"; // "all" | "user" | "auto"
let listQuery = "";
let detailQuery = "";

const GroupColors = {
  grey: "#94a3b8",
  blue: "#3b82f6",
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  pink: "#ec4899",
  purple: "#a855f7",
  cyan: "#06b6d4",
  orange: "#f97316",
};

async function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// Debounce helper for search inputs
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Send a message to the background service worker with a timeout so a
// silent failure never leaves the popup stuck on "Loading…".
// SaveCurrent needs a longer budget: it captures every tab with page meta.
async function send(msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Message timeout: " + msg.type)), timeoutMs);
    chrome.runtime.sendMessage(msg, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function refresh() {
  $("#liveStats").textContent = "Loading…";
  let res;
  try {
    res = await send({ type: "GetSessions" });
  } catch (e) {
    console.error("[EdgeSessions] GetSessions threw", { error: e });
    $("#liveStats").textContent = "Error loading sessions.";
    return;
  }
  if (!res.ok) {
    console.error("[EdgeSessions] GetSessions not ok:", res.error);
    $("#liveStats").textContent = "Error loading sessions.";
    return;
  }
  sessions = res.sessions || [];
  renderList(filteredSessions());
  updateCount();

  let preview;
  try {
    preview = await send({ type: "CapturePreview" });
  } catch (e) {
    console.error("[EdgeSessions] CapturePreview threw", { error: e });
    $("#liveStats").textContent = "Preview unavailable.";
    return;
  }
  if (preview.ok) {
    $("#liveStats").textContent = `${preview.session.windowCount} windows • ${preview.session.tabCount} tabs • ${preview.session.groupCount} groups`;
  } else {
    console.error("[EdgeSessions] CapturePreview not ok:", preview.error);
    $("#liveStats").textContent = "Preview unavailable.";
  }
}

// Apply filter + search to the session list. Search covers the session name
// and every tab's title, URL, and domain.
function filteredSessions() {
  const query = listQuery.trim().toLocaleLowerCase();

  return sessions
    .filter((s) => {
      if (filter === "user") return s.source === "user";
      if (filter === "auto") return s.source === "auto";
      return true;
    })
    .filter((s) => {
      if (!query) return true;

      const searchableText = [
        s.name || "",
        ...(s.windows || []).flatMap((win) =>
          (win.tabs || []).flatMap((tab) => [
            tab.title || "",
            tab.url || "",
            getDomainFromUrl(tab.url || ""),
          ]),
        ),
      ]
        .join("\n")
        .toLocaleLowerCase();

      return searchableText.includes(query);
    });
}

function updateCount() {
  const shown = filteredSessions().length;
  const total = sessions.length;
  countLabel.textContent = `${shown} of ${total} saved`;
}

function renderList(listSessions) {
  sessionList.innerHTML = "";
  if (listSessions.length === 0) {
    sessionList.innerHTML = '<p style="text-align:center;color:#64748b;font-size:13px;padding:16px;">No matching sessions.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  listSessions.forEach((sess) => {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector(".session-card");
    card.dataset.id = sess.id;
    if (sess.id === selectedId) card.classList.add("selected");

    clone.querySelector(".session-name").textContent = sess.name;
    const sourceLabel = sess.source === "auto" ? "• autosaved" : "• saved";
    clone.querySelector(".session-meta").innerHTML = `<span>${new Date(sess.createdAt).toLocaleString()} ${sourceLabel}</span><span>${sess.windowCount} windows • ${sess.tabCount} tabs • ${sess.groupCount} groups</span>`;

    const isLarge = sess.tabCount > 250;
    if (isLarge) {
      const warn = document.createElement("div");
      warn.style.cssText = "font-size:11px;color:#d97706;background:#fef3c7;padding:4px 6px;border-radius:6px;margin-top:6px;";
      warn.textContent = `⚠️ Large session (${sess.tabCount} tabs) - will restore as lazy placeholders to prevent OOM`;
      card.appendChild(warn);
    }

    const groupsEl = clone.querySelector(".groups-preview");
    if (sess.groups.length === 0) {
      groupsEl.innerHTML = '<span style="font-size:11px;color:#94a3b8;">No tab groups</span>';
    } else {
      sess.groups.slice(0, 8).forEach((g) => {
        const pill = document.createElement("span");
        pill.className = "group-pill";
        pill.style.borderLeftColor = GroupColors[g.color] || "#94a3b8";
        pill.textContent = `● ${g.title || "(Unnamed group)"}`;
        groupsEl.appendChild(pill);
      });
      if (sess.groups.length > 8) {
        const more = document.createElement("span");
        more.className = "group-pill";
        more.textContent = `+${sess.groups.length - 8} more`;
        groupsEl.appendChild(more);
      }
    }

    // Clicking the card body selects the session; buttons stop propagation.
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectSession(sess.id);
    });

    clone.querySelector(".restore").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      restoreSessionById(sess.id);
    });

    clone.querySelector(".delete").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (confirm(`Delete "${sess.name}"?`)) {
        send({ type: "Delete", id: sess.id }).then(() => {
          refresh();
          if (selectedId === sess.id) selectSession(null);
        });
      }
    });

    clone.querySelector(".rename").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const name = prompt("New name", sess.name);
      if (name) {
        send({ type: "Rename", id: sess.id, name }).then(() => {
          refresh();
        });
      }
    });

    frag.appendChild(clone);
  });
  sessionList.appendChild(frag);
}

function selectSession(id) {
  selectedId = id;
  renderList(filteredSessions()); // re-render to update selected highlight
  if (!id) {
    detailPanel.classList.add("hidden");
    detailEmpty.classList.remove("hidden");
    return;
  }
  const sess = sessions.find((s) => s.id === id);
  if (!sess) return;
  detailEmpty.classList.add("hidden");
  detailPanel.classList.remove("hidden");
  renderDetail(sess);
}

function renderDetail(sess) {
  detailName.textContent = sess.name;
  detailSub.textContent = `${new Date(sess.createdAt).toLocaleString()} • ${sess.windowCount} windows • ${sess.tabCount} tabs • ${sess.groupCount} groups`;
  detailSourceBadge.textContent = sess.source === "auto" ? "auto" : "user";
  detailSourceBadge.className = `detail-source-badge ${sess.source}`;

  detailRestoreBtn.onclick = (e) => {
    e.stopPropagation();
    restoreSessionById(sess.id);
  };

  detailDeleteBtn.onclick = (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${sess.name}"?`)) {
      send({ type: "Delete", id: sess.id }).then(() => {
        refresh();
        selectSession(null);
      });
    }
  };

  renderTreeview(sess);
}

function renderTreeview(sess) {
  detailTree.innerHTML = "";
  const query = detailQuery.toLowerCase();

  const windows = (sess.windows || []).slice();
  const frag = document.createDocumentFragment();

  windows.forEach((win, wIdx) => {
    if (!win.tabs || win.tabs.length === 0) return;

    const winDetails = document.createElement("details");
    winDetails.className = "win-details";
    winDetails.setAttribute("open", true);
    const winSummary = document.createElement("summary");
    winSummary.textContent = `Window ${wIdx + 1} (${win.tabs.length} tabs)`;
    winDetails.appendChild(winSummary);

    const groupsMap = new Map();
    const ungrouped = [];

    (win.tabs || []).forEach((tab) => {
      if (tab.groupKey && sess.groups) {
        const g = sess.groups.find((group) => group.key === tab.groupKey);
        if (g) {
          if (!groupsMap.has(g.key)) groupsMap.set(g.key, { group: g, tabs: [] });
          groupsMap.get(g.key).tabs.push(tab);
          return;
        }
      }
      ungrouped.push(tab);
    });

    groupsMap.forEach(({ group, tabs }) => {
      const grpDetails = document.createElement("details");
      grpDetails.className = "grp-details";
      grpDetails.setAttribute("open", true);
      const grpSummary = document.createElement("summary");
      const colorDot = document.createElement("span");
      colorDot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${GroupColors[group.color] || "#94a3b8"};margin-right:6px;`;
      grpSummary.appendChild(colorDot);
      grpSummary.textContent = group.title || "(Unnamed group)";
      grpDetails.appendChild(grpSummary);

      const tabsContainer = document.createElement("div");
      tabsContainer.style.cssText = "padding-left: 18px;";
      renderTabRows(tabsContainer, tabs, query);
      grpDetails.appendChild(tabsContainer);
      winDetails.appendChild(grpDetails);
    });

    if (ungrouped.length) {
      const ungDetails = document.createElement("details");
      ungDetails.className = "grp-details";
      ungDetails.setAttribute("open", true);
      const ungSummary = document.createElement("summary");
      ungSummary.textContent = "Ungrouped tabs";
      ungDetails.appendChild(ungSummary);

      const tabsContainer = document.createElement("div");
      tabsContainer.style.cssText = "padding-left: 18px;";
      renderTabRows(tabsContainer, ungrouped, query);
      ungDetails.appendChild(tabsContainer);
      winDetails.appendChild(ungDetails);
    }

    frag.appendChild(winDetails);
  });

  if (frag.children.length === 0) {
    detailTree.innerHTML = '<p style="color:#64748b;font-size:12px;padding:8px;">No tabs in this session.</p>';
  } else {
    detailTree.appendChild(frag);
  }
}

function renderTabRows(container, tabs, query) {
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  let rendered = 0;

  tabs.forEach((tab) => {
    if (query) {
      const haystack = `${tab.title || ""} ${tab.url || ""} ${getDomainFromUrl(tab.url || "")}`.toLowerCase();
      if (!haystack.includes(query)) return;
    }
    rendered++;

    const clone = tabRowTemplate.content.cloneNode(true);
    const row = clone.querySelector(".tab-row");
    row.dataset.url = tab.url || "";

    const favicon = clone.querySelector(".tab-favicon");
    favicon.src = tab.favIconUrl || "";
    favicon.alt = "";

    const titleEl = clone.querySelector(".tab-title");
    titleEl.textContent = tab.title || tab.url || "Untitled";
    titleEl.title = tab.title || tab.url || "";

    const domainEl = clone.querySelector(".tab-domain");
    domainEl.textContent = getDomainFromUrl(tab.url || "");

    const openTabBtn = clone.querySelector(".open-tab");
    openTabBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      chrome.tabs.create({ url: tab.url });
    };

    const openWinBtn = clone.querySelector(".open-window");
    openWinBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      chrome.windows.create({ url: tab.url });
    };

    frag.appendChild(row);
  });

  if (rendered === 0 && query) {
    container.innerHTML = '<p style="font-size:11px;color:#64748b;padding:4px 0;">No matching tabs.</p>';
  } else {
    container.appendChild(frag);
  }
}

function restoreSessionById(id) {
  const sess = sessions.find((s) => s.id === id);
  if (!sess) return;
  $("#progress").classList.remove("hidden");
  $("#progressText").textContent = "Starting restore...";
  send({ type: "Restore", id }).then((r) => {
    $("#progress").classList.add("hidden");
    if (!r.ok) {
      alert("Restore failed: " + r.error);
      return;
    }
    const rep = r.report;
    let msg = `Mode: ${rep.mode.toUpperCase()}\n`;
    msg += `Restored ${rep.restoredTabs} tabs in ${rep.createdWindows.length} windows.\n`;
    if (rep.discardedCount > 0) msg += `💤 ${rep.discardedCount} tabs auto-discarded (click to load, 0 memory).\n`;
    if (rep.placeholderCount > 0) msg += `📄 ${rep.placeholderCount} tabs restored as lazy placeholders (click to load).\n`;
    msg += `Skipped ${rep.skippedTabs.length} pages.`;
    if (rep.errors?.length) {
      msg +=
        `\n\nERRORS:\n` +
        rep.errors
          .slice(0, 5)
          .map((e) => `- ${e.url || e.group || ""}: ${e.error}`)
          .join("\n");
    }
    alert(msg);
  });
}

// --- Controls ---

// Filter toggle
filterToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  $$("#filterToggle button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  filter = btn.dataset.filter;
  renderList(filteredSessions());
  updateCount();
});

// List search
listSearch.addEventListener(
  "input",
  debounce(() => {
    listQuery = listSearch.value;
    renderList(filteredSessions());
    updateCount();
  }, 150),
);

// Detail search
detailSearch.addEventListener(
  "input",
  debounce(() => {
    detailQuery = detailSearch.value;
    const sess = sessions.find((s) => s.id === selectedId);
    if (sess) renderTreeview(sess);
  }, 150),
);

$("#saveBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  e.preventDefault();
  if (confirm(`Are you sure to save the current session?`)) {
    const name = $("#sessionName").value.trim();
    // Save is acknowledged immediately by the service worker (quick snapshot,
    // no per-tab scripting). Background enrichment completes independently.
    const res = await send({ type: "SaveCurrent", name: name || undefined }, 5000);
    if (!res.ok) {
      alert("Save failed: " + res.error);
      return;
    }
    $("#sessionName").value = "";
    refresh();
  }
});

$("#openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Messages from the background service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "RestoreProgress") {
    const pct = Math.round((msg.done / Math.max(1, msg.total)) * 100);
    $("#progressFill").style.width = pct + "%";
    $("#progressText").textContent = `${msg.done}/${msg.total} - ${msg.msg}`;
    return;
  }

  if (msg.type === "SessionSaved") {
    // The save is acknowledged before capture completes. Refresh only when the
    // background confirms that the session has been persisted.
    refresh();
    return;
  }

  if (msg.type === "SessionEnriched") {
    // Metadata was added to an already-saved session; reload the card data.
    refresh();
    return;
  }

  if (msg.type === "SaveFailed") {
    alert("Save failed: " + (msg.error || "Unknown error"));
  }
});

document.addEventListener("DOMContentLoaded", refresh);

// Small helper used by detail rendering (avoids re-importing session-model)
function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch (e) {
    console.warn("[EdgeSessions] Failed to extract domain from URL", { url, error: e });
    return "";
  }
}
