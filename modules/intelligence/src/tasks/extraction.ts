import type { AIInput, Prompt, TaskHandler, TaskValidationResult } from '../types';

// ---------------------------------------------------------------------------
// Amount normalisation — runs in validator so the flow's parseAmount always
// receives a clean numeric string regardless of what the LLM returns.
// ---------------------------------------------------------------------------

function normalizeAmountString(raw: string): string {
  let s = raw.trim()
    .replace(/[₹$€£¥]/g, '')          // strip currency symbols
    .replace(/^(Rs\.?|INR|USD|EUR)\s*/i, '') // strip textual currency prefixes
    .replace(/,/g, '')                 // remove thousands separators
    .trim();

  const lower = s.toLowerCase();

  // "crore" / "cr" — 10,000,000
  const croreMatch = lower.match(/^([\d.]+)\s*(crore|cr)$/);
  if (croreMatch) return String(parseFloat(croreMatch[1]) * 10_000_000);

  // "lakh" / "lac" / "l" — 100,000
  const lakhMatch = lower.match(/^([\d.]+)\s*(lakh|lac|l)$/);
  if (lakhMatch) return String(parseFloat(lakhMatch[1]) * 100_000);

  // "thousand" — 1,000  (bare "k" is handled by the flow's parseAmount)
  const thousandMatch = lower.match(/^([\d.]+)\s*thousand$/);
  if (thousandMatch) return String(parseFloat(thousandMatch[1]) * 1_000);

  return s;
}

export class ExtractionHandler implements TaskHandler {
  buildPrompt(input: AIInput): Prompt {
    const fields: string[] = input.options?.fields ?? [];
    const fieldList = fields.length > 0 ? fields.join(', ') : 'all relevant fields';

    return {
      system: [
        'You are a financial ledger assistant. Extract transaction fields from the user message.',
        '',
        'Respond ONLY in valid JSON. No explanation. No markdown.',
        '',
        `Extract these fields: ${fieldList}`,
        '',
        'Format:',
        `{${fields.map(f => `"${f}": "<value or null>"`).join(', ')}}`,
        '',
        'Field rules:',
        '- type: "credit" = money IN  — received, got, earned, collected, deposited, returned, credited, income, salary.',
        '       "debit"  = money OUT — paid, spent, gave, sent, withdrew, bought, purchased, shopped, expense, bill, fee.',
        '       Must be exactly "credit", "debit", or null.',
        '- amount: numeric string only. Strip ₹/$. Remove commas. Keep "k" suffix if present (e.g. "2.5k").',
        '          Convert: "1 lakh"→"100000", "1 crore"→"10000000", "1 thousand"→"1000".',
        '          If no amount present, use null.',
        '- party: name of the person or business. Strip leading articles ("the", "a", "an").',
        '         If no specific person is mentioned but a payee/vendor is implied by context,',
        '         use the service/vendor type as party (e.g. "electricity bill" → party:"electricity board",',
        '         "petrol 500" → party:"petrol pump", "grocery 650" → party:"grocery store").',
        '         Only use null if absolutely no party can be inferred.',
        '- category: infer from context when clear — e.g. "salary", "rent", "groceries", "electricity",',
        '            "petrol", "food", "medical", "travel", "supplies", "fee", "loan", "advance".',
        '            Use null if unclear.',
        '',
        'Examples:',
        '  "I got 5000 from rahul"                  → {"type":"credit","amount":"5000","party":"rahul","category":null}',
        '  "gave 200 to the shopkeeper"              → {"type":"debit","amount":"200","party":"shopkeeper","category":null}',
        '  "paid ₹1,500 rent to landlord"            → {"type":"debit","amount":"1500","party":"landlord","category":"rent"}',
        '  "received salary 30000 from company"      → {"type":"credit","amount":"30000","party":"company","category":"salary"}',
        '  "electricity bill 800"                    → {"type":"debit","amount":"800","party":"electricity board","category":"electricity"}',
        '  "got 2.5k from amit"                      → {"type":"credit","amount":"2.5k","party":"amit","category":null}',
        '  "paid 1 lakh advance to builder"          → {"type":"debit","amount":"100000","party":"builder","category":"advance"}',
        '  "petrol 500"                              → {"type":"debit","amount":"500","party":"petrol pump","category":"petrol"}',
        '  "sent Rs 2000 to rahul for groceries"     → {"type":"debit","amount":"2000","party":"rahul","category":"groceries"}',
        '  "rahul returned 800"                      → {"type":"credit","amount":"800","party":"rahul","category":null}',
        '  "collected rent 15000 from tenant"        → {"type":"credit","amount":"15000","party":"tenant","category":"rent"}',
        '  "withdrew 5000"                           → {"type":"debit","amount":"5000","party":null,"category":null}',
        '  "deposited 10000"                         → {"type":"credit","amount":"10000","party":null,"category":null}',
        '',
        'Rules:',
        '- Each value must be a string or null — never a number',
        '- party is required for routing; only use null if truly no person or entity is mentioned',
        '- Do NOT hallucinate values not present in the message',
        '- Do NOT add explanations outside the JSON',
      ].join('\n'),
      user: input.input.text ?? '',
    };
  }

  validate(parsed: Record<string, unknown>, input: AIInput): TaskValidationResult {
    if (Object.keys(parsed).length === 0) {
      return { valid: false, error: 'Extraction result is empty' };
    }

    const fields: string[] = input.options?.fields ?? [];
    const VALID_TYPES = new Set(['credit', 'debit', null]);

    const normalized: Record<string, string | null> = {};

    for (const field of fields) {
      const raw = parsed[field];

      // Coerce numbers to string (amount: 5000 → "5000")
      const value = typeof raw === 'number' ? String(raw)
                  : typeof raw === 'string' ? raw.trim() || null
                  : raw === null || raw === undefined ? null
                  : null; // reject objects/arrays

      if (typeof value !== 'string' && value !== null) {
        return { valid: false, error: `Field "${field}" must be a string or null` };
      }

      if (field === 'type') {
        const t = value?.toLowerCase() ?? null;
        if (!VALID_TYPES.has(t)) {
          return { valid: false, error: `Field "type" must be "credit", "debit", or null — got "${value}"` };
        }
        normalized[field] = t;
      } else if (field === 'amount' && value !== null) {
        // Normalise amount so the flow's parseAmount always gets a clean string
        normalized[field] = normalizeAmountString(value);
      } else {
        normalized[field] = value;
      }
    }

    // Carry through any extra fields the LLM returned
    for (const [key, raw] of Object.entries(parsed)) {
      if (fields.includes(key)) continue;
      if (typeof raw !== 'string' && raw !== null) {
        return { valid: false, error: `Field "${key}" must be a string or null` };
      }
      normalized[key] = typeof raw === 'string' ? raw.trim() || null : null;
    }

    return { valid: true, output: { fields: normalized } };
  }
}
