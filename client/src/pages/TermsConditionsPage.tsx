import { useCallback, useEffect, useState } from "react";
import {
  Select,
  Input,
  Button,
  message,
  Typography,
  Space,
  Alert,
  Table,
  Modal,
  Form,
  Switch,
  Tag,
  Popconfirm,
  Divider,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company, TermsTemplate, TermsTemplateDocType } from "../types";

const DEFAULT_TERMS = [
  "Goods once sold will not be taken back unless otherwise agreed in writing.",
  "Payment shall be made according to the agreed payment terms.",
  "Any shortage or damage should be reported immediately upon receipt of goods.",
  "Warranty, where applicable, is governed by the agreed quotation / order terms.",
  "Transportation and installation charges are applicable as agreed.",
  "All disputes are subject to Chennai jurisdiction.",
  "This document is subject to applicable GST laws and regulations.",
].join("\n");

const DOC_TYPE_OPTIONS: { value: TermsTemplateDocType; label: string }[] = [
  { value: "all", label: "All Documents" },
  { value: "quotation", label: "Quotation" },
  { value: "proforma_invoice", label: "Proforma Invoice" },
  { value: "delivery_challan", label: "Delivery Challan" },
  { value: "tax_invoice", label: "Tax Invoice" },
];

const DOC_TYPE_LABELS: Record<TermsTemplateDocType, string> = Object.fromEntries(
  DOC_TYPE_OPTIONS.map((o) => [o.value, o.label])
) as Record<TermsTemplateDocType, string>;

export function TermsConditionsPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "super_admin" || user?.role === "admin";
  const canDelete = canEdit;

  // ---- Section 1: per-company fallback wording (used when a document has
  // no template-derived text of its own) ----
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [text, setText] = useState("");
  const [loadingCompany, setLoadingCompany] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.data);
        if (res.data.length) setCompanyId(res.data[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!companyId) return;
    setLoadingCompany(true);
    api
      .get<{ company: Company }>(`/companies/${companyId}`)
      .then((res) => setText(res.company.terms_and_conditions || ""))
      .catch((err) => message.error(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoadingCompany(false));
  }, [companyId]);

  async function handleSaveCompanyDefault() {
    if (!companyId) return;
    setSavingCompany(true);
    try {
      const { company } = await api.get<{ company: Company }>(`/companies/${companyId}`);
      await api.put(`/companies/${companyId}`, { ...company, terms_and_conditions: text || null });
      message.success("Default wording updated");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingCompany(false);
    }
  }

  // ---- Section 2: selectable, editable templates offered on documents ----
  const [templates, setTemplates] = useState<TermsTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TermsTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const res = await api.get<{ data: TermsTemplate[] }>("/terms-templates");
      setTemplates(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ doc_type: "all", is_default: false });
    setModalOpen(true);
  }

  function openEdit(record: TermsTemplate) {
    setEditing(record);
    form.setFieldsValue({
      title: record.title,
      doc_type: record.doc_type,
      content: record.content,
      is_default: Boolean(record.is_default),
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/terms-templates/${editing.id}`, values);
        message.success("Template updated");
      } else {
        await api.post("/terms-templates", values);
        message.success("Template created");
      }
      setModalOpen(false);
      loadTemplates();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: TermsTemplate) {
    try {
      await api.delete(`/terms-templates/${record.id}`);
      message.success("Template deleted");
      loadTemplates();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete template");
    }
  }

  const columns: ColumnsType<TermsTemplate> = [
    { title: "Title", dataIndex: "title", key: "title" },
    {
      title: "Applies To",
      dataIndex: "doc_type",
      key: "doc_type",
      render: (v: TermsTemplateDocType) => DOC_TYPE_LABELS[v] ?? v,
    },
    {
      title: "Default",
      dataIndex: "is_default",
      key: "is_default",
      width: 90,
      render: (v: boolean | number) => (v ? <Tag color="success">Default</Tag> : null),
    },
    {
      title: "Content",
      dataIndex: "content",
      key: "content",
      ellipsis: true,
      render: (v: string) => v.split("\n")[0] + (v.includes("\n") ? " ..." : ""),
    },
    {
      title: "Actions",
      key: "actions",
      width: 110,
      render: (_, record) => (
        <Space size="small">
          {canEdit && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />}
          {canDelete && (
            <Popconfirm title="Delete this template?" onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4}>Terms &amp; Conditions</Typography.Title>

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Templates
      </Typography.Title>
      <Typography.Text type="secondary">
        The wording a user can pick (and then edit) when creating a Quotation, Proforma Invoice, Delivery Challan or
        Tax Invoice. Tag a template to a specific document type, or "All Documents" to offer it everywhere. Editing
        or deleting a template here never changes documents that already used it - each document keeps its own copy
        of the text.
      </Typography.Text>

      <div style={{ marginTop: 12, marginBottom: 16 }}>
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Template
          </Button>
        )}
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={templates}
        loading={loadingTemplates}
        size="small"
        pagination={false}
      />

      <Modal
        title={editing ? "Edit Template" : "Add Template"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="title" label="Title" rules={[{ required: true, message: "Title is required" }]}>
            <Input placeholder="e.g. Export Terms, Warranty Terms" />
          </Form.Item>
          <Form.Item name="doc_type" label="Applies To" rules={[{ required: true }]}>
            <Select options={DOC_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item
            name="content"
            label="Content"
            rules={[{ required: true, message: "Content is required" }]}
            extra="One line per bullet point."
          >
            <Input.TextArea rows={8} placeholder={DEFAULT_TERMS} />
          </Form.Item>
          <Form.Item name="is_default" label="Pre-select on new documents of this type" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Divider />

      <Typography.Title level={5}>Company Default Wording</Typography.Title>
      <Typography.Text type="secondary">
        Used when a document has no Terms &amp; Conditions text of its own (no template selected and nothing typed
        in). Leave blank to fall back further to the built-in default wording shown below.
      </Typography.Text>

      <Space style={{ display: "block", marginTop: 16, marginBottom: 16 }}>
        <Select
          style={{ width: 240 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
      </Space>

      {!text && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="No custom wording set - PDFs for this company currently use the built-in default shown below."
        />
      )}

      <Input.TextArea
        rows={8}
        value={text}
        placeholder={DEFAULT_TERMS}
        onChange={(e) => setText(e.target.value)}
        disabled={loadingCompany || !canEdit}
      />

      {canEdit && (
        <Button type="primary" onClick={handleSaveCompanyDefault} loading={savingCompany} style={{ marginTop: 12 }}>
          Save
        </Button>
      )}
    </div>
  );
}
