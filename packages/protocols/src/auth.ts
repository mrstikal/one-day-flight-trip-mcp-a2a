import { createHash, timingSafeEqual } from "node:crypto";
import type { ProtocolConfig } from "./config.js";

/**
 * Phase 03 service authentication (plan §3.15).
 *
 * Inbound agent/MCP requests authenticate with a bearer token mapped to the
 * trusted registry identity. Comparison is timing-safe; failures are safe and
 * identical for missing/unknown/invalid tokens, and a caller can never choose
 * its own identity through the request body.
 */

export class ProtocolAuthError extends Error {
  readonly code = "UNAUTHORIZED" as const;
  constructor(message = "service authentication failed") {
    super(message);
    this.name = "ProtocolAuthError";
  }
}

export interface ServiceIdentity {
  /** Registry identity of the authenticated caller. */
  readonly agentIdentity: string;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison over equal-length digests. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Extract a bearer token from an Authorization header value. */
export function bearerTokenOf(authorization: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  // RFC 7235: the auth scheme is case-insensitive.
  if (!value || !value.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Authenticate one inbound request against the trusted registry. Returns the
 * authenticated service identity or throws a safe auth error.
 */
export function authenticateServiceRequest(
  config: ProtocolConfig,
  authorization: string | string[] | undefined,
): ServiceIdentity {
  const token = bearerTokenOf(authorization);
  if (!token) {
    throw new ProtocolAuthError();
  }
  for (const agent of config.registry.agents) {
    const expected = config.resolveCredential(agent.credentialRef);
    if (!expected) {
      continue;
    }
    if (safeEqual(token, expected)) {
      return { agentIdentity: agent.agentIdentity };
    }
  }
  throw new ProtocolAuthError();
}

/**
 * MCP bearer verification callback: returns the authenticated identity or
 * undefined (the handler then answers with the SDK's challenge response).
 */
export function mcpBearerVerifier(
  config: ProtocolConfig,
): (request: { headers: { get(name: string): string | null } }) => Promise<
  { token: string; clientId: string; scopes: string[] } | undefined
> {
  return async (request) => {
    const header = request.headers.get("authorization");
    try {
      const identity = authenticateServiceRequest(config, header ?? undefined);
      return { token: "verified", clientId: identity.agentIdentity, scopes: [] };
    } catch {
      return undefined;
    }
  };
}

/** Outbound bearer token for a trusted agent (never logged). */
export function outboundBearer(config: ProtocolConfig, credentialRef: string): string {
  const token = config.resolveCredential(credentialRef);
  if (!token) {
    throw new ProtocolAuthError(
      `missing credential for ${credentialRef}; configure it in the environment`,
    );
  }
  return token;
}
