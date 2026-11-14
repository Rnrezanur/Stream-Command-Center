# Stream Command Center

A zero-delay broadcast command center for OBS Studio control, 1-click platform auto-connect, multi-platform video syndication (upload once, publish everywhere), live viewer telemetry, and unified multi-platform chat. Runs locally with zero setup and deploys cleanly to Vercel through GitHub.

## Run Locally

Requires Node.js 20 or newer.

1. Install dependencies:

```bash
npm install
```

2. Optional: create `.env` from `.env.example` (set `APP_SECRET` to a random secret, and add `MONGODB_URI` if connecting to MongoDB locally; when `MONGODB_URI` is omitted, data persists to built-in zero-config storage in `data/local-dev.json`).
3. Start the server:

```bash
npm start
```

Open `http://127.0.0.1:4173`. When opening the dashboard from another device on your LAN, use the host computer's LAN address, such as `http://192.168.0.188:4173`.

`APP_SECRET` signs session cookies and encrypts saved platform credentials with AES-256-GCM.

---

## Deploy With GitHub And Vercel

Stream Command Center is designed to run on Vercel **out of the box with zero external dependencies required**, while seamlessly scaling to **MongoDB Atlas** when configured.

### Zero-Config Vercel Deploy (Instant)

1. Open [Vercel New Project](https://vercel.com/new).
2. Import your GitHub repository (`Rnrezanur/Stream-Command-Center`).
3. Set Environment Variable:
   - `APP_SECRET` = any random 32+ character string
4. Click **Deploy**. The app works immediately without throwing errors.

### Persistent MongoDB Atlas Database (Recommended for Cloud)

If you want persistent data across Vercel serverless cold starts:

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Copy your connection string (`MONGODB_URI`).
3. In Atlas **Network Access**, allow access from `0.0.0.0/0` (for dynamic Vercel cloud IPs).
4. In Vercel Project Settings > **Environment Variables**, add:

```text
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=stream_command_center
APP_SECRET=long-random-application-secret
```

5. Redeploy. All collections (`users`, `platform_settings`, `obs_agents`, `obs_commands`, `videos`) and their indexes are created automatically on the first request.

Visit `/api/health` on your deployed domain to verify `ok: true`.

---

## 📹 OmniPublish: Multi-Platform Video Syndication

Upload or drag & drop a single video file to publish and syndicate it simultaneously across:

- **YouTube** (HD 1080p Video, VOD & Shorts eligible)
- **Facebook** (Page Watch & Reels)
- **Twitch** (Highlights & Channel VODs)
- **TikTok** (Vertical Shorts with auto `#Shorts` tags)
- **Instagram** (Reels syndication)
- **X (Twitter)** (Broadcast Video Tweet)

### Features of the Video Publisher:
1. **Interactive Video Preview**: Plays selected video locally with resolution, duration, and file size detection.
2. **Automatic Frame Thumbnail Capture**: Generates a thumbnail image directly from the video frame using canvas.
3. **Target Platform Matrix**: Choose which platforms to syndicate to with interactive toggles.
4. **Live Progress Tracking**: Real-time progress bars for each platform with direct clickable links (`View on YouTube ↗`, `View on Facebook ↗`, etc.) once published.
5. **Published History**: Review, open, or delete previously syndicated videos directly from the dashboard.

---

## Features

- **Zero-Config Vercel Deployment**: No crash if `MONGODB_URI` is not provided; automatically runs in resilient zero-config storage mode, and upgrades to MongoDB Atlas when `MONGODB_URI` is added.
- **OmniPublish Multi-Platform Video Syndication**: Upload one video to publish simultaneously to YouTube, Facebook, Twitch, TikTok, Instagram & X.
- **1-Click Launch & Auto-Connect**: Launch into the Command Center in one click and auto-connect YouTube Live, Twitch, and Facebook Live channels instantly.
- **Zero-Delay Optimistic Controls**: Instant visual feedback for Stream, Record, Mic Mute, Scene Switching, and Multi-Platform Chat.
- **Encrypted Credentials & Secure Sessions**: AES-256-GCM encryption for API/OAuth secrets, `scrypt` password hashing, and signed `HttpOnly` cookies.
- **OBS WebSocket 5.x Integration**: Direct local WebSocket connection and remote HTTPS agent support.
- **Unified Multi-Platform Chat**: Filter comments across YouTube, Twitch, and Facebook, and broadcast replies directly from the command center.

---

## OBS Setup

1. Open OBS Studio.
2. Open **Tools > WebSocket Server Settings**.
3. Enable the server, use port `4455`, and set a password (optional).
4. Click **Connect OBS** in the dashboard (it also auto-attempts `ws://127.0.0.1:4455` on sign-in).
5. For another device on the LAN, use the OBS computer's address, such as `ws://192.168.0.188:4455`.

### Hosted OBS Remote Agent (For HTTPS / Vercel)

When accessing the dashboard over HTTPS, browser security blocks direct unencrypted `ws://` to local IPs. The included lightweight agent solves this:

1. Click **Connect Remote OBS** in the deployed dashboard.
2. Generate a pairing code.
3. Paste and run the single command in PowerShell on your streaming PC:
   ```powershell
   irm https://your-domain.vercel.app/obs-agent.js -OutFile obs-agent.js; $env:RELAY_URL="https://your-domain.vercel.app"; $env:PAIRING_CODE="YOUR_CODE"; node obs-agent.js
   ```

---

## Platform Setup (Manual / Custom API)

Sign in, then click **Configure** on any platform card or open **Platform Settings**:

- **YouTube**: API key or Google OAuth (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`), Channel ID.
- **Twitch**: Client ID, OAuth or App Access Token (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`), Channel name.
- **Facebook**: Page Access Token, Page ID, Graph API version (`v24.0`).
