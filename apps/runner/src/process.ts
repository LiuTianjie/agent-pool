import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CommandExecutor, CommandOptions, CommandResult } from './types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function extraCommandDirectories(home: string): string[] {
  return [join(home, '.local', 'bin'), join(home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

export function commandSearchPath(source: NodeJS.ProcessEnv = process.env): string {
  const extras = extraCommandDirectories(homedir());
  const extraSet = new Set(extras);
  const current = (source.PATH ?? source.Path ?? '').split(delimiter).filter(Boolean);
  return [...extras, ...current.filter((entry) => !extraSet.has(entry))].join(delimiter);
}

export function taskProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...source };
  environment.PATH = commandSearchPath(source);
  // Do not inject control authority into a normal task Agent environment. This
  // is exposure reduction, not filesystem isolation: a replaced executable or
  // another process under the same OS user can still inspect that user's files.
  delete environment.AGENTPOOL_CONTROL_TOKEN;
  delete environment.AGENTPOOL_CONTROL_STATE_DIR;
  return environment;
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next) <= limit) {
    return next;
  }

  throw new Error('process_output_limit');
}

export const executeCommand: CommandExecutor = async (
  command,
  args,
  options: CommandOptions = {},
): Promise<CommandResult> => {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return await new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let abortTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: taskProcessEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stop = (): void => {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      abortTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      abortTimer.unref();
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs)
      : undefined;
    timeout?.unref();

    const onAbort = (): void => stop();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) stop();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => undefined);

    child.stdout.on('data', (chunk: string) => {
      if (outputLimitExceeded) return;
      try {
        stdout = appendBounded(stdout, chunk, maxOutputBytes);
        if (options.onStdoutLine) {
          lineBuffer += chunk;
          const lines = lineBuffer.split(/\r?\n/u);
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) options.onStdoutLine(line);
        }
      } catch {
        outputLimitExceeded = true;
        stop();
      }
    });

    child.stderr.on('data', (chunk: string) => {
      if (outputLimitExceeded) return;
      try {
        stderr = appendBounded(stderr, chunk, maxOutputBytes);
      } catch {
        outputLimitExceeded = true;
        stop();
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortTimer) clearTimeout(abortTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        errorCode: error.code,
        timedOut,
      });
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortTimer) clearTimeout(abortTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (lineBuffer && options.onStdoutLine) options.onStdoutLine(lineBuffer);
      resolve({
        exitCode,
        stdout: outputLimitExceeded ? '' : stdout,
        stderr: outputLimitExceeded ? '' : stderr,
        errorCode: outputLimitExceeded ? 'OUTPUT_LIMIT' : undefined,
        timedOut,
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
};
