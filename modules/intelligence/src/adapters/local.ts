import type { AIAdapter, Prompt } from '../types';

const DEFAULT_URL   = 'http://localhost:11434';
const DEFAULT_MODEL = 'deepseek-r1';
const TIMEOUT_MS    = 10_000;

export class LocalAIAdapter implements AIAdapter {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl ?? DEFAULT_URL).replace(/\/$/, '');
    this.model   = model ?? DEFAULT_MODEL;
  }

  async execute(prompt: Prompt): Promise<string> {
    const combined = prompt.system
      ? `${prompt.system}\n\n${prompt.user}`
      : prompt.user;

    const body = JSON.stringify({
      model:  this.model,
      prompt: combined,
      stream: false,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `Local AI request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Local AI HTTP error: ${res.status} ${res.statusText}`);
    }

    let json: { response?: string };
    try {
      json = await res.json() as { response?: string };
    } catch {
      throw new Error('Local AI returned invalid JSON');
    }

    if (!json.response || json.response.trim() === '') {
      throw new Error('Local AI returned empty response');
    }

    return json.response;
  }
}
