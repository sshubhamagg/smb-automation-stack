// ============================================================
// Flow 2: compute-metrics
//
// Responsibilities:
//   - Compute row-level financial metrics from enriched data
//   - Metrics: ROAS, CAC, AOV, Contribution Margin
//
// This is a pure computation flow.
// All logic runs in buildInitialContext().
// The flow has no engine steps — runFlow() returns immediately.
//
// Input:  enriched rows (from read-and-normalize handler output)
// Output: ctx.state.data.metrics — MetricRow[]
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { VCEngineConfig, EnrichedRow, MetricRow } from '../src/types';
import { safeDivide, round2 } from '../src/utils';

// ---------------------------------------------------------------------------
// Row-level computation (pure, non-throwing)
// ---------------------------------------------------------------------------

function computeRowMetrics(row: EnrichedRow): MetricRow {
  const roas   = round2(safeDivide(row.revenue, row.spend));
  const cac    = round2(safeDivide(row.spend, row.orders));
  const aov    = round2(safeDivide(row.revenue, row.orders));
  const margin = round2(row.revenue - row.spend - row.cost);
  return { ...row, roas, cac, aov, margin };
}

// ---------------------------------------------------------------------------
// buildInitialContext
// Computes all row metrics synchronously before the flow runs.
// ---------------------------------------------------------------------------

export function buildInitialContext(
  enriched: EnrichedRow[],
  config: VCEngineConfig,
): ExecutionContext {
  const metrics: MetricRow[] = enriched.map(computeRowMetrics);

  return {
    state: {
      config,
      data: {
        enriched,
        metrics,
        aggregates: [],
        alerts: [],
        snapshot: null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Flow — no steps (pure computation already done above)
// ---------------------------------------------------------------------------

export const computeMetricsFlow: Flow = {
  id: 'compute-metrics',
  steps: [],
};
