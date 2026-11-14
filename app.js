/**
 * STREAM COMMAND CENTER • CLIENT APPLICATION
 * Clean, classic, modular, zero-delay architecture.
 */

// =========================================================================
// APPLICATION STATE
// =========================================================================
const state = {
  user: null,
  dashboard: null,
  activeTab: "overview",
  selectedPlatforms: new Set(["youtube", "twitch", "facebook", "tiktok", "instagram", "x"]),
  chatSearchQuery: "",
  replyTarget: null,
  pollTimer: null,
  obsTimer: null,
  obsStreaming: false,
  obsRecording: false,
  obsMuted: false,
  selectedVideoFile: null,
  avatarBase64: null,
  authMode: "login" // "login" | "register"
};

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Server responded with ${res.status}`);
  }
  return data;
}

let toastTimer = null;
function showToast(message) {
  const toast = $("#toastNotice");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getInitials(name) {
  return (name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase() || "R";
}

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// =========================================================================
// AUTHENTICATION & SESSION MANAGEMENT
// =========================================================================
async function checkSession() {
  try {
    const { user } = await api("/api/me");
    if (user) {
      setSignedIn(user);
    } else {
      setSignedOut();
    }
  } catch (_) {
    setSignedOut();
  }
}

function setSignedIn(user) {
  state.user = user;
  $("#authView").style.display = "none";
  $("#workspaceView").style.display = "block";
  $("#mainNavTabs").style.display = "flex";
  $("#headerActions").style.display = "flex";

  // Update Header Avatar & Name
  updateHeaderUser(user);

  // Set OBS Browser Source URL in Alert Box
  const overlayUrl = `${window.location.origin}/alerts.html`;
  const urlEl = $("#alertOverlayUrl");
  if (urlEl) urlEl.textContent = overlayUrl;

  // Auto-connect all 6 platforms on startup
  api("/api/platforms/auto-connect", { method: "POST", body: JSON.stringify({ platform: "all" }) }).catch(() => {});

  // Start polling dashboard & OBS state
  refreshDashboard();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshDashboard, 1200);

  loadVideosHistory();
  fetchObsPairingCode();
  pollObsState();
  clearInterval(state.obsTimer);
  state.obsTimer = setInterval(pollObsState, 2500);
}

function setSignedOut() {
  state.user = null;
  clearInterval(state.pollTimer);
  clearInterval(state.obsTimer);
  $("#authView").style.display = "flex";
  $("#workspaceView").style.display = "none";
  $("#mainNavTabs").style.display = "none";
  $("#headerActions").style.display = "none";
}

function updateHeaderUser(user) {
  const nameEl = $("#headerUserName");
  const avatarEl = $("#headerUserAvatar");
  if (nameEl) nameEl.textContent = user.name || "Streamer";
  if (avatarEl) {
    if (user.avatar) {
      avatarEl.innerHTML = `<img src="${user.avatar}" alt="${escapeHtml(user.name)}">`;
    } else {
      avatarEl.textContent = getInitials(user.name);
    }
  }
}

// Auth Tab Switch (Sign In vs Register)
$("#authTabLogin")?.addEventListener("click", () => {
  state.authMode = "login";
  $("#authTabLogin").classList.add("active");
  $("#authTabRegister").classList.remove("active");
  $("#authNameGroup").style.display = "none";
  $("#btnAuthSubmit span").textContent = "Sign In to Studio";
  $("#authErrorMsg").style.display = "none";
});

$("#authTabRegister")?.addEventListener("click", () => {
  state.authMode = "register";
  $("#authTabRegister").classList.add("active");
  $("#authTabLogin").classList.remove("active");
  $("#authNameGroup").style.display = "flex";
  $("#btnAuthSubmit span").textContent = "Create Account";
  $("#authErrorMsg").style.display = "none";
});

// Auth Form Submit
$("#authForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authInputEmail").value.trim();
  const password = $("#authInputPassword").value;
  const name = $("#authInputName")?.value.trim();
  const errBox = $("#authErrorMsg");
  errBox.style.display = "none";

  const endpoint = state.authMode === "register" ? "/api/register" : "/api/login";
  const payload = state.authMode === "register" ? { email, password, name } : { email, password };

  try {
    const { user } = await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
    setSignedIn(user);
    showToast(`Welcome, ${user.name}!`);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.style.display = "block";
  }
});

// Instant Demo Button
$("#btnInstantDemo")?.addEventListener("click", async () => {
  try {
    const { user } = await api("/api/quick-connect", { method: "POST", body: "{}" });
    setSignedIn(user);
    showToast(`Welcome to Demo Mode, ${user.name}!`);
  } catch (err) {
    showToast(err.message);
  }
});

// Logout Button
$("#headerLogoutBtn")?.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch (_) {}
  setSignedOut();
  showToast("Signed out successfully.");
});

// =========================================================================
// NAVIGATION TABS
// =========================================================================
function switchTab(tabId) {
  state.activeTab = tabId;
  $$(".nav-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  $$(".tab-view").forEach((view) => {
    view.classList.toggle("active", view.id === `tab${capitalize(tabId)}`);
  });
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

document.addEventListener("click", (e) => {
  const navBtn = e.target.closest(".nav-tab-btn");
  if (navBtn && navBtn.dataset.tab) {
    switchTab(navBtn.dataset.tab);
  }
  const linkBtn = e.target.closest("[data-tab-link]");
  if (linkBtn && linkBtn.dataset.tabLink) {
    switchTab(linkBtn.dataset.tabLink);
  }
});

// =========================================================================
// DASHBOARD & PLATFORMS SYNC
// =========================================================================
async function refreshDashboard() {
  if (!state.user) return;
  try {
    const data = await api("/api/dashboard");
    state.dashboard = data;
    renderDashboard(data);
  } catch (_) {}
}

function renderDashboard(data) {
  const platforms = data.platforms || {};
  const platformKeys = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"];

  // 1. Total Audience & Connected Count
  const totalAudience = Number(data.totalViewers || 0);
  const totalEl = $("#totalAudienceCount");
  if (totalEl) totalEl.textContent = totalAudience.toLocaleString();

  const connectedList = platformKeys.filter((k) => platforms[k]?.connected);
  const connCountEl = $("#connectedPlatformsCount");
  if (connCountEl) connCountEl.textContent = `${connectedList.length} / 6`;

  // 2. Render each platform card
  platformKeys.forEach((key) => {
    const p = platforms[key] || { connected: false, viewers: 0 };

    // Badge
    const badge = $(`#platBadge_${key}`);
    if (badge) {
      badge.className = `status-badge ${p.connected ? "connected" : "disconnected"}`;
      badge.textContent = p.connected ? "● Connected" : "○ Disconnected";
    }

    // Handle / Account Name
    const handleEl = $(`#platHandle_${key}`);
    if (handleEl) {
      handleEl.textContent = p.handle || p.channel || p.page || p.accountName || "Channel";
    }

    // Viewers / Status Value
    const viewersEl = $(`#platViewers_${key}`);
    if (viewersEl) {
      if (["tiktok", "instagram", "x"].includes(key)) {
        viewersEl.textContent = p.connected ? "Active" : "Ready";
      } else {
        viewersEl.textContent = Number(p.viewers || 0).toLocaleString();
      }
    }

    // Toggle Button
    const toggleBtn = $(`.btn-plat-toggle[data-platform="${key}"]`);
    if (toggleBtn) {
      toggleBtn.classList.toggle("active", Boolean(p.connected));
      toggleBtn.textContent = p.connected ? "Connected" : "Connect";
    }
  });

  // 3. Render Unified Chat
  renderChatComments(data.comments || []);
  renderPinnedComment(data.pinnedComment);

  // 4. Render Live Alerts
  renderAlertsFeed(data.alerts || []);
}

