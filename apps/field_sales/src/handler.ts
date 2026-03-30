import { execute as storageExecute } from 'storage-module';
import { execute as communicationExecute } from 'communication-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import { buildInitialContext } from './context';
import { dailyReportEntryFlow } from '../../../flows/field-sales/daily-report-entry/flow';
import { templates } from './templates';
import type { Rep } from './types';

// ---------------------------------------------------------------------------
// Incoming event shape from WhatsApp ingestion layer
// ---------------------------------------------------------------------------

export type FieldSalesEvent = {
  message: string;   // raw text body from WhatsApp
  user: string;      // E.164 phone or rep_id
  timestamp: number; // epoch ms
};

// ---------------------------------------------------------------------------
// Config — loaded once from environment at handler call time
// ---------------------------------------------------------------------------

type HandlerConfig = {
  reps: Rep[];
};

function loadConfig(): HandlerConfig {
  const repsJson = process.env['FIELD_SALES_REPS_JSON'];
  if (!repsJson) {
    throw new Error('Missing required env var: FIELD_SALES_REPS_JSON');
  }
  const reps = JSON.parse(repsJson) as Rep[];
  if (!Array.isArray(reps) || reps.length === 0) {
    throw new Error('FIELD_SALES_REPS_JSON must be a non-empty JSON array');
  }
  return { reps };
}

// ---------------------------------------------------------------------------
// Modules — wired at handler level; engine has no knowledge of implementations
// ---------------------------------------------------------------------------

const modules: Modules = {
  storage:       (input) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input) => communicationExecute(input as { to: string; message: string }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Guarded send — a failed delivery must never crash the handler.
async function send(to: string, message: string): Promise<void> {
  await communicationExecute({ to, message }).catch((err: unknown) => {
    console.error('[field-sales] send failed:', err instanceof Error ? err.message : err);
  });
}

function log(label: string, data?: unknown): void {
  if (data !== undefined) {
    console.log(`[field-sales] ${label}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[field-sales] ${label}`);
  }
}

// ---------------------------------------------------------------------------
// handleFieldSalesReport
//
// Single entry point for an incoming WhatsApp field sales report.
//
// Failure path guarantee:
//   Every failure sends a WhatsApp response before returning.
//   No silent failures.
//
// Paths:
//   1. Config error         → log + send generic error to rep + return
//   2. Context build error  → send structured error to rep (parse / validation)
//   3. Flow ok              → flow steps handle confirmation (send-confirmation step)
//   4. Flow failure         → log step + send fallback error to rep
// ---------------------------------------------------------------------------

export async function handleFieldSalesReport(event: FieldSalesEvent): Promise<void> {
  log(`incoming report from ${event.user}`);

  // ── 1. Load config ──────────────────────────────────────────────────────

  let config: HandlerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[field-sales] config error:', msg);
    await send(event.user, templates.validationError('Service misconfigured. Please contact support.'));
    return;
  }

  // ── 2. Build context (parse + rep lookup + validation) ──────────────────

  const ctxResult = buildInitialContext({
    event: { message: event.message, user: event.user },
    config: { reps: config.reps },
  });

  if (!ctxResult.ok) {
    log('context build failed', { reason: ctxResult.error });
    await send(event.user, templates.validationError(ctxResult.error));
    return;
  }

  log('context built', { rep: ctxResult.context.state?.['rep']?.rep_id });

  // ── 3. Run flow ──────────────────────────────────────────────────────────

  const result = await runFlow(dailyReportEntryFlow, ctxResult.context, modules);

  log('flow result', {
    ok: result.ok,
    steps: result.steps.map((s) => ({ id: s.id, status: s.status })),
  });

  // ── 4. Handle flow failure ───────────────────────────────────────────────

  if (!result.ok) {
    console.error(`[field-sales] flow failed at step "${result.failedStep}": ${result.error}`);
    await send(
      event.user,
      templates.validationError('Failed to process your report. Please try again later.'),
    );
  }
}
