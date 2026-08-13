import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import {
  cleanupOrders,
  createTestProduct,
  createTestUser,
  deleteTestUser,
  getInventoryStock,
  type TestUser,
} from "./helpers/testFixtures";

describe("Part C, scenario 5 / B1 — concurrent stock race", () => {
  let seller: TestUser;
  let customerA: TestUser;
  let customerB: TestUser;
  let productId: string;

  beforeAll(async () => {
    seller = await createTestUser({ role: "SELLER" });
    customerA = await createTestUser({ role: "CUSTOMER" });
    customerB = await createTestUser({ role: "CUSTOMER" });

    productId = await createTestProduct(seller, { stock: 1 });
  }, 30_000);

  afterAll(async () => {
    await cleanupOrders(customerA.id);
    await cleanupOrders(customerB.id);
    await deleteTestUser(seller.id);
    await deleteTestUser(customerA.id);
    await deleteTestUser(customerB.id);
  }, 30_000);

  it("lets exactly one of two simultaneous orders for the last unit succeed", async () => {
    const orderBody = { items: [{ product_id: productId, quantity: 1 }] };

    // Promise.all fires both requests before either resolves — a
    // sequential await here would let the first request's decrement
    // commit before the second even starts, which proves nothing about
    // the atomic UPDATE actually racing under load.
    const [responseA, responseB] = await Promise.all([
      request(app).post("/orders").set("Authorization", `Bearer ${customerA.accessToken}`).send(orderBody),
      request(app).post("/orders").set("Authorization", `Bearer ${customerB.accessToken}`).send(orderBody),
    ]);

    const statuses = [responseA.status, responseB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const rejected = responseA.status === 409 ? responseA : responseB;
    expect(rejected.body.success).toBe(false);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_STOCK");

    const finalStock = await getInventoryStock(productId);
    expect(finalStock).toBe(0);
  });
});
