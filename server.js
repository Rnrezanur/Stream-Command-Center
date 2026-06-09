const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createClient } = require("@libsql/client");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL is required on Vercel");
if (process.env.VERCEL && !process.env.APP_SECRET) throw new Error("APP_SECRET is required on Vercel");
const APP_SECRET = process.env.APP_SECRET || "change-this-development-secret";
const DATA_DIR = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(DATA_DIR, "relay.db")}`,
  authToken: process.env.TURSO_AUTH_TOKEN
});
const dbReady = db.batch([
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    encrypted_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`
]);

const twitchChats = new Map();
const detectedBroadcasts = new Map();
const key = crypto.scryptSync(APP_SECRET, "relay-settings", 32);
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1_000_000) req.destroy();
  });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); } });
});
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const passwordHash = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
};
const passwordValid = (password, stored) => {
  const [salt, expected] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
};
const encrypt = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
};
const decrypt = (value) => {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
};

async function currentUser(req) {
  await dbReady;
  const token = (req.headers.cookie || "").match(/relay_session=([^;]+)/)?.[1];
  if (!token) return null;
  const result = await db.execute({
    sql: `
    SELECT users.id, users.email, users.name FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE token_hash = ? AND expires_at > ?
  `,
    args: [hashToken(token), Date.now()]
  });
  return result.rows[0] || null;
}

async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) json(res, 401, { error: "Sign in required" });
  return user;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.execute({ sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", args: [hashToken(token), userId, Date.now() + 30 * 86400000] });
  return `relay_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.VERCEL ? "; Secure" : ""}`;
}

async function getSettings(userId) {
  const result = await db.execute({ sql: "SELECT encrypted_json FROM settings WHERE user_id = ?", args: [userId] });
  const row = result.rows[0];
  return row ? decrypt(row.encrypted_json) : {};
}

function safeSettings(settings) {
  const masked = structuredClone(settings);
  for (const platform of ["youtube", "twitch", "facebook"]) {
    for (const field of ["apiKey", "accessToken", "clientSecret"]) {
      if (masked[platform]?.[field]) masked[platform][field] = "••••••••";
    }
  }
  return masked;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `API returned ${response.status}`);
  return body;
}

