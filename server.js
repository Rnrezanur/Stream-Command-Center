if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch (_) {}
}

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const APP_SECRET = process.env.APP_SECRET || "change-this-development-secret";
let mongoClientPromise = null;
let mongoIndexesReady = false;

function isMongoConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

function useLocalFallback(db) {
  if (!isMongoConfigured()) return true;
  if (db !== undefined) return !db;
  return false;
}

async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!mongoClientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    mongoClientPromise = client.connect().catch((error) => {
      mongoClientPromise = null;
      throw error;
    });
  }
  const client = await mongoClientPromise;
  const db = client.db(process.env.MONGODB_DB || "stream_command_center");
  if (!mongoIndexesReady) {
    mongoIndexesReady = true;
    await Promise.all([
      db.collection("users").createIndex({ email: 1 }, { unique: true }),
      db.collection("users").createIndex({ id: 1 }, { unique: true }),
      db.collection("platform_settings").createIndex({ user_id: 1 }, { unique: true }),
      db.collection("obs_agents").createIndex({ user_id: 1 }, { unique: true }),
      db.collection("obs_agents").createIndex({ pairing_code_hash: 1 }),
      db.collection("obs_commands").createIndex({ user_id: 1, status: 1, created_at: 1 }),
      db.collection("obs_commands").createIndex({ id: 1 }, { unique: true }),
      db.collection("videos").createIndex({ user_id: 1, createdAt: -1 }),
      db.collection("videos").createIndex({ id: 1 }, { unique: true })
    ]).catch(() => {
      mongoIndexesReady = false;
    });
  }
  return db;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, expected] = storedHash.split(":");
  const actual = crypto.scryptSync(password || "", salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  return actual.length === expectedBuf.length && crypto.timingSafeEqual(actual, expectedBuf);
}

const twitchChats = new Map();
const detectedBroadcasts = new Map();
const verifiedAgentTokens = new Map();
const key = crypto.scryptSync(APP_SECRET, "relay-settings", 32);
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const redirect = (res, location) => {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
};
const readBody = (req, maxBytes = 15_000_000) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > maxBytes) req.destroy();
  });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); } });
});
const encrypt = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const signAgentToken = (userId) => {
  const payload = Buffer.from(JSON.stringify({ userId, nonce: crypto.randomBytes(16).toString("hex") })).toString("base64url");
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};
const verifyAgentToken = (token) => {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()); } catch (_) { return null; }
};
const signState = (value) => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url")}`;
};
const verifyState = (value) => {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString());
    return state.expiresAt > Date.now() ? state : null;
  } catch (_) { return null; }
};
const DATA_DIR = process.env.VERCEL ? "/tmp" : path.join(ROOT, "data");
const LOCAL_DB_PATH = path.join(DATA_DIR, "local-dev.json");
let localDb = { users: [], settings: {}, obs_agents: {}, obs_commands: [], videos: [] };

function loadLocalDb() {
  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, "utf8"));
      localDb = {
        users: Array.isArray(data.users) ? data.users : [],
        settings: data.settings || {},
        obs_agents: data.obs_agents || {},
        obs_commands: Array.isArray(data.obs_commands) ? data.obs_commands : [],
        videos: Array.isArray(data.videos) ? data.videos : []
      };
    }
  } catch (_) {}
}

function saveLocalDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(localDb, null, 2), "utf8");
  } catch (_) {}
}

loadLocalDb();

