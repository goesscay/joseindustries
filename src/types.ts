export type Role = "super_admin" | "admin" | "staff";
export type Status = "active" | "inactive";

export interface User {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface JwtPayload {
  sub: number;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
