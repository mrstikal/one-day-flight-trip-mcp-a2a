import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { buildFixtureInventory } from "./offers.js";

/**
 * Insert a `scenario_snapshots` row with fixture inventory and point the trip at
 * it. Snapshot/approval content is Phase 04's engine; here it is a fixed test
 * input so `BookingService` is testable before the generator exists.
 */
export async function insertFixtureSnapshot(
  client: Pick<PoolClient, "query">,
  input: { tripId: string; scenarioKey?: string },
): Promise<string> {
  const id = randomUUID();
  const inventory = buildFixtureInventory();
  await client.query(
    `INSERT INTO odft_app.scenario_snapshots
       (id, trip_id, scenario_key, snapshot_version, manifest, inventory, content_hashes, generated_at)
     VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb, $6::jsonb, now())`,
    [
      id,
      input.tripId,
      input.scenarioKey ?? "fixture-v1",
      JSON.stringify({ scenarioId: input.tripId }),
      JSON.stringify(inventory),
      JSON.stringify({ flights: "0".repeat(64) }),
    ],
  );
  await client.query(`UPDATE odft_app.trips SET active_scenario_snapshot_id = $2 WHERE id = $1`, [
    input.tripId,
    id,
  ]);
  return id;
}
