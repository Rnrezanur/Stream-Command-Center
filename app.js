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
const REQUIRED_AGENT_VERSION = "20260610-7";
const pendingOBS = new Map();

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

  button?.classList.remove("connected", "connecting", "disconnected");
  button?.classList.add(state);

  if (state === "connected") {
    if (label) label.textContent = "OBS Connected";
    if (statusTxt) statusTxt.textContent = "OBS Ready";
    showToast("✓ Connected to OBS Studio");
  } else if (state === "connecting") {
    if (label) label.textContent = "Connecting...";
    if (statusTxt) statusTxt.textContent = "Syncing...";
  } else {
    if (label) label.textContent = location.protocol === "https:" ? "Connect Remote OBS" : "Connect OBS";
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
  showToast(`⚡ Auto-connecting ${platform === "all" ? "all channels" : platform}...`);
  try {
    const res = await api("/api/platforms/auto-connect", { method: "POST", body: JSON.stringify({ platform }) });
    showToast(`✓ ${platform === "all" ? "YouTube, Twitch & Facebook" : platform} connected live!`);
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
  const totalViewers = $("#totalViewers");
  if (totalViewers) totalViewers.textContent = Number(data.totalViewers || 0).toLocaleString();

  // Update platform cards
  for (const name of ["youtube", "twitch", "facebook"]) {
    const card = $(`.platform-card[data-platform="${name}"]`);
    const platform = data.platforms?.[name] || { connected: false, viewers: 0 };
    if (card) {
      const numEl = card.querySelector(".metric-num");
      if (numEl) numEl.textContent = Number(platform.viewers || 0).toLocaleString();

      const dot = card.querySelector(".platform-status-dot");
      if (dot) dot.className = `platform-status-dot ${platform.connected ? "connected" : "disconnected"}`;

      const autoBtn = card.querySelector(".btn-card-auto");
      if (autoBtn) {
        autoBtn.classList.toggle("connected", Boolean(platform.connected));
        autoBtn.textContent = platform.connected ? "✓ Connected" : "⚡ Auto-Connect";
      }

      const handle = card.querySelector(".platform-handle");
      if (handle) {
        if (platform.channel) handle.textContent = platform.channel;
        else if (platform.page) handle.textContent = platform.page;
      }
    }
  }

  // Update chat
  const comments = data.comments || [];
  const countEl = $("#commentCount");
  if (countEl) countEl.textContent = comments.length;

  const chatFeed = $("#chatFeed");
  if (chatFeed) {
    const nextHtml = comments.length
      ? comments.map(renderComment).join("")
      : `<p class="empty-state">${signedInUser ? "Broadcasting live! Comments will flow here automatically." : "Sign in to monitor live chat."}</p>`;
    if (nextHtml !== lastRenderedChatHtml) {
      chatFeed.innerHTML = nextHtml;
      lastRenderedChatHtml = nextHtml;
    }
    applyChatFilter();
  }
}

function renderComment(comment) {
  const platform = ["youtube", "twitch", "facebook"].includes(comment.platform) ? comment.platform : "youtube";
  const age = comment.time ? new Date(comment.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "now";
  const isHost = Boolean(comment.isHost);
  const avatarBg = platform === "youtube" ? "var(--youtube)" : platform === "twitch" ? "var(--twitch)" : "var(--facebook)";

  return `<article class="comment ${isHost ? "is-host" : ""}" data-platform="${platform}">
    <div class="comment-avatar" style="background:${avatarBg}">
      ${escapeHtml(initials(comment.author || "?"))}
    </div>
    <div class="comment-content">
      <div class="comment-meta">
        <strong>${escapeHtml(comment.author || "Viewer")}</strong>
        <span class="tag ${platform}-tag">${escapeHtml(platform)}</span>
        ${isHost ? '<span class="tag host-tag">HOST</span>' : ''}
        <time>${escapeHtml(age)}</time>
      </div>
      <p>${escapeHtml(comment.message || "")}</p>
    </div>
  </article>`;
}

function setSignedInUser(user) {
  signedInUser = user;
  const initialsEl = $("#accountInitials");
  const hdrLabel = $("#headerAccountLabel");
  const chatSender = $("#chatSenderName");
  
  if (initialsEl) initialsEl.textContent = user ? initials(user.name) : "?";
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
    setSignedInUser(user);
    await refreshDashboard();
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
    setConnectionState("disconnected");
  }
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

// 2. CHAT SEND WITH ZERO DELAY (OPTIMISTIC)
$("#chatForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const message = input.value.trim();
  if (!message) return;

  const filter = $("#chatFilters button.active")?.dataset.filter || "all";
  const platforms = filter === "all" ? ["youtube", "twitch", "facebook"] : [filter];

  input.value = "";
  // Optimistic instant append
  const instant = {
    id: "usr_" + Date.now(),
    platform: platforms[0],
    author: signedInUser ? signedInUser.name : "Streamer (You)",
    message,
    time: new Date().toISOString(),
    isHost: true
  };
  const feed = $("#chatFeed");
  const empty = feed.querySelector(".empty-state");
  if (empty) empty.remove();
  lastRenderedChatHtml = "";
  feed.insertAdjacentHTML("afterbegin", renderComment(instant));
  applyChatFilter();

  try {
    await api("/api/chat/send", { method: "POST", body: JSON.stringify({ message, platforms }) });
  } catch (_) {}
});

// 3. CHAT FILTERS
$("#chatFilters")?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  $$("#chatFilters button").forEach((b) => b.classList.remove("active"));
  button.classList.add("active");
  applyChatFilter();
});

