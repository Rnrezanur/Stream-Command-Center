const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const toast = $("#toast");
let toastTimer, obs, statsTimer;
let elapsed = 0;
let recordElapsed = 0;
let micInputName = "Mic/Aux";
let signedInUser = null;
let dashboardTimer = null;
let remoteObsTimer = null;
let lastRenderedChatHtml = "";
let currentReplyTarget = null;
let currentPinnedComment = null;
const REQUIRED_AGENT_VERSION = "20260610-7";
const pendingOBS = new Map();

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatTime(total) {
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// 1-Second Master Clock
setInterval(() => {
  if ($("#streamButton")?.dataset.active === "true") elapsed += 1;
  if ($("#recordButton")?.dataset.active === "true") recordElapsed += 1;
  const liveTimer = $("#liveTimer");
  const recTimer = $("#recordTimer");
  if (liveTimer) liveTimer.textContent = formatTime(elapsed);
  if (recTimer) recTimer.textContent = formatTime(recordElapsed);
  if ($("#recordButton")?.dataset.active === "true") {
    const sub = $("#recordSub");
    if (sub) sub.textContent = `REC ${formatTime(recordElapsed)}`;
  }
}, 1000);

class OBSWebSocketClient {
  constructor() {
    this.socket = null;
    this.pending = new Map();
    this.requestId = 0;
    this.eventHandler = () => {};
  }

  async connect(address, password) {
    this.socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timed out")), 5000);
      this.socket.onopen = () => { clearTimeout(timeout); resolve(); };
      this.socket.onerror = () => reject(new Error("Cannot reach OBS WebSocket"));
      this.socket.onclose = () => reject(new Error("OBS connection closed"));
    });

    const hello = await this.nextMessage();
    if (hello.op !== 0) throw new Error("OBS returned an unexpected handshake");
    const identify = { rpcVersion: 1, eventSubscriptions: 2047 };
    if (hello.d.authentication) identify.authentication = await this.createAuthentication(password, hello.d.authentication);
    this.socket.send(JSON.stringify({ op: 1, d: identify }));
    const identified = await this.nextMessage();
    if (identified.op !== 2) throw new Error("OBS authentication failed");
    this.socket.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
    this.socket.onclose = () => {
      clearInterval(statsTimer);
      setConnectionState("disconnected");
      this.pending.forEach(({ reject: rejectRequest }) => rejectRequest(new Error("OBS disconnected")));
      this.pending.clear();
    };
  }

  nextMessage() {
    return new Promise((resolve, reject) => {
      this.socket.onmessage = (event) => resolve(JSON.parse(event.data));
      this.socket.onerror = () => reject(new Error("OBS WebSocket error"));
      this.socket.onclose = () => reject(new Error("OBS authentication failed or connection closed"));
    });
  }

  async createAuthentication(password, auth) {
    const secret = await this.sha256Base64(password + auth.salt);
    return this.sha256Base64(secret + auth.challenge);
  }

  async sha256Base64(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
  }

  call(requestType, requestData = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Connect OBS first"));
    const requestId = String(++this.requestId);
    this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out`));
      }, 5000);
    });
  }

  handleMessage(message) {
    if (message.op === 5) this.eventHandler(message.d.eventType, message.d.eventData || {});
    if (message.op !== 7) return;
    const pending = this.pending.get(message.d.requestId);
    if (!pending) return;
    this.pending.delete(message.d.requestId);
    if (message.d.requestStatus.result) pending.resolve(message.d.responseData || {});
    else pending.reject(new Error(message.d.requestStatus.comment || `OBS error ${message.d.requestStatus.code}`));
  }

  disconnect() { this.socket?.close(); }
}

function setConnectionState(state) {
  const button = $("#connectionButton");
  const label = $("#connectionLabel");
  const light = $("#statusLightIndicator");
  const statusTxt = $("#obsConnectionLabelText");

  button?.classList.remove("connected", "connecting", "disconnected", "virtual");
  button?.classList.add(state === "virtual" ? "connected" : state);

  if (state === "connected") {
    if (label) label.textContent = "OBS Connected";
    if (statusTxt) statusTxt.textContent = "OBS Ready";
    showToast("✓ Connected to OBS Studio");
  } else if (state === "virtual") {
    if (label) label.textContent = "Virtual Deck";
    if (statusTxt) statusTxt.textContent = "Virtual Deck";
  } else if (state === "connecting") {
    if (label) label.textContent = "Connecting...";
    if (statusTxt) statusTxt.textContent = "Syncing...";
  } else {
    if (label) label.textContent = location.protocol === "https:" ? "Connect Remote OBS" : "Virtual Deck";
    if (statusTxt) statusTxt.textContent = "Virtual Deck";
  }
}

// UPDATE STREAM (OPTIMISTIC ZERO DELAY)
function updateStream(active, timecode) {
  const btn = $("#streamButton");
  if (!btn) return;
  btn.dataset.active = String(active);
  btn.classList.toggle("danger", active);
  
  const lbl = $("#streamButtonLabel");
  const sub = $("#streamSub");
  const badge = $("#liveTextBadge");
  const light = $("#statusLightIndicator");
  const signalIcon = $(".signal-icon");

  if (lbl) lbl.textContent = active ? "Stop stream" : "Start stream";
  if (sub) sub.textContent = active ? "ON AIR // Broadcasting" : "Ready to stream";
  if (badge) {
    badge.textContent = active ? "ON AIR" : "OFFLINE";
    badge.classList.toggle("live", active);
  }
  if (light) light.classList.toggle("live", active);
  if (signalIcon) {
    signalIcon.style.color = active ? "#10b981" : "#64748b";
  }

  if (timecode) elapsed = timecodeToSeconds(timecode);
  else if (!active) elapsed = 0;
}

// UPDATE RECORD (OPTIMISTIC ZERO DELAY)
function updateRecord(active, timecode) {
  const btn = $("#recordButton");
  if (!btn) return;
  btn.dataset.active = String(active);
  btn.classList.toggle("recording", active);
  
  const lbl = $("#recordLabel");
  const sub = $("#recordSub");
  const square = $(".record-square");
  const recIcon = $(".record-icon");

  if (lbl) lbl.textContent = active ? "Stop recording" : "Start recording";
  if (sub) sub.textContent = active ? `REC ${formatTime(recordElapsed)}` : "Capture local master";
  if (square) square.style.background = active ? "var(--record)" : "var(--faint)";
  if (recIcon) recIcon.style.background = active ? "var(--record)" : "var(--faint)";

  if (timecode) recordElapsed = timecodeToSeconds(timecode);
  else if (!active) recordElapsed = 0;
}

// UPDATE MUTE (OPTIMISTIC ZERO DELAY)
function updateMute(muted) {
  const btn = $("#muteButton");
  if (!btn) return;
  btn.dataset.muted = String(muted);
  btn.classList.toggle("danger", muted);
  
  const lbl = $("#muteLabel");
  if (lbl) lbl.textContent = muted ? "Unmute microphone" : "Mute microphone";

  const leds = $$(".vu-led");
  if (muted) {
    leds.forEach(l => { l.style.opacity = "0.15"; l.style.animation = "none"; });
  } else {
    leds.forEach(l => { l.style.opacity = ""; l.style.animation = ""; });
  }
}

// UPDATE SCENE (OPTIMISTIC ZERO DELAY)
function updateScene(sceneName) {
  $$(".scene-card").forEach((scene, index) => {
    const active = scene.dataset.scene === sceneName;
    scene.classList.toggle("active", active);
    const tag = scene.querySelector("small");
    if (tag) tag.textContent = active ? "LIVE" : `⌘ ${index + 1}`;
  });
}

function timecodeToSeconds(timecode) {
  const parts = String(timecode || "00:00:00").split(":").map(Number);
  return Math.floor((parts[0] * 3600) + (parts[1] * 60) + (parts[2] || 0));
}

async function syncOBSState() {
  if (!obs || obs.socket?.readyState !== WebSocket.OPEN) return;
  try {
    const [scenes, stream, record, mute] = await Promise.all([
      obs.call("GetSceneList"),
      obs.call("GetStreamStatus"),
      obs.call("GetRecordStatus"),
      obs.call("GetInputMute", { inputName: micInputName }).catch(() => ({ inputMuted: false }))
    ]);
    if (scenes?.scenes) renderScenes(scenes.scenes, scenes.currentProgramSceneName);
    if (stream) updateStream(stream.outputActive, stream.outputTimecode);
    if (record) updateRecord(record.outputActive, record.outputTimecode);
    if (mute) updateMute(mute.inputMuted);
    await updateStats();
  } catch (_) {}
}

function renderScenes(scenes, activeScene) {
  if (!scenes || !scenes.length) return;
  const grid = $("#sceneGrid");
  if (!grid) return;
  const previews = ["main-preview", "screen-preview", "brb-preview", "starting-preview"];
  grid.innerHTML = scenes.slice(0, 8).map((scene, index) => `
    <button class="scene-card ${scene.sceneName === activeScene ? "active" : ""}" data-scene="${escapeHtml(scene.sceneName)}">
      <span class="preview ${previews[index % previews.length]}">
        <span class="preview-tag">SCN 0${index + 1}</span>
        <b>${escapeHtml(scene.sceneName.slice(0, 14))}</b>
      </span>
      <span class="scene-meta">
        <strong>${escapeHtml(scene.sceneName)}</strong>
        <small>${scene.sceneName === activeScene ? "LIVE" : `⌘ ${index + 1}`}</small>
      </span>
    </button>`).join("");
}

async function updateStats() {
  if (!obs || obs.socket?.readyState !== WebSocket.OPEN) return;
  try {
    const [stats, stream, video] = await Promise.all([
      obs.call("GetStats"),
      obs.call("GetStreamStatus"),
      obs.call("GetVideoSettings")
    ]);
    const cpu = stats?.cpuUsage || 11.4;
    const fps = video?.fpsDenominator ? (video.fpsNumerator / video.fpsDenominator) : 60;
    updateMonitor(cpu, fps);
  } catch (_) {}
}

function updateMonitor(cpuUsage = 11.4, activeFps = 60.00) {
  const cpuEl = $("#monitorCpu");
  const fpsEl = $("#monitorFps");
  if (cpuEl) cpuEl.textContent = `${Number(cpuUsage).toFixed(1)}%`;
  if (fpsEl) fpsEl.textContent = `${Number(activeFps).toFixed(1)} FPS`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function initials(name) {
  return String(name || "?").split(/\s+/).map(p => p[0]).join("").slice(0, 2).toUpperCase() || "?";
}

function normalizeOBSAddress(value) {
  let address = String(value || "ws://127.0.0.1:4455").trim().replace(/\/+$/, "");
  if (!/^wss?:\/\//i.test(address)) address = `ws://${address}`;
  try {
    const url = new URL(address);
    if (!url.port) url.port = "4455";
    return url.href.replace(/\/$/, "");
  } catch (_) {
    return "ws://127.0.0.1:4455";
  }
}

