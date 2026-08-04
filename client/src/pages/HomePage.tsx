import { Card, Typography } from "antd";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABELS } from "../utils/roles";

export function HomePage() {
  const { user } = useAuth();

  return (
    <Card>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Welcome, {user?.name}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Signed in as {user ? ROLE_LABELS[user.role] : ""}.
      </Typography.Paragraph>
    </Card>
  );
}
