import { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { AppError } from "../middleware/errorHandler";
import {
  createProductSchema,
  cursorPayloadSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  updateProductSchema,
  type CursorPayload,
} from "../schemas/product.schema";

// This module always writes through the service-role client and enforces
// ownership itself using req.user (resolved from a verified token by
// authenticateUser) — the same tables also carry RLS policies, which are
// the independent, always-on backstop for anything that reaches Supabase
// directly rather than through this API.

const PRODUCT_COLUMNS =
  "id, store_id, name, description, category, price_cents, currency, status, created_at, updated_at";

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    return cursorPayloadSchema.parse(JSON.parse(json));
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Malformed pagination cursor");
  }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { stock, ...fields } = createProductSchema.parse(req.body);
    const storeId = req.user!.storeId;

    if (!storeId) {
      throw new AppError(409, "NO_STORE", "You must create a store before adding products");
    }

    const { data: product, error: productError } = await supabaseAdmin
      .from("products")
      .insert({ ...fields, store_id: storeId })
      .select(PRODUCT_COLUMNS)
      .single();

    if (productError || !product) {
      throw new AppError(500, "PRODUCT_CREATE_FAILED", productError?.message ?? "Failed to create product");
    }

    const { error: inventoryError } = await supabaseAdmin
      .from("inventory")
      .insert({ product_id: product.id, stock });

    if (inventoryError) {
      // No cross-table transaction via supabase-js: undo the product row
      // rather than leave a product with no inventory record.
      await supabaseAdmin.from("products").delete().eq("id", product.id);
      throw new AppError(500, "PRODUCT_CREATE_FAILED", inventoryError.message);
    }

    res.status(201).json({ success: true, data: { ...product, stock } });
  } catch (err) {
    next(err);
  }
}

export async function getProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const query = listProductsQuerySchema.parse(req.query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    let builder = supabaseAdmin
      .from("products")
      .select(`${PRODUCT_COLUMNS}, inventory!inner(stock)`)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(query.limit);

    if (query.search) {
      builder = builder.textSearch("search", query.search, { type: "websearch", config: "english" });
    }

    if (query.category) {
      builder = builder.eq("category", query.category);
    }

    if (query.min_price !== undefined) {
      builder = builder.gte("price_cents", query.min_price);
    }

    if (query.max_price !== undefined) {
      builder = builder.lte("price_cents", query.max_price);
    }

    if (query.in_stock !== undefined) {
      builder = query.in_stock ? builder.gt("inventory.stock", 0) : builder.eq("inventory.stock", 0);
    }

    if (cursor) {
      // Emulates the tuple comparison (created_at, id) < (cursor_date, cursor_id),
      // which the supabase-js query builder can't express directly.
      builder = builder.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await builder;

    if (error) {
      throw new AppError(500, "PRODUCT_LIST_FAILED", error.message);
    }

    const products = data ?? [];
    const last = products[products.length - 1];
    const nextCursor =
      products.length === query.limit && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null;

    res.status(200).json({
      success: true,
      data: products,
      pagination: { limit: query.limit, nextCursor },
    });
  } catch (err) {
    next(err);
  }
}

export async function getProductById(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = productIdParamSchema.parse(req.params);

    const { data: product, error } = await supabaseAdmin
      .from("products")
      .select(`${PRODUCT_COLUMNS}, inventory(stock)`)
      .eq("id", id)
      .eq("status", "active")
      .maybeSingle();

    if (error) {
      throw new AppError(500, "PRODUCT_FETCH_FAILED", error.message);
    }

    if (!product) {
      throw new AppError(404, "NOT_FOUND", "Product not found");
    }

    res.status(200).json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
}

async function loadOwnedProduct(id: string, storeId: string | undefined) {
  const { data: existing, error } = await supabaseAdmin
    .from("products")
    .select("id, store_id")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new AppError(500, "PRODUCT_FETCH_FAILED", error.message);
  }

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "Product not found");
  }

  if (existing.store_id !== storeId) {
    throw new AppError(403, "FORBIDDEN", "You do not own this product");
  }

  return existing;
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = productIdParamSchema.parse(req.params);
    const updates = updateProductSchema.parse(req.body);

    await loadOwnedProduct(id, req.user!.storeId);

    const { data: product, error } = await supabaseAdmin
      .from("products")
      .update(updates)
      .eq("id", id)
      .select(PRODUCT_COLUMNS)
      .single();

    if (error || !product) {
      throw new AppError(500, "PRODUCT_UPDATE_FAILED", error?.message ?? "Failed to update product");
    }

    res.status(200).json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
}

export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = productIdParamSchema.parse(req.params);

    await loadOwnedProduct(id, req.user!.storeId);

    // Archive rather than hard-delete: order_items.product_id is
    // ON DELETE RESTRICT, so a product with order history can't be
    // physically removed anyway — archiving works for every product.
    const { data: product, error } = await supabaseAdmin
      .from("products")
      .update({ status: "archived" })
      .eq("id", id)
      .select(PRODUCT_COLUMNS)
      .single();

    if (error || !product) {
      throw new AppError(500, "PRODUCT_DELETE_FAILED", error?.message ?? "Failed to archive product");
    }

    res.status(200).json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
}
