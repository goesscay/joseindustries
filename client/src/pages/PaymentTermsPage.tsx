import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, Input, message, Popconfirm, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { PaymentTerm } from "../types";

export function PaymentTermsPage() {
  const { user } = useAuth();
  const [terms, setTerms] = useState<PaymentTerm[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentTerm | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canDelete = user?.role === "super_admin" || user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: PaymentTerm[] }>("/payment-terms");
      setTerms(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load payment terms");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  }

  function openEdit(record: PaymentTerm) {
    setEditing(record);
    form.setFieldsValue(record);
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/payment-terms/${editing.id}`, values);
        message.success("Payment term updated");
      } else {
        await api.post("/payment-terms", values);
        message.success("Payment term created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save payment term");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: PaymentTerm) {
    try {
      await api.delete(`/payment-terms/${record.id}`);
      message.success("Payment term deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete payment term");
    }
  }

  const columns: ColumnsType<PaymentTerm> = [
    { title: "Label", dataIndex: "label", key: "label" },
    {
      title: "Actions",
      key: "actions",
      width: 110,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          {canDelete && (
            <Popconfirm title="Delete this payment term?" onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Payment Terms
          </Typography.Title>
          <Typography.Text type="secondary">
            Reusable wording for the "Mode/Terms of Payment" field on Quotations, Proforma Invoices, Delivery Challans
            and Tax Invoices.
          </Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Add Term
        </Button>
      </Space>

      <Table rowKey="id" columns={columns} dataSource={terms} loading={loading} size="small" pagination={false} />

      <Modal
        title={editing ? "Edit Payment Term" : "Add Payment Term"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="label" label="Wording" rules={[{ required: true, message: "Wording is required" }]}>
            <Input placeholder="e.g. 50% Advance, Balance in 15 Days" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
