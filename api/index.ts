import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../backend/src/app.js';
import { loadConfig } from '../backend/src/config.js';
import { AppDatabase } from '../backend/src/db.js';

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'production',
  DEPLOYMENT_PURPOSE: 'public-demo',
  DATABASE_PATH: ':memory:',
  DEMO_MODE: 'true',
  ALLOW_DEMO_ATTESTATION: 'true',
  AUTH_SECRET: 'public-demo-auth-secret-not-for-production-2026',
  QR_SIGNING_SECRET: 'public-demo-qr-secret-not-for-production-2026'
});

const db = new AppDatabase(config.databasePath);
db.seed(new Date());
const app = await buildApp({ config, db });

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await app.ready();
  app.server.emit('request', request, response);
}
