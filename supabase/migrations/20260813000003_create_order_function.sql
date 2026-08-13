-- Order creation as a single atomic transaction.
--
-- Why an RPC and not sequential supabase-js calls: PostgREST executes each
-- REST call as its own committed transaction, and its update payload is a
-- literal JSON body — there is no way to express `stock = stock - qty` or
-- to roll back an earlier item's decrement after a later item fails,
-- except inside one real database transaction. A Postgres function called
-- once via `.rpc()` gives us that: every statement below runs in the
-- transaction PostgREST opens for the call, and any RAISE EXCEPTION that
-- escapes the function aborts that whole transaction, undoing every prior
-- decrement/insert automatically. No manual compensation logic needed.
--
-- Locking: the `UPDATE inventory ... WHERE stock >= quantity` per item is
-- what makes two concurrent orders for the same product safe — see the
-- concurrency note further down, and the README for the full writeup.
--
-- Only the backend's service role may call this (see REVOKE/GRANT at the
-- bottom): it trusts p_customer_id as given, so it must never be reachable
-- with an arbitrary customer_id from a client-held JWT.

create or replace function create_order(
  p_customer_id uuid,
  p_items jsonb,
  p_idempotency_key text default null,
  p_request_hash text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_existing_response jsonb;
  v_existing_hash     text;
  v_reserved          boolean := false;
  v_item              jsonb;
  v_product_id        uuid;
  v_quantity          integer;
  v_price_cents       bigint;
  v_seller_id         uuid;
  v_new_stock         integer;
  v_order_id          uuid;
  v_total_cents       bigint := 0;
  v_order_items       jsonb := '[]'::jsonb;
  v_response          jsonb;
begin
  if p_idempotency_key is not null then
    -- Reserve the key first. If a concurrent request holds the same key,
    -- this INSERT blocks on the unique index until that request's
    -- transaction commits or rolls back — not merely until it starts.
    -- If it committed, response_body was written before that commit, so
    -- by the time we unblock and observe the conflict, the cached
    -- response is guaranteed to be fully populated. If it rolled back
    -- (e.g. insufficient stock), its reservation row is gone and this
    -- INSERT simply succeeds instead of conflicting. Either way there is
    -- no window where we'd observe a half-written row.
    begin
      insert into idempotency_keys (key, user_id, request_hash)
      values (p_idempotency_key, p_customer_id, p_request_hash);
      v_reserved := true;
    exception when unique_violation then
      select response_body, request_hash
        into v_existing_response, v_existing_hash
        from idempotency_keys
       where key = p_idempotency_key;

      if v_existing_hash is distinct from p_request_hash then
        raise exception 'IDEMPOTENCY_KEY_CONFLICT';
      end if;

      return v_existing_response;
    end;
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;

    select price_cents, store_id
      into v_price_cents, v_seller_id
      from products
     where id = v_product_id
       and status = 'active';

    if not found then
      raise exception 'PRODUCT_NOT_FOUND:%', v_product_id;
    end if;

    -- The atomic decrement: this single statement is what makes B1 hold.
    -- The UPDATE takes the row lock as part of finding the row, so a
    -- second concurrent UPDATE on the same product_id blocks until this
    -- one commits or rolls back, then re-evaluates `stock >= v_quantity`
    -- against the now-updated value — it cannot race on a stale read.
    update inventory
       set stock = stock - v_quantity
     where product_id = v_product_id
       and stock >= v_quantity
    returning stock into v_new_stock;

    if not found then
      raise exception 'INSUFFICIENT_STOCK:%', v_product_id;
    end if;

    v_total_cents := v_total_cents + (v_price_cents * v_quantity);

    v_order_items := v_order_items || jsonb_build_object(
      'product_id', v_product_id,
      'seller_id', v_seller_id,
      'quantity', v_quantity,
      'unit_price_cents', v_price_cents
    );
  end loop;

  insert into orders (customer_id, status, total_cents, currency, idempotency_key)
  values (p_customer_id, 'confirmed', v_total_cents, 'XOF', p_idempotency_key)
  returning id into v_order_id;

  insert into order_items (order_id, product_id, seller_id, quantity, unit_price_cents)
  select
    v_order_id,
    (elem ->> 'product_id')::uuid,
    (elem ->> 'seller_id')::uuid,
    (elem ->> 'quantity')::integer,
    (elem ->> 'unit_price_cents')::bigint
  from jsonb_array_elements(v_order_items) elem;

  select jsonb_build_object(
    'id', o.id,
    'status', o.status,
    'total_cents', o.total_cents,
    'currency', o.currency,
    'created_at', o.created_at,
    'items', v_order_items
  )
  into v_response
  from orders o
  where o.id = v_order_id;

  if v_reserved then
    update idempotency_keys
       set response_body = v_response,
           status_code = 201
     where key = p_idempotency_key;
  end if;

  return v_response;
end;
$$;

revoke all on function create_order(uuid, jsonb, text, text) from public;
grant execute on function create_order(uuid, jsonb, text, text) to service_role;
