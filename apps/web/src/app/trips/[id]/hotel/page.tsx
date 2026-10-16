import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { HotelView } from "@/components/wizard/HotelView";

export const dynamic = "force-dynamic";

/** Hotel gating, selection, and the confirmation dialog for one trip. */
export default async function HotelPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="flex flex-col gap-8">
      <HotelView tripId={id} />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
