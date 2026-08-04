export type Role = "super_admin" | "admin" | "staff";
export type Status = "active" | "inactive";

export interface AppUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: Status;
  created_at: string;
  updated_at: string;
}
