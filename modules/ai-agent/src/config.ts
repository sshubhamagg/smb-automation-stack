import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  llmApiKey: string;
  llmProvider: string;
  llmTimeoutMs: number;
  logLevel: string;
}

let _config: Readonly<Config> | null = null;

export function loadConfig(): Readonly<Config> {
  if (_config) return _config;

  const llmApiKey = process.env.LLM_API_KEY;
  if (!llmApiKey) throw new Error('LLM_API_KEY is required but not set');

  _config = Object.freeze({
    llmApiKey,
    llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
    llmTimeoutMs: parseInt(process.env.LLM_TIMEOUT_MS ?? '10000', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  });

  return _config;
}

export function resetConfig(): void {
  _config = null;
}
