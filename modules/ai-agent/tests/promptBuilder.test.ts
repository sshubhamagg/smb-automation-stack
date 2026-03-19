import { buildSystemPrompt, buildUserPrompt, buildPrompt } from '../src/promptBuilder';

const sampleData = [{ product: 'cement', stock: '50' }];
const sampleQuestion = 'Which product has the lowest stock?';

describe('buildSystemPrompt', () => {
  it('contains the required JSON schema fields', () => {
    const system = buildSystemPrompt();
    expect(system).toContain('"answer"');
    expect(system).toContain('"rows"');
    expect(system).toContain('"confidence"');
    expect(system).toContain('"status"');
  });

  it('contains all valid enum values for confidence', () => {
    const system = buildSystemPrompt();
    expect(system).toContain('low');
    expect(system).toContain('medium');
    expect(system).toContain('high');
  });

  it('contains all valid enum values for status', () => {
    const system = buildSystemPrompt();
    expect(system).toContain('ok');
    expect(system).toContain('insufficient_data');
    expect(system).toContain('ambiguous');
  });

  it('instructs LLM to return only JSON', () => {
    const system = buildSystemPrompt();
    expect(system).toContain('ONLY the JSON object');
  });

  it('instructs LLM not to hallucinate', () => {
    const system = buildSystemPrompt();
    expect(system).toContain('hallucinate');
  });

  it('is a non-empty string', () => {
    expect(buildSystemPrompt().length).toBeGreaterThan(100);
  });
});

describe('buildUserPrompt', () => {
  it('includes the question', () => {
    const user = buildUserPrompt(sampleData, sampleQuestion);
    expect(user).toContain(sampleQuestion);
  });

  it('includes serialized data', () => {
    const user = buildUserPrompt(sampleData, sampleQuestion);
    expect(user).toContain(JSON.stringify(sampleData));
  });

  it('includes context.description when provided', () => {
    const user = buildUserPrompt(sampleData, sampleQuestion, { description: 'Inventory data' });
    expect(user).toContain('Inventory data');
  });

  it('includes context.columns when provided', () => {
    const user = buildUserPrompt(sampleData, sampleQuestion, { columns: ['product', 'stock'] });
    expect(user).toContain('product, stock');
  });

  it('omits context section when not provided', () => {
    const user = buildUserPrompt(sampleData, sampleQuestion);
    expect(user).not.toContain('Columns:');
    expect(user).not.toContain('Context:');
  });

  it('omits columns when only description provided', () => {
    const user = buildUserPrompt(sampleData, sampleQuestion, { description: 'desc' });
    expect(user).not.toContain('Columns:');
  });

  it('uses compact JSON (no extra whitespace)', () => {
    const user = buildUserPrompt([{ a: 'b' }], 'q');
    expect(user).toContain('[{"a":"b"}]');
  });
});

describe('buildPrompt', () => {
  it('returns system and user strings', () => {
    const prompt = buildPrompt({ data: sampleData, question: sampleQuestion });
    expect(typeof prompt.system).toBe('string');
    expect(typeof prompt.user).toBe('string');
    expect(prompt.system.length).toBeGreaterThan(0);
    expect(prompt.user.length).toBeGreaterThan(0);
  });

  it('passes context through to user prompt', () => {
    const prompt = buildPrompt({
      data: sampleData,
      question: sampleQuestion,
      context: { description: 'Test context' },
    });
    expect(prompt.user).toContain('Test context');
  });
});
