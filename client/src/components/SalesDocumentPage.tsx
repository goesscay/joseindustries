import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Table,
  Button,
  Input,
  AutoComplete,
  Space,
  Modal,
  Form,
  Select,
  DatePicker,
  InputNumber,
  Collapse,
  Row,
  Col,
  message,
  Popconfirm,
  Typography,
  Tag,
  Dropdown,
  Switch,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, FilePdfOutlined, SwapOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { QuickAddCustomerModal } from "./QuickAddCustomerModal";
import {
  Company,
  Customer,
  Item,
  PaymentTerm,
  SalesDocument,
  DocumentLineItem,
  DocStatus,
  Role,
  TermsTemplate,
  TermsTemplateDocType,
} from "../types";

const PAGE_SIZE = 10;

// Maps this component's apiPath prop to the doc_type value used by
// terms_and_conditions_templates.doc_type, so the Terms & Conditions picker
// only offers templates tagged for this document (plus ones tagged "all").
const API_PATH_TO_DOC_TYPE: Record<string, TermsTemplateDocType> = {
  "/quotations": "quotation",
  "/proforma-invoices": "proforma_invoice",
  "/delivery-challans": "delivery_challan",
  "/tax-invoices": "tax_invoice",
};

// Maps this component's apiPath prop to its permission module key (see
// constants/permissions.ts) for the create/edit/delete button gating below.
const API_PATH_TO_MODULE: Record<string, string> = {
  "/quotations": "sales.quotations",
  "/proforma-invoices": "sales.proforma_invoices",
  "/delivery-challans": "sales.delivery_challans",
  "/tax-invoices": "sales.tax_invoices",
};

const DEFAULT_STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<DocStatus, string> = {
  draft: "default",
  sent: "blue",
  accepted: "success",
  rejected: "error",
  cancelled: "default",
};

