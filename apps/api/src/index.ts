import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { runMigrationsWithRetry } from './db.js';
import { runMaintenance } from './services.js';
import { safeRetryErrorCode, STARTUP_RETRY_DEFAULTS } from './startup-retry.js';

const config = await loadConfig();
const app = await buildApp({ config });
try {
  await runMigrationsWithRetry(app.db, {
    onRetry: (event) => {
      app.log.warn(event, 'Database migrations unavailable; retrying startup');
    },
  });
} catch (error) {
  const errorCode = safeRetryErrorCode(error);
  app.log.fatal(
    { errorCode, retryWindowMs: STARTUP_RETRY_DEFAULTS.maxElapsedMs },
    'Database migrations unavailable after startup retry deadline',
  );
  await app.close();
  throw new Error(`Database migrations failed after startup retry deadline (${errorCode})`);
}
let maintenanceInFlight: Promise<void> | undefined;
const maintenancePass = (): Promise<void> => {
  if (maintenanceInFlight) return maintenanceInFlight;
  const current = runMaintenance(app.db).finally(() => {
    if (maintenanceInFlight === current) maintenanceInFlight = undefined;
  });
  maintenanceInFlight = current;
  return current;
};
await maintenancePass();

const maintenance = setInterval(() => {
  void maintenancePass().catch((error) => app.log.error({ error }, 'Maintenance pass failed'));
}, 10_000);
maintenance.unref();
app.addHook('onClose', async () => {
  clearInterval(maintenance);
  await maintenanceInFlight;
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
