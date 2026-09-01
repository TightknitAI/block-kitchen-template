import { Hono, type Context } from "hono";
import { SlackHonoApp } from "@tightknitai/slack-hono";
import { SlackAPIClient } from "slack-web-api-client";
import { validateBlockKit } from "@tightknitai/slack-block-kit-validator";
import {
  exchangeOAuthCode,
  generateOAuthState,
  startOAuth,
  validateOAuthState,
  type StoredBotInstallation,
  type StoredUserInstallation,
} from "./oauth";
import { createSession, getSession, type Session } from "./session";
import { clientIp, enforceRateLimit } from "./rate-limit";

type Bindings = {
  ASSETS: Fetcher;
  SLACK_INSTALLATIONS: KVNamespace;
  SLACK_USER_INSTALLATIONS: KVNamespace;
  SLACK_OAUTH_STATE: KVNamespace;
  SLACK_MODAL_VIEWS: KVNamespace;
  SLACK_SESSIONS: KVNamespace;
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_BOT_SCOPES: string;
  SLACK_USER_SCOPES: string;
  // Optional so a fork that hasn't copied the `ratelimits` block from
  // wrangler.jsonc still boots — see rate-limit.ts.
  API_RATE_LIMITER?: RateLimit;
  SLACK_API_RATE_LIMITER?: RateLimit;
};

// Stored modal view — what `/api/slack/modals/send` writes, what the
// open_modal block-action reads to feed `views.open`.
interface StoredModalView {
  team_id: string;
  user_id: string;
  blocks: unknown[];
  title: string;
  created_at: number;
}
const MODAL_VIEW_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MODAL_OPEN_ACTION_ID = "bkb_open_modal";
const MODAL_VIEW_CALLBACK_ID = "bkb_modal_v1";

type AppEnv = { Bindings: Bindings };

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Slack events (mounted via slack-hono).
//
// Multi-workspace authorize() resolves the bot token per request out of
// SLACK_INSTALLATIONS KV using the team.id on the payload. Registered
// listeners:
//   - block_actions:   "bkb_open_modal" → views.open with the stored view
//   - view_submission: "bkb_modal_v1"   → ack + DM a confirmation
// ---------------------------------------------------------------------------

app.all("/slack/events", async (c) => {
  const slack = new SlackHonoApp({
    env: { SLACK_SIGNING_SECRET: c.env.SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN: "" },
    authorize: async (req) => {
      const teamId = (req.body.team as { id?: string } | undefined)?.id
        ?? (req.body.team_id as string | undefined);
      if (!teamId) throw new Error("authorize: missing team id on payload");
      const raw = await c.env.SLACK_INSTALLATIONS.get(teamId);
      if (!raw) throw new Error(`authorize: no installation for team ${teamId}`);
      const install = JSON.parse(raw) as StoredBotInstallation;
      return {
        botToken: install.bot_token,
        botId: install.bot_user_id ?? "",
        botUserId: install.bot_user_id ?? "",
        botScopes: c.env.SLACK_BOT_SCOPES.split(","),
        teamId: install.team_id,
      };
    },
  });

  // Button on the DM nudge: pull the stored view by id and open the modal.
  slack.action(
    MODAL_OPEN_ACTION_ID,
    async () => {},
    async ({ context, payload }) => {
      const action = payload.actions[0];
      const viewId = action && "value" in action ? (action.value as string | undefined) : undefined;
      if (!viewId) return;
      const raw = await c.env.SLACK_MODAL_VIEWS.get(viewId);
      if (!raw) {
        await context.client.chat.postMessage({
          channel: payload.user.id,
          text: "This modal preview has expired. Compose a new one in the builder and try again.",
        });
        return;
      }
      const stored = JSON.parse(raw) as StoredModalView;
      await context.client.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: "modal",
          callback_id: MODAL_VIEW_CALLBACK_ID,
          title: { type: "plain_text", text: stored.title.slice(0, 24) },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: stored.blocks as never,
        },
      });
    },
  );

  // Submission: ack with an empty response (closes the modal) and DM the
  // submitter so they can see their values landed.
  slack.viewSubmission(
    MODAL_VIEW_CALLBACK_ID,
    async () => ({ response_action: "clear" }),
    async ({ context, payload }) => {
      const values = payload.view.state?.values ?? {};
      const summary = JSON.stringify(values, null, 2).slice(0, 2500);
      await context.client.chat.postMessage({
        channel: payload.user.id,
        text: `Modal submitted. Captured state:\n\`\`\`\n${summary}\n\`\`\``,
      });
    },
  );

  return await slack.run(c.req.raw, c.executionCtx);
});

