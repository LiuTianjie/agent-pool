import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter, buildClaudeArgs } from '../src/adapters/claude.js';
import { CodexAdapter, buildCodexArgs } from '../src/adapters/codex.js';
import { taskCapsuleHash } from '../src/task-contract.js';
import type { CommandExecutor, LeasePayload, TaskCapsule } from '../src/types.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function lease(overrides: Partial<LeasePayload> = {}): LeasePayload {
  return {
    leaseId: 'lease-1',
    unitId: 'unit-1',
    poolId: 'pool-1',
    category: 'text',
    requestedAgent: 'codex',
    requestedModel: 'exact-model-id',
    reward: 10,
    instruction: 'PRIVATE INSTRUCTION',
    input: { secret: 'PRIVATE INPUT' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('CodexAdapter', () => {
  it('uses an ephemeral stdin invocation, exact model, and parses the final event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-adapter-test-'));
    directories.push(directory);
    const command = vi.fn<CommandExecutor>(async (_binary, _args, options) => {
      options?.onStdoutLine?.('{"type":"turn.started"}');
      options?.onStdoutLine?.('{"type":"item.started"}');
      options?.onStdoutLine?.(
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":42}"}}',
      );
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    const progress = vi.fn();
    const adapter = new CodexAdapter(command);
    const work = lease({ outputSchema: { type: 'object' } });

    const output = await adapter.run({
      lease: work,
      taskDirectory: directory,
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(output).toEqual({ answer: 42 });
    const [binary, args, options] = command.mock.calls[0] ?? [];
    expect(binary).toBe('codex');
    expect(args).toEqual(
      buildCodexArgs(directory, 'exact-model-id', join(directory, 'output-schema.json')),
    );
    expect(args).not.toContain('PRIVATE INSTRUCTION');
    expect(JSON.stringify(args)).not.toContain('PRIVATE INPUT');
    expect(args).toContain('shell_tool');
    expect(args).toContain('unified_exec');
    expect(args).toContain('read-only');
    expect(options?.stdin).toContain('PRIVATE INSTRUCTION');
    expect(options?.stdin).toContain('PRIVATE INPUT');
    expect(options?.cwd).toBe(directory);
  });

  it('uses capsule JSON mode without inventing an output schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-adapter-test-'));
    directories.push(directory);
    const command = vi.fn<CommandExecutor>(async (_binary, _args, options) => {
      options?.onStdoutLine?.(
        '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":42}"}}',
      );
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    const adapter = new CodexAdapter(command);
    const taskCapsule: TaskCapsule = {
      version: 'ap-task/1',
      goal: 'Return an answer.',
      inputDescription: 'One question.',
      outputDescription: 'Return a JSON object.',
      constraints: [],
      examples: [],
      delivery: { format: 'json', maxBytes: 1_024 },
      acceptance: { mode: 'non_empty', criteria: ['Include answer.'] },
    };
    const work = lease({
      taskCapsule,
      outputSchema: { type: 'string', description: 'MUST NOT OVERRIDE CAPSULE' },
      contractHash: taskCapsuleHash(taskCapsule),
      delivery: { mode: 'platform' },
    });

    await expect(
      adapter.run({
        lease: work,
        taskDirectory: directory,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).resolves.toEqual({ answer: 42 });
    expect(command.mock.calls[0]?.[1]).not.toContain('--output-schema');
  });
});

describe('ClaudeAdapter', () => {
  it('disables persistence/tools and parses only the final result event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-adapter-test-'));
    directories.push(directory);
    const command = vi.fn<CommandExecutor>(async (_binary, _args, options) => {
      options?.onStdoutLine?.('{"type":"system"}');
      options?.onStdoutLine?.('{"type":"assistant","message":{}}');
      options?.onStdoutLine?.('{"type":"result","is_error":false,"result":"done"}');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    const adapter = new ClaudeAdapter(command);
    const work = lease({ requestedAgent: 'claude' });

    const output = await adapter.run({
      lease: work,
      taskDirectory: directory,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(output).toBe('done');
    const [binary, args, options] = command.mock.calls[0] ?? [];
    expect(binary).toBe('claude');
    expect(args).toEqual(buildClaudeArgs('exact-model-id'));
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--tools');
    expect(args).not.toContain('PRIVATE INSTRUCTION');
    expect(options?.stdin).toContain('PRIVATE INSTRUCTION');
    expect(options?.cwd).toBe(directory);
  });

  it('keeps a private output schema out of process arguments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentpool-adapter-test-'));
    directories.push(directory);
    const command = vi.fn<CommandExecutor>(async (_binary, _args, options) => {
      options?.onStdoutLine?.('{"type":"result","is_error":false,"result":"{\\"answer\\":42}"}');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    const adapter = new ClaudeAdapter(command);
    const work = lease({
      requestedAgent: 'claude',
      outputSchema: { type: 'object', description: 'PRIVATE SCHEMA' },
    });

    await expect(
      adapter.run({
        lease: work,
        taskDirectory: directory,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).resolves.toEqual({ answer: 42 });
    expect(JSON.stringify(command.mock.calls[0]?.[1])).not.toContain('PRIVATE SCHEMA');
    expect(command.mock.calls[0]?.[2]?.stdin).toContain('PRIVATE SCHEMA');
  });
});
