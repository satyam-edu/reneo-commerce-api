-- Row Level Security for every table. Writes that must reflect
-- server-computed truth (stock decrements, order/order_items/event
-- creation) have no client-facing policy at all — they only happen
-- through the backend's service role, which bypasses RLS by design.

alter table profiles         enable row level security;
alter table stores           enable row level security;
alter table products         enable row level security;
alter table inventory        enable row level security;
alter table orders           enable row level security;
alter table order_items      enable row level security;
alter table idempotency_keys enable row level security;
alter table events           enable row level security;

-- profiles: users read/update only their own row.
create policy "profiles_select_own"
on profiles for select
to authenticated
using (id = (select auth.uid()));

create policy "profiles_update_own"
on profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- role is granted at signup and must not be self-escalated; column-level
-- privilege narrows what the blanket UPDATE grant above actually allows.
revoke update on profiles from authenticated;
grant update (display_name) on profiles to authenticated;

-- stores: storefronts are public read; only the owner can manage their store.
create policy "stores_select_all"
on stores for select
to authenticated, anon
using (true);

create policy "stores_insert_own"
on stores for insert
to authenticated
with check (owner_id = (select auth.uid()));

create policy "stores_update_own"
on stores for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy "stores_delete_own"
on stores for delete
to authenticated
using (owner_id = (select auth.uid()));

-- products: anyone can read active listings; only the owning store can
-- write, and the owner can also see their own non-active (archived) stock.
create policy "products_select_active"
on products for select
to authenticated, anon
using (status = 'active');

create policy "products_select_own_store"
on products for select
to authenticated
using (
  store_id in (
    select id from stores where owner_id = (select auth.uid())
  )
);

create policy "products_insert_own_store"
on products for insert
to authenticated
with check (
  store_id in (
    select id from stores where owner_id = (select auth.uid())
  )
);

create policy "products_update_own_store"
on products for update
to authenticated
using (
  store_id in (
    select id from stores where owner_id = (select auth.uid())
  )
)
with check (
  store_id in (
    select id from stores where owner_id = (select auth.uid())
  )
);

create policy "products_delete_own_store"
on products for delete
to authenticated
using (
  store_id in (
    select id from stores where owner_id = (select auth.uid())
  )
);

-- inventory: readable by anyone (active products) and by the owning
-- seller; no insert/update/delete policy at all — writes only via the
-- service role's atomic stock-decrement transaction.
create policy "inventory_select_active_product"
on inventory for select
to authenticated, anon
using (
  exists (
    select 1 from products
    where products.id = inventory.product_id
      and products.status = 'active'
  )
);

create policy "inventory_select_own_store"
on inventory for select
to authenticated
using (
  exists (
    select 1
    from products
    join stores on stores.id = products.store_id
    where products.id = inventory.product_id
      and stores.owner_id = (select auth.uid())
  )
);

-- orders: customers read their own orders. No client-facing insert policy —
-- the server resolves price/stock/seller and writes via the service role.
create policy "orders_select_own"
on orders for select
to authenticated
using (customer_id = (select auth.uid()));

-- order_items: customers read items on their own orders; sellers read
-- (never write) items belonging to their store.
create policy "order_items_select_customer"
on order_items for select
to authenticated
using (
  exists (
    select 1 from orders
    where orders.id = order_items.order_id
      and orders.customer_id = (select auth.uid())
  )
);

create policy "order_items_select_seller"
on order_items for select
to authenticated
using (
  seller_id in (
    select id from stores where owner_id = (select auth.uid())
  )
);

-- idempotency_keys and events are backend-only bookkeeping: RLS is enabled
-- above with zero policies, so only the service role (which bypasses RLS)
-- can read or write them.
