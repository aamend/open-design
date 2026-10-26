import { DEFAULT_MODEL_OPTION, clampCodexReasoning } from './shared.js';
import { codexResolvedSandboxMode } from './codex.js';
import { GENIE_AGENT_ID } from '../codex-protocol.js';
import type { RuntimeAgentDef } from '../types.js';

// Databricks Genie CLI (`genie`).
//
// Genie is a fork of Codex: `genie exec --json` emits the same JSONL event
// stream (`thread.started` / `turn.started` / `item.*` / `turn.completed`), so
// this adapter reuses the codex event parser and capture-style resume.
//
// Unlike Codex, Genie does not accept `-c key=value` overrides or `--model` on
// argv. Model selection comes from the user's own `~/.genie/config.toml`.

export const genieAgentDef = {
  id: GENIE_AGENT_ID,
  name: 'Genie CLI',
  bin: 'genie',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
  ],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'none', label: 'None' },
    { id: 'minimal', label: 'Minimal' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
  ],
  buildArgs: (
    _prompt,
    _imagePaths,
    _extraAllowedDirs = [],
    _options = {},
    runtimeContext = {},
  ) => {
    const resumeSessionId =
      typeof runtimeContext.resumeSessionId === 'string' &&
      runtimeContext.resumeSessionId.length > 0
        ? runtimeContext.resumeSessionId
        : null;

    const args = ['exec', '--json', '--skip-git-repo-check'];

    if (resumeSessionId) {
      args.push('resume', resumeSessionId);
      return args;
    }

    args.push('--sandbox', codexResolvedSandboxMode());
    if (runtimeContext.cwd) args.push('-C', runtimeContext.cwd);
    return args;
  },
  promptViaStdin: true,
  resumesSessionViaCli: true,
  capturesSessionIdFromStream: true,
  streamFormat: 'json-event-stream',
  eventParser: 'codex',
} satisfies RuntimeAgentDef;
