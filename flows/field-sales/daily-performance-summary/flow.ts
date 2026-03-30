import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import { aggregateReports, type AggregateResult } from '../../../apps/field_sales/src/aggregate';
import { computeMissing } from '../../../apps/field_sales/src/compute-missing';
import { templates } from '../../../apps/field_sales/src/templates';
import type { Rep, NormalizedReport } from '../../../apps/field_sales/src/types';

// ---------------------------------------------------------------------------
// Config expected at ctx.state.config
// ---------------------------------------------------------------------------

export type PerformanceSummaryConfig = {
  date: string;
  manager_id: string;
  manager_phone: string;
  reps: Rep[];
};

// ---------------------------------------------------------------------------
// Helpers — safe context reads
// ---------------------------------------------------------------------------

function getConfig(ctx: ExecutionContext): PerformanceSummaryConfig {
  return ctx.state?.['config'] as PerformanceSummaryConfig;
}

function getReports(ctx: ExecutionContext): NormalizedReport[] {
  const output = ctx.outputs?.['read-reports'] as { rows?: NormalizedReport[] } | undefined;
  return output?.rows ?? [];
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

function runAggregation(ctx: ExecutionContext): AggregateResult {
  return aggregateReports(getReports(ctx));
}

function runMissingCompute(ctx: ExecutionContext): string[] {
  const config = getConfig(ctx);
  if (!config?.reps || !config?.date) return [];
  return computeMissing({
    reps: config.reps,
    reports: getReports(ctx),
    date: config.date,
  }).missing_rep_ids;
}

function resolveRepName(repId: string, reps: Rep[]): string {
  return reps.find((r) => r.rep_id === repId)?.name ?? repId;
}

function topPerformerIds(agg: AggregateResult): string[] {
  return Object.values(agg.rep_metrics)
    .sort((a, b) => b.sales_value - a.sales_value)
    .slice(0, 3)
    .map((m) => m.rep_id);
}

function exceptionLines(agg: AggregateResult, reps: Rep[]): string[] {
  const lines: string[] = [];
  for (const m of Object.values(agg.rep_metrics)) {
    const name = resolveRepName(m.rep_id, reps);
    if (m.sales_value === 0) lines.push(`- ${name}: zero sales`);
    if (m.stock_issue) lines.push(`- ${name}: stock issue reported`);
  }
  return lines;
}

function buildSummaryMessage(ctx: ExecutionContext): string {
  const config = getConfig(ctx);
  const reps = config?.reps ?? [];
  const agg = runAggregation(ctx);
  const missingIds = runMissingCompute(ctx);

  const totalReps = reps.filter((r) => r.active).length;
  const reportsReceived = Object.keys(agg.rep_metrics).length;
  const missingNames = missingIds.map((id) => resolveRepName(id, reps)).join(', ') || 'none';
  const topNames = topPerformerIds(agg).map((id) => resolveRepName(id, reps)).join(', ') || 'none';
  const exceptions = exceptionLines(agg, reps);

  return templates.managerSummary(
    config?.date ?? 'unknown date',
    config?.manager_id ?? 'unknown',
    totalReps,
    reportsReceived,
    missingNames,
    agg.total_sales,
    agg.total_orders,
    agg.total_calls,
    topNames,
    exceptions.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// daily-performance-summary flow
//
// Step execution map:
//
//   read-reports  → always; loads today's normalized reports from storage
//   send-summary  → always; input() runs phases 2-4 (aggregate, missing, format)
// ---------------------------------------------------------------------------

export const dailyPerformanceSummaryFlow: Flow = {
  id: 'daily-performance-summary',
  steps: [

    // -------------------------------------------------------------------------
    // Step 1 — read-reports
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
    // Step 2 — send-summary
    // -------------------------------------------------------------------------
    {
      id: 'send-summary',
      type: 'communication',
      input: (ctx: ExecutionContext) => ({
        to: getConfig(ctx)?.manager_phone ?? '',
        message: buildSummaryMessage(ctx),
      }),
    },

  ],
};
