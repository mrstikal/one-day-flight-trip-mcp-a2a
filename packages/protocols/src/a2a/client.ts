import {
  Client,
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import type {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  SendMessageResult,
  StreamResponse,
  Task,
} from "@a2a-js/sdk";
import type { ProtocolConfig } from "../config.js";
import { TrustedAgentRegistry } from "./registry.js";

/**
 * Phase 03 A2A client (plan §3.2, §3.9).
 *
 * Modern JSON-RPC over HTTP through the official SDK client, with:
 * - explicit per-request deadlines (card 3 s / call 5 s by default),
 * - redirects refused (`redirect: "error"`), so a trusted origin cannot bounce
 *   a credentialed request elsewhere,
 * - exact-origin pinning and a bounded card cache (5 minutes),
 * - safe error surfacing: SDK errors keep their protocol codes, transport
 *   failures become safe application categories at the call site.
 */

export class A2AClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "A2AClientError";
    this.code = code;
  }
}

/** fetch wrapper: hard deadline + no redirects (fail closed). */
export function deadlineFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input, init) => {
    return fetchImpl(input, {
      ...init,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  };
}

interface CachedCard {
  readonly card: AgentCard;
  readonly cardVersion: string;
  readonly fetchedAt: number;
}

export interface A2AClientDependencies {
  readonly config: ProtocolConfig;
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock for cache tests. */
  readonly now?: () => number;
}

export class A2AClient {
  private readonly registry: TrustedAgentRegistry;
  private readonly fetchImpl: typeof fetch;
  private readonly cardFetch: typeof fetch;
  private readonly callFetch: typeof fetch;
  private readonly now: () => number;
  private readonly cardCache = new Map<string, CachedCard>();

  constructor(private readonly deps: A2AClientDependencies) {
    this.registry = new TrustedAgentRegistry(deps.config);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.cardFetch = deadlineFetch(this.fetchImpl, deps.config.timeouts.cardTimeoutMs);
    this.callFetch = deadlineFetch(this.fetchImpl, deps.config.timeouts.callTimeoutMs);
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Fetch (or reuse) the pinned agent card. Validates that the card declares
   * every required skill; a card that stops covering a required skill is
   * rejected rather than used.
   */
  async discoverCard(agentIdentity: string): Promise<CachedCard> {
    const entry = this.registry.entryFor(agentIdentity);
    this.registry.assertTrustedOrigin(agentIdentity, entry.cardUrl);
    const cached = this.cardCache.get(agentIdentity);
    if (cached && this.now() - cached.fetchedAt < this.deps.config.timeouts.capabilityCacheTtlMs) {
      return cached;
    }
    const resolver = new DefaultAgentCardResolver({ fetchImpl: this.cardFetch });
    const base = new URL(entry.cardUrl);
    const card = await resolver.resolve(base.origin, base.pathname);
    const advertisedSkills = new Set(card.skills.map((skill) => skill.id));
    const missing = entry.requiredSkills.filter((skill) => !advertisedSkills.has(skill));
    if (missing.length > 0) {
      throw new A2AClientError(
        "AGENT_UNAVAILABLE",
        `agent ${agentIdentity} no longer advertises required skills: ${missing.join(", ")}`,
      );
    }
    const next: CachedCard = {
      card,
      cardVersion: card.version ?? "",
      fetchedAt: this.now(),
    };
    this.cardCache.set(agentIdentity, next);
    return next;
  }

  /** Build an official SDK client for a trusted agent (exact origin). */
  async createClient(agentIdentity: string): Promise<Client> {
    const { card } = await this.discoverCard(agentIdentity);
    // The trusted registry supplies the bearer; it is attached to every
    // business call (never to card discovery) and never logged.
    const bearer = this.registry.bearerFor(agentIdentity);
    const authenticatedFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return this.callFetch(input, { ...init, headers });
    };
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: this.cardFetch }),
    });
    const client = await factory.createFromAgentCard(card);
    const endpointOrigin = new URL(this.registry.entryFor(agentIdentity).endpointUrl).origin;
    // Every advertised interface must stay on the trusted origin: a card that
    // points at another origin is rejected before any business call.
    const interfaces = card.supportedInterfaces ?? [];
    const foreign = interfaces.find(
      (entry) => new URL(entry.url).origin !== endpointOrigin,
    );
    if (foreign) {
      throw new A2AClientError(
        "AGENT_UNAVAILABLE",
        `agent ${agentIdentity} advertises an interface outside the trusted origin`,
      );
    }
    return client;
  }

  async sendMessage(agentIdentity: string, params: SendMessageRequest): Promise<SendMessageResult> {
    const client = await this.createClient(agentIdentity);
    return client.sendMessage(params);
  }

  async *sendMessageStream(
    agentIdentity: string,
    params: SendMessageRequest,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const client = await this.createClient(agentIdentity);
    yield* client.sendMessageStream(params);
  }

  async getTask(agentIdentity: string, params: GetTaskRequest): Promise<Task> {
    const client = await this.createClient(agentIdentity);
    return client.getTask(params);
  }

  async cancelTask(agentIdentity: string, params: CancelTaskRequest): Promise<Task> {
    const client = await this.createClient(agentIdentity);
    return client.cancelTask(params);
  }
}
