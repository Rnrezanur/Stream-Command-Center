const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const toast = $("#toast");
let toastTimer, obs, statsTimer;
let elapsed = 0;
let micInputName = "Mic/Aux";
let signedInUser = null;
let dashboardTimer = null;
let remoteObsTimer = null;

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

setInterval(() => {
  if ($("#streamButton").dataset.active === "true") elapsed += 1;
  $("#liveTimer").textContent = formatTime(elapsed);
  if ($("#recordButton").dataset.active === "true") $("#recordSub").textContent = `Recording - ${formatTime(elapsed)}`;
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
      const timeout = setTimeout(() => reject(new Error("Connection timed out")), 6000);
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
      }, 6000);
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
  button.classList.toggle("disconnected", state === "disconnected");
  button.classList.toggle("connecting", state === "connecting");
  $("#connectionLabel").textContent = state === "connected" ? "OBS connected" : state === "connecting" ? "Connecting..." : "Connect OBS";
  if (state === "disconnected") {
    $("#streamSub").textContent = "Connect OBS to control";
    $("#recordSub").textContent = "Connect OBS to control";
  }
}

function updateStream(active, timecode) {
  $("#streamButton").dataset.active = String(active);
  $("#streamButton").classList.toggle("danger", active);
  $("#streamButtonLabel").textContent = active ? "Stop stream" : "Start stream";
  $("#streamSub").textContent = active ? "OBS output is live" : "Ready to stream";
  $(".status-label").textContent = active ? "Broadcast live" : "Broadcast offline";
  $(".status-light").style.background = active ? "#ff4d58" : "#68717a";
  $(".quality").textContent = active ? "OBS output active" : "Ready";
  if (timecode) elapsed = timecodeToSeconds(timecode);
}

function updateRecord(active) {
  $("#recordButton").dataset.active = String(active);
  $("#recordButton").classList.toggle("recording", active);
  $(".record-square").style.background = active ? "#ff4d58" : "#879099";
  $("#recordLabel").textContent = active ? "Stop recording" : "Start recording";
  $("#recordSub").textContent = active ? `Recording - ${formatTime(elapsed)}` : "Ready to record";
}

function updateMute(muted) {
  $("#muteButton").dataset.muted = String(muted);
  $("#muteButton").classList.toggle("danger", muted);
  $("#muteLabel").textContent = muted ? "Unmute microphone" : "Mute microphone";
}

function updateScene(sceneName) {
  $$(".scene-card").forEach((scene, index) => {
    const active = scene.dataset.scene === sceneName;
    scene.classList.toggle("active", active);
    scene.querySelector("small").textContent = active ? "LIVE" : `CTRL ${index + 1}`;
  });
}

function timecodeToSeconds(timecode) {
  const parts = timecode.split(":").map(Number);
  return Math.floor((parts[0] * 3600) + (parts[1] * 60) + parts[2]);
}

async function syncOBSState() {
  const [scenes, stream, record, mute] = await Promise.all([
    obs.call("GetSceneList"),
    obs.call("GetStreamStatus"),
    obs.call("GetRecordStatus"),
    obs.call("GetInputMute", { inputName: micInputName })
  ]);
  renderScenes(scenes.scenes || [], scenes.currentProgramSceneName);
  updateStream(stream.outputActive, stream.outputTimecode);
  updateRecord(record.outputActive);
  updateMute(mute.inputMuted);
  await updateStats();
}

function renderScenes(scenes, activeScene) {
  if (!scenes.length) return;
  $("#sceneGrid").innerHTML = scenes.slice(0, 8).map((scene, index) => `
    <button class="scene-card ${scene.sceneName === activeScene ? "active" : ""}" data-scene="${escapeHtml(scene.sceneName)}">
      <span class="preview ${["main-preview", "screen-preview", "brb-preview", "starting-preview"][index % 4]}"><b>${escapeHtml(scene.sceneName.slice(0, 16))}</b></span>
      <span class="scene-meta"><strong>${escapeHtml(scene.sceneName)}</strong><small>${scene.sceneName === activeScene ? "LIVE" : `CTRL ${index + 1}`}</small></span>
    </button>`).join("");
}

