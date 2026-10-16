import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { ActivitiesView } from "@/components/wizard/ActivitiesView";

export const dynamic = "force-dynamic";

/** Activity preferences for one trip. */
export default async function ActivitiesPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <ActivitiesView tripId={id} />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
