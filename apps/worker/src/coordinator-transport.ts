import { readFileSync } from "node:fs";
import { TaskState } from "@a2a-js/sdk";
import {
  DEFAULT_PROTOCOL_TIMEOUTS,
  A2AClient,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";
import type {
  CoordinatorAgentBinding,
  CoordinatorDelegationTransport,
  DelegationTaskSnapshot,
} from "@odft/workflow";

/**
 * Phase 07 worker-side delegation transport: the official A2A client over the
 * trusted registry. The workflow package stays SDK-free; only this adapter
 * speaks HTTP and turns SDK tasks into the SDK-free snapshot shape.
 */

const COORDINATOR_IDENTITY = "coordinator";

interface TaskArtifactLike {
  readonly artifactId?: string;
  readonly parts?: readonly {
    readonly content?: { readonly $case?: string; readonly value?: unknown };
  }[];
}

export interface CoordinatorTransportConfig {
  readonly config: ProtocolConfig;
  readonly flight: CoordinatorAgentBinding;
  readonly accommodation: CoordinatorAgentBinding;
  readonly cityGuide: CoordinatorAgentBinding;
  /** Phase 08: the same City Guide agent's itinerary skill. */
  readonly itinerary: CoordinatorAgentBinding;
}

export function loadCoordinatorTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorTransportConfig {
  const registryPath = env.ODFT_AGENT_REGISTRY_PATH;
  if (!registryPath) {
    throw new Error("ODFT_AGENT_REGISTRY_PATH is required for coordinator delegation");
  }
  const registry = trustedRegistrySchema.parse(JSON.parse(readFileSync(registryPath, "utf8")));
  const binding = (
    skillId:
      | "flight.recommend.v1"
      | "accommodation.recommend.v1"
      | "city-guide.research.v1"
      | "itinerary.propose.v1",
  ): CoordinatorAgentBinding => {
    const entry = registry.agents.find((agent) =>
      (agent.requiredSkills as readonly string[]).includes(skillId),
    );
    if (!entry) {
      throw new Error(`the trusted registry has no specialist entry for ${skillId}`);
    }
    return {
      agentIdentity: entry.agentIdentity,
      endpointUrl: entry.endpointUrl,
      skillId,
    };
  };
  return {
    config: {
      selfAgentIdentity: COORDINATOR_IDENTITY,
      registry,
      mcpRegistry: { schemaVersion: 1, services: [] },
      timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
      resolveCredential: (ref) => env[ref],
    },
    flight: binding("flight.recommend.v1"),
    accommodation: binding("accommodation.recommend.v1"),
    cityGuide: binding("city-guide.research.v1"),
    itinerary: binding("itinerary.propose.v1"),
  };
}

/** Map the SDK task state onto the dispatch-level token. */
function normalizeState(state: unknown): string {
  switch (state) {
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input_required";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth_required";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    default:
      return String(state);
  }
}

function artifactData(artifact: TaskArtifactLike): unknown {
  for (const part of artifact.parts ?? []) {
    if (part.content?.$case === "data" && part.content.value !== undefined) {
      return part.content.value;
    }
  }
  return undefined;
}

export function createA2ADelegationTransport(
  config: ProtocolConfig,
): CoordinatorDelegationTransport {
  // Non-blocking send + explicit polling: a durable outbound intent must not
  // hold the coordinator's claim for the whole specialist computation, and a
  // queued question can be observed while a sibling is still working.
  const client = new A2AClient({ config, polling: true });
  return {
    async describeAgent(input) {
      const discovered = await client.discoverCard(input.agentIdentity);
      const skills = new Set(discovered.card.skills.map((skill) => skill.id));
      if (!skills.has(input.skillId)) {
        throw new Error(
          `agent ${input.agentIdentity} does not advertise the required skill ${input.skillId}`,
        );
      }
      return { cardVersion: discovered.cardVersion };
    },
    async sendTask(input) {
      const dataMessage = {
        messageId: input.messageId,
        contextId: input.contextId ?? "",
        taskId: input.taskId ?? "",
        role: 1, // Role.ROLE_USER
        parts: [
          {
            content: { $case: "data" as const, value: input.data },
            mediaType: "application/json",
            filename: "",
            metadata: {},
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };
      const result = await client.sendMessage(input.agentIdentity, {
        message: dataMessage as never,
        tenant: "",
        configuration: undefined,
        metadata: undefined,
      });
      if (!("status" in result) || typeof result.id !== "string") {
        throw new Error("the specialist did not return a task");
      }
      return { taskId: result.id, contextId: (result as { contextId?: string }).contextId ?? "" };
    },
    async getTask(input) {
      const task = await client.getTask(input.agentIdentity, { id: input.taskId, tenant: "" });
      const artifacts = (task.artifacts ?? [])
        .map((artifact) => ({
          artifactId: (artifact as TaskArtifactLike).artifactId ?? "",
          data: artifactData(artifact as TaskArtifactLike),
        }))
        .filter((entry) => entry.data !== undefined);
      const failureText = (task.status?.message?.parts ?? [])
        .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
        .join(" ")
        .trim();
      const snapshot: DelegationTaskSnapshot = {
        taskId: task.id,
        state: normalizeState(task.status?.state),
        artifacts,
        failureCode: failureText.length > 0 ? failureText.slice(0, 200) : null,
        question:
          normalizeState(task.status?.state) === "input_required"
            ? artifacts.find((entry) => entry.artifactId !== "")?.data
            : undefined,
      };
      return snapshot;
    },
    async cancelTask(input) {
      await client.cancelTask(input.agentIdentity, {
        id: input.taskId,
        tenant: "",
        metadata: undefined,
      });
    },
  };
}
