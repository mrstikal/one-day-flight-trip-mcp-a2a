import type { AgentCard } from "@a2a-js/sdk";
import { ACCOMMODATION_AGENT_IDENTITY, ACCOMMODATION_SKILL_ID, type AccommodationAgentConfig } from "./config.js";

/** Phase 06 agent card: one specialist skill, streaming, no push notifications. */
export function buildAccommodationAgentCard(config: AccommodationAgentConfig): AgentCard {
  const endpointUrl = `http://${config.host}:${config.port}`;
  return {
    name: ACCOMMODATION_AGENT_IDENTITY,
    description:
      "Ranked hotel recommendations within the delegated category of a frozen trip snapshot.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpointUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: ACCOMMODATION_SKILL_ID,
        name: "Accommodation recommendations",
        description:
          "Returns ranked existing hotel offers of the delegated snapshot with effective level and comparison facts; never generates or books hotels.",
        tags: ["hotels", "recommendation"],
        examples: ["Rank the hotel candidates of the delegated snapshot for the cheaper objective."],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    provider: undefined,
    documentationUrl: "",
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "Bearer token from the coordinator's trusted registry",
            scheme: "bearer",
            bearerFormat: "",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    signatures: [],
    iconUrl: "",
  };
}
