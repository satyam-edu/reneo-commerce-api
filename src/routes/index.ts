import { Router } from "express";
import { healthRouter } from "./health.routes";
import { productRouter } from "./product.routes";

export const router = Router();

router.use(healthRouter);
router.use(productRouter);
