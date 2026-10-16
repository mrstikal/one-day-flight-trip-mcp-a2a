import { haversineKm, type LatLon } from "./catchments.js";

/**
 * On-demand landmark discovery (2026-10-13).
 *
 * The reviewed reference asset (`data/reference/landmarks.ndjson`) pins a small
 * curated set of cities and stays offline-reproducible. For every other city the
 * scenario generator may only offer explicitly synthetic generic activities, so
 * this client looks a city's notable places up from Wikidata (CC0) once: famous
 * tourist attractions inside the city envelope, most-linked first, mapped to the
 * same landmark shape the reviewed rows use (`wikidata:Q<id>`, name, coordinates,
 * source URL). Callers persist the result and mark the city curated; a failed or
 * empty lookup falls back to the generic categories and must never fail a trip.
 *
 * Two queries keep it fast: (1) around + class + sitelink count, grouped per
 * item, ordered by notability (the label service makes that join ~5x slower), then
 * (2) one label lookup for the selected QIDs only.
 */

export interface DiscoveredLandmark {
  readonly qid: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** Wikipedia sitelink count used for notability ordering. */
  readonly sitelinks: number;
}

export interface LandmarkDiscoveryInput {
  readonly center: LatLon;
  readonly envelopeRadiusKm: number;
  readonly language?: string;
  readonly limit?: number;
  /** Budget for the WHOLE discovery (both queries); defaults to 30 s. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
/**
 * Attraction classes kept close to the curated set's intent: tourist attraction,
 * museum, park, monument, castle, church building, cathedral, botanical garden,
 * zoo, amusement park, observation tower.
 */
const ATTRACTION_CLASS_QIDS = [
  "Q570116",
  "Q33506",
  "Q22698",
  "Q4989906",
  "Q23413",
  "Q16970",
  "Q2977",
  "Q167346",
  "Q43501",
  "Q194195",
  "Q1440300",
] as const;
const DEFAULT_LIMIT = 24;
const DEFAULT_TIMEOUT_MS = 30_000;

/** The items query (exported so tests pin its exact shape). */
export function landmarkDiscoveryQuery(input: {
  readonly center: LatLon;
  readonly radiusKm: number;
  readonly limit: number;
}): string {
  return [
    "SELECT ?item (SAMPLE(?rawCoord) AS ?coord) (MAX(?rawLinks) AS ?sitelinks) WHERE {",
    "  SERVICE wikibase:around {",
    "    ?item wdt:P625 ?rawCoord .",
    `    bd:serviceParam wikibase:center "Point(${input.center.lon} ${input.center.lat})"^^geo:wktLiteral .`,
    `    bd:serviceParam wikibase:radius "${input.radiusKm}" .`,
    "  }",
    `  VALUES ?class { ${ATTRACTION_CLASS_QIDS.map((qid) => `wd:${qid}`).join(" ")} }`,
    "  ?item wdt:P31 ?class .",
    "  ?item wikibase:sitelinks ?rawLinks .",
    "}",
    "GROUP BY ?item",
    "ORDER BY DESC(?sitelinks)",
    `LIMIT ${input.limit}`,
  ].join("\n");
}

/** The label lookup for the selected QIDs (exported so tests pin its exact shape). */
export function landmarkLabelQuery(input: {
  readonly qids: readonly string[];
  readonly language: string;
}): string {
  return [
    "SELECT ?item ?itemLabel WHERE {",
    `  VALUES ?item { ${input.qids.map((qid) => `wd:${qid}`).join(" ")} }`,
    `  SERVICE wikibase:label { bd:serviceParam wikibase:language "${input.language}". }`,
    "}",
  ].join("\n");
}

interface SparqlResponse {
  readonly results?: { readonly bindings?: readonly Record<string, { readonly value?: unknown }>[] };
}

async function runSparql(
  fetchImpl: typeof fetch,
  query: string,
  signal: AbortSignal,
): Promise<SparqlResponse> {
  const response = await fetchImpl(`${WIKIDATA_SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`, {
    headers: {
      accept: "application/sparql-results+json",
      "user-agent": "one-day-flight-trip-demo/1.0 (landmark reference discovery)",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Wikidata discovery failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as SparqlResponse;
  if (!Array.isArray(body.results?.bindings)) {
    throw new Error("Wikidata discovery returned an unexpected response shape");
  }
  return body;
}

function qidOf(uri: unknown): string {
  return typeof uri === "string" ? (uri.split("/").pop() ?? "") : "";
}

/** `Point(lon lat)` from a geo:wktLiteral binding. */
function parseWktPoint(value: unknown): LatLon | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Point\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  return { lat, lon };
}

export async function discoverCityLandmarks(
  input: LandmarkDiscoveryInput,
): Promise<DiscoveredLandmark[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const language = input.language ?? "en";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const items = await runSparql(
      fetchImpl,
      landmarkDiscoveryQuery({
        center: input.center,
        radiusKm: input.envelopeRadiusKm,
        limit,
      }),
      controller.signal,
    );
    const envelope = { ...input.center, envelopeRadiusKm: input.envelopeRadiusKm };
    const seen = new Set<string>();
    const candidates: { qid: string; lat: number; lon: number; sitelinks: number }[] = [];
    for (const binding of items.results?.bindings ?? []) {
      const qid = qidOf(binding["item"]?.value);
      const coord = parseWktPoint(binding["coord"]?.value);
      const sitelinks = Number(binding["sitelinks"]?.value ?? 0);
      if (!/^Q\d+$/.test(qid) || seen.has(qid) || !coord) {
        continue;
      }
      if (haversineKm(envelope, coord) > input.envelopeRadiusKm) {
        continue;
      }
      seen.add(qid);
      candidates.push({
        qid,
        lat: coord.lat,
        lon: coord.lon,
        sitelinks: Number.isFinite(sitelinks) ? sitelinks : 0,
      });
      if (candidates.length >= limit) {
        break;
      }
    }
    if (candidates.length === 0) {
      return [];
    }

    const labels = await runSparql(
      fetchImpl,
      landmarkLabelQuery({ qids: candidates.map((candidate) => candidate.qid), language }),
      controller.signal,
    );
    const labelByQid = new Map<string, string>();
    for (const binding of labels.results?.bindings ?? []) {
      const qid = qidOf(binding["item"]?.value);
      const label = typeof binding["itemLabel"]?.value === "string" ? binding["itemLabel"].value : "";
      // An unlabeled item falls back to its QID; never present that as a venue.
      if (qid && label.length > 0 && label !== qid) {
        labelByQid.set(qid, label);
      }
    }
    return candidates
      .filter((candidate) => labelByQid.has(candidate.qid))
      .map((candidate) => ({
        qid: candidate.qid,
        name: labelByQid.get(candidate.qid) as string,
        lat: candidate.lat,
        lon: candidate.lon,
        sitelinks: candidate.sitelinks,
      }));
  } finally {
    clearTimeout(timeout);
  }
}