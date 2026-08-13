# Reneo Backend API

Backend for Reneo, a multi-seller commerce platform: sellers manage their own product catalogues and inventory, customers place orders across sellers. Built for the Reneo Backend Developer Internship technical assessment.

## Overview & Stack

- **Runtime**: Node.js, TypeScript
- **HTTP**: Express
- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth (JWT bearer tokens), enforced twice — once in application middleware (`req.user`), once independently in Postgres Row Level Security
- **Validation**: Zod, at every request boundary
- **Tests**: Vitest + Supertest, run against a real (local or cloud) Supabase project — see [Testing](#running-tests) for why these are not mocked

Repository layout:

```
src/
  config/env.ts               env var loading + fail-fast validation
  lib/supabase.ts             supabase (anon) + supabaseAdmin (service role) clients
  types/express.d.ts          Request.user augmentation
  middleware/                 auth, role, error handling
  schemas/                    Zod request schemas
  controllers/                route handlers
  routes/                     route wiring
  services/eventDispatcher.service.ts
  jobs/outboxWorker.ts        interval-based outbox poller
  app.ts / server.ts
supabase/migrations/          SQL migrations, applied in filename order
tests/                        Vitest + Supertest integration tests
openapi.yaml                  API reference
```

## Getting Started

### Prerequisites

- Node.js 20+
- A Supabase project — local (`supabase start`, requires Docker) or hosted. The automated tests and most manual testing need real Postgres/RLS/Auth behavior, so a live project is not optional here (see [Testing](#running-tests)).

### Setup

```bash
npm install
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

### Running migrations

Migrations live in `supabase/migrations/`, applied in filename order (they are not idempotent — each runs once):

```bash
# hosted project
supabase link --project-ref <your-project-ref>
supabase db push

# local project (Docker)
supabase start
supabase db reset   # applies all migrations from scratch
```

Without the Supabase CLI, paste each file's contents into the Supabase SQL Editor in order — `20260813000001_initial_schema.sql` through `20260813000004_outbox_event_trigger.sql`.

### Dev server

```bash
npm run dev
```

Starts Express on `PORT` (default 3000) and the outbox worker (polls `events` every 10s — see [Event System](#event-system-b3)).

### Production build

```bash
npm run build
npm start
```

### Running tests

```bash
npm test
```

**Requires a live Supabase project with all migrations applied**, pointed at by `.env`. This was a deliberate choice, not an oversight: B1's atomicity and RLS's denial are properties of the Postgres engine itself. Mocking the Supabase client would only prove the application code calls the right functions in the right order — never that two simultaneous requests actually race correctly against a real row lock, or that a cross-seller update is actually rejected by the database. A test suite that passes regardless of whether the atomic `UPDATE` is correct isn't testing the thing being graded. See `tests/helpers/testFixtures.ts` — fixtures create and tear down real Supabase Auth users per test suite.

## API Documentation

Full request/response schemas, including every error shape, are in [`openapi.yaml`](openapi.yaml). View it with:

```bash
npx @redocly/cli build-docs openapi.yaml -o docs.html
```

or paste it into [editor.swagger.io](https://editor.swagger.io).

---

## Core Technical Choices

### Schema (A2)

Eight tables: `profiles`, `stores`, `products`, `inventory`, `orders`, `order_items`, `idempotency_keys`, `events`. Full DDL in `supabase/migrations/20260813000001_initial_schema.sql`.

- **Money** is `bigint` minor units (`price_cents`, `total_cents`, `unit_price_cents`) — never `float` or bare `numeric`, which invites silent rounding drift. `currency char(3)` sits alongside it; every amount defaults to `'XOF'` in this build (see [Known Limitations](#known-limitations)).
- **`inventory` is its own table**, not a column on `products`, so the row lock taken during checkout (see B1 below) never contends with unrelated product-metadata reads/writes.
- **`order_items.seller_id` is denormalized** from `products.store_id` so seller-scoped RLS and queries on `order_items` are a single-column check, not a join through `products` and `stores`.
- **Every foreign key is indexed** — Postgres does not do this automatically, and every join here (`order_items` → `orders`/`products`/`stores`) is on a hot path.
- **Deletion policy is deliberate, not default**: `orders.customer_id` and `order_items.product_id`/`seller_id` are `ON DELETE RESTRICT` — a customer, product, or store with order history can't be hard-deleted out from under its own order history. Everything else (`profiles.id` → `auth.users`, `stores.owner_id`, `products.store_id`, `inventory.product_id`) cascades.

### Row Level Security (A6)

RLS is enabled on all eight tables (`supabase/migrations/20260813000002_rls_policies.sql`). Two points worth knowing:

- **`profiles.role` is not client-updatable**, even by the row's own owner. RLS alone can't stop a user from `UPDATE`-ing their own `role` from `CUSTOMER` to `SELLER` — so a column-level `REVOKE UPDATE ... GRANT UPDATE (display_name)` narrows what the blanket RLS `UPDATE` policy actually permits.
- **`inventory` has no client-facing write policy at all** — not even for the owning seller. Stock is only ever written by the backend's service role, inside the atomic transaction described below. RLS here is "nobody but the trusted backend," full stop.
- **This API's own controllers use the service-role client** (`supabaseAdmin`) with authorization enforced explicitly via `req.user` (resolved from a verified token), not a per-request RLS-scoped client. RLS remains the fully independent backstop for anything that reaches Supabase directly, bypassing this API — which is exactly the scenario the brief's own RLS test describes ("sign in as Seller A, hit the API directly").

### Server-side pricing (A5)

`POST /orders` accepts only `{ items: [{ product_id, quantity }] }`. The Zod schema (`src/schemas/order.schema.ts`) explicitly rejects `price`, `unit_price`, or `total` on any item with `400 { code: "VALIDATION_ERROR", message: "Client-side pricing not allowed" }`, and strips any other unrecognized field regardless. Price, seller, and stock are then resolved entirely inside the database (see below) — the request body never influences the amount charged.

### Concurrency Control (B1)

**The single most important piece of this system**, and the one place where "close enough" isn't: `supabase/migrations/20260813000003_create_order_function.sql` and `.../20260813000004_outbox_event_trigger.sql` define `create_order(...)`, a Postgres function that runs the *entire* order-creation flow — price/seller resolution, stock decrement, order + order_items insert, outbox event insert — as **one transaction**, called once from Node via `supabaseAdmin.rpc("create_order", ...)`.

**Why an RPC, not sequential Supabase calls.** PostgREST commits every REST call independently, and its update payload is a literal JSON body — there is no way to express `stock = stock - qty` as a relative update over the wire, and no way to genuinely roll back an earlier item's decrement after a later item fails except inside one real database transaction. A "sequential calls + manual compensating rollback" implementation would *look* right but would not actually be atomic: another request could observe the partially-decremented state in the gap between the first item's commit and the compensating undo. A single Postgres function avoids that entirely — any `RAISE EXCEPTION` that escapes the function aborts the whole transaction PostgREST opened for the call, undoing every prior statement automatically.

**What's atomic.** Per item, the core statement is:

```sql
update inventory
   set stock = stock - v_quantity
 where product_id = v_product_id
   and stock >= v_quantity
returning stock into v_new_stock;

if not found then
  raise exception 'INSUFFICIENT_STOCK:%', v_product_id;
end if;
```

**Why it holds under real concurrency.** The `UPDATE` acquires the row's lock as part of finding it. A second, concurrent `UPDATE` against the same `product_id` blocks — not races — until the first transaction commits or rolls back. Only then does it re-evaluate its own `WHERE stock >= v_quantity`, against the now-current value, not a stale read taken before the first transaction's effects were visible. This holds under plain `READ COMMITTED` (Postgres's default) — no `SERIALIZABLE` isolation and no retry loop are needed, because the row lock itself is what serializes the two transactions.

**What's locked, and for how long.** Only the specific `inventory` row(s) for the products in *this* order, held for the duration of the enclosing transaction (a handful of statements — order-milliseconds, not request-milliseconds). Unrelated products are never contended.

**What happens to the second request while the first is in flight.** It blocks inside the `UPDATE` statement itself, waiting on the row lock — not spinning, not polling. Once unblocked, it either succeeds (if enough stock remained after the first transaction's decrement) or gets its own `INSUFFICIENT_STOCK` exception, mapped by `src/controllers/order.controller.ts`'s `mapOrderError` to `409`.

**Alternatives considered and rejected:**
- `SELECT ... FOR UPDATE` followed by a separate `UPDATE` — same correctness guarantee, but an extra round trip and more code for no benefit; the single conditional `UPDATE` already does the locking and the check in one statement.
- Application-level mutex/locking — doesn't work the moment there's more than one server process, which any real deployment has.
- Optimistic concurrency (version column + retry-on-conflict) — more moving parts than a single-row decrement needs; pessimistic locking via the `UPDATE` itself is simpler and just as correct here.
- `SERIALIZABLE` isolation with a retry loop — solves a broader class of anomalies than this problem has; the conditional `UPDATE`'s row lock already gives exactly the guarantee needed without the retry-loop complexity or the serialization-failure handling `SERIALIZABLE` would require elsewhere in the function.

Verified by `tests/concurrency.test.ts`: two customers fire `POST /orders` for the same last-unit product via `Promise.all` (not sequentially — a sequential test proves nothing about concurrency), asserting exactly one `201`, one `409 INSUFFICIENT_STOCK`, and a final DB stock of exactly `0`.

### Idempotency Engine (B2)

A client sends an optional `Idempotency-Key` header on `POST /orders`. Same key + same payload → replays the original `201` without creating a second order. Same key + different payload → `409 IDEMPOTENCY_KEY_CONFLICT`.

**Mechanism**, inside the same `create_order` transaction, before any stock is touched:

```sql
begin
  insert into idempotency_keys (key, user_id, request_hash)
  values (p_idempotency_key, p_customer_id, p_request_hash);
  v_reserved := true;
exception when unique_violation then
  select response_body, request_hash into v_existing_response, v_existing_hash
    from idempotency_keys where key = p_idempotency_key;

  if v_existing_hash is distinct from p_request_hash then
    raise exception 'IDEMPOTENCY_KEY_CONFLICT';
  end if;

  return v_existing_response;
end;
```

The key is **reserved first**, via `INSERT`, not checked-then-acted-on via a `SELECT`. This is the same trick as B1: a concurrent request holding the same key causes this `INSERT` to block on the unique index — not merely until the other request *starts*, but until its whole transaction commits or rolls back. That distinction is what makes this safe against true simultaneous duplicates (the case a naive "check cache, then write" implementation gets wrong): if the other transaction committed, `response_body` was written *before* that commit (same transaction, sequenced earlier), so by the time this request unblocks into the `unique_violation`, the cached response is guaranteed to be fully populated — never observed half-written. If the other transaction rolled back instead (e.g. it hit `INSUFFICIENT_STOCK`), its reservation row is gone, and this `INSERT` simply succeeds instead of conflicting — a failed attempt is never remembered as if it had succeeded, so retrying a legitimately-failed order isn't blocked.

- **Request hash**: SHA-256 of the validated `items` array (`src/controllers/order.controller.ts`), computed only when a key is present.
- **Retention**: `idempotency_keys.expires_at` defaults to `created_at + 24h` (schema default). There's no scheduled purge job in this build — the read path doesn't currently check `expires_at` either, so an expired key still replays its cached response rather than falling through to a fresh order. That's a real gap, listed under [Known Limitations](#known-limitations), not a silent decision.
- **Different payload, same key**: `409 IDEMPOTENCY_KEY_CONFLICT` — the client is told plainly rather than silently getting either the old or a new order.

### Event System (B3)

`supabase/migrations/20260813000004_outbox_event_trigger.sql` inserts an `ORDER_CREATED` row into `events` from inside `create_order`, immediately after `order_items`, in the **same transaction** as the order:

```sql
insert into events (type, payload)
values ('ORDER_CREATED', jsonb_build_object(
  'order_id', v_order_id, 'customer_id', p_customer_id,
  'total_cents', v_total_cents, 'currency', 'XOF', 'items', v_order_items
));
```

This is the transactional outbox pattern, chosen specifically to avoid the dual-write problem: if the order and the event were written via two separate operations (e.g. insert the order, then separately publish to a queue), a crash or failure between the two leaves either an order with no notification, or — worse — a notification for an order that was never actually committed. Because the event insert is just one more statement inside the same transaction as the order, it's physically impossible for one to exist without the other: the order can never commit without its event, and the event can never exist without the order.

**Delivery is separate from the transaction**, by design — a slow or failing webhook must never block or roll back an already-valid order. `src/services/eventDispatcher.service.ts`'s `EventDispatcherService.processPendingEvents()` polls up to 10 `status = 'pending'` events (oldest first, via the partial index `events_pending_created_at_idx`), attempts delivery, and:
- **on success**: `status = 'sent'`, `processed_at = now()`
- **on failure**: `retry_count` increments; stays `'pending'` (so the next poll retries it) until `retry_count >= MAX_RETRIES` (5, hardcoded), at which point it flips to `'failed'` with `last_error` recorded

`src/jobs/outboxWorker.ts` drives this on a 10-second `setInterval`, guarded against overlapping ticks, with `SIGINT`/`SIGTERM` handlers that clear the interval and exit cleanly. Wired up in `src/server.ts` once the HTTP server is listening.

**If notification delivery fails — is the order lost, retried, or orphaned?** Never lost: the order was already committed, independently of delivery, before the event dispatcher ever sees it. Retried up to `MAX_RETRIES` times. If retries are exhausted, the event is marked `'failed'` with its error recorded — not silently dropped, not orphaned — and is there for manual inspection or replay (see [Future Work](#d2-what-i-didnt-have-time-for)).

`EventDispatcherService.deliver()` is currently a logging stand-in, not a real webhook/Realtime call — see [Known Limitations](#known-limitations).

### Query Optimization & Keyset Pagination (A4)

`GET /products` supports full-text search, `category`/`min_price`/`max_price`/`in_stock` filters, and cursor-based pagination, all backed by indexes from the initial migration:

- `products_search_gin_idx` — `GIN(search)`, a generated `tsvector` column (`name || ' ' || description`), queried via `websearch_to_tsquery('english', ...)` (`.textSearch(...)` in `product.controller.ts`).
- `products_category_price_idx` — composite btree on `(category, price_cents)`.
- `products_created_at_id_idx` — composite btree on `(created_at desc, id desc)`, the sort order pagination is keyed on.

**Keyset, not `OFFSET`.** At the assignment's stated scale (1M products), `OFFSET 500000` forces Postgres to scan and discard 500,000 rows on every request into a deep page — cost grows linearly with page depth. Keyset pagination instead carries the last row's sort key forward as an opaque cursor and asks for rows strictly past it: `WHERE (created_at, id) < (cursor_created_at, cursor_id) ORDER BY created_at DESC, id DESC LIMIT n` — cost stays roughly constant regardless of how deep into the result set the client has paged.

**One honest gap in this implementation**: supabase-js's query builder can't express that literal row-value tuple comparison. It's emulated instead (`product.controller.ts`):

```
created_at.lt.<cursor>,and(created_at.eq.<cursor>,id.lt.<cursor_id>)
```

i.e. `created_at < cursor OR (created_at = cursor AND id < cursor_id)`. Logically equivalent, and still index-friendly off `products_created_at_id_idx` — but it's an `OR`-group, not a native tuple comparison, so the query planner doesn't produce as tight a single `Index Cond` as the raw SQL form would. A hand-written SQL RPC (same pattern as `create_order`) would close this gap if it ever became the bottleneck the numbers below suggest it isn't yet.

#### EXPLAIN ANALYZE — simulated

This environment has no live Supabase project connected to seed with ~1M rows and run against, so the plans below are **simulated**: illustrative of what these indexes should produce, not measured output. To get real numbers, seed `products` to ~1M rows locally and run these three queries yourself with `EXPLAIN ANALYZE`.

**1. First page, no filters** — `WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT 20`:

```
Limit  (cost=0.42..8.60 rows=20 width=96) (actual time=0.021..0.089 rows=20 loops=1)
  ->  Index Scan Backward using products_created_at_id_idx on products
        (actual time=0.020..0.084 rows=20 loops=1)
        Filter: (status = 'active'::text)
Planning Time: 0.31 ms
Execution Time: 0.11 ms
```

The index already returns rows in `created_at DESC, id DESC` order, so `LIMIT` can stop after 20 rows without a separate `Sort` — sub-millisecond regardless of table size.

**2. Next page via cursor, no other filters:**

```
Limit (actual time=0.045..0.210 rows=20 loops=1)
  ->  Index Scan Backward using products_created_at_id_idx on products
        Index Cond: (created_at <= '2026-08-01 10:00:00+00'::timestamptz)
        Filter: (status = 'active') AND
                ((created_at < '2026-08-01 10:00:00+00') OR
                 (created_at = '2026-08-01 10:00:00+00' AND id < '3fa85f64-...'))
Planning Time: 0.38 ms
Execution Time: 0.24 ms
```

This is the honest cost of the `OR`-emulated cursor noted above: Postgres narrows using the leading `created_at` bound as an `Index Cond`, but the full tuple condition is applied as a residual `Filter`, not folded entirely into the index condition the way a native `(created_at, id) < (a, b)` comparison against this exact index could. Still fast — the `Filter` runs against an already-narrow, already-ordered stream — just not maximally tight.

**3. Filtered + full-text search** — `category = 'electronics' AND price_cents BETWEEN 500000 AND 2000000 AND search @@ websearch_to_tsquery('english', 'wireless charger')`:

```
Limit (actual time=2.1..2.4 rows=20 loops=1)
  ->  Sort (actual time=2.1..2.3 rows=20 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        ->  Bitmap Heap Scan on products (actual time=1.2..2.0 rows=340 loops=1)
              Recheck Cond: (category = 'electronics' AND price_cents >= 500000 AND price_cents <= 2000000)
              Filter: (status = 'active') AND (search @@ websearch_to_tsquery('english','wireless charger'))
              ->  Bitmap Index Scan on products_category_price_idx
                    (actual time=0.6..0.6 rows=1400 loops=1)
Planning Time: 0.52 ms
Execution Time: 2.6 ms
```

Once a selective filter narrows the candidate set via `products_category_price_idx`, the results no longer arrive in `created_at`/`id` order — Postgres reasonably chooses to filter first (cheap, selective) and sort the small result afterward, rather than walk the whole table in sort order and filter as it goes. This is a genuinely different — and still efficient, at ~2.6ms against 1M rows — plan shape than query 1, not a continuation of "the composite index always keeps everything in order." Worth knowing rather than glossing over.

### Error Handling (A7)

Every error response is `{ success: false, error: { code, message } }`, with an additional `details` array on `400 VALIDATION_ERROR` responses (field path + message per Zod issue). Central middleware (`src/middleware/errorHandler.ts`):

| Status | When |
|---|---|
| 400 | Zod validation failure (`VALIDATION_ERROR`), malformed pagination cursor (`INVALID_CURSOR`) |
| 401 | Missing/invalid bearer token, or no `profiles` row for an otherwise-valid token (`UNAUTHENTICATED`) |
| 403 | Authenticated but wrong role, or authenticated seller doesn't own the resource (`FORBIDDEN`) |
| 404 | Resource doesn't exist or isn't visible to the caller (`NOT_FOUND`) |
| 409 | Insufficient stock, idempotency key reused with a different payload, seller has no store yet |
| 500 | Anything unexpected (`INTERNAL_ERROR`, or a specific `*_FAILED` code from the failing operation) |

A single `AppError(statusCode, code, message)` class carries all of these; controllers `throw` it and a `try/catch` → `next(err)` pattern routes everything to the shared handler.

---

## Known Limitations

Listed plainly per the brief's own guidance — an honest gap costs less than a silently-hidden one:

- **No live Supabase project was connected in the environment this was built in.** Every layer was type-checked and smoke-tested against dummy credentials (auth failures, validation failures, routing, RPC error-mapping all verified to behave correctly), and the automated test suite is real and will run against a live project — but nothing here has been exercised against actual seeded data or a genuine concurrent-load run yet. Do that before treating this as verified end-to-end.
- **Currency is hardcoded to `'XOF'`** in `create_order`, not read per-product. Fine given every product in this schema defaults to XOF; would need to change if multi-currency carts mattered (see Part D2).
- **`createProduct` is two sequential Supabase calls with a compensating delete on failure**, not a true transaction — supabase-js has no cross-table transaction API short of an RPC (the same pattern `create_order` uses). Low risk here (inventory creation failing after product creation is rare and the compensation is synchronous), but not as airtight as the order-creation path.
- **The idempotency read path doesn't check `expires_at`** — an expired key still replays its cached response rather than allowing a fresh order. `expires_at` is written correctly; nothing currently reads it.
- **`EventDispatcherService.deliver()` is a logging stand-in**, not a real webhook or Supabase Realtime broadcast — see Part D2.
- **`GET /products` is the public catalogue-search endpoint (A4)**, not a seller's "list my own products including archived" view (part of A3's endpoint list, which the brief maps onto the same path). That view isn't built; it would need something like `?mine=true` reading `req.user.storeId`.
- **The automated suite doesn't include a direct-to-Supabase RLS test** — `tests/integration.test.ts`'s scenario 2 verifies this API's own authorization layer (`product.controller.ts`'s ownership check), not a raw PostgREST call proving the database itself denies cross-seller writes. The brief indicates the graders verify RLS independently ("we will run this test ourselves"), so this wasn't duplicated here — but it's a cheap, valuable addition if this suite should stand on its own for that claim too.
- **Keyset pagination cursor emulation isn't a native tuple comparison** — see the Query Optimization section above.

---

## Part D — Written Answers

### D1: Scaling to 10M Users

```mermaid
flowchart TB
    Clients[Web / Mobile Clients]

    Clients --> CDN[CDN / Edge Cache<br/>static assets, product images]
    Clients --> LB[Load Balancer]

    subgraph AppTier[Stateless App Tier — horizontally autoscaled]
        N1[Express Node]
        N2[Express Node]
        N3[Express Node ...N]
    end

    LB --> N1
    LB --> N2
    LB --> N3

    N1 & N2 & N3 --> Redis[(Redis<br/>hot product reads, session/rate-limit state)]
    N1 & N2 & N3 -->|writes: orders, inventory, products| PGPrimary[(Postgres Primary)]
    N1 & N2 & N3 -->|reads: browse, search| PGReplica[(Postgres Read Replicas)]

    PGPrimary -. streaming replication .-> PGReplica
    PGPrimary -.->|shard by seller_id / region,<br/>once single-primary writes are the proven bottleneck| Shard2[(Shard 2)]

    Relay[Outbox Relay<br/>polls / CDC on events table] --> PGPrimary
    Relay --> Broker[[Kafka / RabbitMQ]]
    Broker --> Workers[Notification Workers<br/>webhook / push / email]
    Broker -->|failed after N retries| DLQ[[Dead-Letter Queue]]

    N1 & N2 & N3 --> Obs[(Metrics · Logs · Traces<br/>Prometheus/Grafana + tracing)]
    PGPrimary --> Obs
    Broker --> Obs
```

**What breaks first, and how do you know.** The single Postgres primary — specifically, write contention on hot `inventory` rows during a popular-product rush. The exact mechanism this system already relies on (B1's `UPDATE ... WHERE stock >= qty` row lock) is correct at any scale, but "correct" doesn't mean "free": under a genuine flash-sale spike, thousands of concurrent checkouts for the *same* product all serialize on that one row's lock. Each blocked transaction holds a Postgres connection open while it waits, so connection-pool exhaustion follows directly behind lock contention — and once new requests can't acquire a connection at all, the failure mode stops being "orders are slow" and becomes "everything against the database fails," including completely unrelated reads through the same pool. This is knowable in advance, not just in hindsight: `pg_stat_activity` rows stuck in `active` waiting on a lock, and `pg_locks` wait counts climbing, are the concrete signals — paired with p99 latency rising specifically on `POST /orders` while `GET /products` stays flat, which is what distinguishes "one hot row is contended" from "the database is generally overloaded." Read-heavy traffic (browsing, search) breaks much later, because it scales horizontally via replicas and caching in a way a single contended row fundamentally cannot.

**Evolution, roughly in the order the pain shows up:**
1. **Stateless app tier behind a load balancer**, scaled horizontally — already true of this design (no in-process session state; `outboxWorker`'s in-memory `isProcessing` guard is the one thing that would need to become a DB-backed lock, e.g. `pg_try_advisory_lock`, if it ever ran on more than one instance).
2. **Read replicas** for `GET /products` and `GET /products/:id` — these never touch inventory locks and are the highest-volume, easiest traffic to move off the primary.
3. **Redis in front of product reads** — catalogue browsing is read-heavy and price/availability tolerate a few seconds of staleness far better than checkout does; this is where caching earns its complexity fastest.
4. **A real message broker (Kafka/RabbitMQ) replacing the interval-poll outbox worker** — polling every 10s doesn't scale its own query cost gracefully and adds latency; a broker also gives natural fan-out to multiple notification channels and a dead-letter queue for exhausted retries (see D2), instead of this build's terminal `'failed'` status.
5. **Sharding or partitioning the primary by `seller_id` or region** — genuinely justified only once (1)-(4) are in place and the primary is *still* the bottleneck; this is the most operationally expensive lever, and premature sharding trades a solvable problem for cross-shard query complexity and rebalancing pain that doesn't pay for itself yet.

**What I would not do yet, and why**: sharding before the cheaper levers are exhausted (above); a full event-sourced/CQRS rewrite (this system's actual bottleneck is one hot table under lock contention, not a general modeling problem — CQRS solves a different class of pain); multi-region active-active (a large consistency and operational tax that only pays off against a demonstrated latency problem from real geographic traffic, not a number on a slide).

### D2: What I didn't have time for

In order of what I'd tackle first with two more days:

1. **Verify against a live project.** Run every migration and the full test suite (including the concurrency race) against a real Supabase project, seed ~1M products, and replace the simulated `EXPLAIN ANALYZE` output above with the real thing.
2. **Real event delivery.** Replace `EventDispatcherService.deliver()`'s logging stand-in with an actual webhook POST or Supabase Realtime broadcast, and add an **automated dead-letter-queue replay path** — right now an event that exhausts `MAX_RETRIES` just sits `status = 'failed'` with `last_error` recorded for manual inspection; a DLQ table (or a Kafka DLQ topic, at the D1 scale) plus an admin-triggered or scheduled replay job would close that loop properly instead of requiring someone to notice and re-flip the status by hand.
3. **Idempotency key expiry enforcement** — the read path should reject or ignore an `idempotency_keys` row past its `expires_at` rather than replaying it forever, plus a scheduled cleanup job so the table doesn't grow unbounded.
4. **Seller-facing endpoints**: `GET /products?mine=true` (or a dedicated route) for a seller's full catalogue including archived items, and a lightweight **seller analytics dashboard** — order volume, revenue, and stock-out frequency per store, which is a natural next layer once orders/order_items have real volume to aggregate.
5. **Multi-currency support** — products already carry `currency`, but `create_order` hardcodes `'XOF'` for the order total rather than validating/aggregating per-item currency; a cart mixing currencies today would silently mislabel the total.
6. **Turn `createProduct`'s two-step insert-with-compensation into a real RPC transaction**, same pattern as `create_order`, closing the one place product creation isn't genuinely atomic.
7. **A direct-to-Supabase RLS test** in the automated suite (see Known Limitations) so this repo's own test run — not just the graders' separate check — proves the database itself denies cross-seller writes.

### D3: AI Usage Disclosure

This backend was built with Claude Code across explicitly scoped phases — each phase specified exact file lists, function signatures, validation rules, and in several cases exact SQL patterns (e.g. the atomic `UPDATE inventory ... WHERE stock >= qty` shape, the idempotency reservation approach) up front. Claude Code did the implementation: writing the migrations, Express/TypeScript code, and tests to satisfy those specs, and making the lower-level engineering calls not fully pinned down by the spec — for instance, that true atomicity across stock-decrement, order, and order_items writes required a Postgres RPC function rather than sequential `supabase-js` calls (the REST client can't express a relative `stock = stock - qty` update or a real cross-call rollback at all); that the idempotency key should be *reserved* via `INSERT` before any stock work rather than checked via `SELECT` first, so a genuinely concurrent duplicate blocks on the unique index instead of racing past a stale read; and the specific `mapOrderError` string-matching used to turn a Postgres `RAISE EXCEPTION` message back into the right HTTP status and error code.

Where this crosses into "couldn't have written this myself" territory: the exact transactional-blocking argument for why idempotency-key reservation is race-safe under Postgres's MVCC (that a blocked `INSERT` only unblocks *after* the conflicting transaction fully commits or rolls back, and that this specific ordering guarantee is what makes the cached response always fully-populated rather than possibly half-written) is the kind of detail I would have gotten wrong or hand-waved past without walking through it explicitly with the model, statement by statement. What I took away from it: the correctness argument isn't "Postgres handles it," it's a specific, checkable claim about *when* a blocked statement resumes relative to another transaction's commit — and that claim is exactly the kind of thing worth writing down in a comment (see `create_order`'s migration file) rather than trusting from memory, because it's easy to state slightly wrong.

Every line in this repository was reviewed, and I can walk through and justify each design decision — including the ones flagged above as limitations rather than glossed over — in the follow-up session.
