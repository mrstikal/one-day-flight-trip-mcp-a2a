import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { lockOperationFence, type OperationFencingContext } from "./operations/fencing.js";

/**
 * Recommendation artifacts (05 sections 7 and 11): the persisted, idempotent
 * output of one domain research/ranking pass. The artifact stores the input
 * fingerprint it was computed from, so a refresh can prove which domain hash and
 * effective preferences produced the ranked ids. Writing is idempotent per
 * `(trip, service, input fingerprint)`: a crash replay upserts the same row
 * instead of appending a duplicate.
 */

type Queryable = Pick<PoolClient, "query">;

export interface RecommendationArtifactInput {
  readonly tripId: string;
  /** `hotel` | `breakfast` | `lunch` | `dinner` | `attractions` | `events`. */
  readonly serviceKey: string;
  readonly inputFingerprint: string;
  readonly rankedOfferIds: readonly string[];
  readonly snapshotRefs?: readonly string[];
  readonly explanation?: string | null;
}

export interface RecommendationArtifactRecord {
  readonly id: string;
  readonly serviceKey: string;
  readonly inputFingerprint: string;
  readonly rankedOfferIds: string[];
  readonly explanation: string | null;
}

/**
 * Deterministic artifact UUID: the first 32 hex characters of
 * `sha256(tripId:serviceKey:inputFingerprint)` formatted as an RFC 4122 v4
 * UUID (version/variant nibbles forced). Replaying an identical ranking
 * therefore writes the same row.
 */
export function artifactIdFor(input: {
  readonly tripId: string;
  readonly serviceKey: string;
  readonly inputFingerprint: string;
}): string {
  const hex = createHash("sha256")
    .update(`${input.tripId}:${input.serviceKey}:${input.inputFingerprint}`, "utf8")
    .digest("hex");
  const chars = hex.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "a";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/**
 * Upsert one artifact. When a fencing context is given, the write is guarded by
 * the operation's exact fencing token inside a short transaction (never held
 * across a provider call): a worker that lost its lease writes nothing.
 */
export async function recordRecommendationArtifact(
  pool: Pool,
  input: RecommendationArtifactInput,
  fence?: OperationFencingContext,
): Promise<string> {
  const id = artifactIdFor(input);
  const parameters = [
    id,
    input.tripId,
    input.serviceKey,
    input.inputFingerprint,
    JSON.stringify(input.snapshotRefs ?? []),
    JSON.stringify(input.rankedOfferIds),
    input.explanation ?? null,
  ];
  const upsert = `INSERT INTO odft_app.recommendation_artifacts
       (id, trip_id, service_key, input_fingerprint, snapshot_refs, ranked_offers, explanation)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
     ON CONFLICT (id) DO UPDATE
       SET input_fingerprint = EXCLUDED.input_fingerprint,
           snapshot_refs = EXCLUDED.snapshot_refs,
           ranked_offers = EXCLUDED.ranked_offers,
           explanation = EXCLUDED.explanation`;
  if (!fence) {
    await pool.query(upsert, parameters);
    return id;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockOperationFence(client, fence);
    await client.query(upsert, parameters);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The newest artifact per service for a trip (safe read for projections/tests). */
export async function listLatestRecommendationArtifacts(
  client: Queryable,
  tripId: string,
): Promise<RecommendationArtifactRecord[]> {
  const result = await client.query<{
    id: string;
    service_key: string;
    input_fingerprint: string;
    ranked_offers: unknown;
    explanation: string | null;
  }>(
    `SELECT DISTINCT ON (service_key) id, service_key, input_fingerprint, ranked_offers, explanation
       FROM odft_app.recommendation_artifacts
      WHERE trip_id = $1
      ORDER BY service_key, created_at DESC, id DESC`,
    [tripId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    serviceKey: row.service_key,
    inputFingerprint: row.input_fingerprint,
    rankedOfferIds: Array.isArray(row.ranked_offers)
      ? (row.ranked_offers as unknown[]).filter((value): value is string => typeof value === "string")
      : [],
    explanation: row.explanation,
  }));
}