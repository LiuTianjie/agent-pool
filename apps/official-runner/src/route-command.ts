import { spawn } from 'node:child_process';

import type { CommandExecutor, CommandOptions, CommandResult } from '../../runner/src/types.js';

import { resolveRouteEnvironment } from './secrets.js';
import type { FleetRouteConfig, RouteFailureKind } from './types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ObservedCommandExecutor {
  execute: CommandExecutor;
  consumeObservation(): RouteCommandObservation | undefined;
  clearObservation(): void;
}

export interface RouteCommandObservation {
  failureKind: RouteFailureKind;
  producedFinalOutput: boolean;
}

export function createRouteCommandExecutor(
  route: FleetRouteConfig,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): ObservedCommandExecutor {
  let observation: RouteCommandObservation | undefined;
  return {
    execute: async (command, args, options = {}) => {
      let producedFinalOutput = false;
      const onStdoutLine = options.onStdoutLine;
      const result = await executeWithEnvironment(
        command,
        args,
        {
          ...options,
          ...(onStdoutLine
            ? {
                onStdoutLine: (line) => {
                  if (isFinalOutputEvent(line)) producedFinalOutput = true;
                  onStdoutLine(line);
                },
              }
            : {}),
        },
        await resolveRouteEnvironment(route, hostEnvironment),
      );
      observation = {
        failureKind: classifyCommandFailure(result),
        producedFinalOutput,
      };
      return result;
    },
    consumeObservation: () => {
      const current = observation;
      observation = undefined;
      return current;
    },
    clearObservation: () => {
      observation = undefined;
    },
  };
}

export function classifyCommandFailure(result?: CommandResult): RouteFailureKind {
  if (!result) return 'other';
  if (
    result.timedOut ||
    result.errorCode === 'ETIMEDOUT' ||
    result.errorCode === 'ECONNRESET' ||
    result.errorCode === 'ECONNABORTED'
  ) {
    return 'timeout';
  }
  const metadata = `${result.errorCode ?? ''}\n${result.stderr}`.toLowerCase();
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key/u.test(metadata)) return 'auth';
  if (/\b429\b|rate.?limit|too many requests/u.test(metadata)) return 'overloaded';
  if (/\b5\d\d\b|service unavailable|bad gateway|gateway timeout/u.test(metadata)) {
    return 'transient';
  }
  return 'other';
}

function isFinalOutputEvent(line: string): boolean {
  let event: Record<string, unknown>;
  try {
    const decoded = JSON.parse(line) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return false;
    event = decoded as Record<string, unknown>;
  } catch {
    return false;
  }
  if (event.type === 'message.completed' && typeof event.text === 'string') return true;
  if (event.type === 'result' && event.is_error !== true && typeof event.result === 'string') {
    return true;
  }
  const item = event.item;
  return (
    typeof item === 'object' &&
    item !== null &&
    !Array.isArray(item) &&
    (item as Record<string, unknown>).type === 'agent_message' &&
    typeof (item as Record<string, unknown>).text === 'string'
  );
}

async function executeWithEnvironment(
  command: string,
  args: readonly string[],
  options: CommandOptions,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
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
      env: environment,
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

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortTimer) clearTimeout(abortTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
        outputLimitExceeded = true;
        stop();
        return '';
      }
      return next;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: string) => {
      if (outputLimitExceeded) return;
      stdout = append(stdout, chunk);
      if (!options.onStdoutLine || outputLimitExceeded) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) options.onStdoutLine(line);
    });
    child.stderr.on('data', (chunk: string) => {
      if (!outputLimitExceeded) stderr = append(stderr, chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout: '',
        stderr: '',
        errorCode: error.code,
        timedOut,
      });
    });
    child.on('close', (exitCode) => {
      if (lineBuffer && options.onStdoutLine && !outputLimitExceeded) {
        options.onStdoutLine(lineBuffer);
      }
      finish({
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
}
