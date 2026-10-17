import type { AgentCard } from "@a2a-js/sdk";
import { FLIGHT_AGENT_IDENTITY, FLIGHT_SKILL_ID, type FlightAgentConfig } from "./config.js";

/** Phase 05 agent card: one flight skill, streaming, no push notifications. */
export function buildFlightAgentCard(config: FlightAgentConfig): AgentCard {
  const endpointUrl = `http://${config.host}:${config.port}`;
  return {
    name: FLIGHT_AGENT_IDENTITY,
    description:
      "Ranked, schedule-valid flight recommendations for a delegated frozen trip snapshot.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpointUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: FLIGHT_SKILL_ID,
        name: "Flight recommendations",
        description:
          "Returns ranked existing schedule-valid combinations with price/time facts; never generates flights.",
        tags: ["flights", "recommendation"],
        examples: ["Rank the schedule-valid combinations by price for this delegated snapshot."],
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
