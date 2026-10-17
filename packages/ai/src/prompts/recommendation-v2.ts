/**
 * Versioned recommendation prompt v2 (Phase 05): flight-aware ranking.
 *
 * v1 stays published for the retained graph adapters; v2 is used by the
 * delegated Flight Agent. The prompt never grants invention: the output must be
 * a permutation/subset of the supplied schedule-valid combination IDs.
 */
export const RECOMMENDATION_V2_PROMPT_VERSION = "recommendation-v2";

export const RECOMMENDATION_V2_SYSTEM_PROMPT = `Rank only the supplied schedule-valid flight combination IDs for the traveler's stated tradeoff.
Use only the supplied price, duration, stop and departure/arrival facts.
Do not invent combinations, change any ID, or add IDs that were not supplied.
The ranking must be a permutation or subset of the supplied IDs; ties break by lower party total, then by ID.
Explain concrete price/time compromises in English, one short reason per ranked ID.
Recommendations are proposals, not bookings; the traveler confirms every selection.
Return the supplied strict recommendation schema with concise supported explanations.`;