async function updateStats() {
  if (!obs) return;
  try {
    const [stats, stream] = await Promise.all([obs.call("GetStats"), obs.call("GetStreamStatus")]);
    $(".stats-row div:nth-child(1) strong").textContent = Math.round((stream.outputBytes || 0) * 8 / Math.max(stream.outputDuration || 1, 1)).toLocaleString();
    $(".stats-row div:nth-child(2) strong").textContent = Number(stream.outputSkippedFrames || 0).toLocaleString();
    $(".stats-row div:nth-child(3) strong").textContent = Number(stats.cpuUsage || 0).toFixed(1);
  } catch (_) {}
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function normalizeOBSAddress(value) {
  let address = value.trim().replace(/\/+$/, "");
  if (!/^wss?:\/\//i.test(address)) address = `ws://${address}`;
  const url = new URL(address);
  if (!url.port) url.port = "4455";
  return url.href.replace(/\/$/, "");
}

$("#connectionButton").addEventListener("click", () => {
  if (location.protocol === "https:") {
    $("#remoteObsModal").classList.add("open");
    return;
  }
  if (obs?.socket?.readyState === WebSocket.OPEN) {
    obs.disconnect();
    obs = null;
    showToast("OBS disconnected");
    return;
  }
  $("#connectionModal").classList.add("open");
  $("#connectionModal").setAttribute("aria-hidden", "false");
});

$("#cancelConnection").addEventListener("click", closeConnectionModal);
function closeConnectionModal() {
  $("#connectionModal").classList.remove("open");
  $("#connectionModal").setAttribute("aria-hidden", "true");
}

$("#connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#connectionError").textContent = "";
  setConnectionState("connecting");
  $("#connectSubmit").disabled = true;
  try {
    obs = new OBSWebSocketClient();
    micInputName = $("#obsMicInput").value.trim();
    $("#micName").textContent = micInputName;
    const address = normalizeOBSAddress($("#obsAddress").value);
    $("#obsAddress").value = address;
    obs.eventHandler = (type, data) => {
      if (type === "CurrentProgramSceneChanged") updateScene(data.sceneName);
      if (type === "StreamStateChanged") updateStream(data.outputActive, data.outputTimecode);
      if (type === "RecordStateChanged") updateRecord(data.outputActive);
      if (type === "InputMuteStateChanged" && data.inputName === micInputName) updateMute(data.inputMuted);
    };
    await obs.connect(address, $("#obsPassword").value);
    await syncOBSState();
    localStorage.setItem("obsAddress", address);
    localStorage.setItem("obsMicInput", micInputName);
    setConnectionState("connected");
    closeConnectionModal();
    statsTimer = setInterval(updateStats, 5000);
    showToast("Connected to OBS Studio");
  } catch (error) {
    obs?.disconnect();
    obs = null;
    setConnectionState("disconnected");
    const remoteAddress = !$("#obsAddress").value.includes("127.0.0.1") && !$("#obsAddress").value.includes("localhost");
    $("#connectionError").textContent = remoteAddress && /timed out|reach|closed/i.test(error.message)
      ? "Cannot reach OBS. Confirm both devices use the same network and allow TCP port 4455 through the OBS computer firewall."
      : error.message;
  } finally {
    $("#connectSubmit").disabled = false;
  }
});

$("#muteButton").addEventListener("click", async () => {
  try {
    const muted = $("#muteButton").dataset.muted === "true";
    await callOBS("SetInputMute", { inputName: micInputName, inputMuted: !muted });
  } catch (error) { showToast(error.message); }
});

$("#recordButton").addEventListener("click", async () => {
  try { await callOBS($("#recordButton").dataset.active === "true" ? "StopRecord" : "StartRecord"); }
  catch (error) { showToast(error.message); }
});

const stopModal = $("#stopModal");
$("#streamButton").addEventListener("click", async () => {
  if (!obs && location.protocol !== "https:") return showToast("Connect OBS first");
  if ($("#streamButton").dataset.active === "true") {
    stopModal.classList.add("open");
    stopModal.setAttribute("aria-hidden", "false");
  } else {
    try { await callOBS("StartStream"); } catch (error) { showToast(error.message); }
  }
});
$("#cancelStop").addEventListener("click", closeStopModal);
function closeStopModal() { stopModal.classList.remove("open"); stopModal.setAttribute("aria-hidden", "true"); }
$("#confirmStop").addEventListener("click", async () => {
  try { await callOBS("StopStream"); closeStopModal(); } catch (error) { showToast(error.message); }
});

