import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const productionBase = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'a'.repeat(32),
  QR_SIGNING_SECRET: 'q'.repeat(32)
} as const;

describe('deployment boundaries', () => {
  it('keeps demo features forbidden in product production mode', () => {
    expect(() => loadConfig({
      ...productionBase,
      DEMO_MODE: 'true',
      ALLOW_DEMO_ATTESTATION: 'true'
    })).toThrow('Demo authentication and attestation must be disabled in production');
  });

  it('allows only an isolated in-memory public demo', () => {
    const config = loadConfig({
      ...productionBase,
      DEPLOYMENT_PURPOSE: 'public-demo',
      DATABASE_PATH: ':memory:',
      DEMO_MODE: 'true',
      ALLOW_DEMO_ATTESTATION: 'true'
    });
    expect(config.deploymentPurpose).toBe('public-demo');
    expect(config.databasePath).toBe(':memory:');
  });

  it('rejects a public demo backed by a persistent product database', () => {
    expect(() => loadConfig({
      ...productionBase,
      DEPLOYMENT_PURPOSE: 'public-demo',
      DATABASE_PATH: './data/product.sqlite',
      DEMO_MODE: 'true',
      ALLOW_DEMO_ATTESTATION: 'true'
    })).toThrow('Public demo must use demo guards and an isolated in-memory database');
  });
});