// ---------------------------------------------------------------------------
// Bot OAuth — installs the app into a workspace, stores bot token in KV,
// sets a cookie identifying the workspace so the SPA can call /api/* with
// the right context.
// ---------------------------------------------------------------------------

app.get("/slack/install", async (c) => {
  const state = await generateOAuthState(c.env.SLACK_OAUTH_STATE, "bot");
  const redirectUri = `${new URL(c.req.url).origin}/slack/oauth_redirect`;
  return c.redirect(
    startOAuth({
      clientId: c.env.SLACK_CLIENT_ID,
      scope: c.env.SLACK_BOT_SCOPES,
      state,
      redirectUri,
    }),
  );
});

app.get("/slack/oauth_redirect", async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.text("Missing code or state", 400);

  const stateValid = await validateOAuthState(c.env.SLACK_OAUTH_STATE, "bot", state);
  if (!stateValid) return c.text("Invalid OAuth state", 400);

  const redirectUri = `${new URL(c.req.url).origin}/slack/oauth_redirect`;
  const tokenResponse = await exchangeOAuthCode({
    code,
    clientId: c.env.SLACK_CLIENT_ID,
    clientSecret: c.env.SLACK_CLIENT_SECRET,
    redirectUri,
  });

  if (!tokenResponse.ok || !tokenResponse.access_token || !tokenResponse.team?.id) {
    return c.text(`OAuth failed: ${tokenResponse.error ?? "unknown"}`, 400);
  }

  const installation: StoredBotInstallation = {
    team_id: tokenResponse.team.id,
    team_name: tokenResponse.team.name ?? null,
    bot_token: tokenResponse.access_token,
    bot_user_id: tokenResponse.bot_user_id ?? null,
    installed_at: Date.now(),
  };
  await c.env.SLACK_INSTALLATIONS.put(tokenResponse.team.id, JSON.stringify(installation));

  // Bind the workspace + installer to a server-side session for SPA calls
  await createSession(c, c.env.SLACK_SESSIONS, {
    team_id: tokenResponse.team.id,
    user_id: tokenResponse.authed_user?.id ?? null,
  });

  return c.redirect("/?installed=1");
});

// ---------------------------------------------------------------------------
// User-token OAuth — separate flow because user scopes are distinct from bot
// scopes. Lets the builder's "send as me" toggle post as the signed-in user.
// ---------------------------------------------------------------------------

app.get("/slack/user-install", async (c) => {
  const state = await generateOAuthState(c.env.SLACK_OAUTH_STATE, "user");
  const redirectUri = `${new URL(c.req.url).origin}/slack/user-oauth-redirect`;
  return c.redirect(
    startOAuth({
      clientId: c.env.SLACK_CLIENT_ID,
      userScope: c.env.SLACK_USER_SCOPES,
      state,
      redirectUri,
    }),
  );
});

app.get("/slack/user-oauth-redirect", async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.text("Missing code or state", 400);

  const stateValid = await validateOAuthState(c.env.SLACK_OAUTH_STATE, "user", state);
  if (!stateValid) return c.text("Invalid OAuth state", 400);

  const redirectUri = `${new URL(c.req.url).origin}/slack/user-oauth-redirect`;
  const tokenResponse = await exchangeOAuthCode({
    code,
    clientId: c.env.SLACK_CLIENT_ID,
    clientSecret: c.env.SLACK_CLIENT_SECRET,
    redirectUri,
  });

  const teamId = tokenResponse.team?.id;
  const userId = tokenResponse.authed_user?.id;
  const userToken = tokenResponse.authed_user?.access_token;
  if (!tokenResponse.ok || !teamId || !userId || !userToken) {
    return c.text(`User OAuth failed: ${tokenResponse.error ?? "unknown"}`, 400);
  }

  const installation: StoredUserInstallation = {
    team_id: teamId,
    user_id: userId,
    user_token: userToken,
    scopes: tokenResponse.authed_user?.scope ?? "",
    installed_at: Date.now(),
  };
  await c.env.SLACK_USER_INSTALLATIONS.put(`${teamId}:${userId}`, JSON.stringify(installation));

  await createSession(c, c.env.SLACK_SESSIONS, { team_id: teamId, user_id: userId });

  return c.redirect("/?user_installed=1");
});

