-- Reneo initial schema: profiles, stores, products, inventory, orders,
-- order_items, idempotency_keys, events.
-- Money is stored as bigint minor units, never float/numeric.

create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('SELLER', 'CUSTOMER')),
  display_name text,
  created_at   timestamptz not null default now()
);

create table stores (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles (id) on delete cascade,
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

create table products (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores (id) on delete cascade,
  name         text not null,
  description  text,
  category     text not null,
  price_cents  bigint not null check (price_cents > 0),
  currency     char(3) not null default 'XOF',
  status       text not null default 'active' check (status in ('active', 'archived')),
  search       tsvector generated always as (
                 to_tsvector('english', name || ' ' || coalesce(description, ''))
               ) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Kept separate from products: the atomic stock decrement in the order
-- transaction locks this row only, so it never contends with product
-- metadata reads/writes.
create table inventory (
  product_id uuid primary key references products (id) on delete cascade,
  stock      integer not null check (stock >= 0)
);

create table orders (
  id              uuid primary key default gen_random_uuid(),
  -- RESTRICT: a customer with order history can't be hard-deleted.
  customer_id     uuid not null references profiles (id) on delete restrict,
  status          text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  total_cents     bigint not null check (total_cents >= 0),
  currency        char(3) not null default 'XOF',
  idempotency_key text unique,
  created_at      timestamptz not null default now()
);

create table order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders (id) on delete cascade,
  -- RESTRICT: a product referenced by past orders can be archived but not deleted.
  product_id        uuid not null references products (id) on delete restrict,
  -- Denormalized from products.store_id so seller-scoped RLS on this table
  -- is a single-column check instead of a join.
  seller_id         uuid not null references stores (id) on delete restrict,
  quantity          integer not null check (quantity > 0),
  unit_price_cents  bigint not null check (unit_price_cents > 0),
  created_at        timestamptz not null default now()
);

create table idempotency_keys (
  key           text primary key,
  user_id       uuid not null references profiles (id) on delete cascade,
  request_hash  text not null,
  response_body jsonb,
  status_code   int,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '24 hours')
);

create table events (
  id           uuid primary key default gen_random_uuid(),
  type         text not null,
  payload      jsonb not null,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);

-- Foreign key indexes (Postgres does not create these automatically).
create index stores_owner_id_idx on stores (owner_id);
create index products_store_id_idx on products (store_id);
create index orders_customer_id_idx on orders (customer_id);
create index order_items_order_id_idx on order_items (order_id);
create index order_items_product_id_idx on order_items (product_id);
create index order_items_seller_id_idx on order_items (seller_id);
create index idempotency_keys_user_id_idx on idempotency_keys (user_id);

-- Full-text search on name + description.
create index products_search_gin_idx on products using gin (search);

-- Category + price range filtering.
create index products_category_price_idx on products (category, price_cents);

-- Keyset pagination (avoids OFFSET's linear scan cost at scale).
create index products_created_at_id_idx on products (created_at desc, id desc);

-- Keep products.updated_at accurate without relying on application code.
create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_set_updated_at
before update on products
for each row
execute function set_updated_at();
