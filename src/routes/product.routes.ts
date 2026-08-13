import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import {
  createProduct,
  deleteProduct,
  getProductById,
  getProducts,
  updateProduct,
} from "../controllers/product.controller";

export const productRouter = Router();

// Public catalogue: search/pagination over active listings, no auth required.
productRouter.get("/products", getProducts);
productRouter.get("/products/:id", getProductById);

// Seller-only writes, scoped to the caller's own store in the controller.
productRouter.post("/products", authenticateUser, requireRole("SELLER"), createProduct);
productRouter.patch("/products/:id", authenticateUser, requireRole("SELLER"), updateProduct);
productRouter.delete("/products/:id", authenticateUser, requireRole("SELLER"), deleteProduct);
