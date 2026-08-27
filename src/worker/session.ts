import type { Context } from "hono";
import { getCookie, setCookie } from "./cookies";

/**
 * Server-side sessions. The cookie holds only an opaque, random session id;
 * the workspace and user identity live in KV under that id. A client cannot
 * forge identity by editing the cookie, because the id must match a record we
 * minted at an OAuth callback.
 */

const SESSION_COOKIE = "bkb_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — matches the cookie Max-Age

export interface Session {
  team_id: string;
  user_id: string | null;
}

/** Mint a session, store the identity in KV, and set the opaque id as the cookie. */
export async function createSession(c: Context, kv: KVNamespace, session: Session): Promise<void> {
  const sessionId = crypto.randomUUID();
  await kv.put(sessionId, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  setCookie(c, SESSION_COOKIE, sessionId);
}

/** Load the session named by the request cookie, or null if the cookie is absent or unknown. */
export async function getSession(c: Context, kv: KVNamespace): Promise<Session | null> {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  const raw = await kv.get(sessionId);
  if (!raw) return null;
  return JSON.parse(raw) as Session;
}
