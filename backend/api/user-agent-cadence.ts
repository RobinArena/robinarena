export const USER_AGENT_SUCCESS_BREAK_MS = 12_000;
export const USER_AGENT_MAX_BREAK_MS = 20_000;

export function nextUserAgentBreak(current: number): number {
  return Math.min(
    Math.max(current, USER_AGENT_SUCCESS_BREAK_MS) + 4_000,
    USER_AGENT_MAX_BREAK_MS,
  );
}
