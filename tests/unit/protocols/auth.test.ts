import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROTOCOL_TIMEOUTS,
  TrustedAgentRegistry,
  authenticateAgentServiceRequest,
  authenticateServiceRequest,
  isAuthorizedCaller,
  mcpBearerVerifier,
  scopeInboundRegistry,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";

const TOKENS: Record<string, string> = {
  ODFT_AGENT_TOKEN_FLIGHT: "flight-token",
  ODFT_AGENT_TOKEN_ACCOMMODATION: "accommodation-token",
  ODFT_COORDINATOR_TOKEN: "coordinator-token",
};

function config(): ProtocolConfig {
  return {
    selfAgentIdentity: "flight-agent",
    registry: trustedRegistrySchema.parse({
      schemaVersion: 1,
      agents: [
        {
          agentIdentity: "flight-agent",
          endpointUrl: "http://127.0.0.1:4401",
          cardUrl: "http://127.0.0.1:4401/.well-known/agent-card.json",
          credentialRef: "ODFT_AGENT_TOKEN_FLIGHT",
          requiredSkills: ["flight.recommend.v1"],
        },
        {
          agentIdentity: "accommodation-agent",
          endpointUrl: "http://127.0.0.1:4402",
          cardUrl: "http://127.0.0.1:4402/.well-known/agent-card.json",
          credentialRef: "ODFT_AGENT_TOKEN_ACCOMMODATION",
          requiredSkills: ["accommodation.recommend.v1"],
        },
      ],
      coordinator: {
        agentIdentity: "coordinator",
        credentialRef: "ODFT_COORDINATOR_TOKEN",
      },
    }),
    mcpRegistry: { schemaVersion: 1, services: [] },
    timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
    resolveCredential: (ref) => TOKENS[ref],
  };
}

describe("coordinator service identity", () => {
  it("presents the coordinator credential, never the target agent's token", () => {
    const registry = new TrustedAgentRegistry(config());
    expect(registry.bearerFor("flight-agent")).toBe("coordinator-token");
    expect(registry.bearerFor("accommodation-agent")).toBe("coordinator-token");
  });

  it("authenticates the coordinator as its own identity", () => {
    const identity = authenticateServiceRequest(config(), "Bearer coordinator-token");
    expect(identity.agentIdentity).toBe("coordinator");
    expect(isAuthorizedCaller(config(), identity, "flight-agent")).toBe(true);
  });

  it("rejects a peer agent identity even with a valid peer token", () => {
    const peer = authenticateServiceRequest(config(), "Bearer accommodation-token");
    expect(peer.agentIdentity).toBe("accommodation-agent");
    expect(isAuthorizedCaller(config(), peer, "flight-agent")).toBe(false);
  });

  it("does not grant the coordinator identity MCP access", async () => {
    expect(() => authenticateAgentServiceRequest(config(), "Bearer coordinator-token")).toThrow();
    expect(authenticateAgentServiceRequest(config(), "Bearer flight-token").agentIdentity).toBe(
      "flight-agent",
    );
    const verify = mcpBearerVerifier(config());
    const request = {
      headers: { get: () => "Bearer coordinator-token" },
    };
    await expect(verify(request)).resolves.toBeUndefined();
  });

  it("scopes the inbound registry to the own entry plus the coordinator", () => {
    const scoped = scopeInboundRegistry(
      config().registry,
      "flight-agent",
      "ODFT_AGENT_TOKEN_FLIGHT",
    );
    expect(scoped.agents.map((agent) => agent.agentIdentity)).toEqual(["flight-agent"]);
    expect(scoped.coordinator?.agentIdentity).toBe("coordinator");
  });
});