async function getYouTube(settings) {
  if (!settings.apiKey || (!settings.videoId && !settings.channelId)) return { connected: false, viewers: 0, comments: [] };
  const cacheKey = `youtube:${settings.channelId || settings.videoId}`;
  let videoId = settings.videoId || detectedBroadcasts.get(cacheKey);
  if (!videoId) {
    const live = await apiFetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&maxResults=1&channelId=${encodeURIComponent(settings.channelId)}&key=${encodeURIComponent(settings.apiKey)}`);
    videoId = live.items?.[0]?.id?.videoId;
    if (!videoId) return { connected: true, viewers: 0, comments: [], status: "No active broadcast detected" };
    detectedBroadcasts.set(cacheKey, videoId);
  }
  const video = await apiFetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(settings.apiKey)}`);
  const details = video.items?.[0]?.liveStreamingDetails || {};
  if (details.actualEndTime && !settings.videoId) detectedBroadcasts.delete(cacheKey);
  const comments = [];
  const liveChatId = details.activeLiveChatId;
  if (liveChatId) {
    const chat = await apiFetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet,authorDetails&maxResults=200&liveChatId=${encodeURIComponent(liveChatId)}&key=${encodeURIComponent(settings.apiKey)}`);
    for (const item of chat.items || []) comments.push({
      id: item.id, platform: "youtube", author: item.authorDetails?.displayName || "YouTube user",
      avatar: item.authorDetails?.profileImageUrl, message: item.snippet?.displayMessage || "", time: item.snippet?.publishedAt
    });
  }
  return { connected: true, viewers: Number(details.concurrentViewers || 0), comments, broadcastId: videoId };
}

async function getTwitch(settings, userId) {
  if (!settings.clientId || !settings.accessToken || !settings.channel) return { connected: false, viewers: 0, comments: [] };
  const stream = await apiFetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(settings.channel)}`, {
    headers: { "Client-ID": settings.clientId, Authorization: `Bearer ${settings.accessToken}` }
  });
  ensureTwitchChat(userId, settings.channel);
  return { connected: true, viewers: Number(stream.data?.[0]?.viewer_count || 0), comments: twitchChats.get(userId)?.messages || [] };
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
  if (!settings.accessToken || (!settings.liveVideoId && !settings.pageId)) return { connected: false, viewers: 0, comments: [] };
  const version = settings.graphVersion || "v23.0";
  const cacheKey = `facebook:${settings.pageId || settings.liveVideoId}`;
  let liveVideoId = settings.liveVideoId || detectedBroadcasts.get(cacheKey);
  if (!liveVideoId) {
    const liveVideos = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(settings.pageId)}/live_videos?fields=id,status&limit=25&access_token=${encodeURIComponent(settings.accessToken)}`);
    liveVideoId = liveVideos.data?.find((item) => item.status === "LIVE")?.id;
    if (!liveVideoId) return { connected: true, viewers: 0, comments: [], status: "No active broadcast detected" };
    detectedBroadcasts.set(cacheKey, liveVideoId);
  }
  const video = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}?fields=live_views,status&access_token=${encodeURIComponent(settings.accessToken)}`);
  if (video.status && video.status !== "LIVE" && !settings.liveVideoId) detectedBroadcasts.delete(cacheKey);
  const chat = await apiFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}/comments?fields=id,from,message,created_time&limit=100&access_token=${encodeURIComponent(settings.accessToken)}`);
  return {
    connected: true, viewers: Number(video.live_views || 0), broadcastId: liveVideoId,
    comments: (chat.data || []).map((item) => ({ id: item.id, platform: "facebook", author: item.from?.name || "Facebook user", message: item.message || "", time: item.created_time }))
  };
}

async function dashboard(user) {
  const settings = await getSettings(user.id);
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
  await dbReady;
  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readBody(req);
    if (!body.email || !body.password || body.password.length < 8) return json(res, 400, { error: "Email and password of at least 8 characters are required" });
    try {
      const result = await db.execute({ sql: "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)", args: [body.email.toLowerCase(), body.name || body.email.split("@")[0], passwordHash(body.password)] });
      const userId = Number(result.lastInsertRowid);
      return json(res, 201, { user: { id: userId, email: body.email.toLowerCase(), name: body.name || body.email.split("@")[0] } }, { "set-cookie": await createSession(userId) });
    } catch (_) { return json(res, 409, { error: "An account with this email already exists" }); }
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const result = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [String(body.email || "").toLowerCase()] });
    const user = result.rows[0];
    if (!user || !passwordValid(body.password || "", user.password_hash)) return json(res, 401, { error: "Invalid email or password" });
    return json(res, 200, { user: { id: user.id, email: user.email, name: user.name } }, { "set-cookie": await createSession(user.id) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = (req.headers.cookie || "").match(/relay_session=([^;]+)/)?.[1];
    if (token) await db.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [hashToken(token)] });
    return json(res, 200, { ok: true }, { "set-cookie": "relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user });
  if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, { settings: safeSettings(await getSettings(user.id)) });
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const incoming = await readBody(req);
    const current = await getSettings(user.id);
    for (const platform of ["youtube", "twitch", "facebook"]) {
      incoming[platform] ||= {};
      for (const secret of ["apiKey", "accessToken", "clientSecret"]) {
        if (incoming[platform][secret] === "••••••••") incoming[platform][secret] = current[platform]?.[secret] || "";
      }
    }
    await db.execute({
      sql: "INSERT INTO settings (user_id, encrypted_json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_json=excluded.encrypted_json, updated_at=CURRENT_TIMESTAMP",
      args: [user.id, encrypt(incoming)]
    });
    return json(res, 200, { settings: safeSettings(incoming) });
  }
  if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, await dashboard(user));
  return json(res, 404, { error: "Not found" });
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/plain; charset=utf-8" };
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
