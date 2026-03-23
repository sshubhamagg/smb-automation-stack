// ============================================================
// Flow 1: read-and-normalize
//
// Responsibilities:
//   - Read orders, marketing, costs sheets via storage module
//   - After runFlow(), handler calls normalizeAndJoin() to
//     enrich the raw rows and produce EnrichedRow[]
//
// Steps:
//   1. read-orders      — storage read
//   2. read-marketing   — storage read
//   3. read-costs       — storage read
//
// ctx.state.config is required before calling runFlow().
// Output rows land in ctx.outputs['read-orders' | 'read-marketing' | 'read-costs'].
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { VCEngineConfig, EnrichedRow } from '../src/types';
import { safeNum } from '../src/utils';

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(config: VCEngineConfig): ExecutionContext {
  return {
    state: { config },
  };
}

// ---------------------------------------------------------------------------
// normalizeAndJoin
// Called by handler AFTER runFlow() to turn raw sheet rows into EnrichedRow[].
// Pure function — no I/O, no throws.
// ---------------------------------------------------------------------------

export function normalizeAndJoin(
  ordersRows: Record<string, string>[],
  marketingRows: Record<string, string>[],
  costsRows: Record<string, string>[],
  config: VCEngineConfig,
): EnrichedRow[] {
  const cm = config.columnMap;

  // Build spend lookup: "channel|date" → total spend
  const spendMap = new Map<string, number>();
  for (const row of marketingRows) {
    const channel = row[cm.marketing.channel] ?? '';
    const date    = row[cm.marketing.date]    ?? '';
    const spend   = safeNum(row[cm.marketing.spend]);
    const key     = `${channel}|${date}`;
    spendMap.set(key, (spendMap.get(key) ?? 0) + spend);
  }

  // Build cost lookup: sku → unit cost
  const costMap = new Map<string, number>();
  for (const row of costsRows) {
    const sku  = row[cm.costs.sku]  ?? '';
    const cost = safeNum(row[cm.costs.cost]);
    costMap.set(sku, cost);
  }

  // Map each order row and join spend + cost
  return ordersRows.map((row): EnrichedRow => {
    const date    = row[cm.orders.date]    ?? '';
    const sku     = row[cm.orders.sku]     ?? '';
    const channel = row[cm.orders.channel] ?? '';
    const revenue = safeNum(row[cm.orders.revenue]);
    const orders  = safeNum(row[cm.orders.orders]);
    const spend   = spendMap.get(`${channel}|${date}`) ?? 0;
    const cost    = costMap.get(sku) ?? 0;
    return { date, sku, channel, revenue, orders, spend, cost };
  });
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const readAndNormalizeFlow: Flow = {
  id: 'read-and-normalize',
  steps: [
    // Step 1: Read orders sheet
    {
      id: 'read-orders',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: (ctx.state?.config as VCEngineConfig).ordersSheetId,
        options: { range: 'Orders' },
      }),
    },

    // Step 2: Read marketing sheet
    {
      id: 'read-marketing',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: (ctx.state?.config as VCEngineConfig).marketingSheetId,
        options: { range: 'Marketing' },
      }),
    },

    // Step 3: Read costs sheet
    {
      id: 'read-costs',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: (ctx.state?.config as VCEngineConfig).costsSheetId,
        options: { range: 'Costs' },
      }),
    },
  ],
};
