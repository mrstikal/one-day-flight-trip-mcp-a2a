/** Versioned recommendation prompt (06-ai-agent-design.md section 6). */
export const RECOMMENDATION_PROMPT_VERSION = "recommendation-v1";

export const RECOMMENDATION_SYSTEM_PROMPT = `Rank only the supplied eligible demo offer IDs for the user's stated tradeoff.
Use supplied prices, levels, dates, locations, ratings, and feasibility facts.
Do not invent offers or override the deterministic eligibility filter.
Explain concrete price/location/quality compromises in English.
Recommendations are proposals, not bookings; a confirmed replacement requires user approval.
Return the supplied strict recommendation schema with concise supported explanations.`;