// API CLIENT
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

async function callOBS(requestType, requestData = {}) {
  if (location.protocol !== "https:" && obs?.socket?.readyState === WebSocket.OPEN) {
    return obs.call(requestType, requestData);
  }
  return api("/api/obs/commands", { method: "POST", body: JSON.stringify({ requestType, requestData }) }).catch(() => ({}));
}

// AUTO-CONNECT PLATFORMS
async function autoConnectPlatforms(platform = "all") {
  showToast(`⚡ Auto-connecting ${platform === "all" ? "all 6 channels" : platform}...`);
  try {
    const res = await api("/api/platforms/auto-connect", { method: "POST", body: JSON.stringify({ platform }) });
    showToast(`✓ ${platform === "all" ? "All 6 Platforms (YouTube, Twitch, Facebook, TikTok, Instagram, X)" : platform} connected live!`);
    await refreshDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

function applyChatFilter() {
  const filter = $("#chatFilters button.active")?.dataset.filter || "all";
  $$(".comment").forEach((c) => {
    c.style.display = (filter === "all" || c.dataset.platform === filter) ? "" : "none";
  });
}

// REFRESH DASHBOARD (HIGH FREQUENCY 1.2S ZERO DELAY)
async function refreshDashboard() {
  if (!signedInUser) return;
  try {
    const data = await api("/api/dashboard");
    renderDashboard(data);
  } catch (_) {}
}

function renderDashboard(data) {
  const total = Number(data.totalViewers || 0);
  const totalFormatted = total.toLocaleString();

  const totalViewers = $("#totalViewers");
  if (totalViewers) totalViewers.textContent = totalFormatted;

  const topbarAudienceBadge = $("#topbarAudienceBadge");
  if (topbarAudienceBadge) topbarAudienceBadge.textContent = totalFormatted;

  const glanceTotalViewers = $("#glanceTotalViewers");
  if (glanceTotalViewers) glanceTotalViewers.textContent = total > 0 ? `${totalFormatted}+` : "0";

  // Update platform cards & glance strip
  for (const name of ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"]) {
    const card = $(`.platform-card[data-platform="${name}"]`);
    const platform = data.platforms?.[name] || { connected: false, viewers: 0 };
    const vFormatted = Number(platform.viewers || 0).toLocaleString();

    if (card) {
      const numEl = card.querySelector(".metric-num");
      if (numEl) {
        if (["tiktok", "instagram", "x"].includes(name)) {
          numEl.textContent = platform.connected ? "Active" : "Ready";
        } else {
          numEl.textContent = vFormatted;
        }
      }

      const dot = card.querySelector(".platform-status-dot");
      if (dot) dot.className = `platform-status-dot ${platform.connected ? "connected" : "disconnected"}`;

      const autoBtn = card.querySelector(".btn-card-auto");
      if (autoBtn) {
        autoBtn.classList.toggle("connected", Boolean(platform.connected));
        autoBtn.textContent = platform.connected ? "✓ Connected" : "⚡ Auto-Connect";
      }

      const handle = card.querySelector(".platform-handle");
      if (handle) {
        if (platform.handle) handle.textContent = platform.handle;
        else if (platform.channel) handle.textContent = platform.channel;
        else if (platform.page) handle.textContent = platform.page;
      }
    }

    // Update OmniPublish modal connection badges
    const synBadge = $(`#synConnBadge_${name}`);
    if (synBadge) {
      synBadge.className = `plat-conn-badge ${platform.connected ? "connected" : "disconnected"}`;
      synBadge.textContent = platform.connected ? "● Connected" : "⚡ Connect";
    }

    // Update glance strip in Deck view
    if (name === "youtube") {
      const gNum = $("#glanceYtViewers");
      if (gNum) gNum.textContent = vFormatted;
      const gH = $("#glanceYtHandle");
      if (gH && platform.channel) gH.textContent = platform.channel;
    } else if (name === "twitch") {
      const gNum = $("#glanceTwitchViewers");
      if (gNum) gNum.textContent = vFormatted;
      const gH = $("#glanceTwitchHandle");
      if (gH && platform.channel) gH.textContent = platform.channel;
    } else if (name === "facebook") {
      const gNum = $("#glanceFbViewers");
      if (gNum) gNum.textContent = vFormatted;
      const gH = $("#glanceFbHandle");
      if (gH && platform.page) gH.textContent = platform.page;
    } else if (name === "tiktok") {
      const gNum = $("#glanceTiktokViewers");
      if (gNum) gNum.textContent = platform.connected ? "Active" : "Offline";
      const gH = $("#glanceTiktokHandle");
      if (gH && platform.handle) gH.textContent = platform.handle;
    } else if (name === "instagram") {
      const gNum = $("#glanceIgViewers");
      if (gNum) gNum.textContent = platform.connected ? "Active" : "Offline";
      const gH = $("#glanceIgHandle");
      if (gH && platform.handle) gH.textContent = platform.handle;
    } else if (name === "x") {
      const gNum = $("#glanceXViewers");
      if (gNum) gNum.textContent = platform.connected ? "Active" : "Offline";
      const gH = $("#glanceXHandle");
      if (gH && platform.handle) gH.textContent = platform.handle;
    }
  }

  // Update telemetry and multi-cast indicators
  const connectedPlatforms = Object.values(data.platforms || {}).filter(p => p.connected);
  const connectedCount = connectedPlatforms.length;
  const rtmpRelayCount = $("#rtmpRelayCount");
  if (rtmpRelayCount) rtmpRelayCount.textContent = `${connectedCount} / 6`;
  const rtmpRelaySub = $("#rtmpRelaySubtitle");
  if (rtmpRelaySub) rtmpRelaySub.textContent = connectedCount === 6 ? "Active (All 6 Synchronized)" : `${connectedCount} Channels Active`;
  const glanceSynced = $("#glanceSyncedSubtitle");
  if (glanceSynced) glanceSynced.textContent = `● Synced Across ${connectedCount} Platforms`;

  // Update chat
  const comments = data.comments || [];
  const countEl = $("#commentCount");
  if (countEl) countEl.textContent = comments.length;

  // Update pinned comment
  if (data.pinnedComment !== undefined) {
    currentPinnedComment = data.pinnedComment;
    renderPinnedBox(currentPinnedComment);
  }

  const chatFeed = $("#chatFeed");
  if (chatFeed) {
    const nextHtml = comments.length
      ? comments.map(renderComment).join("")
      : `<div class="empty-state-chat">
          <div class="empty-state-icon">💬</div>
          <strong>Chat Stream Ready</strong>
          <p>When you go live on Facebook, YouTube, or Twitch, comments from your viewers will appear here in real time. Click Reply to answer on that platform, or Pin to spotlight a message.</p>
        </div>`;
    if (nextHtml !== lastRenderedChatHtml) {
      chatFeed.innerHTML = nextHtml;
      lastRenderedChatHtml = nextHtml;
    }
    applyChatFilter();
  }

  // Update Alert Box state & views
  if (Array.isArray(data.alerts)) {
    currentAlerts = data.alerts;
    renderAlerts(currentAlerts, data.latestAlert);
  }
}

function setReplyTarget(target) {
  currentReplyTarget = target;
  const bar = $("#replyTargetBar");
  const authorEl = $("#replyTargetAuthor");
  const platEl = $("#replyTargetPlatform");
  const bcastBar = $("#broadcastTargetBar");
  const input = $("#chatInput");

  if (target) {
    if (bar) bar.style.display = "flex";
    if (bcastBar) bcastBar.style.display = "none";
    if (authorEl) authorEl.textContent = `@${target.author}`;
    if (platEl) {
      platEl.textContent = target.platform.toUpperCase();
      platEl.className = `reply-plat-pill ${target.platform}`;
    }
    if (input) {
      input.placeholder = `Reply to @${target.author} on ${capitalize(target.platform)}...`;
      input.focus();
    }
  } else {
    if (bar) bar.style.display = "none";
    if (bcastBar) bcastBar.style.display = "flex";
    if (input) {
      input.placeholder = "Send message to YouTube, Twitch, Facebook...";
    }
  }
}

async function pinComment(comment) {
  currentPinnedComment = comment;
  renderPinnedBox(comment);
  showToast(`📌 Pinned message from ${capitalize(comment.platform)}`);
  try {
    await api("/api/chat/pin", { method: "POST", body: JSON.stringify({ comment }) });
  } catch (_) {}
}

async function unpinComment() {
  currentPinnedComment = null;
  renderPinnedBox(null);
  showToast("Unpinned message");
  try {
    await api("/api/chat/pin", { method: "POST", body: JSON.stringify({ comment: null }) });
  } catch (_) {}
}

function renderPinnedBox(pinned) {
  const box = $("#chatPinnedBox");
  if (!box) return;
  if (!pinned) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  const platform = ["youtube", "twitch", "facebook"].includes(pinned.platform) ? pinned.platform : "facebook";
  box.style.display = "";
  box.innerHTML = `
    <div class="pinned-card ${platform}">
      <div class="pinned-header">
        <span class="pinned-badge">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M12 2v8m-7 4 3-3V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6l3 3v2H5v-2Zm7 4v6"/></svg>
          <span>Pinned from ${platform.toUpperCase()}</span>
        </span>
        <button type="button" class="btn-unpin-comment" id="btnUnpinComment" title="Unpin message">&times;</button>
      </div>
      <div class="pinned-body">
        <strong class="pinned-author">@${escapeHtml(pinned.author)}</strong>
        <p class="pinned-text">${escapeHtml(pinned.message)}</p>
      </div>
      <button type="button" class="btn-pinned-reply" id="btnPinnedReply">
        <span>↳ Reply on ${capitalize(platform)}</span>
      </button>
    </div>
  `;
}

function renderComment(comment) {
  const platform = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"].includes(comment.platform) ? comment.platform : "youtube";
  const age = comment.time ? new Date(comment.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "now";
  const isHost = Boolean(comment.isHost);
  const avatarBg = platform === "youtube" ? "var(--youtube)" : platform === "twitch" ? "var(--twitch)" : platform === "tiktok" ? "#010101" : platform === "instagram" ? "#d6249f" : platform === "x" ? "#111" : "var(--facebook)";
  const replyTag = comment.replyTo ? `<span class="reply-tag">↳ @${escapeHtml(comment.replyTo.author)}</span>` : "";

  let avatarContent = escapeHtml(initials(comment.author || "?"));
  if (isHost && signedInUser?.avatar) {
    avatarContent = `<img src="${signedInUser.avatar}" alt="Avatar">`;
  } else if (comment.avatar) {
    avatarContent = `<img src="${comment.avatar}" alt="Avatar">`;
  }

  return `<article class="comment ${isHost ? "is-host" : ""}" data-id="${escapeHtml(comment.id || "")}" data-platform="${platform}" data-author="${escapeHtml(comment.author || "Viewer")}" data-message="${escapeHtml(comment.message || "")}">
    <div class="comment-avatar" style="background:${avatarBg}">
      ${avatarContent}
    </div>
    <div class="comment-content">
      <div class="comment-meta">
        <strong>${escapeHtml(comment.author || "Viewer")}</strong>
        <span class="tag ${platform}-tag">${escapeHtml(platform)}</span>
        ${isHost ? '<span class="tag host-tag">HOST</span>' : ''}
        ${replyTag}
        <time>${escapeHtml(age)}</time>
      </div>
      <p>${escapeHtml(comment.message || "")}</p>
      <div class="comment-actions">
        <button type="button" class="btn-comment-reply" data-action="reply" title="Reply on ${capitalize(platform)}">
          <svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v1.5"/></svg>
          <span>Reply</span>
        </button>
        <button type="button" class="btn-comment-pin" data-action="pin" title="Pin message">
          <svg viewBox="0 0 24 24"><path d="M12 2v8m-7 4 3-3V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6l3 3v2H5v-2Zm7 4v6"/></svg>
          <span>Pin</span>
        </button>
      </div>
    </div>
  </article>`;
}

function setSignedInUser(user) {
  signedInUser = user;
  const initialsTxt = $("#accountInitialsText");
  const initialsImg = $("#accountInitialsImg");
  const hdrThumb = $("#headerAvatarThumb");
  const hdrImg = $("#headerAvatarImg");
  const hdrDot = $("#headerAccountDot");
  const hdrLabel = $("#headerAccountLabel");
  const chatSender = $("#chatSenderName");
  
  if (user?.avatar) {
    if (initialsImg) { initialsImg.src = user.avatar; initialsImg.style.display = "block"; }
    if (initialsTxt) { initialsTxt.style.display = "none"; }
    if (hdrImg) { hdrImg.src = user.avatar; }
    if (hdrThumb) { hdrThumb.style.display = "inline-flex"; }
    if (hdrDot) { hdrDot.style.display = "none"; }
  } else {
    if (initialsTxt) { initialsTxt.textContent = user ? initials(user.name) : "?"; initialsTxt.style.display = "block"; }
    if (initialsImg) { initialsImg.style.display = "none"; }
    if (hdrThumb) { hdrThumb.style.display = "none"; }
    if (hdrDot) { hdrDot.style.display = "inline-block"; }
  }

  if (hdrLabel) hdrLabel.textContent = user ? user.name : "Sign in";
  if (chatSender) chatSender.textContent = user ? `${user.name} (You)` : "Streamer (You)";

  const authScreen = $("#authScreen");
  const dashboardApp = $("#dashboardApp");

  if (authScreen) authScreen.hidden = Boolean(user);
  if (dashboardApp) dashboardApp.hidden = !user;
}

async function loadCurrentUser() {
  try {
    const { user } = await api("/api/me");
    setSignedInUser(user || null);
    if (!user) return;
    // Auto-connect all platforms immediately on login / page load
    await autoConnectPlatforms("all");
    await refreshDashboard();
    loadPublishedVideos();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 1200);
    // Auto-connect local OBS if available
    autoConnectLocalOBS();
  } catch (_) {
    setSignedInUser(null);
  }
}

async function autoConnectLocalOBS() {
  const address = normalizeOBSAddress($("#obsAddress")?.value || "ws://127.0.0.1:4455");
  const password = $("#obsPassword")?.value || "";
  try {
    obs = new OBSWebSocketClient();
    obs.eventHandler = (type, data) => {
      if (type === "CurrentProgramSceneChanged") updateScene(data.sceneName);
      if (type === "StreamStateChanged") updateStream(data.outputActive, data.outputTimecode);
      if (type === "RecordStateChanged") updateRecord(data.outputActive, data.outputTimecode);
      if (type === "InputMuteStateChanged" && data.inputName === micInputName) updateMute(data.inputMuted);
    };
    await obs.connect(address, password);
    await syncOBSState();
    setConnectionState("connected");
    statsTimer = setInterval(updateStats, 2000);
  } catch (_) {
    // Graceful fallback to Virtual Deck mode for zero lag
    setConnectionState("virtual");
  }
}

// WORKSPACE VIEW SWITCHER (DECK // PLATFORMS // SYNDICATE // ALERTS)
function switchWorkspaceView(view = "deck") {
  const views = {
    deck: $("#viewDeck"),
    platforms: $("#viewPlatforms"),
    syndicate: $("#viewSyndicate"),
    alerts: $("#viewAlerts")
  };

  Object.entries(views).forEach(([key, el]) => {
    if (el) {
      el.style.display = key === view ? "" : "none";
      el.classList.toggle("active", key === view);
    }
  });

  $$(".view-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  const sidebarDeck = $("#sidebarConsoleBtn") || $(".nav-item[data-nav-view='deck']");
  const sidebarPlat = $("#sidebarPlatformsBtn");
  const sidebarUpload = $("#sidebarUploadBtn");
  const sidebarAlerts = $("#sidebarAlertsBtn");

  $$(".sidebar .nav-item").forEach((b) => b.classList.remove("active"));
  if (view === "deck" && sidebarDeck) sidebarDeck.classList.add("active");
  if (view === "platforms" && sidebarPlat) sidebarPlat.classList.add("active");
  if (view === "syndicate" && sidebarUpload) sidebarUpload.classList.add("active");
  if (view === "alerts" && sidebarAlerts) sidebarAlerts.classList.add("active");
  if (view === "alerts") updateOverlayUrlDisplay();
}

// EVENT LISTENERS //

// 1. FAST ZERO-DELAY CONTROLS
$("#streamButton")?.addEventListener("click", async () => {
  const currentlyActive = $("#streamButton").dataset.active === "true";
  const next = !currentlyActive;
  updateStream(next);
  showToast(next ? "🔴 Stream went LIVE!" : "Stream stopped");
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    callOBS(next ? "StartStream" : "StopStream").catch(() => {});
  }
});

$("#recordButton")?.addEventListener("click", async () => {
  const currentlyActive = $("#recordButton").dataset.active === "true";
  const next = !currentlyActive;
  updateRecord(next);
  showToast(next ? "⏺ Recording started" : "Recording stopped");
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    callOBS(next ? "StartRecord" : "StopRecord").catch(() => {});
  }
});

$("#muteButton")?.addEventListener("click", async () => {
  const currentlyMuted = $("#muteButton").dataset.muted === "true";
  const next = !currentlyMuted;
  updateMute(next);
  showToast(next ? "🔇 Microphone muted" : "🎙 Microphone active");
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    callOBS("SetInputMute", { inputName: micInputName, inputMuted: next }).catch(() => {});
  }
});

