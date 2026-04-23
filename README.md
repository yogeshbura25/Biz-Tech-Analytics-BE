# Biz-Tech Analytics — Backend

> Real-time factory floor intelligence: computer-vision events from edge cameras → REST API backend → analytics dashboard.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [API Reference](#api-reference)
3. [Resilience Patterns](#resilience-patterns)
   - [Intermittent Connectivity](#1-intermittent-connectivity)
   - [Duplicate Events](#2-duplicate-events)
   - [Out-of-Order Timestamps](#3-out-of-order-timestamps)
4. [ML Model Lifecycle](#ml-model-lifecycle)
   - [Model Versioning](#1-model-versioning)
   - [Drift Detection](#2-drift-detection)
   - [Triggering Retraining](#3-triggering-retraining)
5. [Scaling Strategy](#scaling-strategy)
6. [Local Development](#local-development)
7. [Running with Docker](#running-with-docker)
8. [Environment Variables](#environment-variables)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  EDGE  (Camera + On-Device Inference)                                   │
│                                                                         │
│   ┌──────────┐   ┌─────────────────────────────────────────────────┐   │
│   │  Camera  │──▶│  Inference Runtime (ONNX / TFLite / OpenVINO)  │   │
│   └──────────┘   │  - Detect: worker_id, event_type, confidence   │   │
│                  │  - Buffer events locally when offline           │   │
│                  └─────────────────────────────────────────────────┘   │
│                                      │  HTTP POST /events               │
└──────────────────────────────────────┼──────────────────────────────────┘
                                       │
                              (LAN / 4G / VPN)
                                       │
┌──────────────────────────────────────▼──────────────────────────────────┐
│  BACKEND  (Node.js + Express + PostgreSQL)          port 8080            │
│                                                                         │
│   POST /events  ──▶  Validate ──▶  Dedup ──▶  INSERT events table      │
│   GET  /metrics ──▶  Query ──▶  calculateMetrics() ──▶  JSON           │
│   GET  /metrics/factory ──▶  Aggregate all cameras ──▶  JSON           │
│   POST /seed    ──▶  Reset seed workers & workstations                 │
│                                                                         │
│   Tables: workers | workstations | events                               │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │  REST / WebSocket
                                       │
┌──────────────────────────────────────▼──────────────────────────────────┐
│  DASHBOARD  (React / Next.js)                                           │
│                                                                         │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐ │
│   │ Worker Cards │  │ Station View │  │ Factory Overview (heatmap)   │ │
│   └──────────────┘  └──────────────┘  └──────────────────────────────┘ │
│     Active/Idle time   Utilisation %    Units per hour · Trend charts   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow (step by step)

| Step | Actor | Action |
|------|-------|--------|
| 1 | Camera | Captures frame at configurable FPS |
| 2 | Edge Runtime | Runs CV model → produces `event_type`, `confidence`, `count` |
| 3 | Edge Agent | HTTP `POST /events` with JSON payload to Backend |
| 4 | Backend | Validates, deduplicates, inserts row into `events` table |
| 5 | Dashboard | Polls `GET /metrics?worker_id=W1` (or factory-wide) |
| 6 | Backend | Runs `calculateMetrics()` over sorted event rows → returns KPIs |
| 7 | Dashboard | Renders real-time charts, utilisation gauges, unit counters |

---

## API Reference

### `POST /events`
Ingest a single CV event from an edge device.

**Request body:**
```json
{
  "timestamp":      "2026-04-23T06:00:00.000Z",
  "worker_id":      "W3",
  "workstation_id": "S3",
  "event_type":     "working",
  "confidence":     0.94,
  "count":          0
}
```

| Field | Type | Notes |
|-------|------|-------|
| `timestamp` | ISO-8601 string | Falls back to `NOW()` if omitted |
| `event_type` | string | `working`, `idle`, `product_count` |
| `confidence` | float 0–1 | Model confidence score |
| `count` | integer | Units produced (only meaningful for `product_count`) |

**Response:** `{ "message": "Event stored" }`

---

### `GET /metrics`
Per-worker or per-station KPIs.

| Query param | Example | Effect |
|-------------|---------|--------|
| `worker_id` | `?worker_id=W1` | Filter by worker |
| `station_id` | `?station_id=S2` | Filter by station |
| _(none)_ | | All events |

**Response:**
```json
{
  "metrics": {
    "active_time":   3600,
    "idle_time":     1200,
    "utilization":   75.0,
    "total_units":   48,
    "units_per_hour": 48.0
  },
  "total_events": 120
}
```

---

### `GET /metrics/factory`
Aggregate KPIs across all workers and stations.

---

### `POST /seed`
Reset and re-seed workers (W1–W6) and workstations (S1–S6). Useful for demo/testing.

---

## Resilience Patterns

### 1. Intermittent Connectivity

Edge devices (cameras) may lose network access in industrial environments. The recommended approach:

**Edge-side (local buffer):**
```
Camera offline
  └── Edge agent writes events to a local SQLite / queue file
        └── On reconnect → replay buffered events to POST /events
              └── Include original timestamp so ordering is preserved
```

**Backend-side (current implementation):**
- `COALESCE($1::TIMESTAMP, NOW())` already accepts an explicit timestamp, so replayed events land with their *original* capture time — not the replay time.
- A retry queue (e.g., `bull` / `pg-boss`) can be added to guarantee at-least-once delivery.

**Recommended addition:**
```js
// Edge agent pseudo-code
const queue = new LocalQueue('./buffer.db');

async function sendEvent(payload) {
  try {
    await axios.post('/events', payload);
  } catch {
    queue.push(payload);           // store locally
  }
}

// background worker: drain on reconnect
setInterval(async () => {
  if (await isOnline()) {
    for (const evt of queue.drain()) await sendEvent(evt);
  }
}, 5000);
```

---

### 2. Duplicate Events

Network retries and at-least-once delivery guarantees mean the same event may arrive more than once.

**Strategy: Idempotency key (content hash or UUID)**

Add a unique `event_id` (UUID v4 generated on the edge) and enforce a `UNIQUE` constraint on the backend:

```sql
-- Schema change
ALTER TABLE events ADD COLUMN event_id UUID UNIQUE;
```

```js
// Backend: upsert instead of insert
await pool.query(`
  INSERT INTO events (event_id, timestamp, worker_id, workstation_id, event_type, confidence, count)
  VALUES ($1, COALESCE($2::TIMESTAMP, NOW()), $3, $4, $5, $6, $7)
  ON CONFLICT (event_id) DO NOTHING
`, [event_id, timestamp, worker_id, workstation_id, event_type, confidence, count]);
```

This makes every `POST /events` call **idempotent** — safe to retry without creating phantom rows.

---

### 3. Out-of-Order Timestamps

Because `calculateMetrics()` computes durations between *consecutive* event rows, out-of-order data yields negative or wildly inflated intervals.

**Current mitigation:** all queries already include `ORDER BY timestamp ASC`, so PostgreSQL sorts before the metric calculation loop.

**Additional hardening:**

```js
const calculateMetrics = (events) => {
  // Sort defensively in application layer too (handles edge replays)
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  for (let i = 1; i < sorted.length; i++) {
    const diff =
      (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 1000;

    // Guard: skip negative or impossibly large gaps (> 1 hour = likely clock drift)
    if (diff < 0 || diff > 3600) continue;

    if (sorted[i - 1].event_type === 'working') totalActive += diff;
    if (sorted[i - 1].event_type === 'idle')    totalIdle   += diff;
  }
};
```

**Clock sync recommendation:** run NTP (`chrony` / `systemd-timesyncd`) on all edge devices to keep clocks within ±1 second of UTC.

---

## ML Model Lifecycle

### 1. Model Versioning

Track which model version produced each event so metrics can be stratified or rolled back:

```sql
ALTER TABLE events ADD COLUMN model_version VARCHAR DEFAULT 'v1.0.0';
```

Edge devices embed the version string in every event payload:
```json
{ "model_version": "v1.2.0", "event_type": "working", ... }
```

**Versioning scheme:** `MAJOR.MINOR.PATCH`

| Increment | When |
|-----------|------|
| PATCH | Retraining on same architecture / same label set |
| MINOR | New event types / label added |
| MAJOR | Architecture change (e.g., MobileNet → YOLOv8) |

Store model artifacts in a registry (e.g., MLflow, DVC, or an S3 bucket) keyed by version. The backend can serve the current active version via a `GET /model/version` endpoint so edge devices self-update.

---

### 2. Detect Model Drift

Drift means the model's outputs no longer reflect reality. Two signals are already in the data:

| Signal | How to measure | Threshold example |
|--------|---------------|-------------------|
| **Confidence drop** | Rolling 7-day average of `confidence` per `model_version` | Alert if avg drops > 10 pp |
| **Event distribution shift** | % of `working` vs `idle` events per hour | Alert if ratio deviates > 2σ from baseline |
| **Production count variance** | Compare `units_per_hour` against historical average | Alert if drops > 20% for 3 consecutive hours |

**Implementation sketch:**
```js
// Scheduled job (runs every hour via node-cron)
const detectDrift = async () => {
  const { rows } = await pool.query(`
    SELECT
      model_version,
      AVG(confidence)                          AS avg_confidence,
      COUNT(*) FILTER (WHERE event_type = 'working') * 100.0 / COUNT(*) AS pct_working
    FROM events
    WHERE timestamp > NOW() - INTERVAL '7 days'
    GROUP BY model_version
  `);

  for (const row of rows) {
    if (row.avg_confidence < CONFIDENCE_THRESHOLD) {
      triggerAlert(`Drift detected on model ${row.model_version}`);
    }
  }
};
```

---

### 3. Trigger Retraining

```
Drift Alert
  └── Collect labelled images from the last N days (stored by edge devices)
        └── Upload to training bucket (S3 / GCS)
              └── Trigger training pipeline (GitHub Actions / Vertex AI / SageMaker)
                    └── Evaluate: if accuracy > current model → promote
                          └── Push new model to edge devices via OTA update
                                └── Edge agent loads new weights, increments model_version
```

**Retraining triggers (in priority order):**

1. **Scheduled** — retrain every 30 days regardless of drift (keeps model fresh)
2. **Drift-triggered** — auto-trigger when drift metric breaches threshold (see above)
3. **Manual** — operator initiates via dashboard `POST /model/retrain`

**Automated pipeline example (GitHub Actions):**
```yaml
on:
  schedule:
    - cron: '0 2 1 * *'   # monthly at 02:00
  workflow_dispatch:       # manual trigger

jobs:
  retrain:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python train.py --data s3://biz-tech/labels/ --epochs 50
      - run: python evaluate.py --threshold 0.85
      - run: python deploy.py --push-to-fleet
```

---

## Scaling Strategy

### 5 Cameras (Current State)

```
5× Edge Devices  ──▶  1× Backend (Node.js, port 8080)  ──▶  1× PostgreSQL
```

- Single `events` table, no partitioning needed
- All queries complete in < 50 ms
- `nodemon` dev server is sufficient

---

### 100+ Cameras (Mid Scale)

```
100× Edge Devices
   └── Load Balancer (nginx / AWS ALB)
         ├── Backend Instance 1
         ├── Backend Instance 2   ──▶  PostgreSQL (primary + read replica)
         └── Backend Instance N         └── Table partitioned BY RANGE (timestamp)
```

**Key changes:**

| Concern | Solution |
|---------|----------|
| Write throughput | Replace direct INSERT with a message queue (Redis Streams / Kafka) to absorb bursts |
| Read latency | Add indexes on `(worker_id, timestamp)` and `(workstation_id, timestamp)` |
| DB size | Partition `events` by month: `PARTITION BY RANGE (timestamp)` |
| Session state | Use stateless JWT or sticky sessions behind the LB |
| Connection pool | Use `pgBouncer` to cap DB connections |

**Recommended indexes (add now, cost is low):**
```sql
CREATE INDEX idx_events_worker_ts   ON events (worker_id,      timestamp ASC);
CREATE INDEX idx_events_station_ts  ON events (workstation_id, timestamp ASC);
CREATE INDEX idx_events_model_ver   ON events (model_version);
```

---

### Multi-Site (Enterprise Scale)

```
Site A (Factory 1)                    Site B (Factory 2)
  100× cameras                          100× cameras
     └── Regional Backend (EU-West)        └── Regional Backend (US-East)
           └── Regional DB                       └── Regional DB
                    │                                     │
                    └──────────┐   ┌─────────────────────┘
                               ▼   ▼
                      Global Aggregation Tier
                        (ClickHouse / BigQuery)
                               │
                        Central Dashboard
                      (cross-site analytics)
```

**Key changes:**

| Concern | Solution |
|---------|----------|
| Data sovereignty | Keep raw events in regional DBs; aggregate anonymised KPIs centrally |
| Event streaming | Apache Kafka with per-site topics replicated to global cluster |
| Schema evolution | Enforce schema registry (Confluent / AWS Glue) for all event payloads |
| Observability | OpenTelemetry → Grafana / Datadog for latency, error rates per site |
| Multi-tenant | Add `site_id` column to `events`; all APIs and dashboards scoped by site |
| Disaster recovery | Cross-region PostgreSQL replication; RTO < 15 min |

**`site_id` addition:**
```sql
ALTER TABLE events ADD COLUMN site_id VARCHAR DEFAULT 'site-1';
CREATE INDEX idx_events_site ON events (site_id, timestamp ASC);
```

---

## Local Development

### Prerequisites

- Node.js ≥ 18
- PostgreSQL ≥ 14 running locally

### Setup

```bash
# Install dependencies
npm install

# Start development server (auto-restarts on file change)
npm run dev
```

Server starts at **http://localhost:8080**

### Quick smoke test

```bash
# Ingest a test event
curl -X POST http://localhost:8080/events \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-04-23T06:00:00.000Z",
    "worker_id": "W1",
    "workstation_id": "S1",
    "event_type": "working",
    "confidence": 0.95,
    "count": 0
  }'

# Fetch metrics for worker W1
curl "http://localhost:8080/metrics?worker_id=W1"

# Factory-wide metrics
curl "http://localhost:8080/metrics/factory"
```

---

## Running with Docker

You can run the entire stack (Node.js + PostgreSQL) using Docker and Docker Compose. This ensures a consistent environment and skips manual database setup.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

### Quick Start

```bash
# Build and start the containers
docker compose up --build -d
```

### Useful Commands

| Action | Command |
|--------|---------|
| View logs | `docker compose logs -f app` |
| View DB logs | `docker compose logs -f db` |
| Stop containers | `docker compose stop` |
| Remove containers & volumes | `docker compose down -v` |
| Seed database | `curl -X POST http://localhost:8080/seed` |

The API remains accessible at **http://localhost:8080**.

---

## Environment Variables

Create a `.env` file (already present, **never commit to git**):

```env
PG_USER=postgres
PG_HOST=localhost
PG_DATABASE=Biz-Tech-Analytics
PG_PASSWORD=your_password
PG_PORT=5432
PORT=8080
```

> **Note:** The current implementation reads DB credentials directly from `index.js`. For production, load them via `dotenv` and reference `process.env.*`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | PostgreSQL 14+ (via `pg` driver) |
| Dev server | nodemon |
| Edge inference | ONNX / TFLite / OpenVINO (model-dependent) |

---

*Biz-Tech Analytics — © 2026*
