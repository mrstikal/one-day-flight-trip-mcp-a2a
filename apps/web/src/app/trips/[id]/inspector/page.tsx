import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { InspectorView } from "@/components/inspector/InspectorView";

export const dynamic = "force-dynamic";

/**
 * Phase 11 execution inspector. Read-only safe projection plus the
 * flag/owner-protected scenario controls.
 */
export default async function InspectorPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <InspectorView tripId={id} />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
