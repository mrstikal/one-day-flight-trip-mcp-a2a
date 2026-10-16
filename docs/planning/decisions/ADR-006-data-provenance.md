# ADR-006: Offline Geography and Immutable Seeded Demo Data

Status: accepted for implementation planning; not yet implemented. Date: 2026-10-10.

## Context

The demo needs European search coverage and real geographic consistency without live commercial providers. Re-generating random offers on retries destroys selections and makes failure demonstrations impossible to reproduce. Geographic datasets have independent licenses and limitations.

## Decision

Import/filter/version GeoNames countries/cities, OurAirports airports, import-time geo-tz boundaries, and reviewed Wikidata landmarks. Use an explicit Europe policy, cross-border catchments, timezone evidence/overrides, license manifests, actual retrieval hashes, and attribution. Runtime planning is offline except optional compliant tiles and configured AI.

Use Faker for fictional names/controlled variation, with independent domain/meal streams. Deterministic algorithms own coordinates/anchors, time/date/duration, pricing, capacity, and route estimates. Persist immutable bounded snapshots and separate flight/hotel/breakfast/lunch/dinner/activity/event hashes; append domain extensions without altering prior IDs.

Fault modes use persisted behavior overlays/counters, not inventory regeneration. Reference landmarks are real; business offers, schedules, availability, opening assumptions, prices, and reservations are visibly simulated.

## Alternatives

| Alternative | Reason not chosen |
| --- | --- |
| Three hardcoded cities only | Fails European search/country-city requirement |
| Faker geography/addresses | Invents facts and can place services outside cities/on water |
| Live geocoding/routing/travel APIs | Network/cost dependence and out-of-scope integrations |
| Seed-only reconstruction without persisted snapshots | Package/order changes and crash timing can change IDs/content |
| Treat timezone package MIT as data license | Boundary-derived mapping carries separate ODbL obligations |

## Consequences

- `cities15000` coverage and non-curated program limitations are explicit.
- Initial curated Rome/Paris/Barcelona has at least8 reviewed activities each; other supported cities use labeled generic activities, not invented museums.
- TR/RU/territory/XK/CY policy is explicit and does not rely solely on continent fields.
- ODbL-derived zone assets retain license/derivation attribution separately from application code.
- Library/reference versions and actual content hashes are part of scenario provenance.

## Verification and References

[Sources/licenses/rules](../05-synthetic-data-design.md), [Phase02](../phases/phase-02.md), [Phase04](../phases/phase-04.md), [invariants](../11-testing-strategy.md#8-invariant-and-property-checks). Verify zone/source identity, safe anchors, import limitations, deterministic replay, domain extension, and A-N recipes.