$("#sceneGrid")?.addEventListener("click", async (event) => {
  const card = event.target.closest(".scene-card");
  if (!card) return;
  const sceneName = card.dataset.scene;
  updateScene(sceneName);
  showToast(`Switched to: ${sceneName}`);
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    callOBS("SetCurrentProgramScene", { sceneName }).catch(() => {});
  }
});

// 2. CHAT SEND & REPLY (PLATFORM-AWARE)
$("#chatForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const message = input.value.trim();
  if (!message) return;

  input.value = "";

  const replyTarget = currentReplyTarget;
  const filter = $("#chatFilters button.active")?.dataset.filter || "all";
  const platform = replyTarget ? replyTarget.platform : (filter === "all" ? "facebook" : filter);
  const platforms = replyTarget ? [replyTarget.platform] : (filter === "all" ? ["youtube", "twitch", "facebook"] : [filter]);

  // Optimistic instant append
  const instant = {
    id: "usr_" + Date.now(),
    platform,
    author: signedInUser ? signedInUser.name : "Streamer (You)",
    message,
    time: new Date().toISOString(),
    isHost: true,
    replyTo: replyTarget ? {
      id: replyTarget.id,
      author: replyTarget.author,
      platform
    } : null
  };

  const feed = $("#chatFeed");
  const empty = feed.querySelector(".empty-state, .empty-state-chat");
  if (empty) empty.remove();
  lastRenderedChatHtml = "";
  feed.insertAdjacentHTML("afterbegin", renderComment(instant));
  applyChatFilter();

  if (replyTarget) {
    showToast(`↳ Replied to @${replyTarget.author} on ${capitalize(replyTarget.platform)}`);
    setReplyTarget(null);
  }

  try {
    await api("/api/chat/send", {
      method: "POST",
      body: JSON.stringify({
        message,
        platforms,
        platform: replyTarget ? replyTarget.platform : undefined,
        replyToCommentId: replyTarget ? replyTarget.id : undefined,
        replyToAuthor: replyTarget ? replyTarget.author : undefined
      })
    });
  } catch (err) {
    showToast(err.message);
  }
});

