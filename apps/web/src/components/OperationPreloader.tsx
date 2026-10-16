"use client";

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { operationPreloader } from "@/lib/operation-preloader";

export function OperationPreloaderProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const message = useSyncExternalStore(
    operationPreloader.subscribe,
    operationPreloader.getSnapshot,
    () => null,
  );
  const blocking = useSyncExternalStore(
    operationPreloader.subscribe,
    operationPreloader.getBlockingSnapshot,
    () => false,
  );

  return (
    <>
      <div
        inert={blocking}
        aria-busy={blocking}
        className="contents"
        data-testid="operation-content"
      >
        {children}
      </div>
      {message ? (
        <div
          aria-atomic="true"
          aria-live="polite"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
          data-testid="operation-preloader"
          role="status"
        >
          <div className="flex items-center gap-3 rounded border border-border bg-paper px-5 py-4 text-base font-medium shadow-lg">
            <span
              aria-hidden="true"
              className="size-5 animate-spin rounded-full border-2 border-teal border-t-transparent motion-reduce:animate-none"
            />
            <span>{message}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}
