import type {
  AgentAdapter,
  AgentAdapterDriver,
  CommandExecutor,
  LeasePayload,
  Logger,
} from '../../runner/src/types.js';

export type OfficialAdapter = AgentAdapter;
export type SecretReference = { env: string } | { file: string };

export interface FleetRouteConfig {
  id: string;
  kind: 'cli' | 'mock';
  concurrency: number;
  environment: Record<string, string>;
  secretEnvRefs: Record<string, SecretReference>;
}

export interface FleetCellConfig {
  id: string;
  adapter: OfficialAdapter;
  model: string;
  allowWebhooks: boolean;
  routes: FleetRouteConfig[];
}

export interface OfficialFleetConfig {
  version: 'agentpool-official-fleet/1';
  pollIntervalMs: number;
  cells: FleetCellConfig[];
}

export type RouteFailureKind = 'auth' | 'overloaded' | 'timeout' | 'transient' | 'other';

export interface RouteSnapshot {
  id: string;
  concurrency: number;
  inFlight: number;
  state: 'ready' | 'busy' | 'cooling' | 'isolated';
  cooldownUntil?: string;
  failureKind?: RouteFailureKind;
}

export interface CellSnapshot {
  id: string;
  adapter: OfficialAdapter;
  model: string;
  availableConcurrency: number;
  totalConcurrency: number;
  routes: RouteSnapshot[];
}

export interface RouteRuntime {
  readonly config: FleetRouteConfig;
  readonly command?: CommandExecutor;
  inFlight: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  isolated: boolean;
  lastFailureKind?: RouteFailureKind;
}

export interface CellRuntime {
  readonly config: FleetCellConfig;
  readonly adapter: AgentAdapterDriver;
  readonly routePool: {
    availableConcurrency(now?: number): number;
    totalConcurrency(): number;
    snapshot(now?: number): CellSnapshot;
  };
}

export interface FleetLogger extends Logger {
  debug?(message: string): void;
}

export interface RouteExecutionOptions {
  lease: LeasePayload;
  taskDirectory: string;
  signal: AbortSignal;
  onProgress: Parameters<AgentAdapterDriver['run']>[0]['onProgress'];
}
