import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendConversationMessage,
  insertConversationMessage,
  insertEvent,
  listTripEvents,
} from "@odft/persistence";
import { createGraphTestPool, createHarnessTrip, resetGraphDatabase } from "../graph/_setup.js";

/**
 * T-IT-VOICE-06/07 (VOICE_CONTROLL.md section 15): one `conversation.message_added`
 * event per inserted message, none for duplicates, the persisted payload is the
 * allowlisted metadata only, terminal-before-message ordering holds, cursor
 * replay keeps stable monotonic ids, and appending never changes graph
 * completion semantics.
 */

describe("atomic conversation delivery", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createGraphTestPool(8);
    await resetGraphDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("writes one message and exactly one safe event per insertion, and nothing for a duplicate", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const requestId = randomUUID();
    const first = await appendConversationMessage(pool, {
      tripId,
      role: "user",
      content: "Make the day less exhausting",
      requestId,
      interpretation: { intent: "adjust_pace" },
    });
    const duplicate = await appendConversationMessage(pool, {
      tripId,
      role: "user",
      content: "Make the day less exhausting",
      requestId,
      interpretation: { intent: "adjust_pace" },
    });
    expect(duplicate.id).toBe(first.id);

    const messages = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.conversation_messages WHERE trip_id = $1`,
      [tripId],
    );
    expect(messages.rows[0]?.count).toBe("1");
    const events = await pool.query<{ payload: unknown; operation_id: string | null }>(
      `SELECT payload, operation_id FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'conversation.message_added' ORDER BY id ASC`,
      [tripId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.payload).toEqual({
      messageId: first.id,
      sequence: first.sequence,
      role: "user",
    });
    expect(events.rows[0]?.operation_id).toBeNull();

    const second = await appendConversationMessage(pool, {
      tripId,
      role: "assistant",
      content: "Adjusted the pace.",
      requestId: randomUUID(),
    });
    expect(second.sequence).toBe(2);
    const afterSecond = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'conversation.message_added'`,
      [tripId],
    );
    expect(afterSecond.rows[0]?.count).toBe("2");
  });

  it("rolls back the message and its event together", async () => {
    const { tripId } = await createHarnessTrip(pool);
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await insertConversationMessage(writer, {
        tripId,
        role: "user",
        content: "transient message",
        requestId: randomUUID(),
      });
      await writer.query("ROLLBACK");
    } finally {
      writer.release();
    }
    const messages = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.conversation_messages WHERE trip_id = $1`,
      [tripId],
    );
    const events = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.execution_events
        WHERE trip_id = $1 AND type = 'conversation.message_added'`,
      [tripId],
    );
    expect(messages.rows[0]?.count).toBe("0");
    expect(events.rows[0]?.count).toBe("0");
  });

  it("orders the terminal event before its outcome message and replays stable monotonic ids", async () => {
    const { tripId, creationOperationId } = await createHarnessTrip(pool);
    const revisionBefore = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    await insertEvent(pool, {
      tripId,
      operationId: creationOperationId,
      type: "operation.succeeded",
      payload: { summary: "creation completed" },
    });

    // The append holds BOTH the message and its event uncommitted: readers must
    // not observe the message event before the message itself commits.
    const writer = await pool.connect();
    let messageSequence = 0;
    let committed = false;
    try {
      await writer.query("BEGIN");
      const message = await insertConversationMessage(writer, {
        tripId,
        role: "assistant",
        content: "Your trip is ready.",
        operationId: creationOperationId,
        requestId: randomUUID(),
      });
      messageSequence = message.sequence;
      const midTransaction = await listTripEvents(pool, tripId, {});
      expect(midTransaction.some((event) => event.type === "conversation.message_added")).toBe(
        false,
      );
      await writer.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) {
        try {
          await writer.query("ROLLBACK");
        } catch {
          // The connection may already be gone; the assertion failure matters.
        }
      }
      writer.release();
    }

    const all = await listTripEvents(pool, tripId, {});
    const terminalIndex = all.findIndex((event) => event.type === "operation.succeeded");
    const messageIndex = all.findIndex((event) => event.type === "conversation.message_added");
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeGreaterThan(terminalIndex);
    expect(all[messageIndex]?.operationId).toBe(creationOperationId);
    // Monotonic bigint ids, never lossy numbers.
    const ids = all.map((event) => BigInt(event.id));
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]! > ids[index - 1]!).toBe(true);
    }

    // Cursor replay: paging by `after` returns exactly the remaining events with
    // the same ids and order as a full replay.
    const firstPage = await listTripEvents(pool, tripId, { limit: 1 });
    expect(firstPage).toHaveLength(1);
    const rest = await listTripEvents(pool, tripId, { after: firstPage[0]!.id });
    expect(rest.map((event) => event.id)).toEqual(all.slice(1).map((event) => event.id));
    const replay = await listTripEvents(pool, tripId, {});
    expect(replay.map((event) => event.id)).toEqual(all.map((event) => event.id));

    // The append never altered graph completion semantics: no revision change,
    // no pending decision, and the operation row itself is untouched.
    const revisionAfter = await pool.query<{ revision: number }>(
      `SELECT revision FROM odft_app.trips WHERE id = $1`,
      [tripId],
    );
    expect(revisionAfter.rows[0]?.revision).toBe(revisionBefore.rows[0]?.revision);
    const decisions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM odft_app.pending_decisions WHERE trip_id = $1`,
      [tripId],
    );
    expect(decisions.rows[0]?.count).toBe("0");
    const operation = await pool.query<{ status: string }>(
      `SELECT status FROM odft_app.workflow_operations WHERE id = $1`,
      [creationOperationId],
    );
    expect(operation.rows[0]?.status).toBe("queued");
    expect(messageSequence).toBe(1);
  });
});
