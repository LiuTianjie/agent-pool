import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const TASK_DIRECTORY_PREFIX = 'agentpool-task-';

export async function createTaskDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), TASK_DIRECTORY_PREFIX));
  await chmod(directory, 0o700);
  return directory;
}

export async function removeTaskDirectory(directory: string): Promise<void> {
  const resolvedDirectory = resolve(directory);
  const resolvedTemp = resolve(tmpdir());
  if (
    dirname(resolvedDirectory) !== resolvedTemp ||
    !basename(resolvedDirectory).startsWith(TASK_DIRECTORY_PREFIX)
  ) {
    throw new Error('Refusing to remove an unrecognized task directory.');
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

export async function withTaskDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await createTaskDirectory();
  try {
    return await work(directory);
  } finally {
    await removeTaskDirectory(directory);
  }
}
