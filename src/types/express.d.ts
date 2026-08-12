export type UserRole = "SELLER" | "CUSTOMER";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
        storeId?: string;
      };
    }
  }
}
