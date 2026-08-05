import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, InputNumber, message, Typography, Alert } from "antd";
import type { ColumnsType } from "antd/es/table";
import { EditOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { DocCounter } from "../types";

const DOC_TYPE_LABELS: Record<string, string> = {
  quotation: "Quotation",
  proforma_invoice: "Proforma Invoice",
  delivery_challan: "Delivery Challan",
  tax_invoice: "Tax Invoice",
  receipt: "Receipt",
  expense: "Expense",
  vendor_payment: "Vendor Payment",
};

export function DocumentNumberingPage() {
  const { user } = useAuth();
  const [counters, setCounters] = useState<DocCounter[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DocCounter | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canEdit = user?.role === "super_admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: DocCounter[] }>("/doc-counters");
      setCounters(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load document numbering");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openEdit(record: DocCounter) {
    setEditing(record);
    form.setFieldsValue({ last_number: record.last_number });
  }

  async function handleSubmit() {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.put("/doc-counters", {
        doc_type: editing.doc_type,
        company_code: editing.company_code,
        financial_year: editing.financial_year,
        last_number: values.last_number,
      });
      message.success("Counter updated");
      setEditing(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update counter");
    } finally {
      setSaving(false);
    }
  }

  const columns: ColumnsType<DocCounter> = [
    { title: "Company", dataIndex: "company_name", key: "company_name", render: (v, r) => v || r.company_code },
    {
      title: "Document Type",
      dataIndex: "doc_type",
      key: "doc_type",
      render: (v: string) => DOC_TYPE_LABELS[v] || v,
    },
    { title: "Financial Year", dataIndex: "financial_year", key: "financial_year" },
    { title: "Last Number Used", dataIndex: "last_number", key: "last_number" },
    { title: "Next Number", key: "next_number", render: (_, r) => r.last_number + 1 },
    ...(canEdit
      ? [
          {
            title: "Actions",
            key: "actions",
            width: 80,
            render: (_: unknown, record: DocCounter) => (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <Typography.Title level={4}>Document Numbering</Typography.Title>
      <Typography.Text type="secondary">
        The next sequence number for each document series (per company, per financial year). These are assigned
        automatically and atomically when a document is created - this page is a read-only view for everyone, and a
        break-glass correction tool for Super Admins only.
      </Typography.Text>

      {canEdit && (
        <Alert
          style={{ marginTop: 12, marginBottom: 12 }}
          type="warning"
          showIcon
          message="Editing a counter directly can cause duplicate or skipped document numbers if done carelessly. Only change this to correct a known issue (e.g. after removing test data)."
        />
      )}

      <Table
        rowKey={(r) => `${r.doc_type}-${r.company_code}-${r.financial_year}`}
        columns={columns}
        dataSource={counters}
        loading={loading}
        size="small"
        pagination={false}
        style={{ marginTop: 12 }}
      />

      <Modal
        title={`Edit Counter${editing ? ` - ${DOC_TYPE_LABELS[editing.doc_type] || editing.doc_type}` : ""}`}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        {editing && (
          <>
            <Typography.Paragraph>
              {editing.company_name || editing.company_code} - {DOC_TYPE_LABELS[editing.doc_type] || editing.doc_type} -
              FY {editing.financial_year}
            </Typography.Paragraph>
            <Form form={form} layout="vertical" size="middle">
              <Form.Item
                name="last_number"
                label="Last Number Used"
                rules={[{ required: true, message: "Required" }]}
                extra="The next document created in this series will use this number + 1."
              >
                <InputNumber style={{ width: "100%" }} min={0} />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>
    </div>
  );
}
