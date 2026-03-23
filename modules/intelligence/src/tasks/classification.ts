import type { AIInput, Prompt, TaskHandler, TaskValidationResult } from '../types';

export class ClassificationHandler implements TaskHandler {
  buildPrompt(input: AIInput): Prompt {
    const categories: string[] = input.options?.categories ?? [];
    const categoryList = categories.length > 0 ? categories.join(', ') : 'any relevant category';

    const descriptions: Record<string, string> = {
      add:     'recording any money movement — received, paid, sent, got, gave, earned, spent, credited, debited, salary, expense, bill, fee, transfer',
      balance: 'checking overall account standing — total credits, total debits, net balance, how much money, overall status',
      summary: 'listing transactions for a time period — today\'s entries, recent activity, what was spent/received today',
      ledger:  'transaction history with a specific named person or party — what do I owe X, what does X owe me, X\'s account',
      delete:  'removing or undoing the last recorded entry — delete, undo, cancel, remove, reverse last',
    };

    const categoryLines = categories.length > 0
      ? categories.map(c => `  "${c}" — ${descriptions[c] ?? c}`).join('\n')
      : `  ${categoryList}`;

    const examples = [
      // add — various phrasings
      '"I got 5000 from rahul"              → add',
      '"gave 200 to the shopkeeper"         → add',
      '"received salary 30000 from company" → add',
      '"paid electricity bill 1500"         → add',
      '"sent 2000 to amit"                  → add',
      '"rahul returned 800"                 → add',
      '"collected rent 15000 from tenant"   → add',
      '"bought groceries for 650"           → add',
      '"deposited 10000"                    → add',
      '"withdrew 5000"                      → add',
      '"petrol 500"                         → add',
      '"₹1200 to landlord"                  → add',
      '"got 2.5k from client"               → add',
      '"paid 1 lakh advance to builder"     → add',
      // balance
      '"balance"                            → balance',
      '"what\'s my balance"                 → balance',
      '"how much do I have"                 → balance',
      '"total amount"                       → balance',
      '"show me my account"                 → balance',
      // summary
      '"summary"                            → summary',
      '"today\'s transactions"              → summary',
      '"what did I spend today"             → summary',
      '"show today\'s entries"              → summary',
      // ledger
      '"ledger rahul"                       → ledger',
      '"show rahul\'s account"              → ledger',
      '"what does amit owe me"              → ledger',
      '"history with vendor"                → ledger',
      // delete
      '"delete last"                        → delete',
      '"undo"                               → delete',
      '"remove last entry"                  → delete',
      '"cancel that"                        → delete',
    ].map(e => `  ${e}`).join('\n');

    return {
      system: [
        'You are a financial ledger assistant. Classify the user message into exactly one category.',
        '',
        'Respond ONLY in valid JSON. No explanation. No markdown.',
        '',
        'Format:',
        '{"label": "<category>", "confidence": <0.0-1.0>}',
        '',
        'Categories:',
        categoryLines,
        '',
        'Examples:',
        examples,
        '',
        'Rules:',
        '- Pick the single best matching category',
        '- For any money movement (paid, received, got, gave, sent, spent, earned, bill, salary), use "add"',
        '- confidence ≥ 0.85 when clearly matching, 0.5–0.84 when likely, < 0.5 when guessing',
        '- Do NOT output any label not listed above',
      ].join('\n'),
      user: input.input.text ?? '',
    };
  }

  validate(parsed: Record<string, unknown>, input: AIInput): TaskValidationResult {
    const { label, confidence } = parsed;

    if (typeof label !== 'string' || label.trim() === '') {
      return { valid: false, error: 'Missing or invalid field: label' };
    }

    const trimmedLabel = label.trim().toLowerCase();

    const categories: string[] = input.options?.categories ?? [];
    if (categories.length > 0 && !categories.includes(trimmedLabel)) {
      return { valid: false, error: `Label "${trimmedLabel}" is not one of the allowed categories` };
    }

    const conf = typeof confidence === 'number' ? Math.min(1, Math.max(0, confidence)) : 0;

    return { valid: true, output: { label: trimmedLabel, confidence: conf, reasoning: '' } };
  }
}
