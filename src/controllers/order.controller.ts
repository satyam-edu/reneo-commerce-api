import { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase";
import { AppError } from "../middleware/errorHandler";
import { createOrderSchema } from "../schemas/order.schema";

function hashPayload(items: unknown): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function mapOrderError(message: string): AppError {
  if (message.startsWith("INSUFFICIENT_STOCK:")) {
    const productId = message.slice("INSUFFICIENT_STOCK:".length);
    return new AppError(409, "INSUFFICIENT_STOCK", `Insufficient stock for product ${productId}`);
  }

  if (message.startsWith("PRODUCT_NOT_FOUND:")) {
    const productId = message.slice("PRODUCT_NOT_FOUND:".length);
    return new AppError(404, "NOT_FOUND", `Product ${productId} not found`);
  }

  if (message === "IDEMPOTENCY_KEY_CONFLICT") {
    return new AppError(409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was reused with a different payload");
  }

  if (message === "EMPTY_ORDER") {
    return new AppError(400, "VALIDATION_ERROR", "Order must contain at least one item");
  }

  return new AppError(500, "ORDER_CREATE_FAILED", message);
}

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { items } = createOrderSchema.parse(req.body);

    const idempotencyKey = req.header("Idempotency-Key")?.trim() || undefined;
    const requestHash = idempotencyKey ? hashPayload(items) : undefined;

    const { data, error } = await supabaseAdmin.rpc("create_order", {
      p_customer_id: req.user!.id,
      p_items: items,
      p_idempotency_key: idempotencyKey ?? null,
      p_request_hash: requestHash ?? null,
    });

    if (error) {
      throw mapOrderError(error.message);
    }

    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
