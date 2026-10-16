import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  buildScenarioKey,
  generateFlights,
  SyntheticAccommodationSearchProvider,
  SyntheticFlightSearchProvider,
  validateRoute,
  validateSchedules,
} from "@odft/data";
import {
  GENERATOR_VERSION,
  REFERENCE_VERSION,
  SCHEDULE_RULE_VERSION,
  type FeasibleRouteApproval,
  type RouteInputs,
  type SnapshotContext,
} from "@odft/contracts";
import {
  PostgresSnapshotSource,
  ScenarioService,
  buildRouteInputs,
  currentApprovalGuard,
  evaluateAndPersistRoute,
  getTrip,
  initialSnapshotContent,
  loadFeasibleRouteApproval,
  loadLatestManifest,
  loadReferenceData,
  persistSnapshot,
  persistScheduleValidation,
  runMigrations,
  scenarioUuid,
} from "@odft/persistence";
import { createFixtureSession } from "../../fixtures/session.js";
import {
  FIXTURE_DESTINATION_CITY,
  FIXTURE_ORIGIN_AIRPORT,
  fixtureCreationInput,
} from "../../fixtures/trip.js";
import { FIXTURE_HOTEL_OFFER } from "../../fixtures/offers.js";
import {
  createBookingFixture,
  createBookingService,
  createConfirmationDecision,
  createOperation,
} from "../booking/_setup.js";
import { randomUUID } from "node:crypto";

/** Real-PostgreSQL Stage A/B, snapshot, and independent-guard integration tests. */

function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.replace(/^\//, "").endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL pointing at a *_test database is required");
  }
  return url;
}

const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 4 });

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS odft_app CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS odft_checkpoint CASCADE");
  await runMigrations(pool);
  await loadReferenceData(pool);
});
afterAll(async () => {
  await pool.end();
});

async function createTrip(
  originAirportId: string,
  cityId: string,
  countryKey: string,
): Promise<string> {
  const { createTrip } = await import("@odft/persistence");
  const client = await pool.connect();
  let sessionId: string;
  try {
    sessionId = await createFixtureSession(client);
  } finally {
    client.release();
  }
  const created = await createTrip(pool, {
    sessionId,
    input: fixtureCreationInput({
      originAirportId,
      destinationCityId: cityId,
      destinationCountryKey: countryKey,
    }),
  });
  if (!("tripId" in created)) {
    throw new Error(`createTrip failed: ${created.code}`);
  }
  return created.tripId;
}

interface RouteContext {
  readonly context: SnapshotContext;
  readonly inputs: RouteInputs;
  readonly trip: NonNullable<Awaited<ReturnType<typeof getTrip>>>;
}

async function routeContext(tripId: string): Promise<RouteContext> {
  const client = await pool.connect();
  try {
    const trip = await getTrip(client, tripId);
    if (!trip) {
      throw new Error("trip missing");
    }
    const inputs = await buildRouteInputs(client, trip);
    if (!inputs) {
      throw new Error("route inputs missing");
    }
    const city = await client.query<{ name: string; coverage_flag: string }>(
      `SELECT name, coverage_flag FROM odft_app.reference_cities WHERE id = $1`,
      [trip.destinationCityId],
    );
    const row = city.rows[0];
    const context: SnapshotContext = {
      destinationCityId: trip.destinationCityId,
      countryKey: trip.destinationCountryKey,
      cityName: row?.name ?? "City",
      center: { lat: inputs.destination.lat, lon: inputs.destination.lon },
      envelopeRadiusKm: 16,
      cityZone: inputs.destination.zone as string,
      cityFactor: row?.name === "Paris" ? 1.3 : row?.name === "Barcelona" ? 1.1 : 1.0,
      sightseeingDate: trip.sightseeingDate,
      travelVariant: trip.travelVariant,
      adults: trip.adults,
      isCurated: row?.coverage_flag === "curated_landmarks",
      referenceVersion: REFERENCE_VERSION,
    };
    return { context, inputs, trip };
  } finally {
    client.release();
  }
}

async function approvalFor(tripId: string): Promise<FeasibleRouteApproval> {
  const client = await pool.connect();
  try {
    const approval = await loadFeasibleRouteApproval(client, tripId);
    if (!approval) {
      throw new Error("approval missing");
    }
    return approval;
  } finally {
    client.release();
  }
}

