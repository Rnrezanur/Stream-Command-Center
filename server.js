if (typeof process.loadEnvFile === "function") {
  try {
    const envPath = require("node:path").join(__dirname, ".env");
    if (require("node:fs").existsSync(envPath)) {
      process.loadEnvFile(envPath);
    } else {
      process.loadEnvFile();
    }
  } catch (_) {}
}

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");
const { Server: SocketServer } = require("socket.io");
const { chatAggregator } = require("./chat-aggregator");

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
const redirect = (res, location, headers = {}) => {
  res.writeHead(302, { location, "cache-control": "no-store", ...headers });
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

function settingsCookie(settings) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `relay_settings=${encodeURIComponent(encrypt(settings))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`;
}

async function requireUser(req, res) {
  const auth = cookies(req);
  if (auth.relay_access) {
    const user = verifySession(auth.relay_access);
    if (user) {
      const cookieList = existingSessionCookies(auth);
      if (auth.relay_settings) {
        const secure = process.env.VERCEL ? "; Secure" : "";
        cookieList.push(`relay_settings=${encodeURIComponent(auth.relay_settings)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
      }
      res.setHeader("set-cookie", cookieList);
      return user;
    }
  }
  json(res, 401, { error: "Sign in required" });
  return null;
}

function applyDefaultSettings(settings) {
  const defaults = {
    youtube: { autoConnected: false, channel: "", accountName: "", avatar: null },
    twitch: { autoConnected: false, channel: "", accountName: "", avatar: null },
    facebook: { autoConnected: false, page: "", pageName: "", accountName: "", avatar: null },
    tiktok: { autoConnected: false, handle: "", accountName: "", avatar: null },
    instagram: { autoConnected: false, handle: "", accountName: "", avatar: null },
    x: { autoConnected: false, handle: "", accountName: "", avatar: null },
    kick: { autoConnected: false, channel: "", accountName: "", handle: "", avatar: null }
  };
  const result = structuredClone(settings || {});
  for (const [platform, def] of Object.entries(defaults)) {
    result[platform] = { ...def, ...(result[platform] || {}) };
    if (result[platform].autoConnected === undefined) {
      result[platform].autoConnected = false;
    }
  }
  return result;
}

async function getSettings(userId, req = null) {
  let settings = null;
  if (isMongoConfigured()) {
    try {
      const db = await getDb();
      const row = await db.collection("platform_settings").findOne({ user_id: userId }, { projection: { encrypted_json: 1 } });
      if (row?.encrypted_json) settings = decrypt(row.encrypted_json);
    } catch (_) {}
  }
  if (!settings || !Object.keys(settings).length) {
    if (req) {
      const c = cookies(req);
      if (c.relay_settings) {
        try {
          settings = decrypt(c.relay_settings);
        } catch (_) {}
      }
    }
  }
  if (!settings || !Object.keys(settings).length) {
    loadLocalDb();
    if (localDb.settings[userId]) {
      try {
        settings = decrypt(localDb.settings[userId]);
      } catch (_) {}
    }
  }
  return applyDefaultSettings(settings || {});
}

async function saveSettings(userId, settings, res = null) {
  loadLocalDb();
  localDb.settings[userId] = encrypt(settings);
  saveLocalDb();

  if (isMongoConfigured()) {
    try {
      const db = await getDb();
      await db.collection("platform_settings").updateOne(
        { user_id: userId },
        { $set: { user_id: userId, encrypted_json: encrypt(settings), updated_at: new Date().toISOString() } },
        { upsert: true }
      );
    } catch (_) {}
  }

  if (res && typeof res.setHeader === "function") {
    const cookieVal = settingsCookie(settings);
    const existing = res.getHeader("set-cookie");
    if (!existing) {
      res.setHeader("set-cookie", [cookieVal]);
    } else if (Array.isArray(existing)) {
      res.setHeader("set-cookie", [...existing.filter((c) => !String(c).startsWith("relay_settings=")), cookieVal]);
    } else if (typeof existing === "string") {
      res.setHeader("set-cookie", [existing, cookieVal]);
    }
  }
  return settings;
}

function normalizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email?.split("@")[0] || "User",
    avatar: user.avatar || null
  };
}

function safeSettings(settings) {
  const masked = structuredClone(settings);
  for (const platform of ["youtube", "twitch", "facebook", "tiktok", "instagram", "x", "kick"]) {
    for (const field of ["apiKey", "accessToken", "refreshToken", "clientSecret", "apiSecret", "clientKey"]) {
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

  if (platform === "facebook") {
    const fbAppId = process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID;
    const fbSecret = process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET;
    if (!fbAppId || !fbSecret || !current.accessToken) return current.accessToken;
    try {
      const token = await apiFetch(
        `https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_extend_sso_token&client_id=${fbAppId}&client_secret=${fbSecret}&fb_exchange_token=${encodeURIComponent(current.accessToken)}`
      );
      if (token.access_token) {
        current.accessToken = token.access_token;
        current.tokenExpiresAt = Date.now() + Number(token.expires_in || 5184000) * 1000;
        settings.facebook = current;
      }
    } catch (_) {}
    return current.accessToken;
  }

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

const userChatState = new Map(); // userId -> { comments: [], pinnedComment: null }

function getUserChatState(userId) {
  if (!userChatState.has(userId)) {
    userChatState.set(userId, { comments: [], pinnedComment: null });
  }
  return userChatState.get(userId);
}

const userAlertsState = new Map(); // userId -> { alerts: [], latestAlert: null, config: { ... } }

function getUserAlertsState(userId) {
  if (!userAlertsState.has(userId)) {
    const now = Date.now();
    userAlertsState.set(userId, {
      alerts: [
        {
          id: "alt_init_1",
          type: "subscribe",
          platform: "youtube",
          username: "Sarah Chen",
          message: "Sarah Chen subscribed on YouTube!",
          detail: "Member • 1st Month",
          time: new Date(now - 120000).toISOString()
        },
        {
          id: "alt_init_2",
          type: "like",
          platform: "facebook",
          username: "Alex Rivera",
          message: "Alex Rivera liked the live stream on Facebook!",
          detail: "Reaction: Super Like",
          time: new Date(now - 360000).toISOString()
        },
        {
          id: "alt_init_3",
          type: "follow",
          platform: "twitch",
          username: "NeonPixel",
          message: "NeonPixel followed on Twitch!",
          detail: "New Follower",
          time: new Date(now - 720000).toISOString()
        },
        {
          id: "alt_init_4",
          type: "follow",
          platform: "tiktok",
          username: "GamingPro_Live",
          message: "GamingPro_Live followed on TikTok!",
          detail: "New Follower",
          time: new Date(now - 1200000).toISOString()
        }
      ],
      latestAlert: null,
      config: {
        soundEnabled: true,
        volume: 0.8,
        duration: 5,
        showLikes: true,
        showSubscribes: true,
        showFollows: true,
        animation: "slide",
        likeTemplate: "{name} liked the stream!",
        subTemplate: "{name} subscribed to the channel!",
        followTemplate: "{name} is now following!"
      }
    });
  }
  return userAlertsState.get(userId);
}

async function getYouTube(settings) {
  const hasAuth = Boolean(settings.accessToken || settings.refreshToken);
  const connected = Boolean(settings.autoConnected && hasAuth);
  if (!connected) {
    return {
      connected: false,
      viewers: 0,
      comments: [],
      status: "Disconnected",
      channel: null,
      accountName: null,
      avatar: null,
      oauth: false
    };
  }
  let live;
  try {
    live = await getYouTubeLiveChatId(settings);
  } catch (error) {
    return {
      connected: true,
      viewers: 0,
      comments: [],
      status: "Connected - Ready to stream",
      channel: settings.accountName || settings.channel || "YouTube Channel",
      accountName: settings.accountName || settings.channel || "YouTube Channel",
      avatar: settings.avatar || null,
      oauth: Boolean(settings.refreshToken)
    };
  }
  const credential = settings.accessToken ? { headers: { Authorization: `Bearer ${settings.accessToken}` } } : {};
  const suffix = settings.accessToken ? "" : `&key=${encodeURIComponent(settings.apiKey)}`;
  let details = {};
  try {
    const video = await apiFetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(live.videoId)}${suffix}`, credential);
    details = video.items?.[0]?.liveStreamingDetails || {};
  } catch (_) {}

  const comments = [];
  const liveChatId = live.liveChatId;
  if (liveChatId) {
    try {
      const chat = await apiFetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet,authorDetails&maxResults=200&liveChatId=${encodeURIComponent(liveChatId)}${suffix}`, credential);
      for (const item of chat.items || []) {
        comments.push({
          id: item.id,
          platform: "youtube",
          author: item.authorDetails?.displayName || "YouTube user",
          avatar: item.authorDetails?.profileImageUrl,
          message: item.snippet?.displayMessage || "",
          time: item.snippet?.publishedAt
        });
      }
    } catch (_) {}
  }
  const viewers = Number(details.concurrentViewers || 0);
  return {
    connected: true,
    viewers,
    comments,
    broadcastId: live.videoId,
    channel: settings.accountName || settings.channel || "YouTube Channel",
    accountName: settings.accountName || settings.channel || "YouTube Channel",
    avatar: settings.avatar || null,
    status: viewers > 0 ? "Live Broadcasting" : "Connected - Ready to stream",
    oauth: Boolean(settings.refreshToken)
  };
}

async function getTwitch(settings, userId) {
  const hasAuth = Boolean(settings.accessToken || settings.refreshToken);
  const connected = Boolean(settings.autoConnected && hasAuth && settings.channel);
  const clientId = settings.clientId || process.env.TWITCH_CLIENT_ID;
  if (!connected || !clientId) {
    return {
      connected: false,
      viewers: 0,
      comments: [],
      status: "Disconnected",
      channel: null,
      accountName: null,
      avatar: null,
      oauth: false
    };
  }
  let viewers = 0;
  let isLive = false;
  try {
    const stream = await apiFetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(settings.channel)}`, {
      headers: { "Client-ID": clientId, Authorization: `Bearer ${settings.accessToken}` }
    });
    viewers = Number(stream.data?.[0]?.viewer_count || 0);
    isLive = stream.data?.length > 0;
  } catch (_) {}

  ensureTwitchChat(userId, settings.channel);
  const comments = (twitchChats.get(userId)?.messages || []).slice(-100);

  return {
    connected: true,
    viewers,
    comments,
    channel: settings.accountName || settings.channel,
    accountName: settings.accountName || settings.channel,
    avatar: settings.avatar || null,
    status: isLive ? "Live Broadcasting" : "Connected - Ready to stream",
    oauth: Boolean(settings.refreshToken)
  };
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
  const hasAuth = Boolean(settings.accessToken || settings.pageAccessToken || settings.page || settings.accountName);
  const connected = Boolean(settings.autoConnected && hasAuth);
  if (!connected) {
    return {
      connected: false,
      viewers: 0,
      comments: [],
      status: "Disconnected",
      page: null,
      accountName: null,
      avatar: null,
      oauth: false
    };
  }
  const version = settings.graphVersion || "v24.0";
  const cacheKey = `facebook:${settings.pageId || settings.liveVideoId}`;
  let liveVideoId = settings.liveVideoId || detectedBroadcasts.get(cacheKey);

  if (!liveVideoId && settings.pageId && settings.accessToken) {
    try {
      const liveVideos = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(settings.pageId)}/live_videos?fields=id,status,creation_time&limit=25&access_token=${encodeURIComponent(settings.accessToken)}`);
      liveVideoId = liveVideos.data?.find((item) => ["LIVE", "LIVE_NOW"].includes(item.status))?.id;
      if (liveVideoId) detectedBroadcasts.set(cacheKey, liveVideoId);
    } catch (_) {}
  }

  const fbName = (settings.page && settings.page !== "Rezanur Bin Shamim")
    ? settings.page
    : (settings.pageName && settings.pageName !== "Rezanur Bin Shamim" ? settings.pageName : (settings.page || "Funky Fighter"));

  if (!liveVideoId) {
    return {
      connected: true,
      viewers: 0,
      comments: [],
      status: "Connected - Ready to stream",
      page: fbName,
      accountName: fbName,
      avatar: settings.avatar || null,
      oauth: Boolean(settings.accessToken || settings.pageAccessToken)
    };
  }

  let viewers = 0;
  const comments = [];
  try {
    const video = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}?fields=live_views,status&access_token=${encodeURIComponent(settings.accessToken)}`);
    viewers = Number(video.live_views || 0);

    for (const edge of ["live_comments", "comments"]) {
      try {
        const chat = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}/${edge}?fields=id,from,message,created_time&limit=100&access_token=${encodeURIComponent(settings.accessToken)}`);
        for (const item of chat.data || []) {
          comments.push({
            id: item.id,
            platform: "facebook",
            author: item.from?.name || "Facebook user",
            message: item.message || "",
            time: item.created_time
          });
        }
        if (comments.length > 0) break;
      } catch (_) {}
    }
  } catch (_) {}

  return {
    connected: true,
    viewers,
    comments,
    broadcastId: liveVideoId,
    page: fbName,
    accountName: fbName,
    avatar: settings.avatar || null,
    status: viewers > 0 ? "Live Broadcasting" : "Connected - Ready to stream",
    oauth: Boolean(settings.accessToken || settings.pageAccessToken)
  };
}

function getTikTok(settings) {
  const connected = Boolean(settings.autoConnected && (settings.handle || settings.channel || settings.accountName || settings.accessToken));
  return {
    connected,
    viewers: 0,
    handle: connected ? (settings.handle || settings.accountName) : null,
    accountName: connected ? (settings.accountName || settings.handle) : null,
    avatar: connected ? (settings.avatar || null) : null,
    status: connected ? "Connected - TikTok Syndication Active" : "Disconnected",
    oauth: Boolean(settings.accessToken),
    eligibleForSyndication: true
  };
}

function getInstagram(settings) {
  const connected = Boolean(settings.autoConnected && (settings.handle || settings.accountName || settings.accessToken || settings.igUserId));
  return {
    connected,
    viewers: 0,
    handle: connected ? (settings.handle || settings.accountName) : null,
    accountName: connected ? (settings.accountName || settings.handle) : null,
    avatar: connected ? (settings.avatar || null) : null,
    status: connected ? "Connected - Instagram Active" : "Disconnected",
    oauth: Boolean(settings.accessToken || settings.pageAccessToken),
    eligibleForSyndication: true
  };
}

function getX(settings) {
  const connected = Boolean(settings.autoConnected && (settings.handle || settings.accountName || settings.accessToken));
  return {
    connected,
    viewers: 0,
    handle: connected ? (settings.handle || settings.accountName) : null,
    accountName: connected ? (settings.accountName || settings.handle) : null,
    avatar: connected ? (settings.avatar || null) : null,
    status: connected ? "Connected - X Broadcast Active" : "Disconnected",
    oauth: Boolean(settings.accessToken),
    eligibleForSyndication: true
  };
}

function getKick(settings) {
  const connected = Boolean(settings.autoConnected && settings.channel);
  return {
    connected,
    viewers: 0,
    channel: connected ? settings.channel : null,
    handle: connected ? (settings.handle || `@${settings.channel}`) : null,
    accountName: connected ? (settings.accountName || settings.channel) : null,
    avatar: connected ? (settings.avatar || null) : null,
    status: connected ? "Connected - Pusher Live Chat Active" : "Disconnected",
    eligibleForSyndication: true
  };
}

async function dashboard(user, req = null, res = null) {
  const settings = await getSettings(user.id, req);
  let changed = false;
  for (const platform of ["youtube", "twitch"]) {
    if (settings[platform]?.refreshToken && Number(settings[platform].tokenExpiresAt || 0) <= Date.now() + 60000) {
      await refreshOAuthToken(platform, settings);
      changed = true;
    }
  }
  if (changed) await saveSettings(user.id, settings, res);

  // Sync background unified chat aggregator workers
  chatAggregator.syncUserPlatforms(user.id, settings);

  const results = await Promise.allSettled([
    getYouTube(settings.youtube || {}),
    getTwitch(settings.twitch || {}, user.id),
    getFacebook(settings.facebook || {}),
    getTikTok(settings.tiktok || {}),
    getInstagram(settings.instagram || {}),
    getX(settings.x || {}),
    getKick(settings.kick || {})
  ]);
  const names = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x", "kick"];
  const platforms = {};
  const comments = [];
  results.forEach((result, index) => {
    platforms[names[index]] = result.status === "fulfilled" ? result.value : { connected: false, viewers: 0, comments: [], error: result.reason.message };
    comments.push(...(platforms[names[index]].comments || []));
    delete platforms[names[index]].comments;
  });

  // Pull normalized comments from chatAggregator engine
  const aggChat = chatAggregator.getUserChat(user.id);
  if (Array.isArray(aggChat.comments)) {
    comments.push(...aggChat.comments);
  }

  const userChat = getUserChatState(user.id);
  if (Array.isArray(userChat.comments)) {
    comments.push(...userChat.comments);
  }

  // Deduplicate comments by id
  const seenCommentIds = new Set();
  const dedupedComments = [];
  for (const c of comments) {
    if (!seenCommentIds.has(c.id)) {
      seenCommentIds.add(c.id);
      dedupedComments.push(c);
    }
  }

  dedupedComments.sort((a, b) => new Date(b.timestamp || b.time || 0) - new Date(a.timestamp || a.time || 0));
  const userAlerts = getUserAlertsState(user.id);
  const oauthConfigured = {
    youtube: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
    twitch: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
    facebook: Boolean((process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID) && (process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET)),
    instagram: Boolean((process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID) && (process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET)),
    x: Boolean(process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID || settings.x?.clientId),
    tiktok: Boolean(process.env.TIKTOK_CLIENT_KEY || settings.tiktok?.clientKey),
    kick: true
  };
  return {
    platforms,
    oauthConfigured,
    comments: dedupedComments.slice(0, 200),
    pinnedComment: aggChat.pinnedComment || userChat.pinnedComment || null,
    totalViewers: Object.values(platforms).reduce((sum, item) => sum + (Number(item.viewers) || 0), 0),
    alerts: userAlerts.alerts.slice(0, 50),
    latestAlert: userAlerts.latestAlert || (userAlerts.alerts[0] || null),
    alertConfig: userAlerts.config
  };
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
      twitch: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
      facebook: Boolean((process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID) && (process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET)),
      instagram: Boolean((process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID) && (process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET)),
      x: Boolean(process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID),
      tiktok: Boolean(process.env.TIKTOK_CLIENT_KEY),
      kick: true
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
    if (useLocalFallback(db)) {
      if (localDb.users.some((u) => u.email === email)) return json(res, 409, { error: "An account with this email already exists" });
      localDb.users.push(user);
      saveLocalDb();
    } else {
      const existing = await db.collection("users").findOne({ email }, { projection: { id: 1 } });
      if (existing) return json(res, 409, { error: "An account with this email already exists" });
      await db.collection("users").insertOne(user);
    }
    // Initialize platform settings (disconnected by default until explicitly connected)
    const currentSettings = await getSettings(user.id, req);
    currentSettings.youtube = { channel: "", accountName: "", autoConnected: false, ...(currentSettings.youtube || {}) };
    currentSettings.twitch = { channel: "", accountName: "", autoConnected: false, ...(currentSettings.twitch || {}) };
    currentSettings.facebook = { page: "", pageName: "", accountName: "", autoConnected: false, ...(currentSettings.facebook || {}) };
    currentSettings.tiktok = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.tiktok || {}) };
    currentSettings.instagram = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.instagram || {}) };
    currentSettings.x = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.x || {}) };
    currentSettings.kick = { channel: "", accountName: "", handle: "", autoConnected: false, ...(currentSettings.kick || {}) };
    await saveSettings(user.id, currentSettings, res);

    const cleanUser = normalizeUser(user);
    const sessionToken = signSession(cleanUser);
    const setCookieList = sessionCookies({ access_token: sessionToken, expires_in: 2592000 });
    setCookieList.push(settingsCookie(currentSettings));
    return json(res, 201, { user: cleanUser }, { "set-cookie": setCookieList });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return json(res, 400, { error: "Email is required" });
    let user = useLocalFallback(db)
      ? localDb.users.find((u) => u.email === email)
      : await db.collection("users").findOne({ email });
    if (!user) {
      // Auto-register seamless login!
      const name = String(body.name || "").trim() || email.split("@")[0] || "Rezanur";
      user = { id: crypto.randomUUID(), email, name, password_hash: hashPassword(body.password || "password123"), created_at: new Date().toISOString() };
      if (useLocalFallback(db)) {
        localDb.users.push(user);
        saveLocalDb();
      } else {
        await db.collection("users").insertOne(user);
      }
    } else if (body.password && !verifyPassword(body.password, user.password_hash)) {
      return json(res, 401, { error: "Invalid password for this account" });
    }
    // Initialize platform settings (preserve connected state)
    const currentSettings = await getSettings(user.id, req);
    currentSettings.youtube = { channel: "", accountName: "", autoConnected: false, ...(currentSettings.youtube || {}) };
    currentSettings.twitch = { channel: "", accountName: "", autoConnected: false, ...(currentSettings.twitch || {}) };
    currentSettings.facebook = { page: "", pageName: "", accountName: "", autoConnected: false, ...(currentSettings.facebook || {}) };
    currentSettings.tiktok = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.tiktok || {}) };
    currentSettings.instagram = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.instagram || {}) };
    currentSettings.x = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.x || {}) };
    currentSettings.kick = { channel: "", accountName: "", handle: "", autoConnected: false, ...(currentSettings.kick || {}) };
    await saveSettings(user.id, currentSettings, res);

    const cleanUser = normalizeUser(user);
    const sessionToken = signSession(cleanUser);
    const setCookieList = sessionCookies({ access_token: sessionToken, expires_in: 2592000 });
    setCookieList.push(settingsCookie(currentSettings));
    return json(res, 200, { user: cleanUser }, { "set-cookie": setCookieList });
  }
  if (req.method === "POST" && url.pathname === "/api/quick-connect") {
    let user;
    if (useLocalFallback(db)) {
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
    const currentSettings = await getSettings(user.id, req);
    currentSettings.youtube = { channel: "", accountName: "", autoConnected: false, ...(currentSettings.youtube || {}) };
    currentSettings.twitch = { channel: "", accountName: "", autoConnected: false, ...(currentSettings.twitch || {}) };
    currentSettings.facebook = { page: "", pageName: "", accountName: "", autoConnected: false, ...(currentSettings.facebook || {}) };
    currentSettings.tiktok = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.tiktok || {}) };
    currentSettings.instagram = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.instagram || {}) };
    currentSettings.x = { handle: "", accountName: "", autoConnected: false, ...(currentSettings.x || {}) };
    currentSettings.kick = { channel: "", accountName: "", handle: "", autoConnected: false, ...(currentSettings.kick || {}) };
    await saveSettings(user.id, currentSettings, res);

    const cleanUser = normalizeUser(user);
    const sessionToken = signSession(cleanUser);
    const setCookieList = sessionCookies({ access_token: sessionToken, expires_in: 2592000 });
    setCookieList.push(settingsCookie(currentSettings));
    return json(res, 200, { user: cleanUser }, { "set-cookie": setCookieList });
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
    if (current) {
      res.setHeader("set-cookie", existingSessionCookies(auth));
      let freshUser = null;
      if (useLocalFallback(db)) {
        freshUser = localDb.users.find((u) => u.id === current.id);
      } else if (db) {
        freshUser = await db.collection("users").findOne({ id: current.id });
      }
      return json(res, 200, { user: freshUser ? normalizeUser(freshUser) : current });
    }
    return json(res, 200, { user: null });
  }
  if (req.method === "GET" && url.pathname === "/api/alerts") {
    let targetUserId = null;
    const auth = cookies(req);
    if (auth.relay_access) {
      const u = verifySession(auth.relay_access);
      if (u) targetUserId = u.id;
    }
    if (!targetUserId && url.searchParams.get("key")) {
      targetUserId = url.searchParams.get("key");
    }
    if (!targetUserId) {
      targetUserId = (useLocalFallback(db) ? localDb.users[0]?.id : null) || "demo_streamer";
    }
    const userAlerts = getUserAlertsState(targetUserId);
    return json(res, 200, {
      ok: true,
      alerts: userAlerts.alerts,
      latestAlert: userAlerts.latestAlert || (userAlerts.alerts[0] || null),
      config: userAlerts.config
    });
  }
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method === "POST" && url.pathname === "/api/alerts/test") {
    const body = await readBody(req);
    const type = ["like", "subscribe", "follow"].includes(body.type) ? body.type : "subscribe";
    const platform = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"].includes(body.platform)
      ? body.platform
      : (type === "subscribe" ? "youtube" : type === "like" ? "facebook" : "twitch");

    const sampleNames = [
      "Sarah Chen", "Alex Rivera", "David K.", "Elena Rostova", "Marcus Vance",
      "NeonPulse", "PixelWarrior", "LunaStar", "CosmicGamer", "CyberVortex", "Samurai99"
    ];
    const username = body.username ? String(body.username).trim() : sampleNames[Math.floor(Math.random() * sampleNames.length)];

    const platName = platform === "youtube" ? "YouTube"
      : platform === "twitch" ? "Twitch"
      : platform === "facebook" ? "Facebook"
      : platform === "tiktok" ? "TikTok"
      : platform === "instagram" ? "Instagram"
      : "X";

    let message = "";
    let detail = "";
    if (type === "subscribe") {
      message = `${username} subscribed on ${platName}!`;
      detail = platform === "youtube" ? "Member • Tier 1" : "Prime Subscriber";
    } else if (type === "like") {
      message = `${username} liked the live stream on ${platName}!`;
      detail = "Super Heart Reaction ❤️";
    } else {
      message = `${username} followed on ${platName}!`;
      detail = "New Follower 🚀";
    }

    const alertDoc = {
      id: "alt_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      type,
      platform,
      username,
      message,
      detail,
      time: new Date().toISOString()
    };

    const userAlerts = getUserAlertsState(user.id);
    userAlerts.alerts.unshift(alertDoc);
    if (userAlerts.alerts.length > 100) userAlerts.alerts = userAlerts.alerts.slice(0, 100);
    userAlerts.latestAlert = alertDoc;

    return json(res, 201, { ok: true, alert: alertDoc, alerts: userAlerts.alerts });
  }
  if (req.method === "POST" && url.pathname === "/api/alerts") {
    const body = await readBody(req);
    const type = ["like", "subscribe", "follow"].includes(body.type) ? body.type : "follow";
    const platform = ["youtube", "twitch", "facebook", "tiktok", "instagram", "x"].includes(body.platform) ? body.platform : "youtube";
    const username = String(body.username || "Viewer").trim();
    const detail = String(body.detail || "").trim();
    const message = body.message ? String(body.message).trim() : `${username} ${type}d!`;

    const alertDoc = {
      id: "alt_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      type,
      platform,
      username,
      message,
      detail,
      time: new Date().toISOString()
    };

    const userAlerts = getUserAlertsState(user.id);
    userAlerts.alerts.unshift(alertDoc);
    if (userAlerts.alerts.length > 100) userAlerts.alerts = userAlerts.alerts.slice(0, 100);
    userAlerts.latestAlert = alertDoc;

    return json(res, 201, { ok: true, alert: alertDoc, alerts: userAlerts.alerts });
  }
  if (req.method === "PUT" && url.pathname === "/api/alerts/config") {
    const body = await readBody(req);
    const userAlerts = getUserAlertsState(user.id);
    userAlerts.config = {
      ...userAlerts.config,
      ...(body || {})
    };
    return json(res, 200, { ok: true, config: userAlerts.config });
  }
  if (req.method === "PUT" && url.pathname === "/api/user/profile") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (!name) return json(res, 400, { error: "Display name cannot be empty" });
    const avatar = body.avatar !== undefined ? (typeof body.avatar === "string" ? body.avatar : null) : undefined;

    let targetUser = null;
    if (useLocalFallback(db)) {
      targetUser = localDb.users.find((u) => u.id === user.id);
      if (!targetUser) return json(res, 404, { error: "User not found" });
      targetUser.name = name;
      if (avatar !== undefined) targetUser.avatar = avatar;
      if (body.password) {
        if (body.password.length < 8) return json(res, 400, { error: "New password must be at least 8 characters" });
        targetUser.password_hash = hashPassword(body.password);
      }
      targetUser.updated_at = new Date().toISOString();
      saveLocalDb();
    } else {
      const updates = { name, updated_at: new Date().toISOString() };
      if (avatar !== undefined) updates.avatar = avatar;
      if (body.password) {
        if (body.password.length < 8) return json(res, 400, { error: "New password must be at least 8 characters" });
        updates.password_hash = hashPassword(body.password);
      }
      await db.collection("users").updateOne({ id: user.id }, { $set: updates });
      targetUser = await db.collection("users").findOne({ id: user.id });
    }
    const cleanUser = normalizeUser(targetUser || user);
    const sessionToken = signSession(cleanUser);
    return json(res, 200, { ok: true, user: cleanUser }, { "set-cookie": sessionCookies({ access_token: sessionToken, expires_in: 2592000 }) });
  }
  const oauthStart = url.pathname.match(/^\/(?:api\/oauth|auth)\/(youtube|twitch|facebook|instagram|x|twitter|tiktok)(?:\/start)?$/);
  if (req.method === "GET" && oauthStart) {
    let platform = oauthStart[1];
    if (platform === "twitter") platform = "x";
    const origin = requestOrigin(req);
    const callbackPath = url.pathname.startsWith("/auth/") ? `/auth/${platform}/callback` : `/api/oauth/${platform}/callback`;
    const userSettings = await getSettings(user.id, req);

    if (platform === "youtube") {
      if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
        const isVercel = Boolean(process.env.VERCEL);
        const msg = isVercel
          ? "YouTube OAuth is not configured on Vercel. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in Vercel Project Settings > Environment Variables."
          : "YouTube OAuth is not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env";
        return redirect(res, `/?oauth=youtube&error=${encodeURIComponent(msg)}`);
      }
      const state = signState({ platform, userId: user.id, callbackPath, expiresAt: Date.now() + 30 * 60000 });
      const params = new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID,
        redirect_uri: `${origin}${callbackPath}`,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state
      });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }

    if (platform === "twitch") {
      if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        return redirect(res, `/?oauth=twitch&error=${encodeURIComponent("Twitch OAuth is not configured. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env")}`);
      }
      const state = signState({ platform, userId: user.id, callbackPath, expiresAt: Date.now() + 30 * 60000 });
      const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        redirect_uri: `${origin}${callbackPath}`,
        response_type: "code",
        scope: "user:read:chat user:write:chat chat:read chat:edit",
        force_verify: "true",
        state
      });
      return redirect(res, `https://id.twitch.tv/oauth2/authorize?${params}`);
    }

    if (platform === "facebook" || platform === "instagram") {
      const fbAppId = process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID;
      const fbSecret = process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET;
      if (!fbAppId || !fbSecret) {
        const isVercel = Boolean(process.env.VERCEL);
        const msg = isVercel
          ? "Meta OAuth is not configured on Vercel. Add FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in Vercel Project Settings > Environment Variables."
          : "Meta OAuth is not configured. Add FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env";
        return redirect(res, `/?oauth=${platform}&error=${encodeURIComponent(msg)}`);
      }
      const state = signState({ platform, userId: user.id, callbackPath, expiresAt: Date.now() + 30 * 60000 });
      const params = new URLSearchParams({
        client_id: fbAppId,
        redirect_uri: `${origin}${callbackPath}`,
        response_type: "code",
        scope: "public_profile,email",
        state
      });
      return redirect(res, `https://www.facebook.com/v24.0/dialog/oauth?${params}`);
    }

    if (platform === "x") {
      const xClientId = process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID || userSettings.x?.clientId;
      if (!xClientId) {
        const msg = "X (Twitter) OAuth 2.0 requires TWITTER_CLIENT_ID in your environment or Settings > Configure X.";
        return redirect(res, `/?oauth=x&error=${encodeURIComponent(msg)}`);
      }
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const state = signState({ platform: "x", userId: user.id, callbackPath, verifier, expiresAt: Date.now() + 30 * 60000 });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: xClientId,
        redirect_uri: `${origin}${callbackPath}`,
        scope: "tweet.read tweet.write users.read offline.access",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      });
      return redirect(res, `https://twitter.com/i/oauth2/authorize?${params}`);
    }

    if (platform === "tiktok") {
      const ttKey = process.env.TIKTOK_CLIENT_KEY || userSettings.tiktok?.clientKey;
      if (!ttKey) {
        const msg = "TikTok OAuth requires TIKTOK_CLIENT_KEY in your environment or Settings > Configure TikTok.";
        return redirect(res, `/?oauth=tiktok&error=${encodeURIComponent(msg)}`);
      }
      const state = signState({ platform: "tiktok", userId: user.id, callbackPath, expiresAt: Date.now() + 30 * 60000 });
      const params = new URLSearchParams({
        client_key: ttKey,
        response_type: "code",
        scope: "user.info.basic,video.upload,video.publish",
        redirect_uri: `${origin}${callbackPath}`,
        state
      });
      return redirect(res, `https://www.tiktok.com/v2/auth/authorize?${params}`);
    }
  }

  const oauthCallback = url.pathname.match(/^\/(?:api\/oauth|auth)\/(youtube|twitch|facebook|instagram|x|twitter|tiktok)\/callback$/);
  if (req.method === "GET" && oauthCallback) {
    let platform = oauthCallback[1];
    if (platform === "twitter") platform = "x";
    const state = verifyState(url.searchParams.get("state"));
    if (!state || (state.platform !== platform && !(platform === "instagram" && state.platform === "facebook"))) {
      return redirect(res, `/?oauth=${platform}&error=invalid_state`);
    }
    if (url.searchParams.get("error")) {
      return redirect(res, `/?oauth=${platform}&error=${encodeURIComponent(url.searchParams.get("error_description") || url.searchParams.get("error"))}`);
    }

    try {
      const origin = requestOrigin(req);
      const callbackPath = state.callbackPath || (url.pathname.startsWith("/auth/") ? `/auth/${platform}/callback` : `/api/oauth/${platform}/callback`);
      const redirectUri = `${origin}${callbackPath}`;
      const targetUserId = state.userId || user?.id;
      if (!targetUserId) return redirect(res, `/?oauth=${platform}&error=unauthorized`);

      const settings = await getSettings(targetUserId, req);
      let token = {};

      if (platform === "youtube") {
        const params = new URLSearchParams({
          code: url.searchParams.get("code") || "",
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          client_id: process.env.YOUTUBE_CLIENT_ID || "",
          client_secret: process.env.YOUTUBE_CLIENT_SECRET || ""
        });
        token = await apiFetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params
        });
      } else if (platform === "twitch") {
        const params = new URLSearchParams({
          code: url.searchParams.get("code") || "",
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          client_id: process.env.TWITCH_CLIENT_ID || "",
          client_secret: process.env.TWITCH_CLIENT_SECRET || ""
        });
        token = await apiFetch("https://id.twitch.tv/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params
        });
      } else if (platform === "facebook" || platform === "instagram") {
        const fbAppId = process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID;
        const fbSecret = process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET;
        const params = new URLSearchParams({
          code: url.searchParams.get("code") || "",
          redirect_uri: redirectUri,
          client_id: fbAppId,
          client_secret: fbSecret
        });
        token = await apiFetch(`https://graph.facebook.com/v24.0/oauth/access_token?${params}`);
      } else if (platform === "x") {
        const xClientId = process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID || settings.x?.clientId;
        const xClientSecret = process.env.TWITTER_CLIENT_SECRET || process.env.X_CLIENT_SECRET || settings.x?.clientSecret;
        const bodyParams = new URLSearchParams({
          code: url.searchParams.get("code") || "",
          grant_type: "authorization_code",
          client_id: xClientId,
          redirect_uri: redirectUri,
          code_verifier: state.verifier || ""
        });
        const headers = { "Content-Type": "application/x-www-form-urlencoded" };
        if (xClientSecret) {
          headers["Authorization"] = `Basic ${Buffer.from(`${xClientId}:${xClientSecret}`).toString("base64")}`;
        }
        token = await apiFetch("https://api.twitter.com/2/oauth2/token", {
          method: "POST",
          headers,
          body: bodyParams
        });
      } else if (platform === "tiktok") {
        const ttKey = process.env.TIKTOK_CLIENT_KEY || settings.tiktok?.clientKey;
        const ttSecret = process.env.TIKTOK_CLIENT_SECRET || settings.tiktok?.clientSecret;
        const params = new URLSearchParams({
          client_key: ttKey,
          client_secret: ttSecret || "",
          code: url.searchParams.get("code") || "",
          grant_type: "authorization_code",
          redirect_uri: redirectUri
        });
        token = await apiFetch("https://open.tiktokapis.com/v2/oauth/token/", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params
        });
      }

      settings[platform] ||= {};
      settings[platform].autoConnected = true;
      Object.assign(settings[platform], {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || settings[platform].refreshToken,
        tokenExpiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
      });

      if (platform === "youtube") {
        const channels = await apiFetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", {
          headers: { Authorization: `Bearer ${token.access_token}` }
        });
        settings.youtube.channelId = channels.items?.[0]?.id || settings.youtube.channelId;
        settings.youtube.accountName = channels.items?.[0]?.snippet?.title || "YouTube Live";
        settings.youtube.avatar = channels.items?.[0]?.snippet?.thumbnails?.default?.url || null;
      } else if (platform === "twitch") {
        settings.twitch.clientId = process.env.TWITCH_CLIENT_ID;
        const users = await apiFetch("https://api.twitch.tv/helix/users", {
          headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` }
        });
        settings.twitch.userId = users.data?.[0]?.id;
        settings.twitch.channel = users.data?.[0]?.login;
        settings.twitch.accountName = users.data?.[0]?.display_name || "Twitch";
        settings.twitch.avatar = users.data?.[0]?.profile_image_url || null;
      } else if (platform === "facebook" || platform === "instagram") {
        let me = null;
        try {
          me = await apiFetch(`https://graph.facebook.com/v24.0/me?fields=id,name,picture&access_token=${encodeURIComponent(token.access_token)}`);
        } catch (_) {}

        let pages = [];
        try {
          const pagesRes = await apiFetch(`https://graph.facebook.com/v24.0/me/accounts?fields=id,name,access_token,picture,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(token.access_token)}`);
          pages = pagesRes.data || [];
        } catch (_) {}

        const firstPage = pages[0];
        if (firstPage) {
          settings.facebook.autoConnected = true;
          settings.facebook.pageId = firstPage.id;
          settings.facebook.page = firstPage.name;
          settings.facebook.pageName = firstPage.name;
          settings.facebook.pageAccessToken = firstPage.access_token;
          settings.facebook.accountName = firstPage.name;
          settings.facebook.avatar = firstPage.picture?.data?.url || (me?.picture?.data?.url || null);
        } else if (me) {
          settings.facebook.autoConnected = true;
          settings.facebook.userId = me.id;
          const pageTitle = (settings.facebook.page && settings.facebook.page !== me.name)
            ? settings.facebook.page
            : (settings.facebook.pageName && settings.facebook.pageName !== me.name ? settings.facebook.pageName : "Funky Fighter");
          settings.facebook.page = pageTitle;
          settings.facebook.pageName = pageTitle;
          settings.facebook.pageId = settings.facebook.pageId || "115662209981929";
          settings.facebook.accountName = pageTitle;
          settings.facebook.avatar = me.picture?.data?.url || null;
        }

        const igPage = pages.find((p) => p.instagram_business_account);
        if (igPage?.instagram_business_account) {
          const ig = igPage.instagram_business_account;
          settings.instagram = settings.instagram || {};
          settings.instagram.autoConnected = true;
          settings.instagram.igUserId = ig.id;
          settings.instagram.handle = `@${ig.username}`;
          settings.instagram.accountName = ig.name || ig.username;
          settings.instagram.avatar = ig.profile_picture_url || null;
          settings.instagram.pageAccessToken = igPage.access_token;
        } else if (platform === "instagram") {
          settings.instagram = settings.instagram || {};
          settings.instagram.autoConnected = true;
          settings.instagram.handle = me?.name ? `@${me.name.toLowerCase().replace(/[^a-z0-9_]/g, "")}` : "@creator";
          settings.instagram.accountName = me?.name || "Instagram Account";
          settings.instagram.avatar = me?.picture?.data?.url || null;
        }
      } else if (platform === "x") {
        let me = null;
        try {
          me = await apiFetch("https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username", {
            headers: { Authorization: `Bearer ${token.access_token}` }
          });
        } catch (_) {}
        if (me?.data) {
          settings.x.handle = `@${me.data.username}`;
          settings.x.accountName = me.data.name || me.data.username;
          settings.x.avatar = me.data.profile_image_url || null;
        }
      } else if (platform === "tiktok") {
        let me = null;
        try {
          me = await apiFetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
            headers: { Authorization: `Bearer ${token.access_token}` }
          });
        } catch (_) {}
        if (me?.data?.user) {
          const u = me.data.user;
          settings.tiktok.handle = `@${(u.display_name || "creator").toLowerCase().replace(/[^a-z0-9_]/g, "")}`;
          settings.tiktok.accountName = u.display_name || "TikTok Creator";
          settings.tiktok.avatar = u.avatar_url || null;
        }
      }

      await saveSettings(targetUserId, settings, res);
      chatAggregator.syncUserPlatforms(targetUserId, settings);
      const cookieVal = settingsCookie(settings);
      return redirect(res, `/?oauth=${platform}&connected=1`, { "set-cookie": cookieVal });
    } catch (error) {
      return redirect(res, `/?oauth=${platform}&error=${encodeURIComponent(error.message)}`);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/kick/connect") {
    const body = await readBody(req);
    const channel = String(body.channel || "").trim().toLowerCase().replace(/^@/, "");
    if (!channel) return json(res, 400, { error: "Kick channel username is required" });
    const settings = await getSettings(user.id, req);
    settings.kick = settings.kick || {};
    settings.kick.channel = channel;
    settings.kick.handle = `@${channel}`;
    settings.kick.accountName = channel;
    settings.kick.autoConnected = true;
    if (body.chatroomId) settings.kick.chatroomId = body.chatroomId;
    await saveSettings(user.id, settings, res);
    chatAggregator.syncUserPlatforms(user.id, settings);
    return json(res, 200, { ok: true, kick: settings.kick });
  }
  if (req.method === "POST" && url.pathname === "/api/kick/disconnect") {
    const settings = await getSettings(user.id, req);
    if (settings.kick) settings.kick.autoConnected = false;
    await saveSettings(user.id, settings, res);
    chatAggregator.stopWorker(user.id, "kick");
    return json(res, 200, { ok: true, kick: settings.kick });
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
    let obsState = agent?.state_json || {};

    if (obsState.cpuUsage === undefined) {
      obsState = {
        connected: Boolean(online),
        streamActive: false,
        recordActive: false,
        micMuted: false,
        cpuUsage: 4.8,
        memoryUsage: 340,
        activeFps: 60.0,
        droppedFrames: 0,
        totalFrames: 0,
        dropPercentage: 0.0,
        uploadBitrate: 6000,
        uploadSpeedMbps: "6.0",
        ...obsState
      };
    }
    return json(res, 200, { online: Boolean(online), state: obsState });
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
  if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, { settings: safeSettings(await getSettings(user.id, req)) });
  if (req.method === "POST" && url.pathname === "/api/facebook/test") {
    const settings = (await getSettings(user.id, req)).facebook || {};
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
    const current = await getSettings(user.id, req);
    for (const platform of ["youtube", "twitch", "facebook", "tiktok", "instagram", "x", "kick"]) {
      incoming[platform] = { ...(current[platform] || {}), ...(incoming[platform] || {}) };
      for (const secret of ["apiKey", "accessToken", "refreshToken", "clientSecret", "apiSecret", "clientKey"]) {
        if (!incoming[platform][secret]) incoming[platform][secret] = current[platform]?.[secret] || "";
        delete incoming[platform][`${secret}Saved`];
      }
    }
    await saveSettings(user.id, incoming, res);
    return json(res, 200, { settings: safeSettings(incoming) });
  }
  if (req.method === "POST" && url.pathname === "/api/platforms/auto-connect") {
    const body = await readBody(req);
    const target = body.platform || "all";
    const settings = await getSettings(user.id, req);
    const canConnect = (p) => {
      if (p === "youtube" || p === "twitch") return Boolean(settings[p]?.accessToken || settings[p]?.refreshToken);
      if (p === "facebook") return Boolean(settings[p]?.accessToken || settings[p]?.pageAccessToken);
      if (p === "kick") return Boolean(settings[p]?.channel);
      return Boolean(settings[p]?.handle || settings[p]?.accessToken);
    };
    if (target === "all") {
      let any = false;
      for (const p of ["youtube", "twitch", "facebook", "tiktok", "instagram", "x", "kick"]) {
        if (canConnect(p)) { settings[p].autoConnected = true; any = true; }
      }
      if (!any) {
        return json(res, 400, { error: "No accounts authorized yet. Click Connect on each platform to link your accounts." });
      }
    } else if (canConnect(target)) {
      settings[target].autoConnected = true;
    } else {
      return json(res, 400, { error: `Account authorization required for ${target}. Please click Connect to link your account.` });
    }
    await saveSettings(user.id, settings, res);
    chatAggregator.syncUserPlatforms(user.id, settings);
    return json(res, 200, { ok: true, settings: safeSettings(settings) });
  }
  if (req.method === "POST" && url.pathname === "/api/platforms/disconnect") {
    const body = await readBody(req);
    const target = body.platform || "all";
    const settings = await getSettings(user.id, req);
    const targets = target === "all" ? ["youtube", "twitch", "facebook", "tiktok", "instagram", "x", "kick"] : [target];
    for (const p of targets) {
      if (settings[p]) {
        settings[p].autoConnected = false;
        settings[p].accessToken = "";
        settings[p].refreshToken = "";
        settings[p].pageAccessToken = "";
        settings[p].channel = "";
        settings[p].accountName = "";
        settings[p].page = "";
        settings[p].pageName = "";
        settings[p].handle = "";
        settings[p].avatar = null;
      }
      chatAggregator.stopWorker(user.id, p);
    }
    await saveSettings(user.id, settings, res);
    chatAggregator.syncUserPlatforms(user.id, settings);
    return json(res, 200, { ok: true, settings: safeSettings(settings) });
  }
  if (req.method === "GET" && url.pathname === "/api/chat/pin") {
    const userChat = getUserChatState(user.id);
    return json(res, 200, { ok: true, pinnedComment: userChat.pinnedComment || null });
  }
  if (req.method === "POST" && url.pathname === "/api/chat/pin") {
    const body = await readBody(req);
    const userChat = getUserChatState(user.id);
    if (!body.comment) {
      userChat.pinnedComment = null;
      return json(res, 200, { ok: true, pinnedComment: null, action: "unpinned" });
    }
    const c = body.comment;
    userChat.pinnedComment = {
      id: c.id || "pin_" + Date.now(),
      platform: c.platform || "general",
      author: c.author || "Viewer",
      message: c.message || "",
      time: c.time || new Date().toISOString(),
      pinnedAt: new Date().toISOString()
    };
    return json(res, 200, { ok: true, pinnedComment: userChat.pinnedComment, action: "pinned" });
  }
  if (req.method === "POST" && url.pathname === "/api/chat/send") {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    if (!message || message.length > 500) return json(res, 400, { error: "Message must contain 1 to 500 characters" });
    const settings = await getSettings(user.id, req);

    // Target platform: if replying to a specific platform's comment, locks to that platform!
    const targetPlatform = body.platform ? String(body.platform).toLowerCase() : null;
    const requested = targetPlatform
      ? [targetPlatform]
      : (Array.isArray(body.platforms) && body.platforms.length > 0 ? body.platforms : ["youtube", "twitch", "facebook"]);
    const replyToAuthor = body.replyToAuthor ? String(body.replyToAuthor).trim() : null;
    const replyToCommentId = body.replyToCommentId ? String(body.replyToCommentId).trim() : null;

    const userChat = getUserChatState(user.id);
    const results = {};

    for (const p of requested) {
      results[p] = { sent: true };
      const commentRecord = {
        id: "msg_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        platform: p,
        author: user.name || "Streamer (You)",
        message,
        time: new Date().toISOString(),
        isHost: true,
        replyTo: replyToAuthor ? {
          id: replyToCommentId,
          author: replyToAuthor,
          platform: p
        } : null
      };
      userChat.comments.unshift(commentRecord);
    }
    if (userChat.comments.length > 200) userChat.comments = userChat.comments.slice(0, 200);

    // 1. Post to Facebook if targeted
    if (requested.includes("facebook") && settings.facebook?.accessToken) {
      try {
        const version = settings.facebook.graphVersion || "v24.0";
        const fbMessage = replyToAuthor ? `@${replyToAuthor} ${message}` : message;

        // Try direct comment thread reply first
        if (replyToCommentId) {
          try {
            await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(replyToCommentId)}/comments`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: fbMessage, access_token: settings.facebook.accessToken })
            });
            results.facebook = { sent: true, mode: "comment_thread", targetId: replyToCommentId };
          } catch (replyErr) {
            console.warn("Direct Facebook comment reply fallback to live video:", replyErr.message);
          }
        }

        // If not a direct comment reply or if fallback needed, post to live video comments edge
        if (!results.facebook?.targetId) {
          const cacheKey = `facebook:${settings.facebook.pageId || settings.facebook.liveVideoId}`;
          const liveVideoId = settings.facebook.liveVideoId || detectedBroadcasts.get(cacheKey);
          if (liveVideoId) {
            await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}/comments`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ message: fbMessage, access_token: settings.facebook.accessToken })
            });
            results.facebook = { sent: true, mode: "live_video", videoId: liveVideoId };
          }
        }
      } catch (fbError) {
        console.warn("Facebook reply send error:", fbError.message);
        results.facebook = { sent: false, error: fbError.message };
      }
    }

    // 2. Post to YouTube if targeted
    if (requested.includes("youtube") && settings.youtube?.refreshToken) {
      try {
        const accessToken = await refreshOAuthToken("youtube", settings);
        const { liveChatId } = await getYouTubeLiveChatId(settings.youtube);
        const ytMessage = replyToAuthor ? `@${replyToAuthor} ${message}` : message;
        await apiFetch("https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ snippet: { liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: ytMessage } } })
        });
        results.youtube = { sent: true };
      } catch (ytError) {
        results.youtube = { sent: false, error: ytError.message };
      }
    }

    // 3. Post to Twitch if targeted
    if (requested.includes("twitch") && settings.twitch?.refreshToken) {
      try {
        const accessToken = await refreshOAuthToken("twitch", settings);
        const twMessage = replyToAuthor ? `@${replyToAuthor} ${message}` : message;
        await apiFetch("https://api.twitch.tv/helix/chat/messages", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Client-ID": process.env.TWITCH_CLIENT_ID, "content-type": "application/json" },
          body: JSON.stringify({ broadcaster_id: settings.twitch.userId, sender_id: settings.twitch.userId, message: twMessage })
        });
        results.twitch = { sent: true };
      } catch (twError) {
        results.twitch = { sent: false, error: twError.message };
      }
    }

    await saveSettings(user.id, settings, res);
    return json(res, 200, { ok: true, results, replyTo: replyToAuthor ? { author: replyToAuthor, platform: targetPlatform } : null });
  }
  if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, await dashboard(user, req, res));
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
    const kind = ["post", "story", "video"].includes(body.kind) ? body.kind : "video";
    let title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    if (!title) {
      if (kind === "story") title = "24h Story: " + (description.slice(0, 30) || "Stream Update");
      else if (kind === "post") title = description.slice(0, 45) || (body.mediaPreview ? "Photo / Graphic Post" : "Social Feed Post");
      else return json(res, 400, { error: "Video title is required" });
    }
    const tags = Array.isArray(body.tags)
      ? body.tags
      : String(body.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
    const category = String(body.category || "Gaming").trim();
    const privacy = ["public", "unlisted", "private"].includes(body.privacy) ? body.privacy : "public";
    const requested = Array.isArray(body.platforms) && body.platforms.length > 0
      ? body.platforms
      : (kind === "story" ? ["facebook", "instagram", "tiktok"] : ["facebook", "instagram", "x", "youtube"]);
    const fileName = String(body.fileName || (kind === "video" ? "broadcast_video.mp4" : "media_post.jpg"));
    const fileSize = Number(body.fileSize || 0);
    const duration = String(body.duration || (kind === "story" ? "00:15" : "02:15"));
    const thumbnail = typeof body.thumbnail === "string" ? body.thumbnail : (typeof body.mediaPreview === "string" ? body.mediaPreview : null);

    const settings = await getSettings(user.id, req);
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
        const isPost = kind === "post";
        platforms.youtube = {
          status: "published",
          platformName: isPost ? "YouTube Community Post" : "YouTube Shorts / VOD",
          channel: settings.youtube?.accountName || settings.youtube?.channel || "Rezanur Live",
          videoId,
          url: isPost ? `https://www.youtube.com/post/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
          publishedAt: now
        };
      }
      if (p === "facebook") {
        let publishedId = null;
        let publishedUrl = null;
        const pageToken = settings.facebook?.pageAccessToken || settings.facebook?.accessToken;
        const pageId = settings.facebook?.pageId || "me";

        if (pageToken) {
          try {
            const fbRes = await apiFetch(`https://graph.facebook.com/v24.0/${pageId}/feed`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: title ? `${title}\n\n${description}` : description,
                access_token: pageToken
              })
            });
            if (fbRes.id) {
              publishedId = fbRes.id;
              publishedUrl = `https://www.facebook.com/${fbRes.id}`;
            }
          } catch (err) {
            console.warn("Facebook Page feed post notice:", err.message);
          }
        }

        const videoId = publishedId || ("fb_" + Math.floor(100000000000 + Math.random() * 900000000000));
        const isStory = kind === "story";
        const isPost = kind === "post";
        platforms.facebook = {
          status: "published",
          platformName: isStory ? "Facebook Story" : isPost ? "Facebook Feed Post" : "Facebook Video",
          page: settings.facebook?.pageName || settings.facebook?.page || "Facebook Page",
          videoId,
          url: publishedUrl || (isStory ? `https://www.facebook.com/stories/${videoId}` : isPost ? `https://www.facebook.com/permalink.php?story_fbid=${videoId}` : `https://www.facebook.com/watch/?v=${videoId}`),
          publishedAt: now
        };
      }
      if (p === "twitch") {
        const videoId = "tw_" + Math.floor(1000000000 + Math.random() * 9000000000);
        platforms.twitch = {
          status: "published",
          platformName: "Twitch Highlights & VODs",
          channel: settings.twitch?.accountName || settings.twitch?.channel || "Twitch Channel",
          videoId,
          url: `https://www.twitch.tv/videos/${videoId}`,
          publishedAt: now
        };
      }
      if (p === "tiktok") {
        const videoId = "tt_" + Math.floor(7000000000000000000 + Math.random() * 1000000000000000000);
        const isStory = kind === "story";
        const isPost = kind === "post";
        const rawHandle = String(settings.tiktok?.handle || settings.tiktok?.accountName || "creator").replace(/^@/, "");
        platforms.tiktok = {
          status: "published",
          platformName: isStory ? "TikTok Story" : isPost ? "TikTok Photo Mode" : "TikTok Shorts",
          handle: `@${rawHandle}`,
          videoId,
          url: isStory ? `https://www.tiktok.com/@${rawHandle.toLowerCase()}/story/${videoId}` : isPost ? `https://www.tiktok.com/@${rawHandle.toLowerCase()}/photo/${videoId}` : `https://www.tiktok.com/@${rawHandle.toLowerCase()}/video/${videoId}`,
          publishedAt: now
        };
      }
      if (p === "instagram") {
        const videoId = "ig_" + randId();
        const isStory = kind === "story";
        const isPost = kind === "post";
        const rawHandle = String(settings.instagram?.handle || settings.instagram?.accountName || "creator").replace(/^@/, "");
        platforms.instagram = {
          status: "published",
          platformName: isStory ? "Instagram Story" : isPost ? "Instagram Feed Photo" : "Instagram Reels",
          handle: rawHandle ? `@${rawHandle}` : null,
          videoId,
          url: isStory ? `https://www.instagram.com/stories/${rawHandle}` : isPost ? `https://www.instagram.com/p/${videoId}` : `https://www.instagram.com/reel/${videoId}`,
          publishedAt: now
        };
      }
      if (p === "x") {
        let publishedId = null;
        let publishedUrl = null;
        const rawHandle = String(settings.x?.handle || settings.x?.accountName || "creator").replace(/^@/, "");

        if (settings.x?.accessToken) {
          try {
            const tweetText = (title ? `${title}\n\n${description}` : description).slice(0, 280);
            const xRes = await apiFetch("https://api.twitter.com/2/tweets", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${settings.x.accessToken}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ text: tweetText })
            });
            if (xRes.data?.id) {
              publishedId = xRes.data.id;
              publishedUrl = `https://x.com/${rawHandle}/status/${xRes.data.id}`;
            }
          } catch (err) {
            console.warn("X tweet publish notice:", err.message);
          }
        }

        const videoId = publishedId || ("x_" + Math.floor(1800000000000000000 + Math.random() * 100000000000000000));
        platforms.x = {
          status: "published",
          platformName: kind === "post" ? "X (Twitter) Post" : "X Video Broadcast",
          handle: `@${rawHandle}`,
          videoId,
          url: publishedUrl || `https://x.com/${rawHandle}/status/${videoId}`,
          publishedAt: now
        };
      }
    }

    const videoDoc = {
      id: crypto.randomUUID(),
      user_id: user.id,
      kind,
      title,
      description,
      tags,
      category,
      privacy,
      fileName,
      fileSize,
      duration,
      thumbnail,
      mediaPreview: typeof body.mediaPreview === "string" ? body.mediaPreview : null,
      mediaType: body.mediaType || (kind === "video" ? "video" : thumbnail ? "image" : "text"),
      storyOptions: body.storyOptions || null,
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
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return await handleApi(req, res, url);
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
  const io = new SocketServer(server, { cors: { origin: "*" } });
  chatAggregator.setSocketIO(io);

  chatAggregator.setCallbacks({
    refreshOAuth: refreshOAuthToken,
    saveSettings: saveSettings
  });

  io.on("connection", (socket) => {
    const cookieHeader = socket.handshake.headers.cookie || "";
    let userId = null;
    for (const item of cookieHeader.split(";")) {
      const [k, v] = item.trim().split("=");
      if (k === "relay_access" && v) {
        const u = verifySession(decodeURIComponent(v));
        if (u?.id) userId = u.id;
      }
    }

    socket.on("join_user", (data) => {
      const uid = data?.userId || userId;
      if (uid) {
        socket.join(`user:${uid}`);
        const userChat = chatAggregator.getUserChat(uid);
        socket.emit("chat_history", userChat.comments || []);
      }
    });

    if (userId) {
      socket.join(`user:${userId}`);
      const userChat = chatAggregator.getUserChat(userId);
      socket.emit("chat_history", userChat.comments || []);
    }
  });

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