// CHAT COMMENT INTERACTIONS (REPLY & PIN)
$("#chatFeed")?.addEventListener("click", (e) => {
  const replyBtn = e.target.closest(".btn-comment-reply");
  if (replyBtn) {
    const commentEl = replyBtn.closest(".comment");
    if (!commentEl) return;
    setReplyTarget({
      id: commentEl.dataset.id,
      author: commentEl.dataset.author,
      platform: commentEl.dataset.platform
    });
    return;
  }

  const pinBtn = e.target.closest(".btn-comment-pin");
  if (pinBtn) {
    const commentEl = pinBtn.closest(".comment");
    if (!commentEl) return;
    pinComment({
      id: commentEl.dataset.id,
      author: commentEl.dataset.author,
      platform: commentEl.dataset.platform,
      message: commentEl.dataset.message,
      time: new Date().toISOString()
    });
    return;
  }
});

$("#btnCancelReply")?.addEventListener("click", () => setReplyTarget(null));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentReplyTarget) {
    setReplyTarget(null);
  }
});

$("#chatPinnedBox")?.addEventListener("click", (e) => {
  if (e.target.closest("#btnUnpinComment")) {
    unpinComment();
    return;
  }
  if (e.target.closest("#btnPinnedReply")) {
    if (currentPinnedComment) {
      setReplyTarget({
        id: currentPinnedComment.id,
        author: currentPinnedComment.author,
        platform: currentPinnedComment.platform
      });
    }
  }
});

// 3. CHAT FILTERS
$("#chatFilters")?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  $$("#chatFilters button").forEach((b) => b.classList.remove("active"));
  button.classList.add("active");
  applyChatFilter();
});

// 4. WORKSPACE VIEW SWITCHER
$$(".view-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchWorkspaceView(btn.dataset.view));
});

$("#sidebarConsoleBtn")?.addEventListener("click", () => switchWorkspaceView("deck"));
$("#sidebarPlatformsBtn")?.addEventListener("click", () => switchWorkspaceView("platforms"));
$("#sidebarUploadBtn")?.addEventListener("click", () => switchWorkspaceView("syndicate"));
$("#sidebarAlertsBtn")?.addEventListener("click", () => switchWorkspaceView("alerts"));

document.addEventListener("click", (e) => {
  const switchLink = e.target.closest("[data-switch-view]");
  if (switchLink) {
    switchWorkspaceView(switchLink.dataset.switchView);
  }
});

// 5. AUTO-CONNECT BUTTONS
$("#headerAutoConnectBtn")?.addEventListener("click", () => autoConnectPlatforms("all"));
$("#btnAutoConnectAll")?.addEventListener("click", () => autoConnectPlatforms("all"));

document.addEventListener("click", (event) => {
  const autoBtn = event.target.closest(".btn-card-auto");
  if (autoBtn) {
    const platform = autoBtn.dataset.platform;
    const isConn = autoBtn.classList.contains("connected");
    if (isConn) {
      api("/api/platforms/disconnect", { method: "POST", body: JSON.stringify({ platform }) })
        .then(() => {
          showToast(`Disconnected ${platform}`);
          refreshDashboard();
        });
    } else {
      autoConnectPlatforms(platform);
    }
  }
});

// 5. QUICK LAUNCH / AUTH BUTTON
$("#authQuickConnect")?.addEventListener("click", async () => {
  $("#authPageError").textContent = "";
  $("#authQuickConnect").disabled = true;
  try {
    const result = await api("/api/quick-connect", { method: "POST", body: "{}" });
    setSignedInUser(result.user);
    // Auto-connect all platforms for instant action!
    await autoConnectPlatforms("all");
    await refreshDashboard();
    loadPublishedVideos();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 1200);
    showToast(`✓ Welcome, ${result.user.name}! Command Center Ready.`);
    autoConnectLocalOBS();
  } catch (error) {
    $("#authPageError").textContent = error.message;
  } finally {
    $("#authQuickConnect").disabled = false;
  }
});

let authPageRegistering = false;
$("#authPageMode")?.addEventListener("click", () => {
  authPageRegistering = !authPageRegistering;
  $("#authPageForm").classList.toggle("registering", authPageRegistering);
  $("#authPageTitle").textContent = authPageRegistering ? "Create Account" : "Welcome Back";
  $("#authPageCopy").textContent = authPageRegistering ? "Set up your personal command center." : "Sign in to open your command center.";
  $("#authPageSubmit").textContent = authPageRegistering ? "Create account" : "Sign in";
  $("#authPageMode").textContent = authPageRegistering ? "Already have an account? Sign in" : "New to Relay? Create an account";
  $("#authPageError").textContent = "";
});

$("#authPageForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#authPageError").textContent = "";
  $("#authPageSubmit").disabled = true;
  try {
    const endpoint = authPageRegistering ? "/api/register" : "/api/login";
    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        name: $("#authPageName").value.trim(),
        email: $("#authPageEmail").value.trim(),
        password: $("#authPagePassword").value
      })
    });
    setSignedInUser(result.user);
    await autoConnectPlatforms("all");
    await refreshDashboard();
    loadPublishedVideos();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 1200);
    showToast(authPageRegistering ? "Account created" : "Welcome back");
  } catch (error) {
    $("#authPageError").textContent = error.message;
  } finally {
    $("#authPageSubmit").disabled = false;
  }
});

// SCENE ADDITIONS & RESTORED SETTINGS
function appendSceneCard(sceneName) {
  const grid = $("#sceneGrid");
  if (!grid || !sceneName) return;
  if ($$(".scene-card", grid).some((c) => c.dataset.scene === sceneName)) return;
  const index = $$(".scene-card", grid).length;
  const previews = ["main-preview", "screen-preview", "brb-preview", "starting-preview"];
  grid.insertAdjacentHTML("beforeend", `
    <button class="scene-card" data-scene="${escapeHtml(sceneName)}">
      <span class="preview ${previews[index % previews.length]}">
        <span class="preview-tag">SCN 0${index + 1}</span>
        <b>${escapeHtml(sceneName.slice(0, 14))}</b>
      </span>
      <span class="scene-meta">
        <strong>${escapeHtml(sceneName)}</strong>
        <small>⌘ ${index + 1}</small>
      </span>
    </button>`);
}

function loadSavedPreferences() {
  const savedAddress = localStorage.getItem("obsAddress");
  const savedMic = localStorage.getItem("obsMicInput");
  if (savedAddress && $("#obsAddress")) $("#obsAddress").value = savedAddress;
  if (savedMic) {
    micInputName = savedMic;
    if ($("#obsMicInput")) $("#obsMicInput").value = savedMic;
    if ($("#micName")) $("#micName").textContent = savedMic;
  }
  try {
    const customScenes = JSON.parse(localStorage.getItem("customScenes") || "[]");
    if (Array.isArray(customScenes)) customScenes.forEach(appendSceneCard);
  } catch (_) {}
}

$("#addScene")?.addEventListener("click", () => {
  const name = window.prompt("Enter OBS scene name:")?.trim();
  if (!name) return;
  appendSceneCard(name);
  try {
    const customScenes = JSON.parse(localStorage.getItem("customScenes") || "[]");
    if (Array.isArray(customScenes) && !customScenes.includes(name)) {
      customScenes.push(name);
      localStorage.setItem("customScenes", JSON.stringify(customScenes));
    }
  } catch (_) {}
  showToast(`Added scene: ${name}`);
});

// MODAL CONTROLS
const platformModal = $("#platformModal");
function populatePlatformForm(settings) {
  for (const input of $$("#platformForm [name]")) {
    const [platform, field] = input.name.split(".");
    const value = settings[platform]?.[field];
    const saved = settings[platform]?.[`${field}Saved`];
    if (input.type === "password") {
      input.value = "";
      if (saved) input.placeholder = "Saved securely - enter a new value to replace";
    } else if (value) {
      input.value = value;
    }
  }
  const ytConnected = Boolean(settings.youtube?.refreshTokenSaved || settings.youtube?.autoConnected);
  const twConnected = Boolean(settings.twitch?.refreshTokenSaved || settings.twitch?.autoConnected);
  const ttConnected = Boolean(settings.tiktok?.autoConnected);
  const igConnected = Boolean(settings.instagram?.autoConnected);
  const xConnected = Boolean(settings.x?.autoConnected);

  if ($("#youtubeOAuthStatus")) {
    $("#youtubeOAuthStatus").textContent = ytConnected
      ? `Connected as ${settings.youtube?.accountName || settings.youtube?.channel || "YouTube"}.`
      : "One-click OAuth automatically links your channel.";
  }
  if ($(".youtube-oauth strong")) {
    $(".youtube-oauth strong").textContent = ytConnected ? "Reconnect Google / YouTube" : "Connect with Google / YouTube";
  }
  if ($("#twitchOAuthStatus")) {
    $("#twitchOAuthStatus").textContent = twConnected
      ? `Connected as ${settings.twitch?.accountName || settings.twitch?.channel || "Twitch"}.`
      : "OAuth allows sending chat messages directly as your channel.";
  }
  if ($(".twitch-oauth strong")) {
    $(".twitch-oauth strong").textContent = twConnected ? "Reconnect Twitch Account" : "Connect with Twitch Account";
  }
  if ($("#tiktokOAuthStatus")) {
    $("#tiktokOAuthStatus").textContent = ttConnected
      ? `Connected as ${settings.tiktok?.handle || "@rezanur_live"}. Ready for OmniPublish.`
      : "Auto-connects your TikTok account for instant video & clip syndication.";
  }
  if ($("#btnModalTikTokConnect")) {
    $("#btnModalTikTokConnect").textContent = ttConnected ? "✓ TikTok Connected" : "Auto-Connect TikTok Account";
  }
  if ($("#instagramOAuthStatus")) {
    $("#instagramOAuthStatus").textContent = igConnected
      ? `Connected as ${settings.instagram?.handle || "@rezanur.studio"}. Ready for Reels.`
      : "Auto-connects your Instagram account for instant Reels syndication.";
  }
  if ($("#btnModalInstagramConnect")) {
    $("#btnModalInstagramConnect").textContent = igConnected ? "✓ Instagram Connected" : "Auto-Connect Instagram Account";
  }
  if ($("#xOAuthStatus")) {
    $("#xOAuthStatus").textContent = xConnected
      ? `Connected as ${settings.x?.handle || "@rezanur_live"}. Ready for X Broadcasts.`
      : "Auto-connects your X profile for instant video tweet syndication.";
  }
  if ($("#btnModalXConnect")) {
    $("#btnModalXConnect").textContent = xConnected ? "✓ X Connected" : "Auto-Connect X (Twitter) Account";
  }
}

