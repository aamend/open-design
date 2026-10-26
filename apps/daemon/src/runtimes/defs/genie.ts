import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_MODEL_OPTION, clampCodexReasoning } from './shared.js';
import {
  CODEX_SHELL_ENVIRONMENT_INCLUDE_KEYS,
  codexResolvedSandboxMode,
} from './codex.js';
import { GENIE_AGENT_ID } from '../codex-protocol.js';
import type { RuntimeAgentDef, RuntimeBuildOptions } from '../types.js';

// Databricks Genie Code CLI (`genie`, verified against 0.1.0-beta.2).
//
// Genie is a fork of Codex: `genie exec --json` emits the same JSONL event
// stream (`thread.started` / `turn.started` / `item.*` / `turn.completed`), so
// this adapter reuses the codex event parser and capture-style resume. What it
// does NOT share is Codex's argv surface. Genie rejects `-c key=value`,
// `--model`, `debug models`, `login status`, and `app-server`; every override
// the codex adapter puts on argv lives here in a config profile instead.
//
// Profiles are layered with `-p <name>`, which reads
// `$GENIE_HOME/<name>.config.toml` on top of `$GENIE_HOME/config.toml`. To keep
// those files out of the user's own `~/.genie`, OpenDesign runs Genie against a
// daemon-owned home under the daemon data root (see `genieRunHomeDir`) whose
// `config.toml` is refreshed from the user's Genie config on every spawn. The
// user's model provider and Databricks auth command therefore carry over
// unchanged, while OpenDesign's sessions and run profiles stay under daemon
// data.

/** The daemon-owned Genie home for runs, derived from the daemon data root. */
export function genieRunHomeDir(dataDir: string): string {
  return path.join(dataDir, 'genie', 'home');
}

/** The user's own Genie home, the source of provider and auth config. */
export function genieUserHomeDir(env: NodeJS.ProcessEnv): string | null {
  const configured = env.GENIE_HOME?.trim();
  if (configured) return configured;
  const home = os.homedir();
  return home ? path.join(home, '.genie') : null;
}

/**
 * Point a Genie child at the daemon-owned run home, seeded from the user's
 * Genie home. Idempotent: an env already pointing at the run home is left
 * alone, and a missing user config simply leaves Genie on its defaults (it then
 * reports its own configuration error on the first turn).
 */
