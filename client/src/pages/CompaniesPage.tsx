import { useEffect, useState } from "react";
import { Card, Descriptions, Button, Modal, Form, Input, message, Row, Col, Typography } from "antd";
import { EditOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company } from "../types";

export function CompaniesPage() {
  const { user } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canEdit = user?.role === "super_admin" || user?.role === "admin";

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: Company[] }>("/companies");
      setCompanies(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load companies");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openEdit(company: Company) {
    setEditing(company);
    form.setFieldsValue(company);
  }

  async function handleSubmit() {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      // Merge onto the full record (not just this form's fields) so fields
      // this form doesn't render - like terms_and_conditions, managed on
      // its own Settings page - aren't wiped out by this save.
      await api.put(`/companies/${editing.id}`, { ...editing, ...values });
      message.success("Company updated");
      setEditing(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update company");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Companies
      </Typography.Title>
      <Row gutter={[16, 16]}>
        {companies.map((company) => (
          <Col xs={24} md={12} key={company.id}>
            <Card
              loading={loading}
              title={company.name}
              extra={
                canEdit && (
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(company)}>
                    Edit
                  </Button>
                )
              }
            >
              <Descriptions column={1} size="small">
                <Descriptions.Item label="Code">{company.code}</Descriptions.Item>
                <Descriptions.Item label="Address">{company.address || "-"}</Descriptions.Item>
                <Descriptions.Item label="Phone">{company.phone || "-"}</Descriptions.Item>
                <Descriptions.Item label="GSTIN">{company.gstin || "-"}</Descriptions.Item>
                <Descriptions.Item label="State">
                  {company.state || "-"} {company.state_code ? `(${company.state_code})` : ""}
                </Descriptions.Item>
                <Descriptions.Item label="Bank">{company.bank_name || "-"}</Descriptions.Item>
                <Descriptions.Item label="A/c No">{company.bank_account_no || "-"}</Descriptions.Item>
                <Descriptions.Item label="IFSC">{company.bank_ifsc || "-"}</Descriptions.Item>
              </Descriptions>
            </Card>
          </Col>
        ))}
      </Row>

      <Modal
        title={`Edit ${editing?.name ?? ""}`}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={600}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="tagline" label="Tagline">
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="phone" label="Phone">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label="Email">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="gstin" label="GSTIN">
                <Input />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="state" label="State">
                <Input />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="state_code" label="Code">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="bank_name" label="Bank Name">
                <Input />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="bank_account_no" label="Account No">
                <Input />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="bank_ifsc" label="IFSC">
                <Input />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
