import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { FlightsView } from "@/components/wizard/FlightsView";

export const dynamic = "force-dynamic";

/** Flight gating, selection, and the confirmation dialog for one trip. */
export default async function FlightsPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <FlightsView tripId={id} />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
