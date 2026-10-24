// Initialises a single-node replica set (idempotent). Uses the MongoDB driver that ships with
// Mongoose, so mongosh is not required.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const { MongoClient } = require('mongodb');

const host = process.argv[2] ?? '127.0.0.1:27018';
const client = new MongoClient(`mongodb://${host}/?directConnection=true`, {
  serverSelectionTimeoutMS: 15000,
});

try {
  await client.connect();
  const admin = client.db('admin');
  try {
    const status = await admin.command({ replSetGetStatus: 1 });
    console.log(`• Replica set "${status.set}" already initialised`);
  } catch (error) {
    if (!/no replset config|NotYetInitialized/i.test(`${error.codeName} ${error.message}`))
      throw error;
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] } });
    console.log('✔ Replica set rs0 initialised');
  }
  for (let i = 0; i < 60; i++) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) {
      console.log('✔ MongoDB primary ready');
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for the replica set primary');
} finally {
  await client.close();
}
