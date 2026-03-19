import { loadConfig } from './config';
import { setLogLevel } from './logger';
import { handle, AnalyzeInput, AnalyzeResponse } from './handler';

function setup(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);
}

setup();

export async function analyze(input: AnalyzeInput): Promise<AnalyzeResponse> {
  return handle(input);
}
