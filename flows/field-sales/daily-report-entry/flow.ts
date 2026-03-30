import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { ParsedReportData } from '../../../apps/field_sales/src/parser';
import type { Rep } from '../../../apps/field_sales/src/types';
import { templates } from '../../../apps/field_sales/src/templates';
import { buildDuplicateCheckInput } from '../../../apps/field_sales/src/inputs/check-duplicate';
import { buildWriteRawReportInput } from '../../../apps/field_sales/src/inputs/write-raw-report';
import { buildWriteNormalizedReportInput } from '../../../apps/field_sales/src/inputs/write-normalized-report';

// ---------------------------------------------------------------------------
// Helpers — read context state with safe fallback typing.
// ---------------------------------------------------------------------------

function getParsed(ctx: ExecutionContext): ParsedReportData {
  return ctx.state?.['parsed_input'] as ParsedReportData;
}

function getRep(ctx: ExecutionContext): Rep {
  return ctx.state?.['rep'] as Rep;
}

function getTimestamp(ctx: ExecutionContext): number {
  return (ctx.state?.['timestamp'] as number) ?? 0;
}

function getSubmittedAt(ctx: ExecutionContext): number {
  return (ctx.state?.['submitted_at'] as number) ?? 0;
}

function getRawText(ctx: ExecutionContext): string {
  return (ctx.event?.['message'] as string) ?? '';
}

// Returns true when the check-duplicate step ran AND found an existing record.
function isDuplicate(ctx: ExecutionContext): boolean {
  const result = ctx.outputs?.['check-duplicate'] as { rows?: unknown[] } | undefined;
  return (result?.rows?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// daily-field-report-entry flow
//
// Step execution map:
//
//   check-duplicate        → always runs; queries storage for (rep_id + date)
//   write-raw-report       → always runs; stores immutable audit record
//   write-normalized-report→ skipped if duplicate
//   send-confirmation      → skipped if duplicate
//   send-error             → runs only if duplicate
// ---------------------------------------------------------------------------

export const dailyReportEntryFlow: Flow = {
  id: 'daily-field-report-entry',
  steps: [

    // -------------------------------------------------------------------------
    // Step 1 — check-duplicate
    // -------------------------------------------------------------------------
    {
      id: 'check-duplicate',
      type: 'storage',
      input: (ctx: ExecutionContext) =>
        buildDuplicateCheckInput({
          parsed_input: getParsed(ctx),
          rep: getRep(ctx),
        }),
    },

    // -------------------------------------------------------------------------
    // Step 2 — write-raw-report
    // Always written — immutable audit trail of the original WhatsApp message.
    // -------------------------------------------------------------------------
    {
      id: 'write-raw-report',
      type: 'storage',
      input: (ctx: ExecutionContext) =>
        buildWriteRawReportInput({
          parsed_input: getParsed(ctx),
          rep: getRep(ctx),
          raw_text: getRawText(ctx),
          timestamp: getTimestamp(ctx),
        }),
    },

    // -------------------------------------------------------------------------
    // Step 3 — write-normalized-report
    // Skipped if a report already exists for (rep_id + date).
    // -------------------------------------------------------------------------
    {
      id: 'write-normalized-report',
      type: 'storage',
      condition: (ctx: ExecutionContext) => !isDuplicate(ctx),
      input: (ctx: ExecutionContext) =>
        buildWriteNormalizedReportInput({
          parsed_input: getParsed(ctx),
          rep: getRep(ctx),
          submitted_at: getSubmittedAt(ctx),
        }),
    },

    // -------------------------------------------------------------------------
    // Step 4 — send-confirmation
    // Skipped if duplicate. Sends success message to the submitting rep.
    // -------------------------------------------------------------------------
    {
      id: 'send-confirmation',
      type: 'communication',
      condition: (ctx: ExecutionContext) => !isDuplicate(ctx),
      input: (ctx: ExecutionContext) => {
        const parsed = getParsed(ctx);
        const rep = getRep(ctx);
        return {
          to: rep?.phone ?? '',
          message: templates.successConfirmation(
            parsed?.date ?? '',
            parsed?.region ?? '',
            parsed?.beat ?? '',
            parsed?.total_calls ?? 0,
            parsed?.orders ?? 0,
            parsed?.sales_value ?? 0,
          ),
        };
      },
    },

    // -------------------------------------------------------------------------
    // Step 5 — send-error
    // Runs only when a duplicate was detected.
    // -------------------------------------------------------------------------
    {
      id: 'send-error',
      type: 'communication',
      condition: (ctx: ExecutionContext) => isDuplicate(ctx),
      input: (ctx: ExecutionContext) => {
        const parsed = getParsed(ctx);
        const rep = getRep(ctx);
        return {
          to: rep?.phone ?? '',
          message: templates.duplicateWarning(parsed?.date ?? ''),
        };
      },
    },

  ],
};
