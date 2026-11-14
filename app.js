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
  selectedPlatforms: new Set(["youtube", "twitch", "facebook", "kick", "tiktok", "instagram", "x"]),
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
// REAL-TIME SOCKET.IO CLIENT
// =========================================================================
let socket = null;
function initSocket() {
  if (typeof io !== "function") return;
  if (socket) return;
  socket = io();
  socket.on("connect", () => {
    console.log("Socket.io live chat connected:", socket.id);
    if (state.user?.id) {
      socket.emit("join_user", { userId: state.user.id });
    }
  });
  socket.on("chat_message", (comment) => {
    appendLiveComment(comment);
  });
  socket.on("chat_history", (messages) => {
    if (Array.isArray(messages) && messages.length > 0) {
      state.dashboard = state.dashboard || {};
      state.dashboard.comments = messages;
      renderChatComments(messages);
    }
  });
}

function appendLiveComment(comment) {
  if (!state.dashboard) state.dashboard = {};
  state.dashboard.comments = state.dashboard.comments || [];
  if (state.dashboard.comments.some((c) => c.id === comment.id)) return;
  state.dashboard.comments.unshift(comment);
  renderChatComments(state.dashboard.comments);
}

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

  // Initialize real-time Socket.io live chat
  initSocket();
  if (socket) socket.emit("join_user", { userId: user.id });

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
  const platformKeys = ["youtube", "facebook", "kick", "twitch", "tiktok", "instagram", "x"];

  // 1. Total Audience & Connected Count
  const totalAudience = Number(data.totalViewers || 0);
  const totalEl = $("#totalAudienceCount");
  if (totalEl) totalEl.textContent = totalAudience.toLocaleString();

  const connectedList = platformKeys.filter((k) => platforms[k]?.connected);
  const connCountEl = $("#connectedPlatformsCount");
  if (connCountEl) connCountEl.textContent = `${connectedList.length} / ${platformKeys.length}`;

  const connSubEl = $("#connectedPlatformsSub");
  if (connSubEl) {
    if (connectedList.length === platformKeys.length) {
      connSubEl.textContent = "All channels connected & active";
      connSubEl.className = "metric-sub good";
    } else if (connectedList.length > 0) {
      connSubEl.textContent = `${connectedList.length} of ${platformKeys.length} channels connected`;
      connSubEl.className = "metric-sub good";
    } else {
      connSubEl.textContent = "No channels connected";
      connSubEl.className = "metric-sub";
    }
  }

  // Update top "Disconnect All" button if any connected
  const autoConnBtn = $("#btnAutoConnectAll");
  if (autoConnBtn) {
    autoConnBtn.innerHTML = connectedList.length > 0
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Disconnect All`
      : `🔗 Connect Platforms`;
  }

  // 2. Render each platform card
  platformKeys.forEach((key) => {
    const p = platforms[key] || { connected: false, viewers: 0 };
    const isConn = Boolean(p.connected);

    // Badge
    const badge = $(`#platBadge_${key}`);
    if (badge) {
      badge.className = `status-badge ${isConn ? "connected" : "disconnected"}`;
      badge.textContent = isConn ? "● Connected" : "○ Disconnected";
    }

    // Handle / Account Name
    const handleEl = $(`#platHandle_${key}`);
    if (handleEl) {
      if (isConn) {
        handleEl.classList.remove("muted");
        const name = p.accountName || p.page || p.channel || p.handle || "Connected Account";
        handleEl.innerHTML = p.avatar
          ? `<span style="display:inline-flex; align-items:center; gap:6px;"><img src="${escapeHtml(p.avatar)}" style="width:16px; height:16px; border-radius:50%; object-fit:cover;"> ${escapeHtml(name)}</span>`
          : escapeHtml(name);
      } else {
        handleEl.classList.add("muted");
        handleEl.textContent = "Not Connected";
      }
    }

    // Viewers / Status Value
    const viewersEl = $(`#platViewers_${key}`);
    if (viewersEl) {
      if (["tiktok", "instagram", "x"].includes(key)) {
        viewersEl.textContent = isConn ? "Active" : "Disconnected";
      } else {
        viewersEl.textContent = isConn ? Number(p.viewers || 0).toLocaleString() : "0";
      }
    }

    // Action Button (Connect or Disconnect)
    const toggleBtn = $(`.btn-plat-toggle[data-platform="${key}"]`);
    if (toggleBtn) {
      toggleBtn.classList.toggle("connected", isConn);
      if (isConn) {
        toggleBtn.textContent = "Disconnect";
        toggleBtn.title = `Disconnect ${key}`;
      } else {
        const labels = {
          youtube: "Connect with YouTube (OAuth 2.0)",
          facebook: "Connect with Facebook (OAuth 2.0)",
          kick: "Connect Kick Live Chat",
          twitch: "Connect with Twitch (OAuth 2.0)",
          tiktok: "Connect with TikTok (OAuth 2.0)",
          instagram: "Connect with Instagram (OAuth 2.0)",
          x: "Connect with X (OAuth 2.0)"
        };
        toggleBtn.textContent = labels[key] || "Connect";
      }
    }
  });

  // 3. Render Unified Chat
  renderChatComments(data.comments || []);
  renderPinnedComment(data.pinnedComment);

  // 4. Render Live Alerts
  renderAlertsFeed(data.alerts || []);
}