async function persistFlightSnapshot(tripId: string, seed: string) {
  const { context, inputs } = await routeContext(tripId);
  const evaluated = await evaluateAndPersistRoute(pool, tripId);
  if (!evaluated || evaluated.result.status !== "FEASIBLE") {
    throw new Error("expected a feasible route");
  }
  const approval = await approvalFor(tripId);
  const scenarioKey = buildScenarioKey({
    seed,
    originAirportId: inputs.origin.airportId,
    originIata: inputs.origin.iata,
    destinationCityId: context.destinationCityId,
    destinationCountryKey: context.countryKey,
    destinationAirportIds: approval.approvedPairDetails.map((pair) => pair.destinationAirportId),
    sightseeingDate: context.sightseeingDate,
    travelVariant: context.travelVariant,
    adults: context.adults,
    generatorVersion: GENERATOR_VERSION,
    referenceVersion: REFERENCE_VERSION,
    routePolicyVersion: inputs.routePolicyVersion,
  });
  const flights = generateFlights(
    approval,
    {
      scenarioKey,
      seed,
      sightseeingDate: context.sightseeingDate,
      travelVariant: context.travelVariant,
      adults: context.adults,
      generatorVersion: GENERATOR_VERSION,
    },
    inputs,
  );
  const content = initialSnapshotContent({
    scenarioKey,
    seed,
    referenceVersion: REFERENCE_VERSION,
    routeFingerprint: approval.fingerprint,
    generatedAt: "2026-10-10T00:00:00.000Z",
    context,
    flights,
  });
  const manifest = await persistSnapshot(pool, {
    tripId,
    scenarioId: scenarioUuid(scenarioKey),
    snapshotVersion: 1,
    routeFingerprint: approval.fingerprint,
    content,
  });
  return { approval, flights, manifest, inputs, scenarioKey };
}

describe("Stage A/B and scenario snapshots (real PostgreSQL)", () => {
  it("validates PRG -> Rome and produces at least three valid combinations", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    const { approval, flights, manifest, inputs, scenarioKey } = await persistFlightSnapshot(
      tripId,
      "seed-rome",
    );

    expect(approval.approvedAirportPairs.length).toBeGreaterThan(0);
    const schedule = validateSchedules({
      approval,
      combinations: flights,
      scenarioKey,
      flightDomainVersion: manifest.domainVersions.flights,
      flightDomainHash: manifest.domainContentHashes.flights,
      scheduleRuleVersion: SCHEDULE_RULE_VERSION,
      sightseeingDate: inputs.sightseeingDate,
      travelVariant: inputs.travelVariant,
      destinationZone: inputs.destination.zone as string,
      destinationTransferMinutes: approval.approvedPairDetails[0]!.destinationTransferMinutes,
      routeValidationId: approval.routeValidationId,
    });
    expect(schedule.status).toBe("VALID");
    expect(schedule.validCombinationIds.length).toBeGreaterThanOrEqual(3);

    const scheduleId = await persistScheduleValidation(pool, {
      tripId,
      snapshotId: manifest.snapshotId,
      result: schedule,
    });
    expect(scheduleId).toMatch(/[0-9a-f-]{36}/);
  });

  it("blocks PRG -> Ceske Budejovice with GROUND_TRAVEL_PREFERRED and generates no offers", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, "geonames:3077916", "CZ");
    const evaluated = await evaluateAndPersistRoute(pool, tripId);
    expect(evaluated?.result.status).toBe("INFEASIBLE");
    if (evaluated?.result.status === "INFEASIBLE") {
      expect(evaluated.result.reasons.map((reason) => reason.code)).toContain(
        "GROUND_TRAVEL_PREFERRED",
      );
    }
    const snapshots = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM odft_app.scenario_snapshots WHERE trip_id = $1",
      [tripId],
    );
    expect(snapshots.rows[0]?.c).toBe(0);
    expect(await loadLatestManifest(pool, tripId)).toBeUndefined();
  });

  it("admits BCN -> PMI through the island exception", async () => {
    const tripId = await createTrip("ourairports:4004", "geonames:2512989", "ES");
    const evaluated = await evaluateAndPersistRoute(pool, tripId);
    expect(evaluated?.result.status).toBe("FEASIBLE");
    if (evaluated?.result.status === "FEASIBLE") {
      expect(evaluated.result.warnings.map((warning) => warning.code)).toContain(
        "SHORT_ROUTE_UNJUSTIFIED",
      );
    }
  });

  it("extends snapshots idempotently, preserves the flight hash, and serves providers", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    const { manifest, approval } = await persistFlightSnapshot(tripId, "seed-extend");
    const service = new ScenarioService(pool);
    const extended = await service.ensureDomains(tripId, [
      "hotels",
      "breakfast",
      "lunch",
      "dinner",
      "activities",
      "events",
    ]);
    expect(extended.snapshotVersion).toBe(manifest.snapshotVersion + 1);
    expect(extended.domainContentHashes.flights).toBe(manifest.domainContentHashes.flights);
    expect(extended.materializedDomains).toContain("hotels");

    const again = await service.ensureDomains(tripId, [
      "hotels",
      "breakfast",
      "lunch",
      "dinner",
      "activities",
      "events",
    ]);
    expect(again.snapshotId).toBe(extended.snapshotId);

    const source = new PostgresSnapshotSource(pool);
    const hotelProvider = new SyntheticAccommodationSearchProvider(source);
    const hotels = await hotelProvider.search({
      snapshotId: extended.snapshotId,
      level: "standard",
      adults: 2,
      dates: [],
    });
    expect(hotels.status).toBe("ok");

    const flightProvider = new SyntheticFlightSearchProvider(source);
    const flights = await flightProvider.search({
      snapshotId: extended.snapshotId,
      approval,
      travelVariant: "two_nights",
      adults: 2,
    });
    expect(flights.status).toBe("ok");
  });

  it("can reserve an offer from a newly generated snapshot (P1 booking-store fix)", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    const { approval, flights, inputs, scenarioKey } = await persistFlightSnapshot(
      tripId,
      "seed-reserve",
    );
    const scenarioService = new ScenarioService(pool);
    const extended = await scenarioService.ensureDomains(tripId, [
      "hotels",
      "breakfast",
      "lunch",
      "dinner",
      "activities",
      "events",
    ]);

    const schedule = validateSchedules({
      approval,
      combinations: flights,
      scenarioKey,
      flightDomainVersion: extended.domainVersions.flights,
      flightDomainHash: extended.domainContentHashes.flights,
      scheduleRuleVersion: SCHEDULE_RULE_VERSION,
      sightseeingDate: inputs.sightseeingDate,
      travelVariant: inputs.travelVariant,
      destinationZone: inputs.destination.zone as string,
      destinationTransferMinutes: approval.approvedPairDetails[0]!.destinationTransferMinutes,
      routeValidationId: approval.routeValidationId,
    });
    expect(schedule.status).toBe("VALID");
    await persistScheduleValidation(pool, {
      tripId,
      snapshotId: extended.snapshotId,
      result: schedule,
    });

    const source = new PostgresSnapshotSource(pool);
    const content = await source.getContent(extended.snapshotId);
    expect(content).toBeDefined();
    const hotelOfferId = content!.hotels[0]!.id;

    const booking = createBookingService(pool);
    const operationId = await createOperation(pool, tripId);
    const proposal = await booking.propose({
      tripId,
      sessionId: await sessionForTrip(tripId),
      service: "hotel",
      offerId: hotelOfferId,
      operationId,
      sourceFingerprint: "c".repeat(64),
    });
    const decisionId = await createConfirmationDecision(pool, {
      tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: "c".repeat(64),
      allowedOfferIds: [hotelOfferId],
      revision: 1,
    });
    const result = await booking.confirm({
      tripId,
      sessionId: await sessionForTrip(tripId),
      proposalId: proposal.proposalId,
      decisionId,
      operationId: await createOperation(pool, tripId),
      acceptedRevision: 1,
      acceptedDemoDisclaimer: true,
      confirmationKey: randomUUID(),
    });
    expect(result.status).toBe("confirmed");
  });
});

