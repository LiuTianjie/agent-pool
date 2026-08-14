import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTaskPrompt, parseTaskResult } from '../prompt.js';
import { executeCommand } from '../process.js';
import { outputSchemaForLease, processOutputLimitForLease } from '../task-contract.js';
import type {
  AdapterRunOptions,
  AgentAdapterDriver,
  CommandExecutor,
  RunnerAdapterStatus,
} from '../types.js';
import { AdapterExecutionError, firstLine, safeParseObject, unavailableStatus } from './common.js';

function extractAgentText(event: Record<string, unknown>): string | null {
  const item = event.item;
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type === 'agent_message' && typeof itemRecord.text === 'string') {
      return itemRecord.text;
    }
  }
  if (event.type === 'message.completed' && typeof event.text === 'string') return event.text;
  return null;
}

export function buildCodexArgs(
  taskDirectory: string,
  model: string,
  outputSchemaPath?: string,
): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--sandbox',
    'read-only',
    '--json',
    '-C',
    taskDirectory,
    '-m',
    model,
  ];
  if (outputSchemaPath) args.push('--output-schema', outputSchemaPath);
  args.push('-');
  return args;
}

export class CodexAdapter implements AgentAdapterDriver {
  readonly name = 'codex' as const;
  readonly defaultModels: readonly string[] = [];

  constructor(private readonly command: CommandExecutor = executeCommand) {}

  async detect(): Promise<RunnerAdapterStatus> {
    const versionResult = await this.command('codex', ['--version'], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const unavailable = unavailableStatus(this.name, versionResult);
    if (unavailable) return unavailable;

    const available = versionResult.exitCode === 0;
    if (!available) {
      return {
        adapter: this.name,
        available: false,
        authenticated: false,
        supportedModels: [],
        detail: 'CLI unavailable',
      };
    }

    const authResult = await this.command('codex', ['login', 'status'], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    return {
      adapter: this.name,
      available: true,
      authenticated: authResult.exitCode === 0,
      supportedModels: [],
      version: firstLine(versionResult.stdout),
      detail:
        authResult.exitCode === 0
          ? 'Ready; declare exact allowed models with --allow-model.'
          : 'CLI found, but local login is required.',
    };
  }

  async run(options: AdapterRunOptions): Promise<unknown> {
    const { lease, taskDirectory, signal, onProgress } = options;
    if (!lease.requestedModel) throw new AdapterExecutionError('model_mismatch');
    await onProgress({ stage: 'starting', progress: 5 });

    let schemaPath: string | undefined;
    const outputSchema = outputSchemaForLease(lease);
    if (outputSchema) {
      schemaPath = join(taskDirectory, 'output-schema.json');
      await writeFile(schemaPath, JSON.stringify(outputSchema), { mode: 0o600 });
    }

    let finalText: string | null = null;
    let emittedThinking = false;
    let emittedWorking = false;
    const result = await this.command(
      'codex',
      buildCodexArgs(taskDirectory, lease.requestedModel, schemaPath),
      {
        cwd: taskDirectory,
        stdin: buildTaskPrompt(lease),
        signal,
        maxOutputBytes: processOutputLimitForLease(lease),
        onStdoutLine: (line) => {
          const event = safeParseObject(line);
          if (!event) return;
          if (!emittedThinking && event.type === 'turn.started') {
            emittedThinking = true;
            void onProgress({ stage: 'thinking', progress: 20 });
          }
          if (!emittedWorking && event.type === 'item.started') {
            emittedWorking = true;
            void onProgress({ stage: 'working', progress: 55 });
          }
          const text = extractAgentText(event);
          if (text !== null) finalText = text;
        },
      },
    );

    if (signal.aborted) throw new AdapterExecutionError('agent_error');
    if (result.exitCode !== 0 || result.errorCode || finalText === null) {
      throw new AdapterExecutionError('agent_error');
    }
    await onProgress({ stage: 'checking', progress: 88 });
    try {
      return parseTaskResult(finalText, lease);
    } catch {
      throw new AdapterExecutionError('invalid_output');
    }
  }
}
