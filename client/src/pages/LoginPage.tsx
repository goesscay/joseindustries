import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Form, Input, Button, Card, Typography, Alert } from "antd";
import { MailOutlined, LockOutlined } from "@ant-design/icons";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";
import logo from "../assets/logo-black.png";

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  async function handleFinish(values: { email: string; password: string }) {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.email, values.password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f7f6",
        padding: 16,
      }}
    >
      <Card style={{ width: "100%", maxWidth: 380 }} styles={{ body: { padding: 28 } }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <img src={logo} alt="Jose Industries" style={{ height: 40 }} />
        </div>
        <Typography.Title level={5} style={{ textAlign: "center", marginBottom: 20 }}>
          Sign in to your account
        </Typography.Title>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={handleFinish} disabled={submitting}>
          <Form.Item
            name="email"
            rules={[{ required: true, message: "Email is required" }]}
          >
            <Input prefix={<MailOutlined />} placeholder="Email" size="middle" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: "Password is required" }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="Password" size="middle" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              Sign in
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
