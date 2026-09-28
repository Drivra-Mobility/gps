# GPS & Fleet Management System: Technical Architecture Blueprint

## Executive Summary
This document provides a purely technical, infrastructure, and data-engineering blueprint to optimize the existing GPS Tracking & Misuse Review system. It focuses on solving query bottlenecks, database load, network egress, and ingestion scalability without changing product scope.

---

## 1. System Architecture: Current vs Target

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CURRENT ARCHITECTURE (PoC)                         │
└─────────────────────────────────────────────────────────────────────────────┘
  [GPS Ingestion] ──(Direct Write)──► [vehicle_positions (Unpartitioned Table)]
                                                    │
  [Browser Dashboard] ──(5-Min Poll)──► [PostgreSQL On-The-Fly RPC Calculations]
                                                    │
                                         💥 High CPU & 57014 Timeouts

───────────────────────────────────────────────────────────────────────────────

┌─────────────────────────────────────────────────────────────────────────────┐
│                     PROPOSED TECHNICAL ARCHITECTURE                         │
└─────────────────────────────────────────────────────────────────────────────┘
  [GPS Telematics] ──► [Queue Buffer (Redis/SQS)] ──(Batch Insert)──► [Partitioned DB]
                                                                            │
  ┌─────────────────────────────────────────────────────────────────────────┴──┐
  │                           POSTGRESQL DATA LAYER                            │
  │  • Monthly Partitioning (PARTITION BY RANGE)                               │
  │  • BRIN Indexing on timestamps (100x smaller memory footprint)             │
  │  • Nightly Rollup Worker (pg_cron) generating pre-aggregated summaries     │
  └─────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                         CACHING & READ LAYER                               │
  │  • Redis / HTTP Edge Cache (Immutable historical days cached forever)      │
  │  • Server-Sent Events (SSE) / Push for live map updates                    │
  └─────────────────────────────────────┬──────────────────────────────────────┘
                                        │
                                        ▼
                               [Frontend Dashboard]
                             (Sub-50ms instant load)
```

---

## 2. Core Architectural Pillars

### Pillar 1: Database Optimization & Time-Series Partitioning
1. **Range Partitioning by Month:**
   - Partition `vehicle_positions` by month (`PARTITION BY RANGE (polled_at)`).
   - Queries filtering by date will prune unused partitions instantly, skipping historical data at the storage engine level.

2. **Index Optimization (BRIN vs B-Tree):**
   - Replace generic B-Tree indexes on `polled_at` with **BRIN (Block Range Index)**:
     ```sql
     CREATE INDEX idx_positions_brin_polled_at ON vehicle_positions USING BRIN (polled_at);
     ```
   - For append-only time-series data, BRIN takes ~1% of the RAM of a standard B-Tree index while offering fast block-level range lookups.
   - Use a composite index for single-vehicle drilldowns:
     ```sql
     CREATE INDEX idx_positions_imei_polled ON vehicle_positions (imei_no, polled_at DESC);
     ```

3. **Pre-Aggregated Daily Rollup Tables:**
   - Pre-compute historical days into summary tables (`daily_vehicle_summary`, `daily_misuse_summary`).
   - Closed days (e.g. yesterday) are computed once at midnight and never queried raw again.

---

### Pillar 2: Ingestion Pipeline & Queue Buffering
1. **The Issue:** Direct API-to-database writes cause connection pool exhaustion and lock contention during analytical queries.
2. **The Fix:**
   - Introduce an ingestion queue/buffer (e.g. Redis Streams, BullMQ, or SQS).
   - Ingestion workers drain the queue and execute **batched multi-row inserts** (e.g., 200–500 rows per transaction) instead of unbuffered single-row insertions.
   - Reduces database write IOPS by over 70%.

---

### Pillar 3: Caching & Edge Delivery
1. **Immutable Historical Caching:**
   - Historical dates (any date prior to today) never change.
   - Set caching headers on historical summary requests:
     ```http
     Cache-Control: public, max-age=31536000, immutable
     ```
   - Subsequent requests for the same date range are served from memory/CDN in **< 5ms** with zero database queries.

2. **Live Data Caching:**
   - Cache latest fleet state (`vehicle_latest`) in Redis with a 30-second TTL to handle concurrent dashboard viewers without database hits.

---

### Pillar 4: Read/Write Workload Separation (CQRS)
1. Separate live ingestion writes from analytical reads.
2. Prevent heavy multi-day aggregation queries from starving CPU and I/O bandwidth needed for real-time GPS telemetry updates.

---

### Pillar 5: Real-Time Transport (SSE / WebSockets vs Polling)
1. Replace 5-minute client-side HTTP polling with **Server-Sent Events (SSE)** or **WebSocket push**.
2. When a GPS tracker reports a new position, push only the 40-byte delta `{ imei, lat, lon, speed, state }` to active browser clients.
3. Eliminates unnecessary full-table scans on recurring poll cycles.

---

## 3. Architecture Comparison Matrix

| Architectural Layer | Current State | Proposed Target State |
| :--- | :--- | :--- |
| **Table Structure** | Single unpartitioned table | **Monthly partitioned time-series table** |
| **Indexing Strategy** | Standard B-Trees | **BRIN on time-series + Targeted composite B-Trees** |
| **Computation Model** | Dynamic on-the-fly SQL RPC on raw points | **Nightly pre-aggregated rollups + Delta for today** |
| **Ingestion Pipeline** | Direct unbuffered Lambda writes | **Queue-buffered batch ingestion** |
| **Caching Layer** | No caching (every request hits DB) | **Edge / Redis caching on immutable historical dates** |
| **Client Transport** | Periodic 5-minute HTTP pull | **Server-Sent Events (SSE) / Push stream** |
| **Query Latency** | 8,000 ms – 15,000 ms (Timeout risk) | **15 ms – 40 ms** |

---

## 4. Implementation Priority Matrix

```
[High Impact / Low Effort]                     [High Impact / High Effort]
  • Pre-aggregated Rollup Tables                 • Monthly Table Partitioning
  • Edge Caching for Historical Dates            • Queue-Buffered Ingestion Pipeline
──────────────────────────────────────────────────────────────────────────────────
[Low Impact / Low Effort]                      [Low Impact / High Effort]
  • BRIN Index Migration                         • Full WebSocket Push Infrastructure
```