function setModalOpen(modal, isOpen) {
  if (!modal) return;
  modal.classList.toggle("open", isOpen);
  modal.setAttribute("aria-hidden", String(!isOpen));
}

async function openPlatformSettings(platform = "youtube") {
  if (!signedInUser) return openAccountModal();
  selectSettingsTab(platform);
  $("#platformError").textContent = "";
  if ($("#facebookTestStatus")) $("#facebookTestStatus").textContent = "Save before testing.";
  setModalOpen(platformModal, true);
  try {
    const { settings } = await api("/api/settings");
    populatePlatformForm(settings || {});
  } catch (error) {
    $("#platformError").textContent = error.message;
  }
}

function selectSettingsTab(platform) {
  $$(".settings-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.settingsTab === platform));
  $$(".settings-section").forEach((s) => s.classList.toggle("active", s.dataset.settingsSection === platform));
}

$("#connectPlatformsButton")?.addEventListener("click", () => openPlatformSettings());
$("#platformSettingsButton")?.addEventListener("click", () => openPlatformSettings());
$("#sidebarPlatformsBtn")?.addEventListener("click", () => openPlatformSettings());
$("#sidebarSettingsBtn")?.addEventListener("click", () => openPlatformSettings());
$("#cancelPlatformSettings")?.addEventListener("click", () => setModalOpen(platformModal, false));
platformModal?.addEventListener("click", (e) => { if (e.target === platformModal) setModalOpen(platformModal, false); });

$(".settings-tabs")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-settings-tab]");
  if (b) selectSettingsTab(b.dataset.settingsTab);
});

document.addEventListener("click", (e) => {
  const configBtn = e.target.closest(".btn-card-config");
  if (configBtn) openPlatformSettings(configBtn.dataset.platform);
});

document.addEventListener("click", async (e) => {
  const modalAutoBtn = e.target.closest('[data-action="auto-connect-modal"]');
  if (modalAutoBtn) {
    const p = modalAutoBtn.dataset.platform;
    await autoConnectPlatforms(p);
    try {
      const { settings } = await api("/api/settings");
      populatePlatformForm(settings || {});
    } catch (_) {}
  }
});

$("#platformForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#platformError").textContent = "";
  const payload = {};
  for (const input of $$("#platformForm [name]")) {
    const [platform, field] = input.name.split(".");
    payload[platform] = payload[platform] || {};
    const val = input.value.trim();
    if (val) payload[platform][field] = val;
  }
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    setModalOpen(platformModal, false);
    showToast("✓ Platform settings saved securely");
    await refreshDashboard();
  } catch (error) {
    $("#platformError").textContent = error.message;
  }
});

$("#testFacebookConnection")?.addEventListener("click", async () => {
  const statusEl = $("#facebookTestStatus");
  if (statusEl) statusEl.textContent = "Testing Facebook Graph API...";
  try {
    const result = await api("/api/facebook/test", { method: "POST", body: "{}" });
    if (statusEl) statusEl.textContent = `✓ ${result.page || "Page"}: ${result.status}`;
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message;
  }
});

// STOP STREAM CONFIRMATION MODAL
const stopModal = $("#stopModal");
$("#cancelStop")?.addEventListener("click", () => setModalOpen(stopModal, false));
$("#confirmStop")?.addEventListener("click", () => {
  setModalOpen(stopModal, false);
  updateStream(false);
  showToast("Stream stopped");
  if (obs?.socket?.readyState === WebSocket.OPEN || location.protocol === "https:") {
    callOBS("StopStream").catch(() => {});
  }
});
stopModal?.addEventListener("click", (e) => { if (e.target === stopModal) setModalOpen(stopModal, false); });

// REMOTE OBS MODAL (HOSTED HTTPS)
const remoteObsModal = $("#remoteObsModal");
let remoteObsOnline = false;
async function refreshRemoteOBS() {
  if (!signedInUser || location.protocol !== "https:") return;
  try {
    const { online, state } = await api("/api/obs/state");
    remoteObsOnline = Boolean(online);
    if (online) {
      setConnectionState("connected");
      if (state.scenes) renderScenes(state.scenes, state.currentScene);
      if (typeof state.streaming === "boolean") updateStream(state.streaming);
      if (typeof state.recording === "boolean") updateRecord(state.recording);
      if (typeof state.muted === "boolean") updateMute(state.muted);
    } else if (!obs || obs.socket?.readyState !== WebSocket.OPEN) {
      setConnectionState("disconnected");
    }
  } catch (_) {}
}

$("#cancelRemoteObs")?.addEventListener("click", () => setModalOpen(remoteObsModal, false));
remoteObsModal?.addEventListener("click", (e) => { if (e.target === remoteObsModal) setModalOpen(remoteObsModal, false); });

$("#generatePairingCode")?.addEventListener("click", async () => {
  const errEl = $("#remoteObsError");
  const cmdEl = $("#agentCommand");
  const copyBtn = $("#copyAgentCommand");
  if (errEl) errEl.textContent = "";
  try {
    const { pairingCode } = await api("/api/obs/pairing-code", { method: "POST", body: "{}" });
    const psCmd = `irm ${location.origin}/obs-agent.js -OutFile obs-agent.js; $env:RELAY_URL="${location.origin}"; $env:PAIRING_CODE="${pairingCode}"; node obs-agent.js`;
    if (cmdEl) cmdEl.textContent = psCmd;
    if (copyBtn) copyBtn.disabled = false;
    $$(".remote-step").forEach((step, idx) => step.classList.toggle("active", idx <= 1));
    showToast(`Pairing code generated: ${pairingCode}`);
  } catch (error) {
    if (errEl) errEl.textContent = error.message;
  }
});

$("#copyAgentCommand")?.addEventListener("click", async () => {
  const text = $("#agentCommand")?.textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast("✓ Agent command copied to clipboard");
  } catch (_) {
    showToast("Copy manually from the command box");
  }
});

// OBS MODAL
const connectionModal = $("#connectionModal");
$("#connectionButton")?.addEventListener("click", () => {
  if (location.protocol === "https:") {
    if (!signedInUser) return openAccountModal();
    setModalOpen(remoteObsModal, true);
    return;
  }
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    obs.disconnect();
    obs = null;
    setConnectionState("disconnected");
    showToast("OBS disconnected");
    return;
  }
  setModalOpen(connectionModal, true);
});
$("#cancelConnection")?.addEventListener("click", () => setModalOpen(connectionModal, false));
connectionModal?.addEventListener("click", (e) => { if (e.target === connectionModal) setModalOpen(connectionModal, false); });

$("#connectionForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#connectionError").textContent = "";
  setConnectionState("connecting");
  $("#connectSubmit").disabled = true;
  try {
    obs = new OBSWebSocketClient();
    micInputName = $("#obsMicInput").value.trim() || "Mic/Aux";
    $("#micName").textContent = micInputName;
    const address = normalizeOBSAddress($("#obsAddress").value);
    obs.eventHandler = (type, data) => {
      if (type === "CurrentProgramSceneChanged") updateScene(data.sceneName);
      if (type === "StreamStateChanged") updateStream(data.outputActive, data.outputTimecode);
      if (type === "RecordStateChanged") updateRecord(data.outputActive, data.outputTimecode);
      if (type === "InputMuteStateChanged" && data.inputName === micInputName) updateMute(data.inputMuted);
    };
    await obs.connect(address, $("#obsPassword").value);
    await syncOBSState();
    localStorage.setItem("obsAddress", address);
    localStorage.setItem("obsMicInput", micInputName);
    setConnectionState("connected");
    setModalOpen(connectionModal, false);
    statsTimer = setInterval(updateStats, 2000);
    showToast("✓ Connected to OBS Studio");
  } catch (error) {
    obs?.disconnect();
    obs = null;
    setConnectionState("disconnected");
    $("#connectionError").textContent = error.message;
  } finally {
    $("#connectSubmit").disabled = false;
  }
});

// ACCOUNT MODAL & PROFILE CONTROLS
const accountModal = $("#accountModal");
let accountModalRegistering = false;
let accountModalEditMode = true;
let stagedAvatarDataUrl = null;

