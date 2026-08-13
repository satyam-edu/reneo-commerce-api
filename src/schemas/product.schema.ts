import { z } from "zod";

const priceCents = z.number().int().positive();

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(1).max(100),
  price_cents: priceCents,
  currency: z.string().length(3).optional(),
  stock: z.number().int().nonnegative(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000),
    category: z.string().trim().min(1).max(100),
    price_cents: priceCents,
    currency: z.string().length(3),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const productIdParamSchema = z.object({
  id: z.string().uuid(),
});

const booleanQueryParam = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true"));

export const listProductsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    search: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    min_price: z.coerce.number().int().nonnegative().optional(),
    max_price: z.coerce.number().int().nonnegative().optional(),
    in_stock: booleanQueryParam,
  })
  .refine(
    (data) =>
      data.min_price === undefined ||
      data.max_price === undefined ||
      data.min_price <= data.max_price,
    { message: "min_price must be less than or equal to max_price", path: ["min_price"] },
  );

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// Decoded shape of the base64url pagination cursor: the last row's sort key.
export const cursorPayloadSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;
