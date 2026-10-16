import type { BookableKey } from "@odft/contracts";

interface FixtureOffer {
  readonly partyTotalMinor: number;
  readonly adults: number;
  readonly supportedVariants: readonly ("one_night" | "two_nights")[];
  readonly synthetic: true;
}

function offer(partyTotalMinor: number): FixtureOffer {
  return { partyTotalMinor, adults: 2, supportedVariants: ["one_night", "two_nights"], synthetic: true };
}

/** Fixture snapshot offers marked synthetic; party-total EUR minor units. */
export const FIXTURE_OFFERS: Record<BookableKey, Record<string, FixtureOffer>> = {
  flights: {
    "DEMO-FLIGHT-1": offer(30000),
    "DEMO-FLIGHT-2": offer(45000),
  },
  hotel: {
    "DEMO-HOTEL-1": offer(20000),
    "DEMO-HOTEL-2": offer(32000),
  },
  breakfast: { "DEMO-BREAKFAST-1": offer(3000) },
  lunch: { "DEMO-LUNCH-1": offer(5000) },
  dinner: { "DEMO-DINNER-1": offer(8000) },
};

export const FIXTURE_FLIGHT_OFFER = "DEMO-FLIGHT-1";
export const FIXTURE_HOTEL_OFFER = "DEMO-HOTEL-1";
export const FIXTURE_HOTEL_OFFER_ALT = "DEMO-HOTEL-2";

export function buildFixtureInventory(): { offers: typeof FIXTURE_OFFERS } {
  return { offers: FIXTURE_OFFERS };
}
