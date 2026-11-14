// =========================================================================
// Unified Multi-Platform Live Stream Chat Aggregator Engine
// Connects to YouTube Live, Twitch, Facebook Live, and Kick simultaneously
// Normalizes comments into unified format and broadcasts in real-time via Socket.io
// =========================================================================

const { WebSocket } = require("ws");

function normalizeComment({ id, platform, username, avatar, message, badges = [], timestamp }) {
  return {
    id: String(id || `${platform}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    platform: String(platform || "stream").toLowerCase(),
    username: String(username || "Viewer").trim(),
    avatar: avatar || null,
    message: String(message || "").trim(),
    badges: Array.isArray(badges) ? badges : (badges ? [badges] : []),
    timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
  };
}

class ChatAggregatorEngine {
  constructor() {
    this.io = null;
    this.userSessions = new Map(); // userId -> { active: boolean, workers: Map, seenIds: Set, comments: [], pinnedComment: null }
    this.refreshOAuthCallback = null;
    this.saveSettingsCallback = null;
  }

  setSocketIO(io) {
    this.io = io;
  }

  setCallbacks({ refreshOAuth, saveSettings }) {
    this.refreshOAuthCallback = refreshOAuth;
    this.saveSettingsCallback = saveSettings;
  }

  getUserChat(userId) {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, {
        active: true,
        workers: new Map(),
        seenIds: new Set(),
        comments: [],
        pinnedComment: null
      });
    }
    return this.userSessions.get(userId);
  }

  broadcastComment(userId, rawComment) {
    const session = this.getUserChat(userId);
    const comment = normalizeComment(rawComment);

    if (session.seenIds.has(comment.id)) return;
    session.seenIds.add(comment.id);

    // Keep seenIds bounded
    if (session.seenIds.size > 2000) {
      const arr = Array.from(session.seenIds);
      session.seenIds = new Set(arr.slice(-1000));
    }

    session.comments.push(comment);
    if (session.comments.length > 300) {
      session.comments = session.comments.slice(-300);
    }

    // Broadcast in real-time via Socket.io
    if (this.io) {
      this.io.to(`user:${userId}`).emit("chat_message", comment);
      this.io.emit("live_chat_event", { userId, comment }); // general room fallback
    }
  }

  syncUserPlatforms(userId, settings = {}) {
    const session = this.getUserChat(userId);

    // 1. YouTube Live Chat Worker
    if (settings.youtube?.autoConnected) {
      this.startYouTubeWorker(userId, settings.youtube);
    } else {
      this.stopWorker(userId, "youtube");
    }

    // 2. Twitch Live Chat Worker
    if (settings.twitch?.autoConnected && (settings.twitch.channel || settings.twitch.accountName)) {
      this.startTwitchWorker(userId, settings.twitch);
    } else {
      this.stopWorker(userId, "twitch");
    }

    // 3. Facebook Live Chat Worker
    if (settings.facebook?.autoConnected && settings.facebook.accessToken) {
      this.startFacebookWorker(userId, settings.facebook);
    } else {
      this.stopWorker(userId, "facebook");
    }

    // 4. Kick Live Chat Worker
    if (settings.kick?.autoConnected && (settings.kick.channel || settings.kick.handle)) {
      this.startKickWorker(userId, settings.kick);
    } else {
      this.stopWorker(userId, "kick");
    }
  }

  stopWorker(userId, platform) {
    const session = this.getUserChat(userId);
    const worker = session.workers.get(platform);
    if (worker) {
      if (typeof worker.stop === "function") worker.stop();
      if (worker.socket && typeof worker.socket.close === "function") worker.socket.close();
      if (worker.timer) clearInterval(worker.timer);
      session.workers.delete(platform);
    }
  }

  stopAll(userId) {
    const session = this.getUserChat(userId);
    for (const platform of session.workers.keys()) {
      this.stopWorker(userId, platform);
    }
  }

  // -----------------------------------------------------------------------
  // 1. YouTube Live Chat Ingestion (OAuth 2.0 / API v3)
  // -----------------------------------------------------------------------
  startYouTubeWorker(userId, ytSettings) {
    const session = this.getUserChat(userId);
    if (session.workers.has("youtube")) return;

    let stopped = false;
    let nextPageToken = null;
    let pollingIntervalMs = 5000;
    let timer = null;

    const pollMessages = async () => {
      if (stopped) return;
      try {
        let accessToken = ytSettings.accessToken;

        // Auto-refresh token if expiring
        if (ytSettings.refreshToken && (!accessToken || Number(ytSettings.tokenExpiresAt || 0) <= Date.now() + 60000)) {
          if (this.refreshOAuthCallback) {
            accessToken = await this.refreshOAuthCallback("youtube", ytSettings, userId);
          }
        }

        if (!accessToken && !ytSettings.apiKey) return;

        // Find active liveChatId if not known
        if (!ytSettings.liveChatId) {
          try {
            const authHeader = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
            const keySuffix = accessToken ? "" : `&key=${encodeURIComponent(ytSettings.apiKey || "")}`;
            
            // Check broadcast
            const broadcastRes = await fetch(
              `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all${keySuffix}`,
              { headers: authHeader }
            );
            const broadcastJson = await broadcastRes.json();
            const activeBroadcast = broadcastJson.items?.[0];
            if (activeBroadcast?.snippet?.liveChatId) {
              ytSettings.liveChatId = activeBroadcast.snippet.liveChatId;
            }
          } catch (_) {}
        }

        if (!ytSettings.liveChatId) return;

        // Poll chat messages
        const authHeader = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
        const keySuffix = accessToken ? "" : `&key=${encodeURIComponent(ytSettings.apiKey || "")}`;
        const pageParam = nextPageToken ? `&pageToken=${encodeURIComponent(nextPageToken)}` : "";

        const chatRes = await fetch(
          `https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet,authorDetails&liveChatId=${encodeURIComponent(ytSettings.liveChatId)}${pageParam}&maxResults=100${keySuffix}`,
          { headers: authHeader }
        );
        const chatData = await chatRes.json();

        if (chatData.pollingIntervalMillis) {
          pollingIntervalMs = Math.max(2500, Math.min(10000, chatData.pollingIntervalMillis));
        }
        if (chatData.nextPageToken) {
          nextPageToken = chatData.nextPageToken;
        }

        for (const item of chatData.items || []) {
          const author = item.authorDetails || {};
          const snippet = item.snippet || {};

          const badges = [];
          if (author.isChatOwner) badges.push("broadcaster");
          if (author.isChatModerator) badges.push("mod");
          if (author.isChatSponsor) badges.push("sponsor");
          if (author.isVerified) badges.push("verified");

          this.broadcastComment(userId, {
            id: item.id,
            platform: "youtube",
            username: author.displayName || "YouTube User",
            avatar: author.profileImageUrl || null,
            message: snippet.displayMessage || snippet.textMessageDetails?.messageText || "",
            badges,
            timestamp: snippet.publishedAt || new Date().toISOString()
          });
        }
      } catch (_) {}

      if (!stopped) {
        timer = setTimeout(pollMessages, pollingIntervalMs);
      }
    };

    timer = setTimeout(pollMessages, 1000);
    session.workers.set("youtube", {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      }
    });
  }

  // -----------------------------------------------------------------------
  // 2. Twitch Live Chat Ingestion (WebSocket IRC)
  // -----------------------------------------------------------------------
  startTwitchWorker(userId, twitchSettings) {
    const session = this.getUserChat(userId);
    if (session.workers.has("twitch")) return;

    const channel = (twitchSettings.channel || twitchSettings.accountName || "streamer").toLowerCase().replace(/^#/, "");
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

    ws.on("open", () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n");
      if (twitchSettings.accessToken) {
        ws.send(`PASS oauth:${twitchSettings.accessToken}\r\n`);
        ws.send(`NICK ${channel}\r\n`);
      } else {
        ws.send("PASS SCHMOOPIIE\r\n");
        ws.send(`NICK justinfan${Math.floor(Math.random() * 80000 + 1000)}\r\n`);
      }
      ws.send(`JOIN #${channel}\r\n`);
    });

    ws.on("message", (data) => {
      const text = data.toString();
      if (text.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv\r\n");
        return;
      }

      for (const line of text.split("\r\n")) {
        if (!line.includes("PRIVMSG")) continue;

        // Parse IRC tags: @badges=...;display-name=...;id=... :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
        const tagMatch = line.match(/^@([^ ]+) :[^!]+![^@]+@[^ ]+ PRIVMSG #[^ ]+ :(.+)$/);
        if (!tagMatch) continue;

        const rawTags = tagMatch[1];
        const messageText = tagMatch[2];
        const tags = {};
        for (const pair of rawTags.split(";")) {
          const [k, v] = pair.split("=");
          tags[k] = v;
        }

        const badges = [];
        if (tags.badges) {
          for (const b of tags.badges.split(",")) {
            const badgeName = b.split("/")[0];
            if (badgeName === "broadcaster") badges.push("broadcaster");
            else if (badgeName === "moderator") badges.push("mod");
            else if (badgeName === "subscriber") badges.push("subscriber");
            else if (badgeName === "vip") badges.push("vip");
            else if (badgeName) badges.push(badgeName);
          }
        }

        this.broadcastComment(userId, {
          id: tags.id || `twitch_${Date.now()}_${Math.random()}`,
          platform: "twitch",
          username: tags["display-name"] || tags.login || "Twitch User",
          avatar: null,
          message: messageText,
          badges,
          timestamp: tags["tmi-sent-ts"] ? new Date(Number(tags["tmi-sent-ts"])).toISOString() : new Date().toISOString()
        });
      }
    });

    ws.on("error", () => {});
    ws.on("close", () => {
      // Reconnect if session is still active
      if (session.workers.has("twitch")) {
        session.workers.delete("twitch");
        setTimeout(() => this.startTwitchWorker(userId, twitchSettings), 5000);
      }
    });

    session.workers.set("twitch", {
      socket: ws,
      stop: () => {
        session.workers.delete("twitch");
        ws.close();
      }
    });
  }

  // -----------------------------------------------------------------------
  // 3. Facebook Live Comments Ingestion (Graph API)
  // -----------------------------------------------------------------------
  startFacebookWorker(userId, fbSettings) {
    const session = this.getUserChat(userId);
    if (session.workers.has("facebook")) return;

    let stopped = false;
    let timer = null;
    const version = fbSettings.graphVersion || "v24.0";

    const pollFacebookComments = async () => {
      if (stopped) return;
      try {
        const accessToken = fbSettings.pageAccessToken || fbSettings.accessToken;
        if (!accessToken) return;

        let liveVideoId = fbSettings.liveVideoId;

        // Auto-detect live broadcast ID if Page ID is set
        if (!liveVideoId && fbSettings.pageId) {
          try {
            const liveRes = await fetch(
              `https://graph.facebook.com/${version}/${encodeURIComponent(fbSettings.pageId)}/live_videos?fields=id,status&limit=5&access_token=${encodeURIComponent(accessToken)}`
            );
            const liveJson = await liveRes.json();
            const active = liveJson.data?.find((v) => ["LIVE", "LIVE_NOW"].includes(v.status));
            if (active?.id) liveVideoId = active.id;
          } catch (_) {}
        }

        if (liveVideoId) {
          const commentsRes = await fetch(
            `https://graph.facebook.com/${version}/${encodeURIComponent(liveVideoId)}/comments?fields=id,from{name,picture},message,created_time&order=reverse_chronological&limit=50&access_token=${encodeURIComponent(accessToken)}`
          );
          const commentsJson = await commentsRes.json();

          for (const item of commentsJson.data || []) {
            this.broadcastComment(userId, {
              id: item.id,
              platform: "facebook",
              username: item.from?.name || "Facebook User",
              avatar: item.from?.picture?.data?.url || null,
              message: item.message || "",
              badges: ["facebook"],
              timestamp: item.created_time || new Date().toISOString()
            });
          }
        }
      } catch (_) {}

      if (!stopped) {
        timer = setTimeout(pollFacebookComments, 4000);
      }
    };

    timer = setTimeout(pollFacebookComments, 1000);
    session.workers.set("facebook", {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      }
    });
  }

  // -----------------------------------------------------------------------
  // 4. Kick Live Chat Ingestion (Pusher WebSocket Gateway)
  // -----------------------------------------------------------------------
  async startKickWorker(userId, kickSettings) {
    const session = this.getUserChat(userId);
    if (session.workers.has("kick")) return;

    const channelSlug = String(kickSettings.channel || kickSettings.handle || "streamer").toLowerCase().replace(/^@/, "");
    let chatroomId = kickSettings.chatroomId || null;

    // Resolve chatroom ID if needed
    if (!chatroomId) {
      try {
        const resp = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channelSlug)}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.chatroom?.id) {
            chatroomId = data.chatroom.id;
            kickSettings.chatroomId = chatroomId;
          }
        }
      } catch (_) {}
    }

    // Default or fallback chatroom ID if API fails or protected
    if (!chatroomId) {
      chatroomId = channelSlug;
    }

    // Connect to Kick's Pusher cluster (us2) with verified public app key
    const pusherAppKey = process.env.KICK_PUSHER_KEY || "34bf7a0ff419a2a775b9";
    const pusherWsUrl = `wss://ws-us2.pusher.com/app/${pusherAppKey}?protocol=7&client=js&version=8.4.0&flash=false`;

    let ws = null;
    let pingInterval = null;

    try {
      ws = new WebSocket(pusherWsUrl);
    } catch (_) {
      return;
    }

    ws.on("open", () => {
      // Send Pusher subscribe to chatroom channel
      const subscribePayload = JSON.stringify({
        event: "pusher:subscribe",
        data: { auth: "", channel: `chatrooms.${chatroomId}.v2` }
      });
      ws.send(subscribePayload);

      // Keepalive ping
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "pusher:ping", data: {} }));
        }
      }, 30000);
    });

    ws.on("message", (rawData) => {
      try {
        const payload = JSON.parse(rawData.toString());
        if (payload.event === "App\\Events\\ChatMessageEvent") {
          const chatData = typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data;
          const sender = chatData.sender || {};
          const identity = sender.identity || {};

          const badges = [];
          if (identity.badges) {
            for (const b of identity.badges) {
              if (b.type) badges.push(b.type);
            }
          }

          this.broadcastComment(userId, {
            id: chatData.id || `kick_${Date.now()}_${Math.random()}`,
            platform: "kick",
            username: sender.username || "Kick Viewer",
            avatar: sender.profile_pic || null,
            message: chatData.content || "",
            badges,
            timestamp: chatData.created_at || new Date().toISOString()
          });
        }
      } catch (_) {}
    });

    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(pingInterval);
      if (session.workers.has("kick")) {
        session.workers.delete("kick");
        setTimeout(() => this.startKickWorker(userId, kickSettings), 6000);
      }
    });

    session.workers.set("kick", {
      socket: ws,
      stop: () => {
        session.workers.delete("kick");
        clearInterval(pingInterval);
        ws.close();
      }
    });
  }
}

const chatAggregator = new ChatAggregatorEngine();

module.exports = {
  chatAggregator,
  normalizeComment
};
