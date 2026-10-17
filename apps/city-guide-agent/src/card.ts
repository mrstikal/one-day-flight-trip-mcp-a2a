import type { AgentCard } from "@a2a-js/sdk";
import {
  CITY_GUIDE_AGENT_IDENTITY,
  CITY_GUIDE_SKILL_ID,
  ITINERARY_SKILL_ID,
  type CityGuideAgentConfig,
} from "./config.js";

/** Phase 06/08 agent card: research and itinerary skills, streaming, no push notifications. */
export function buildCityGuideAgentCard(config: CityGuideAgentConfig): AgentCard {
  const endpointUrl = `http://${config.host}:${config.port}`;
  return {
    name: CITY_GUIDE_AGENT_IDENTITY,
    description:
      "Per-domain meal, activity and event research for a delegated frozen trip snapshot.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpointUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: CITY_GUIDE_SKILL_ID,
        name: "City guide research",
        description:
          "Returns per-requested-domain outcomes with ranked existing restaurant/activity/event ids and provenance; retains partial successes.",
        tags: ["restaurants", "activities", "events", "research"],
        examples: ["Research the requested meal and activity domains of the delegated snapshot."],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
      {
        id: ITINERARY_SKILL_ID,
        name: "Itinerary proposal",
        description:
          "Proposes one planner-compatible sightseeing day from a compact planner context and deterministically preflights it through the authorized Itinerary Tools.",
        tags: ["itinerary", "planning", "activities", "preflight"],
        examples: ["Plan the delegated sightseeing day and return candidate-bound stops."],
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
