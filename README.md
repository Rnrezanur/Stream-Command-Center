# Stream Command Center

A full-stack dashboard for OBS control, user accounts, saved platform settings, live viewer counts, and unified comments. It can run locally or deploy to Vercel through GitHub.

## Run

Requires Node.js 24 or newer.

```powershell
$env:APP_SECRET="replace-with-a-long-random-secret"
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SECRET_KEY="your-supabase-secret-key"
npm start
```

Open `http://127.0.0.1:4173`. When opening the dashboard from another device, use the server computer's LAN address, such as `http://192.168.0.188:4173`.

`APP_SECRET` encrypts saved platform credentials. Use the same value every time the server starts.

## Deploy With GitHub And Vercel

The hosted application uses Supabase Auth and PostgreSQL.

### 1. Create A Supabase Project

1. Create a project at [Supabase](https://supabase.com/dashboard).
2. Open **SQL Editor**, paste the contents of `supabase.sql`, and run it once.
3. Open the project's **Connect** dialog or **Settings > API Keys**.
4. Copy the Project URL and the server-side Secret key. Legacy projects can use the `service_role` key.

Accounts created before this Supabase migration are not migrated automatically. Create new accounts after switching to Supabase.

Required environment variables:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-secret-or-service-role-key
APP_SECRET=long-random-application-secret
```

Keep `APP_SECRET` unchanged after deploying. It encrypts saved platform credentials. Never expose `SUPABASE_SECRET_KEY` in browser code.

The server also accepts the legacy variable name `SUPABASE_SERVICE_ROLE_KEY`. After adding or changing Vercel environment variables, redeploy the project. Visit `/api/health` on the deployed domain to verify the function configuration.

### 2. Push To GitHub

```powershell
git add .
git commit -m "Prepare Stream Command Center for deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Do not commit `.env`, `data/`, API tokens, OBS passwords, or platform credentials.

### 3. Import Into Vercel

1. Open [Vercel New Project](https://vercel.com/new).
2. Import the GitHub repository.
3. Keep the framework preset as **Other**.
4. Add `APP_SECRET`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` as Environment Variables.
5. Click **Deploy**.

The included `vercel.json` routes `/api/*` to the Node Vercel Function. Static dashboard assets are served directly by Vercel.

### Hosted OBS Limitation

The hosted Vercel dashboard can control OBS through the included secure local agent. The agent makes outbound HTTPS requests to Vercel and connects locally to OBS, so port `4455` is never exposed to the internet.

1. Run the updated `supabase.sql` in Supabase SQL Editor.
2. Open the deployed dashboard and click **Connect Remote OBS**.
3. Generate a pairing code.
4. On the OBS computer, paste and run the single PowerShell command shown by the dashboard. It downloads, pairs, and starts the agent.
5. Keep `npm run agent` running while using remote OBS control.

The agent stores its pairing token and local OBS settings in ignored `data/obs-agent.json`. To configure a non-default local OBS connection before first pairing:

```powershell
$env:OBS_ADDRESS="ws://127.0.0.1:4455"
$env:OBS_PASSWORD="your-obs-websocket-password"
$env:OBS_MIC_INPUT="Mic/Aux"
```

Never expose OBS port `4455` directly to the internet.

Twitch viewer counts work on Vercel. Twitch public chat currently uses a persistent IRC WebSocket, which Vercel Functions cannot reliably keep alive; production Twitch chat requires a persistent worker service or Twitch EventSub implementation.

## Features

- Supabase Auth accounts with secure HTTP-only sessions
- Encrypted per-user platform settings
- OBS WebSocket 5.x scene, stream, recording, mute, and statistics controls
- YouTube concurrent viewers and live comments
- Twitch concurrent viewers and public chat
- Facebook Live viewers and comments
- Unified comments feed and platform filters

TikTok is intentionally not connected because TikTok does not provide a generally available supported public API for this live-chat use case.

## OBS

1. Open OBS Studio.
2. Open **Tools > WebSocket Server Settings**.
3. Enable the server, use port `4455`, and set a password.
4. Click **Connect OBS** in the dashboard.
5. For another device on the LAN, use the OBS computer's address, such as `ws://192.168.0.188:4455`.

Never expose OBS WebSocket port `4455` directly to the public internet.

## Platform Setup

Create an account in the dashboard, then open **Platform settings** using the comments settings button or a platform's three-dot menu.

### YouTube

Create a Google Cloud project, enable **YouTube Data API v3**, and create an API key.

Enter:

- YouTube API key
- YouTube channel ID
- Live video ID override is optional

The backend automatically searches the configured channel for its active live broadcast, then caches the detected video ID and discovers its active chat ID. YouTube search consumes additional API quota, so detection is not repeated while the cached broadcast remains active.

### Twitch

Register an application in the Twitch Developer Console and create an app access token.

Enter:

- Twitch Client ID
- App access token
- Channel login name, without the `@`

The backend gets viewer counts through Twitch Helix and reads public chat through Twitch IRC WebSocket.

### Facebook

Create a Meta app and obtain a Page access token with permissions that allow reading the Page's live video and comments.

Enter:

- Page access token
- Facebook Page ID
- Live video ID override is optional
- Graph API version

The backend automatically queries the Page's live videos and selects the active broadcast. Meta permissions and token availability depend on the Page, app mode, and Meta app review.

## Security Notes

- Platform credentials are encrypted at rest using `APP_SECRET`.
- Password authentication and password hashing are managed by Supabase Auth.
- Platform credentials are never returned to the browser after being saved.
- The `platform_settings` table has Row Level Security enabled and is accessed only through the server-side Supabase secret key.
- This is suitable for a private/local deployment foundation. Before exposing it publicly, add HTTPS, CSRF protection, rate limiting, email verification, password reset, and a production secrets manager.

## API Sources

- [YouTube Live Chat API](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list)
- [YouTube live viewer details](https://developers.google.com/youtube/v3/docs/videos)
- [Twitch Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams)
- [Twitch chat and IRC](https://dev.twitch.tv/docs/irc)
