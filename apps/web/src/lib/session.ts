import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  createSession,
  getSessionByTokenHash,
  renewSession,
  type ServerConfig,
} from "@odft/persistence";

/**
 * Anonymous session + CSRF (10-security-reliability.md section 2/4).
 *
 * The raw cookie token is never persisted; only its SHA-256 hash is stored. The
 * cookie is additionally HMAC-signed so a forged or truncated cookie is rejected
 * before any database lookup. Renewal is sliding and preserves the session id,
 * token hash, and CSRF derivation so concurrent tabs keep ownership.
 */

export const SESSION_COOKIE = "odft_session";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hmac(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** Store only a keyed HMAC-SHA-256 hash of the raw token, never the token. */
export function hashToken(token: string, config: ServerConfig): string {
  return createHmac("sha256", config.sessionHmacKey).update(`token:${token}`).digest("hex");
}

/** CSRF is derived per session so it is stable across renewals and tabs. */
export function deriveCsrf(sessionId: string, config: ServerConfig): string {
  return hmac(`csrf:${sessionId}`, config.sessionHmacKey);
}

function csrfHash(csrfToken: string): string {
  return createHash("sha256").update(csrfToken).digest("hex");
}

function signToken(token: string, config: ServerConfig): string {
  return hmac(`token:${token}`, config.sessionHmacKey);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly setCookie?: string;
}

export function serializeSessionCookie(
  value: string,
  maxAgeMs: number,
  config: ServerConfig,
): string {
  const secure = new URL(config.publicBaseUrl).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    maxAgeMs / 1000,
  )}${secure}`;
}

export function parseCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length > 0) {
      return rest.join("=");
    }
  }
  return undefined;
}

function decodeSessionCookie(
  raw: string,
  config: ServerConfig,
): { sessionId: string; token: string } | undefined {
  const parts = raw.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const [sessionId, token, signature] = parts as [string, string, string];
  if (!sessionId || !token || !signature || !safeEqual(signature, signToken(token, config))) {
    return undefined;
  }
  return { sessionId, token };
}

/**
 * Look up an existing, unexpired session from the request cookie. Sliding
 * renewal happens only for accepted writes / `POST /api/session` (`renew: true`);
 * GET and SSE reads pass `renew: false` so they never mutate session state.
 */
export async function resolveSession(
  pool: Pool,
  config: ServerConfig,
  cookieHeader: string | null,
  options: { renew?: boolean } = {},
): Promise<ResolvedSession | undefined> {
  const raw = parseCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) {
    return undefined;
  }
  const decoded = decodeSessionCookie(raw, config);
  if (!decoded) {
    return undefined;
  }
  const session = await getSessionByTokenHash(pool, hashToken(decoded.token, config));
  if (!session) {
    return undefined;
  }
  const renew = options.renew ?? true;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  if (renew) {
    await renewSession(pool, session.id, expiresAt);
  }
  return {
    sessionId: session.id,
    csrfToken: deriveCsrf(session.id, config),
    expiresAt: (renew ? expiresAt : session.expiresAt).toISOString(),
    // Refresh the cookie Max-Age on renewal so the browser keeps the token for
    // as long as the session is valid (sliding expiry, same secret).
    ...(renew ? { setCookie: serializeSessionCookie(raw, SESSION_TTL_MS, config) } : {}),
  };
}

/** Issue a fresh session and its signed cookie. */
export async function issueSession(pool: Pool, config: ServerConfig): Promise<ResolvedSession> {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const csrfToken = deriveCsrf(sessionId, config);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createSession(pool, {
    id: sessionId,
    tokenHash: hashToken(token, config),
    csrfTokenHash: csrfHash(csrfToken),
    expiresAt,
  });
  return {
    sessionId,
    csrfToken,
    expiresAt: expiresAt.toISOString(),
    setCookie: serializeSessionCookie(`${sessionId}.${token}.${signToken(token, config)}`, SESSION_TTL_MS, config),
  };
}

/** Constant-time CSRF verification against the value derived for the session. */
export function verifyCsrf(
  session: { sessionId: string },
  provided: string | null,
  config: ServerConfig,
): boolean {
  if (!provided) {
    return false;
  }
  return safeEqual(provided, deriveCsrf(session.sessionId, config));
}
