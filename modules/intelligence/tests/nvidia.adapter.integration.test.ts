/**
 * Real integration test — hits the live NVIDIA NIM API.
 * Requires NVIDIA_API_KEY to be set.
 */

import { NvidiaAdapter } from '../src/adapters/nvidia';
import type { Prompt } from '../src/types';

const API_KEY   = process.env['NVIDIA_API_KEY']   ?? '';
const BASE_URL  = process.env['NVIDIA_BASE_URL']  ?? 'https://integrate.api.nvidia.com/v1';
const MODEL     = process.env['NVIDIA_MODEL']     ?? 'meta/llama-3.1-8b-instruct';

const skip = !API_KEY;

const describeReal = skip ? describe.skip : describe;

describeReal('NvidiaAdapter — live API', () => {
  let adapter: NvidiaAdapter;

  beforeAll(() => {
    adapter = new NvidiaAdapter(API_KEY, BASE_URL, MODEL);
  });

  it('returns a non-empty string for a simple prompt', async () => {
    const prompt: Prompt = {
      system: 'You are a helpful assistant. Respond with valid JSON only.',
      user:   'Return this JSON exactly: {"status":"ok"}',
    };

    const result = await adapter.execute(prompt);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    console.log('[nvidia] raw response:', result);
  }, 30_000);

  it('returns parseable JSON for a classification task prompt', async () => {
    const prompt: Prompt = {
      system: 'You are a classifier. Respond ONLY with valid JSON: {"label":"<label>","confidence":<0-1>}',
      user:   'Classify this message: "add credit 5000 rahul"',
    };

    const raw = await adapter.execute(prompt);
    console.log('[nvidia] classification response:', raw);

    const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
    expect(json).toHaveProperty('label');
    expect(typeof json.confidence).toBe('number');
  }, 30_000);

  it('throws on invalid API key', async () => {
    const badAdapter = new NvidiaAdapter('invalid-key', BASE_URL, MODEL);
    const prompt: Prompt = { system: 'test', user: 'test' };

    await expect(badAdapter.execute(prompt)).rejects.toThrow(/NVIDIA API error/);
  }, 30_000);
});
