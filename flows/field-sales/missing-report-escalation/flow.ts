import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import { computeMissing } from '../../../apps/field_sales/src/compute-missing';
import type { Rep, NormalizedReport } from '../../../apps/field_sales/src/types';

// ---------------------------------------------------------------------------
// Config expected at ctx.state.config
// ---------------------------------------------------------------------------

export type MissingReportConfig = {
  date: string;               // "DD Mon" — the date to check for missing submissions
  manager_phone: string;      // escalation recipient
  team_broadcast_phone: string; // WhatsApp group/broadcast — all reps receive reminders here
};

// ---------------------------------------------------------------------------
// Helpers — read step outputs with safe fallback typing
// ---------------------------------------------------------------------------

function getReps(ctx: ExecutionContext): Rep[] {
  const output = ctx.outputs?.['read-reps'] as { rows?: Rep[] } | undefined;
  return output?.rows ?? [];
}

function getReports(ctx: ExecutionContext): NormalizedReport[] {
  const output = ctx.outputs?.['read-reports'] as { rows?: NormalizedReport[] } | undefined;
  return output?.rows ?? [];
}

function getConfig(ctx: ExecutionContext): MissingReportConfig {
  return ctx.state?.['config'] as MissingReportConfig;
}

// Runs computeMissing() against step outputs already in context.
function getMissingIds(ctx: ExecutionContext): string[] {
  const config = getConfig(ctx);
  if (!config?.date) return [];
  return computeMissing({
    reps: getReps(ctx),
    reports: getReports(ctx),
    date: config.date,
  }).missing_rep_ids;
}

// Builds a human-readable list of missing rep names for the message body.
function formatMissingList(ctx: ExecutionContext): string {
  const missingIds = new Set(getMissingIds(ctx));
  const reps = getReps(ctx);
  const names = reps
    .filter((r) => missingIds.has(r.rep_id))
    .map((r) => r.name || r.rep_id);
  return names.length > 0 ? names.join(', ') : missingIds.size > 0 ? [...missingIds].join(', ') : '';
}

// ---------------------------------------------------------------------------
// missing-report-escalation flow
//
// Step execution map:
//
//   read-reps              → always; loads active rep roster from storage
//   read-reports           → always; loads submitted reports for the target date
//   notify-reps            → skipped if no missing reps; sends group reminder
//   notify-manager         → skipped if no missing reps; sends escalation to manager
// ---------------------------------------------------------------------------

export const missingReportEscalationFlow: Flow = {
  id: 'missing-report-escalation',
  steps: [

    // -------------------------------------------------------------------------
    // Step 1 — read-reps
    // -------------------------------------------------------------------------
    {
      id: 'read-reps',
      type: 'storage',
      input: (_ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: 'reps',
        options: { range: 'A:Z' },
      }),
    },

    // -------------------------------------------------------------------------
    // Step 2 — read-reports
    // -------------------------------------------------------------------------
    {
      id: 'read-reports',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'query',
        resource: 'daily_reports',
        query: { date: getConfig(ctx)?.date ?? '' },
        options: { range: 'A:Z' },
      }),
    },

    // -------------------------------------------------------------------------
    // Step 3 — notify-reps
    // Sends a single reminder to the team broadcast phone.
    // Skipped entirely when no one is missing.
    // -------------------------------------------------------------------------
    {
      id: 'notify-reps',
      type: 'communication',
      condition: (ctx: ExecutionContext) => getMissingIds(ctx).length > 0,
      input: (ctx: ExecutionContext) => {
        const config = getConfig(ctx);
        const missing = formatMissingList(ctx);
        return {
          to: config?.team_broadcast_phone ?? '',
          message:
            `Reminder: the following reps have not submitted their report for ${config?.date ?? 'today'}:\n` +
            `${missing}\n` +
            `Please submit before the cutoff.`,
        };
      },
    },

    // -------------------------------------------------------------------------
    // Step 4 — notify-manager
    // Sends an escalation to the manager with the full missing count and names.
    // Skipped when no one is missing.
    // -------------------------------------------------------------------------
    {
      id: 'notify-manager',
      type: 'communication',
      condition: (ctx: ExecutionContext) => getMissingIds(ctx).length > 0,
      input: (ctx: ExecutionContext) => {
        const config = getConfig(ctx);
        const missingIds = getMissingIds(ctx);
        const missing = formatMissingList(ctx);
        return {
          to: config?.manager_phone ?? '',
          message:
            `Escalation: ${missingIds.length} rep(s) have not submitted for ${config?.date ?? 'today'}.\n` +
            `Missing: ${missing}`,
        };
      },
    },

  ],
};