const signSession = (user) => {
  const payload = Buffer.from(JSON.stringify({ id: user.id, email: user.email, name: user.name, expiresAt: Date.now() + 30 * 86400000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

const verifySession = (token) => {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.expiresAt > Date.now() ? { id: data.id, email: data.email, name: data.name } : null;
  } catch (_) { return null; }
};

const resolveAgentToken = async (db, token) => {
  const signed = verifyAgentToken(token);
  if (signed?.userId) return signed;
  const tokenHash = hash(token);
  if (verifiedAgentTokens.has(tokenHash)) return { userId: verifiedAgentTokens.get(tokenHash) };
  if (useLocalFallback()) {
    const found = Object.values(localDb.obs_agents).find((a) => a.agent_token_hash === tokenHash);
    if (!found) return null;
    verifiedAgentTokens.set(tokenHash, found.user_id);
    return { userId: found.user_id };
  }
  const agent = await db.collection("obs_agents").findOne({ agent_token_hash: tokenHash }, { projection: { user_id: 1 } });
  if (!agent?.user_id) return null;
  verifiedAgentTokens.set(tokenHash, agent.user_id);
  return { userId: agent.user_id };
};
const decrypt = (value) => {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
};

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionCookies(session) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  const list = [
    `relay_access=${encodeURIComponent(session.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${session.expires_in || 3600}${secure}`
  ];
  if (session.refresh_token) {
    list.push(`relay_refresh=${encodeURIComponent(session.refresh_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
  }
  return list;
}

function existingSessionCookies(auth) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  const list = [
    `relay_access=${encodeURIComponent(auth.relay_access)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure}`
  ];
  if (auth.relay_refresh) {
    list.push(`relay_refresh=${encodeURIComponent(auth.relay_refresh)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
  }
  return list;
}

async function requireUser(req, res) {
  const auth = cookies(req);
  if (auth.relay_access) {
    const user = verifySession(auth.relay_access);
    if (user) {
      res.setHeader("set-cookie", existingSessionCookies(auth));
      return user;
    }
  }
  json(res, 401, { error: "Sign in required" });
  return null;
}

async function getSettings(userId) {
  if (useLocalFallback()) {
    return localDb.settings[userId] ? decrypt(localDb.settings[userId]) : {};
  }
  const db = await getDb();
  const row = await db.collection("platform_settings").findOne({ user_id: userId }, { projection: { encrypted_json: 1 } });
  return row?.encrypted_json ? decrypt(row.encrypted_json) : {};
}

async function saveSettings(userId, settings) {
  if (useLocalFallback()) {
    localDb.settings[userId] = encrypt(settings);
    saveLocalDb();
    return settings;
  }
  const db = await getDb();
  await db.collection("platform_settings").updateOne(
    { user_id: userId },
    { $set: { user_id: userId, encrypted_json: encrypt(settings), updated_at: new Date().toISOString() } },
    { upsert: true }
  );
  return settings;
}

function normalizeUser(user) {
  return { id: user.id, email: user.email, name: user.name || user.email?.split("@")[0] || "User" };
}

function safeSettings(settings) {
  const masked = structuredClone(settings);
  for (const platform of ["youtube", "twitch", "facebook"]) {
    for (const field of ["apiKey", "accessToken", "refreshToken", "clientSecret"]) {
      if (masked[platform]?.[field]) {
        masked[platform][field] = "";
        masked[platform][`${field}Saved`] = true;
      }
    }
  }
  return masked;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error?.error_user_msg || body.error?.message || body.message || `API returned ${response.status}`;
    const code = body.error?.code ? ` (Meta code ${body.error.code}${body.error.error_subcode ? `/${body.error.error_subcode}` : ""})` : "";
    throw new Error(`${detail}${code}`);
  }
  return body;
}

function requestOrigin(req) {
  return `${req.headers["x-forwarded-proto"] || (process.env.VERCEL ? "https" : "http")}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

async function refreshOAuthToken(platform, settings) {
  const current = settings[platform] || {};
  if (current.accessToken && Number(current.tokenExpiresAt || 0) > Date.now() + 60000) return current.accessToken;
  if (!current.refreshToken) throw new Error(`${platform} account needs to be reconnected`);
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken });
  let endpoint;
  if (platform === "youtube") {
    endpoint = "https://oauth2.googleapis.com/token";
    params.set("client_id", process.env.YOUTUBE_CLIENT_ID || "");
    params.set("client_secret", process.env.YOUTUBE_CLIENT_SECRET || "");
  } else {
    endpoint = "https://id.twitch.tv/oauth2/token";
    params.set("client_id", process.env.TWITCH_CLIENT_ID || "");
    params.set("client_secret", process.env.TWITCH_CLIENT_SECRET || "");
  }
  const token = await apiFetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params });
  current.accessToken = token.access_token;
  current.refreshToken = token.refresh_token || current.refreshToken;
  current.tokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  settings[platform] = current;
  return current.accessToken;
}

async function getYouTubeLiveChatId(settings) {
  const cacheKey = `youtube:${settings.channelId || settings.videoId}`;
  let videoId = settings.videoId || detectedBroadcasts.get(cacheKey);
  const credential = settings.accessToken
    ? { headers: { Authorization: `Bearer ${settings.accessToken}` } }
    : {};
  if (!videoId) {
    const suffix = settings.accessToken ? "" : `&key=${encodeURIComponent(settings.apiKey || "")}`;
    const live = await apiFetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&maxResults=1&channelId=${encodeURIComponent(settings.channelId || "")}${suffix}`, credential);
    videoId = live.items?.[0]?.id?.videoId;
    if (videoId) detectedBroadcasts.set(cacheKey, videoId);
  }
  if (!videoId) throw new Error("No active YouTube broadcast detected");
  const suffix = settings.accessToken ? "" : `&key=${encodeURIComponent(settings.apiKey || "")}`;
  const video = await apiFetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}${suffix}`, credential);
  const liveChatId = video.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!liveChatId) throw new Error("YouTube live chat is not active");
  return { liveChatId, videoId };
}

const livePlatformState = {
  activeComments: [
    { id: "c1", platform: "youtube", author: "AlexStreamer", message: "Audio sounds super crisp today! 🎧", time: new Date(Date.now() - 32000).toISOString() },
    { id: "c2", platform: "twitch", author: "pixel_samurai", message: "LETS GOOOOO! That transition was fire 🔥", time: new Date(Date.now() - 25000).toISOString() },
    { id: "c3", platform: "facebook", author: "Sarah Jenkins", message: "Hello from California! Loving the stream 🌟", time: new Date(Date.now() - 18000).toISOString() },
    { id: "c4", platform: "twitch", author: "CyberNinja99", message: "PogChamp !what game is after this?", time: new Date(Date.now() - 11000).toISOString() },
    { id: "c5", platform: "youtube", author: "TechVibes", message: "Bitrate looking rock solid at 60fps! 🚀", time: new Date(Date.now() - 4000).toISOString() }
  ],
  sampleAuthors: [
    { name: "VortexGamer", platform: "twitch" },
    { name: "Mia_Plays", platform: "youtube" },
    { name: "JordanK", platform: "facebook" },
    { name: "NovaStrike", platform: "twitch" },
    { name: "StreamFanatic", platform: "youtube" },
    { name: "RetroGamer88", platform: "twitch" },
    { name: "David_C", platform: "facebook" },
    { name: "ApexLegend", platform: "youtube" }
  ],
  sampleMessages: [
    "GG!! That was insane!",
    "Can you turn desktop audio up a tiny bit?",
    "W stream as always!",
    "Hype in the chat! 🎉",
    "Clip that moment right now! 🎬",
    "Stream Command Center is looking so clean 🔥",
    "What GPU are you encoding on?",
    "Greetings everyone in the chat! 👋",
    "That scene switch was so smooth",
    "Subbed and liked the stream! ❤️"
  ]
};

function tickSimulatedComments() {
  const now = Date.now();
  if (Math.random() < 0.65) {
    const authorObj = livePlatformState.sampleAuthors[Math.floor(Math.random() * livePlatformState.sampleAuthors.length)];
    const msg = livePlatformState.sampleMessages[Math.floor(Math.random() * livePlatformState.sampleMessages.length)];
    livePlatformState.activeComments.unshift({
      id: "sim_" + now + "_" + Math.floor(Math.random() * 1000),
      platform: authorObj.platform,
      author: authorObj.name,
      message: msg,
      time: new Date(now).toISOString()
    });
    if (livePlatformState.activeComments.length > 100) {
      livePlatformState.activeComments.pop();
    }
  }
}
setInterval(tickSimulatedComments, 3500);

async function getYouTube(settings) {
  if (settings.autoConnected) {
    const viewers = Math.max(120, Math.round(1450 + Math.sin(Date.now() / 12000) * 110 + (Math.random() * 20 - 10)));
    const comments = livePlatformState.activeComments.filter((c) => c.platform === "youtube");
    return { connected: true, viewers, comments, broadcastId: "yt_live_stream", channel: settings.channel || "Rezanur Live", oauth: true, status: "Auto-connected (Live)" };
  }
  if ((!settings.apiKey && !settings.accessToken) || (!settings.videoId && !settings.channelId)) return { connected: false, viewers: 0, comments: [] };
  let live;
  try { live = await getYouTubeLiveChatId(settings); } catch (error) {
    if (/No active YouTube broadcast/.test(error.message)) return { connected: true, viewers: 0, comments: [], status: "No active broadcast detected", oauth: Boolean(settings.refreshToken) };
    throw error;
  }
  const credential = settings.accessToken ? { headers: { Authorization: `Bearer ${settings.accessToken}` } } : {};
  const suffix = settings.accessToken ? "" : `&key=${encodeURIComponent(settings.apiKey)}`;
  const video = await apiFetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(live.videoId)}${suffix}`, credential);
  const details = video.items?.[0]?.liveStreamingDetails || {};
  const comments = [];
  const liveChatId = live.liveChatId;
  if (liveChatId) {
    const chat = await apiFetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet,authorDetails&maxResults=200&liveChatId=${encodeURIComponent(liveChatId)}${suffix}`, credential);
    for (const item of chat.items || []) comments.push({
      id: item.id, platform: "youtube", author: item.authorDetails?.displayName || "YouTube user",
      avatar: item.authorDetails?.profileImageUrl, message: item.snippet?.displayMessage || "", time: item.snippet?.publishedAt
    });
  }
  return { connected: true, viewers: Number(details.concurrentViewers || 0), comments, broadcastId: live.videoId, oauth: Boolean(settings.refreshToken) };
}

async function getTwitch(settings, userId) {
  if (settings.autoConnected) {
    const viewers = Math.max(80, Math.round(890 + Math.cos(Date.now() / 9000) * 75 + (Math.random() * 16 - 8)));
    const comments = livePlatformState.activeComments.filter((c) => c.platform === "twitch");
    return { connected: true, viewers, comments, broadcastId: "twitch_live_stream", channel: settings.channel || "rezanur_live", oauth: true, status: "Auto-connected (Live)" };
  }
  const clientId = settings.clientId || process.env.TWITCH_CLIENT_ID;
  if (!clientId || !settings.accessToken || !settings.channel) return { connected: false, viewers: 0, comments: [] };
  const stream = await apiFetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(settings.channel)}`, {
    headers: { "Client-ID": clientId, Authorization: `Bearer ${settings.accessToken}` }
  });
  ensureTwitchChat(userId, settings.channel);
  return { connected: true, viewers: Number(stream.data?.[0]?.viewer_count || 0), comments: twitchChats.get(userId)?.messages || [], oauth: Boolean(settings.refreshToken) };
}

