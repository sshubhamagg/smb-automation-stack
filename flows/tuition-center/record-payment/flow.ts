// ============================================================
// Flow: record-payment
//
// Responsibilities:
//   - Read FEES sheet to find current month's record for the student
//   - Update row: Amount Paid, Status (PAID/PARTIAL), Paid At
//   - Confirm to teacher; send receipt to student
//   - Handle edge cases: fee not found, fee already PAID
//
// buildInitialContext():
//   - Computes current month (YYYY-MM)
//   - Records paidAt timestamp
//
// Steps:
//   1. read-fees          — storage read (FEES)
//   2. update-fee         — storage update (condition: fee found AND not already PAID)
//   3. confirm-teacher    — communication  (condition: update-fee ran)
//   4. receipt-student    — communication  (condition: update-fee ran)
//   5. send-not-found     — communication  (condition: fee record not found)
//   6. send-already-paid  — communication  (condition: fee found AND status = PAID)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { TuitionConfig, ParsedIntent } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentEvent = {
  phone_number: string;   // teacher's phone (sender)
};

export type PaymentState = {
  config: TuitionConfig;
  parsed: ParsedIntent;
  month: string;     // YYYY-MM
  paidAt: string;    // ISO timestamp
};

type FeeRow = Record<string, string>;