export function applyGenieRunHomeEnv(env: NodeJS.ProcessEnv): void {
  const dataDir = env.OD_DATA_DIR?.trim();
  if (!dataDir) return;
  const runHome = genieRunHomeDir(dataDir);
  const userHome = genieUserHomeDir(env);
  env.GENIE_HOME = runHome;
  if (!userHome || path.resolve(userHome) === path.resolve(runHome)) return;
  try {
    mkdirSync(runHome, { recursive: true });
    const userConfig = path.join(userHome, 'config.toml');
    if (existsSync(userConfig)) {
      copyFileSync(userConfig, path.join(runHome, 'config.toml'));
    }
    // Genie may keep login credentials next to its config. Link rather than
    // copy so a token refresh in either home is seen by both.
    const userAuth = path.join(userHome, 'auth.json');
    const runAuth = path.join(runHome, 'auth.json');
    if (existsSync(userAuth) && !pathExists(runAuth)) {
      symlinkSync(userAuth, runAuth);
    }
  } catch {
    // A read-only or missing source must not block the spawn; Genie surfaces
    // its own configuration error if it cannot start.
  }
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function tomlString(value: string): string {
  // JSON string escapes are a subset of TOML basic-string escapes.
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * Render the OpenDesign overrides for one run as a Genie config profile.
 *
 * This is the codex adapter's `-c` override set, translated key for key:
 * sandbox mode and network access, the tool-shell environment whitelist with
 * login shells disabled, the detailed reasoning summary, the `update_plan`
 * tool, and the model / reasoning effort the user picked. Writable roots stand
 * in for `--add-dir`, which `exec resume` does not accept, so a resumed turn
 * keeps the grants of the turn that created the session.
 */
export function renderGenieRunProfile(
  options: RuntimeBuildOptions = {},
  extraAllowedDirs: readonly string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`sandbox_mode = ${tomlString(codexResolvedSandboxMode())}`);
  lines.push('allow_login_shell = false');
  lines.push('model_reasoning_summary = "detailed"');
  if (options.model && options.model !== 'default') {
    lines.push(`model = ${tomlString(options.model)}`);
  }
  if (options.reasoning && options.reasoning !== 'default') {
    const effort = clampCodexReasoning(options.model, options.reasoning);
    if (effort) lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  }
  const writableRoots = extraAllowedDirs.filter(
    (dir) => typeof dir === 'string' && dir.length > 0,
  );
  lines.push('');
  lines.push('[sandbox_workspace_write]');
  lines.push('network_access = true');
  lines.push(`writable_roots = ${tomlStringArray(writableRoots)}`);
  lines.push('');
  lines.push('[shell_environment_policy]');
  lines.push('inherit = "all"');
  lines.push('ignore_default_excludes = true');
  lines.push(
    `include_only = ${tomlStringArray([...new Set(CODEX_SHELL_ENVIRONMENT_INCLUDE_KEYS)])}`,
  );
  lines.push('');
  lines.push('[tools.update_plan]');
  lines.push('enabled = true');
  return `${lines.join('\n')}\n`;
}

/**
 * Content-addressed profile name, so concurrent runs with different models
 * never share a file and identical turns of one conversation reuse the same
 * profile (Genie hashes the per-turn context, as Codex does, so a resume that
 * saw different overrides would miss the prefix cache).
 */
export function genieRunProfileName(profile: string): string {
  return `opendesign-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}`;
}

function writeGenieRunProfile(genieHome: string, name: string, profile: string): void {
  const target = path.join(genieHome, `${name}.config.toml`);
  try {
    if (readFileSync(target, 'utf8') === profile) return;
  } catch {
    // Not written yet.
  }
  mkdirSync(genieHome, { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, profile);
  renameSync(tmp, target);
}

export const genieAgentDef = {
  id: GENIE_AGENT_ID,
  name: 'Genie CLI',
  bin: 'genie',
  versionArgs: ['--version'],
  // Genie has no model-listing command. The model normally comes from the
  // user's Genie config (`default`); `gpt-5.6-sol` is the model Genie's own
  // installer configures, and custom ids remain available in Settings.
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
    extraAllowedDirs = [],
    options = {},
    runtimeContext = {},
  ) => {
    const resumeSessionId =
      typeof runtimeContext.resumeSessionId === 'string'
      && runtimeContext.resumeSessionId.length > 0
        ? runtimeContext.resumeSessionId
        : null;
    // Every flag goes before the `resume` subcommand: `genie exec resume`
    // rejects `-p`, while `genie exec -p <profile> … resume <id>` applies it.
    const args = ['exec'];
    const genieHome = runtimeContext.genieHome;
    if (genieHome) {
      const profile = renderGenieRunProfile(options, extraAllowedDirs);
      const name = genieRunProfileName(profile);
      writeGenieRunProfile(genieHome, name, profile);
      args.push('-p', name);
    }
    args.push('--json', '--skip-git-repo-check');
    if (resumeSessionId) {
      // The thread id is the positional SESSION_ID; the prompt arrives on
      // stdin (promptViaStdin), so the id is the final argv entry.
      args.push('resume', resumeSessionId);
      return args;
    }
    // Without a run home there is no profile to carry the sandbox, so pass it
    // on argv (create turns only accept it there).
    if (!genieHome) args.push('--sandbox', codexResolvedSandboxMode());
    if (runtimeContext.cwd) args.push('-C', runtimeContext.cwd);
    return args;
  },
  promptViaStdin: true,
  // Same capture-style resume as codex: the handle is the
  // `thread.started.thread_id` the create turn reports.
  resumesSessionViaCli: true,
  capturesSessionIdFromStream: true,
  streamFormat: 'json-event-stream',
  eventParser: 'codex',
} satisfies RuntimeAgentDef;