// Auto-Connect All Button
$("#btnAutoConnectAll")?.addEventListener("click", async () => {
  showToast("⚡ Re-synchronizing all 6 live platforms...");
  try {
    await api("/api/platforms/auto-connect", { method: "POST", body: JSON.stringify({ platform: "all" }) });
    showToast("✓ All 6 platforms connected & synchronized!");
    refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// Platform Connect / Disconnect Toggle
document.addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest('[data-action="toggle-connect"]');
  if (toggleBtn) {
    const platform = toggleBtn.dataset.platform;
    const isConn = toggleBtn.classList.contains("active");
    const endpoint = isConn ? "/api/platforms/disconnect" : "/api/platforms/auto-connect";
    try {
      await api(endpoint, { method: "POST", body: JSON.stringify({ platform }) });
      showToast(`${isConn ? "Disconnected" : "Connected"} ${platform}`);
      refreshDashboard();
    } catch (err) {
      showToast(err.message);
    }
  }
});

// Copy to Clipboard Buttons
document.addEventListener("click", (e) => {
  const copyBtn = e.target.closest("[data-copy-target]");
  if (copyBtn) {
    const targetEl = $(copyBtn.dataset.copyTarget);
    if (targetEl) {
      const text = targetEl.textContent.trim();
      navigator.clipboard.writeText(text).then(() => {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = originalText), 1600);
        showToast("Copied to clipboard!");
      });
    }
  }
});

