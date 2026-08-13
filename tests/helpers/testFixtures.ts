import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../src/app";
import { supabase, supabaseAdmin } from "../../src/lib/supabase";

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  storeId?: string;
}

interface CreateTestUserOptions {
  role: "SELLER" | "CUSTOMER";
  storeName?: string;
}

const TEST_PASSWORD = "Test-Password-1234!";

export async function createTestUser({ role, storeName }: CreateTestUserOptions): Promise<TestUser> {
  const suffix = randomUUID();
  const email = `test-${suffix}@reneo.test`;

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });

  if (createError || !created.user) {
    throw new Error(`Failed to create test user: ${createError?.message}`);
  }

  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .insert({ id: created.user.id, role, display_name: email });

  if (profileError) {
    throw new Error(`Failed to create test profile: ${profileError.message}`);
  }

  let storeId: string | undefined;

  if (role === "SELLER") {
    const { data: store, error: storeError } = await supabaseAdmin
      .from("stores")
      .insert({ owner_id: created.user.id, name: storeName ?? `Test store ${suffix}`, slug: `test-store-${suffix}` })
      .select("id")
      .single();

    if (storeError || !store) {
      throw new Error(`Failed to create test store: ${storeError?.message}`);
    }

    storeId = store.id;
  }

  const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });

  if (signInError || !signedIn.session) {
    throw new Error(`Failed to sign in test user: ${signInError?.message}`);
  }

  return { id: created.user.id, email, accessToken: signedIn.session.access_token, storeId };
}

export async function deleteTestUser(userId: string): Promise<void> {
  // Cascades through profiles -> stores -> products -> inventory. Must run
  // after cleanupOrders(), since order_items.product_id/seller_id are
  // ON DELETE RESTRICT and would otherwise block the cascade.
  await supabaseAdmin.auth.admin.deleteUser(userId);
}

export async function cleanupOrders(customerId: string): Promise<void> {
  const { data: orders } = await supabaseAdmin.from("orders").select("id").eq("customer_id", customerId);

  const orderIds = (orders ?? []).map((order) => order.id as string);

  if (orderIds.length > 0) {
    // events carries no FK to orders (jsonb payload only), so it isn't
    // cleaned up by any cascade — remove it explicitly.
    await supabaseAdmin.from("events").delete().in("payload->>order_id", orderIds);
  }

  await supabaseAdmin.from("orders").delete().eq("customer_id", customerId);
}

interface CreateTestProductOptions {
  name?: string;
  category?: string;
  price_cents?: number;
  stock?: number;
}

export async function createTestProduct(seller: TestUser, options: CreateTestProductOptions = {}): Promise<string> {
  const response = await request(app)
    .post("/products")
    .set("Authorization", `Bearer ${seller.accessToken}`)
    .send({
      name: options.name ?? `Test product ${randomUUID()}`,
      category: options.category ?? "test-category",
      price_cents: options.price_cents ?? 1000,
      stock: options.stock ?? 10,
    });

  if (response.status !== 201) {
    throw new Error(`Failed to create test product: ${JSON.stringify(response.body)}`);
  }

  return response.body.data.id as string;
}

export async function getInventoryStock(productId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select("stock")
    .eq("product_id", productId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to read inventory for ${productId}: ${error?.message}`);
  }

  return data.stock as number;
}
