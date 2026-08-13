import { z } from "zod";

const FORBIDDEN_PRICING_KEYS = ["price", "unit_price", "total"] as const;

const orderItemSchema = z
  .object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive(),
  })
  // passthrough (not .strict()) so the check below can single out pricing
  // fields with an intent-revealing message instead of a generic
  // "unrecognized key" error.
  .passthrough()
  .superRefine((item, ctx) => {
    const present = FORBIDDEN_PRICING_KEYS.filter((key) => key in item);
    if (present.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Client-side pricing not allowed",
        path: present,
      });
    }
  })
  // Drop anything beyond product_id/quantity so no stray field — pricing
  // or otherwise — ever reaches the order-creation RPC.
  .transform(({ product_id, quantity }) => ({ product_id, quantity }));

export const createOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1, "Order must contain at least one item"),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
