import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { OperationPreloaderProvider } from "@/components/OperationPreloader";
import { WizardDraftProvider } from "@/components/wizard/WizardDraft";
import { CONFIRMATION_DISCLAIMER, DEMO_DISCLAIMER } from "@/lib/disclaimers";
import { getServerDeps } from "@/lib/server";

export const metadata: Metadata = {
  title: "AI Travel Planner",
  description: "Demo AI travel planner for one sightseeing day in a European city.",
};

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-roboto",
  display: "swap",
});

/** Visible AI-mode banner (08 section 1): fixture vs live AI mode. */
function aiModeBanner(): string | null {
  try {
    const { config } = getServerDeps();
    return config.aiMode === "fixture"
      ? "Deterministic fixture mode - no live AI calls"
      : "OpenRouter mode - recommendations may call the configured model";
  } catch {
    return null;
  }
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  const banner = aiModeBanner();
  return (
    <html lang="en" className={roboto.variable}>
      <body className="flex min-h-screen flex-col bg-cream text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-teal focus:px-4 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        <header className="border-b border-border bg-paper">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-4">
            <p className="text-xl font-semibold">AI Travel Planner</p>
            <p role="note" className="text-sm text-clay">
              {DEMO_DISCLAIMER}
            </p>
            {banner ? (
              <p data-testid="ai-mode-banner" role="note" className="text-sm text-ink-muted">
                {banner}
              </p>
            ) : null}
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
          <OperationPreloaderProvider>
            <WizardDraftProvider>{children}</WizardDraftProvider>
          </OperationPreloaderProvider>
        </main>
        <footer className="border-t border-border bg-paper">
          <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-4">
            <p role="note" className="text-sm text-ink-muted">
              {DEMO_DISCLAIMER}
            </p>
            <p role="note" className="text-sm text-ink-muted">
              {CONFIRMATION_DISCLAIMER}
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
