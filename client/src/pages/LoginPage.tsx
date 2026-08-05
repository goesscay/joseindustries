import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Form, Input, Button, Typography, Alert, Divider } from "antd";
import { MailOutlined, LockOutlined } from "@ant-design/icons";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../api/client";
import { FurnitureIllustration } from "../components/FurnitureIllustration";
import logoWhite from "../assets/logo-white.png";
import logoBlack from "../assets/logo-black.png";

const STATS = [
  { value: "38+", label: "Years" },
  { value: "5,000+", label: "Products" },
  { value: "500+", label: "Clients" },
];

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
    <div className="login-page">
      {/* Left: brand / pictorial panel */}
      <div
        className="login-visual"
        style={{
          position: "relative",
          overflow: "hidden",
          background: "linear-gradient(155deg, #0d3d28 0%, #146339 45%, #16A34A 100%)",
          color: "#ffffff",
        }}
      >
        {/* Decorative circle bleed, echoing the company's own brand collateral */}
        <div
          style={{
            position: "absolute",
            right: -160,
            bottom: -160,
            width: 420,
            height: 420,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.06)",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: -80,
            bottom: -80,
            width: 260,
            height: 260,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.05)",
          }}
        />

        <div
          style={{
            position: "relative",
            zIndex: 1,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: "48px 56px",
            boxSizing: "border-box",
          }}
        >
          <img src={logoWhite} alt="Jose Industries" style={{ height: 34, alignSelf: "flex-start" }} />

          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
            <div style={{ width: "100%", maxWidth: 340, aspectRatio: "1 / 1" }}>
              <FurnitureIllustration />
            </div>
          </div>

          <div>
            <Typography.Title level={2} style={{ color: "#ffffff", marginBottom: 8, fontWeight: 700 }}>
              Crafting Furniture Excellence Since 1986
            </Typography.Title>
            <Typography.Paragraph style={{ color: "rgba(255,255,255,0.82)", fontSize: 15, maxWidth: 420 }}>
              Chennai's trusted manufacturer of premium office, home &amp; institutional furniture —
              factory-direct, ISO 9001:2015 certified.
            </Typography.Paragraph>
            <div style={{ display: "flex", gap: 28, marginTop: 20 }}>
              {STATS.map((stat, i) => (
                <div key={stat.label} style={{ display: "flex", alignItems: "center", gap: 28 }}>
                  {i > 0 && <div style={{ width: 1, height: 30, background: "rgba(255,255,255,0.25)" }} />}
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{stat.value}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>{stat.label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right: login form panel */}
      <div className="login-form-panel">
        <div style={{ width: "100%", maxWidth: 380 }}>
          <img src={logoBlack} alt="Jose Industries" style={{ height: 32, marginBottom: 32 }} />

          <Typography.Title level={3} style={{ marginBottom: 4, fontWeight: 700 }}>
            Welcome back
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 28 }}>
            Sign in to manage quotations, invoices, and more.
          </Typography.Paragraph>

          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 20 }} />}

          <Form layout="vertical" onFinish={handleFinish} disabled={submitting} requiredMark={false}>
            <Form.Item label="Email" name="email" rules={[{ required: true, message: "Email is required" }]}>
              <Input prefix={<MailOutlined style={{ color: "#bbb" }} />} placeholder="you@company.com" size="large" autoFocus />
            </Form.Item>
            <Form.Item label="Password" name="password" rules={[{ required: true, message: "Password is required" }]}>
              <Input.Password prefix={<LockOutlined style={{ color: "#bbb" }} />} placeholder="••••••••" size="large" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
              <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
                Sign in
              </Button>
            </Form.Item>
          </Form>

          <Divider style={{ margin: "32px 0 16px" }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            © {new Date().getFullYear()} Jose Industries. All rights reserved.
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}