$("#sceneGrid").addEventListener("click", async (event) => {
  const card = event.target.closest(".scene-card");
  if (!card) return;
  try { await callOBS("SetCurrentProgramScene", { sceneName: card.dataset.scene }); }
  catch (error) { showToast(error.message); }
});
$("#addScene").addEventListener("click", () => showToast("Create scenes inside OBS, then reconnect"));

$("#chatFilters").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  $$("#chatFilters button").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  $$(".comment").forEach((comment) => comment.classList.toggle("hidden", button.dataset.filter !== "all" && comment.dataset.platform !== button.dataset.filter));
});

$("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  showToast("Sending replies requires each platform's user OAuth permission");
});

document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "m" && document.activeElement.tagName !== "INPUT") $("#muteButton").click();
  if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); $("#recordButton").click(); }
  if (event.ctrlKey && event.key.toLowerCase() === "s") { event.preventDefault(); $("#streamButton").click(); }
  if (event.ctrlKey && ["1","2","3","4"].includes(event.key)) { event.preventDefault(); $$(".scene-card")[Number(event.key) - 1]?.click(); }
});

$("#obsAddress").value = localStorage.getItem("obsAddress") || "ws://127.0.0.1:4455";
$("#obsMicInput").value = localStorage.getItem("obsMicInput") || "Mic/Aux";
setConnectionState("disconnected");
if (location.protocol === "https:") {
  $("#connectionLabel").textContent = "Connect remote OBS";
  $("#connectionButton").title = "Pair the secure local OBS agent";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    if (response.status === 405) {
      throw new Error("Login API unavailable. Open this dashboard from the Node server on port 4173, not a static preview server.");
    }
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

async function callOBS(requestType, requestData = {}) {
  if (location.protocol !== "https:") return obs.call(requestType, requestData);
  const result = await api("/api/obs/commands", { method: "POST", body: JSON.stringify({ requestType, requestData }) });
  showToast("Command sent to remote OBS");
  return result;
}

async function refreshRemoteOBS() {
  if (location.protocol !== "https:" || !signedInUser) return;
  try {
    const { online, state } = await api("/api/obs/state");
    setConnectionState(online ? "connected" : "disconnected");
    $("#connectionLabel").textContent = online ? "Remote OBS online" : "Connect remote OBS";
    if (online) $$(".remote-step").forEach((step, index) => step.classList.toggle("active", index === 2));
    if (!online) return;
    if (state.error) {
      $(".signal-good").innerHTML = `<span style="background:#e6c341"></span> ${escapeHtml(state.error)}`;
    } else {
      $(".signal-good").innerHTML = `<span></span> Excellent`;
    }
    micInputName = state.micInput || micInputName;
    $("#micName").textContent = micInputName;
    updateStream(Boolean(state.streamActive), state.streamTimecode);
    updateRecord(Boolean(state.recordActive));
    updateMute(Boolean(state.micMuted));
    if (state.scenes?.length) renderScenes(state.scenes.map((sceneName) => ({ sceneName })), state.currentScene);
    if (state.cpuUsage != null) $(".stats-row div:nth-child(3) strong").textContent = Number(state.cpuUsage).toFixed(1);
  } catch (_) {}
}

$("#cancelRemoteObs").addEventListener("click", () => $("#remoteObsModal").classList.remove("open"));
$("#generatePairingCode").addEventListener("click", async () => {
  try {
    const { pairingCode } = await api("/api/obs/pairing-code", { method: "POST", body: "{}" });
    $("#agentCommand").textContent = `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Rnrezanur/Stream-Command-Center/main/agent.ps1))) -Server "${location.origin}" -Code "${pairingCode}"`;
    $("#copyAgentCommand").disabled = false;
    $$(".remote-step").forEach((step, index) => step.classList.toggle("active", index === 1));
    $("#generatePairingCode").textContent = "Generate new command";
    $("#remoteObsError").textContent = "Copy and run this command on the OBS computer within 10 minutes.";
  } catch (error) { $("#remoteObsError").textContent = error.message; }
});
$("#copyAgentCommand").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#agentCommand").textContent);
    $("#copyAgentCommand").textContent = "Copied";
    setTimeout(() => { $("#copyAgentCommand").textContent = "Copy"; }, 1800);
  } catch (_) { showToast("Select and copy the command manually"); }
});

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function setSignedInUser(user) {
  signedInUser = user;
  $("#accountInitials").textContent = user ? initials(user.name) : "?";
  $("#headerAccountLabel").textContent = user ? user.name : "Sign in";
  $("#headerAccountButton").classList.toggle("logged-out", !user);
  $(".online-dot").style.background = user ? "#5ae28c" : "#68717a";
  $("#authScreen").hidden = Boolean(user);
  $("#dashboardApp").hidden = !user;
}