describe("independent approval freshness guards", () => {
  it("rejects the generator guard after a route-input change (T-INV-10a)", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    const { approval, inputs } = await persistFlightSnapshot(tripId, "seed-guard-a");
    await pool.query(`UPDATE odft_app.trips SET sightseeing_date = '2026-12-02' WHERE id = $1`, [
      tripId,
    ]);
    let changed: RouteInputs | undefined;
    const client = await pool.connect();
    try {
      const trip = await getTrip(client, tripId);
      changed = trip ? await buildRouteInputs(client, trip) : undefined;
      expect(changed).toBeDefined();
      if (!changed) {
        throw new Error("changed route inputs unavailable");
      }
      expect(() =>
        generateFlights(
          approval,
          {
            scenarioKey: "key",
            seed: "seed",
            sightseeingDate: inputs.sightseeingDate,
            travelVariant: inputs.travelVariant,
            adults: inputs.adults,
            generatorVersion: GENERATOR_VERSION,
          },
          changed as RouteInputs,
        ),
      ).toThrowError();
    } finally {
      client.release();
    }
  });

  it("reports a fingerprint mismatch after a route-input change (T-INV-10b guard mechanism)", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    await persistFlightSnapshot(tripId, "seed-guard-b");
    const before = await withClient((client) => currentApprovalGuard(client, tripId));
    expect(before.routeApprovalFingerprint).toBe(before.currentRouteFingerprint);
    await pool.query(`UPDATE odft_app.trips SET sightseeing_date = '2026-12-02' WHERE id = $1`, [
      tripId,
    ]);
    const after = await withClient((client) => currentApprovalGuard(client, tripId));
    expect(after.routeApprovalFingerprint).not.toBe(after.currentRouteFingerprint);
  });

  it("keeps the pure Stage A result consistent with the DB-reconstructed inputs", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    const { inputs } = await routeContext(tripId);
    expect(validateRoute(inputs).status).toBe("FEASIBLE");
  });
});

