import type { EventRef } from "@odft/contracts";
import {
  ok,
  unavailable,
  unsupported,
  type ProviderResult,
  type SnapshotSource,
} from "./result.js";

/** Demo events provider (05 section 11) over a persisted snapshot. */

export interface EventsInput {
  readonly snapshotId: string;
  readonly date: string;
}

export interface EventsProvider {
  list(input: EventsInput): Promise<ProviderResult<EventRef[]>>;
}

export class SyntheticEventsProvider implements EventsProvider {
  constructor(private readonly source: SnapshotSource) {}

  async list(input: EventsInput): Promise<ProviderResult<EventRef[]>> {
    const content = await this.source.getContent(input.snapshotId);
    if (!content) {
      return unavailable(`snapshot ${input.snapshotId} is not materialized`);
    }
    if (content.events.length === 0) {
      return unsupported("the events domain is not materialized in this snapshot version");
    }
    const events = content.events.filter((event) => event.date === input.date);
    return events.length > 0 ? ok(events) : unavailable("no demo events on the requested date");
  }
}