async function loadCurrentUser() {
  try {
    const { user } = await api("/api/me");
    setSignedInUser(user);
    await refreshDashboard();
    await refreshRemoteOBS();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 15000);
    clearInterval(remoteObsTimer);
    remoteObsTimer = setInterval(refreshRemoteOBS, 3000);
  } catch (_) {
    setSignedInUser(null);
    renderDashboard({ platforms: {}, comments: [], totalViewers: 0 });
  }
}

async function authenticate({ registering, name, email, password }) {
  return api(registering ? "/api/register" : "/api/login", {
    method: "POST",
    body: JSON.stringify({ name, email, password })
  });
}

function renderDashboard(data) {
  $("#totalViewers").textContent = Number(data.totalViewers || 0).toLocaleString();
  for (const name of ["youtube", "twitch", "facebook"]) {
    const row = $(`.platform-row[data-platform="${name}"]`);
    const platform = data.platforms?.[name] || { connected: false, viewers: 0 };
    row.querySelector(".viewer-count strong").textContent = Number(platform.viewers || 0).toLocaleString();
    row.querySelector(".platform-name span").innerHTML = `<i style="background:${platform.connected ? "#62db8e" : "#68717a"}"></i> ${escapeHtml(platform.error || platform.status || (platform.connected ? "Connected - live API" : "Not connected"))}`;
  }
  const comments = data.comments || [];
  $("#commentCount").textContent = comments.length;
  $("#chatFeed").innerHTML = comments.length ? comments.map(renderComment).join("") : `<p class="empty-state">${signedInUser ? "No live comments yet. Open platform settings to connect your broadcasts." : "Sign in and connect platforms to load comments."}</p>`;
}

function renderComment(comment) {
  const platform = ["youtube", "twitch", "facebook"].includes(comment.platform) ? comment.platform : "youtube";
  const age = comment.time ? new Date(comment.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now";
  return `<article class="comment" data-platform="${platform}">
    <div class="comment-avatar ${platform === "youtube" ? "coral" : platform === "twitch" ? "violet" : "blue"}">${escapeHtml(initials(comment.author || "?"))}</div>
    <div><div class="comment-meta"><strong>${escapeHtml(comment.author || "Unknown")}</strong><span class="tag ${platform}-tag">${escapeHtml(platform)}</span><time>${escapeHtml(age)}</time></div><p>${escapeHtml(comment.message || "")}</p></div>
  </article>`;
}

async function refreshDashboard() {
  if (!signedInUser) return;
  try {
    renderDashboard(await api("/api/dashboard"));
  } catch (error) {
    showToast(error.message);
  }
}

const accountModal = $("#accountModal");
function openAccountModal() {
  accountModal.classList.add("open");
  const form = $(".account-modal");
  form.classList.toggle("authenticated", Boolean(signedInUser));
  form.classList.remove("registering");
  $("#accountTitle").textContent = signedInUser ? signedInUser.name : "Sign in";
  $("#accountError").textContent = signedInUser ? signedInUser.email : "";
}
$("#accountButton").addEventListener("click", openAccountModal);
$("#headerAccountButton").addEventListener("click", openAccountModal);
accountModal.addEventListener("click", (event) => { if (event.target === accountModal) accountModal.classList.remove("open"); });
$("#accountMode").addEventListener("click", () => {
  const form = $(".account-modal");
  const registering = !form.classList.contains("registering");
  form.classList.toggle("registering", registering);
  $("#accountTitle").textContent = registering ? "Create account" : "Sign in";
  $("#accountMode").textContent = registering ? "Use existing account" : "Create account";
  $("#accountForm button[type='submit']").textContent = registering ? "Create account" : "Sign in";
});
$("#accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const registering = $(".account-modal").classList.contains("registering");
  try {
    const result = await authenticate({
      registering,
      name: $("#accountName").value.trim(),
      email: $("#accountEmail").value.trim(),
      password: $("#accountPassword").value
    });
    setSignedInUser(result.user);
    accountModal.classList.remove("open");
    await refreshDashboard();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 15000);
    showToast(registering ? "Account created" : "Signed in");
  } catch (error) { $("#accountError").textContent = error.message; }
});
$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  clearInterval(dashboardTimer);
  clearInterval(remoteObsTimer);
  setSignedInUser(null);
  accountModal.classList.remove("open");
  renderDashboard({ platforms: {}, comments: [], totalViewers: 0 });
  showToast("Signed out");
});

