import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { requireRole } from "../middleware/role.middleware";
import { createOrder } from "../controllers/order.controller";

export const orderRouter = Router();

orderRouter.post("/orders", authenticateUser, requireRole("CUSTOMER"), createOrder);