// ---------------------------------------------------------------------------
// SPA-facing JSON API. Resolves workspace context from the server-side
// session bound at OAuth, never from client-supplied identity.
// ---------------------------------------------------------------------------

// Per-IP throttle across the whole SPA-facing API. Registered ahead of the
// routes so a flood is rejected before it costs a KV read, let alone a Slack
// call.
app.use("/api/*", async (c, next) => {
  const throttled = await enforceRateLimit(
    c.env.API_RATE_LIMITER,
    "API_RATE_LIMITER",
    clientIp(c.req.raw),
  );
  if (throttled) return throttled;
  await next();
});

interface AuthedRequest {
  session: Session;
  install: StoredBotInstallation;
}

const requireBotInstall = async (
  c: Context<AppEnv>,
): Promise<AuthedRequest | Response> => {
  const session = await getSession(c, c.env.SLACK_SESSIONS);
  if (!session) {
    return c.json({ ok: false, error: "Not installed yet — visit /slack/install" }, 401);
  }
  const raw = await c.env.SLACK_INSTALLATIONS.get(session.team_id);
  if (!raw) {
    return c.json({ ok: false, error: "Installation not found" }, 404);
  }
  // Every route behind this helper spends the workspace's Slack API quota, so
  // charge it against a per-workspace budget too. The per-IP limit above can't
  // do this job on its own — callers spread across many IPs still add up to
  // one workspace's quota.
  const throttled = await enforceRateLimit(
    c.env.SLACK_API_RATE_LIMITER,
    "SLACK_API_RATE_LIMITER",
    session.team_id,
  );
  if (throttled) return throttled;
  return { session, install: JSON.parse(raw) as StoredBotInstallation };
};

// Bound the `conversations.list` walk. 5 pages × 200 is 1,000 channels —
// comfortably above any real workspace, and it caps the Slack fan-out one
// request can trigger. When Slack still has a cursor at the cap we say so in
// the response instead of silently serving a partial picker.
const CHANNELS_PAGE_SIZE = 200;
const CHANNELS_MAX_PAGES = 5;

interface ChannelsResponse {
  channels: { id: string; name: string }[];
  truncated: boolean;
}

app.get("/api/slack/channels", async (c) => {
  const authed = await requireBotInstall(c);
  if (authed instanceof Response) return authed;
  const { install } = authed;

  const client = new SlackAPIClient(install.bot_token);
  const channels: ChannelsResponse["channels"] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await client.conversations.list({
      types: ["public_channel", "private_channel"],
      exclude_archived: true,
      limit: CHANNELS_PAGE_SIZE,
      cursor,
    });
    for (const ch of res.channels ?? []) {
      if (ch.id && ch.name) channels.push({ id: ch.id, name: ch.name });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    pages += 1;
  } while (cursor && pages < CHANNELS_MAX_PAGES);

  channels.sort((a, b) => a.name.localeCompare(b.name));
  const body: ChannelsResponse = { channels, truncated: Boolean(cursor) };
  return c.json(body);
});

// Workspace custom emoji, sourced live from Slack `emoji.list`. The template
// has no DB, so the live API is the natural source (vs. a synced table).
// Normalized to the `{ name, url, alias }[]` shape the builder's `customEmojis`
// prop expects — mirrors @tightknitai/block-kitchen's `CustomEmoji`, kept local
// so the worker stays decoupled from the client package:
//   - true custom emoji → { name, url: <image>, alias: null }
//   - alias of another  → { name, url: null,    alias: <target codename> }
// Requires the bot `emoji:read` scope.
interface CustomEmoji {
  name: string;
  url: string | null;
  alias: string | null;
}
const EMOJI_ALIAS_PREFIX = "alias:";

