import type { DatasetSource, RequestedAgent, TaskCategory } from '@agent-pool/shared';
import type {
  AcceptanceMode,
  DeliveryFormat,
  DeliveryMode,
  LaunchMode,
  TaskCapsule,
  TaskExampleDraft,
} from './taskContract';
import type { TaskUnitDraft } from './unitTypes';
import type { UnitParseMode } from './units';

export const PUBLISH_DRAFT_KEY = 'agent-pool.publish-draft.v1';

export interface WorkPreview {
  url: string;
  title: string;
  category: string;
  publicSummary: string;
  adapter: RequestedAgent;
  model: string;
  urlHost: string;
  unitsHost: string;
  answersHost: string | null;
  acceptance: AcceptanceMode;
  totalUnits: number;
  taskCapsule: TaskCapsule;
}

export interface PublishDraftV1 {
  v: 1;
  step: 1 | 2 | 3;
  source: DatasetSource['mode'];
  workUrl: string;
  workPreview: WorkPreview | null;
  title: string;
  category: TaskCategory;
  goal: string;
  inputDescription: string;
  outputDescription: string;
  constraintsRaw: string;
  examples: TaskExampleDraft[];
  datasetUrl: string;
  datasetHost: string | null;
  remoteUnitCount: number;
  datasetCheckedUrl: string;
  rawUnits: string;
  parseMode: UnitParseMode;
  units: TaskUnitDraft[];
  acceptanceMode: AcceptanceMode;
  deliveryFormat: DeliveryFormat;
  schemaText: string;
  deliveryTarget: DeliveryMode;
  webhookUrl: string;
  receiptSecret: string;
  requestedAgent: RequestedAgent;
  requestedModel: string;
  requiredConcurrency: number;
  maxUnitSeconds: number;
  deadlineAt: string;
  rewardPerUnit: number;
  launchMode: LaunchMode;
  pilotUnits: number;
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const AGENTS: RequestedAgent[] = ['codex', 'claude', 'mock'];
const STEPS = [1, 2, 3] as const;
const SOURCES: DatasetSource['mode'][] = ['work', 'https', 'inline'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgent(value: unknown): value is RequestedAgent {
  return typeof value === 'string' && AGENTS.includes(value as RequestedAgent);
}

export function defaultPublishDeadline(now = Date.now()): string {
  const date = new Date(now + 24 * 60 * 60 * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function restorePublishDeadline(value: unknown, now = Date.now()): string {
  if (typeof value !== 'string') return defaultPublishDeadline(now);
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time <= now + 10_000) return defaultPublishDeadline(now);
  return value;
}

export function parsePublishDraft(value: unknown, now = Date.now()): PublishDraftV1 | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!STEPS.includes(value.step as 1 | 2 | 3)) return null;
  if (
    typeof value.source !== 'string' ||
    !SOURCES.includes(value.source as DatasetSource['mode'])
  ) {
    return null;
  }
  if (!isAgent(value.requestedAgent)) return null;
  return {
    v: 1,
    step: value.step as 1 | 2 | 3,
    source: value.source as DatasetSource['mode'],
    workUrl: typeof value.workUrl === 'string' ? value.workUrl : '',
    workPreview: isRecord(value.workPreview) ? (value.workPreview as unknown as WorkPreview) : null,
    title: typeof value.title === 'string' ? value.title : '',
    category: typeof value.category === 'string' ? (value.category as TaskCategory) : 'text',
    goal: typeof value.goal === 'string' ? value.goal : '',
    inputDescription: typeof value.inputDescription === 'string' ? value.inputDescription : '',
    outputDescription: typeof value.outputDescription === 'string' ? value.outputDescription : '',
    constraintsRaw: typeof value.constraintsRaw === 'string' ? value.constraintsRaw : '',
    examples: Array.isArray(value.examples)
      ? (value.examples as TaskExampleDraft[])
      : [{ input: '', output: '', note: '' }],
    datasetUrl: typeof value.datasetUrl === 'string' ? value.datasetUrl : '',
    datasetHost: typeof value.datasetHost === 'string' ? value.datasetHost : null,
    remoteUnitCount: typeof value.remoteUnitCount === 'number' ? value.remoteUnitCount : 0,
    datasetCheckedUrl: typeof value.datasetCheckedUrl === 'string' ? value.datasetCheckedUrl : '',
    rawUnits: typeof value.rawUnits === 'string' ? value.rawUnits : '',
    parseMode: value.parseMode === 'lines' ? 'lines' : 'jsonl',
    units: Array.isArray(value.units) ? (value.units as TaskUnitDraft[]) : [],
    acceptanceMode:
      typeof value.acceptanceMode === 'string'
        ? (value.acceptanceMode as AcceptanceMode)
        : 'non_empty',
    deliveryFormat: value.deliveryFormat === 'json' ? 'json' : 'text',
    schemaText: typeof value.schemaText === 'string' ? value.schemaText : '',
    deliveryTarget: value.deliveryTarget === 'webhook' ? 'webhook' : 'platform',
    webhookUrl: typeof value.webhookUrl === 'string' ? value.webhookUrl : '',
    receiptSecret: typeof value.receiptSecret === 'string' ? value.receiptSecret : '',
    requestedAgent: value.requestedAgent,
    requestedModel: typeof value.requestedModel === 'string' ? value.requestedModel : '',
    requiredConcurrency:
      typeof value.requiredConcurrency === 'number' ? value.requiredConcurrency : 3,
    maxUnitSeconds: typeof value.maxUnitSeconds === 'number' ? value.maxUnitSeconds : 120,
    deadlineAt: restorePublishDeadline(value.deadlineAt, now),
    rewardPerUnit: typeof value.rewardPerUnit === 'number' ? value.rewardPerUnit : 10,
    launchMode: value.launchMode === 'immediate' ? 'immediate' : 'pilot',
    pilotUnits: typeof value.pilotUnits === 'number' ? value.pilotUnits : 3,
  };
}

export function readPublishDraft(
  storage: DraftStorage | null = defaultDraftStorage(),
  now = Date.now(),
): PublishDraftV1 | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PUBLISH_DRAFT_KEY);
    if (!raw) return null;
    return parsePublishDraft(JSON.parse(raw) as unknown, now);
  } catch {
    return null;
  }
}

export function writePublishDraft(
  draft: PublishDraftV1,
  storage: DraftStorage | null = defaultDraftStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PUBLISH_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota or private mode should not block publishing.
  }
}

export function clearPublishDraft(storage: DraftStorage | null = defaultDraftStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(PUBLISH_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function defaultDraftStorage(): DraftStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}
