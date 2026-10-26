import { DEFAULT_MODEL_OPTION } from './shared.js';
import { codexResolvedSandboxMode } from './codex.js';
import type { RuntimeAgentDef } from '../types.js';

// Databricks Genie CLI. Genie is a fork of Codex: `genie exec --json` emits
// the same JSONL event stream, so this adapter reuses the codex event parser
// and capture-style resume. Model selection comes from the user's
// ~/.genie/config.toml; Genie does not accept a --model flag on argv.

export const genieAgentDef = {
  id: 'genie',
  name: 'Genie CLI',
  bin: 'genie',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
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