// Optional Tally-style fields whose form values are dayjs objects, needing
// YYYY-MM-DD serialization on submit and dayjs parsing on load.
const OPTIONAL_DATE_FIELDS = ["delivery_note_date", "buyers_order_date", "date_of_supply", "due_date"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ConvertTarget {
  apiPath: string;
  routePath: string;
  title: string;
  /** If set, only these roles can convert to this target (e.g. Tax Invoice needs admin/super_admin). */
  allowedRoles?: Role[];
}

interface SalesDocumentPageProps {
  apiPath: string;
  title: string;
  pluralTitle: string;
  statusLabels?: Partial<Record<DocStatus, string>>;
  convertTargets?: ConvertTarget[];
  /** If set, only these roles can create/edit/convert this document type (others get a read-only view + PDF). */
  restrictedToRoles?: Role[];
  /** Adds Paid / Balance Due columns, sourced from the list endpoint's paid_amount field (Tax Invoices). */
  showPaymentStatus?: boolean;
}

export function SalesDocumentPage({
  apiPath,
  title,
  pluralTitle,
  statusLabels,
  convertTargets,
  restrictedToRoles,
  showPaymentStatus,
}: SalesDocumentPageProps) {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const labels = { ...DEFAULT_STATUS_LABELS, ...statusLabels };
  const permissionModule = API_PATH_TO_MODULE[apiPath];
  const roleAllows = !restrictedToRoles || (user ? restrictedToRoles.includes(user.role) : false);
  const canCreate = roleAllows && can(permissionModule, "create");
  const canEdit = roleAllows && can(permissionModule, "edit");
  const canCreateCustomer = can("contacts.customers", "create");

  const [rows, setRows] = useState<SalesDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm[]>([]);
  const [termsTemplates, setTermsTemplates] = useState<TermsTemplate[]>([]);
  const docType = API_PATH_TO_DOC_TYPE[apiPath];
  const applicableTemplates = termsTemplates.filter((t) => t.doc_type === "all" || t.doc_type === docType);

  const [modalOpen, setModalOpen] = useState(false);
  const [quickAddCustomerOpen, setQuickAddCustomerOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<SalesDocument | null>(null);
  const [convertTarget, setConvertTarget] = useState<ConvertTarget | null>(null);
  const [convertSourceId, setConvertSourceId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const lineItems = Form.useWatch("items", form) as DocumentLineItem[] | undefined;
  const freightWatch = Form.useWatch("freight_charges", form) as number | undefined;
  const installationWatch = Form.useWatch("installation_charges", form) as number | undefined;

  const canDelete = can(permissionModule, "delete");
  const availableConvertTargets = (convertTargets ?? []).filter(
    (t) => !t.allowedRoles || (user && t.allowedRoles.includes(user.role))
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: SalesDocument[]; meta: { total: number } }>(
        `${apiPath}?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setRows(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : `Failed to load ${pluralTitle.toLowerCase()}`);
    } finally {
      setLoading(false);
    }
  }, [apiPath, page, search, pluralTitle]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
    api.get<{ data: Customer[] }>("/customers?perPage=200").then((res) => setCustomers(res.data)).catch(() => {});
    api.get<{ data: Item[] }>("/items?perPage=200").then((res) => setItems(res.data)).catch(() => {});
    api.get<{ data: PaymentTerm[] }>("/payment-terms").then((res) => setPaymentTerms(res.data)).catch(() => {});
    api
      .get<{ data: TermsTemplate[] }>(`/terms-templates?docType=${docType}`)
      .then((res) => setTermsTemplates(res.data))
      .catch(() => {});
  }, [docType]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let discountAmount = 0;
    let tax = 0;
    (lineItems || []).forEach((line) => {
      const qty = Number(line?.qty) || 0;
      const rate = Number(line?.rate) || 0;
      const discountPercent = Number(line?.discount_percent) || 0;
      const taxRate = Number(line?.tax_rate) || 0;
      const base = round2(qty * rate);
      const discount = round2((base * discountPercent) / 100);
      const taxable = round2(base - discount);
      subtotal += taxable;
      discountAmount += discount;
      tax += round2((taxable * taxRate) / 100);
    });
    subtotal = round2(subtotal);
    discountAmount = round2(discountAmount);
    tax = round2(tax);
    const freight = round2(Number(freightWatch) || 0);
    const installation = round2(Number(installationWatch) || 0);
    const raw = subtotal + tax + freight + installation;
    const grand = Math.round(raw);
    const roundOff = round2(grand - raw);
    return { subtotal, discountAmount, tax, freight, installation, roundOff, grand };
  }, [lineItems, freightWatch, installationWatch]);

  function openCreate() {
    setEditingDoc(null);
    setConvertTarget(null);
    setConvertSourceId(null);
    form.resetFields();
    // Prefer a default template tagged specifically for this document type
    // over a default tagged "all", so the picker starts pre-filled but the
    // user can still swap or edit it before saving.
    const defaultTemplate =
      applicableTemplates.find((t) => t.is_default && t.doc_type === docType) ||
      applicableTemplates.find((t) => t.is_default);
    form.setFieldsValue({
      issue_date: dayjs(),
      company_id: companies[0]?.id,
      reverse_charge: false,
      freight_charges: 0,
      installation_charges: 0,
      terms_and_conditions: defaultTemplate?.content,
      items: [
        { item_id: null, description: "", hsn_code: "", qty: 1, unit: "pcs", rate: 0, discount_percent: 0, tax_rate: 18 },
      ],
    });
    setModalOpen(true);
  }

  function applyTermsTemplate(templateId: number) {
    const template = termsTemplates.find((t) => t.id === templateId);
    if (template) form.setFieldsValue({ terms_and_conditions: template.content });
  }

  function fillFormFrom(doc: SalesDocument, docItems: DocumentLineItem[], issueDate: dayjs.Dayjs) {
    const values: Record<string, unknown> = {
      company_id: doc.company_id,
      customer_id: doc.customer_id,
      issue_date: issueDate,
      notes: doc.notes,
      consignee_name: doc.consignee_name,
      consignee_address: doc.consignee_address,
      consignee_gstin: doc.consignee_gstin,
      consignee_state: doc.consignee_state,
      transport_mode: doc.transport_mode,
      vehicle_number: doc.vehicle_number,
      place_of_supply: doc.place_of_supply,
      buyers_order_no: doc.buyers_order_no,
      dispatch_doc_no: doc.dispatch_doc_no,
      dispatched_through: doc.dispatched_through,
      destination: doc.destination,
      terms_of_delivery: doc.terms_of_delivery,
      delivery_note: doc.delivery_note,
      mode_terms_of_payment: doc.mode_terms_of_payment,
      other_reference: doc.other_reference,
      supplier_reference: doc.supplier_reference,
      terms_and_conditions: doc.terms_and_conditions,
      credit_period: doc.credit_period,
      reverse_charge: Boolean(doc.reverse_charge),
      freight_charges: Number(doc.freight_charges) || 0,
      installation_charges: Number(doc.installation_charges) || 0,
      items: docItems.map((i) => ({
        item_id: i.item_id,
        description: i.description,
        hsn_code: i.hsn_code,
        qty: Number(i.qty),
        unit: i.unit,
        rate: Number(i.rate),
        discount_percent: Number(i.discount_percent) || 0,
        tax_rate: Number(i.tax_rate),
      })),
    };
    for (const dateField of OPTIONAL_DATE_FIELDS) {
      const raw = (doc as unknown as Record<string, unknown>)[dateField];
      values[dateField] = raw ? dayjs(raw as string) : undefined;
    }
    form.setFieldsValue(values);
  }

  async function openEdit(record: SalesDocument) {
    try {
      const res = await api.get<{ document: SalesDocument; items: DocumentLineItem[] }>(`${apiPath}/${record.id}`);
      setEditingDoc(res.document);
      setConvertTarget(null);
      setConvertSourceId(null);
      fillFormFrom(res.document, res.items, dayjs(res.document.issue_date));
      setModalOpen(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : `Failed to load ${title.toLowerCase()}`);
    }
  }

  async function openConvert(record: SalesDocument, target: ConvertTarget) {
    try {
      const res = await api.get<{ document: SalesDocument; items: DocumentLineItem[] }>(`${apiPath}/${record.id}`);
      setEditingDoc(null);
      setConvertTarget(target);
      setConvertSourceId(record.id);
      fillFormFrom(res.document, res.items, dayjs());
      setModalOpen(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load source document");
    }
  }

  function handleItemSelect(index: number, itemId: number) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const current = form.getFieldValue("items");
    current[index] = {
      ...current[index],
      item_id: item.id,
      description: item.name,
      hsn_code: item.hsn_code,
      unit: item.unit,
      rate: Number(item.default_rate),
      tax_rate: Number(item.tax_rate),
    };
    form.setFieldsValue({ items: current });
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { ...values };
      payload.issue_date = values.issue_date.format("YYYY-MM-DD");
      for (const dateField of OPTIONAL_DATE_FIELDS) {
        const v = values[dateField];
        payload[dateField] = v ? v.format("YYYY-MM-DD") : null;
      }

      if (convertTarget) {
        payload.converted_from_id = convertSourceId;
        const res = await api.post<{ document: SalesDocument }>(convertTarget.apiPath, payload);
        message.success(`Converted to ${convertTarget.title} ${res.document.doc_number}`);
        setModalOpen(false);
        navigate(convertTarget.routePath);
        return;
      }

      if (editingDoc) {
        await api.put(`${apiPath}/${editingDoc.id}`, payload);
        message.success(`${title} updated`);
      } else {
        await api.post(apiPath, payload);
        message.success(`${title} created`);
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : `Failed to save ${title.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(record: SalesDocument, status: DocStatus) {
    try {
      await api.patch(`${apiPath}/${record.id}/status`, { status });
      message.success("Status updated");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function handleDelete(record: SalesDocument) {
    try {
      await api.delete(`${apiPath}/${record.id}`);
      message.success(`${title} deleted`);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : `Failed to delete ${title.toLowerCase()}`);
    }
  }

  function downloadPdf(record: SalesDocument) {
    window.open(`/api${apiPath}/${record.id}/pdf`, "_blank");
  }

  const columns: ColumnsType<SalesDocument> = [
    { title: "No.", dataIndex: "doc_number", key: "doc_number" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Customer", dataIndex: "customer_name", key: "customer_name" },
    {
      title: "Date",
      dataIndex: "issue_date",
      key: "issue_date",
      render: (d: string) => dayjs(d).format("DD MMM YYYY"),
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: DocStatus, record) => (
        <Dropdown
          menu={{
            items: (Object.keys(labels) as DocStatus[]).map((s) => ({
              key: s,
              label: labels[s],
              onClick: () => handleStatusChange(record, s),
            })),
          }}
        >
          <Tag color={STATUS_COLORS[status]} style={{ cursor: "pointer" }}>
            {labels[status]}
          </Tag>
        </Dropdown>
      ),
    },
    {
      title: "Total",
      dataIndex: "grand_total",
      key: "grand_total",
      render: (v: string) => `Rs. ${Number(v).toFixed(2)}`,
    },
    ...(showPaymentStatus
      ? [
          {
            title: "Paid",
            key: "paid_amount",
            render: (_: unknown, record: SalesDocument) => `Rs. ${Number(record.paid_amount ?? 0).toFixed(2)}`,
          },
          {
            title: "Balance Due",
            key: "balance_due",
            render: (_: unknown, record: SalesDocument) => {
              const balance = Number(record.grand_total) - Number(record.paid_amount ?? 0);
              return <Tag color={balance > 0.001 ? "warning" : "success"}>{`Rs. ${balance.toFixed(2)}`}</Tag>;
            },
          },
        ]
      : []),
    {
      title: "Actions",
      key: "actions",
      width: 190,
      render: (_, record) => (
        <Space size="small">
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled title="View only" />
          )}
          <Button size="small" icon={<FilePdfOutlined />} onClick={() => downloadPdf(record)} />
          {canCreate && availableConvertTargets.length > 0 && record.status === "accepted" && (
            <Dropdown
              menu={{
                items: availableConvertTargets.map((t) => ({
                  key: t.apiPath,
                  label: `Convert to ${t.title}`,
                  onClick: () => openConvert(record, t),
                })),
              }}
            >
              <Button size="small" icon={<SwapOutlined />} />
            </Dropdown>
          )}
          {canDelete && record.status === "draft" && (
            <Popconfirm title={`Delete this ${title.toLowerCase()}?`} onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const modalTitle = convertTarget
    ? `New ${convertTarget.title} (from ${title})`
    : editingDoc
      ? `Edit ${editingDoc.doc_number}`
      : `New ${title}`;

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {pluralTitle}
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search number or customer"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New {title}
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        size="small"
        scroll={{ x: 780 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={modalTitle}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={820}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Row gutter={12}>
            <Col xs={24} sm={8}>
              <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
                <Select placeholder="Select company" options={companies.map((c) => ({ value: c.id, label: c.name }))} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={10}>
              <Form.Item label="Customer" required>
                <div style={{ display: "flex", gap: 8 }}>
                  <Form.Item
                    name="customer_id"
                    rules={[{ required: true, message: "Customer is required" }]}
                    style={{ flex: 1, marginBottom: 0 }}
                  >
                    <Select
                      showSearch
                      placeholder="Select customer"
                      options={customers.map((c) => ({ value: c.id, label: c.name }))}
                      filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
                    />
                  </Form.Item>
                  {canCreateCustomer && (
                    <Button icon={<PlusOutlined />} onClick={() => setQuickAddCustomerOpen(true)} title="Add new customer" />
                  )}
                </div>
              </Form.Item>
            </Col>
            <Col xs={24} sm={6}>
              <Form.Item name="issue_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
                <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>

          <Collapse
            ghost
            size="small"
            style={{ marginBottom: 12 }}
            items={[
              {
                key: "consignee",
                label: "Shipping / Consignee (optional, if different from buyer)",
                children: (
                  <Row gutter={12}>
                    <Col xs={24} sm={12}>
                      <Form.Item name="consignee_name" label="Consignee Name">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item name="consignee_gstin" label="Consignee GSTIN">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={16}>
                      <Form.Item name="consignee_address" label="Consignee Address">
                        <Input.TextArea rows={2} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="consignee_state" label="Consignee State">
                        <Input />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
              {
                key: "references",
                label: "References & Transport (optional)",
                children: (
                  <Row gutter={12}>
                    <Col xs={24} sm={8}>
                      <Form.Item name="place_of_supply" label="Place of Supply">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="mode_terms_of_payment" label="Mode/Terms of Payment">
                        <AutoComplete
                          options={paymentTerms.map((t) => ({ value: t.label }))}
                          filterOption={(input, option) => (option?.value as string).toLowerCase().includes(input.toLowerCase())}
                          placeholder="e.g. 50% Advance, Balance in 15 Days"
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="supplier_reference" label="Supplier's Reference">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="other_reference" label="Other Reference">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="buyers_order_no" label="Buyer's Order No">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="buyers_order_date" label="Buyer's Order Date">
                        <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="delivery_note" label="Delivery Note">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="delivery_note_date" label="Delivery Note Date">
                        <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="dispatch_doc_no" label="Dispatch Doc No">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="dispatched_through" label="Dispatched Through">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="destination" label="Destination">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="terms_of_delivery" label="Terms of Delivery">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="transport_mode" label="Transport Mode">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="vehicle_number" label="Vehicle Number">
                        <Input />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item name="date_of_supply" label="Date of Supply">
                        <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
              {
                key: "charges",
                label: "Invoice Terms & Charges (due date, credit period, freight, installation)",
                children: (
                  <Row gutter={12}>
                    <Col xs={24} sm={6}>
                      <Form.Item name="due_date" label="Due Date">
                        <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={6}>
                      <Form.Item name="credit_period" label="Credit Period">
                        <Input placeholder="e.g. 15 Days" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={6}>
                      <Form.Item name="freight_charges" label="Freight / Transportation">
                        <InputNumber min={0} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={6}>
                      <Form.Item name="installation_charges" label="Installation / Other Charges">
                        <InputNumber min={0} style={{ width: "100%" }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={6}>
                      <Form.Item name="reverse_charge" label="Reverse Charge" valuePropName="checked">
                        <Switch />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
              {
                key: "terms",
                label: "Terms & Conditions (optional)",
                children: (
                  <>
                    <Form.Item label="Start from a saved template">
                      <Select
                        allowClear
                        placeholder="Choose a template to fill in the text below - you can still edit it after"
                        options={applicableTemplates.map((t) => ({ value: t.id, label: t.title }))}
                        onChange={(value) => value && applyTermsTemplate(value)}
                      />
                    </Form.Item>
                    <Form.Item
                      name="terms_and_conditions"
                      label="Printed Terms & Conditions"
                      extra="One line per bullet point. Leave blank to use the company's default wording."
                    >
                      <Input.TextArea rows={6} />
                    </Form.Item>
                  </>
                ),
              },
            ]}
          />

          <Form.List name="items">
            {(fields, { add, remove }) => (
              <div style={{ marginBottom: 16 }}>
                <Typography.Text strong>Line Items</Typography.Text>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", marginTop: 8, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", fontSize: 12, color: "#888" }}>
                        <th style={{ minWidth: 150 }}>Item</th>
                        <th style={{ minWidth: 150 }}>Description</th>
                        <th style={{ width: 90 }}>HSN/SAC</th>
                        <th style={{ width: 70 }}>Qty</th>
                        <th style={{ width: 90 }}>Rate</th>
                        <th style={{ width: 65 }}>Disc %</th>
                        <th style={{ width: 70 }}>Tax %</th>
                        <th style={{ width: 90 }}>Amount</th>
                        <th style={{ width: 32 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(({ key, name }) => {
                        const line = lineItems?.[name];
                        let lineTotal = 0;
                        if (line) {
                          const base = round2((Number(line.qty) || 0) * (Number(line.rate) || 0));
                          const discount = round2((base * (Number(line.discount_percent) || 0)) / 100);
                          const taxable = round2(base - discount);
                          const tax = round2((taxable * (Number(line.tax_rate) || 0)) / 100);
                          lineTotal = round2(taxable + tax);
                        }
                        return (
                          <tr key={key}>
                            <td>
                              <Select
                                allowClear
                                placeholder="From catalog"
                                size="small"
                                style={{ width: "100%" }}
                                options={items.map((i) => ({ value: i.id, label: i.name }))}
                                onChange={(value) => value && handleItemSelect(name, value)}
                              />
                            </td>
                            <td>
                              <Form.Item
                                name={[name, "description"]}
                                rules={[{ required: true, message: "Required" }]}
                                style={{ marginBottom: 0 }}
                              >
                                <Input size="small" placeholder="Description" />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[name, "hsn_code"]} style={{ marginBottom: 0 }}>
                                <Input size="small" placeholder="HSN" />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[name, "qty"]} style={{ marginBottom: 0 }}>
                                <InputNumber size="small" min={0.01} style={{ width: "100%" }} />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[name, "rate"]} style={{ marginBottom: 0 }}>
                                <InputNumber size="small" min={0} style={{ width: "100%" }} />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[name, "discount_percent"]} style={{ marginBottom: 0 }}>
                                <InputNumber size="small" min={0} max={100} style={{ width: "100%" }} />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[name, "tax_rate"]} style={{ marginBottom: 0 }}>
                                <InputNumber size="small" min={0} max={100} style={{ width: "100%" }} />
                              </Form.Item>
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>{lineTotal.toFixed(2)}</td>
                            <td>
                              {fields.length > 1 && (
                                <Button
                                  type="text"
                                  size="small"
                                  danger
                                  icon={<DeleteOutlined />}
                                  onClick={() => remove(name)}
                                />
                              )}
                            </td>
                            <td style={{ display: "none" }}>
                              <Form.Item name={[name, "item_id"]} noStyle>
                                <Input />
                              </Form.Item>
                              <Form.Item name={[name, "unit"]} noStyle>
                                <Input />
                              </Form.Item>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Button
                  type="dashed"
                  size="small"
                  icon={<PlusOutlined />}
                  style={{ marginTop: 8 }}
                  onClick={() =>
                    add({
                      item_id: null,
                      description: "",
                      hsn_code: "",
                      qty: 1,
                      unit: "pcs",
                      rate: 0,
                      discount_percent: 0,
                      tax_rate: 18,
                    })
                  }
                >
                  Add Line
                </Button>
              </div>
            )}
          </Form.List>

          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>

          <div style={{ textAlign: "right", borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
            <div>Subtotal / Taxable Value: Rs. {totals.subtotal.toFixed(2)}</div>
            {totals.discountAmount > 0 && <div>Discount: Rs. {totals.discountAmount.toFixed(2)}</div>}
            <div>Tax: Rs. {totals.tax.toFixed(2)}</div>
            {totals.freight > 0 && <div>Freight / Transportation: Rs. {totals.freight.toFixed(2)}</div>}
            {totals.installation > 0 && <div>Installation / Other Charges: Rs. {totals.installation.toFixed(2)}</div>}
            {totals.roundOff !== 0 && <div>Round Off: Rs. {totals.roundOff.toFixed(2)}</div>}
            <Typography.Text strong>Grand Total: Rs. {totals.grand.toFixed(2)}</Typography.Text>
          </div>
        </Form>
      </Modal>

      <QuickAddCustomerModal
        open={quickAddCustomerOpen}
        onClose={() => setQuickAddCustomerOpen(false)}
        onCreated={(customer) => {
          setCustomers((prev) => [customer, ...prev]);
          form.setFieldsValue({ customer_id: customer.id });
          setQuickAddCustomerOpen(false);
        }}
      />
    </div>
  );
}
