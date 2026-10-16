import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  computeDomainHashes,
  extendSnapshotContent,
  generateActivities,
  generateEvents,
  generateHotels,
  generateMeals,
  materializedDomains,
  type SnapshotAdditions,
  assertSnapshotBounded,
  type SnapshotSource,
} from "@odft/data";
import {
  FAKER_VERSION,
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  snapshotContentSchema,
  scenarioManifestSchema,
  type ScenarioDomain,
  type ScenarioDomainHashes,
  type ScenarioDomainVersions,
  type ScenarioManifest,
  type SnapshotContent,
  type SnapshotInput,
} from "@odft/contracts";
import { getCuratedLandmarks } from "../reference/repository.js";

/**
 * Scenario snapshot persistence (05 section 7). Snapshots are immutable; a
 * genuine extension appends a new `snapshot_version` that preserves prior offer
 * IDs and unrelated domain hashes. `ensureDomains` is idempotent and appends at
 * most one version per call.
 */

type Queryable = Pick<PoolClient, "query">;

interface SnapshotRow {
  id: string;
  scenario_key: string;
  snapshot_version: number;
  manifest: unknown;
  inventory: unknown;
  content_hashes: unknown;
  generated_at: Date;
}

/** Deterministic UUID derived from the scenario key (stable scenario identity). */
export function scenarioUuid(scenarioKey: string): string {
  const hex = createHash("sha256").update(scenarioKey, "utf8").digest("hex").slice(0, 32);
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function versionsFor(
  hashes: ScenarioDomainHashes,
  materialized: readonly ScenarioDomain[],
  previous?: ScenarioManifest,
): ScenarioDomainVersions {
  const result: ScenarioDomainVersions = {
    flights: 0,
    hotels: 0,
    breakfast: 0,
    lunch: 0,
    dinner: 0,
    activities: 0,
    events: 0,
  };
  const domains: ScenarioDomain[] = [
    "flights",
    "hotels",
    "breakfast",
    "lunch",
    "dinner",
    "activities",
    "events",
  ];
  for (const domain of domains) {
    const previousVersion = previous?.domainVersions[domain] ?? 0;
    const previousHash = previous?.domainContentHashes[domain];
    if (!materialized.includes(domain)) {
      result[domain] = previousVersion;
    } else if (previousHash === hashes[domain]) {
      result[domain] = previousVersion;
    } else {
      result[domain] = previousVersion + 1;
    }
  }
  return result;
}

function buildManifest(
  snapshotId: string,
  content: SnapshotContent,
  routeFingerprint: string,
  scenarioId: string,
  previous?: ScenarioManifest,
): ScenarioManifest {
  const hashes = computeDomainHashes(content);
  const materialized = materializedDomains(content);
  return scenarioManifestSchema.parse({
    scenarioId,
    snapshotId,
    snapshotVersion: previous ? previous.snapshotVersion + 1 : 1,
    scenarioKey: content.scenarioKey,
    seed: content.seed,
    generatorVersion: content.generatorVersion,
    fakerVersion: content.fakerVersion,
    referenceVersion: content.referenceVersion,
    generatedAt: content.generatedAt,
    destinationCityId: content.context.destinationCityId,
    routeFingerprint,
    materializedDomains: materialized,
    domainVersions: versionsFor(hashes, materialized, previous),
    domainContentHashes: hashes,
  });
}

async function loadLatestSnapshotRow(
  client: Queryable,
  tripId: string,
): Promise<SnapshotRow | undefined> {
  const result = await client.query<SnapshotRow>(
    `SELECT id, scenario_key, snapshot_version, manifest, inventory, content_hashes, generated_at
       FROM odft_app.scenario_snapshots WHERE trip_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
    [tripId],
  );
  return result.rows[0];
}

async function insertSnapshot(
  client: Queryable,
  tripId: string,
  content: SnapshotContent,
  manifest: ScenarioManifest,
): Promise<void> {
  await client.query(
    `INSERT INTO odft_app.scenario_snapshots
       (id, trip_id, scenario_key, snapshot_version, manifest, inventory, content_hashes, generated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
    [
      manifest.snapshotId,
      tripId,
      content.scenarioKey,
      manifest.snapshotVersion,
      JSON.stringify(manifest),
      JSON.stringify(content),
      JSON.stringify(manifest.domainContentHashes),
      content.generatedAt,
    ],
  );
  await client.query(
    `UPDATE odft_app.trips SET active_scenario_snapshot_id = $2, updated_at = now() WHERE id = $1`,
    [tripId, manifest.snapshotId],
  );
}

/** Insert the first immutable snapshot version for a trip. */
export async function persistSnapshot(pool: Pool, input: SnapshotInput): Promise<ScenarioManifest> {
  const content = snapshotContentSchema.parse(input.content);
  assertSnapshotBounded(content);
  if (content.routeFingerprint !== input.routeFingerprint) {
    throw new Error("snapshot content routeFingerprint must match the persisted route fingerprint");
  }
  const manifest = buildManifest(randomUUID(), content, input.routeFingerprint, input.scenarioId);
  if (manifest.snapshotVersion !== input.snapshotVersion) {
    throw new Error(
      `snapshot version mismatch: input ${input.snapshotVersion} but computed ${manifest.snapshotVersion}`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertSnapshot(client, input.tripId, content, manifest);
    await client.query("COMMIT");
    return manifest;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadSnapshotManifest(
  client: Queryable,
  snapshotId: string,
): Promise<ScenarioManifest> {
  const result = await client.query<{ manifest: unknown }>(
    `SELECT manifest FROM odft_app.scenario_snapshots WHERE id = $1`,
    [snapshotId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`snapshot ${snapshotId} not found`);
  }
  return scenarioManifestSchema.parse(row.manifest);
}

export async function loadSnapshotContent(
  client: Queryable,
  snapshotId: string,
): Promise<SnapshotContent | undefined> {
  const result = await client.query<{ inventory: unknown }>(
    `SELECT inventory FROM odft_app.scenario_snapshots WHERE id = $1`,
    [snapshotId],
  );
  const row = result.rows[0];
  return row ? snapshotContentSchema.parse(row.inventory) : undefined;
}

export async function loadLatestManifest(
  client: Queryable,
  tripId: string,
): Promise<ScenarioManifest | undefined> {
  const row = await loadLatestSnapshotRow(client, tripId);
  return row ? scenarioManifestSchema.parse(row.manifest) : undefined;
}

export interface ExtensionInput {
  readonly tripId: string;
  readonly additions: SnapshotAdditions;
  readonly generatedAt?: string;
}

/**
 * Insert a full replacement snapshot as the next version, or reuse the latest
 * version when its content and route fingerprint already match. Route
 * revalidation after a route change produces a new version; a crash-replay of an
 * unchanged generation reuses the existing row instead of appending.
 */
export async function persistSnapshotVersion(
  pool: Pool,
  input: {
    readonly tripId: string;
    readonly scenarioId: string;
    readonly content: SnapshotContent;
  },
): Promise<{ readonly manifest: ScenarioManifest; readonly reused: boolean }> {
  const content = snapshotContentSchema.parse(input.content);
  assertSnapshotBounded(content);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const latest = await loadLatestSnapshotRow(client, input.tripId);
    if (latest) {
      const latestContent = snapshotContentSchema.parse(latest.inventory);
      if (
        latestContent.scenarioKey === content.scenarioKey &&
        latestContent.routeFingerprint === content.routeFingerprint &&
        JSON.stringify(latestContent.flights) === JSON.stringify(content.flights)
      ) {
        await client.query("COMMIT");
        return { manifest: scenarioManifestSchema.parse(latest.manifest), reused: true };
      }
    }
    const previous = latest ? scenarioManifestSchema.parse(latest.manifest) : undefined;
    const manifest = buildManifest(randomUUID(), content, content.routeFingerprint, input.scenarioId, previous);
    await insertSnapshot(client, input.tripId, content, manifest);
    await client.query("COMMIT");
    return { manifest, reused: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Append a new snapshot version with the given domain additions. */
export async function extendSnapshot(pool: Pool, input: ExtensionInput): Promise<ScenarioManifest> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const latest = await loadLatestSnapshotRow(client, input.tripId);
    if (!latest) {
      await client.query("ROLLBACK");
      throw new Error(`trip ${input.tripId} has no scenario snapshot to extend`);
    }
    const previousManifest = scenarioManifestSchema.parse(latest.manifest);
    const base = snapshotContentSchema.parse(latest.inventory);
    const content = snapshotContentSchema.parse({
      ...extendSnapshotContent(base, input.additions),
      generatedAt: input.generatedAt ?? new Date().toISOString(),
    });
    assertSnapshotBounded(content);
    const snapshotId = randomUUID();
    const manifest = buildManifest(
      snapshotId,
      content,
      previousManifest.routeFingerprint,
      previousManifest.scenarioId,
      previousManifest,
    );
    await insertSnapshot(client, input.tripId, content, manifest);
    await client.query("COMMIT");
    return manifest;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only `SnapshotSource` over persisted inventories (async). */
export class PostgresSnapshotSource implements SnapshotSource {
  constructor(private readonly pool: Pool) {}

  async getContent(snapshotId: string): Promise<SnapshotContent | undefined> {
    const client = await this.pool.connect();
    try {
      return await loadSnapshotContent(client, snapshotId);
    } finally {
      client.release();
    }
  }
}

/**
 * Idempotent per-domain materializer (05 section 7). If a requested domain is
 * already materialized at the current version, nothing is appended.
 */
export class ScenarioService {
  constructor(private readonly pool: Pool) {}

  async ensureDomains(
    tripId: string,
    domains: readonly ScenarioDomain[],
  ): Promise<ScenarioManifest> {
    const client = await this.pool.connect();
    let latest: SnapshotRow | undefined;
    let cityId: string | undefined;
    try {
      latest = await loadLatestSnapshotRow(client, tripId);
      if (latest) {
        const base = snapshotContentSchema.parse(latest.inventory);
        cityId = base.context.destinationCityId;
      }
    } finally {
      client.release();
    }
    if (!latest || !cityId) {
      throw new Error(`trip ${tripId} has no base snapshot to extend`);
    }
    const previousManifest = scenarioManifestSchema.parse(latest.manifest);
    const base = snapshotContentSchema.parse(latest.inventory);
    const requested = new Set(domains);
    const additions: {
      hotels?: SnapshotAdditions["hotels"];
      restaurants?: SnapshotAdditions["restaurants"];
      activities?: SnapshotAdditions["activities"];
      events?: SnapshotAdditions["events"];
    } = {};
    const context = base.context;
    const genInput = {
      scenarioKey: base.scenarioKey,
      seed: base.seed,
      generatorVersion: base.generatorVersion,
      context,
    };

    // Fetch curated landmarks once and reuse them for safe anchors and activities.
    const needsLandmarks =
      requested.has("hotels") ||
      requested.has("breakfast") ||
      requested.has("lunch") ||
      requested.has("dinner") ||
      requested.has("activities") ||
      requested.has("events");
    let landmarkAnchors: { lat: number; lon: number }[] = [];
    if (needsLandmarks) {
      const landmarksClient = await this.pool.connect();
      try {
        const { landmarks } = await getCuratedLandmarks(landmarksClient, cityId);
        landmarkAnchors = landmarks.map((landmark) => ({ lat: landmark.lat, lon: landmark.lon }));
      } finally {
        landmarksClient.release();
      }
    }

    if (requested.has("hotels") && !previousManifest.materializedDomains.includes("hotels")) {
      additions.hotels = generateHotels({ ...genInput, landmarks: landmarkAnchors });
    }
    const mealDomains = (["breakfast", "lunch", "dinner"] as const).filter(
      (meal) => requested.has(meal) && !previousManifest.materializedDomains.includes(meal),
    );
    if (mealDomains.length > 0) {
      additions.restaurants = mealDomains.flatMap((meal) =>
        generateMeals({ ...genInput, meal, landmarks: landmarkAnchors }),
      );
    }
    if (
      requested.has("activities") &&
      !previousManifest.materializedDomains.includes("activities")
    ) {
      const landmarksClient = await this.pool.connect();
      try {
        const { landmarks } = await getCuratedLandmarks(landmarksClient, cityId);
        additions.activities = generateActivities({
          ...genInput,
          landmarks: landmarks.map((landmark) => ({
            id: landmark.id,
            name: landmark.name,
            cityId: landmark.cityId,
            lat: landmark.lat,
            lon: landmark.lon,
            sourceId: landmark.sourceId,
            sourceUrl: landmark.sourceUrl,
          })),
        });
      } finally {
        landmarksClient.release();
      }
    }
    if (requested.has("events") && !previousManifest.materializedDomains.includes("events")) {
      additions.events = generateEvents({ ...genInput, landmarks: landmarkAnchors });
    }

    if (Object.keys(additions).length === 0) {
      return previousManifest;
    }
    return extendSnapshot(this.pool, { tripId, additions });
  }
}

/** Build the initial flight-only snapshot context and content deterministically. */
export function initialSnapshotContent(input: {
  scenarioKey: string;
  seed: string;
  referenceVersion: string;
  routeFingerprint: string;
  generatedAt: string;
  context: SnapshotContent["context"];
  flights: SnapshotContent["flights"];
}): SnapshotContent {
  return snapshotContentSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    scenarioKey: input.scenarioKey,
    seed: input.seed,
    generatorVersion: GENERATOR_VERSION,
    fakerVersion: FAKER_VERSION,
    referenceVersion: input.referenceVersion,
    routeFingerprint: input.routeFingerprint,
    generatedAt: input.generatedAt,
    context: input.context,
    flights: input.flights,
    hotels: [],
    restaurants: [],
    activities: [],
    events: [],
  });
}