let authPageRegistering = false;
$("#authPageMode").addEventListener("click", () => {
  authPageRegistering = !authPageRegistering;
  $("#authPageForm").classList.toggle("registering", authPageRegistering);
  $("#authPageTitle").textContent = authPageRegistering ? "Create your account" : "Welcome back";
  $("#authPageCopy").textContent = authPageRegistering ? "Create an account to save platform connections and settings." : "Sign in to open your command center.";
  $("#authPageSubmit").textContent = authPageRegistering ? "Create account" : "Sign in";
  $("#authPageMode").textContent = authPageRegistering ? "Already have an account? Sign in" : "New to Relay? Create an account";
  $("#authPagePassword").autocomplete = authPageRegistering ? "new-password" : "current-password";
  $("#authPageError").textContent = "";
});
$("#authPageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#authPageError").textContent = "";
  $("#authPageSubmit").disabled = true;
  try {
    const result = await authenticate({
      registering: authPageRegistering,
      name: $("#authPageName").value.trim(),
      email: $("#authPageEmail").value.trim(),
      password: $("#authPagePassword").value
    });
    setSignedInUser(result.user);
    await refreshDashboard();
    clearInterval(dashboardTimer);
    dashboardTimer = setInterval(refreshDashboard, 15000);
    clearInterval(remoteObsTimer);
    remoteObsTimer = setInterval(refreshRemoteOBS, 3000);
    showToast(authPageRegistering ? "Account created" : "Welcome back");
  } catch (error) {
    $("#authPageError").textContent = error.message;
  } finally {
    $("#authPageSubmit").disabled = false;
  }
});

const platformModal = $("#platformModal");
async function openPlatformSettings(platform = "youtube") {
  if (!signedInUser) return openAccountModal();
  $("#platformError").textContent = "";
  try {
    const { settings } = await api("/api/settings");
    $$("[name]", $("#platformForm")).forEach((input) => {
      const [group, field] = input.name.split(".");
      input.value = settings[group]?.[field] || "";
      const secretSaved = settings[group]?.[`${field}Saved`];
      if (!input.dataset.defaultPlaceholder) input.dataset.defaultPlaceholder = input.placeholder;
      input.placeholder = secretSaved ? "Saved securely - enter a new value to replace" : input.dataset.defaultPlaceholder;
      input.classList.toggle("secret-saved", Boolean(secretSaved));
    });
    selectSettingsTab(platform);
    platformModal.classList.add("open");
  } catch (error) { showToast(error.message); }
}
function selectSettingsTab(platform) {
  $$(".settings-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.settingsTab === platform));
  $$(".settings-section").forEach((section) => section.classList.toggle("active", section.dataset.settingsSection === platform));
}
$("#platformSettingsButton").addEventListener("click", () => openPlatformSettings());
$("#connectPlatformsButton").addEventListener("click", () => openPlatformSettings());
$$(".row-menu").forEach((button) => button.addEventListener("click", () => {
  const platform = button.closest(".platform-row").dataset.platform;
  openPlatformSettings(platform);
}));
$(".settings-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-settings-tab]");
  if (button) selectSettingsTab(button.dataset.settingsTab);
});
$("#cancelPlatformSettings").addEventListener("click", () => platformModal.classList.remove("open"));
platformModal.addEventListener("click", (event) => { if (event.target === platformModal) platformModal.classList.remove("open"); });
$("#platformForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = { youtube: {}, twitch: {}, facebook: {} };
  $$("[name]", event.currentTarget).forEach((input) => {
    const [group, field] = input.name.split(".");
    settings[group][field] = input.value.trim();
  });
  try {
    const { settings: savedSettings } = await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
    $$("[name]", event.currentTarget).forEach((input) => {
      const [group, field] = input.name.split(".");
      if (savedSettings[group]?.[`${field}Saved`]) {
        input.value = "";
        input.placeholder = "Saved securely - enter a new value to replace";
        input.classList.add("secret-saved");
      }
    });
    platformModal.classList.remove("open");
    await refreshDashboard();
    showToast("Platform settings saved");
  } catch (error) { $("#platformError").textContent = error.message; }
});

loadCurrentUser();
