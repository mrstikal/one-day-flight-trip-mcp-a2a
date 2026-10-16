import type { ActivityRef, ActivityTag } from "@odft/contracts";
import {
  ok,
  unavailable,
  unsupported,
  type ProviderResult,
  type SnapshotSource,
} from "./result.js";

/** Attractions provider (05 section 11): verified references or labeled generic activities. */

export interface AttractionsInput {
  readonly snapshotId: string;
  readonly cityId: string;
  readonly tags?: readonly ActivityTag[];
  readonly requireReference?: boolean;
}

export interface AttractionsProvider {
  list(input: AttractionsInput): Promise<ProviderResult<ActivityRef[]>>;
}

export class SyntheticAttractionsProvider implements AttractionsProvider {
  constructor(private readonly source: SnapshotSource) {}

  async list(input: AttractionsInput): Promise<ProviderResult<ActivityRef[]>> {
    const content = await this.source.getContent(input.snapshotId);
    if (!content) {
      return unavailable(`snapshot ${input.snapshotId} is not materialized`);
    }
    if (content.activities.length === 0) {
      return unsupported("the activities domain is not materialized in this snapshot version");
    }
    const activities = content.activities.filter((activity) => {
      if (activity.cityId !== input.cityId) {
        return false;
      }
      if (input.requireReference === true && !activity.reference) {
        return false;
      }
      if (
        input.tags &&
        input.tags.length > 0 &&
        !input.tags.some((tag) => activity.tags.includes(tag))
      ) {
        return false;
      }
      return true;
    });
    return activities.length > 0
      ? ok(activities)
      : unavailable("no matching activities for this city in the snapshot");
  }
}
