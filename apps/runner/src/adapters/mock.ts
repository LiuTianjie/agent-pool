import type { AdapterRunOptions, AgentAdapterDriver, RunnerAdapterStatus } from '../types.js';
import { AdapterExecutionError } from './common.js';

export const MOCK_MODEL = 'mock-v1';

export class MockAdapter implements AgentAdapterDriver {
  readonly name = 'mock' as const;
  readonly defaultModels = [MOCK_MODEL] as const;

  async detect(): Promise<RunnerAdapterStatus> {
    return {
      adapter: this.name,
      available: true,
      authenticated: true,
      supportedModels: [...this.defaultModels],
      version: 'built-in',
      detail: 'Local deterministic adapter for testing; it does not call a model.',
    };
  }

  async run(options: AdapterRunOptions): Promise<unknown> {
    if (options.lease.requestedModel !== MOCK_MODEL) {
      throw new AdapterExecutionError('model_mismatch');
    }
    await options.onProgress({ stage: 'starting', progress: 5 });
    await options.onProgress({ stage: 'thinking', progress: 25 });
    await options.onProgress({ stage: 'working', progress: 65 });
    await options.onProgress({ stage: 'checking', progress: 90 });

    const input = options.lease.input;
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const record = input as Record<string, unknown>;
      const explicitOutput = record.__mockOutput;
      if (explicitOutput !== undefined) return explicitOutput;
      if (typeof record.text === 'string' && typeof record.nonce === 'string') {
        return {
          reversed: [...record.text].reverse().join(''),
          uppercase: record.text.toUpperCase(),
          grouped: record.text.match(/.{1,3}/gu)?.join('-') ?? record.text,
          length: record.text.length,
        };
      }
    }
    return { ok: true };
  }
}
