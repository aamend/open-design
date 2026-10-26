// Dependency-free so prompt, observability, and env modules can ask the
// question without importing the adapter definitions.

export const GENIE_AGENT_ID = 'genie';

/**
 * Agents that speak the codex `exec --json` protocol and share its runtime
 * semantics (capture-style thread resume, `--add-dir` grants write access,
 * `turn.completed` usage is session-scoped, `update_plan` is the plan tool).
 * Use this instead of `agentId === 'codex'` wherever the behaviour follows the
 * protocol rather than Codex's own CLI flags or home directory layout.
 */
export function isCodexProtocolAgentId(agentId: string | null | undefined): boolean {
  const id = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  return id === 'codex' || id === GENIE_AGENT_ID;
}
