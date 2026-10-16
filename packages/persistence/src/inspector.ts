import type { Pool } from "pg";
import {
  decisionKindSchema,
  errorCodeSchema,
  graphDefinitionSchema,
  operationStatusSchema,
  publicInspectorFaultSchema,
  publicInspectorSchema,
  publicVoiceCallSchema,
  scenarioDomainSchema,
  type PublicInspector,
  type PublicInspectorEvent,
  type PublicInspectorNode,
  type PublicVoiceCall,
} from "@odft/contracts";
import { formatUsdAmount, parseUsdAmount, usdFromDb } from "./usd.js";

/**
 * Phase 11 execution-inspector projection (08-frontend-ux.md section 10).
 *
 * The inspector is built EXCLUSIVELY from safe persisted rows: allowlisted
 * execution events, operation/decision telemetry, the LLM cost ledger, and the
 * labeled fault rows. Nothing here is computed by calling a graph API, and no
 * field can carry a prompt, reasoning chain, provider payload, SQL, stack trace,
 * or secret — those were never stored (see `projectSafeEvent`).
 */

const MAX_ROWS = 200;

type Queryable = Pick<Pool, "query">;

interface EventRow {
  id: string;
  type: string;
  payload: unknown;
  created_at: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shortString(value: unknown, max = 120): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

/** Postgres text timestamps are converted to the ISO-UTC instant the DTO requires. */
function toIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** One safe line of evidence per event type; never a payload dump. */
function summarizeEvent(type: string, payload: unknown): string | null {
  const record = asRecord(payload);
  switch (type) {
    case "node.started":
      return `${shortString(record.node, 80) ?? "node"} started`;
    case "node.updated":
      return shortString(record.node, 80);
    case "research.domain_started":
      return `research ${shortString(record.domain, 40)} started (attempt ${String(record.attempt ?? 1)})`;
    case "research.domain_finished": {
      const status = shortString(record.status, 40) ?? "unknown";
      const reason = shortString(record.reason, 120);
      return `research ${shortString(record.domain, 40)} ${status}${reason ? `: ${reason}` : ""}`;
    }
    case "booking.confirmed":
      return `booking confirmed: ${shortString(record.serviceKey, 40) ?? "service"}`;
    case "booking.cancelled":
      return `booking cancelled: ${shortString(record.serviceKey, 40) ?? "service"}`;
    case "route_change.committed":
      return `route change committed (${stringArray(record.cancelledReservationIds).length} reservations cancelled)`;
    case "operation.failed":
    case "operation.rejected":
      return `failed: ${shortString(record.code, 60) ?? "error"}`;
    case "operation.succeeded":
      return shortString(record.summary, 160);
    case "decision.awaiting":
      return `awaiting ${shortString(record.kind, 60) ?? "decision"}`;
    case "itinerary.attempt_finished":
      return `itinerary attempt ${String(record.attempt ?? "?")} ${shortString(record.status, 20) ?? ""}`.trim();
    case "program.saved":
      return "meal selections saved";
    case "itinerary.attempt_started":
      return `planning itinerary (attempt ${String(record.attempt ?? "?")})`;
    case "itinerary.review_started":
      return `reviewing itinerary (attempt ${String(record.attempt ?? "?")})`;
    case "itinerary.reviewed":
      return `itinerary reviewed: ${shortString(record.verdict, 20) ?? "unknown"}`;
    case "itinerary.approved":
      return `itinerary approved (v${String(record.version ?? "?")})`;
    case "trip.route_changed":
      return `route changed (${shortString(record.command, 40) ?? "command"})`;
    case "trip.preferences_changed":
      return `preferences changed (${shortString(record.command, 40) ?? "command"})`;
    case "trip.simulation_armed":
      return `simulated failure armed: ${shortString(record.mode, 60) ?? "mode"}`;
    case "graph.initialized":
      return "graph definition persisted";
    default:
      return null;
  }
}

function rowToEvent(row: EventRow): PublicInspectorEvent {
  return {
    id: String(row.id),
    type: row.type.slice(0, 80),
    node: shortString(asRecord(row.payload).node, 80),
    summary: summarizeEvent(row.type, row.payload),
    at: toIso(row.created_at),
  };
}

/**
 * The newest operation's execution frontier from REAL node events: a node with a
 * `node.started` event and no later `node.updated` for the same operation is the
 * node that is (or was, on failure) executing. `null` when the operation is not
 * running/failed or has no start evidence — the inspector never guesses from the
 * newest completed-node event of a previous operation (Phase 11 review fix).
 */
export function deriveOperationFrontier(
  events: readonly {
    readonly type: string;
    readonly operationId: string | null;
    readonly node: string | null;
  }[],
  newestOperation: { readonly id: string; readonly status: string } | null,
): { readonly node: string | null; readonly status: "active" | "failed" } {
  if (
    !newestOperation ||
    (newestOperation.status !== "running" && newestOperation.status !== "failed")
  ) {
    return { node: null, status: newestOperation?.status === "failed" ? "failed" : "active" };
  }
  const relevant = events.filter((event) => event.operationId === newestOperation.id);
  const started = new Set<string>();
  const completed = new Set<string>();
  let frontierNode: string | null = null;
  // Events arrive newest-first; walk oldest-first to replay start/finish pairs.
  for (const event of [...relevant].reverse()) {
    if (!event.node) {
      continue;
    }
    if (event.type === "node.started") {
      started.add(event.node);
      frontierNode = event.node;
    } else if (event.type === "node.updated") {
      completed.add(event.node);
      if (frontierNode === event.node) {
        frontierNode = null;
      }
    }
  }
  const stillRunning = frontierNode !== null && !completed.has(frontierNode);
  if (!stillRunning) {
    return { node: null, status: "active" };
  }
  return { node: frontierNode, status: newestOperation.status === "failed" ? "failed" : "active" };
}

/**
 * Build the public inspector view. Returns a schema-validated DTO: any row that
 * does not fit a safe field is dropped rather than rendered.
 */
export async function loadPublicInspector(
  client: Queryable,
  tripId: string,
): Promise<PublicInspector> {
  const [
    graphResult,
    nodeEvents,
    operationsResult,
    checkpointsResult,
    llmResult,
    voiceResult,
    faultsResult,
    eventsResult,
    activeResult,
  ] = await Promise.all([
    client.query<{ payload: unknown }>(
      `SELECT payload FROM odft_app.execution_events
          WHERE trip_id = $1 AND type = 'graph.initialized'
          ORDER BY id DESC LIMIT 1`,
      [tripId],
    ),
    client.query<EventRow & { operation_id: string | null }>(
      `SELECT id::text AS id, type, payload, created_at::text AS created_at, operation_id
           FROM odft_app.execution_events
          WHERE trip_id = $1 AND type IN ('node.started', 'node.updated')
          ORDER BY id DESC LIMIT $2`,
      [tripId, MAX_ROWS],
    ),
    client.query<{
      id: string;
      kind: string;
      status: string;
      attempts: number;
      accepted_revision: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, kind, status, attempts, accepted_revision,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM odft_app.workflow_operations
          WHERE trip_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tripId, MAX_ROWS],
    ),
    client.query<{
      id: string;
      kind: string;
      status: string;
      created_revision: number;
      checkpoint_id: string | null;
      interrupt_id: string | null;
      created_at: string;
    }>(
      `SELECT id, kind, status, created_revision, checkpoint_id, interrupt_id,
                created_at::text AS created_at
           FROM odft_app.pending_decisions
          WHERE trip_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tripId, MAX_ROWS],
    ),
    client.query<{
      role: string;
      model: string;
      prompt_version: string;
      mode: string;
      status: string;
      validation_status: string | null;
      attempts: number;
      reserved_tokens: number;
      actual_tokens: number | null;
      reserved_cost_usd: string;
      actual_cost_usd: string | null;
      created_at: string;
    }>(
      `SELECT role, model, prompt_version, mode, status, validation_status, attempts,
                reserved_tokens, actual_tokens, reserved_cost_usd::text AS reserved_cost_usd,
                actual_cost_usd::text AS actual_cost_usd, created_at::text AS created_at
           FROM odft_app.llm_calls
          WHERE trip_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tripId, MAX_ROWS],
    ),
    client.query<{
      kind: string;
      model: string;
      provider_restriction: string | null;
      serving_provider: string | null;
      unit_kind: string | null;
      input_units: string | null;
      latency_ms: number | null;
      status: string;
      cost_status: string | null;
      reserved_cost_usd: string;
      actual_cost_usd: string | null;
      error_code: string | null;
      created_at: string;
    }>(
      // Voice usage stays a separate USD-only ledger; no audio/transcripts.
      `SELECT kind, model, provider_restriction, serving_provider, unit_kind,
                input_units::text AS input_units, latency_ms, status, cost_status,
                reserved_cost_usd::text AS reserved_cost_usd,
                actual_cost_usd::text AS actual_cost_usd, error_code,
                created_at::text AS created_at
           FROM odft_app.voice_calls
          WHERE trip_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tripId, MAX_ROWS],
    ),
    client.query<{ domain: string; fault: string; label: string | null; updated_at: string }>(
      `SELECT domain, fault, state->>'label' AS label, updated_at::text AS updated_at
           FROM odft_app.simulation_faults
          WHERE trip_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [tripId],
    ),
    client.query<EventRow>(
      `SELECT id::text AS id, type, payload, created_at::text AS created_at
           FROM odft_app.execution_events
          WHERE trip_id = $1 ORDER BY id DESC LIMIT $2`,
      [tripId, MAX_ROWS],
    ),
    client.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM odft_app.pending_decisions
          WHERE trip_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [tripId],
    ),
  ]);

  const graphParsed = graphResult.rows[0]
    ? graphDefinitionSchema.safeParse(graphResult.rows[0].payload)
    : undefined;
  const graph = graphParsed?.success ? graphParsed.data : null;

  const pendingDecision = activeResult.rows[0] ?? null;
  const newestOperation = operationsResult.rows[0] ?? null;
  const nodeStats = new Map<string, { occurrences: number; lastAt: string }>();
  for (const row of nodeEvents.rows) {
    const node = shortString(asRecord(row.payload).node, 80);
    if (!node) {
      continue;
    }
    const existing = nodeStats.get(node);
    if (existing) {
      existing.occurrences += 1;
    } else {
      nodeStats.set(node, { occurrences: 1, lastAt: toIso(row.created_at) });
    }
  }
  const nodeIds =
    graph?.nodes.map((node) => node.id) ?? [...nodeStats.keys()].sort((a, b) => a.localeCompare(b));
  const frontier = deriveOperationFrontier(
    nodeEvents.rows.map((row) => ({
      type: row.type,
      operationId: row.operation_id,
      node: shortString(asRecord(row.payload).node, 80),
    })),
    newestOperation,
  );
  const nodes: PublicInspectorNode[] = nodeIds.map((name) => {
    const stats = nodeStats.get(name);
    let status: PublicInspectorNode["status"] = stats ? "completed" : "pending";
    if (pendingDecision && name === "await_decision") {
      status = "interrupted";
    } else if (frontier.node === name) {
      // Real start evidence: the node started in the newest operation without a
      // matching completion event is the frontier — active while the operation
      // runs, failed when it failed (Phase 11 review fix).
      status = frontier.status;
    }
    return {
      name,
      status,
      occurrences: Math.min(stats?.occurrences ?? 0, 10_000),
      lastAt: stats?.lastAt ?? null,
    };
  });

  const operations = operationsResult.rows.flatMap((row) => {
    const status = operationStatusSchema.safeParse(row.status);
    if (!status.success) {
      return [];
    }
    return [
      {
        operationId: row.id,
        kind: (row.kind === "creation" || row.kind === "decision" ? row.kind : "command") as
          "command" | "creation" | "decision",
        status: status.data,
        attempts: row.attempts,
        acceptedRevision: row.accepted_revision,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      },
    ];
  });

  const checkpoints = checkpointsResult.rows.flatMap((row) => {
    const kind = decisionKindSchema.safeParse(row.kind);
    const status =
      row.status === "pending" || row.status === "resolved" || row.status === "cancelled"
        ? row.status
        : undefined;
    if (!kind.success || !status) {
      return [];
    }
    return [
      {
        decisionId: row.id,
        kind: kind.data,
        status,
        createdRevision: row.created_revision,
        checkpointId: row.checkpoint_id,
        interruptId: row.interrupt_id,
        createdAt: toIso(row.created_at),
      },
    ];
  });

  const llmCalls = llmResult.rows.flatMap((row) => {
    const role =
      row.role === "intent" ||
      row.role === "recommendation" ||
      row.role === "planner" ||
      row.role === "reviewer"
        ? row.role
        : null;
    if (!role || (row.mode !== "fixture" && row.mode !== "openrouter")) {
      return [];
    }
    return [
      {
        role,
        model: row.model,
        promptVersion: row.prompt_version,
        mode: row.mode as "fixture" | "openrouter",
        status: row.status,
        validationStatus: row.validation_status,
        attempts: row.attempts,
        reservedTokens: row.reserved_tokens,
        actualTokens: row.actual_tokens,
        reservedCostUsd: row.reserved_cost_usd,
        actualCostUsd: row.actual_cost_usd,
        createdAt: toIso(row.created_at),
      },
    ];
  });
  // The footer total sums exactly the DISPLAYED rows with the same rule the rows
  // render: a settled actual amount replaces its reservation, an unsettled row
  // counts at its reserved worst case (BigInt-scaled, never a lossy float).
  const llmCostTotalUsd = formatUsdAmount(
    llmCalls.reduce(
      (total, call) => total + parseUsdAmount(call.actualCostUsd ?? call.reservedCostUsd),
      0n,
    ),
  );

  const voiceCalls = voiceResult.rows.flatMap((row): PublicVoiceCall[] => {
    const parsed = publicVoiceCallSchema.safeParse({
      kind: row.kind,
      model: row.model,
      restrictedProviderId: row.provider_restriction,
      servingProviderId: row.serving_provider,
      unitKind: row.unit_kind,
      inputUnits: row.input_units === null ? null : Number(row.input_units),
      latencyMs: row.latency_ms,
      status: row.status,
      costStatus: row.cost_status,
      // Trim numeric(18,9) padding so the DTO never implies false precision.
      reservedCostUsd: formatUsdAmount(usdFromDb(row.reserved_cost_usd)),
      actualCostUsd:
        row.actual_cost_usd === null ? null : formatUsdAmount(usdFromDb(row.actual_cost_usd)),
      // Internal-only codes (e.g. VOICE_REQUEST_ABORTED) are not part of the
      // public taxonomy: keep the row visible with a null safe code instead of
      // dropping the whole telemetry row.
      errorCode: errorCodeSchema.safeParse(row.error_code).success ? row.error_code : null,
      createdAt: toIso(row.created_at),
    });
    return parsed.success ? [parsed.data] : [];
  });

  const faults = faultsResult.rows.flatMap((row) => {
    // Injected faults target a scenario domain or the itinerary attempt.
    const domain =
      row.domain === "itinerary"
        ? { success: true as const, data: "itinerary" as const }
        : scenarioDomainSchema.safeParse(row.domain);
    if (!domain.success) {
      return [];
    }
    const parsed = publicInspectorFaultSchema.safeParse({
      domain: domain.data,
      mode: row.fault,
      label: "Simulated failure",
      note: row.label ? row.label.slice(0, 300) : null,
      at: toIso(row.updated_at),
    });
    return parsed.success ? [parsed.data] : [];
  });

  const events = eventsResult.rows.map(rowToEvent);
  const scenarioMode = faultsResult.rows[0]?.fault ?? "normal";

  const candidate = {
    scenarioMode,
    graph,
    nodes,
    operations,
    checkpoints,
    llmCalls,
    llmCostTotalUsd,
    voiceCalls,
    faults,
    events,
  };
  const parsed = publicInspectorSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }
  // A row that does not fit a safe field must never break the projection: return
  // the same shape with the offending collections dropped.
  return publicInspectorSchema.parse({
    scenarioMode,
    graph,
    nodes: [],
    operations: [],
    checkpoints: [],
    llmCalls: [],
    llmCostTotalUsd: "0",
    voiceCalls: [],
    faults: [],
    events: [],
  });
}