// =========================================================================
// UNIFIED LIVE CHAT STREAM
// =========================================================================
function renderChatComments(comments) {
  const feed = $("#chatFeed");
  const countSpan = $("#chatCountSpan");
  const countBadge = $("#chatCountBadge");
  if (!feed) return;

  const allPlatforms = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"];

  // Calculate per-platform counts
  const counts = { all: comments.length };
  allPlatforms.forEach((p) => (counts[p] = 0));
  comments.forEach((c) => {
    const p = c.platform || "youtube";
    if (counts[p] !== undefined) counts[p]++;
  });

  // Update count indicators in filter bar
  if (countSpan) countSpan.textContent = comments.length;
  if (countBadge) countBadge.textContent = comments.length;
  const filterAllCount = $("#filterCount_all");
  if (filterAllCount) filterAllCount.textContent = comments.length;
  allPlatforms.forEach((p) => {
    const el = $(`#filterCount_${p}`);
    if (el) el.textContent = counts[p] || 0;
  });

  // Update active styling on filter pills
  const allSelected = allPlatforms.every((p) => state.selectedPlatforms.has(p));
  const allPill = $(`.chat-filter-pill[data-filter="all"]`);
  if (allPill) allPill.classList.toggle("active", allSelected);

  allPlatforms.forEach((p) => {
    const pill = $(`.chat-filter-pill[data-filter="${p}"]`);
    if (pill) pill.classList.toggle("active", state.selectedPlatforms.has(p));
  });

  // Filter comments by selected platforms
  let filtered = comments.filter((c) => {
    const p = c.platform || "youtube";
    return state.selectedPlatforms.has(p);
  });

  // Filter comments by search query
  if (state.chatSearchQuery) {
    const q = state.chatSearchQuery.toLowerCase();
    filtered = filtered.filter((c) =>
      (c.author && c.author.toLowerCase().includes(q)) ||
      (c.message && c.message.toLowerCase().includes(q))
    );
  }

  if (filtered.length === 0) {
    if (comments.length > 0) {
      feed.innerHTML = `
        <div class="empty-chat-state">
          <div class="empty-chat-icon">🔍</div>
          <h3>No Comments Found</h3>
          <p>No comments match your active platform filter or search. Click "Select All" above to view comments across all 6 networks.</p>
        </div>`;
    } else {
      feed.innerHTML = `
        <div class="empty-chat-state">
          <div class="empty-chat-icon">💬</div>
          <h3>Unified Chat Stream Ready</h3>
          <p>When you start broadcasting or viewers comment on YouTube, Twitch, Facebook, TikTok, Instagram or X, messages will appear here in real time.</p>
        </div>`;
    }
    return;
  }

  feed.innerHTML = filtered.map((c) => {
    const isHost = Boolean(c.isHost);
    const platform = c.platform || "youtube";
    const timeStr = c.time ? new Date(c.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";

    let avatarHtml = escapeHtml(getInitials(c.author));
    if (isHost && state.user?.avatar) {
      avatarHtml = `<img src="${state.user.avatar}" alt="Avatar">`;
    } else if (c.avatar) {
      avatarHtml = `<img src="${c.avatar}" alt="Avatar">`;
    }

    return `
      <div class="comment-item ${isHost ? "is-host" : ""}" data-comment-id="${escapeHtml(c.id)}" data-platform="${platform}">
        <div class="comment-avatar-circle">${avatarHtml}</div>
        <div class="comment-main">
          <div class="comment-header-row">
            <span class="comment-author-name">${escapeHtml(c.author || "Viewer")}</span>
            <span class="comment-platform-pill ${platform}">${platform}</span>
            <span class="comment-time">${timeStr}</span>
          </div>
          <div class="comment-message">${escapeHtml(c.message || "")}</div>
          <div class="comment-actions-row">
            <button type="button" class="btn-comment-action" data-action="reply-comment" data-author="${escapeHtml(c.author)}" data-platform="${platform}" data-id="${escapeHtml(c.id)}">↳ Reply</button>
            <button type="button" class="btn-comment-action" data-action="pin-comment" data-id="${escapeHtml(c.id)}">📌 Pin</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderPinnedComment(pinned) {
  const banner = $("#chatPinnedBanner");
  if (!banner) return;
  if (pinned) {
    banner.style.display = "flex";
    $("#pinnedAuthor").textContent = `@${pinned.author || "Viewer"}`;
    $("#pinnedMessage").textContent = pinned.message || "";
  } else {
    banner.style.display = "none";
  }
}

// Chat Platform Filter Click
$("#chatFilters")?.addEventListener("click", (e) => {
  const pill = e.target.closest(".chat-filter-pill");
  if (!pill || !pill.dataset.filter) return;
  const target = pill.dataset.filter;
  const allPlatforms = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"];

  if (target === "all") {
    // Select all 6 platforms
    allPlatforms.forEach((p) => state.selectedPlatforms.add(p));
  } else {
    const allSelected = allPlatforms.every((p) => state.selectedPlatforms.has(p));
    if (allSelected) {
      // If currently all are selected, isolate to the clicked platform (instant focus mode!)
      state.selectedPlatforms.clear();
      state.selectedPlatforms.add(target);
    } else {
      // Toggle this platform in or out of the set
      if (state.selectedPlatforms.has(target)) {
        state.selectedPlatforms.delete(target);
        // If nothing is left selected, reset to all
        if (state.selectedPlatforms.size === 0) {
          allPlatforms.forEach((p) => state.selectedPlatforms.add(p));
        }
      } else {
        state.selectedPlatforms.add(target);
      }
    }
  }

  if (state.dashboard?.comments) {
    renderChatComments(state.dashboard.comments);
  }
});

// "Select All" Button
$("#btnSelectAllFilters")?.addEventListener("click", () => {
  ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"].forEach((p) => state.selectedPlatforms.add(p));
  state.chatSearchQuery = "";
  const searchInput = $("#chatSearchInput");
  if (searchInput) searchInput.value = "";
  if (state.dashboard?.comments) {
    renderChatComments(state.dashboard.comments);
  }
});

// Search comments or @user input
$("#chatSearchInput")?.addEventListener("input", (e) => {
  state.chatSearchQuery = e.target.value.trim();
  if (state.dashboard?.comments) {
    renderChatComments(state.dashboard.comments);
  }
});

// Reply and Pin Actions
document.addEventListener("click", async (e) => {
  // Reply Click
  const replyBtn = e.target.closest('[data-action="reply-comment"]');
  if (replyBtn) {
    state.replyTarget = {
      id: replyBtn.dataset.id,
      author: replyBtn.dataset.author,
      platform: replyBtn.dataset.platform
    };
    $("#replyPreviewBar").style.display = "flex";
    $("#replyAuthor").textContent = `@${state.replyTarget.author}`;
    $("#replyPlatformName").textContent = capitalize(state.replyTarget.platform);
    $("#chatInputMessage").focus();
  }

  // Pin Click
  const pinBtn = e.target.closest('[data-action="pin-comment"]');
  if (pinBtn) {
    const commentId = pinBtn.dataset.id;
    try {
      await api("/api/chat/pin", { method: "POST", body: JSON.stringify({ commentId }) });
      showToast("Comment spotlighted & pinned to top!");
      refreshDashboard();
    } catch (err) {
      showToast(err.message);
    }
  }
});

// Cancel Reply
$("#btnCancelReply")?.addEventListener("click", () => {
  state.replyTarget = null;
  $("#replyPreviewBar").style.display = "none";
});

// Unpin Message
$("#btnUnpinMessage")?.addEventListener("click", async () => {
  try {
    await api("/api/chat/pin", { method: "DELETE" });
    showToast("Comment unpinned.");
    refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// Send Chat Message
$("#chatComposeForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chatInputMessage");
  const message = input.value.trim();
  if (!message) return;

  const payload = {
    message,
    replyToId: state.replyTarget?.id || null,
    replyToAuthor: state.replyTarget?.author || null,
    targetPlatform: state.replyTarget?.platform || "all"
  };

  try {
    await api("/api/chat/send", { method: "POST", body: JSON.stringify(payload) });
    input.value = "";
    state.replyTarget = null;
    $("#replyPreviewBar").style.display = "none";
    refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// =========================================================================
// OMNIPUBLISH VIDEO SYNDICATION
// =========================================================================
const dropzone = $("#fileDropzone");
const fileInput = $("#videoFileInput");

dropzone?.addEventListener("click", () => fileInput?.click());

dropzone?.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));

dropzone?.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files?.length) {
    handleFileSelect(e.dataTransfer.files[0]);
  }
});

fileInput?.addEventListener("change", (e) => {
  if (e.target.files?.length) {
    handleFileSelect(e.target.files[0]);
  }
});

function handleFileSelect(file) {
  state.selectedVideoFile = file;
  $("#selectedFileName").textContent = file.name;
  $("#selectedFileSize").textContent = formatBytes(file.size);
  $("#selectedFileInfo").classList.add("active");
  dropzone.style.display = "none";
  if (!$("#uploadTitle").value) {
    $("#uploadTitle").value = file.name.replace(/\.[^/.]+$/, "");
  }
}

$("#btnRemoveSelectedFile")?.addEventListener("click", () => {
  state.selectedVideoFile = null;
  $("#selectedFileInfo").classList.remove("active");
  dropzone.style.display = "block";
  if (fileInput) fileInput.value = "";
});

// Publish Video Submit
$("#btnSubmitPublish")?.addEventListener("click", async () => {
  const title = $("#uploadTitle").value.trim();
  if (!title) {
    showToast("Please enter a video title");
    $("#uploadTitle").focus();
    return;
  }

  const selectedPlats = $$('input[name="pubPlat"]:checked').map((cb) => cb.value);
  if (!selectedPlats.length) {
    showToast("Please select at least 1 destination platform");
    return;
  }

  const desc = $("#uploadDesc").value.trim();
  const fileName = state.selectedVideoFile?.name || `${title.toLowerCase().replace(/\s+/g, "_")}.mp4`;
  const fileSize = state.selectedVideoFile?.size || 14800000;

  // Animate progress bar
  const pBox = $("#uploadProgressBar");
  const pFill = $("#uploadProgressFill");
  const pText = $("#uploadStatusText");
  pBox.classList.add("active");
  pFill.style.width = "25%";
  pText.textContent = "Transcoding master 1080p stream...";

  setTimeout(() => {
    pFill.style.width = "65%";
    pText.textContent = `Distributing to ${selectedPlats.length} platforms simultaneously...`;
  }, 400);

  try {
    const res = await api("/api/videos/upload", {
      method: "POST",
      body: JSON.stringify({
        title,
        description: desc,
        platforms: selectedPlats,
        fileName,
        fileSize
      })
    });

    pFill.style.width = "100%";
    pText.textContent = "Video successfully syndicated!";
    showToast(`✓ Published "${title}" to ${selectedPlats.length} platforms!`);

    setTimeout(() => {
      pBox.classList.remove("active");
      pFill.style.width = "0%";
      $("#uploadTitle").value = "";
      $("#uploadDesc").value = "";
      $("#btnRemoveSelectedFile")?.click();
      loadVideosHistory();
    }, 900);
  } catch (err) {
    pBox.classList.remove("active");
    showToast(err.message);
  }
});

async function loadVideosHistory() {
  const container = $("#uploadHistoryList");
  if (!container) return;
  try {
    const { videos } = await api("/api/videos");
    if (!videos || !videos.length) {
      container.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-faint);">No videos published yet. Upload your first clip to start syndicating!</div>`;
      return;
    }
    container.innerHTML = videos.map((v) => {
      const timeStr = new Date(v.createdAt).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const plats = Object.keys(v.platforms || {}).map((p) => `<span class="comment-platform-pill ${p}">${p}</span>`).join(" ");

      return `
        <div class="history-item">
          <div class="history-top">
            <span class="history-title">${escapeHtml(v.title)}</span>
            <span class="history-time">${timeStr}</span>
          </div>
          <div class="history-platforms">${plats}</div>
        </div>
      `;
    }).join("");
  } catch (_) {}
}

// =========================================================================
// ALERT BOX & OVERLAYS
// =========================================================================
function renderAlertsFeed(alerts) {
  const containers = [$("#alertsActivityFeed"), $("#chatAlertsActivityFeed")].filter(Boolean);
  if (!containers.length) return;
  if (!alerts || !alerts.length) {
    containers.forEach((c) => {
      c.innerHTML = `<div style="text-align:center; padding:24px 16px; color:var(--text-faint); font-size:12px;">No live alerts yet. Use the test buttons above to trigger live alerts!</div>`;
    });
    return;
  }

  const html = alerts.map((a) => {
    const icon = a.type === "subscribe" ? "💎" : a.type === "like" ? "❤️" : "🚀";
    const timeStr = a.time ? new Date(a.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";

    return `
      <div class="alert-item-card">
        <span class="alert-type-badge">${icon}</span>
        <div class="alert-info-col">
          <div class="alert-user-bold">${escapeHtml(a.username || "Viewer")}</div>
          <div class="alert-desc-text">${escapeHtml(a.message || a.detail || "")}</div>
        </div>
        <span class="alert-item-time">${timeStr}</span>
      </div>
    `;
  }).join("");

  containers.forEach((c) => (c.innerHTML = html));
}

// Test Alert Buttons
document.addEventListener("click", async (e) => {
  const testBtn = e.target.closest("[data-test-alert]");
  if (testBtn) {
    const type = testBtn.dataset.testAlert;
    try {
      await api("/api/alerts/test", { method: "POST", body: JSON.stringify({ type }) });
      showToast(`Test ${type} alert sent to OBS Browser Source!`);
      refreshDashboard();
    } catch (err) {
      showToast(err.message);
    }
  }
});

// =========================================================================
// OBS STUDIO REMOTE CONTROLLER
// =========================================================================
async function fetchObsPairingCode() {
  try {
    const { pairingCode } = await api("/api/obs/pairing-code", { method: "POST", body: "{}" });
    const codeEl = $("#obsPairingCodeDisplay");
    if (codeEl) codeEl.textContent = pairingCode || "ONLINE";
  } catch (_) {}
}

$("#btnRefreshPairingCode")?.addEventListener("click", fetchObsPairingCode);

async function pollObsState() {
  if (!state.user) return;
  try {
    const { online, state: obsData } = await api("/api/obs/state");
    const pill = $("#headerObsPill");
    const text = $("#headerObsText");
    const metric = $("#obsMetricState");
    const metricSub = $("#obsMetricSub");
    const chatBadge = $("#chatObsStatusBadge");

    if (online) {
      if (pill) pill.className = "obs-status-pill online";
      if (text) text.textContent = "OBS Connected";
      if (metric) metric.textContent = "Connected";
      if (metricSub) metricSub.textContent = "WebSocket 4455 active";
      if (chatBadge) {
        chatBadge.className = "status-badge connected";
        chatBadge.textContent = "Connected";
      }
    } else {
      if (pill) pill.className = "obs-status-pill";
      if (text) text.textContent = "OBS Ready";
      if (metric) metric.textContent = "Ready";
      if (metricSub) metricSub.textContent = "Port 4455 standby";
      if (chatBadge) {
        chatBadge.className = "status-badge disconnected";
        chatBadge.textContent = "Standby";
      }
    }

    if (obsData) {
      state.obsStreaming = Boolean(obsData.outputActive || obsData.streamActive);
      state.obsRecording = Boolean(obsData.recording || obsData.recordActive);
      state.obsMuted = Boolean(obsData.micMuted);

      // Extract real-time telemetry (CPU, Dropped Frames, Upload Bitrate, FPS)
      const cpu = typeof obsData.cpuUsage === "number" ? obsData.cpuUsage.toFixed(1) : "4.8";
      const dropCount = Number(obsData.droppedFrames || 0);
      const dropPct = typeof obsData.dropPercentage === "number" ? obsData.dropPercentage.toFixed(1) : "0.0";
      const bitrate = Number(obsData.uploadBitrate || (state.obsStreaming ? 6000 : (online ? 6000 : 0)));
      const bitrateFormatted = bitrate > 0 ? `${bitrate.toLocaleString()} kbps` : (state.obsStreaming ? "6,000 kbps" : "0 kbps");
      const mbps = (bitrate / 1000).toFixed(1);
      const fps = typeof obsData.activeFps === "number" ? obsData.activeFps.toFixed(1) : "60.0";

      // 1. Update Live Chat Companion Mini Telemetry
      const chatCpu = $("#chatObsCpu");
      if (chatCpu) chatCpu.textContent = `${cpu}%`;
      const chatDrop = $("#chatObsDrop");
      if (chatDrop) {
        chatDrop.textContent = `${dropCount} (${dropPct}%)`;
        chatDrop.className = `telemetry-mini-val ${Number(dropPct) > 2 ? "danger" : "good"}`;
      }
      const chatUpload = $("#chatObsUpload");
      if (chatUpload) chatUpload.textContent = bitrateFormatted;
      const chatFps = $("#chatObsFps");
      if (chatFps) chatFps.textContent = `${fps} FPS`;

      // 2. Update OBS Studio Remote Full Telemetry Grid
      const fullCpu = $("#fullObsCpu");
      if (fullCpu) fullCpu.textContent = `${cpu}%`;
      const badgeCpu = $("#badgeObsCpu");
      if (badgeCpu) badgeCpu.textContent = Number(cpu) > 40 ? "High" : "Normal";
      const fullCpuSub = $("#fullObsCpuSub");
      if (fullCpuSub) fullCpuSub.textContent = Number(cpu) > 40 ? "High encoder load" : "Low encoder load";

      const fullDrop = $("#fullObsDrop");
      if (fullDrop) fullDrop.textContent = `${dropCount.toLocaleString()} Frames`;
      const badgeDrop = $("#badgeObsDrop");
      if (badgeDrop) {
        badgeDrop.textContent = `${dropPct}%`;
        badgeDrop.className = `status-badge ${Number(dropPct) > 2 ? "disconnected" : "connected"}`;
      }
      const fullDropSub = $("#fullObsDropSub");
      if (fullDropSub) {
        fullDropSub.textContent = `● ${dropPct}% dropped (${Number(dropPct) > 2 ? "Network congested" : "Optimal"})`;
        fullDropSub.className = `obs-telem-sub ${Number(dropPct) > 2 ? "danger" : "good"}`;
      }

      const fullUpload = $("#fullObsUpload");
      if (fullUpload) fullUpload.textContent = bitrateFormatted;
      const fullUploadSub = $("#fullObsUploadSub");
      if (fullUploadSub) fullUploadSub.textContent = `${mbps} MB/s relay throughput`;

      const fullFps = $("#fullObsFps");
      if (fullFps) fullFps.textContent = `${fps} FPS`;

      const streamBtn = $("#btnObsStreamToggle");
      const recordBtn = $("#btnObsRecordToggle");
      const muteBtn = $("#btnObsMuteToggle");
      const chatStreamBtn = $("#btnChatObsStream");
      const chatRecordBtn = $("#btnChatObsRecord");
      const chatMuteBtn = $("#btnChatObsMute");

      if (streamBtn) {
        streamBtn.classList.toggle("active", state.obsStreaming);
        $("#lblObsStream").textContent = state.obsStreaming ? "Stop Live Stream" : "Start Live Stream";
      }
      if (chatStreamBtn) {
        chatStreamBtn.classList.toggle("active", state.obsStreaming);
        $("#lblChatObsStream").textContent = state.obsStreaming ? "Stop Stream" : "Start Stream";
      }

      if (recordBtn) {
        recordBtn.classList.toggle("active", state.obsRecording);
        $("#lblObsRecord").textContent = state.obsRecording ? "Stop Recording" : "Start Recording";
      }
      if (chatRecordBtn) {
        chatRecordBtn.classList.toggle("active", state.obsRecording);
        $("#lblChatObsRecord").textContent = state.obsRecording ? "Stop Record" : "Start Record";
      }

      if (muteBtn) {
        muteBtn.classList.toggle("active", state.obsMuted);
        $("#lblObsMute").textContent = state.obsMuted ? "Unmute Mic" : "Mute Microphone";
      }
      if (chatMuteBtn) {
        chatMuteBtn.classList.toggle("active", state.obsMuted);
        $("#lblChatObsMute").textContent = state.obsMuted ? "Unmute Mic" : "Mute Mic";
      }
    }
  } catch (_) {}
}

// Studio Action Commands
async function toggleObsStream() {
  const req = state.obsStreaming ? "StopStream" : "StartStream";
  try {
    await api("/api/obs/commands", { method: "POST", body: JSON.stringify({ requestType: req }) });
    state.obsStreaming = !state.obsStreaming;
    showToast(state.obsStreaming ? "Live stream starting..." : "Live stream stopped.");
    pollObsState();
  } catch (err) {
    showToast(err.message);
  }
}

async function toggleObsRecord() {
  const req = state.obsRecording ? "StopRecord" : "StartRecord";
  try {
    await api("/api/obs/commands", { method: "POST", body: JSON.stringify({ requestType: req }) });
    state.obsRecording = !state.obsRecording;
    showToast(state.obsRecording ? "Recording started." : "Recording stopped.");
    pollObsState();
  } catch (err) {
    showToast(err.message);
  }
}

async function toggleObsMute() {
  const req = "SetInputMute";
  try {
    await api("/api/obs/commands", {
      method: "POST",
      body: JSON.stringify({ requestType: req, requestData: { inputName: "Mic/Aux", inputMuted: !state.obsMuted } })
    });
    state.obsMuted = !state.obsMuted;
    showToast(state.obsMuted ? "Microphone muted" : "Microphone unmuted");
    pollObsState();
  } catch (err) {
    showToast(err.message);
  }
}

// Wire up OBS action buttons for both Tab 5 and Live Chat
$("#btnObsStreamToggle")?.addEventListener("click", toggleObsStream);
$("#btnChatObsStream")?.addEventListener("click", toggleObsStream);

$("#btnObsRecordToggle")?.addEventListener("click", toggleObsRecord);
$("#btnChatObsRecord")?.addEventListener("click", toggleObsRecord);

$("#btnObsMuteToggle")?.addEventListener("click", toggleObsMute);
$("#btnChatObsMute")?.addEventListener("click", toggleObsMute);

// Scene Switcher (Synchronized across Tab 5 and Live Chat)
document.addEventListener("click", async (e) => {
  const sceneBtn = e.target.closest(".btn-scene-select");
  if (sceneBtn && sceneBtn.dataset.scene) {
    const sceneName = sceneBtn.dataset.scene;
    $$(".btn-scene-select").forEach((b) => {
      b.classList.toggle("active", b.dataset.scene === sceneName);
    });
    try {
      await api("/api/obs/commands", {
        method: "POST",
        body: JSON.stringify({ requestType: "SetCurrentProgramScene", requestData: { sceneName } })
      });
      showToast(`Switched scene to "${sceneName}"`);
    } catch (err) {
      showToast(err.message);
    }
  }
});

// =========================================================================
// MODALS MANAGEMENT (PROFILE & PLATFORM CONFIG)
// =========================================================================
function openModal(modalId) {
  const modal = $(`#${modalId}`);
  if (modal) {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeModal(modalId) {
  const modal = $(`#${modalId}`);
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
}

document.addEventListener("click", (e) => {
  const closeBtn = e.target.closest("[data-close-modal]");
  if (closeBtn) {
    closeModal(closeBtn.dataset.closeModal);
  }
  if (e.target.classList.contains("modal-backdrop")) {
    e.target.classList.remove("open");
    e.target.setAttribute("aria-hidden", "true");
  }
});

// Profile Modal Open
$("#headerProfileBtn")?.addEventListener("click", () => {
  if (!state.user) return;
  $("#profileInputName").value = state.user.name || "";
  $("#profileInputEmail").value = state.user.email || "";
  $("#profileInputPassword").value = "";

  const preview = $("#modalAvatarPreview");
  if (state.user.avatar) {
    preview.innerHTML = `<img src="${state.user.avatar}" alt="Avatar">`;
  } else {
    preview.textContent = getInitials(state.user.name);
  }
  state.avatarBase64 = state.user.avatar || null;
  openModal("profileModal");
});

// Profile Avatar File Selection
$("#btnChooseAvatarFile")?.addEventListener("click", () => {
  $("#modalAvatarFileInput")?.click();
});

$("#modalAvatarFileInput")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.avatarBase64 = reader.result;
    $("#modalAvatarPreview").innerHTML = `<img src="${reader.result}" alt="Preview">`;
  };
  reader.readAsDataURL(file);
});

$("#btnRemoveAvatar")?.addEventListener("click", () => {
  state.avatarBase64 = null;
  $("#modalAvatarPreview").textContent = getInitials($("#profileInputName").value);
  if ($("#modalAvatarFileInput")) $("#modalAvatarFileInput").value = "";
});

// Save Profile Submit
$("#profileForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#profileInputName").value.trim();
  const password = $("#profileInputPassword").value;
  if (!name) return;

  const payload = { name, avatar: state.avatarBase64 };
  if (password && password.length >= 8) {
    payload.password = password;
  }

  try {
    const { user } = await api("/api/user/profile", { method: "PUT", body: JSON.stringify(payload) });
    state.user = user;
    updateHeaderUser(user);
    closeModal("profileModal");
    showToast("Profile updated successfully!");
    refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// Platform Configure Modal
document.addEventListener("click", async (e) => {
  const cfgBtn = e.target.closest('[data-action="configure"]');
  if (!cfgBtn) return;
  const platform = cfgBtn.dataset.platform;
  $("#cfgPlatformKey").value = platform;
  $("#platformModalTitle").textContent = `Configure ${capitalize(platform)}`;

  const bodyEl = $("#platformConfigBody");
  bodyEl.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-faint);">Loading settings...</div>`;
  openModal("platformModal");

  try {
    const { settings } = await api("/api/settings");
    const pData = settings[platform] || {};

    if (platform === "youtube") {
      bodyEl.innerHTML = `
        <div class="form-group">
          <label class="form-label">YouTube Channel Name / Title</label>
          <input type="text" class="form-input" name="channel" value="${escapeHtml(pData.channel || "Rezanur Live")}">
        </div>
        <div class="form-group">
          <label class="form-label">API Key (Optional for private streams)</label>
          <input type="text" class="form-input" name="apiKey" placeholder="AIzaSy..." value="${escapeHtml(pData.apiKey || "")}">
        </div>
        <div class="form-group">
          <label class="form-label">Stream Key</label>
          <input type="password" class="form-input" name="streamKey" placeholder="••••••••" value="${escapeHtml(pData.streamKey || "")}">
        </div>
      `;
    } else if (platform === "twitch") {
      bodyEl.innerHTML = `
        <div class="form-group">
          <label class="form-label">Twitch Channel Username</label>
          <input type="text" class="form-input" name="channel" value="${escapeHtml(pData.channel || "rezanur_live")}">
        </div>
        <div class="form-group">
          <label class="form-label">Stream Key</label>
          <input type="password" class="form-input" name="streamKey" placeholder="live_••••••••" value="${escapeHtml(pData.streamKey || "")}">
        </div>
      `;
    } else if (platform === "facebook") {
      bodyEl.innerHTML = `
        <div class="form-group">
          <label class="form-label">Facebook Page Name</label>
          <input type="text" class="form-input" name="page" value="${escapeHtml(pData.page || "Rezanur Gaming")}">
        </div>
        <div class="form-group">
          <label class="form-label">Page Access Token</label>
          <input type="password" class="form-input" name="accessToken" placeholder="EAA..." value="${escapeHtml(pData.accessToken || "")}">
        </div>
      `;
    } else {
      bodyEl.innerHTML = `
        <div class="form-group">
          <label class="form-label">${capitalize(platform)} Account Handle</label>
          <input type="text" class="form-input" name="handle" value="${escapeHtml(pData.handle || `@rezanur_live`)}">
        </div>
        <div class="form-group">
          <label class="form-label">Syndication RTMP Key</label>
          <input type="password" class="form-input" name="streamKey" placeholder="••••••••" value="${escapeHtml(pData.streamKey || "")}">
        </div>
      `;
    }
  } catch (err) {
    bodyEl.innerHTML = `<div style="color:var(--danger); padding:10px;">Failed to load settings: ${escapeHtml(err.message)}</div>`;
  }
});

// Save Platform Config Form Submit
$("#platformConfigForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const platform = $("#cfgPlatformKey").value;
  const formData = new FormData(e.target);
  const patch = {};

  formData.forEach((value, key) => {
    if (key !== "cfgPlatformKey") patch[key] = value.trim();
  });

  try {
    const { settings } = await api("/api/settings");
    settings[platform] = { ...(settings[platform] || {}), ...patch };
    await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
    closeModal("platformModal");
    showToast(`Saved settings for ${capitalize(platform)}`);
    refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// =========================================================================
// INITIALIZE APPLICATION
// =========================================================================
document.addEventListener("DOMContentLoaded", () => {
  checkSession();
});
