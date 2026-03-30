// ============================================================
// Flow 4: evaluate-rules
//
// Responsibilities:
//   - Apply threshold-based rules to aggregated metrics
//   - Generate Alert[] for each threshold violation:
//       LOW_ROAS       — avgRoas  < thresholds.minRoas
//       HIGH_CAC       — avgCac   > thresholds.maxCac
//       NEGATIVE_MARGIN — avgMargin < 0
//
// This is a pure computation flow.
// All logic runs in buildInitialContext().
// The flow has no engine steps — runFlow() returns immediately.
//
// Input:  ctx.state.data (enriched + metrics + aggregates)
// Output: ctx.state.data.alerts — Alert[]
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { VCEngineConfig, EnrichedRow, MetricRow, Aggregate, Alert } from '../src/types';

// ---------------------------------------------------------------------------
// Rule evaluation (pure, non-throwing)
// ---------------------------------------------------------------------------

function evaluateRules(aggregates: Aggregate[], config: VCEngineConfig): Alert[] {
  const { minRoas, maxCac } = config.thresholds;
  const alerts: Alert[] = [];

  for (const agg of aggregates) {
    // Rule 1: ROAS below minimum threshold → inefficient ad spend
    if (agg.avgRoas < minRoas) {
      alerts.push({
        type: 'LOW_ROAS',
        channel: agg.channel,
        sku: agg.sku,
        date: agg.date,
        value: agg.avgRoas,
        threshold: minRoas,
      });
    }

    // Rule 2: CAC above maximum threshold → high acquisition cost
    if (agg.avgCac > maxCac) {
      alerts.push({
        type: 'HIGH_CAC',
        channel: agg.channel,
        sku: agg.sku,
        date: agg.date,
        value: agg.avgCac,
        threshold: maxCac,
      });
    }

    // Rule 3: Negative margin → loss-making SKU/channel combo
    if (agg.avgMargin < 0) {
      alerts.push({
        type: 'NEGATIVE_MARGIN',
        channel: agg.channel,
        sku: agg.sku,
        date: agg.date,
        value: agg.avgMargin,
        threshold: 0,
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  enriched: EnrichedRow[],
  metrics: MetricRow[],
  aggregates: Aggregate[],
  config: VCEngineConfig,
): ExecutionContext {
  const alerts = evaluateRules(aggregates, config);

  return {
    state: {
      config,
      data: {
        enriched,
        metrics,
        aggregates,
        alerts,
        snapshot: null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Flow — no steps (pure computation already done above)
// ---------------------------------------------------------------------------

export const evaluateRulesFlow: Flow = {
  id: 'evaluate-rules',
  steps: [],
};
