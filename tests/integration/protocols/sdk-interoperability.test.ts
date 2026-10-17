import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { Client as McpSdkClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  A2AClient,
  DEFAULT_PROTOCOL_TIMEOUTS,
  McpClient,
  trustedRegistrySchema,
  type ProtocolConfig,
} from "@odft/protocols";
import { agentInputRequestSchema, flightRecommendationsSchema } from "@odft/contracts";
import { createTestPool, requireTestDatabaseUrl, resetProtocolDatabase } from "./_setup.js";

/**
 * Phase 03 SDK interoperability tests: REAL official A2A and MCP clients talking
 * to REAL fixture servers over HTTP, against real PostgreSQL task storage.
 * Covers card discovery, task acceptance, streamed progress/artifacts/terminal
 * status, input-required continuation, duplicate/conflict handling, restart
 * persistence, the admission crash window, MCP modern negotiation and auth.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = `${REPO_ROOT}/node_modules/.bin/tsx`;

const A2A_PORT = 4311;
const CRASH_PORT = 4316;
const MCP_PORT = 4314;
const A2A_TOKEN = "fixture-flight-token";
const MCP_TOKEN = "fixture-mcp-token";

let pool: Pool;
const fixtures: ChildProcess[] = [];

function a2aConfig(port = A2A_PORT, agentIdentity = "flight-agent"): ProtocolConfig {
  const endpointUrl = `http://127.0.0.1:${port}`;
  return {
    selfAgentIdentity: "coordinator",
    registry: trustedRegistrySchema.parse({
      schemaVersion: 1,
      agents: [
        {
          agentIdentity,
          endpointUrl,
          cardUrl: `${endpointUrl}/.well-known/agent-card.json`,
          credentialRef: "ODFT_A2A_TEST_TOKEN",
          requiredSkills: ["flight.recommend.v1"],
        },
      ],
    }),
    mcpRegistry: {
      schemaVersion: 1,
      services: [
        {
          serviceName: "mcp-echo",
          endpointUrl: `http://127.0.0.1:${MCP_PORT}/mcp`,
          credentialRef: "ODFT_MCP_TEST_TOKEN",
        },
      ],
    },
    timeouts: DEFAULT_PROTOCOL_TIMEOUTS,
    resolveCredential: (ref) =>
      ref === "ODFT_A2A_TEST_TOKEN"
        ? A2A_TOKEN
        : ref === "ODFT_MCP_TEST_TOKEN"
          ? MCP_TOKEN
          : undefined,
  };
}

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`fixture did not print ${pattern} within ${timeoutMs} ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(buffer);
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      if (!pattern.test(buffer)) {
        clearTimeout(timer);
        reject(new Error(`fixture exited with ${code} before readiness: ${buffer}`));
      }
    });
  });
}

async function startFixture(
  script: string,
  port: number,
  env: Record<string, string> = {},
): Promise<ChildProcess> {
  const child = spawn(TSX, [script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: requireTestDatabaseUrl(),
      PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  fixtures.push(child);
  await waitForLine(child, /ready on/);
  return child;
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
    setTimeout(resolve, 5_000);
  });
}

function dataMessage(messageId: string, value: unknown, taskId = "", contextId = ""): Message {
  return {
    messageId,
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "data", value },
        mediaType: "application/json",
        filename: "",
        metadata: {},
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

async function sendAndAwaitTask(
  client: A2AClient,
  message: Message,
  agentIdentity = "flight-agent",
): Promise<Task> {
  const result = await client.sendMessage(agentIdentity, {
    message,
    tenant: "",
    configuration: undefined,
    metadata: undefined,
  });
  const task = "status" in result ? result : undefined;
  if (!task) {
    throw new Error("expected a task result");
  }
  return task as Task;
}

beforeAll(async () => {
  pool = createTestPool();
  await resetProtocolDatabase(pool);
  await startFixture("tests/fixtures/protocols/a2a-echo.ts", A2A_PORT, {
    ODFT_A2A_ECHO_TOKEN: A2A_TOKEN,
  });
  await startFixture("tests/fixtures/protocols/mcp-echo.ts", MCP_PORT, {
    ODFT_MCP_ECHO_TOKEN: MCP_TOKEN,
  });
}, 60_000);

afterAll(async () => {
  for (const child of fixtures) {
    await stopFixture(child);
  }
  await pool.end();
});

describe("A2A interoperability", () => {
  it("discovers the pinned card and validates the required skill", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const { card } = await client.discoverCard("flight-agent");
    expect(card.skills.map((skill) => skill.id)).toContain("flight.recommend.v1");
    const interfaces = card.supportedInterfaces ?? [];
    expect(interfaces.every((entry) => entry.url.startsWith(`http://127.0.0.1:${A2A_PORT}`))).toBe(true);
  });

  it("completes a task with a validated versioned artifact", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const task = await sendAndAwaitTask(client, dataMessage(randomUUID(), { payload: { x: 1 } }));
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.artifacts.length).toBeGreaterThan(0);
    const artifact = task.artifacts[0];
    const dataPart = artifact?.parts.find((part) => part.content?.$case === "data");
    expect(dataPart?.mediaType).toBe("application/vnd.odft.flight-recommendations.v1+json");
    const parsed = flightRecommendationsSchema.parse(
      dataPart?.content?.$case === "data" ? dataPart.content.value : undefined,
    );
    expect(parsed.rankedCombinationIds.length).toBeGreaterThan(0);
  });

  it("streams progress, the artifact and the terminal status", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const events: string[] = [];
    const artifactMediaTypes: string[] = [];
    let finalState: number | undefined;
    for await (const event of client.sendMessageStream("flight-agent", {
      message: dataMessage(randomUUID(), { payload: { streamed: true } }),
      tenant: "",
      configuration: undefined,
      metadata: undefined,
    })) {
      const payload = (event as { payload?: { $case?: string; value?: unknown } }).payload;
      if (!payload?.$case) {
        continue;
      }
      events.push(payload.$case);
      if (payload.$case === "artifactUpdate") {
        const value = payload.value as { artifact?: { parts: { mediaType?: string }[] } };
        for (const part of value.artifact?.parts ?? []) {
          if (part.mediaType) {
            artifactMediaTypes.push(part.mediaType);
          }
        }
      }
      if (payload.$case === "statusUpdate") {
        const value = payload.value as { status?: { state?: number } };
        finalState = value.status?.state;
      }
    }
    expect(events[0]).toBe("task");
    expect(events).toContain("statusUpdate");
    expect(events).toContain("artifactUpdate");
    expect(artifactMediaTypes).toContain("application/vnd.odft.flight-recommendations.v1+json");
    expect(finalState).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("supports a genuine input_required continuation on the same task", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const firstMessage = dataMessage(randomUUID(), { requestInput: true });
    const first = await sendAndAwaitTask(client, firstMessage);
    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const questionArtifact = first.artifacts.find((artifact) =>
      artifact.parts.some(
        (part) => part.mediaType === "application/vnd.odft.agent-input-request.v1+json",
      ),
    );
    const questionPart = questionArtifact?.parts.find(
      (part) => part.mediaType === "application/vnd.odft.agent-input-request.v1+json",
    );
    const question = agentInputRequestSchema.parse(
      questionPart?.content?.$case === "data" ? questionPart.content.value : undefined,
    );
    expect(question.options.length).toBeGreaterThanOrEqual(2);

    const continuation = await sendAndAwaitTask(
      client,
      dataMessage(randomUUID(), { answer: question.options[0]?.id }, first.id, first.contextId),
    );
    expect(continuation.id).toBe(first.id);
    expect(continuation.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // The continuation preserved the first turn: the original message and the
    // question artifact are still there (nothing was wiped).
    expect(continuation.history.map((entry) => entry.messageId)).toContain(
      firstMessage.messageId,
    );
    expect(
      continuation.artifacts.some((artifact) => artifact.artifactId === questionArtifact?.artifactId),
    ).toBe(true);
  });

  it("keeps a completed task completed on a duplicate streaming request", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const message = dataMessage(randomUUID(), { payload: { streamDuplicate: true } });
    const first = await sendAndAwaitTask(client, message);
    const frames: string[] = [];
    for await (const event of client.sendMessageStream("flight-agent", {
      message,
      tenant: "",
      configuration: undefined,
      metadata: undefined,
    })) {
      const payload = (event as { payload?: { $case?: string } }).payload;
      if (payload?.$case) {
        frames.push(payload.$case);
      }
    }
    // The replay answers with the persisted task and starts no new work.
    expect(frames).toEqual(["task"]);
    const stored = await client.getTask("flight-agent", {
      id: first.id,
      tenant: "",
      historyLength: undefined,
    });
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("never claims a message for a binding this server rejects", async () => {
    const messageId = randomUUID();
    // Legacy 0.3-shaped JSON-RPC without the version header: the official
    // handler rejects it, so the message must not be admitted.
    const response = await fetch(`http://127.0.0.1:${A2A_PORT}/`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${A2A_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "message/send",
        params: { message: dataMessage(messageId, { payload: {} }) },
      }),
    });
    const body = (await response.json()) as { error?: { data?: { reason?: string }[] } };
    expect(body.error?.data?.[0]?.reason).toBe("VERSION_NOT_SUPPORTED");
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.protocol_inbound_messages WHERE message_id = $1`,
      [messageId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("cancels a task that is waiting for input", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const task = await sendAndAwaitTask(
      client,
      dataMessage(randomUUID(), { requestInput: true }),
    );
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const cancelled = await client.cancelTask("flight-agent", {
      id: task.id,
      tenant: "",
      metadata: undefined,
    });
    expect(cancelled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("replays a duplicate message instead of starting new work", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const message = dataMessage(randomUUID(), { payload: { duplicate: true } });
    const first = await sendAndAwaitTask(client, message);
    const replay = await sendAndAwaitTask(client, message);
    expect(replay.id).toBe(first.id);
    expect(replay.artifacts[0]?.artifactId).toBe(first.artifacts[0]?.artifactId);
    // Exactly one executor run: one mapped admission row for the message.
    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM odft_app.protocol_inbound_messages
        WHERE agent_identity = 'flight-agent' AND message_id = $1 AND state = 'completed'`,
      [message.messageId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("rejects a conflicting duplicate payload with a safe error", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const messageId = randomUUID();
    await sendAndAwaitTask(client, dataMessage(messageId, { payload: { first: true } }));
    await expect(
      sendAndAwaitTask(client, dataMessage(messageId, { payload: { second: true } })),
    ).rejects.toThrow(/already admitted with a different payload/);
  });

  it("rejects an unauthenticated request before any dispatch", async () => {
    const response = await fetch(`http://127.0.0.1:${A2A_PORT}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
        "a2a-version": "1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: { message: dataMessage(randomUUID(), { payload: {} }), tenant: "" },
      }),
    });
    expect(response.status).toBe(401);
  });

  it("retrieves the persisted task after a server restart", async () => {
    const client = new A2AClient({ config: a2aConfig() });
    const task = await sendAndAwaitTask(client, dataMessage(randomUUID(), { payload: { persist: true } }));
    const running = fixtures.find((child) => child.exitCode === null && child.pid !== undefined);
    // Restart the A2A fixture (the MCP fixture keeps running).
    const a2aFixture = fixtures[0];
    if (!a2aFixture) {
      throw new Error("A2A fixture missing");
    }
    await stopFixture(a2aFixture);
    fixtures.splice(fixtures.indexOf(a2aFixture), 1);
    void running;
    await startFixture("tests/fixtures/protocols/a2a-echo.ts", A2A_PORT, {
      ODFT_A2A_ECHO_TOKEN: A2A_TOKEN,
    });
    const persisted = await client.getTask("flight-agent", {
      id: task.id,
      tenant: "",
      historyLength: undefined,
    });
    expect(persisted.id).toBe(task.id);
    expect(persisted.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(persisted.artifacts.length).toBeGreaterThan(0);
  });

  it("reconciles a crash after admission into an explicit restart failure", async () => {
    // A second agent identity: the service lock is per identity, so the crash
    // instance coexists with the main fixture.
    const crashFixture = await startFixture("tests/fixtures/protocols/a2a-echo.ts", CRASH_PORT, {
      ODFT_A2A_ECHO_TOKEN: A2A_TOKEN,
      ODFT_A2A_ECHO_CRASH: "1",
      ODFT_A2A_ECHO_AGENT_IDENTITY: "flight-agent-crash",
    });
    const client = new A2AClient({ config: a2aConfig(CRASH_PORT, "flight-agent-crash") });
    const message = dataMessage(randomUUID(), { payload: { crash: true } });
    await expect(sendAndAwaitTask(client, message, "flight-agent-crash")).rejects.toBeTruthy();
    await new Promise<void>((resolve) => {
      if (crashFixture.exitCode !== null) {
        resolve();
        return;
      }
      crashFixture.once("exit", () => resolve());
    });
    fixtures.splice(fixtures.indexOf(crashFixture), 1);

    // The admission committed before the crash: the mapping exists.
    const mapped = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM odft_app.protocol_inbound_messages
        WHERE agent_identity = 'flight-agent-crash' AND message_id = $1`,
      [message.messageId],
    );
    const taskId = mapped.rows[0]?.task_id;
    expect(taskId).toBeTruthy();

    // A restarted instance reconciles the orphaned task before serving.
    const restarted = await startFixture("tests/fixtures/protocols/a2a-echo.ts", CRASH_PORT, {
      ODFT_A2A_ECHO_TOKEN: A2A_TOKEN,
      ODFT_A2A_ECHO_AGENT_IDENTITY: "flight-agent-crash",
    });
    expect(restarted.exitCode).toBeNull();

    const clientAfter = new A2AClient({ config: a2aConfig(CRASH_PORT, "flight-agent-crash") });
    const recovered = await clientAfter.getTask("flight-agent-crash", {
      id: taskId as string,
      tenant: "",
      historyLength: undefined,
    });
    expect(recovered.status?.state).toBe(TaskState.TASK_STATE_FAILED);

    // A duplicate replays the failed task; no new work starts.
    const replay = await sendAndAwaitTask(clientAfter, message, "flight-agent-crash");
    expect(replay.id).toBe(taskId);
    expect(replay.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  }, 60_000);
});

describe("MCP interoperability", () => {
  it("negotiates the pinned modern protocol version", async () => {
    const client = new McpClient({ config: a2aConfig() });
    expect(await client.negotiatedProtocolVersion("mcp-echo")).toBe("2026-07-28");
  });

  it("calls the echo tool and reads the echo resource", async () => {
    const client = new McpClient({ config: a2aConfig() });
    const tools = await client.listTools("mcp-echo");
    expect(tools.tools.map((tool) => tool.name)).toContain("echo");
    const result = await client.callTool("mcp-echo", {
      name: "echo",
      arguments: { payload: "hello" },
    });
    expect(result.structuredContent).toEqual({ echoed: "hello", server: "mcp-echo" });
    const resource = await client.readResource("mcp-echo", { uri: "odft://echo/info" });
    const text = resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "";
    expect(text).toContain("mcp-echo");
  });

  it("rejects a legacy (2025-era) client", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${MCP_PORT}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } } },
    );
    const legacyClient = new McpSdkClient({ name: "legacy-client", version: "1.0.0" });
    await expect(legacyClient.connect(transport)).rejects.toBeTruthy();
  });

  it("rejects an unauthenticated request", async () => {
    const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
