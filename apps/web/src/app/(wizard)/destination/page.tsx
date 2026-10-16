import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { DestinationStep } from "@/components/wizard/DestinationStep";

export const dynamic = "force-dynamic";

/** Steps 1-2: country, city, and trip creation. */
export default function DestinationPage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <DestinationStep />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
