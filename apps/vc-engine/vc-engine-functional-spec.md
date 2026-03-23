# VC Engine — Functional Specification

## 1. Product Overview

### Purpose
VC Engine is a rule-based data computation and decision system that transforms raw Google Sheets data into:
- standardized financial and operational metrics
- actionable alerts
- CEO-level summaries

It eliminates manual spreadsheet calculations and enables consistent decision-making across portfolio companies.

---

## 2. Target Users

- VC Fund Partners (CEO-level view)
- Investment Analysts (detailed metrics)
- Portfolio Ops Teams

---

## 3. Problem Statement

Current state:
- Data lives in multiple sheets
- Metrics computed manually using formulas
- No standardization across companies
- Insights are delayed and inconsistent

Solution:
- Automated metric computation engine
- Standardized outputs
- Real-time alerts

---

## 4. Input Data Model

### Data Sources (Google Sheets)

Each company provides:

#### Orders Sheet
| Date | SKU | Channel | Revenue | Orders |

#### Marketing Sheet
| Date | Channel | Spend |

#### Costs Sheet
| SKU | Cost |

---

## 5. Output Data Model

System generates new sheets:

### 1. METRICS_RAW
Row-level computed metrics

### 2. AGGREGATES
Grouped metrics (channel, SKU, date)

### 3. ALERTS
Triggered rules

### 4. CEO_SNAPSHOT
High-level summary:
- Revenue
- ROAS
- CAC
- Top/worst performers
- Alerts summary

---

## 6. Core Metrics

### Acquisition
- CAC
- ROAS
- Cost per order

### Revenue
- GMV
- Net revenue
- AOV

### Profitability
- Contribution margin
- Net margin

### Efficiency
- LTV/CAC
- Burn rate (if available)

---

## 7. Rule Engine (Decision Layer)

Rules convert metrics → actions.

Examples:

- ROAS < threshold → flag inefficient spend
- CAC > threshold → flag high acquisition cost
- Margin < 0 → flag loss-making SKU

---

## 8. Execution Frequency

- Daily batch execution (MVP)
- Future: hourly / event-driven

---

## 9. Multi-Company Support

- Each company has independent config
- Same system reused across companies

---

## 10. MVP Scope

### Included
- Data normalization
- Metric computation
- Aggregation
- Rule evaluation
- Output generation

### Excluded
- AI insights
- Dashboards
- External integrations

---

## 11. Product Differentiation

- Decision-first system (not dashboard)
- VC-specific metrics
- Standardized across portfolio
- Fully automated

---

## 12. Success Criteria

- Replace manual spreadsheet calculations
- Generate daily CEO snapshot
- Detect performance issues automatically