import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env";

// Stateless server usage: no client-side session to persist or refresh.
const clientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
};

// Anon-key client: subject to RLS, used for verifying user tokens.
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, clientOptions);

// Service-role client: bypasses RLS, used only for server-authoritative
// actions (auth lookups, stock decrements, order/event writes).
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, clientOptions);
