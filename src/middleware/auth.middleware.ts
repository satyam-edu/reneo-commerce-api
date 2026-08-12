import { NextFunction, Request, Response } from "express";
import { supabase, supabaseAdmin } from "../lib/supabase";
import { AppError } from "./errorHandler";
import type { UserRole } from "../types/express";

const BEARER_PREFIX = "Bearer ";

export async function authenticateUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith(BEARER_PREFIX) ? authHeader.slice(BEARER_PREFIX.length) : null;

    if (!token) {
      throw new AppError(401, "UNAUTHENTICATED", "Missing bearer token");
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      throw new AppError(401, "UNAUTHENTICATED", "Invalid or expired token");
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", authData.user.id)
      .single();

    if (profileError || !profile) {
      throw new AppError(401, "UNAUTHENTICATED", "No profile found for this user");
    }

    const role = profile.role as UserRole;
    let storeId: string | undefined;

    if (role === "SELLER") {
      const { data: store } = await supabaseAdmin
        .from("stores")
        .select("id")
        .eq("owner_id", authData.user.id)
        .single();

      storeId = store?.id;
    }

    req.user = {
      id: authData.user.id,
      email: authData.user.email ?? "",
      role,
      storeId,
    };

    next();
  } catch (err) {
    next(err);
  }
}
