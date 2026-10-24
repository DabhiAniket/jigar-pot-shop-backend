import { existsSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * One in-memory single-node replica set (transactions need a replica set) shared by all test
 * files; each file uses its own database. Uses the system mongod when available so tests do
 * not download a MongoDB binary.
 */
export default async function setup(project: TestProject) {
  const systemBinary =
    process.env.MONGOMS_SYSTEM_BINARY ??
    (existsSync('/usr/bin/mongod') ? '/usr/bin/mongod' : undefined);
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: systemBinary ? { systemBinary } : undefined,
  });
  await replSet.waitUntilRunning();
  project.provide('mongoUri', replSet.getUri());
  return async () => {
    await replSet.stop();
  };
}