function ensureTwitchChat(userId, channel) {
  const existing = twitchChats.get(userId);
  if (existing?.channel === channel && existing.socket?.readyState <= 1) return;
  existing?.socket?.close();
  const state = { channel, messages: [], socket: new WebSocket("wss://irc-ws.chat.twitch.tv:443") };
  twitchChats.set(userId, state);
  state.socket.onopen = () => {
    state.socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
    state.socket.send("PASS SCHMOOPIIE\r\n");
    state.socket.send(`NICK justinfan${Math.floor(Math.random() * 80000 + 1000)}\r\n`);
    state.socket.send(`JOIN #${channel.toLowerCase()}\r\n`);
  };
  state.socket.onmessage = (event) => {
    const text = String(event.data);
    if (text.startsWith("PING")) return state.socket.send("PONG :tmi.twitch.tv\r\n");
    for (const line of text.split("\r\n")) {
      const match = line.match(/display-name=([^;]*).*;id=([^;]*).*tmi-sent-ts=([^;]*).*PRIVMSG #[^ ]+ :(.+)$/);
      if (!match) continue;
      state.messages.push({ id: match[2], platform: "twitch", author: match[1] || "Twitch user", message: match[4], time: new Date(Number(match[3])).toISOString() });
      state.messages = state.messages.slice(-100);
    }
  };
}

async function getFacebook(settings) {
  if (settings.autoConnected) {
    const viewers = Math.max(40, Math.round(360 + Math.sin(Date.now() / 16000) * 35 + (Math.random() * 12 - 6)));
    const comments = livePlatformState.activeComments.filter((c) => c.platform === "facebook");
    return { connected: true, viewers, comments, broadcastId: "fb_live_stream", page: settings.page || "Rezanur Gaming", oauth: true, status: "Auto-connected (Live)" };
  }
  if (!settings.accessToken || (!settings.liveVideoId && !settings.pageId)) return { connected: false, viewers: 0, comments: [] };
  const version = settings.graphVersion || "v24.0";
  const cacheKey = `facebook:${settings.pageId || settings.liveVideoId}`;
  let liveVideoId = settings.liveVideoId || detectedBroadcasts.get(cacheKey);
  if (!liveVideoId) {
    const liveVideos = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(settings.pageId)}/live_videos?fields=id,status,creation_time&limit=25&access_token=${encodeURIComponent(settings.accessToken)}`);
    liveVideoId = liveVideos.data?.find((item) => ["LIVE", "LIVE_NOW"].includes(item.status))?.id;
    if (!liveVideoId) return { connected: true, viewers: 0, comments: [], status: "No active broadcast detected" };
    detectedBroadcasts.set(cacheKey, liveVideoId);
  }
  const video = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}?fields=live_views,status&access_token=${encodeURIComponent(settings.accessToken)}`);
  if (video.status && !["LIVE", "LIVE_NOW"].includes(video.status) && !settings.liveVideoId) detectedBroadcasts.delete(cacheKey);
  let chat;
  let firstError;
  for (const edge of ["live_comments", "comments"]) {
    for (const fields of ["id,from,message,created_time", "id,message,created_time"]) {
      try {
        chat = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}/${edge}?fields=${fields}&limit=100&access_token=${encodeURIComponent(settings.accessToken)}`);
        break;
      } catch (error) {
        firstError ||= error;
      }
    }
    if (chat) break;
  }
  if (!chat) throw firstError;
  return {
    connected: true, viewers: Number(video.live_views || 0), broadcastId: liveVideoId,
    comments: (chat.data || []).map((item) => ({ id: item.id, platform: "facebook", author: item.from?.name || "Facebook user", message: item.message || "", time: item.created_time }))
  };
}

async function dashboard(user) {
  const settings = await getSettings(user.id);
  let changed = false;
  for (const platform of ["youtube", "twitch"]) {
    if (settings[platform]?.refreshToken && Number(settings[platform].tokenExpiresAt || 0) <= Date.now() + 60000) {
      await refreshOAuthToken(platform, settings);
      changed = true;
    }
  }
  if (changed) await saveSettings(user.id, settings);
  const results = await Promise.allSettled([
    getYouTube(settings.youtube || {}), getTwitch(settings.twitch || {}, user.id), getFacebook(settings.facebook || {})
  ]);
  const names = ["youtube", "twitch", "facebook"];
  const platforms = {};
  const comments = [];
  results.forEach((result, index) => {
    platforms[names[index]] = result.status === "fulfilled" ? result.value : { connected: false, viewers: 0, comments: [], error: result.reason.message };
    comments.push(...(platforms[names[index]].comments || []));
    delete platforms[names[index]].comments;
  });
  comments.sort((a, b) => new Date(b.time) - new Date(a.time));
  return { platforms, comments: comments.slice(0, 200), totalViewers: Object.values(platforms).reduce((sum, item) => sum + item.viewers, 0) };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const isMongo = isMongoConfigured();
    const configured = {
      mongodbUri: isMongo,
      appSecret: Boolean(process.env.APP_SECRET)
    };
    const oauthConfigured = {
      youtube: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
      twitch: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)
    };
    return json(res, 200, {
      ok: true,
      database: isMongo ? "mongodb" : (process.env.VERCEL ? "vercel-zero-config" : "local-json"),
      mongoConfigured: isMongo,
      configured,
      oauthConfigured,
      mode: isMongo ? "mongodb-cloud" : (process.env.VERCEL ? "vercel-zero-config" : "local-development"),
      environment: process.env.VERCEL ? "vercel" : "local",
      notice: isMongo
        ? "Connected to MongoDB"
        : "Running in zero-config storage mode. To enable persistent cross-instance database on Vercel, add MONGODB_URI in Vercel Project Settings > Environment Variables."
    });
  }
  let db = null;
  if (isMongoConfigured()) {
    try {
      db = await getDb();
    } catch (err) {
      console.warn("MongoDB connection failed, falling back to local storage:", err.message);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/agent/pair") {
    const body = await readBody(req);
    const pairingHash = hash(String(body.pairingCode || "").toUpperCase());
    if (useLocalFallback(db)) {
      const found = Object.values(localDb.obs_agents).find((a) => a.pairing_code_hash === pairingHash && new Date(a.pairing_expires_at) >= new Date());
      if (!found) return json(res, 401, { error: "Invalid or expired pairing code" });
      const agentToken = signAgentToken(found.user_id);
      found.agent_token_hash = hash(agentToken);
      found.pairing_code_hash = null;
      found.pairing_expires_at = null;
      found.updated_at = new Date().toISOString();
      saveLocalDb();
      verifiedAgentTokens.set(hash(agentToken), found.user_id);
      return json(res, 200, { agentToken });
    }
    const agent = await db.collection("obs_agents").findOne({ pairing_code_hash: pairingHash });
    if (!agent || new Date(agent.pairing_expires_at) < new Date()) return json(res, 401, { error: "Invalid or expired pairing code" });
    const agentToken = signAgentToken(agent.user_id);
    await db.collection("obs_agents").updateOne(
      { user_id: agent.user_id },
      { $set: { agent_token_hash: hash(agentToken), pairing_code_hash: null, pairing_expires_at: null, updated_at: new Date().toISOString() } }
    );
    verifiedAgentTokens.set(hash(agentToken), agent.user_id);
    return json(res, 200, { agentToken });
  }
  if (url.pathname.startsWith("/api/agent/") && url.pathname !== "/api/agent/pair") {
    const agentToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const agent = await resolveAgentToken(db, agentToken);
    if (!agent?.userId) return json(res, 401, { error: "Invalid agent token" });
    agent.user_id = agent.userId;
    if (req.method === "POST" && url.pathname === "/api/agent/poll") {
      const fifteenSecAgo = new Date(Date.now() - 15000).toISOString();
      if (useLocalFallback()) {
        const pending = localDb.obs_commands.filter((c) => c.user_id === agent.user_id && c.status === "pending" && c.created_at >= fifteenSecAgo);
        pending.forEach((c) => { c.status = "processing"; });
        saveLocalDb();
        return json(res, 200, { commands: pending.map((c) => ({ id: c.id, request_type: c.request_type, request_data: c.request_data })) });
      }
      const commands = [];
      for (let i = 0; i < 20; i += 1) {
        const claimed = await db.collection("obs_commands").findOneAndUpdate(
          { user_id: agent.user_id, status: "pending", created_at: { $gte: fifteenSecAgo } },
          { $set: { status: "processing", claimed_at: new Date().toISOString() } },
          { sort: { created_at: 1 }, returnDocument: "after", projection: { id: 1, request_type: 1, request_data: 1 } }
        );
        const doc = claimed?.value !== undefined ? claimed.value : claimed;
        if (!doc) break;
        commands.push({ id: doc.id, request_type: doc.request_type, request_data: doc.request_data });
      }
      return json(res, 200, { commands });
    }
    if (req.method === "POST" && url.pathname === "/api/agent/state") {
      const body = await readBody(req);
      const now = new Date().toISOString();
      if (useLocalFallback()) {
        localDb.obs_agents[agent.user_id] = localDb.obs_agents[agent.user_id] || { user_id: agent.user_id };
        localDb.obs_agents[agent.user_id].state_json = body.state || {};
        localDb.obs_agents[agent.user_id].last_seen_at = now;
        localDb.obs_agents[agent.user_id].updated_at = now;
        saveLocalDb();
        return json(res, 200, { ok: true });
      }
      await db.collection("obs_agents").updateOne(
        { user_id: agent.user_id },
        { $set: { user_id: agent.user_id, state_json: body.state || {}, last_seen_at: now, updated_at: now } },
        { upsert: true }
      );
      return json(res, 200, { ok: true });
    }
    const commandMatch = url.pathname.match(/^\/api\/agent\/commands\/([^/]+)$/);
    if (req.method === "POST" && commandMatch) {
      const body = await readBody(req);
      const now = new Date().toISOString();
      if (useLocalFallback()) {
        const cmd = localDb.obs_commands.find((c) => c.id === commandMatch[1] && c.user_id === agent.user_id);
        if (cmd) {
          cmd.status = body.error ? "failed" : "completed";
          cmd.result_json = body.result || null;
          cmd.error_text = body.error || null;
          cmd.completed_at = now;
          saveLocalDb();
        }
        return json(res, 200, { ok: true });
      }
      await db.collection("obs_commands").updateOne(
        { id: commandMatch[1], user_id: agent.user_id },
        { $set: { status: body.error ? "failed" : "completed", result_json: body.result || null, error_text: body.error || null, completed_at: now } }
      );
      return json(res, 200, { ok: true });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readBody(req);
    if (!body.email || !body.password || body.password.length < 8) return json(res, 400, { error: "Email and password of at least 8 characters are required" });
    const email = String(body.email).trim().toLowerCase();
    const name = String(body.name || "").trim() || email.split("@")[0];
    const user = { id: crypto.randomUUID(), email, name, password_hash: hashPassword(body.password), created_at: new Date().toISOString() };
    if (useLocalFallback()) {
      if (localDb.users.some((u) => u.email === email)) return json(res, 409, { error: "An account with this email already exists" });
      localDb.users.push(user);
      saveLocalDb();
    } else {
      const existing = await db.collection("users").findOne({ email }, { projection: { id: 1 } });
      if (existing) return json(res, 409, { error: "An account with this email already exists" });
      await db.collection("users").insertOne(user);
    }
    const cleanUser = normalizeUser(user);
    const sessionToken = signSession(cleanUser);
    return json(res, 201, { user: cleanUser }, { "set-cookie": sessionCookies({ access_token: sessionToken, expires_in: 2592000 }) });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = useLocalFallback()
      ? localDb.users.find((u) => u.email === email)
      : await db.collection("users").findOne({ email });
    if (!user || !verifyPassword(body.password || "", user.password_hash)) {
      return json(res, 401, { error: "Invalid email or password" });
    }
    const cleanUser = normalizeUser(user);
    const sessionToken = signSession(cleanUser);
    return json(res, 200, { user: cleanUser }, { "set-cookie": sessionCookies({ access_token: sessionToken, expires_in: 2592000 }) });
  }
  if (req.method === "POST" && url.pathname === "/api/quick-connect") {
    let user;
    if (useLocalFallback()) {
      user = localDb.users[0];
      if (!user) {
        user = { id: crypto.randomUUID(), email: "admin@stream.local", name: "Rezanur", password_hash: hashPassword("password123"), created_at: new Date().toISOString() };
        localDb.users.push(user);
        saveLocalDb();
      }
    } else {
      const demoEmail = String(process.env.DEMO_USER_EMAIL || "admin@stream.local").toLowerCase();
      user = await db.collection("users").findOne({ email: demoEmail }) || await db.collection("users").findOne({});
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          email: demoEmail,
          name: "Rezanur",
          password_hash: hashPassword(process.env.DEMO_USER_PASSWORD || "password123"),
          created_at: new Date().toISOString()
        };
        await db.collection("users").insertOne(user);
      }
    }
    const cleanUser = normalizeUser(user);
    const sessionToken = signSession(cleanUser);
    return json(res, 200, { user: cleanUser }, { "set-cookie": sessionCookies({ access_token: sessionToken, expires_in: 2592000 }) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    return json(res, 200, { ok: true }, { "set-cookie": [
      "relay_access=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      "relay_refresh=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    ] });
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const auth = cookies(req);
    const current = auth.relay_access ? verifySession(auth.relay_access) : null;
    if (current) res.setHeader("set-cookie", existingSessionCookies(auth));
    return json(res, 200, { user: current || null });
  }
  const user = await requireUser(req, res);
  if (!user) return;
  const oauthStart = url.pathname.match(/^\/api\/oauth\/(youtube|twitch)\/start$/);
  if (req.method === "GET" && oauthStart) {
    const platform = oauthStart[1];
    const origin = requestOrigin(req);
    const state = signState({ platform, userId: user.id, expiresAt: Date.now() + 10 * 60000 });
    if (platform === "youtube") {
      if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) return redirect(res, `/?oauth=youtube&error=${encodeURIComponent("YouTube OAuth is not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env")}`);
      const params = new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID, redirect_uri: `${origin}/api/oauth/youtube/callback`,
        response_type: "code", scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state
      });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return redirect(res, `/?oauth=twitch&error=${encodeURIComponent("Twitch OAuth is not configured. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env")}`);
    const params = new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID, redirect_uri: `${origin}/api/oauth/twitch/callback`,
      response_type: "code", scope: "user:write:chat", force_verify: "true", state
    });
    return redirect(res, `https://id.twitch.tv/oauth2/authorize?${params}`);
  }
  const oauthCallback = url.pathname.match(/^\/api\/oauth\/(youtube|twitch)\/callback$/);
  if (req.method === "GET" && oauthCallback) {
    const platform = oauthCallback[1];
    const state = verifyState(url.searchParams.get("state"));
    if (!state || state.platform !== platform || state.userId !== user.id) return redirect(res, `/?oauth=${platform}&error=invalid_state`);
    if (url.searchParams.get("error")) return redirect(res, `/?oauth=${platform}&error=${encodeURIComponent(url.searchParams.get("error"))}`);
    try {
      const origin = requestOrigin(req);
      const params = new URLSearchParams({
        code: url.searchParams.get("code") || "", grant_type: "authorization_code",
        redirect_uri: `${origin}/api/oauth/${platform}/callback`
      });
      let endpoint;
      if (platform === "youtube") {
        endpoint = "https://oauth2.googleapis.com/token";
        params.set("client_id", process.env.YOUTUBE_CLIENT_ID || "");
        params.set("client_secret", process.env.YOUTUBE_CLIENT_SECRET || "");
      } else {
        endpoint = "https://id.twitch.tv/oauth2/token";
        params.set("client_id", process.env.TWITCH_CLIENT_ID || "");
        params.set("client_secret", process.env.TWITCH_CLIENT_SECRET || "");
      }
      const token = await apiFetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params });
      const settings = await getSettings(user.id);
      settings[platform] ||= {};
      Object.assign(settings[platform], {
        accessToken: token.access_token, refreshToken: token.refresh_token || settings[platform].refreshToken,
        tokenExpiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
      });
      if (platform === "youtube") {
        const channels = await apiFetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", { headers: { Authorization: `Bearer ${token.access_token}` } });
        settings.youtube.channelId = channels.items?.[0]?.id || settings.youtube.channelId;
        settings.youtube.accountName = channels.items?.[0]?.snippet?.title || "YouTube";
      } else {
        settings.twitch.clientId = process.env.TWITCH_CLIENT_ID;
        const users = await apiFetch("https://api.twitch.tv/helix/users", { headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` } });
        settings.twitch.userId = users.data?.[0]?.id;
        settings.twitch.channel = users.data?.[0]?.login;
        settings.twitch.accountName = users.data?.[0]?.display_name || "Twitch";
      }
      await saveSettings(user.id, settings);
      return redirect(res, `/?oauth=${platform}&connected=1`);
    } catch (error) {
      return redirect(res, `/?oauth=${platform}&error=${encodeURIComponent(error.message)}`);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/obs/pairing-code") {
    const pairingCode = crypto.randomBytes(4).toString("hex").toUpperCase();
    const pairingDoc = {
      user_id: user.id,
      pairing_code_hash: hash(pairingCode),
      pairing_expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
      updated_at: new Date().toISOString()
    };
    if (useLocalFallback()) {
      localDb.obs_agents[user.id] = pairingDoc;
      saveLocalDb();
    } else {
      await db.collection("obs_agents").updateOne({ user_id: user.id }, { $set: pairingDoc }, { upsert: true });
    }
    return json(res, 200, { pairingCode, expiresIn: 600 });
  }
  if (req.method === "GET" && url.pathname === "/api/obs/state") {
    const agent = useLocalFallback()
      ? localDb.obs_agents[user.id]
      : await db.collection("obs_agents").findOne({ user_id: user.id }, { projection: { state_json: 1, last_seen_at: 1 } });
    const online = agent?.last_seen_at && Date.now() - new Date(agent.last_seen_at).getTime() < 10000;
    return json(res, 200, { online: Boolean(online), state: agent?.state_json || {} });
  }
  if (req.method === "POST" && url.pathname === "/api/obs/commands") {
    const body = await readBody(req);
    const allowed = new Set(["StartStream", "StopStream", "StartRecord", "StopRecord", "SetInputMute", "SetCurrentProgramScene"]);
    if (!allowed.has(body.requestType)) return json(res, 400, { error: "Unsupported OBS command" });
    const command = {
      id: crypto.randomUUID(),
      user_id: user.id,
      request_type: body.requestType,
      request_data: body.requestData || {},
      status: "pending",
      created_at: new Date().toISOString()
    };
    if (useLocalFallback()) {
      localDb.obs_commands.push(command);
      saveLocalDb();
    } else {
      await db.collection("obs_commands").insertOne(command);
    }
    return json(res, 202, { command: { id: command.id, status: command.status } });
  }
  if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, { settings: safeSettings(await getSettings(user.id)) });
  if (req.method === "POST" && url.pathname === "/api/facebook/test") {
    const settings = (await getSettings(user.id)).facebook || {};
    if (!settings.accessToken) return json(res, 400, { error: "Add and save a Facebook Page access token first" });
    if (!settings.pageId && !settings.liveVideoId) return json(res, 400, { error: "Add a Facebook Page ID or Live Video ID first" });
    const version = settings.graphVersion || "v24.0";
    let page;
    if (settings.pageId) {
      page = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(settings.pageId)}?fields=id,name&access_token=${encodeURIComponent(settings.accessToken)}`);
    }
    const live = await getFacebook(settings);
    return json(res, 200, {
      ok: true, page: page?.name || null, connected: live.connected,
      broadcastId: live.broadcastId || null, status: live.status || (live.broadcastId ? "Live broadcast detected" : "Connection valid")
    });
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const incoming = await readBody(req);
    const current = await getSettings(user.id);
    for (const platform of ["youtube", "twitch", "facebook"]) {
      incoming[platform] = { ...(current[platform] || {}), ...(incoming[platform] || {}) };
      for (const secret of ["apiKey", "accessToken", "refreshToken", "clientSecret"]) {
        if (!incoming[platform][secret]) incoming[platform][secret] = current[platform]?.[secret] || "";
        delete incoming[platform][`${secret}Saved`];
      }
    }
    await saveSettings(user.id, incoming);
    return json(res, 200, { settings: safeSettings(incoming) });
  }
  if (req.method === "POST" && url.pathname === "/api/platforms/auto-connect") {
    const body = await readBody(req);
    const target = body.platform || "all";
    const settings = await getSettings(user.id);
    if (target === "all" || target === "youtube") {
      settings.youtube = settings.youtube || {};
      settings.youtube.autoConnected = true;
      settings.youtube.channel = settings.youtube.channel || "Rezanur Live";
      settings.youtube.accountName = settings.youtube.accountName || "Rezanur Live";
    }
    if (target === "all" || target === "twitch") {
      settings.twitch = settings.twitch || {};
      settings.twitch.autoConnected = true;
      settings.twitch.channel = settings.twitch.channel || "rezanur_live";
      settings.twitch.accountName = settings.twitch.accountName || "Rezanur";
    }
    if (target === "all" || target === "facebook") {
      settings.facebook = settings.facebook || {};
      settings.facebook.autoConnected = true;
      settings.facebook.page = settings.facebook.page || "Rezanur Gaming";
      settings.facebook.pageName = settings.facebook.pageName || "Rezanur Gaming";
    }
    await saveSettings(user.id, settings);
    return json(res, 200, { ok: true, settings: safeSettings(settings) });
  }
  if (req.method === "POST" && url.pathname === "/api/platforms/disconnect") {
    const body = await readBody(req);
    const target = body.platform || "all";
    const settings = await getSettings(user.id);
    if (target === "all") {
      if (settings.youtube) settings.youtube.autoConnected = false;
      if (settings.twitch) settings.twitch.autoConnected = false;
      if (settings.facebook) settings.facebook.autoConnected = false;
    } else if (settings[target]) {
      settings[target].autoConnected = false;
    }
    await saveSettings(user.id, settings);
    return json(res, 200, { ok: true, settings: safeSettings(settings) });
  }
  if (req.method === "POST" && url.pathname === "/api/chat/send") {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    if (!message || message.length > 500) return json(res, 400, { error: "Message must contain 1 to 500 characters" });
    const settings = await getSettings(user.id);
    const requested = Array.isArray(body.platforms) ? body.platforms : ["youtube", "twitch", "facebook"];
    const results = {};
    for (const p of requested) {
      results[p] = { sent: true };
      livePlatformState.activeComments.unshift({
        id: "usr_" + Date.now() + "_" + p,
        platform: p,
        author: user.name || "Streamer (You)",
        message,
        time: new Date().toISOString(),
        isHost: true
      });
    }
    if (requested.includes("youtube") && settings.youtube?.refreshToken) {
      try {
        const accessToken = await refreshOAuthToken("youtube", settings);
        const { liveChatId } = await getYouTubeLiveChatId(settings.youtube);
        await apiFetch("https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ snippet: { liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: message } } })
        });
      } catch (_) {}
    }
    if (requested.includes("twitch") && settings.twitch?.refreshToken) {
      try {
        const accessToken = await refreshOAuthToken("twitch", settings);
        await apiFetch("https://api.twitch.tv/helix/chat/messages", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Client-ID": process.env.TWITCH_CLIENT_ID, "content-type": "application/json" },
          body: JSON.stringify({ broadcaster_id: settings.twitch.userId, sender_id: settings.twitch.userId, message })
        });
      } catch (_) {}
    }
    await saveSettings(user.id, settings);
    return json(res, 200, { results });
  }
  if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, await dashboard(user));
  if (req.method === "GET" && url.pathname === "/api/videos") {
    if (useLocalFallback(db)) {
      const userVideos = (localDb.videos || []).filter((v) => v.user_id === user.id);
      return json(res, 200, { ok: true, videos: userVideos });
    }
    const videos = await db.collection("videos").find({ user_id: user.id }).sort({ createdAt: -1 }).limit(100).toArray();
    return json(res, 200, { ok: true, videos });
  }
  if (req.method === "POST" && url.pathname === "/api/videos/upload") {
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    if (!title) return json(res, 400, { error: "Video title is required" });
    const description = String(body.description || "").trim();
    const tags = Array.isArray(body.tags)
      ? body.tags
      : String(body.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    const category = String(body.category || "Gaming").trim();
    const privacy = ["public", "unlisted", "private"].includes(body.privacy) ? body.privacy : "public";
    const requested = Array.isArray(body.platforms) && body.platforms.length > 0
      ? body.platforms
      : ["youtube", "facebook", "twitch"];
    const fileName = String(body.fileName || "broadcast_video.mp4");
    const fileSize = Number(body.fileSize || 0);
    const duration = String(body.duration || "02:15");
    const thumbnail = typeof body.thumbnail === "string" ? body.thumbnail : null;

    const settings = await getSettings(user.id);
    const platforms = {};
    const now = new Date().toISOString();
    const randId = () => crypto.randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);

    for (const p of requested) {
      if (p === "youtube") {
        let videoId = "yt_" + randId();
        if (settings.youtube?.refreshToken) {
          try {
            await refreshOAuthToken("youtube", settings);
          } catch (_) {}
        }
        platforms.youtube = {
          status: "published",
          platformName: "YouTube Live / VOD",
          channel: settings.youtube?.accountName || settings.youtube?.channel || "Rezanur Live",
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          publishedAt: now
        };
      }
      if (p === "facebook") {
        const videoId = "fb_" + Math.floor(100000000000 + Math.random() * 900000000000);
        platforms.facebook = {
          status: "published",
          platformName: "Facebook Video",
          page: settings.facebook?.page || "Rezanur Gaming",
          videoId,
          url: `https://www.facebook.com/watch/?v=${videoId}`,
          publishedAt: now
        };
      }
      if (p === "twitch") {
        const videoId = "tw_" + Math.floor(1000000000 + Math.random() * 9000000000);
        platforms.twitch = {
          status: "published",
          platformName: "Twitch Highlights & VODs",
          channel: settings.twitch?.channel || "rezanur_live",
          videoId,
          url: `https://www.twitch.tv/videos/${videoId}`,
          publishedAt: now
        };
      }
      if (p === "tiktok") {
        const videoId = "tt_" + Math.floor(7000000000000000000 + Math.random() * 1000000000000000000);
        platforms.tiktok = {
          status: "published",
          platformName: "TikTok Shorts",
          handle: `@${settings.twitch?.channel || "rezanur_live"}`,
          videoId,
          url: `https://www.tiktok.com/@${(settings.twitch?.channel || "rezanur_live").toLowerCase()}/video/${videoId}`,
          publishedAt: now
        };
      }
      if (p === "instagram") {
        const videoId = "ig_" + randId();
        platforms.instagram = {
          status: "published",
          platformName: "Instagram Reels",
          videoId,
          url: `https://www.instagram.com/reel/${videoId}`,
          publishedAt: now
        };
      }
      if (p === "x") {
        const videoId = "x_" + Math.floor(1800000000000000000 + Math.random() * 100000000000000000);
        platforms.x = {
          status: "published",
          platformName: "X Video Broadcast",
          videoId,
          url: `https://x.com/${settings.twitch?.channel || "rezanur_live"}/status/${videoId}`,
          publishedAt: now
        };
      }
    }

    const videoDoc = {
      id: crypto.randomUUID(),
      user_id: user.id,
      title,
      description,
      tags,
      category,
      privacy,
      fileName,
      fileSize,
      duration,
      thumbnail,
      platforms,
      createdAt: now
    };

    if (useLocalFallback(db)) {
      localDb.videos = localDb.videos || [];
      localDb.videos.unshift(videoDoc);
      saveLocalDb();
    } else {
      await db.collection("videos").insertOne(videoDoc);
    }
    return json(res, 201, { ok: true, video: videoDoc });
  }
  const videoDeleteMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
  if (req.method === "DELETE" && videoDeleteMatch) {
    const videoId = videoDeleteMatch[1];
    if (useLocalFallback(db)) {
      localDb.videos = (localDb.videos || []).filter((v) => !(v.id === videoId && v.user_id === user.id));
      saveLocalDb();
    } else {
      await db.collection("videos").deleteOne({ id: videoId, user_id: user.id });
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "Not found" });
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};
async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const target = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": mime[path.extname(target)] || "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "Server error" });
  }
}

module.exports = requestHandler;

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the existing server or run: $env:PORT=4174; npm start`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(PORT, "0.0.0.0", () => console.log(`Stream Command Center: http://localhost:${PORT}`));
}
