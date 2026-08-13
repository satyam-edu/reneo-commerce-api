import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { cleanupOrders, createTestProduct, createTestUser, deleteTestUser, type TestUser } from "./helpers/testFixtures";

describe("Part C — core scenarios (1-4)", () => {
  let sellerA: TestUser;
  let sellerB: TestUser;
  let customer: TestUser;

  beforeAll(async () => {
    sellerA = await createTestUser({ role: "SELLER" });
    sellerB = await createTestUser({ role: "SELLER" });
    customer = await createTestUser({ role: "CUSTOMER" });
  }, 30_000);

  afterAll(async () => {
    await cleanupOrders(customer.id);
    await deleteTestUser(sellerA.id);
    await deleteTestUser(sellerB.id);
    await deleteTestUser(customer.id);
  }, 30_000);

  it("1. Seller A creates a product — success", async () => {
    const response = await request(app)
      .post("/products")
      .set("Authorization", `Bearer ${sellerA.accessToken}`)
      .send({ name: "Seller A widget", category: "widgets", price_cents: 2500, stock: 5 });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.store_id).toBe(sellerA.storeId);
  });

  it("2. Seller B attempts to modify Seller A's product — denied", async () => {
    const productId = await createTestProduct(sellerA);

    const response = await request(app)
      .patch(`/products/${productId}`)
      .set("Authorization", `Bearer ${sellerB.accessToken}`)
      .send({ name: "Hijacked name" });

    // Our API's own authorization layer (verified here). The database's
    // RLS policies are the independent backstop and are exercised by the
    // brief's own direct-to-Supabase check, not by this HTTP-level test.
    expect([403, 404]).toContain(response.status);
    expect(response.body.success).toBe(false);
  });

  it("3. Customer orders an available product — success", async () => {
    const productId = await createTestProduct(sellerA, { stock: 5 });

    const response = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ items: [{ product_id: productId, quantity: 1 }] });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("confirmed");
  });

  it("4. Customer orders more than available stock — denied", async () => {
    const productId = await createTestProduct(sellerA, { stock: 2 });

    const response = await request(app)
      .post("/orders")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ items: [{ product_id: productId, quantity: 3 }] });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INSUFFICIENT_STOCK");
  });
});