app.get("/api/slack/emojis", async (c) => {
  const authed = await requireBotInstall(c);
  if (authed instanceof Response) return authed;
  const { install } = authed;

  const client = new SlackAPIClient(install.bot_token);
  try {
    const res = await client.emoji.list();
    const emojis: CustomEmoji[] = Object.entries(res.emoji ?? {}).map(([name, value]) =>
      value.startsWith(EMOJI_ALIAS_PREFIX)
        ? { name, url: null, alias: value.slice(EMOJI_ALIAS_PREFIX.length) }
        : { name, url: value, alias: null },
    );
    emojis.sort((a, b) => a.name.localeCompare(b.name));
    return c.json(emojis);
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

app.get("/api/slack/me/can-send-as-user", async (c) => {
  const origin = new URL(c.req.url).origin;
  const oauthUrl = `${origin}/slack/user-install`;

  const session = await getSession(c, c.env.SLACK_SESSIONS);
  if (!session?.user_id) {
    return c.json({ canSendAsUser: false, oauthUrl });
  }
  const raw = await c.env.SLACK_USER_INSTALLATIONS.get(`${session.team_id}:${session.user_id}`);
  if (!raw) {
    return c.json({ canSendAsUser: false, oauthUrl });
  }
  return c.json({ canSendAsUser: true });
});

interface SendBody {
  channelId: string;
  blocks: unknown[];
  sendAsUser: boolean;
}

app.post("/api/slack/messages/send", async (c) => {
  const authed = await requireBotInstall(c);
  if (authed instanceof Response) return authed;
  const { install, session } = authed;

  const body = (await c.req.json()) as Partial<SendBody>;
  if (!body.channelId || !Array.isArray(body.blocks)) {
    return c.json({ ok: false, error: "channelId and blocks are required" }, 400);
  }

  const validation = validateBlockKit(body.blocks, { surface: "message" });
  if (!validation.valid) {
    return c.json({ ok: false, error: `Invalid blocks: ${validation.errors.join("; ")}` }, 400);
  }

  let token = install.bot_token;
  if (body.sendAsUser) {
    const userId = session.user_id;
    if (!userId) {
      return c.json({ ok: false, error: "Not signed in as user" }, 401);
    }
    const raw = await c.env.SLACK_USER_INSTALLATIONS.get(`${install.team_id}:${userId}`);
    if (!raw) {
      return c.json({ ok: false, error: "User token not found — install user OAuth first" }, 401);
    }
    const userInstall = JSON.parse(raw) as StoredUserInstallation;
    token = userInstall.user_token;
  }

  const client = new SlackAPIClient(token);
  try {
    await client.chat.postMessage({
      channel: body.channelId,
      blocks: body.blocks as never,
      text: "(Block Kit message — your client must support blocks to render this)",
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

interface SendModalBody {
  blocks: unknown[];
  title?: string;
}

// Builder doesn't "send" modals — Slack only opens views in response to an
// interaction. So this endpoint stores the composed view in KV and DMs the
// installer a one-button nudge; clicking that button opens the modal with
// a fresh trigger_id (handled by the bkb_open_modal action above).
app.post("/api/slack/modals/send", async (c) => {
  const authed = await requireBotInstall(c);
  if (authed instanceof Response) return authed;
  const { install, session } = authed;

  const userId = session.user_id;
  if (!userId) {
    return c.json({ ok: false, error: "Not signed in — reinstall the app via /slack/install" }, 401);
  }

  const body = (await c.req.json()) as Partial<SendModalBody>;
  if (!Array.isArray(body.blocks)) {
    return c.json({ ok: false, error: "blocks are required" }, 400);
  }

  const validation = validateBlockKit(body.blocks, { surface: "modal" });
  if (!validation.valid) {
    return c.json({ ok: false, error: `Invalid blocks: ${validation.errors.join("; ")}` }, 400);
  }

  const viewId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const stored: StoredModalView = {
    team_id: install.team_id,
    user_id: userId,
    blocks: body.blocks,
    title: (body.title ?? "Modal preview").trim() || "Modal preview",
    created_at: Date.now(),
  };
  await c.env.SLACK_MODAL_VIEWS.put(viewId, JSON.stringify(stored), {
    expirationTtl: MODAL_VIEW_TTL_SECONDS,
  });

  const client = new SlackAPIClient(install.bot_token);
  try {
    await client.chat.postMessage({
      channel: userId,
      text: "Your modal is ready — click Open to preview it.",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Your modal is ready.* Click *Open modal* to preview it in Slack." },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open modal" },
              style: "primary",
              action_id: MODAL_OPEN_ACTION_ID,
              value: viewId,
            },
          ],
        },
      ],
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Everything else — defer to the static-assets binding (the React SPA).
// `not_found_handling: "single-page-application"` in wrangler.jsonc makes
// the assets binding serve index.html for any unmatched route.
// ---------------------------------------------------------------------------

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