function syncAccountModalMode() {
  const form = $("#accountForm");
  const isEditing = Boolean(accountModalEditMode && signedInUser);

  if (isEditing) {
    if ($("#accountTitle")) $("#accountTitle").textContent = "Studio Profile Settings";
    if ($("#accountEyebrow")) $("#accountEyebrow").textContent = "Profile Settings • Live Host";
    if ($("#accountAvatarSection")) $("#accountAvatarSection").style.display = "flex";
    if ($("#accountNameLabel")) $("#accountNameLabel").style.display = "flex";
    if ($("#accountName")) $("#accountName").value = signedInUser.name || "";
    if ($("#accountEmail")) $("#accountEmail").value = signedInUser.email || "";
    if ($("#accountPassword")) {
      $("#accountPassword").value = "";
      $("#accountPassword").required = false;
    }
    if ($("#accountPasswordLabelText")) $("#accountPasswordLabelText").textContent = "Change Password (optional)";
    if ($("#accountPasswordHint")) $("#accountPasswordHint").style.display = "block";
    if ($("#accountSubmitBtn")) $("#accountSubmitBtn").textContent = "Save Changes";
    if ($("#accountMode")) $("#accountMode").textContent = "Switch Account";
    if ($("#logoutButton")) $("#logoutButton").style.display = "";

    // Sync avatar preview
    if (stagedAvatarDataUrl) {
      if ($("#accountAvatarImg")) {
        $("#accountAvatarImg").src = stagedAvatarDataUrl;
        $("#accountAvatarImg").style.display = "block";
      }
      if ($("#accountAvatarInitials")) $("#accountAvatarInitials").style.display = "none";
      if ($("#btnRemoveAvatar")) $("#btnRemoveAvatar").style.display = "inline-flex";
    } else {
      if ($("#accountAvatarImg")) $("#accountAvatarImg").style.display = "none";
      if ($("#accountAvatarInitials")) {
        $("#accountAvatarInitials").style.display = "block";
        $("#accountAvatarInitials").textContent = initials(signedInUser.name);
      }
      if ($("#btnRemoveAvatar")) $("#btnRemoveAvatar").style.display = "none";
    }
  } else {
    // Auth mode (Register / Login)
    if ($("#accountAvatarSection")) $("#accountAvatarSection").style.display = "none";
    if ($("#accountPassword")) $("#accountPassword").required = true;
    if ($("#accountPasswordLabelText")) $("#accountPasswordLabelText").textContent = "Password";
    if ($("#accountPasswordHint")) $("#accountPasswordHint").style.display = "none";
    if ($("#logoutButton")) $("#logoutButton").style.display = "none";

    if (accountModalRegistering) {
      if ($("#accountTitle")) $("#accountTitle").textContent = "Create Account";
      if ($("#accountEyebrow")) $("#accountEyebrow").textContent = "New Creator Account";
      if ($("#accountNameLabel")) $("#accountNameLabel").style.display = "flex";
      if ($("#accountSubmitBtn")) $("#accountSubmitBtn").textContent = "Create Account";
      if ($("#accountMode")) $("#accountMode").textContent = "Sign in instead";
    } else {
      if ($("#accountTitle")) $("#accountTitle").textContent = "Sign In";
      if ($("#accountEyebrow")) $("#accountEyebrow").textContent = "Creator Sign In";
      if ($("#accountNameLabel")) $("#accountNameLabel").style.display = "none";
      if ($("#accountSubmitBtn")) $("#accountSubmitBtn").textContent = "Sign In";
      if ($("#accountMode")) $("#accountMode").textContent = "Create account";
    }
  }
}

function openAccountModal() {
  accountModalEditMode = Boolean(signedInUser);
  accountModalRegistering = false;
  stagedAvatarDataUrl = signedInUser?.avatar || null;
  $("#accountError").textContent = "";
  setModalOpen(accountModal, true);
  syncAccountModalMode();
}

$("#accountButton")?.addEventListener("click", openAccountModal);
$("#headerAccountButton")?.addEventListener("click", openAccountModal);
$("#cancelAccount")?.addEventListener("click", () => setModalOpen(accountModal, false));

// AVATAR FILE UPLOAD & PREVIEW
$("#btnUploadAvatar")?.addEventListener("click", () => {
  $("#accountAvatarFile")?.click();
});

$("#accountAvatarFile")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    $("#accountError").textContent = "Please select a valid image file (PNG, JPG, WebP)";
    return;
  }
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      // Compress to max 256x256 for fast storage and loading
      const canvas = document.createElement("canvas");
      const maxDim = 256;
      let w = img.width;
      let h = img.height;
      if (w > h) {
        if (w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      } else {
        if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      stagedAvatarDataUrl = canvas.toDataURL("image/jpeg", 0.85);

      if ($("#accountAvatarImg")) {
        $("#accountAvatarImg").src = stagedAvatarDataUrl;
        $("#accountAvatarImg").style.display = "block";
      }
      if ($("#accountAvatarInitials")) $("#accountAvatarInitials").style.display = "none";
      if ($("#btnRemoveAvatar")) $("#btnRemoveAvatar").style.display = "inline-flex";
      $("#accountError").textContent = "";
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
});

$("#btnRemoveAvatar")?.addEventListener("click", () => {
  stagedAvatarDataUrl = null;
  if ($("#accountAvatarImg")) $("#accountAvatarImg").style.display = "none";
  if ($("#accountAvatarInitials")) {
    $("#accountAvatarInitials").style.display = "block";
    const name = $("#accountName")?.value || signedInUser?.name || "User";
    $("#accountAvatarInitials").textContent = initials(name);
  }
  if ($("#btnRemoveAvatar")) $("#btnRemoveAvatar").style.display = "none";
  const fileInput = $("#accountAvatarFile");
  if (fileInput) fileInput.value = "";
});

$("#accountMode")?.addEventListener("click", () => {
  if (accountModalEditMode) {
    accountModalEditMode = false;
    accountModalRegistering = false;
  } else {
    accountModalRegistering = !accountModalRegistering;
  }
  $("#accountError").textContent = "";
  syncAccountModalMode();
});

$("#accountForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#accountError").textContent = "";

  // 1. If in Edit Profile mode
  if (accountModalEditMode && signedInUser) {
    const name = $("#accountName")?.value.trim();
    if (!name) {
      $("#accountError").textContent = "Display name cannot be empty";
      return;
    }
    const password = $("#accountPassword")?.value || "";
    if (password && password.length < 8) {
      $("#accountError").textContent = "New password must be at least 8 characters";
      return;
    }
    const payload = {
      name,
      avatar: stagedAvatarDataUrl
    };
    if (password) payload.password = password;

    try {
      const result = await api("/api/user/profile", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      setSignedInUser(result.user);
      setModalOpen(accountModal, false);
      showToast("✓ Profile and photo updated successfully!");
      await refreshDashboard();
    } catch (error) {
      $("#accountError").textContent = error.message;
    }
    return;
  }

  // 2. Auth Mode (Sign in or Register)
  const endpoint = accountModalRegistering ? "/api/register" : "/api/login";
  try {
    const result = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({
        name: $("#accountName")?.value.trim() || "",
        email: $("#accountEmail").value.trim(),
        password: $("#accountPassword").value
      })
    });
    setSignedInUser(result.user);
    setModalOpen(accountModal, false);
    await autoConnectPlatforms("all");
    await refreshDashboard();
    loadPublishedVideos();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 1200);
    showToast(accountModalRegistering ? `Account created: ${result.user.name}` : `Signed in as ${result.user.name}`);
    autoConnectLocalOBS();
  } catch (error) {
    $("#accountError").textContent = error.message;
  }
});

$("#logoutButton")?.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  clearInterval(dashboardTimer);
  clearInterval(remoteObsTimer);
  setSignedInUser(null);
  setModalOpen(accountModal, false);
  showToast("Signed out");
});
accountModal?.addEventListener("click", (e) => { if (e.target === accountModal) setModalOpen(accountModal, false); });

// KEYBOARD SHORTCUTS
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $$(".modal-backdrop.open").forEach((m) => setModalOpen(m, false));
    return;
  }
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (event.key.toLowerCase() === "m") $("#muteButton")?.click();
  if (event.ctrlKey && event.key.toLowerCase() === "s") { event.preventDefault(); $("#streamButton")?.click(); }
  if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); $("#recordButton")?.click(); }
  if (event.ctrlKey && ["1", "2", "3", "4"].includes(event.key)) {
    event.preventDefault();
    $$(".scene-card")[Number(event.key) - 1]?.click();
  }
});

// ========================================================
// OMNIPUBLISH: MULTI-PLATFORM VIDEO SYNDICATION
// ========================================================
const videoUploadModal = $("#videoUploadModal");
let currentSelectedVideoFile = null;
let currentThumbnailDataUrl = null;
let publishedVideos = [];

function openVideoUploadModal(tab = "new") {
  if (!signedInUser) return openAccountModal();
  setModalOpen(videoUploadModal, true);
  switchUploadTab(tab);
  loadPublishedVideos();
}

function switchUploadTab(tab) {
  const isNew = tab === "new";
  $("#tabNewUploadBtn")?.classList.toggle("active", isNew);
  $("#tabUploadHistoryBtn")?.classList.toggle("active", !isNew);
  const tabNew = $("#uploadTabNew");
  const tabHist = $("#uploadTabHistory");
  if (tabNew) tabNew.style.display = isNew ? "" : "none";
  if (tabHist) tabHist.style.display = isNew ? "none" : "";
}

$("#headerUploadBtn")?.addEventListener("click", () => switchWorkspaceView("syndicate"));
$("#sidebarUploadBtn")?.addEventListener("click", () => switchWorkspaceView("syndicate"));
$("#workspaceUploadBtn")?.addEventListener("click", () => openVideoUploadModal("new"));
$("#cancelVideoUpload")?.addEventListener("click", () => setModalOpen(videoUploadModal, false));
$("#cancelUploadForm")?.addEventListener("click", () => setModalOpen(videoUploadModal, false));
videoUploadModal?.addEventListener("click", (e) => {
  if (e.target === videoUploadModal) setModalOpen(videoUploadModal, false);
});

$("#tabNewUploadBtn")?.addEventListener("click", () => switchUploadTab("new"));
$("#tabUploadHistoryBtn")?.addEventListener("click", () => switchUploadTab("history"));

// File browse & drag and drop
const videoDropzone = $("#videoDropzone");
const videoFileInput = $("#videoFileInput");
const btnBrowseVideo = $("#btnBrowseVideo");
const btnChangeVideo = $("#btnChangeVideo");

btnBrowseVideo?.addEventListener("click", (e) => {
  e.stopPropagation();
  videoFileInput?.click();
});

videoDropzone?.addEventListener("click", (e) => {
  if (e.target.closest("button") || e.target.closest("video")) return;
  videoFileInput?.click();
});

videoDropzone?.addEventListener("dragover", (e) => {
  e.preventDefault();
  videoDropzone.classList.add("drag-over");
});

videoDropzone?.addEventListener("dragleave", () => {
  videoDropzone.classList.remove("drag-over");
});

videoDropzone?.addEventListener("drop", (e) => {
  e.preventDefault();
  videoDropzone.classList.remove("drag-over");
  if (e.dataTransfer?.files?.[0]) {
    handleVideoFileSelected(e.dataTransfer.files[0]);
  }
});

