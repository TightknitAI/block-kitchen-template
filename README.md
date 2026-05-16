# block-kit-builder Template

A Vite + React SPA on Cloudflare Workers that uses [block-kit-builder](https://github.com/TightknitAI/block-kit-builder) to compose Slack messages and post them via [slack-hono](https://github.com/TightknitAI/slack-hono) + [slack-web-api-client](https://github.com/slack-edge/slack-web-api-client). Validates every send against [slack-block-kit-validator](https://github.com/TightknitAI/slack-block-kit-validator) for defense in depth.

## What you get

- **A visual builder UI** at `/` — drag blocks, edit them in popovers, preview them in real time.
- **Bot OAuth** at `/slack/install` → `/slack/oauth_redirect` for installing the app into a workspace (bot token stored in KV).
- **User-token OAuth** at `/slack/user-install` → `/slack/user-oauth-redirect` for "send as me" support (user token stored in a separate KV).
- **Three Worker API routes** the SPA talks to:
  - `GET /api/slack/channels`
  - `GET /api/slack/me/can-send-as-user`
  - `POST /api/slack/messages/send` (validates blocks, picks bot vs user token, calls `chat.postMessage`)
- **A `/slack/events` ingress** wired through `slack-hono` — empty by default, ready for you to add slash commands, events, and actions.

## Development setup

You'll need a Slack workspace where you can install apps. Options:
- A workspace where you have admin rights
- A free Slack workspace ([create one](https://slack.com/create))
- The [Slack Developer Program sandbox](https://api.slack.com/developer-program)

### Prerequisites

- Node.js ≥ 20
- pnpm
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the dev tunnel
- A Cloudflare account (free)

### 1. Install

```sh
pnpm install
```

### 2. Create the KV namespaces

```sh
pnpm run setup:kv
```

Four namespaces are created:
- `SLACK_INSTALLATIONS` — bot tokens, keyed by team ID
- `SLACK_USER_INSTALLATIONS` — user tokens, keyed by `team_id:user_id`
- `SLACK_OAUTH_STATE` — short-lived OAuth state tokens
- `SLACK_MODAL_VIEWS` — composed modal view payloads (7-day TTL), keyed by short ID

Paste the IDs from the output into `wrangler.jsonc` (four placeholders).

### 3. Start the dev server with a tunnel

```sh
pnpm run dev:tunnel
```

Copy the tunnel URL from the output (e.g. `https://xxx-yyy-zzz.trycloudflare.com`).

> Quick tunnels generate a fresh URL every restart. For a fixed URL during dev, run `pnpm run setup:tunnel <hostname>` once (requires a domain on Cloudflare).

### 4. Create the Slack app

```sh
pnpm run setup:manifest https://xxx-yyy-zzz.trycloudflare.com
```

Updates `manifest.json` with your tunnel URL, copies it to your clipboard, and opens `api.slack.com/apps/new`. Choose **From an app manifest**, paste, **Next** → **Create**.

### 5. Configure local secrets

Grab **Signing Secret**, **Client ID**, **Client Secret** from your app's *Basic Information* page.

```sh
cp .dev.vars.example .dev.vars
# fill in the values
```

Restart the dev server to pick up the new secrets.

### 6. Install the bot

```sh
pnpm run install-app
```

Opens `/slack/install` on your tunnel. After OAuth completes, the app sets a workspace-identity cookie and redirects you to `/`, where the builder is ready to use.

Drag a header + section block into the canvas, click **Send**, pick a channel, hit confirm — your first Block Kit message lands in Slack.

> Stuck? Run `pnpm run setup:doctor` for a preflight that audits KV ids, `.dev.vars`, manifest URL substitution, interactivity, and bot scopes, and prints a punch list of what still needs doing.

## "Send as me" (user-token OAuth)

The builder's send dialog has a **Send as me** toggle. The first time you flip it on, the SPA detects you don't have a user token yet and shows a *Sign in with Slack* link — that takes you through a second OAuth round-trip (`/slack/user-install`) that issues a user token with `chat:write,im:write` scopes. After that round-trip, future sends with the toggle on are posted as you instead of the bot.

User tokens live in their own KV (`SLACK_USER_INSTALLATIONS`) keyed by `team_id:user_id`. Revoking happens by deleting the row.

## Production setup

### 1. Deploy

```sh
pnpm run deploy
```

Note your Worker URL from the output.

### 2. Update manifest URLs

Replace `YOUR_WORKER_URL` in `manifest.json` (or run `pnpm run setup:manifest https://<your-worker-url>`), then push the changes:

1. <https://api.slack.com/apps> → your app → **App Manifest**
2. Paste `manifest.json` → **Save Changes**

### 3. Configure production secrets

```sh
pnpm run setup:secrets
```

### 4. Logs

```sh
pnpm run logs
```

### 5. CI/CD

`.github/workflows/deploy.yml` auto-deploys on push to `main`. Set `CLOUDFLARE_API_TOKEN` in GitHub Secrets (create the token via [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with the "Edit Cloudflare Workers" template).

## How it works

```
                       ┌─────────────────────────────┐
                       │   block-kit-builder         │  React component, all UX
                       │   (npm package)             │
                       └──────────────┬──────────────┘
                                      │ loadChannels / loadSendAsUserStatus / onSend
                                      ▼
┌───────────────┐    fetch     ┌─────────────────────┐    chat.postMessage
│  React SPA    │ ◀──────────▶ │ Cloudflare Worker   │ ──────────────────────▶  Slack API
│  (Vite build) │              │ (Hono + slack-hono) │
└───────────────┘              └─────┬───────────────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │   KV stores  │  bot tokens, user tokens, OAuth state
                              └──────────────┘
```

The package never makes Slack API calls — the Worker does. The Worker validates every send against `slack-block-kit-validator` before it goes out. The SPA carries workspace identity in a cookie set during OAuth.

## Project structure

```
src/
  client/                — Vite React SPA (single page, mounts <BlockKitBuilder>)
    main.tsx
    App.tsx
    styles.css
  worker/                — Cloudflare Worker entry + OAuth helpers
    index.ts             — Hono app: /slack/install, /slack/*, /api/slack/*, asset fallback
    oauth.ts             — bot + user OAuth flow (state, code exchange)
    cookies.ts           — minimal cookie helpers
scripts/                 — setup helpers (manifest, secrets, tunnel, install)
manifest.json            — Slack app manifest
wrangler.jsonc           — Cloudflare Workers config (KV bindings, asset binding)
.dev.vars.example        — local secret template
.github/workflows/
  deploy.yml             — auto-deploy on push to main
```

## License

MIT. See [LICENSE](./LICENSE).

---

Built with [block-kit-builder](https://github.com/TightknitAI/block-kit-builder), [slack-hono](https://github.com/TightknitAI/slack-hono), and [slack-block-kit-validator](https://github.com/TightknitAI/slack-block-kit-validator). Maintained by the [Tightknit](https://tightknit.ai) team.