describe("booking confirmation route-freshness guard (T-INV-10b)", () => {
  const FINGERPRINT = "b".repeat(64);

  async function confirmableFixture() {
    const fixture = await createBookingFixture(pool);
    const service = createBookingService(pool);
    const proposal = await service.propose({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      service: "hotel",
      offerId: FIXTURE_HOTEL_OFFER,
      operationId: fixture.operationId,
      sourceFingerprint: FINGERPRINT,
    });
    const decisionId = await createConfirmationDecision(pool, {
      tripId: fixture.tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: FINGERPRINT,
      allowedOfferIds: [FIXTURE_HOTEL_OFFER],
      revision: fixture.revision,
    });
    const operationId = await createOperation(pool, fixture.tripId);
    return { fixture, service, proposal, decisionId, operationId };
  }

  it("confirms while the approval is fresh", async () => {
    const { fixture, service, proposal, decisionId, operationId } = await confirmableFixture();
    const result = await service.confirm({
      tripId: fixture.tripId,
      sessionId: fixture.sessionId,
      proposalId: proposal.proposalId,
      decisionId,
      operationId,
      acceptedRevision: fixture.revision,
      acceptedDemoDisclaimer: true,
      confirmationKey: randomUUID(),
    });
    expect(result.status).toBe("confirmed");
  });

  it("rejects confirmation after the route inputs change", async () => {
    const { fixture, service, proposal, decisionId, operationId } = await confirmableFixture();
    await pool.query(`UPDATE odft_app.trips SET sightseeing_date = '2026-12-02' WHERE id = $1`, [
      fixture.tripId,
    ]);
    await expect(
      service.confirm({
        tripId: fixture.tripId,
        sessionId: fixture.sessionId,
        proposalId: proposal.proposalId,
        decisionId,
        operationId,
        acceptedRevision: fixture.revision,
        acceptedDemoDisclaimer: true,
        confirmationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "STALE_ROUTE_APPROVAL" });
  });

  it("rejects a flight that is not in the current schedule's valid combinations", async () => {
    const tripId = await createTrip(FIXTURE_ORIGIN_AIRPORT, FIXTURE_DESTINATION_CITY, "IT");
    const { approval, flights, manifest, inputs, scenarioKey } = await persistFlightSnapshot(
      tripId,
      "seed-flight-membership",
    );
    const schedule = validateSchedules({
      approval,
      combinations: flights,
      scenarioKey,
      flightDomainVersion: manifest.domainVersions.flights,
      flightDomainHash: manifest.domainContentHashes.flights,
      scheduleRuleVersion: SCHEDULE_RULE_VERSION,
      sightseeingDate: inputs.sightseeingDate,
      travelVariant: inputs.travelVariant,
      destinationZone: inputs.destination.zone as string,
      destinationTransferMinutes: approval.approvedPairDetails[0]!.destinationTransferMinutes,
      routeValidationId: approval.routeValidationId,
    });
    expect(schedule.status).toBe("VALID");
    const flightOfferId = schedule.validCombinationIds[0]!;
    // Persist a VALID schedule that does NOT include the offered flight.
    await persistScheduleValidation(pool, {
      tripId,
      snapshotId: manifest.snapshotId,
      result: {
        ...schedule,
        validCombinationIds: schedule.validCombinationIds.filter((id) => id !== flightOfferId),
      },
    });

    const sessionId = await sessionForTrip(tripId);
    const booking = createBookingService(pool);
    const operationId = await createOperation(pool, tripId);
    const proposal = await booking.propose({
      tripId,
      sessionId,
      service: "flights",
      offerId: flightOfferId,
      operationId,
      sourceFingerprint: "c".repeat(64),
    });
    const decisionId = await createConfirmationDecision(pool, {
      tripId,
      proposalId: proposal.proposalId,
      sourceFingerprint: "c".repeat(64),
      allowedOfferIds: [flightOfferId],
      revision: 1,
    });
    await expect(
      booking.confirm({
        tripId,
        sessionId,
        proposalId: proposal.proposalId,
        decisionId,
        operationId: await createOperation(pool, tripId),
        acceptedRevision: 1,
        acceptedDemoDisclaimer: true,
        confirmationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "STALE_ROUTE_APPROVAL" });
  });
});

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function sessionForTrip(tripId: string): Promise<string> {
  const row = await pool.query<{ session_id: string }>(
    `SELECT session_id FROM odft_app.trips WHERE id = $1`,
    [tripId],
  );
  const sessionId = row.rows[0]?.session_id;
  if (!sessionId) {
    throw new Error(`trip ${tripId} has no session`);
  }
  return sessionId;
}
