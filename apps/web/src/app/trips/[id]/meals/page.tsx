import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { MealsView } from "@/components/wizard/MealsView";

export const dynamic = "force-dynamic";

/** Program choices, optional meal reservations, and confirmations for one trip. */
export default async function MealsPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <MealsView tripId={id} />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
