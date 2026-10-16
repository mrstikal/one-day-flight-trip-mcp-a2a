import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { ItineraryView } from "@/components/itinerary/ItineraryView";

export const dynamic = "force-dynamic";

/** Itinerary page: timeline, validation, costs, map, and approval. */
export default async function ItineraryPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <ItineraryView tripId={id} />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
