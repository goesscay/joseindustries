import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Result } from "antd";
import { useAuth } from "../context/AuthContext";
import { firstAccessibleRoute } from "../constants/routeModules";

export function ModuleGate({ module, children }: { module: string; children: ReactNode }) {
  const { can } = useAuth();
  if (can(module, "view")) return <>{children}</>;

  // Denied - send the user to the first module they *can* view instead of
  // hardcoding "/": if this route is "/" itself (Dashboard denied), a
  // hardcoded "/" fallback would redirect back into this same gate forever.
  const fallback = firstAccessibleRoute(can, window.location.pathname);
  if (fallback) return <Navigate to={fallback} replace />;

  // Nothing granted at all - an admin created a staff account and hasn't
  // configured any module access yet. Nowhere safe to redirect to.
  return (
    <Result
      status="403"
      title="No access yet"
      subTitle="Your account doesn't have access to any modules. Ask an administrator to grant you access under Users & Roles."
    />
  );
}
