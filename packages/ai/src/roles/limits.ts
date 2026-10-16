/** Per-role default bounds (06-ai-agent-design.md section 3). */
export interface RoleDefaultLimits {
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxAttempts: number;
  readonly maxInputTokens: number;
  readonly maxCallCostUsd: string;
}
