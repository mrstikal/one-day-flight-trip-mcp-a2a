import type { ProtocolConfig, TrustedAgentEntry } from "../config.js";
import { outboundBearer } from "../auth.js";

/**
 * Phase 03 trusted card registry (plan §3.2/§3.15).
 *
 * Only agents from the trusted registry are reachable, each pinned to an exact
 * origin with an explicit card URL and required skills. There is no arbitrary
 * card discovery and no redirect following: the whole advertised interface is
 * validated before any business call.
 */

export class UntrustedAgentError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(message: string) {
    super(message);
    this.name = "UntrustedAgentError";
  }
}

export class TrustedAgentRegistry {
  constructor(private readonly config: ProtocolConfig) {}

  entryFor(agentIdentity: string): TrustedAgentEntry {
    const entry = this.config.registry.agents.find(
      (agent) => agent.agentIdentity === agentIdentity,
    );
    if (!entry) {
      throw new UntrustedAgentError(`agent ${agentIdentity} is not in the trusted registry`);
    }
    return entry;
  }

  /** Card and endpoint must share the trusted origin (no cross-origin hops). */
  assertTrustedOrigin(agentIdentity: string, url: string): TrustedAgentEntry {
    const entry = this.entryFor(agentIdentity);
    const expected = new URL(entry.endpointUrl).origin;
    const actual = new URL(url).origin;
    if (actual !== expected) {
      throw new UntrustedAgentError(
        `agent ${agentIdentity} must be reached at exactly ${expected}, got ${actual}`,
      );
    }
    return entry;
  }

  bearerFor(agentIdentity: string): string {
    const entry = this.entryFor(agentIdentity);
    return outboundBearer(this.config, entry.credentialRef);
  }
}
