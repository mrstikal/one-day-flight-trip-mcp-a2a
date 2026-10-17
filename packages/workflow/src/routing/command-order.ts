import type { DomainCommand } from "@odft/contracts";

/**
 * Deterministic application order of one admitted command batch (Phase 08
 * coordinator parity). Commands that can be refused (a route change after a
 * confirmed reservation, a program selection) run first, so a refusal never
 * leaves earlier preference writes behind. The batch itself is one transaction.
 */
export function orderCommandsForApplication(
  commands: readonly DomainCommand[],
): DomainCommand[] {
  const rank = (command: DomainCommand): number => {
    if (command.type === "set_route") return 0;
    if (command.type === "set_program") return 1;
    if (command.type === "propose_selection") return 2;
    if (command.type === "set_simulation") return 3;
    return 4;
  };
  return [...commands]
    .map((command, index) => ({ command, index }))
    .sort((a, b) => rank(a.command) - rank(b.command) || a.index - b.index)
    .map((entry) => entry.command);
}
