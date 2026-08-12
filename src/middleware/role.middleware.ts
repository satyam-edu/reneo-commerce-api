import { NextFunction, Request, Response } from "express";
import { AppError } from "./errorHandler";
import type { UserRole } from "../types/express";

export function requireRole(...allowedRoles: UserRole[]) {
  return function roleGuard(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) {
      return next(new AppError(401, "UNAUTHENTICATED", "Authentication required"));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError(403, "FORBIDDEN", "You do not have permission to perform this action"));
    }

    next();
  };
}
