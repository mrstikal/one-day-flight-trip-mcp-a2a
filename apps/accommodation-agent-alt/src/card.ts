import type { AgentCard } from "@a2a-js/sdk";
import {
  ACCOMMODATION_ALT_AGENT_IDENTITY,
  ACCOMMODATION_ALT_SKILL_ID,
  type AccommodationAltAgentConfig,
} from "./config.js";

/**
 * Phase 10 replacement agent card: the same public skill and artifact contract,
 * a distinct identity and description. No push notifications.
 */
export function buildAccommodationAltAgentCard(config: AccommodationAltAgentConfig): AgentCard {
  const endpointUrl = `http://${config.host}:${config.port}`;
  return {
    name: ACCOMMODATION_ALT_AGENT_IDENTITY,
    description:
      "Independent value-scored hotel recommendations within the delegated category of a frozen trip snapshot.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpointUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: ACCOMMODATION_ALT_SKILL_ID,
        name: "Accommodation recommendations (alternative)",
        description:
          "Returns the same ranked existing hotel offers contract as the primary accommodation agent, using an independent value-score strategy; never generates or books hotels.",
        tags: ["hotels", "recommendation", "replacement"],
        examples: ["Rank the hotel candidates of the delegated snapshot by value."],
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
