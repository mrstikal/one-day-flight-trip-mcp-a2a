import type { ReactNode } from "react";
import { ConversationRail } from "@/components/assistant/conversation-rail";
import { StepNav } from "@/components/trip/StepNav";

export const dynamic = "force-dynamic";

/** Trip workspace: the step content plus the sticky step nav and assistant rail. */
export default async function TripLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">{children}</div>
      <div className="flex flex-col gap-4 lg:sticky lg:top-6">
        <StepNav tripId={id} />
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <ConversationRail tripId={id} />
        </div>
      </div>
    </div>
  );
}
