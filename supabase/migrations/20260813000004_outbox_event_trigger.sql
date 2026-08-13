-- Transactional outbox (Part B3).
--
-- create_order is CREATE OR REPLACE'd here rather than emitting the event
-- via an AFTER INSERT trigger on `orders`: the event payload must include
-- the item array, which only exists once order_items has been inserted —
-- and that insert happens after the orders row itself within create_order.
-- A trigger on `orders` would fire before order_items exists and couldn't
-- see it. Doing the insert directly, after order_items, in the same
-- function keeps it in the same transaction as the order it describes:
-- the event can never exist without the order, and can never be lost if
-- the order commits.

alter table events add column retry_count integer not null default 0;
alter table events add column last_error text;

-- Dispatcher polling query is `WHERE status = 'pending' ORDER BY created_at
-- LIMIT n`; a partial index keeps that cheap regardless of how many
-- already-sent events have piled up in the table.
create index events_pending_created_at_idx on events (created_at) where status = 'pending';

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

  -- Outbox insert: same transaction as the order above.
  insert into events (type, payload)
  values (
    'ORDER_CREATED',
    jsonb_build_object(
      'order_id', v_order_id,
      'customer_id', p_customer_id,
      'total_cents', v_total_cents,
      'currency', 'XOF',
      'items', v_order_items
    )
  );

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
