/**
 * Rate limiting for the SPA-facing `/api` routes, backed by the Cloudflare
 * Workers rate-limiting binding (the `ratelimits` block in wrangler.jsonc).
 *
 * Two limiters, because there are two different costs to bound:
 *
 *   - `API_RATE_LIMITER`, keyed on client IP, caps how fast any one caller can
 *     drive the Worker itself. Applied to every `/api` route, ahead of auth.
 *   - `SLACK_API_RATE_LIMITER`, keyed on team id, caps how fast one workspace
 *     can burn its own Slack API quota — no matter how many IPs its callers
 *     spread across. Applied once a request is authenticated to a workspace,
 *     so it covers every route that calls Slack with that workspace's token.
 *
 * Both bindings are optional. A fork that hasn't copied the `ratelimits` block
 * into its own wrangler.jsonc still boots and serves traffic; it runs
 * unthrottled and says so in the logs, rather than 500ing on every request.
 */

/** Matches `simple.period` on both limiters in wrangler.jsonc. */
const RETRY_AFTER_SECONDS = 60;

const warnedBindings = new Set<string>();

function warnUnbound(bindingName: string): void {
  if (warnedBindings.has(bindingName)) return;
  warnedBindings.add(bindingName);
  console.warn(
    `[rate-limit] ${bindingName} is not bound — these requests are unthrottled. ` +
      "Copy the `ratelimits` block from wrangler.jsonc into your config.",
  );
}

/**
 * Client IP as Cloudflare sees it. The edge sets (and overwrites) this header
 * on every request, so a caller can't rotate their own bucket by forging it.
 * Deliberately no `X-Forwarded-For` fallback: that header *is* caller-supplied,
 * and keying on it would hand out a fresh budget per request. Off the edge
 * (`vite dev`, `wrangler dev`) the header is absent and every request shares
 * the one `local` bucket — the limit still applies, it's just not per-caller.
 */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}

/**
 * Charge one request against `limiter` under `key`. Returns a 429 Response to
 * send back when the caller is over budget, or `null` when it may proceed.
 */
export async function enforceRateLimit(
  limiter: RateLimit | undefined,
  bindingName: string,
  key: string,
): Promise<Response | null> {
  if (!limiter) {
    warnUnbound(bindingName);
    return null;
  }
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return Response.json(
    { ok: false, error: "Rate limit exceeded — wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(RETRY_AFTER_SECONDS) } },
  );
}
