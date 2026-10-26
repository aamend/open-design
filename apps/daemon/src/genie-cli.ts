// Thin wrapper over `genie mcp add|remove|get` — the Genie CLI equivalent
// of codex-cli.ts. Genie is a Codex fork and shares the same mcp subcommand
// interface, so the implementation mirrors codex-cli.ts exactly with 'genie'
// as the binary id.

import { spawn } from 'node:child_process';
import { createCommandInvocation } from '@open-design/platform';
import { resolveAgentBin } from './runtimes/resolution.js';
import type { CodexInstallSpec, CodexInstallStatus } from './codex-cli.js';

export type { CodexInstallSpec, CodexInstallStatus };

function createGenieCliInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
  configuredEnv: Record<string, string> = {},
) {
  const command = resolveAgentBin('genie', configuredEnv) ?? 'genie';
  return createCommandInvocation({ command, args, env });
}

async function runGenieCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const invocation = createGenieCliInvocation(args, env);
    const child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('genie CLI timed out after 30s'));
    }, 30_000);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
  });
}

export async function probeGenieInstall(name: string): Promise<CodexInstallStatus> {
  try {
    const result = await runGenieCli(['mcp', 'get', name]);
    return { available: true, installed: result.exitCode === 0 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { available: false, installed: false };
    }
    throw err;
  }
}

export async function installGenieMcp(spec: CodexInstallSpec): Promise<void> {
  const argv: string[] = ['mcp', 'add', spec.name];
  for (const [key, value] of Object.entries(spec.env)) {
    argv.push('--env', `${key}=${value}`);
  }
  argv.push('--', spec.command, ...spec.args);
  const result = await runGenieCli(argv);
  if (result.exitCode !== 0) {
    throw new Error(`genie mcp add failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  }
}

export async function uninstallGenieMcp(name: string): Promise<void> {
  const result = await runGenieCli(['mcp', 'remove', name]);
  if (result.exitCode !== 0) {
    throw new Error(`genie mcp remove failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  }
}
