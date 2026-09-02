import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, Input, Switch, ColorPicker, message, Popconfirm, Typography, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { EditOutlined, UndoOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { DocumentTemplate } from "../types";

const DOC_TYPE_LABELS: Record<string, string> = {
  quotation: "Quotation",
  proforma_invoice: "Proforma Invoice",
  delivery_challan: "Delivery Challan",
  tax_invoice: "Tax Invoice",
  purchase_order: "Purchase Order",
  purchase_bill: "Purchase Bill",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
  receipt: "Receipt",
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function DocumentTemplatesPage() {
  const { can } = useAuth();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState<DocumentTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canEdit = can("settings.document_templates", "edit");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: DocumentTemplate[] }>("/document-templates");
      setTemplates(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load document templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openEdit(record: DocumentTemplate) {
    setEditing(record);
    form.setFieldsValue({
      show_logo: Boolean(record.show_logo),
      show_bank_details: Boolean(record.show_bank_details),
      show_signature_block: Boolean(record.show_signature_block),
      accent_color: record.accent_color || undefined,
      header_label: record.header_label || "",
      footer_note: record.footer_note || "",
    });
  }

  async function handleSubmit() {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      const accentColor =
        typeof values.accent_color === "string" ? values.accent_color : values.accent_color?.toHexString?.();
      await api.put(`/document-templates/${editing.company_id}/${editing.doc_type}`, {
        show_logo: values.show_logo,
        show_bank_details: values.show_bank_details,
        show_signature_block: values.show_signature_block,
        accent_color: accentColor || null,
        header_label: values.header_label || null,
        footer_note: values.footer_note || null,
      });
      message.success("Document template updated");
      setEditing(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update document template");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(record: DocumentTemplate) {
    try {
      await api.post(`/document-templates/${record.company_id}/${record.doc_type}/reset`);
      message.success("Reverted to default");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to reset document template");
    }
  }

  const isCustomized = (record: DocumentTemplate) => record.id !== null;

  const columns: ColumnsType<DocumentTemplate> = [
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    {
      title: "Document Type",
      key: "doc_type",
      render: (_, r) => (
        <Space>
          {DOC_TYPE_LABELS[r.doc_type] || r.doc_type}
          {!r.has_pdf && (
            <Tag title="This document type has no PDF export yet - these settings are saved and ready for when it does">
              PDF not available yet
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: "Accent",
      key: "accent_color",
      width: 70,
      render: (_, r) =>
        r.accent_color ? (
          <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: r.accent_color, border: "1px solid #d9d9d9" }} title={r.accent_color} />
        ) : (
          <Typography.Text type="secondary">default</Typography.Text>
        ),
    },
    { title: "Header Label", dataIndex: "header_label", key: "header_label", render: (v: string | null) => v || <Typography.Text type="secondary">default</Typography.Text> },
    {
      title: "Logo",
      dataIndex: "show_logo",
      key: "show_logo",
      width: 60,
      render: (v: boolean | number) => (v ? "Shown" : "Hidden"),
    },
    {
      title: "Bank Details",
      dataIndex: "show_bank_details",
      key: "show_bank_details",
      width: 90,
      render: (v: boolean | number) => (v ? "Shown" : "Hidden"),
    },
    {
      title: "Signature",
      dataIndex: "show_signature_block",
      key: "show_signature_block",
      width: 80,
      render: (v: boolean | number) => (v ? "Shown" : "Hidden"),
    },
    {
      title: "Status",
      key: "status",
      width: 100,
      render: (_, r) => (isCustomized(r) ? <Tag color="blue">Customized</Tag> : <Tag>Default</Tag>),
    },
    ...(canEdit
      ? [
          {
            title: "Actions",
            key: "actions",
            width: 100,
            render: (_: unknown, record: DocumentTemplate) => (
              <Space size="small">
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} title="Edit" />
                {isCustomized(record) && (
                  <Popconfirm title="Revert to the default look?" onConfirm={() => handleReset(record)}>
                    <Button size="small" icon={<UndoOutlined />} title="Reset to Default" />
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <Typography.Title level={4}>Document Templates</Typography.Title>
      <Typography.Text type="secondary">
        Per-company, per-document-type print settings for every document this app can generate as a PDF (and every
        one it will in future) - logo, accent color, a header label (e.g. "Original for Recipient"), whether the
        bank details / signature blocks print, and the footer note. Leaving a document type untouched here keeps
        its existing, unchanged look.
      </Typography.Text>

      <Table
        rowKey={(r) => `${r.company_id}-${r.doc_type}`}
        columns={columns}
        dataSource={templates}
        loading={loading}
        size="small"
        pagination={false}
        style={{ marginTop: 16 }}
        scroll={{ x: 900 }}
      />

      <Modal
        title={editing ? `Edit Template - ${editing.company_code} / ${DOC_TYPE_LABELS[editing.doc_type] || editing.doc_type}` : ""}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="show_logo" label="Show Company Logo" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="show_bank_details" label="Show Bank / Payment Details" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="show_signature_block" label="Show Signature / Acknowledgement Block" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="accent_color"
            label="Accent Color"
            rules={[{ validator: (_, v) => (!v || typeof v !== "string" || HEX_COLOR.test(v) ? Promise.resolve() : Promise.reject(new Error("Must be a hex color like #1B7A4D"))) }]}
            extra="Leave blank to use this document's built-in color."
          >
            <ColorPicker format="hex" allowClear showText />
          </Form.Item>
          <Form.Item name="header_label" label="Header Label (optional)" extra='e.g. "Original for Recipient", "Duplicate Copy"'>
            <Input placeholder="Leave blank to use the built-in default" />
          </Form.Item>
          <Form.Item name="footer_note" label="Footer Note (optional)">
            <Input placeholder="Leave blank to use the built-in default" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
