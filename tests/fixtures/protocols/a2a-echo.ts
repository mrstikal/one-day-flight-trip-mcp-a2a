import { randomUUID } from "node:crypto";
import express from "express";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import {
  Role,
  TaskState,
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
} from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import {
  AGENT_TASK_TABLES,
  DurableMessageAdmission,
  DEFAULT_PROTOCOL_TIMEOUTS,
  ProtocolTelemetryWriter,
  ServiceInstanceLock,
  createAdmissionMiddleware,
  createTaskStore,
  mountA2AServer,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";
import { agentInputRequestSchema, flightRecommendationsSchema } from "@odft/contracts";
import { loadLocalEnv } from "../../../scripts/_load-env.js";

/**
 * Phase 03 A2A echo fixture: a REAL SDK agent over HTTP used by the
 * interoperability tests. It exercises the full production path — trusted
 * registry config, bearer auth, durable admission (claim + canonical task +
 * mapping committed before work), official request handler, streamed
 * progress/artifact events, terminal status, persisted task storage and
 * restart reconciliation — with no business logic of its own.
 *
 * Env: PORT, DATABASE_URL, ODFT_A2A_ECHO_TOKEN, ODFT_A2A_ECHO_CRASH=1
 * (crashes after the task was admitted and before any work is published, to
 * prove the durable-admission crash window).
 */

loadLocalEnv();

const port = Number.parseInt(process.env.PORT ?? "4211", 10);
const token = process.env.ODFT_A2A_ECHO_TOKEN ?? "fixture-flight-token";
const crashAfterAdmission = process.env.ODFT_A2A_ECHO_CRASH === "1";
// Each instance serves ONE agent identity (the service lock is per identity);
// the crash-window test runs a second identity so both instances can coexist.
const agentIdentity = process.env.ODFT_A2A_ECHO_AGENT_IDENTITY ?? "flight-agent";
const endpointUrl = `http://127.0.0.1:${port}`;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the A2A echo fixture");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

const config: ProtocolConfig = {
  selfAgentIdentity: agentIdentity,
  registry: trustedRegistrySchema.parse({
    schemaVersion: 1,
    agents: [
      {
        agentIdentity,
        endpointUrl,
        cardUrl: `${endpointUrl}/.well-known/agent-card.json`,
        credentialRef: "ODFT_A2A_ECHO_TOKEN",
        requiredSkills: ["flight.recommend.v1"],
      },
    ],
  }),
  mcpRegistry: {
    schemaVersion: 1,
    services: [{ serviceName: "unused", endpointUrl, credentialRef: "ODFT_A2A_ECHO_TOKEN" }],
  },
  timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
  resolveCredential: (ref) => (ref === "ODFT_A2A_ECHO_TOKEN" ? token : process.env[ref]),
};

const admission = new DurableMessageAdmission(db, {
  agentIdentity,
  taskTable: AGENT_TASK_TABLES.flight,
  activeOwner: `pid-${process.pid}`,
});
const telemetry = new ProtocolTelemetryWriter(pool);

const agentCard: AgentCard = {
  name: "ODFT flight echo agent (fixture)",
  description:
    "Phase 03 interoperability fixture: echoes validated flight-recommendation artifacts.",
  version: "1.0.0",
  supportedInterfaces: [
    { url: endpointUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: true, pushNotifications: false, extensions: [] },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "flight.recommend.v1",
      name: "Flight recommendations (fixture)",
      description: "Echoes a validated flight-recommendation artifact for interoperability tests.",
      tags: ["fixture"],
      examples: ["echo"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
  provider: undefined,
  documentationUrl: "",
  securitySchemes: {},
  securityRequirements: [],
  signatures: [],
  iconUrl: "",
};

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: "text", value: text },
        mediaType: "text/plain",
        filename: "",
        metadata: {},
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function dataPart(value: unknown, mediaType: string): Part {
  return {
    content: { $case: "data", value },
    mediaType,
    filename: "",
    metadata: {},
  };
}

/** First data part of the incoming message, if any. */
function echoRequestOf(message: Message): { requestInput?: boolean; payload?: unknown } {
  for (const part of message.parts) {
    if (part.content?.$case === "data" && part.content.value !== undefined) {
      return part.content.value as { requestInput?: boolean; payload?: unknown };
    }
  }
  return {};
}

const executor: AgentExecutor = {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const message = requestContext.userMessage;
    if (crashAfterAdmission) {
      // The admission transaction (claim + canonical task + mapping) already
      // committed; dying here proves the crash window is closed.
      process.stderr.write("a2a-echo: simulated crash after admission\n");
      process.exit(3);
    }
    const task = requestContext.task;
    if (!task) {
      throw new Error("admission must have committed the canonical task");
    }
    const request = echoRequestOf(message);
    const generation = task.history.length; // continuation turns append to history
    await admission.markWorking(task.id);

    // 1. Every executor invocation MUST publish the task (or a message) first.
    eventBus.publish({
      kind: "task",
      data: {
        ...task,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
      },
    });
    // 2. Streamed progress.
    eventBus.publish({
      kind: "statusUpdate",
      data: {
        taskId: task.id,
        contextId: task.contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: agentMessage(task.id, task.contextId, `progress ${generation}/2`),
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      },
    });

    if (request.requestInput === true && generation <= 1) {
      // Genuine specialist question: stable request id, finite options, expiry.
      const inputRequest = agentInputRequestSchema.parse({
        correlation: {
          schemaVersion: 1,
          skillId: "flight.recommend.v1",
          tripId: randomUUID(),
          operationId: randomUUID(),
          acceptedRevision: 1,
          delegationId: randomUUID(),
          traceId: `trace-${task.id}`,
          snapshotId: randomUUID(),
          scenarioKey: "fixture",
          inputFingerprint: "a".repeat(64),
          domainFingerprints: { hotel: "b".repeat(64) },
        },
        requestId: `q-${task.id}`,
        taskId: task.id,
        contextId: task.contextId,
        inputGeneration: 1,
        reason: "ambiguous_payload",
        question: "Which option should the fixture pick?",
        options: [
          { id: "option-a", label: "Option A" },
          { id: "option-b", label: "Option B" },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        requestHash: "c".repeat(64),
      });
      eventBus.publish({
        kind: "artifactUpdate",
        data: {
          taskId: task.id,
          contextId: task.contextId,
          artifact: {
            artifactId: randomUUID(),
            name: "agent-input-request",
            description: "fixture question",
            parts: [dataPart(inputRequest, "application/vnd.odft.agent-input-request.v1+json")],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        },
      });
      eventBus.publish({
        kind: "statusUpdate",
        data: {
          taskId: task.id,
          contextId: task.contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            message: agentMessage(task.id, task.contextId, inputRequest.question),
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        },
      });
      eventBus.finished();
      // Waiting for the traveler: a resting state that reconciliation never
      // turns into a failure.
      await admission.markSettled({
        messageId: message.messageId,
        taskId: task.id,
        state: "input_required",
      });
      return;
    }

    // 3. One validated artifact (contract schema enforced by the fixture).
    const artifact = flightRecommendationsSchema.parse({
      correlation: {
        schemaVersion: 1,
        skillId: "flight.recommend.v1",
        tripId: randomUUID(),
        operationId: randomUUID(),
        acceptedRevision: 1,
        delegationId: randomUUID(),
        traceId: `trace-${task.id}`,
        snapshotId: randomUUID(),
        scenarioKey: "fixture",
        inputFingerprint: "d".repeat(64),
        domainFingerprints: { hotel: "e".repeat(64) },
      },
      rankedCombinationIds: [`demo-flights-${task.id.slice(0, 8)}`],
      findings: [],
      priceFacts: [],
      explanations: ["fixture echo"],
      reorderNote: null,
    });
    const artifactRecord: Artifact = {
      artifactId: randomUUID(),
      name: "flight-recommendations",
      description: "fixture artifact",
      parts: [
        dataPart(artifact, "application/vnd.odft.flight-recommendations.v1+json"),
        {
          content: { $case: "text", value: `echo:${message.messageId}` },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: undefined,
      extensions: [],
    };
    eventBus.publish({
      kind: "artifactUpdate",
      data: {
        taskId: task.id,
        contextId: task.contextId,
        artifact: artifactRecord,
        append: false,
        lastChunk: true,
        metadata: undefined,
      },
    });
    // 4. Terminal status.
    eventBus.publish({
      kind: "statusUpdate",
      data: {
        taskId: task.id,
        contextId: task.contextId,
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          message: agentMessage(task.id, task.contextId, "fixture completed"),
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      },
    });
    eventBus.finished();
    await admission.markSettled({
      messageId: message.messageId,
      taskId: task.id,
      state: "completed",
    });
  },

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish({
      kind: "statusUpdate",
      data: {
        taskId,
        contextId: taskId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      },
    });
    eventBus.finished();
  },
};

const app = express();
app.use(express.json({ limit: "1mb" }));
if (process.env.ODFT_A2A_ECHO_TRACE === "1") {
  app.use((req, _res, next) => {
    const bodyText = req.body === undefined ? "(none)" : JSON.stringify(req.body);
    process.stderr.write(
      `TRACE ${req.method} ${req.path} version=${String(req.headers["a2a-version"])} body=${bodyText.slice(0, 160)}\n`,
    );
    next();
  });
}
app.use(createAdmissionMiddleware({ config, admission, telemetry }));
mountA2AServer(app, {
  config,
  agentCard,
  taskStore: createTaskStore(db, { tableName: AGENT_TASK_TABLES.flight, owner: agentIdentity }),
  executor,
});

// One service process per agent identity (session advisory lock), then
// reconciliation: tasks a stopped process left active become explicit restart
// failures before any duplicate can be admitted.
const serviceLock = await ServiceInstanceLock.acquire(pool, agentIdentity).catch((error) => {
  process.stderr.write(`a2a-echo: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
const reconciled = await admission.reconcileRestartedTasks(serviceLock);

app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`a2a-echo ready on ${endpointUrl} (reconciled: ${reconciled.length})\n`);
});