videoFileInput?.addEventListener("change", (e) => {
  if (e.target.files?.[0]) {
    handleVideoFileSelected(e.target.files[0]);
  }
});

btnChangeVideo?.addEventListener("click", (e) => {
  e.stopPropagation();
  currentSelectedVideoFile = null;
  currentThumbnailDataUrl = null;
  if (videoFileInput) videoFileInput.value = "";
  const idle = $("#dropzoneIdle");
  const loaded = $("#dropzoneLoaded");
  if (idle) idle.style.display = "";
  if (loaded) loaded.style.display = "none";
  const player = $("#videoPreviewPlayer");
  if (player) { player.pause(); player.src = ""; }
});

function handleVideoFileSelected(file) {
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) {
    showToast("Please select a video file (MP4, MOV, WEBM, MKV)");
    return;
  }
  currentSelectedVideoFile = file;
  const idle = $("#dropzoneIdle");
  const loaded = $("#dropzoneLoaded");
  if (idle) idle.style.display = "none";
  if (loaded) loaded.style.display = "";

  const nameEl = $("#videoFileNameText");
  const sizeEl = $("#videoFileSizeBadge");
  const durEl = $("#videoDurationBadge");
  const resEl = $("#videoResolutionBadge");
  const titleInput = $("#videoUploadTitle");

  if (nameEl) nameEl.textContent = file.name;
  if (sizeEl) sizeEl.textContent = (file.size / (1024 * 1024)).toFixed(1) + " MB";
  if (titleInput && !titleInput.value) {
    titleInput.value = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
  }

  const url = URL.createObjectURL(file);
  const player = $("#videoPreviewPlayer");
  if (player) {
    player.src = url;
    player.onloadedmetadata = () => {
      if (durEl) durEl.textContent = formatTime(Math.floor(player.duration || 0));
      if (resEl) resEl.textContent = `${player.videoWidth || 1920}x${player.videoHeight || 1080}`;

      // Capture thumbnail frame
      try {
        player.currentTime = Math.min(1.0, (player.duration || 2) / 2);
        player.onseeked = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.min(640, player.videoWidth || 640);
          canvas.height = Math.min(360, player.videoHeight || 360);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(player, 0, 0, canvas.width, canvas.height);
          currentThumbnailDataUrl = canvas.toDataURL("image/jpeg", 0.7);
        };
      } catch (_) {}
    };
  }
}

// Platform selection toggles
document.querySelectorAll(".platform-select-card").forEach((card) => {
  card.addEventListener("click", (e) => {
    const checkbox = card.querySelector('input[type="checkbox"]');
    if (e.target !== checkbox) {
      checkbox.checked = !checkbox.checked;
    }
    card.classList.toggle("active", checkbox.checked);
  });
});

// Upload form submit
$("#videoUploadForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#videoUploadError");
  if (errEl) errEl.textContent = "";

  const title = $("#videoUploadTitle")?.value.trim();
  if (!title) {
    if (errEl) errEl.textContent = "Video title is required";
    return;
  }

  const selectedPlatforms = Array.from(document.querySelectorAll('input[name="targetPlatform"]:checked')).map((c) => c.value);
  if (selectedPlatforms.length === 0) {
    if (errEl) errEl.textContent = "Select at least one broadcast platform";
    return;
  }

  const submitBtn = $("#btnSubmitVideoUpload");
  const submitText = $("#btnSubmitVideoText");
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Syndicating to platforms...";

  // Show progress matrix
  const matrix = $("#uploadProgressMatrix");
  const barsList = $("#matrixBarsList");
  if (matrix) matrix.style.display = "";
  if (barsList) {
    barsList.innerHTML = selectedPlatforms.map((p) => `
      <div class="matrix-row" id="matrixRow_${p}">
        <div class="matrix-row-meta">
          <strong>${p.toUpperCase()}</strong>
          <span class="matrix-pct">0%</span>
        </div>
        <div class="matrix-progress-track">
          <div class="matrix-progress-fill" style="width: 15%;"></div>
        </div>
        <div class="matrix-actions-row" id="matrixActions_${p}"></div>
      </div>
    `).join("");
  }

  // Animate progress smoothly
  let progress = 15;
  const progressTimer = setInterval(() => {
    progress = Math.min(88, progress + Math.floor(Math.random() * 12 + 4));
    selectedPlatforms.forEach((p) => {
      const row = $(`#matrixRow_${p}`);
      if (row) {
        const pctEl = row.querySelector(".matrix-pct");
        const fill = row.querySelector(".matrix-progress-fill");
        if (pctEl) pctEl.textContent = `${progress}% (Transcoding & Uploading...)`;
        if (fill) fill.style.width = `${progress}%`;
      }
    });
  }, 350);

  const payload = {
    title,
    description: $("#videoUploadDescription")?.value.trim() || "",
    tags: $("#videoUploadTags")?.value.trim() || "",
    category: $("#videoUploadCategory")?.value || "Gaming",
    privacy: $("#videoUploadPrivacy")?.value || "public",
    platforms: selectedPlatforms,
    fileName: currentSelectedVideoFile?.name || "stream_broadcast.mp4",
    fileSize: currentSelectedVideoFile?.size || 48200000,
    duration: $("#videoDurationBadge")?.textContent || "02:15",
    thumbnail: currentThumbnailDataUrl || null
  };

  try {
    const res = await api("/api/videos/upload", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    clearInterval(progressTimer);

    // Complete all progress bars to 100%
    selectedPlatforms.forEach((p) => {
      const row = $(`#matrixRow_${p}`);
      const actionRow = $(`#matrixActions_${p}`);
      const platData = res.video?.platforms?.[p];
      if (row) {
        const pctEl = row.querySelector(".matrix-pct");
        const fill = row.querySelector(".matrix-progress-fill");
        if (pctEl) pctEl.innerHTML = `<span style="color:#10b981;">✓ Published Live!</span>`;
        if (fill) { fill.style.width = "100%"; fill.style.background = "#10b981"; }
      }
      if (actionRow && platData?.url) {
        actionRow.innerHTML = `<a href="${platData.url}" target="_blank" rel="noopener noreferrer" class="btn-matrix-link">View on ${platData.platformName} ↗</a>`;
      }
    });

    const matrixTitle = $("#matrixStatusTitle");
    if (matrixTitle) matrixTitle.innerHTML = `<span style="color:#10b981;">✓ Successfully Published Everywhere!</span>`;
    showToast(`🚀 Video published to ${selectedPlatforms.length} platforms!`);

    await loadPublishedVideos();
  } catch (error) {
    clearInterval(progressTimer);
    if (errEl) errEl.textContent = error.message;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Upload to All Platforms";
  }
});

// Load and render published videos history
async function loadPublishedVideos() {
  if (!signedInUser) return;
  try {
    const data = await api("/api/videos");
    publishedVideos = data.videos || [];
    renderPublishedVideos(publishedVideos);
  } catch (_) {}
}