// Disconnect All Button
$("#btnAutoConnectAll")?.addEventListener("click", async () => {
  const platforms = state.dashboard?.platforms || {};
  const platformKeys = ["youtube", "facebook", "kick", "twitch", "tiktok", "instagram", "x"];
  const connectedList = platformKeys.filter((k) => platforms[k]?.connected);

  if (connectedList.length === 0) {
    showToast("Click 'Connect' on any platform card below to link your accounts!");
    return;
  }

  showToast("Disconnecting all platforms...");
  try {
    await api("/api/platforms/disconnect", { method: "POST", body: JSON.stringify({ platform: "all" }) });
    showToast("✓ All platforms disconnected.");
    refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
});

// Platform Connect / Disconnect Action Handler
document.addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest('[data-action="toggle-connect"]');
  if (!toggleBtn) return;
  const platform = toggleBtn.dataset.platform;
  const isConn = toggleBtn.classList.contains("connected");

  if (isConn) {
    try {
      await api("/api/platforms/disconnect", { method: "POST", body: JSON.stringify({ platform }) });
      showToast(`✓ Disconnected ${capitalize(platform)}`);
      refreshDashboard();
    } catch (err) {
      showToast(err.message);
    }
    return;
  }

  // Trigger Real Connection Flow
  if (platform === "youtube") {
    showToast("Redirecting to Google OAuth 2.0...");
    window.location.href = "/auth/youtube";
  } else if (platform === "facebook") {
    showToast("Redirecting to Facebook OAuth 2.0...");
    window.location.href = "/auth/facebook";
  } else if (platform === "instagram") {
    showToast("Redirecting to Instagram / Meta OAuth 2.0...");
    window.location.href = "/auth/instagram";
  } else if (platform === "x") {
    showToast("Redirecting to X (Twitter) OAuth 2.0...");
    window.location.href = "/auth/x";
  } else if (platform === "tiktok") {
    showToast("Redirecting to TikTok OAuth 2.0...");
    window.location.href = "/auth/tiktok";
  } else if (platform === "twitch") {
    showToast("Redirecting to Twitch OAuth 2.0...");
    window.location.href = "/auth/twitch";
  } else if (platform === "kick") {
    const ch = prompt("Enter your Kick channel username (e.g. xqc, ninja, or your channel):");
    if (!ch || !ch.trim()) return;
    try {
      await api("/api/kick/connect", { method: "POST", body: JSON.stringify({ channel: ch.trim() }) });
      showToast(`✓ Connected Kick channel @${ch.trim()}`);
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

  const allPlatforms = ["youtube", "twitch", "facebook", "kick", "tiktok", "instagram", "x"];

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
    const authorName = c.username || c.author || "Viewer";
    const timeStr = (c.timestamp || c.time) ? new Date(c.timestamp || c.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";

    let avatarHtml = escapeHtml(getInitials(authorName));
    if (isHost && state.user?.avatar) {
      avatarHtml = `<img src="${state.user.avatar}" alt="Avatar">`;
    } else if (c.avatar) {
      avatarHtml = `<img src="${c.avatar}" alt="Avatar">`;
    }

    const badgesHtml = Array.isArray(c.badges) && c.badges.length > 0
      ? c.badges.map((b) => `<span class="comment-platform-pill" style="opacity:0.85; font-size:9px; background:rgba(255,255,255,0.08);">${escapeHtml(b)}</span>`).join("")
      : "";

    return `
      <div class="comment-item ${isHost ? "is-host" : ""}" data-comment-id="${escapeHtml(c.id)}" data-platform="${platform}">
        <div class="comment-avatar-circle">${avatarHtml}</div>
        <div class="comment-main">
          <div class="comment-header-row">
            <span class="comment-author-name">${escapeHtml(authorName)}</span>
            <span class="comment-platform-pill ${platform}">${platform}</span>
            ${badgesHtml}
            <span class="comment-time">${timeStr}</span>
          </div>
          <div class="comment-message">${escapeHtml(c.message || "")}</div>
          <div class="comment-actions-row">
            <button type="button" class="btn-comment-action" data-action="reply-comment" data-author="${escapeHtml(authorName)}" data-platform="${platform}" data-id="${escapeHtml(c.id)}">↳ Reply</button>
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
  const allPlatforms = ["youtube", "twitch", "facebook", "kick", "tiktok", "instagram", "x"];

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
// SOCIAL STUDIO & OMNIPUBLISH (POSTS, PICTURES, STORIES, VIDEOS)
// =========================================================================
const studioState = {
  postType: "post", // "post" | "story" | "video"
  previewPlatform: "facebook", // "facebook" | "instagram" | "x" | "story"
  selectedFile: null,
  mediaDataUrl: null,
  mediaType: "none", // "image" | "video" | "none"
  storyGradient: "linear-gradient(135deg, #6366f1, #a855f7)",
  storyLink: ""
};

const dropzone = $("#fileDropzone");
const mediaFileInput = $("#mediaFileInput");
const videoFileInput = $("#videoFileInput");
const mediaPreviewContainer = $("#mediaPreviewContainer");
const mediaPreviewImg = $("#mediaPreviewImg");
const mediaPreviewVideo = $("#mediaPreviewVideo");
const selectedFileInfo = $("#selectedFileInfo");
const uploadDesc = $("#uploadDesc");
const uploadTitle = $("#uploadTitle");
const charCount = $("#charCount");
const storyLinkInput = $("#storyLinkInput");

// 1. Post Type Switcher
$$(".post-type-btn")?.forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".post-type-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    setPostType(btn.dataset.type);
  });
});

function setPostType(type) {
  studioState.postType = type;
  const isPost = type === "post";
  const isStory = type === "story";
  const isVideo = type === "video";

  if ($("#groupTitle")) $("#groupTitle").style.display = isVideo ? "flex" : "none";
  if ($("#storyBgGroup")) $("#storyBgGroup").style.display = isStory ? "flex" : "none";
  if ($("#storyLinkGroup")) $("#storyLinkGroup").style.display = isStory ? "flex" : "none";

  if ($("#dropzoneIcon")) $("#dropzoneIcon").textContent = isVideo ? "🎬" : isStory ? "📸" : "🖼️";
  if ($("#dropzoneText")) {
    $("#dropzoneText").textContent = isVideo
      ? "Click or drag & drop video file"
      : isStory
      ? "Click or drag & drop story picture / clip"
      : "Click or drag & drop picture / artwork";
  }
  if ($("#dropzoneSub")) {
    $("#dropzoneSub").textContent = isVideo
      ? "MP4, MOV, or WebM • Up to 4K 60fps"
      : isStory
      ? "Vertical 9:16 or standard image/video • Up to 25MB"
      : "PNG, JPG, WEBP, or GIF • Up to 25MB";
  }

  if ($("#labelDesc")) {
    $("#labelDesc").textContent = isVideo ? "Video Description & Notes" : isStory ? "Story Text Overlay / Caption" : "Post Caption & Content";
  }
  if (uploadDesc) {
    uploadDesc.placeholder = isVideo
      ? "Write your video description, chapters, and links..."
      : isStory
      ? "e.g. 🔴 LIVE NOW playing Warzone! Tap link to watch 👉"
      : "What's happening? Share stream news, highlights, or links...";
  }

  if ($("#btnSubmitPublishText")) {
    $("#btnSubmitPublishText").textContent = isVideo
      ? "Publish Video Across Selected Platforms"
      : isStory
      ? "Share 24h Story Across Platforms"
      : "Publish Post Across Selected Platforms";
  }

  if ($("#lblFacebook")) $("#lblFacebook").textContent = isStory ? "Facebook Story" : isVideo ? "Facebook Video / Reels" : "Facebook Feed";
  if ($("#lblInstagram")) $("#lblInstagram").textContent = isStory ? "Instagram Story" : isVideo ? "Instagram Reels" : "Instagram Feed";
  if ($("#lblTiktok")) $("#lblTiktok").textContent = isStory ? "TikTok Story" : isVideo ? "TikTok Shorts" : "TikTok Photo Mode";
  if ($("#lblX")) $("#lblX").textContent = isVideo ? "X Broadcast" : "X (Twitter) Post";
  if ($("#lblYoutube")) $("#lblYoutube").textContent = isVideo ? "YouTube VOD / Shorts" : "YouTube Community";

  if ($("#cbWrapTwitch")) $("#cbWrapTwitch").style.display = isVideo ? "flex" : "none";
  if ($("#cbWrapYoutube")) $("#cbWrapYoutube").style.display = isStory ? "none" : "flex";

  $$('input[name="pubPlat"]').forEach((cb) => {
    if (isStory) {
      cb.checked = ["facebook", "instagram", "tiktok"].includes(cb.value);
    } else if (isPost) {
      cb.checked = ["facebook", "instagram", "x", "youtube"].includes(cb.value);
    } else {
      cb.checked = true;
    }
  });

  if (isStory) {
    switchPreviewTab("story");
  } else if (studioState.previewPlatform === "story") {
    switchPreviewTab("facebook");
  }

  updateLivePreview();
}

// 2. Dropzone & File Selection
dropzone?.addEventListener("click", () => {
  if (studioState.postType === "video") {
    videoFileInput?.click();
  } else {
    mediaFileInput?.click();
  }
});

dropzone?.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));

dropzone?.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files?.length) {
    handleStudioFile(e.dataTransfer.files[0]);
  }
});

mediaFileInput?.addEventListener("change", (e) => {
  if (e.target.files?.length) handleStudioFile(e.target.files[0]);
});

videoFileInput?.addEventListener("change", (e) => {
  if (e.target.files?.length) handleStudioFile(e.target.files[0]);
});

function handleStudioFile(file) {
  studioState.selectedFile = file;
  $("#selectedFileName").textContent = file.name;
  $("#selectedFileSize").textContent = formatBytes(file.size);
  selectedFileInfo?.classList.add("active");
  dropzone.style.display = "none";

  const isImg = file.type.startsWith("image/");
  const isVid = file.type.startsWith("video/");
  studioState.mediaType = isImg ? "image" : isVid ? "video" : "none";

  if (uploadTitle && !uploadTitle.value && studioState.postType === "video") {
    uploadTitle.value = file.name.replace(/\.[^/.]+$/, "");
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    studioState.mediaDataUrl = e.target.result;
    mediaPreviewContainer?.classList.add("active");
    if (isImg) {
      if (mediaPreviewImg) { mediaPreviewImg.src = e.target.result; mediaPreviewImg.style.display = "block"; }
      if (mediaPreviewVideo) mediaPreviewVideo.style.display = "none";
    } else if (isVid) {
      if (mediaPreviewVideo) { mediaPreviewVideo.src = e.target.result; mediaPreviewVideo.style.display = "block"; }
      if (mediaPreviewImg) mediaPreviewImg.style.display = "none";
    }
    updateLivePreview();
  };
  reader.readAsDataURL(file);
}

function clearStudioMedia() {
  studioState.selectedFile = null;
  studioState.mediaDataUrl = null;
  studioState.mediaType = "none";
  selectedFileInfo?.classList.remove("active");
  mediaPreviewContainer?.classList.remove("active");
  if (mediaPreviewImg) mediaPreviewImg.src = "";
  if (mediaPreviewVideo) mediaPreviewVideo.src = "";
  if (mediaFileInput) mediaFileInput.value = "";
  if (videoFileInput) videoFileInput.value = "";
  dropzone.style.display = "block";
  updateLivePreview();
}

$("#btnRemoveSelectedFile")?.addEventListener("click", clearStudioMedia);
$("#btnRemoveMedia")?.addEventListener("click", clearStudioMedia);

// 3. Live Preview & Text Updates
uploadDesc?.addEventListener("input", () => {
  const len = uploadDesc.value.length;
  if (charCount) {
    charCount.textContent = `${len} / 280 (X limit)`;
    charCount.style.color = len > 280 ? "#ef4444" : "var(--text-faint)";
  }
  updateLivePreview();
});

storyLinkInput?.addEventListener("input", updateLivePreview);

$$(".hashtag-pill")?.forEach((pill) => {
  pill.addEventListener("click", () => {
    const tag = pill.dataset.tag;
    if (uploadDesc) {
      uploadDesc.value = (uploadDesc.value.trim() ? `${uploadDesc.value.trim()} ${tag}` : tag) + " ";
      uploadDesc.dispatchEvent(new Event("input"));
      uploadDesc.focus();
    }
  });
});

$$(".story-color-swatch")?.forEach((swatch) => {
  swatch.addEventListener("click", () => {
    $$(".story-color-swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
    studioState.storyGradient = swatch.dataset.gradient;
    updateLivePreview();
  });
});

$$(".preview-tab-btn")?.forEach((btn) => {
  btn.addEventListener("click", () => {
    switchPreviewTab(btn.dataset.preview);
  });
});

function switchPreviewTab(platform) {
  studioState.previewPlatform = platform;
  $$(".preview-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.preview === platform));

  const isStory = platform === "story";
  if ($("#feedMockup")) $("#feedMockup").style.display = isStory ? "none" : "flex";
  if ($("#storyMockup")) $("#storyMockup").style.display = isStory ? "flex" : "none";

  if ($("#mockupMeta")) {
    if (platform === "facebook") $("#mockupMeta").textContent = "Just now • 🌐 Public";
    else if (platform === "instagram") $("#mockupMeta").textContent = "Original audio • Sponsored";
    else if (platform === "x") {
      const handle = state.dashboard?.platforms?.x?.handle || state.user?.name?.toLowerCase().replace(/\s+/g, "") || "streamer";
      $("#mockupMeta").textContent = `@${handle.replace(/^@/, "")} • 2m`;
    }
    else $("#mockupMeta").textContent = "Just now • Public";
  }
  updateLivePreview();
}

function updateLivePreview() {
  const text = uploadDesc?.value.trim() || "What's happening? Share stream news, highlights, or links...";
  const user = state.user || {};
  const userName = user.name || "Streamer";
  const avatarLetter = userName.charAt(0).toUpperCase();

  if ($("#mockupName")) $("#mockupName").textContent = userName;
  if ($("#mockupAvatar")) $("#mockupAvatar").textContent = avatarLetter;
  if ($("#mockupContent")) $("#mockupContent").textContent = text;

  const mediaBox = $("#mockupMediaBox");
  const mediaImg = $("#mockupMediaImg");
  const mediaVid = $("#mockupMediaVideo");

  if (studioState.mediaDataUrl) {
    mediaBox?.classList.add("active");
    if (studioState.mediaType === "image") {
      if (mediaImg) { mediaImg.src = studioState.mediaDataUrl; mediaImg.style.display = "block"; }
      if (mediaVid) mediaVid.style.display = "none";
    } else {
      if (mediaVid) { mediaVid.src = studioState.mediaDataUrl; mediaVid.style.display = "block"; }
      if (mediaImg) mediaImg.style.display = "none";
    }
  } else {
    mediaBox?.classList.remove("active");
    if (mediaImg) mediaImg.src = "";
    if (mediaVid) mediaVid.src = "";
  }

  const storyMockup = $("#storyMockup");
  if (storyMockup) {
    if (studioState.mediaDataUrl && studioState.mediaType === "image") {
      storyMockup.style.background = `linear-gradient(rgba(0,0,0,0.3), rgba(0,0,0,0.5)), url(${studioState.mediaDataUrl}) center/cover no-repeat`;
    } else {
      storyMockup.style.background = studioState.storyGradient;
    }
  }
  if ($("#storyMockupName")) $("#storyMockupName").textContent = userName;
  if ($("#storyMockupAvatar")) $("#storyMockupAvatar").textContent = avatarLetter;
  if ($("#storyMockupText")) $("#storyMockupText").textContent = uploadDesc?.value.trim() || "🔴 LIVE NOW!";
  
  const linkVal = storyLinkInput?.value.trim();
  const storyLink = $("#storyMockupLink");
  if (storyLink) {
    if (linkVal) {
      storyLink.style.display = "inline-block";
      storyLink.textContent = `🔗 ${linkVal.replace(/^https?:\/\//, "").slice(0, 18)}...`;
    } else {
      storyLink.style.display = "inline-block";
      storyLink.textContent = "🔗 WATCH STREAM";
    }
  }
}

// 4. Submit & Syndication
$("#btnSubmitPublish")?.addEventListener("click", async () => {
  const type = studioState.postType;
  const isVideo = type === "video";
  const isStory = type === "story";
  const title = uploadTitle?.value.trim() || (isStory ? "24h Story" : "Social Post");
  const desc = uploadDesc?.value.trim() || "";

  if (isVideo && !uploadTitle.value.trim()) {
    showToast("Please enter a video title");
    uploadTitle?.focus();
    return;
  }

  if (!isVideo && !desc && !studioState.selectedFile) {
    showToast("Please write a caption or attach a picture/clip");
    uploadDesc?.focus();
    return;
  }

  const selectedPlats = $$('input[name="pubPlat"]:checked').map((cb) => cb.value);
  if (!selectedPlats.length) {
    showToast("Please select at least 1 destination platform");
    return;
  }

  const fileName = studioState.selectedFile?.name || (isVideo ? `${title.toLowerCase().replace(/\s+/g, "_")}.mp4` : "post_image.jpg");
  const fileSize = studioState.selectedFile?.size || (isVideo ? 14800000 : 850000);

  const pBox = $("#uploadProgressBar");
  const pFill = $("#uploadProgressFill");
  const pText = $("#uploadStatusText");
  pBox?.classList.add("active");
  if (pFill) pFill.style.width = "30%";
  if (pText) pText.textContent = isStory ? "Rendering 24h story & stickers..." : isVideo ? "Transcoding 1080p master stream..." : "Formatting media & tags...";

  setTimeout(() => {
    if (pFill) pFill.style.width = "70%";
    if (pText) pText.textContent = `Distributing to ${selectedPlats.length} platforms simultaneously...`;
  }, 400);

  try {
    await api("/api/videos/upload", {
      method: "POST",
      body: JSON.stringify({
        kind: type,
        title,
        description: desc,
        platforms: selectedPlats,
        fileName,
        fileSize,
        mediaPreview: studioState.mediaDataUrl,
        mediaType: studioState.mediaType,
        storyOptions: isStory ? { bgGradient: studioState.storyGradient, linkUrl: storyLinkInput?.value.trim() } : null
      })
    });

    if (pFill) pFill.style.width = "100%";
    if (pText) pText.textContent = `${isStory ? "Story" : isVideo ? "Video" : "Post"} successfully published!`;
    showToast(`✓ Published ${type} across ${selectedPlats.length} platforms!`);

    setTimeout(() => {
      pBox?.classList.remove("active");
      if (pFill) pFill.style.width = "0%";
      if (uploadTitle) uploadTitle.value = "";
      if (uploadDesc) uploadDesc.value = "";
      if (storyLinkInput) storyLinkInput.value = "";
      clearStudioMedia();
      loadVideosHistory();
    }, 900);
  } catch (err) {
    pBox?.classList.remove("active");
    showToast(err.message);
  }
});

async function loadVideosHistory() {
  const container = $("#uploadHistoryList");
  if (!container) return;
  try {
    const { videos } = await api("/api/videos");
    if (!videos || !videos.length) {
      container.innerHTML = `<div style="text-align:center; padding:40px 20px; color:var(--text-faint);">No publications yet. Create your first post or story to start syndicating!</div>`;
      return;
    }
    container.innerHTML = videos.map((v) => {
      const timeStr = new Date(v.createdAt).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const plats = Object.entries(v.platforms || {}).map(([pKey, pObj]) => {
        const url = pObj.url || "#";
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="comment-platform-pill ${pKey}" title="View on ${pKey}">${pKey} ↗</a>`;
      }).join(" ");

      const kind = v.kind || "video";
      const thumbHtml = v.mediaPreview
        ? `<div style="width:44px; height:44px; border-radius:6px; overflow:hidden; flex-shrink:0; background:#000;"><img src="${escapeHtml(v.mediaPreview)}" style="width:100%; height:100%; object-fit:cover;"></div>`
        : `<div style="width:44px; height:44px; border-radius:6px; background:var(--card-elevated); display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;">${kind === "story" ? "📸" : kind === "post" ? "📝" : "🎬"}</div>`;

      return `
        <div class="history-item">
          <div style="display:flex; gap:12px; align-items:center;">
            ${thumbHtml}
            <div style="flex:1; min-width:0;">
              <div class="history-top">
                <div style="display:flex; align-items:center; gap:8px;">
                  <span class="pub-type-badge ${kind}">${kind}</span>
                  <span class="history-title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(v.title || v.description || "Untitled")}</span>
                </div>
                <span class="history-time">${timeStr}</span>
              </div>
              <div class="history-platforms" style="margin-top:6px;">${plats}</div>
            </div>
          </div>
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
      const isConnected = Boolean(pData.autoConnected && (pData.accessToken || pData.refreshToken || pData.accountName));
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">1-Click OAuth 2.0</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: ${escapeHtml(pData.accountName || pData.channel || "YouTube")}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Authorize with your Google account to automatically stream &amp; ingest YouTube live chat comments in real time.</p>
          <a href="/auth/youtube" class="btn-oauth youtube">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
            <span>${isConnected ? "Reconnect YouTube with OAuth 2.0" : "Connect with YouTube Live (OAuth 2.0)"}</span>
          </a>
        </div>
        <div class="form-group">
          <label class="form-label">Channel Display Name</label>
          <input type="text" class="form-input" name="channel" value="${escapeHtml(pData.channel || pData.accountName || "Rezanur Live")}">
        </div>
        <div class="form-group">
          <label class="form-label">Stream Key</label>
          <input type="password" class="form-input" name="streamKey" placeholder="••••••••" value="${escapeHtml(pData.streamKey || "")}">
        </div>
      `;
    } else if (platform === "twitch") {
      const isConnected = Boolean(pData.autoConnected && (pData.accessToken || pData.refreshToken || pData.channel));
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">1-Click OAuth 2.0</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: @${escapeHtml(pData.accountName || pData.channel || "Twitch")}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Authorize with Twitch OAuth to connect live stream IRC chat &amp; badges without manual keys.</p>
          <a href="/auth/twitch" class="btn-oauth twitch">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>
            <span>${isConnected ? "Reconnect Twitch with OAuth 2.0" : "Connect with Twitch (OAuth 2.0)"}</span>
          </a>
        </div>
        <div class="form-group">
          <label class="form-label">Twitch Channel Username</label>
          <input type="text" class="form-input" name="channel" placeholder="e.g. your_channel" value="${escapeHtml(pData.channel || "")}">
        </div>
        <div class="form-group">
          <label class="form-label">Stream Key</label>
          <input type="password" class="form-input" name="streamKey" placeholder="live_••••••••" value="${escapeHtml(pData.streamKey || "")}">
        </div>
      `;
    } else if (platform === "facebook") {
      const isConnected = Boolean(pData.autoConnected && (pData.accessToken || pData.pageAccessToken || pData.page));
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">1-Click OAuth 2.0</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: ${escapeHtml(pData.pageName || pData.page || "Facebook Page")}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Authorize with Meta to automatically select your Page and sync Facebook Live video comments.</p>
          <a href="/auth/facebook" class="btn-oauth facebook">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            <span>${isConnected ? "Reconnect Facebook with OAuth 2.0" : "Connect with Facebook Live (OAuth 2.0)"}</span>
          </a>
        </div>
        <div class="form-group">
          <label class="form-label">Facebook Page Name</label>
          <input type="text" class="form-input" name="page" placeholder="e.g. My Gaming Page" value="${escapeHtml(pData.page || "")}">
        </div>
      `;
    } else if (platform === "kick") {
      const isConnected = Boolean(pData.autoConnected && pData.channel);
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Pusher WebSocket Gateway</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: @${escapeHtml(pData.channel)}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Connect to Kick's live stream chat via real-time Pusher WebSockets. No password or API keys required.</p>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="text" class="form-input" id="kickChannelInput" placeholder="Kick channel handle (e.g. xqc)" value="${escapeHtml(pData.channel || "")}">
            <button type="button" class="btn-oauth kick" id="btnKickConnectModal" style="width:auto; white-space:nowrap;">
              ${isConnected ? "Reconnect Kick" : "Connect Kick"}
            </button>
          </div>
        </div>
      `;
      setTimeout(() => {
        $("#btnKickConnectModal")?.addEventListener("click", async () => {
          const ch = $("#kickChannelInput")?.value.trim();
          if (!ch) return showToast("Enter a Kick channel username");
          try {
            await api("/api/kick/connect", { method: "POST", body: JSON.stringify({ channel: ch }) });
            showToast(`✓ Connected to Kick channel @${ch}`);
            closeModal("platformModal");
            refreshDashboard();
          } catch (err) {
            showToast(err.message);
          }
        });
      }, 50);
    } else if (platform === "instagram") {
      const isConnected = Boolean(pData.autoConnected && (pData.accessToken || pData.accessTokenSaved || pData.pageAccessToken || pData.handle || pData.igUserId));
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Meta / Instagram Graph OAuth 2.0</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: ${escapeHtml(pData.handle || pData.accountName || "Instagram")}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Authorize with Meta to automatically connect your linked Instagram Professional / Creator account for publishing posts and stories.</p>
          <a href="/auth/instagram" class="btn-oauth instagram">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
            <span>${isConnected ? "Reconnect Instagram via Meta" : "Connect Instagram via Meta (OAuth 2.0)"}</span>
          </a>
        </div>
        <div class="form-group">
          <label class="form-label">Instagram Handle / Username</label>
          <input type="text" class="form-input" name="handle" placeholder="e.g. @your_instagram" value="${escapeHtml(pData.handle || "")}">
        </div>
      `;
    } else if (platform === "x") {
      const isConnected = Boolean(pData.autoConnected && (pData.accessToken || pData.accessTokenSaved || pData.handle));
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">1-Click Twitter / X OAuth 2.0</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: ${escapeHtml(pData.handle || pData.accountName || "X Account")}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Authorize directly with X to publish live tweets, status updates, and broadcast streams automatically.</p>
          <a href="/auth/x" class="btn-oauth x">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            <span>${isConnected ? "Reconnect X (Twitter) with OAuth 2.0" : "Connect with X (Twitter OAuth 2.0)"}</span>
          </a>
        </div>
        <div class="form-group">
          <label class="form-label">X Handle / Username</label>
          <input type="text" class="form-input" name="handle" placeholder="e.g. @username" value="${escapeHtml(pData.handle || "")}">
        </div>
        <div class="form-group">
          <label class="form-label">Client ID (OAuth 2.0) <small style="color:var(--text-faint); font-weight:normal;">(optional if set in env)</small></label>
          <input type="text" class="form-input" name="clientId" placeholder="Twitter Developer Client ID" value="${escapeHtml(pData.clientId || "")}">
        </div>
        <div class="form-group">
          <label class="form-label">Client Secret <small style="color:var(--text-faint); font-weight:normal;">(optional for PKCE public clients)</small></label>
          <input type="password" class="form-input" name="clientSecret" placeholder="••••••••" value="${escapeHtml(pData.clientSecret || "")}">
        </div>
      `;
    } else if (platform === "tiktok") {
      const isConnected = Boolean(pData.autoConnected && (pData.accessToken || pData.accessTokenSaved || pData.handle));
      bodyEl.innerHTML = `
        <div class="oauth-card">
          <div class="oauth-header">
            <span style="font-size:12px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">1-Click TikTok OAuth 2.0</span>
            ${isConnected ? `<span class="oauth-user-badge">● Connected: ${escapeHtml(pData.handle || pData.accountName || "TikTok Account")}</span>` : `<span style="font-size:11px; color:var(--text-faint);">Not Connected</span>`}
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin:0;">Authorize with TikTok Login Kit v2 to publish videos, stories, and sync creator status.</p>
          <a href="/auth/tiktok" class="btn-oauth tiktok">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.298 0 .59.043.87.126V9.4a6.34 6.34 0 0 0-.87-.06 6.34 6.34 0 1 0 6.34 6.33V8.34a8.28 8.28 0 0 0 4.84 1.56V6.45a4.83 4.83 0 0 1-1.07-.32z"/></svg>
            <span>${isConnected ? "Reconnect TikTok with OAuth 2.0" : "Connect with TikTok (OAuth 2.0)"}</span>
          </a>
        </div>
        <div class="form-group">
          <label class="form-label">TikTok Creator Handle</label>
          <input type="text" class="form-input" name="handle" placeholder="e.g. @yourtiktok" value="${escapeHtml(pData.handle || "")}">
        </div>
        <div class="form-group">
          <label class="form-label">TikTok Client Key <small style="color:var(--text-faint); font-weight:normal;">(optional if set in env)</small></label>
          <input type="text" class="form-input" name="clientKey" placeholder="awxxxxxxxxxxxxxx" value="${escapeHtml(pData.clientKey || "")}">
        </div>
        <div class="form-group">
          <label class="form-label">TikTok Client Secret <small style="color:var(--text-faint); font-weight:normal;">(optional if set in env)</small></label>
          <input type="password" class="form-input" name="clientSecret" placeholder="••••••••" value="${escapeHtml(pData.clientSecret || "")}">
        </div>
      `;
    } else {
      bodyEl.innerHTML = `
        <div class="form-group">
          <label class="form-label">${capitalize(platform)} Account Handle</label>
          <input type="text" class="form-input" name="handle" placeholder="e.g. @yourname" value="${escapeHtml(pData.handle || "")}">
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
  // Check OAuth callback parameters in URL
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("connected") === "1") {
    const plat = urlParams.get("oauth") || "platform";
    showToast(`✓ Successfully connected ${capitalize(plat)} via OAuth 2.0!`);
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (urlParams.get("error")) {
    showToast(`OAuth Notice: ${urlParams.get("error")}`);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  checkSession();
});
