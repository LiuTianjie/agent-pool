import type { CommandResult, RunnerAdapterStatus } from '../types.js';

export function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/u).find((candidate) => candidate.trim());
  return line?.trim().slice(0, 160);
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
      detail: 'CLI not found',
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
  constructor(readonly code: 'agent_error' | 'invalid_output' | 'model_mismatch') {
    super(code);
    this.name = 'AdapterExecutionError';
  }
}
