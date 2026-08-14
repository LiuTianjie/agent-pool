import { buildTaskPrompt, parseTaskResult } from '../prompt.js';
import { executeCommand } from '../process.js';
import { processOutputLimitForLease } from '../task-contract.js';
import type {
  AdapterRunOptions,
  AgentAdapterDriver,
  CommandExecutor,
  RunnerAdapterStatus,
} from '../types.js';
import { AdapterExecutionError, firstLine, safeParseObject, unavailableStatus } from './common.js';

export function buildClaudeArgs(model: string): string[] {
  return [
    '-p',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--tools',
    '',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
  ];
}

export class ClaudeAdapter implements AgentAdapterDriver {
  readonly name = 'claude' as const;
  readonly defaultModels: readonly string[] = [];

  constructor(private readonly command: CommandExecutor = executeCommand) {}

  async detect(): Promise<RunnerAdapterStatus> {
    const versionResult = await this.command('claude', ['--version'], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const unavailable = unavailableStatus(this.name, versionResult);
    if (unavailable) return unavailable;
    if (versionResult.exitCode !== 0) {
      return {
        adapter: this.name,
        available: false,
        authenticated: false,
        supportedModels: [],
        detail: 'CLI unavailable',
      };
    }

    const authResult = await this.command('claude', ['auth', 'status'], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    let authenticated = false;
    const auth = safeParseObject(authResult.stdout);
    if (auth && typeof auth.loggedIn === 'boolean') authenticated = auth.loggedIn;
    else authenticated = authResult.exitCode === 0;

    return {
      adapter: this.name,
      available: true,
      authenticated,
      supportedModels: [],
      version: firstLine(versionResult.stdout),
      detail: authenticated
        ? 'Ready; declare exact allowed models with --allow-model.'
        : 'CLI found, but local login is required.',
    };
  }

  async run(options: AdapterRunOptions): Promise<unknown> {
    const { lease, taskDirectory, signal, onProgress } = options;
    if (!lease.requestedModel) throw new AdapterExecutionError('model_mismatch');
    await onProgress({ stage: 'starting', progress: 5 });

    let finalOutput: unknown;
    let hasFinalOutput = false;
    let emittedThinking = false;
    let emittedWorking = false;
    const result = await this.command('claude', buildClaudeArgs(lease.requestedModel), {
      cwd: taskDirectory,
      stdin: buildTaskPrompt(lease),
      signal,
      maxOutputBytes: processOutputLimitForLease(lease),
      onStdoutLine: (line) => {
        const event = safeParseObject(line);
        if (!event) return;
        if (!emittedThinking && event.type === 'system') {
          emittedThinking = true;
          void onProgress({ stage: 'thinking', progress: 20 });
        }
        if (!emittedWorking && event.type === 'assistant') {
          emittedWorking = true;
          void onProgress({ stage: 'working', progress: 55 });
        }
        if (event.type === 'result' && event.is_error !== true) {
          if (typeof event.result === 'string') {
            finalOutput = event.result;
            hasFinalOutput = true;
          }
        }
      },
    });

    if (signal.aborted) throw new AdapterExecutionError('agent_error');
    if (result.exitCode !== 0 || result.errorCode || !hasFinalOutput) {
      throw new AdapterExecutionError('agent_error');
    }
    await onProgress({ stage: 'checking', progress: 88 });
    try {
      return parseTaskResult(finalOutput as string, lease);
    } catch {
      throw new AdapterExecutionError('invalid_output');
    }
  }
}
