import { DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { WelcomeStep } from "@/components/wizard/WelcomeStep";

export const dynamic = "force-dynamic";

/** Step 0: welcome and provisional planning input (no trip exists yet). */
export default function WelcomePage(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <WelcomeStep />
      <p role="note" className="text-sm text-ink-muted">
        {DEMO_DISCLAIMER}
      </p>
    </div>
  );
}
