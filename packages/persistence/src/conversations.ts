import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ConversationRole } from "@odft/contracts";
import { assertOperationFence, type OperationFence } from "./effects.js";
import { insertEvent } from "./events.js";

/**
 * Persistent conversation (07-conversation-and-intents.md section 6).
 *
 * The user message is stored inside the admission transaction, the assistant
 * outcome message only after the operation result is persisted. A duplicate
 * `requestId` reuses the original message (partial unique index) instead of
 * appending another entry.
 */

export interface ConversationMessageRecord {
  readonly id: string;
  readonly tripId: string;
  readonly sequence: number;
  readonly role: ConversationRole;
  readonly content: string;
  readonly interpretation: unknown | null;
  readonly result: unknown | null;
  readonly operationId: string | null;
  readonly createdAt: string;
}

interface MessageRow {
  id: string;
  trip_id: string;
  sequence: number;
  role: ConversationRole;
  content: string;
  interpretation: unknown | null;
  result: unknown | null;
  operation_id: string | null;
  created_at: string;
}

function toRecord(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    tripId: row.trip_id,
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    interpretation: row.interpretation,
    result: row.result,
    operationId: row.operation_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const MESSAGE_COLUMNS =
  "id, trip_id, sequence, role, content, interpretation, result, operation_id, created_at::text AS created_at";

export interface AppendMessageInput {
  readonly tripId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly interpretation?: unknown;
  readonly result?: unknown;
  readonly operationId?: string;
  /** Admission request id; a duplicate reuses the stored message. */
  readonly requestId?: string;
  /** When set, the write is refused unless this worker still holds the fence. */
  readonly fence?: OperationFence;
}

/**
 * Insert one message using an existing transaction. The caller owns BEGIN/COMMIT;
 * the per-trip advisory lock makes sequence allocation race-free.
 */
export async function insertConversationMessage(
  client: PoolClient,
  input: AppendMessageInput,
): Promise<ConversationMessageRecord> {
  if (input.fence) {
    await assertOperationFence(client, input.fence);
  }
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `conversation:${input.tripId}`,
  ]);
  const sequenceResult = await client.query<{ next: string }>(
    `SELECT (COALESCE(MAX(sequence), 0) + 1)::text AS next
       FROM odft_app.conversation_messages WHERE trip_id = $1`,
    [input.tripId],
  );
  const sequence = Number.parseInt(sequenceResult.rows[0]?.next ?? "1", 10);
  const id = randomUUID();
  // RETURNING distinguishes a fresh insertion from a request-id duplicate: the
  // durable `conversation.message_added` event is written exactly once, inside
  // the same transaction as the message (VOICE_CONTROLL.md section 9).
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO odft_app.conversation_messages
       (id, trip_id, sequence, role, content, interpretation, result, operation_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     ON CONFLICT (trip_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      id,
      input.tripId,
      sequence,
      input.role,
      input.content,
      input.interpretation === undefined ? null : JSON.stringify(input.interpretation),
      input.result === undefined ? null : JSON.stringify(input.result),
      input.operationId ?? null,
      input.requestId ?? null,
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) {
    // Exactly the allowlisted safe metadata; message content and interpretation
    // never enter the event. The operation id stays the event's envelope field.
    await insertEvent(client, {
      tripId: input.tripId,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      type: "conversation.message_added",
      payload: { messageId: insertedId, sequence, role: input.role },
    });
  }
  // Re-read by request id so a duplicate request returns the stored message.
  const stored = input.requestId
    ? await client.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM odft_app.conversation_messages
          WHERE trip_id = $1 AND request_id = $2`,
        [input.tripId, input.requestId],
      )
    : await client.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM odft_app.conversation_messages WHERE id = $1`,
        [id],
      );
  const row = stored.rows[0];
  if (!row) {
    throw new Error("conversation message insert did not return a row");
  }
  return toRecord(row);
}

/** Append one message in its own short transaction. */
export async function appendConversationMessage(
  pool: Pool,
  input: AppendMessageInput,
): Promise<ConversationMessageRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await insertConversationMessage(client, input);
    await client.query("COMMIT");
    return record;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original error matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Recent messages in ascending sequence order. */
export async function listConversation(
  client: Pool | PoolClient,
  tripId: string,
  limit = 20,
): Promise<ConversationMessageRecord[]> {
  const result = await client.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM odft_app.conversation_messages
      WHERE trip_id = $1 ORDER BY sequence DESC LIMIT $2`,
    [tripId, Math.max(1, Math.min(limit, 100))],
  );
  return result.rows.map(toRecord).reverse();
}

/** The latest stored clarification interpretation for a trip, if any. */
export async function latestClarification(
  client: Pool | PoolClient,
  tripId: string,
): Promise<unknown | undefined> {
  const result = await client.query<{ interpretation: unknown }>(
    `SELECT interpretation FROM odft_app.conversation_messages
      WHERE trip_id = $1 AND interpretation IS NOT NULL
      ORDER BY sequence DESC LIMIT 1`,
    [tripId],
  );
  return result.rows[0]?.interpretation;
}

/**
 * One message by trip and id (VOICE_CONTROLL.md section 7 synthesis): the trip
 * predicate makes a wrong-trip id indistinguishable from a missing one.
 */
export async function getConversationMessage(
  client: Pool | PoolClient,
  tripId: string,
  messageId: string,
): Promise<ConversationMessageRecord | undefined> {
  const result = await client.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM odft_app.conversation_messages
      WHERE trip_id = $1 AND id = $2`,
    [tripId, messageId],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}