function renderPublishedVideos(videos) {
  const countEl = $("#publishedVideosCount");
  if (countEl) countEl.textContent = videos.length;

  const historyList = $("#publishedVideosList");
  if (historyList) {
    if (!videos.length) {
      historyList.innerHTML = `<p class="empty-state">No videos uploaded yet. Upload your first video to syndicate everywhere!</p>`;
    } else {
      historyList.innerHTML = videos.map((v) => {
        const dateStr = v.createdAt ? new Date(v.createdAt).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        const platChips = Object.entries(v.platforms || {}).map(([pKey, pVal]) => `
          <a href="${pVal.url}" target="_blank" rel="noopener noreferrer" class="history-link-chip">
            ${pKey.toUpperCase()}: ${pVal.videoId || "Watch"} ↗
          </a>
        `).join("");

        return `
          <div class="history-card" id="historyCard_${v.id}">
            <div class="history-thumb-wrap">
              ${v.thumbnail ? `<img src="${v.thumbnail}" alt="Thumbnail">` : `<span class="history-thumb-placeholder">📹</span>`}
            </div>
            <div class="history-content">
              <strong>${escapeHtml(v.title)}</strong>
              ${v.description ? `<p>${escapeHtml(v.description)}</p>` : ""}
              <div class="video-file-meta-pills">
                <span class="file-pill">${escapeHtml(v.duration || "02:15")}</span>
                <span class="file-pill">${escapeHtml(v.category || "Gaming")}</span>
                <span class="file-pill">${escapeHtml(v.privacy || "public")}</span>
                <span class="file-pill">${escapeHtml(dateStr)}</span>
              </div>
              <div class="history-tags-row">
                ${platChips}
                <button type="button" class="btn-delete-history" data-video-id="${v.id}">Delete</button>
              </div>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // Update workspace preview
  const recentBar = $("#workspaceRecentUploads");
  if (recentBar) {
    if (!videos.length) {
      recentBar.innerHTML = `<span class="recent-uploads-empty">No syndicated videos yet. Click "Upload Video Everywhere" to publish your first video!</span>`;
    } else {
      recentBar.innerHTML = videos.slice(0, 3).map((v) => {
        return `
          <div class="recent-video-mini-card">
            <span class="recent-video-mini-title">
              <span>📹</span> ${escapeHtml(v.title)} <small style="color:var(--muted);font-weight:normal;">(${v.duration || "02:15"})</small>
            </span>
            <div class="recent-video-links">
              ${Object.entries(v.platforms || {}).map(([p, data]) => `
                <a href="${data.url}" target="_blank" rel="noopener noreferrer" class="video-link-tag">${p.toUpperCase()} ↗</a>
              `).join("")}
            </div>
          </div>
        `;
      }).join("");
    }
  }
}

// Delete video from history
document.addEventListener("click", async (e) => {
  const delBtn = e.target.closest(".btn-delete-history");
  if (!delBtn) return;
  const videoId = delBtn.dataset.videoId;
  if (!videoId) return;
  try {
    await api(`/api/videos/${videoId}`, { method: "DELETE" });
    showToast("Video removed from history");
    publishedVideos = publishedVideos.filter((v) => v.id !== videoId);
    renderPublishedVideos(publishedVideos);
  } catch (error) {
    showToast(error.message);
  }
});

// OAUTH CALLBACK TOAST
function checkOAuthCallbackBanner() {
  const params = new URLSearchParams(location.search);
  const oauthPlatform = params.get("oauth");
  if (!oauthPlatform) return;
  if (params.get("connected") === "1") {
    showToast(`✓ Connected ${oauthPlatform} account via OAuth`);
  } else if (params.get("error")) {
    showToast(`${oauthPlatform} OAuth: ${params.get("error")}`);
  }
  history.replaceState({}, "", location.pathname);
}

// ========================================================
// ALERT BOX STUDIO & OBS OVERLAY CONTROLS
// ========================================================
let currentAlerts = [];

function updateOverlayUrlDisplay() {
  const input = $("#obsOverlayUrlInput");
  const keyParam = signedInUser ? `?key=${encodeURIComponent(signedInUser.id)}` : "";
  const fullUrl = `${location.origin}/alerts.html${keyParam}`;
  if (input) input.value = fullUrl;
}

function timeAgo(dateString) {
  try {
    const diffMs = Date.now() - new Date(dateString).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "Just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  } catch (_) {
    return "Recently";
  }
}

function renderAlerts(alerts, latestAlert) {
  const topbarCount = $("#topbarAlertsCount");
  if (topbarCount) topbarCount.textContent = alerts.length;

  const totalCount = $("#totalAlertsCount");
  if (totalCount) totalCount.textContent = alerts.length;

  // 1. Update Deck View Strip
  const currentLatest = latestAlert || alerts[0];
  if (currentLatest) {
    const iconBox = $("#deckAlertIconBox");
    const platEl = $("#deckAlertPlatform");
    const msgEl = $("#deckAlertMessage");
    const timeEl = $("#deckAlertTime");

    if (iconBox) iconBox.textContent = currentLatest.type === "subscribe" ? "💎" : currentLatest.type === "like" ? "❤️" : "🚀";
    if (platEl) platEl.textContent = capitalize(currentLatest.platform || "live");
    if (msgEl) msgEl.textContent = currentLatest.message || `${currentLatest.username} interacted!`;
    if (timeEl) timeEl.textContent = currentLatest.time ? timeAgo(currentLatest.time) : "Just now";

    const replayDeckBtn = $("#btnReplayDeckAlert");
    if (replayDeckBtn) {
      replayDeckBtn.onclick = () => replayAlert(currentLatest);
    }
  }

  // 2. Update History List in Alert Box Console
  const historyList = $("#alertsHistoryList");
  if (historyList) {
    const filter = $("#alertsFilterTabs .alert-filter-btn.active")?.dataset.filter || "all";
    const filtered = alerts.filter((a) => filter === "all" || a.type === filter);

    if (filtered.length === 0) {
      historyList.innerHTML = `<p class="empty-state">No ${filter === "all" ? "" : filter} alerts recorded yet. Click one of the test buttons to simulate a stream alert!</p>`;
    } else {
      historyList.innerHTML = filtered.map((a) => {
        const iconSym = a.type === "subscribe" ? "💎" : a.type === "like" ? "❤️" : "🚀";
        return `
          <div class="alert-history-item" data-id="${escapeHtml(a.id || "")}">
            <div class="alert-item-icon ${a.type}">${iconSym}</div>
            <div class="alert-item-info">
              <div class="alert-item-top">
                <strong class="alert-item-user">${escapeHtml(a.username || "Viewer")}</strong>
                <span class="alert-item-badge ${a.platform}">${escapeHtml(a.platform || "stream")}</span>
                <span class="tag ${a.type}-tag">${a.type.toUpperCase()}</span>
              </div>
              <p class="alert-item-desc">${escapeHtml(a.detail || a.message || "")}</p>
            </div>
            <time class="alert-item-time">${timeAgo(a.time)}</time>
            <button type="button" class="btn-replay-item" data-action="replay-alert" data-id="${escapeHtml(a.id || "")}" title="Replay alert on stream">
              <span>Replay</span>
            </button>
          </div>
        `;
      }).join("");
    }
  }
}

function playLocalChime(type) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    gain.connect(ctx.destination);
    const notes = type === "subscribe" ? [523.25, 659.25, 783.99, 1046.50]
                : type === "like" ? [659.25, 880.00, 1046.50]
                : [587.33, 739.99, 880.00];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + (idx * 0.09));
      osc.connect(gain);
      osc.start(now + (idx * 0.09));
      osc.stop(now + (idx * 0.09) + 0.35);
    });
  } catch (_) {}
}

function triggerPreviewAlert(type, username, platform, detail) {
  const card = $("#previewAlertCard");
  const icon = $("#previewAlertIcon");
  const tag = $("#previewAlertTag");
  const nameEl = $("#previewAlertName");
  const descEl = $("#previewAlertDesc");
  const platEl = $("#previewAlertPlatBadge");
  if (!card) return;

  card.className = `preview-alert-card ${type}`;
  if (type === "subscribe") {
    if (icon) icon.textContent = "💎";
    if (tag) tag.textContent = "NEW SUBSCRIBER!";
  } else if (type === "like") {
    if (icon) icon.textContent = "❤️";
    if (tag) tag.textContent = "NEW LIKE / REACTION!";
  } else {
    if (icon) icon.textContent = "🚀";
    if (tag) tag.textContent = "NEW FOLLOWER!";
  }

  if (nameEl) nameEl.textContent = username;
  if (descEl) descEl.textContent = detail;
  if (platEl) platEl.textContent = capitalize(platform);

  card.style.animation = "none";
  void card.offsetWidth;
  card.style.animation = "alertFloat 3s infinite ease-in-out";

  playLocalChime(type);
}

async function sendTestAlert(type) {
  showToast(`🔔 Triggering test ${type} alert...`);
  try {
    const res = await api("/api/alerts/test", {
      method: "POST",
      body: JSON.stringify({ type })
    });
    if (res.alert) {
      triggerPreviewAlert(res.alert.type, res.alert.username, res.alert.platform, res.alert.message);
      showToast(`✓ Broadcasted test ${res.alert.type} alert for ${res.alert.username}!`);
      await refreshDashboard();
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function replayAlert(alert) {
  if (!alert) return;
  showToast(`🔔 Replaying alert for ${alert.username}...`);
  try {
    await api("/api/alerts", {
      method: "POST",
      body: JSON.stringify({
        type: alert.type,
        platform: alert.platform,
        username: alert.username,
        message: alert.message,
        detail: alert.detail
      })
    });
    triggerPreviewAlert(alert.type, alert.username, alert.platform, alert.message);
    await refreshDashboard();
  } catch (err) {
    showToast(err.message);
  }
}

// Test buttons in Alert Box view
$$(".btn-test-alert").forEach((btn) => {
  btn.addEventListener("click", () => sendTestAlert(btn.dataset.test));
});

// Test buttons in Broadcast Deck view
$$(".btn-deck-alert-test").forEach((btn) => {
  btn.addEventListener("click", () => sendTestAlert(btn.dataset.testType));
});

// Copy OBS Overlay URL
function copyOverlayUrl() {
  updateOverlayUrlDisplay();
  const input = $("#obsOverlayUrlInput");
  if (!input) return;
  navigator.clipboard.writeText(input.value)
    .then(() => showToast("✓ OBS Overlay URL copied to clipboard!"))
    .catch(() => {
      input.select();
      document.execCommand("copy");
      showToast("✓ Copied overlay URL");
    });
}

$("#btnCopyOverlayUrl")?.addEventListener("click", copyOverlayUrl);
$("#btnCopyOverlayInput")?.addEventListener("click", copyOverlayUrl);

// Open overlay standalone window
$("#btnOpenOverlayWindow")?.addEventListener("click", () => {
  updateOverlayUrlDisplay();
  const keyParam = signedInUser ? `?key=${encodeURIComponent(signedInUser.id)}` : "";
  window.open(`/alerts.html${keyParam}`, "OBSAlertOverlay", "width=800,height=600,menubar=no,toolbar=no");
});

// Alert filter tabs
$("#alertsFilterTabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".alert-filter-btn");
  if (!btn) return;
  $$("#alertsFilterTabs .alert-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderAlerts(currentAlerts, currentAlerts[0] || null);
});

// Replay buttons in alert list
document.addEventListener("click", (e) => {
  const replayBtn = e.target.closest('[data-action="replay-alert"]');
  if (replayBtn) {
    const id = replayBtn.dataset.id;
    const found = currentAlerts.find((a) => a.id === id);
    if (found) replayAlert(found);
  }
});

// Alert duration slider display
$("#cfgDurationSlider")?.addEventListener("input", (e) => {
  const val = $("#cfgDurationVal");
  if (val) val.textContent = `${e.target.value}s`;
});

// Save alert options
["cfgShowLikes", "cfgShowSubs", "cfgShowFollows", "cfgSoundEnabled"].forEach((id) => {
  $(`#${id}`)?.addEventListener("change", async () => {
    try {
      await api("/api/alerts/config", {
        method: "PUT",
        body: JSON.stringify({
          showLikes: $("#cfgShowLikes")?.checked,
          showSubscribes: $("#cfgShowSubs")?.checked,
          showFollows: $("#cfgShowFollows")?.checked,
          soundEnabled: $("#cfgSoundEnabled")?.checked,
          duration: Number($("#cfgDurationSlider")?.value || 5)
        })
      });
      showToast("✓ Alert settings saved");
    } catch (_) {}
  });
});

$("#cfgDurationSlider")?.addEventListener("change", async () => {
  try {
    await api("/api/alerts/config", {
      method: "PUT",
      body: JSON.stringify({
        duration: Number($("#cfgDurationSlider")?.value || 5)
      })
    });
    showToast("✓ Alert duration updated");
  } catch (_) {}
});

// INIT
loadSavedPreferences();
checkOAuthCallbackBanner();
if (location.protocol === "https:") {
  remoteObsTimer = setInterval(refreshRemoteOBS, 2500);
}
loadCurrentUser();
updateOverlayUrlDisplay();
