const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4173);
const APP_SECRET = process.env.APP_SECRET || "change-this-development-secret";
let supabase;

function supabaseKeyRole(secret) {
  if (!secret) return "missing";
  if (secret.startsWith("sb_secret_")) return "service_role";
  if (secret.startsWith("sb_publishable_")) return "anon";
  try {
    return JSON.parse(Buffer.from(secret.split(".")[1], "base64url").toString()).role || "unknown";
  } catch (_) {
    return "unknown";
  }
}

function getSupabase() {
  if (supabase) return supabase;
  supabase = createSupabaseClient();
  return supabase;
}

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!secret) missing.push("SUPABASE_SECRET_KEY");
  if (process.env.VERCEL && !process.env.APP_SECRET) missing.push("APP_SECRET");
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (supabaseKeyRole(secret) === "anon") {
    throw new Error("SUPABASE_SECRET_KEY is an anon/publishable key. In Vercel, replace it with the Supabase server-side Secret key or legacy service_role key, then redeploy.");
  }
  return createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
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
const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1_000_000) req.destroy();
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
const resolveAgentToken = async (supabase, token) => {
  const signed = verifyAgentToken(token);
  if (signed?.userId) return signed;
  const tokenHash = hash(token);
  if (verifiedAgentTokens.has(tokenHash)) return { userId: verifiedAgentTokens.get(tokenHash) };
  const { data, error } = await supabase.from("obs_agents").select("user_id").eq("agent_token_hash", tokenHash).maybeSingle();
  if (error || !data?.user_id) return null;
  verifiedAgentTokens.set(tokenHash, data.user_id);
  return { userId: data.user_id };
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
  return [
    `relay_access=${encodeURIComponent(session.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${session.expires_in || 3600}${secure}`,
    `relay_refresh=${encodeURIComponent(session.refresh_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`
  ];
}

function existingSessionCookies(auth) {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return [
    `relay_access=${encodeURIComponent(auth.relay_access)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure}`,
    `relay_refresh=${encodeURIComponent(auth.relay_refresh || "")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`
  ];
}

async function requireUser(req, res) {
  const authClient = createSupabaseClient();
  const auth = cookies(req);
  if (auth.relay_access) {
    const { data } = await authClient.auth.getUser(auth.relay_access);
    if (data.user) {
      res.setHeader("set-cookie", existingSessionCookies(auth));
      return normalizeUser(data.user);
    }
  }
  if (auth.relay_refresh) {
    const { data, error } = await authClient.auth.refreshSession({ refresh_token: auth.relay_refresh });
    if (!error && data.session) {
      res.setHeader("set-cookie", sessionCookies(data.session));
      return normalizeUser(data.user);
    }
  }
  json(res, 401, { error: "Sign in required" });
  return null;
}

async function getSettings(userId) {
  const supabase = getSupabase();
  const { data: row, error } = await supabase.from("platform_settings").select("encrypted_json").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return row ? decrypt(row.encrypted_json) : {};
}

async function saveSettings(userId, settings) {
  const { error } = await getSupabase().from("platform_settings").upsert({
    user_id: userId, encrypted_json: encrypt(settings), updated_at: new Date().toISOString()
  });
  if (error) throw error;
  return settings;
}

