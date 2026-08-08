import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { api, ApiError } from "../api/client";
import { AppUser } from "../types";
import { PermissionAction } from "../constants/permissions";

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** True for super_admin/admin always; for staff, checks their granted module permissions (unrestricted = true). */
  can: (moduleKey: string, action: PermissionAction) => boolean;
  /** True for super_admin/admin always, or a staff member unrestricted or explicitly granted this account. */
  canViewAccount: (accountId: number) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: AppUser }>("/auth/me")
      .then((res) => setUser(res.user))
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          console.error(err);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post<{ user: AppUser }>("/auth/login", { email, password });
    setUser(res.user);
  }

  async function logout() {
    await api.post("/auth/logout");
    setUser(null);
  }

  const can = useCallback(
    (moduleKey: string, action: PermissionAction) => {
      if (!user) return false;
      if (user.role === "super_admin" || user.role === "admin") return true;
      // permissions is only ever absent if something upstream failed to load
      // it - fail open the same way "no rows saved yet" does, rather than
      // crashing the whole app for every gated button/route.
      if (!user.permissions || !user.permissions.restricted) return true;
      const access = user.permissions.modules[moduleKey];
      if (!access) return false;
      const field = { view: "can_view", create: "can_create", edit: "can_edit", delete: "can_delete" }[action] as
        | "can_view"
        | "can_create"
        | "can_edit"
        | "can_delete";
      return access[field];
    },
    [user]
  );

  const canViewAccount = useCallback(
    (accountId: number) => {
      if (!user) return false;
      if (user.role === "super_admin" || user.role === "admin") return true;
      if (!user.accountAccess || !user.accountAccess.restricted) return true;
      return user.accountAccess.accountIds.includes(accountId);
    },
    [user]
  );

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, can, canViewAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
