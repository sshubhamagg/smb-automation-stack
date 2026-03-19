import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  serviceAccountJson: string;
  logLevel: string;
}

let _config: Readonly<Config> | null = null;

export function loadConfig(): Readonly<Config> {
  if (_config) return _config;

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required but not set');
  }

  try {
    JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON');
  }

  _config = Object.freeze({
    serviceAccountJson,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  });

  return _config;
}

export function resetConfig(): void {
  _config = null;
}
