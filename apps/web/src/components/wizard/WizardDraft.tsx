"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  parseWizardDraft,
  serializeWizardDraft,
  WIZARD_DRAFT_STORAGE_KEY,
  type WizardDraft,
} from "@/lib/wizard-form";

/**
 * Browser-only trip draft spanning the welcome and destination steps. It holds
 * no server identifiers: the trip (and its id) does not exist until the city is
 * chosen and `POST /api/trips` is admitted. The provider is mounted in the ROOT
 * layout, so the draft survives client-side navigation across the whole app
 * (including a trip workspace round trip). Once `tripId` is set the draft is a
 * read-only record: the wizard only creates trips, so the draft steps render
 * disabled and edits go through the trip's own commands. The completed record is
 * persisted in `sessionStorage`, so a page reload (or a later Trip details /
 * Destination visit) still shows the created trip's values; an in-progress draft
 * stays ephemeral, and `Start a new trip` clears the stored record.
 */

export type { WizardDraft } from "@/lib/wizard-form";

const EMPTY_DRAFT: WizardDraft = {
  userName: "",
  adults: 1,
  originAirportId: "",
  originLabel: "",
  sightseeingDate: "",
  travelVariant: "one_night",
  defaultServiceLevel: "standard",
  activityPace: "moderate",
  maxBudgetEur: "",
  countryKey: "",
  countryName: "",
  destinationCityId: "",
  destinationCityLabel: "",
  creationRequestId: "",
  tripId: "",
};

function readStoredDraft(): WizardDraft | null {
  try {
    return parseWizardDraft(window.sessionStorage.getItem(WIZARD_DRAFT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredDraft(draft: WizardDraft): void {
  try {
    window.sessionStorage.setItem(WIZARD_DRAFT_STORAGE_KEY, serializeWizardDraft(draft));
  } catch {
    // Storage unavailable (private mode/quota): the draft still works in memory.
  }
}

function clearStoredDraft(): void {
  try {
    window.sessionStorage.removeItem(WIZARD_DRAFT_STORAGE_KEY);
  } catch {
    // Ignore: nothing to clear.
  }
}

/*
 * The draft lives in a module-level store read through `useSyncExternalStore`:
 * the server and hydration renders see the empty draft, and the browser
 * restores the stored created-trip record on the first client read, so the
 * restore never changes the server-rendered markup and never needs the
 * set-state-in-effect pattern.
 */
let snapshot: WizardDraft | null = null;
const listeners = new Set<() => void>();

function getClientSnapshot(): WizardDraft {
  if (snapshot === null) {
    snapshot = readStoredDraft() ?? EMPTY_DRAFT;
  }
  return snapshot;
}

function getServerSnapshot(): WizardDraft {
  return EMPTY_DRAFT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setSnapshot(next: WizardDraft): void {
  snapshot = next;
  if (next.tripId !== "") {
    writeStoredDraft(next);
  }
  for (const listener of listeners) {
    listener();
  }
}

interface WizardContextValue {
  readonly draft: WizardDraft;
  update: (partial: Partial<WizardDraft>) => void;
  reset: () => void;
}

const WizardContext = createContext<WizardContextValue | null>(null);

export function WizardDraftProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const draft = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  const update = useCallback((partial: Partial<WizardDraft>) => {
    setSnapshot({ ...getClientSnapshot(), ...partial });
  }, []);

  const reset = useCallback(() => {
    clearStoredDraft();
    setSnapshot(EMPTY_DRAFT);
  }, []);

  const value = useMemo(() => ({ draft, update, reset }), [draft, update, reset]);
  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useWizardDraft(): WizardContextValue {
  const value = useContext(WizardContext);
  if (!value) {
    throw new Error("useWizardDraft must be used inside WizardDraftProvider");
  }
  return value;
}
