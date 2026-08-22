import type { CommandResult, RunnerAdapterStatus } from '../types.js';

const SECRET_PATTERN =
  /(?:api[_-]?key|token|authorization|bearer|password|secret)[=:\s]+[^\s]+|\bsk-[a-z0-9_-]{8,}\b/giu;
const INTERESTING_FAILURE =
  /http\s*[1-5]\d\d|trusted.?dir|sandbox|not supported|unknown model|model .* not|unauthorized|forbidden|ENOENT/iu;

export function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/u).find((candidate) => candidate.trim());
  return line?.trim().slice(0, 160);
}

export function sanitizeProcessText(value: string, limit = 240): string {
  return value.replace(SECRET_PATTERN, '[redacted]').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

export function commandFailureDetail(result: CommandResult): string | undefined {
  if (result.errorCode === 'ENOENT') return 'CLI not found on PATH';
  if (result.timedOut) return 'CLI timed out';
  if (result.errorCode === 'OUTPUT_LIMIT') return 'CLI output exceeded limit';

  const lines = [result.stderr, result.stdout]
    .flatMap((text) => (text ?? '').split(/\r?\n/u))
    .map((line) => sanitizeProcessText(line, 200))
    .filter(Boolean);
  const interesting = lines.find((line) => INTERESTING_FAILURE.test(line));
  if (interesting) return interesting;
  if (lines[0]) return lines[0];
  if (result.exitCode !== null && result.exitCode !== 0) return `CLI exited ${result.exitCode}`;
  return undefined;
}

export function unavailableStatus(
  adapter: RunnerAdapterStatus['adapter'],
  versionResult: CommandResult,
): RunnerAdapterStatus | null {
  if (versionResult.errorCode === 'ENOENT') {
    return {
      adapter,
      available: false,
      authenticated: false,
      supportedModels: [],
      detail: 'CLI not found on PATH',
    };
  }
  return null;
}

export function safeParseObject(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class AdapterExecutionError extends Error {
  constructor(
    readonly code: 'agent_error' | 'invalid_output' | 'model_mismatch',
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AdapterExecutionError';
  }
}