function normalizeUser(user) {
  return { id: user.id, email: user.email, name: user.user_metadata?.name || user.email?.split("@")[0] || "User" };
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

async function getYouTube(settings) {
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
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseRole = supabaseKeyRole(supabaseSecret);
    const configured = {
      supabaseUrl: Boolean(process.env.SUPABASE_URL),
      supabaseSecret: Boolean(supabaseSecret),
      supabasePrivilegedKey: supabaseRole !== "missing" && supabaseRole !== "anon",
      appSecret: Boolean(process.env.APP_SECRET)
    };
    const oauthConfigured = {
      youtube: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
      twitch: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)
    };
    return json(res, Object.values(configured).every(Boolean) ? 200 : 503, { ok: Object.values(configured).every(Boolean), configured, oauthConfigured, supabaseRole, environment: process.env.VERCEL ? "vercel" : "local" });
  }
  const supabase = getSupabase();
  if (req.method === "POST" && url.pathname === "/api/agent/pair") {
    const body = await readBody(req);
    const pairingHash = hash(String(body.pairingCode || "").toUpperCase());
    const { data: agent, error } = await supabase.from("obs_agents").select("user_id,pairing_expires_at").eq("pairing_code_hash", pairingHash).maybeSingle();
    if (error || !agent || new Date(agent.pairing_expires_at) < new Date()) return json(res, 401, { error: "Invalid or expired pairing code" });
    const agentToken = signAgentToken(agent.user_id);
    const { error: updateError } = await supabase.from("obs_agents").update({
      agent_token_hash: hash(agentToken), pairing_code_hash: null, pairing_expires_at: null, updated_at: new Date().toISOString()
    }).eq("user_id", agent.user_id);
    if (updateError) throw updateError;
    verifiedAgentTokens.set(hash(agentToken), agent.user_id);
    return json(res, 200, { agentToken });
  }
  if (url.pathname.startsWith("/api/agent/") && url.pathname !== "/api/agent/pair") {
    const agentToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const agent = await resolveAgentToken(supabase, agentToken);
    if (!agent?.userId) return json(res, 401, { error: "Invalid agent token" });
    agent.user_id = agent.userId;
    if (req.method === "POST" && url.pathname === "/api/agent/poll") {
      let { data: commands, error: commandsError } = await supabase.rpc("claim_obs_commands", { p_user_id: agent.user_id });
      if (commandsError?.code === "PGRST202" || commandsError?.code === "42883") {
        ({ data: commands, error: commandsError } = await supabase.from("obs_commands").select("id,request_type,request_data").eq("user_id", agent.user_id).eq("status", "pending").gte("created_at", new Date(Date.now() - 15000).toISOString()).order("created_at").limit(20));
      }
      if (commandsError) throw commandsError;
      return json(res, 200, { commands: commands || [] });
    }
    if (req.method === "POST" && url.pathname === "/api/agent/state") {
      const body = await readBody(req);
      const { error: stateError } = await supabase.from("obs_agents").update({
        state_json: body.state || {}, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq("user_id", agent.user_id);
      if (stateError) throw stateError;
      return json(res, 200, { ok: true });
    }
    const commandMatch = url.pathname.match(/^\/api\/agent\/commands\/([^/]+)$/);
    if (req.method === "POST" && commandMatch) {
      const body = await readBody(req);
      const { error: updateError } = await supabase.from("obs_commands").update({
        status: body.error ? "failed" : "completed", result_json: body.result || null,
        error_text: body.error || null, completed_at: new Date().toISOString()
      }).eq("id", commandMatch[1]).eq("user_id", agent.user_id);
      if (updateError) throw updateError;
      return json(res, 200, { ok: true });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readBody(req);
    if (!body.email || !body.password || body.password.length < 8) return json(res, 400, { error: "Email and password of at least 8 characters are required" });
    const email = body.email.toLowerCase();
    const name = body.name || email.split("@")[0];
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email, password: body.password, email_confirm: true, user_metadata: { name }
    });
    if (createError) return json(res, 409, { error: createError.message });
    const { data, error } = await createSupabaseClient().auth.signInWithPassword({ email, password: body.password });
    if (error || !data.session) return json(res, 400, { error: error?.message || "Account created. Please sign in." });
    return json(res, 201, { user: normalizeUser(created.user) }, { "set-cookie": sessionCookies(data.session) });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const { data, error } = await createSupabaseClient().auth.signInWithPassword({ email: String(body.email || "").toLowerCase(), password: body.password || "" });
    if (error || !data.session) return json(res, 401, { error: error?.message || "Invalid email or password" });
    return json(res, 200, { user: normalizeUser(data.user) }, { "set-cookie": sessionCookies(data.session) });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    const auth = cookies(req);
    if (auth.relay_access) await supabase.auth.admin.signOut(auth.relay_access).catch(() => {});
    return json(res, 200, { ok: true }, { "set-cookie": [
      "relay_access=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      "relay_refresh=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    ] });
  }
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, { user });
  const oauthStart = url.pathname.match(/^\/api\/oauth\/(youtube|twitch)\/start$/);
  if (req.method === "GET" && oauthStart) {
    const platform = oauthStart[1];
    const origin = requestOrigin(req);
    const state = signState({ platform, userId: user.id, expiresAt: Date.now() + 10 * 60000 });
    if (platform === "youtube") {
      if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) return redirect(res, "/?oauth=youtube&error=YouTube%20OAuth%20is%20not%20configured%20in%20Vercel");
      const params = new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID, redirect_uri: `${origin}/api/oauth/youtube/callback`,
        response_type: "code", scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state
      });
      return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return redirect(res, "/?oauth=twitch&error=Twitch%20OAuth%20is%20not%20configured%20in%20Vercel");
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
    const { error } = await supabase.from("obs_agents").upsert({
      user_id: user.id, pairing_code_hash: hash(pairingCode), pairing_expires_at: new Date(Date.now() + 10 * 60000).toISOString(), updated_at: new Date().toISOString()
    });
    if (error) throw error;
    return json(res, 200, { pairingCode, expiresIn: 600 });
  }
  if (req.method === "GET" && url.pathname === "/api/obs/state") {
    const { data: agent, error } = await supabase.from("obs_agents").select("state_json,last_seen_at").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    const online = agent?.last_seen_at && Date.now() - new Date(agent.last_seen_at).getTime() < 10000;
    return json(res, 200, { online: Boolean(online), state: agent?.state_json || {} });
  }
  if (req.method === "POST" && url.pathname === "/api/obs/commands") {
    const body = await readBody(req);
    const allowed = new Set(["StartStream", "StopStream", "StartRecord", "StopRecord", "SetInputMute", "SetCurrentProgramScene"]);
    if (!allowed.has(body.requestType)) return json(res, 400, { error: "Unsupported OBS command" });
    const { data: command, error } = await supabase.from("obs_commands").insert({
      user_id: user.id, request_type: body.requestType, request_data: body.requestData || {}
    }).select("id,status").single();
    if (error) throw error;
    return json(res, 202, { command });
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
  if (req.method === "POST" && url.pathname === "/api/chat/send") {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    if (!message || message.length > 500) return json(res, 400, { error: "Message must contain 1 to 500 characters" });
    const settings = await getSettings(user.id);
    const requested = Array.isArray(body.platforms) ? body.platforms : ["youtube", "twitch"];
    const results = {};
    if (requested.includes("youtube") && settings.youtube?.refreshToken) {
      try {
        const accessToken = await refreshOAuthToken("youtube", settings);
        const { liveChatId } = await getYouTubeLiveChatId(settings.youtube);
        await apiFetch("https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ snippet: { liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: message } } })
        });
        results.youtube = { sent: true };
      } catch (error) { results.youtube = { sent: false, error: error.message }; }
    }
    if (requested.includes("twitch") && settings.twitch?.refreshToken) {
      try {
        const accessToken = await refreshOAuthToken("twitch", settings);
        const sent = await apiFetch("https://api.twitch.tv/helix/chat/messages", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Client-ID": process.env.TWITCH_CLIENT_ID, "content-type": "application/json" },
          body: JSON.stringify({ broadcaster_id: settings.twitch.userId, sender_id: settings.twitch.userId, message })
        });
        if (sent.data?.[0]?.is_sent === false) throw new Error(sent.data[0].drop_reason?.message || "Twitch rejected the message");
        results.twitch = { sent: true };
      } catch (error) { results.twitch = { sent: false, error: error.message }; }
    }
    await saveSettings(user.id, settings);
    if (!Object.values(results).some((result) => result.sent)) return json(res, 400, { error: Object.values(results)[0]?.error || "Connect YouTube or Twitch with OAuth first", results });
    return json(res, 200, { results });
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
    const message = /row-level security policy/i.test(error.message || "")
      ? "Supabase blocked this request. Set Vercel SUPABASE_SECRET_KEY to the server-side Secret key or legacy service_role key, then redeploy."
      : error.message || "Server error";
    json(res, 500, { error: message });
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
