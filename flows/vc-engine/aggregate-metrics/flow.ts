// ============================================================
// Flow 3: aggregate-metrics
//
// Responsibilities:
//   - Group MetricRow[] by channel + SKU + date
//   - Compute totals and averages per group
//
// This is a pure computation flow.
// All logic runs in buildInitialContext().
// The flow has no engine steps — runFlow() returns immediately.
//
// Input:  ctx.state.data (enriched + metrics)
// Output: ctx.state.data.aggregates — Aggregate[]
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { VCEngineConfig, EnrichedRow, MetricRow, Aggregate } from '../src/types';
import { safeDivide, round2 } from '../src/utils';

// ---------------------------------------------------------------------------
// Aggregation logic (pure, non-throwing)
// ---------------------------------------------------------------------------

function aggregateMetrics(metrics: MetricRow[]): Aggregate[] {
  // Group rows by "channel|sku|date"
  const groupMap = new Map<string, MetricRow[]>();

  for (const row of metrics) {
    const key = `${row.channel}|${row.sku}|${row.date}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groupMap.set(key, [row]);
    }
  }

  const aggregates: Aggregate[] = [];

  for (const [key, rows] of groupMap) {
    const parts        = key.split('|');
    const channel      = parts[0] ?? '';
    const sku          = parts[1] ?? '';
    const date         = parts[2] ?? '';
    const n            = rows.length;
    const totalRevenue = round2(rows.reduce((s, r) => s + r.revenue, 0));
    const avgRoas      = round2(safeDivide(rows.reduce((s, r) => s + r.roas, 0), n));
    const avgCac       = round2(safeDivide(rows.reduce((s, r) => s + r.cac, 0), n));
    const avgMargin    = round2(safeDivide(rows.reduce((s, r) => s + r.margin, 0), n));

    aggregates.push({ channel, sku, date, totalRevenue, avgRoas, avgCac, avgMargin, rowCount: n });
  }

  return aggregates;
}

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  enriched: EnrichedRow[],
  metrics: MetricRow[],
  config: VCEngineConfig,
): ExecutionContext {
  const aggregates = aggregateMetrics(metrics);

  return {
    state: {
      config,
      data: {
        enriched,
        metrics,
        aggregates,
        alerts: [],
        snapshot: null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Flow — no steps (pure computation already done above)
// ---------------------------------------------------------------------------

export const aggregateMetricsFlow: Flow = {
  id: 'aggregate-metrics',
  steps: [],
};
