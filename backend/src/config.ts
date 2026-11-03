import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEPLOYMENT_PURPOSE: z.enum(['product', 'public-demo']).default('product'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_PATH: z.string().default('./data/presence-guard.sqlite'),
  AUTH_SECRET: z.string().min(32).default('development-auth-secret-change-me-0001'),
  QR_SIGNING_SECRET: z.string().min(32).default('development-qr-secret-change-me-000002'),
  QR_SIGNING_KEY_ID: z.string().min(1).max(32).default('v1'),
  DEMO_MODE: z.string().default('true').transform((value) => value === 'true'),
  ALLOW_DEMO_ATTESTATION: z.string().default('true').transform((value) => value === 'true'),
  ALLOWED_ORIGINS: z.string().default(''),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().default(''),
  APPLE_TEAM_ID: z.string().default(''),
  APPLE_BUNDLE_ID: z.string().default(''),
  APPLE_ALLOW_DEVELOPMENT: z.string().default('false').transform((value) => value === 'true')
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, string | undefined> = process.env) {
  const config = schema.parse(overrides);
  if (config.NODE_ENV === 'production') {
    const isPublicDemo = config.DEPLOYMENT_PURPOSE === 'public-demo';
    if (!isPublicDemo && (config.DEMO_MODE || config.ALLOW_DEMO_ATTESTATION)) {
      throw new Error('Demo authentication and attestation must be disabled in production');
    }
    if (isPublicDemo && (!config.DEMO_MODE || !config.ALLOW_DEMO_ATTESTATION || config.DATABASE_PATH !== ':memory:')) {
      throw new Error('Public demo must use demo guards and an isolated in-memory database');
    }
    if (!isPublicDemo && (config.AUTH_SECRET.startsWith('development-') || config.QR_SIGNING_SECRET.startsWith('development-'))) {
      throw new Error('Production secrets must be replaced');
    }
  }
  return {
    nodeEnv: config.NODE_ENV,
    deploymentPurpose: config.DEPLOYMENT_PURPOSE,
    host: config.HOST,
    port: config.PORT,
    databasePath: config.DATABASE_PATH,
    authSecret: config.AUTH_SECRET,
    qrSigningSecret: config.QR_SIGNING_SECRET,
    qrSigningKeyId: config.QR_SIGNING_KEY_ID,
    demoMode: config.DEMO_MODE,
    allowDemoAttestation: config.ALLOW_DEMO_ATTESTATION,
    allowedOrigins: config.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
    googlePlayPackageName: config.GOOGLE_PLAY_PACKAGE_NAME,
    appleTeamId: config.APPLE_TEAM_ID,
    appleBundleId: config.APPLE_BUNDLE_ID,
    appleAllowDevelopment: config.APPLE_ALLOW_DEVELOPMENT
  };
}
