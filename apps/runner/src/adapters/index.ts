import type { AgentAdapter, AgentAdapterDriver, CommandExecutor } from '../types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { MockAdapter } from './mock.js';

export function createAdapter(
  adapter: AgentAdapter,
  command?: CommandExecutor,
): AgentAdapterDriver {
  switch (adapter) {
    case 'codex':
      return new CodexAdapter(command);
    case 'claude':
      return new ClaudeAdapter(command);
    case 'mock':
      return new MockAdapter();
    default:
      throw new Error(`Unsupported adapter: ${String(adapter)}`);
  }
}

export async function detectAllAdapters(
  command?: CommandExecutor,
): Promise<Awaited<ReturnType<AgentAdapterDriver['detect']>>[]> {
  return await Promise.all(
    (['codex', 'claude', 'mock'] as const).map((name) => createAdapter(name, command).detect()),
  );
}
