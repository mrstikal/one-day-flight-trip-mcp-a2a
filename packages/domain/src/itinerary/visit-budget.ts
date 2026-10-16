import type { ActivityPace } from "@odft/contracts";
import { PACE_PROFILES } from "./taxonomy.js";

/**
 * The authoritative activity visit-time budget (08-frontend-ux.md section 7):
 * the sum of the selected visit durations against the pace's daily cap. The
 * activities step uses it for live feedback and disables Save while the selection
 * exceeds the cap; full day feasibility (transfers, windows, breaks) stays with
 * the planner and validator — this is the documented "visit time versus cap"
 * check, computed server-side so the UI never derives pace feasibility itself.
 */

export interface VisitBudgetInput {
  readonly pace: ActivityPace;
  readonly activities: readonly {
    readonly id: string;
    readonly durationMinutes: number;
  }[];
  readonly selectedIds: readonly string[];
}

export interface VisitBudget {
  readonly fits: boolean;
  readonly selectedCount: number;
  readonly selectedMinutes: number;
  readonly capMinutes: number;
  readonly overMinutes: number;
  readonly targetMin: number;
  readonly targetMax: number;
}

export function activityVisitBudget(input: VisitBudgetInput): VisitBudget {
  const profile = PACE_PROFILES[input.pace];
  const selected = new Set(input.selectedIds);
  let selectedCount = 0;
  let selectedMinutes = 0;
  for (const activity of input.activities) {
    if (selected.has(activity.id)) {
      selectedCount += 1;
      selectedMinutes += activity.durationMinutes;
    }
  }
  const overMinutes = Math.max(0, selectedMinutes - profile.visitCapMinutes);
  return {
    fits: overMinutes === 0,
    selectedCount,
    selectedMinutes,
    capMinutes: profile.visitCapMinutes,
    overMinutes,
    targetMin: profile.targetMin,
    targetMax: profile.targetMax,
  };
}