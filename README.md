# Stream Command Center

A zero-delay broadcast command center for OBS Studio control, user accounts, 1-click platform auto-connect, encrypted platform settings, live viewer telemetry, and unified multi-platform chat. Runs locally (with zero external setup or with MongoDB) and deploys cleanly to Vercel through GitHub.

## Run Locally

Requires Node.js 20 or newer.

1. Install dependencies:

```bash
npm install
```

2. Optional: create `.env` from `.env.example` (set `APP_SECRET` to a long random secret, and add `MONGODB_URI` if connecting to MongoDB locally; when `MONGODB_URI` is omitted locally, data persists to ignored `data/local-dev.json`).
3. Start the server:

```bash
npm start
```

Open `http://127.0.0.1:4173`. When opening the dashboard from another device on your LAN, use the host computer's LAN address, such as `http://192.168.0.188:4173`.

`APP_SECRET` signs session cookies and encrypts saved platform credentials with AES-256-GCM. Use the same value every time the server starts.

## Deploy With GitHub And Vercel

The hosted application uses **MongoDB** (e.g., MongoDB Atlas) for users, encrypted platform settings, remote OBS agent pairing, and command queues, with self-contained `scrypt` password hashing and HMAC-SHA256 `HttpOnly` session cookies.

### 1. Create A MongoDB Database

1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create a database user and copy your connection string (`MONGODB_URI`).
3. In Atlas **Network Access**, allow access from Vercel (or `0.0.0.0/0` if using dynamic Vercel IPs).
4. Collections (`users`, `platform_settings`, `obs_agents`, `obs_commands`) and their indexes are created automatically on first request.

Required environment variables for Vercel:

```text
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=stream_command_center
APP_SECRET=long-random-application-secret
YOUTUBE_CLIENT_ID=your-google-oauth-client-id
YOUTUBE_CLIENT_SECRET=your-google-oauth-client-secret
TWITCH_CLIENT_ID=your-twitch-app-client-id
TWITCH_CLIENT_SECRET=your-twitch-app-client-secret
```

Keep `APP_SECRET` unchanged after deploying. It encrypts saved platform credentials and signs user sessions.

Visit `/api/health` on the deployed domain to verify `ok: true` and `database: "mongodb"`.

### 2. Push To GitHub

```bash
git add .
git commit -m "Prepare Stream Command Center for deployment"
git branch -M main
git push -u origin main
```

Do not commit `.env`, `data/`, API tokens, OBS passwords, or platform credentials.

### 3. Import Into Vercel

1. Open [Vercel New Project](https://vercel.com/new).
2. Import the GitHub repository.
3. Keep the framework preset as **Other**.
4. Add `APP_SECRET`, `MONGODB_URI`, and `MONGODB_DB` (plus optional OAuth keys) as Environment Variables.
5. Click **Deploy**.

The included `vercel.json` routes `/api/*` to the Node Vercel Function. Static dashboard assets are served directly by Vercel.

### YouTube And Twitch OAuth

OAuth lets the dashboard read channel broadcasts and send messages as the connected YouTube channel and Twitch account.

1. In Google Cloud, enable **YouTube Data API v3** and create a Web application OAuth client. Add `https://your-domain/api/oauth/youtube/callback` as an authorized redirect URI.
2. In the Twitch Developer Console, create an application and add `https://your-domain/api/oauth/twitch/callback` as its OAuth redirect URL.
3. Add the four OAuth environment variables shown above to Vercel (or `.env`), then redeploy/restart.
4. Open **Platform Settings** and click **Connect with Google / YouTube** or **Connect with Twitch Account** (or use **⚡ Auto-Connect** in the dashboard for instant zero-config multi-stream testing).

### Hosted OBS Remote Agent

The hosted HTTPS dashboard can control local OBS through the included local agent (`obs-agent.js`). The agent makes outbound HTTPS requests to the server and connects locally to OBS, so port `4455` is never exposed to the internet.

1. Open the deployed dashboard and click **Connect Remote OBS** (when accessed over `https://`).
2. Generate a one-time pairing code.
3. On the OBS computer, paste and run the single PowerShell command shown by the dashboard (or run `npm run agent` locally with `RELAY_URL` and `PAIRING_CODE`).

Never expose OBS WebSocket port `4455` directly to the public internet.

## Features

- **MongoDB + Local Dev Fallback**: Full MongoDB Atlas backend for cloud hosting, plus zero-config `data/local-dev.json` fallback locally.
- **1-Click Launch & Auto-Connect**: Launch into the Command Center in one click and auto-connect YouTube Live, Twitch, and Facebook Live channels instantly.
- **Zero-Delay Optimistic Controls**: Instant visual feedback for Stream, Record, Mic Mute, Scene Switching, and Multi-Platform Chat.
- **Encrypted Credentials & Secure Sessions**: AES-256-GCM encryption for API/OAuth secrets, `scrypt` password hashing, and signed `HttpOnly` cookies.
- **OBS WebSocket 5.x Integration**: Local WebSocket control and remote HTTPS agent support.
- **Unified Multi-Platform Chat**: Filter comments across YouTube, Twitch, and Facebook, and broadcast replies directly from the command center.

## OBS Setup

1. Open OBS Studio.
2. Open **Tools > WebSocket Server Settings**.
3. Enable the server, use port `4455`, and set a password (optional).
4. Click **Connect OBS** in the dashboard (it also auto-attempts `ws://127.0.0.1:4455` on sign-in).
5. For another device on the LAN, use the OBS computer's address, such as `ws://192.168.0.188:4455`.

## Platform Setup (Manual / Custom API)

Sign in, then click **Configure** on any platform card or open **Platform Settings**:

- **YouTube**: API key or Google OAuth, Channel ID, optional Video ID override.
- **Twitch**: Client ID, OAuth or App Access Token, Channel login name.
- **Facebook**: Page Access Token, Page ID, optional Live Video ID override, Graph API version (`v24.0`).

## Security Notes

- Platform credentials are encrypted at rest using `APP_SECRET`.
- Passwords are salted and hashed with Node `crypto.scryptSync`.
- Saved secret tokens are never returned to the browser after being stored.
- Before exposing publicly at scale, ensure HTTPS (provided by Vercel), strong `APP_SECRET`, rate limiting, and restrictive CORS/CSP policies.

## API Sources

- [YouTube Live Chat API](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list)
- [YouTube live viewer details](https://developers.google.com/youtube/v3/docs/videos)
- [Twitch Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams)
- [Twitch chat and IRC](https://dev.twitch.tv/docs/irc)