// 4. AUTO-CONNECT BUTTONS
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
}

async function openPlatformSettings(platform = "youtube") {
  if (!signedInUser) return openAccountModal();
  selectSettingsTab(platform);
  $("#platformError").textContent = "";
  if ($("#facebookTestStatus")) $("#facebookTestStatus").textContent = "Save before testing.";
  platformModal.classList.add("open");
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
$("#cancelPlatformSettings")?.addEventListener("click", () => platformModal.classList.remove("open"));
platformModal?.addEventListener("click", (e) => { if (e.target === platformModal) platformModal.classList.remove("open"); });

$(".settings-tabs")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-settings-tab]");
  if (b) selectSettingsTab(b.dataset.settingsTab);
});

document.addEventListener("click", (e) => {
  const configBtn = e.target.closest(".btn-card-config");
  if (configBtn) openPlatformSettings(configBtn.dataset.platform);
});

$("#platformForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#platformError").textContent = "";
  const payload = { youtube: {}, twitch: {}, facebook: {} };
  for (const input of $$("#platformForm [name]")) {
    const [platform, field] = input.name.split(".");
    const val = input.value.trim();
    if (val) payload[platform][field] = val;
  }
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    platformModal.classList.remove("open");
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
$("#cancelStop")?.addEventListener("click", () => stopModal?.classList.remove("open"));
$("#confirmStop")?.addEventListener("click", () => {
  stopModal?.classList.remove("open");
  updateStream(false);
  showToast("Stream stopped");
  if (obs?.socket?.readyState === WebSocket.OPEN || location.protocol === "https:") {
    callOBS("StopStream").catch(() => {});
  }
});
stopModal?.addEventListener("click", (e) => { if (e.target === stopModal) stopModal.classList.remove("open"); });

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

$("#cancelRemoteObs")?.addEventListener("click", () => remoteObsModal?.classList.remove("open"));
remoteObsModal?.addEventListener("click", (e) => { if (e.target === remoteObsModal) remoteObsModal.classList.remove("open"); });

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
    remoteObsModal?.classList.add("open");
    return;
  }
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    obs.disconnect();
    obs = null;
    setConnectionState("disconnected");
    showToast("OBS disconnected");
    return;
  }
  connectionModal.classList.add("open");
});
$("#cancelConnection")?.addEventListener("click", () => connectionModal.classList.remove("open"));
connectionModal?.addEventListener("click", (e) => { if (e.target === connectionModal) connectionModal.classList.remove("open"); });

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
    connectionModal.classList.remove("open");
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

// ACCOUNT MODAL
const accountModal = $("#accountModal");
let accountModalRegistering = false;

function syncAccountModalMode() {
  const form = $("#accountForm");
  form?.classList.toggle("registering", accountModalRegistering);
  if ($("#accountTitle")) {
    $("#accountTitle").textContent = accountModalRegistering
      ? "Create Account"
      : (signedInUser ? `Switch Account (${signedInUser.name})` : "Sign in");
  }
  if ($("#accountMode")) {
    $("#accountMode").textContent = accountModalRegistering ? "Sign in instead" : "Create account";
  }
  if ($("#logoutButton")) {
    $("#logoutButton").style.display = signedInUser ? "" : "none";
  }
}

function openAccountModal() {
  $("#accountError").textContent = "";
  accountModal.classList.add("open");
  syncAccountModalMode();
}

$("#accountButton")?.addEventListener("click", openAccountModal);
$("#headerAccountButton")?.addEventListener("click", openAccountModal);
$("#accountMode")?.addEventListener("click", () => {
  accountModalRegistering = !accountModalRegistering;
  $("#accountError").textContent = "";
  syncAccountModalMode();
});

$("#accountForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#accountError").textContent = "";
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
    accountModal.classList.remove("open");
    await refreshDashboard();
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
  accountModal.classList.remove("open");
  showToast("Signed out");
});
accountModal?.addEventListener("click", (e) => { if (e.target === accountModal) accountModal.classList.remove("open"); });

// KEYBOARD SHORTCUTS
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $$(".modal-backdrop.open").forEach((m) => m.classList.remove("open"));
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

// INIT
loadSavedPreferences();
checkOAuthCallbackBanner();
if (location.protocol === "https:") {
  remoteObsTimer = setInterval(refreshRemoteOBS, 2500);
}
loadCurrentUser();
