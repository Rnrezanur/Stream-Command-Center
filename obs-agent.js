const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const AGENT_VERSION = "20260610-3";

const configPath = path.join(__dirname, "obs-agent.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
let config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const apiBase = (process.env.RELAYCAST_URL || config.apiBase || "").replace(/\/$/, "");
const pairingCode = process.env.RELAYCAST_PAIRING_CODE;
const obsAddress = process.env.OBS_ADDRESS || config.obsAddress || "ws://127.0.0.1:4455";
const obsPassword = process.env.OBS_PASSWORD || config.obsPassword || "";
const micInput = process.env.OBS_MIC_INPUT || config.micInput || "Mic/Aux";
let agentToken = process.env.RELAYCAST_AGENT_TOKEN || config.agentToken;

if (!apiBase) throw new Error("RELAYCAST_URL is required, for example https://relaycast.vercel.app");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (route, options = {}) => {
  const response = await fetch(`${apiBase}${route}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: agentToken ? `Bearer ${agentToken}` : "", ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `API ${response.status}`);
  return body;
};

class OBS {
  constructor() { this.socket = null; this.pending = new Map(); this.id = 0; }
  async connect() {
    this.socket = new WebSocket(obsAddress);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error(`Cannot reach OBS at ${obsAddress}`));
    });
    try {
      const hello = await this.next();
      const identify = { rpcVersion: 1, eventSubscriptions: 0 };
      if (hello.d.authentication) {
        if (!obsPassword) throw new Error("OBS WebSocket password is required");
        identify.authentication = await this.auth(hello.d.authentication);
      }
      this.socket.send(JSON.stringify({ op: 1, d: identify }));
      const identified = await this.next();
      if (identified.op !== 2) throw new Error("OBS authentication failed");
      this.socket.onmessage = (event) => this.handle(JSON.parse(event.data));
      this.socket.onclose = () => { this.socket = null; };
    } catch (error) {
      this.socket?.close();
      this.socket = null;
      if (/closed|authentication/i.test(error.message)) throw new Error("OBS rejected the connection. Check the WebSocket password in OBS > Tools > WebSocket Server Settings");
      throw error;
    }
  }
  next() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OBS handshake timed out")), 8000);
      this.socket.onmessage = (event) => { clearTimeout(timeout); resolve(JSON.parse(event.data)); };
      this.socket.onerror = () => { clearTimeout(timeout); reject(new Error("OBS WebSocket error")); };
      this.socket.onclose = () => { clearTimeout(timeout); reject(new Error("OBS connection closed")); };
    });
  }
  async sha(value) { return Buffer.from(await crypto.webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("base64"); }
  async auth(data) { return this.sha(`${await this.sha(obsPassword + data.salt)}${data.challenge}`); }
  call(requestType, requestData = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("OBS disconnected"));
    const requestId = String(++this.id);
    this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out`));
      }, 8000);
    });
  }
  handle(message) {
    if (message.op !== 7) return;
    const pending = this.pending.get(message.d.requestId);
    if (!pending) return;
    this.pending.delete(message.d.requestId);
    message.d.requestStatus.result ? pending.resolve(message.d.responseData || {}) : pending.reject(new Error(message.d.requestStatus.comment || "OBS command failed"));
  }
}

const obs = new OBS();
let connecting;
async function ensureOBS() {
  if (obs.socket?.readyState === WebSocket.OPEN) return;
  if (!connecting) connecting = obs.connect().finally(() => { connecting = null; });
  return connecting;
}

async function state() {
  const [scenes, stream, record, mute, stats] = await Promise.all([
    obs.call("GetSceneList"), obs.call("GetStreamStatus"), obs.call("GetRecordStatus"),
    obs.call("GetInputMute", { inputName: micInput }), obs.call("GetStats")
  ]);
  return {
    connected: true, agentVersion: AGENT_VERSION, currentScene: scenes.currentProgramSceneName, scenes: (scenes.scenes || []).map((scene) => scene.sceneName),
    streamActive: stream.outputActive, streamTimecode: stream.outputTimecode, recordActive: record.outputActive,
    micMuted: mute.inputMuted, micInput, cpuUsage: stats.cpuUsage, memoryUsage: stats.memoryUsage
  };
}

async function pair() {
  if (agentToken) {
    if (obsPassword && obsPassword !== config.obsPassword) {
      config = { ...config, apiBase, agentToken, obsAddress, obsPassword, micInput };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    return;
  }
  if (!pairingCode) throw new Error("Run with RELAYCAST_PAIRING_CODE from the dashboard");
  const result = await api("/api/agent/pair", { method: "POST", body: JSON.stringify({ pairingCode }) });
  agentToken = result.agentToken;
  config = { apiBase, agentToken, obsAddress, obsPassword, micInput };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("Agent paired successfully.");
}

async function commandLoop() {
  for (;;) {
    try {
      await ensureOBS();
      const payload = await api("/api/agent/poll", { method: "POST", body: "{}" });
      for (const command of payload.commands || []) {
        try {
          const result = await obs.call(command.request_type, command.request_data || {});
          await api(`/api/agent/commands/${command.id}`, { method: "POST", body: JSON.stringify({ result }) });
        } catch (error) {
          await api(`/api/agent/commands/${command.id}`, { method: "POST", body: JSON.stringify({ error: error.message }) });
        }
      }
    } catch (error) {
      console.error(`[agent command] ${error.message}`);
    }
    await sleep(1000);
  }
}

async function stateLoop() {
  for (;;) {
    let snapshot;
    try {
      await ensureOBS();
      snapshot = await state();
    } catch (error) {
      console.error(`[agent state] ${error.message}`);
      snapshot = { connected: Boolean(obs.socket?.readyState === WebSocket.OPEN), agentVersion: AGENT_VERSION, error: error.message, micInput };
    }
    try {
      await api("/api/agent/state", { method: "POST", body: JSON.stringify({ state: snapshot }) });
    } catch (error) {
      console.error(`[agent heartbeat] ${error.message}`);
    }
    await sleep(3000);
  }
}

async function run() {
  await pair();
  console.log(`RelayCast agent ${AGENT_VERSION} online. Remote commands are ready.`);
  await Promise.all([commandLoop(), stateLoop()]);
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
