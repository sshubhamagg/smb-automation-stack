import { execute as storageExecute } from 'storage-module';
import * as communication from 'communication-module';
import { run as intelligenceRun } from 'intelligence-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import {
  buildInitialContext as buildRouterCtx,
  intentRouterFlow,
  resolveRouting,
} from '../../../flows/ledger/intent-router/flow';
import { buildInitialContext as buildEntryCtx,   ledgerEntryFlow   } from '../../../flows/ledger/ledger-entry/flow';
import { buildInitialContext as buildBalanceCtx, ledgerBalanceFlow } from '../../../flows/ledger/ledger-balance/flow';
import { buildInitialContext as buildSummaryCtx, ledgerSummaryFlow } from '../../../flows/ledger/ledger-summary/flow';
import { buildInitialContext as buildPartyCtx,   ledgerPartyFlow   } from '../../../flows/ledger/ledger-party/flow';
import { buildInitialContext as buildDeleteCtx,  ledgerDeleteFlow  } from '../../../flows/ledger/ledger-delete/flow';

export type IncomingMessage = {
  phone_number: string;
  text_body?: string;
  message_type: 'text' | 'unsupported';
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type AppConfig = {
  sheetId: string;
  ownerPhone: string;
  mode: 'structured' | 'ai';
  aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia';
};

function loadConfig(): AppConfig {
  const sheetId   = process.env['LEDGER_SHEET_ID'];
  const ownerPhone = process.env['LEDGER_OWNER_PHONE'];
  if (!sheetId || !ownerPhone) {
    throw new Error('Missing required env vars: LEDGER_SHEET_ID, LEDGER_OWNER_PHONE');
  }
  const cfg: AppConfig = {
    sheetId,
    ownerPhone,
    mode:       (process.env['LEDGER_MODE']        ?? 'structured') as 'structured' | 'ai',
    aiProvider: (process.env['LEDGER_AI_PROVIDER'] ?? 'anthropic')  as 'openai' | 'anthropic' | 'local' | 'nvidia',
  };
  console.log('[AI provider]', cfg.aiProvider);
  return cfg;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const modules: Modules = {
  storage:      (input: unknown) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input: unknown) => communication.execute(input as { to: string; message: string }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intelligence: (input: unknown) => intelligenceRun(input as any),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function send(to: string, message: string): Promise<void> {
  await communication.execute({ to, message }).catch((err: unknown) => {
    console.error('[ledger] send failed:', err instanceof Error ? err.message : err);
  });
}

// Reconstruct a structured "add ..." text_body from a normalized payload.
// ledger-entry/flow.ts parses the text_body; this ensures AI-extracted fields
// pass through its parser correctly.
function payloadToAddText(payload: { type?: string; amount?: number; party?: string; category?: string }): string {
  return ['add', payload.type, String(payload.amount ?? ''), payload.party, payload.category]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleLedgerMessage(msg: IncomingMessage): Promise<void> {
  const phone = msg.phone_number;
  const text  = msg.text_body?.trim() ?? '';

  let cfg: AppConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('[ledger] Config error:', err instanceof Error ? err.message : err);
    await send(phone, 'Service misconfigured. Please contact support.');
    return;
  }

  const ledgerConfig = { sheetId: cfg.sheetId, ownerPhone: cfg.ownerPhone };
  const routerConfig = { mode: cfg.mode, aiProvider: cfg.aiProvider, ownerPhone: cfg.ownerPhone };

  // ── Step 1: Intent router ────────────────────────────────────────────────
  const routerCtx    = buildRouterCtx({ message: text, user: phone }, routerConfig);
  const routerResult = await runFlow(intentRouterFlow, routerCtx, modules);

  if (!routerResult.ok) {
    console.error('[ledger-router] failed:', routerResult.error);
    await send(phone, 'Could not process your request. Please try again.');
    return;
  }

  // ── Step 2: Resolve routing decision ────────────────────────────────────
  const routing = resolveRouting(routerResult.context);

  if (!routing) {
    // send-invalid already fired inside the router for structured mode failures.
    // For AI mode, the classify step always returns one of the 5 labels, so null
    // here means AI extraction failed (e.g. missing required fields for 'add').
    if (cfg.mode === 'ai') {
      await send(phone, 'Could not extract transaction details. Try: add credit 5000 rahul');
    }
    return;
  }

  const { nextFlow, payload } = routing;
  console.log(`[ledger] → ${nextFlow} (${phone})`);

  // ── Step 3: Dispatch to correct flow ────────────────────────────────────

  if (nextFlow === 'ledger-entry') {
    const textBody   = payloadToAddText(payload);
    const ctxResult  = buildEntryCtx({ phone_number: phone, text_body: textBody, config: ledgerConfig });
    if (!ctxResult.ok) {
      await send(phone, 'Invalid entry format. Use: add credit 5000 rahul');
      return;
    }
    const result = await runFlow(ledgerEntryFlow, ctxResult.context, modules);
    if (!result.ok) {
      console.error('[ledger-entry] failed:', result.error);
      await send(phone, 'Failed to record entry. Please try again.');
    }
    return;
  }

  if (nextFlow === 'ledger-balance') {
    const { context } = buildBalanceCtx({ phone_number: phone, config: ledgerConfig });
    const result      = await runFlow(ledgerBalanceFlow, context, modules);
    if (!result.ok) console.error('[ledger-balance] failed:', result.error);
    return;
  }

  if (nextFlow === 'ledger-summary') {
    const { context } = buildSummaryCtx({ phone_number: phone, config: ledgerConfig });
    const result      = await runFlow(ledgerSummaryFlow, context, modules);
    if (!result.ok) console.error('[ledger-summary] failed:', result.error);
    return;
  }

  if (nextFlow === 'ledger-party') {
    const party = payload.party ?? '';
    if (!party) { await send(phone, 'Specify a party name. Example: ledger rahul'); return; }
    const { context } = buildPartyCtx({ phone_number: phone, party, config: ledgerConfig });
    const result      = await runFlow(ledgerPartyFlow, context, modules);
    if (!result.ok) console.error('[ledger-party] failed:', result.error);
    return;
  }

  if (nextFlow === 'ledger-delete') {
    const { context } = buildDeleteCtx({ phone_number: phone, config: ledgerConfig });
    const result      = await runFlow(ledgerDeleteFlow, context, modules);
    if (!result.ok) console.error('[ledger-delete] failed:', result.error);
    return;
  }

  console.error('[ledger] Unhandled nextFlow:', nextFlow);
}