// ---------------------------------------------------------------------------
// buildInitialContext — compute month + paidAt (pure)
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: PaymentEvent,
  parsed: ParsedIntent,
  config: TuitionConfig,
): ExecutionContext {
  const now    = new Date();
  const year   = now.getFullYear();
  const mon    = String(now.getMonth() + 1).padStart(2, '0');
  const month  = `${year}-${mon}`;
  const paidAt = now.toISOString();

  return {
    event,
    state: { config, parsed, month, paidAt },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): PaymentState {
  return ctx.state as PaymentState;
}

function getFeeRows(ctx: ExecutionContext): FeeRow[] {
  const out = ctx.outputs?.['read-fees'] as { rows?: FeeRow[] } | undefined;
  return out?.rows ?? [];
}

function findFeeRow(ctx: ExecutionContext): FeeRow | undefined {
  const s    = getState(ctx);
  const rows = getFeeRows(ctx);
  return rows.find(
    r => (r['Student Phone'] ?? '').trim() === (s.parsed.studentPhone ?? '').trim()
      && (r['Month'] ?? '').trim() === s.month,
  );
}

function isFeeFound(ctx: ExecutionContext): boolean {
  return findFeeRow(ctx) !== undefined;
}

function isAlreadyPaid(ctx: ExecutionContext): boolean {
  return findFeeRow(ctx)?.['Status'] === 'PAID';
}

function updateFeeSucceeded(ctx: ExecutionContext): boolean {
  return ctx.outputs?.['update-fee'] !== undefined;
}

function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = parseInt(mon ?? '1') - 1;
  return `${names[idx] ?? mon} ${year}`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const recordPaymentFlow: Flow = {
  id: 'record-payment',
  steps: [

    // Step 1: Read full FEES sheet
    {
      id: 'read-fees',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider:  'sheets',
        operation: 'read',
        resource:  getState(ctx).config.feesSheetId,
        options:   { range: 'FEES' },
      }),
    },

    // Step 2: Update fee row (only when fee found and not already PAID)
    {
      id: 'update-fee',
      type: 'storage',
      condition: (ctx: ExecutionContext) => isFeeFound(ctx) && !isAlreadyPaid(ctx),
      input: (ctx: ExecutionContext) => {
        const s      = getState(ctx);
        const rows   = getFeeRows(ctx);
        const feeRow = findFeeRow(ctx);

        // feeRow is guaranteed to exist (condition ensures this)
        const row        = feeRow ?? {};
        const dataIndex  = rows.indexOf(row);

        const existingPaid  = parseFloat(row['Amount Paid'] ?? '0') || 0;
        const incoming      = s.parsed.amount ?? 0;
        const newAmountPaid = existingPaid + incoming;
        const amountDue     = parseFloat(row['Amount Due'] ?? '0') || 0;
        const newStatus     = newAmountPaid >= amountDue ? 'PAID' : 'PARTIAL';

        // Row order: Fee ID | Student ID | Student Phone | Name | Month |
        //            Amount Due | Amount Paid | Status | Due Date | Paid At
        const updatedRow = [
          row['Fee ID']        ?? '',
          row['Student ID']    ?? '',
          row['Student Phone'] ?? '',
          row['Name']          ?? '',
          row['Month']         ?? '',
          row['Amount Due']    ?? '',
          String(newAmountPaid),
          newStatus,
          row['Due Date']      ?? '',
          s.paidAt,
        ];

        return {
          provider:  'sheets',
          operation: 'update',
          resource:  s.config.feesSheetId,
          data:      updatedRow,
          options:   { range: 'FEES', rowIndex: dataIndex + 1 },
        };
      },
    },

    // Step 3: Confirm payment to teacher
    {
      id: 'confirm-teacher',
      type: 'communication',
      condition: updateFeeSucceeded,
      input: (ctx: ExecutionContext) => {
        const s      = getState(ctx);
        const feeRow = findFeeRow(ctx) ?? {};

        // Re-compute new state for message display
        const existingPaid  = parseFloat(feeRow['Amount Paid'] ?? '0') || 0;
        const incoming      = s.parsed.amount ?? 0;
        const newAmountPaid = existingPaid + incoming;
        const amountDue     = parseFloat(feeRow['Amount Due'] ?? '0') || 0;
        const newStatus     = newAmountPaid >= amountDue ? 'PAID' : 'PARTIAL';
        const name          = feeRow['Name'] ?? s.parsed.studentPhone ?? '';

        return {
          to:      s.config.teacherPhone,
          message: [
            'Payment recorded ✅',
            `Student : ${name} (${s.parsed.studentPhone ?? ''})`,
            `Month   : ${formatMonthLabel(s.month)}`,
            `Paid    : ₹${incoming}`,
            `Status  : ${newStatus}`,
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

    // Step 4: Send receipt to student
    {
      id: 'receipt-student',
      type: 'communication',
      condition: updateFeeSucceeded,
      input: (ctx: ExecutionContext) => {
        const s      = getState(ctx);
        const feeRow = findFeeRow(ctx) ?? {};

        const existingPaid  = parseFloat(feeRow['Amount Paid'] ?? '0') || 0;
        const incoming      = s.parsed.amount ?? 0;
        const newAmountPaid = existingPaid + incoming;
        const amountDue     = parseFloat(feeRow['Amount Due'] ?? '0') || 0;
        const balance       = Math.max(0, amountDue - newAmountPaid);

        return {
          to:      s.parsed.studentPhone ?? '',
          message: [
            'Payment received ✅',
            `₹${incoming} for ${formatMonthLabel(s.month)}`,
            s.config.centerName,
            `Balance: ₹${balance}`,
            'Thank you!',
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

    // Step 5: Notify teacher — fee record not found for this student + month
    {
      id: 'send-not-found',
      type: 'communication',
      condition: (ctx: ExecutionContext) => !isFeeFound(ctx),
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        return {
          to:      s.config.teacherPhone,
          message: `No fee record found for ${s.parsed.studentPhone ?? ''} in ${formatMonthLabel(s.month)}.\nUse "fees ${s.parsed.studentPhone ?? ''}" to check, or contact admin.`,
          provider: 'meta',
        };
      },
    },

    // Step 6: Notify teacher — fee already fully paid
    {
      id: 'send-already-paid',
      type: 'communication',
      condition: (ctx: ExecutionContext) => isFeeFound(ctx) && isAlreadyPaid(ctx),
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        return {
          to:      s.config.teacherPhone,
          message: `Fees already paid for ${s.parsed.studentPhone ?? ''} in ${formatMonthLabel(s.month)}. No action needed.`,
          provider: 'meta',
        };
      },
    },

  ],
};
