import { loadConfig } from './config.js';
import { createDatabase, runMigrationsWithRetry } from './db.js';
import { bindOfficialFleetOwner } from './official-fleet.js';

const ownerId = readOwnerId(process.argv.slice(2));
const config = await loadConfig();
const db = createDatabase(config.databaseUrl);

try {
  await runMigrationsWithRetry(db);
  const binding = await bindOfficialFleetOwner(db, ownerId, config.defaultOfficialOwnerEmail);
  console.log(
    binding.created
      ? `Official fleet owner bound: ${binding.ownerId} (${binding.ownerEmail}), mode=${binding.mode}`
      : `Official fleet owner already bound: ${binding.ownerId} (${binding.ownerEmail}), mode=${binding.mode}`,
  );
} finally {
  await db.end();
}

function readOwnerId(args: string[]): string {
  const flagIndex = args.indexOf('--owner-id');
  const value = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(
      'Usage: pnpm --filter @agent-pool/api official-fleet:bind -- --owner-id <existing-user-uuid>',
    );
  }
  return value;
}
