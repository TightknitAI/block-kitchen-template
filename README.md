# block-kitchen Template

A Vite + React SPA on Cloudflare Workers that uses [block-kitchen](https://github.com/TightknitAI/block-kitchen) to compose Slack messages and post them via [slack-hono](https://github.com/TightknitAI/slack-hono) + [slack-web-api-client](https://github.com/slack-edge/slack-web-api-client). Validates every send against [slack-block-kit-validator](https://github.com/TightknitAI/slack-block-kit-validator) for defense in depth.

## What you get

- **A visual builder UI** at `/` — drag blocks, edit them in popovers, preview them in real time.
- **Bot OAuth** at `/slack/install` → `/slack/oauth_redirect` for installing the app into a workspace (bot token stored in KV).
- **User-token OAuth** at `/slack/user-install` → `/slack/user-oauth-redirect` for "send as me" support (user token stored in a separate KV).
- **Four Worker API routes** the SPA talks to, all rate limited (see [Rate limiting](#rate-limiting)):
  - `GET /api/slack/channels` → `{ channels, truncated }` (paging is capped — see [Channel loading](#channel-loading))
  - `GET /api/slack/emojis` (workspace custom emoji via `emoji.list`, normalized to `{ name, url, alias }[]`)
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

Five namespaces are created:
- `SLACK_INSTALLATIONS` — bot tokens, keyed by team ID
- `SLACK_USER_INSTALLATIONS` — user tokens, keyed by `team_id:user_id`
- `SLACK_OAUTH_STATE` — short-lived OAuth state tokens
- `SLACK_MODAL_VIEWS` — composed modal view payloads (7-day TTL), keyed by short ID
- `SLACK_SESSIONS` — server-side sessions that bind a browser to a workspace and user, keyed by an opaque session ID

Paste the IDs from the output into `wrangler.jsonc` (five placeholders).

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

## Workspace custom emoji

The builder's emoji picker and live preview resolve your workspace's custom emoji. On mount the SPA calls `GET /api/slack/emojis`, which proxies Slack's [`emoji.list`](https://api.slack.com/methods/emoji.list) (using the bot token) and normalizes the response into the shape block-kitchen's `customEmojis` prop expects:

```ts
type CustomEmoji = {
  name: string;         // codename between colons — `:partyparrot:` → "partyparrot"
  url: string | null;   // hosted image for a real custom emoji, null for an alias
  alias: string | null; // target codename when this entry aliases another, else null
};
```

Slack returns a `{ name: value }` map where `value` is either an image URL or `alias:<target>`; the worker splits that into the `url` / `alias` fields. The SPA hands the resulting array straight to `<BlockKitchen customEmojis={…} />` (see `src/client/App.tsx`) — a plain prop, resolved up front, rather than a lazy loader like `loadChannels` / `loadSendAsUserStatus` / `onSend`. With it set, the picker gains a **Custom** category and the preview renders `:custom:` directives as the workspace image (aliases fall back to their target).

The prop is optional and preview/picker-only — custom-emoji fields are never serialized into the emitted Block Kit JSON, and the builder works unchanged when the array is empty (e.g. before the app is installed). Sourcing emoji live from `emoji.list` needs the bot **`emoji:read`** scope, already declared in `manifest.json` and requested via `SLACK_BOT_SCOPES` in `wrangler.jsonc`. If you installed the app before this change, re-push the manifest and rerun `pnpm run install-app` so the new scope is granted.

## Rate limiting

Every `/api` route is throttled through Cloudflare's [Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding. Two limiters, declared in the `ratelimits` block of `wrangler.jsonc`, because there are two different costs to bound:

| Binding | Keyed on | Default | Bounds |
| --- | --- | --- | --- |
| `API_RATE_LIMITER` | client IP (`CF-Connecting-IP`) | 60 / min | How fast one caller can drive the Worker. Applied to every `/api` route, ahead of auth. |
| `SLACK_API_RATE_LIMITER` | Slack team id | 30 / min | How fast one workspace can burn its own Slack API quota. Applied to every route that calls Slack with that workspace's token. |

The per-IP limiter can't do the second job on its own — callers spread across many IPs still add up to one workspace's Slack quota — which is why the second one keys on the workspace instead.

Unlike KV, these need **no setup step**: `namespace_id` is just a label you pick, unique within the Worker, so the defaults work as-is on first deploy. Tune the numbers in `wrangler.jsonc` for your own traffic; `simple.period` accepts only `10` or `60` seconds. Throttled callers get a `429` with `Retry-After` and `{ ok: false, error }`.

If you're updating an existing fork and skip the `ratelimits` block, the Worker still boots and serves traffic — it just runs unthrottled and logs a warning once per isolate (see `src/worker/rate-limit.ts`).

## Channel loading

`GET /api/slack/channels` walks Slack's `conversations.list` cursor, but not forever: it stops after `CHANNELS_MAX_PAGES` (5) pages of 200, so a single request can never fan out into more than five Slack calls no matter how large the workspace is.

The response is an envelope rather than a bare array:

```jsonc
{
  "channels": [{ "id": "C123", "name": "general" }],
  "truncated": false  // true when Slack still had a cursor at the page cap
}
```

`truncated` exists so a partial list is visible rather than silent — the SPA surfaces a notice above the builder when it's set. 1,000 channels is comfortably above any real workspace; if yours is bigger, raise `CHANNELS_MAX_PAGES` in `src/worker/index.ts` (and expect the request to get slower), or switch the picker to server-side search.

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
                       │   block-kitchen             │  React component, all UX
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
  client/                — Vite React SPA (single page, mounts <BlockKitchen>)
    main.tsx
    App.tsx
    styles.css
  worker/                — Cloudflare Worker entry + OAuth helpers
    index.ts             — Hono app: /slack/install, /slack/*, /api/slack/*, asset fallback
    oauth.ts             — bot + user OAuth flow (state, code exchange)
    session.ts           — server-side sessions (opaque cookie id → identity in KV)
    rate-limit.ts        — per-IP and per-workspace throttles for the /api routes
    cookies.ts           — minimal cookie helpers
scripts/                 — setup helpers (manifest, secrets, tunnel, install)
manifest.json            — Slack app manifest
wrangler.jsonc           — Cloudflare Workers config (KV + rate limit bindings, asset binding)
.dev.vars.example        — local secret template
.github/workflows/
  deploy.yml             — auto-deploy on push to main
```

## License

MIT. See [LICENSE](./LICENSE).

---

Built with [block-kitchen](https://github.com/TightknitAI/block-kitchen), [slack-hono](https://github.com/TightknitAI/slack-hono), and [slack-block-kit-validator](https://github.com/TightknitAI/slack-block-kit-validator). Maintained by the [Tightknit](https://tightknit.ai) team.
