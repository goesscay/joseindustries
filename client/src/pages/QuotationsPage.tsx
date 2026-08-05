import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Table,
  Button,
  Input,
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
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, FilePdfOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company, Customer, Item, Quotation, DocumentLineItem, DocStatus } from "../types";

const PAGE_SIZE = 10;

const STATUS_COLORS: Record<DocStatus, string> = {
  draft: "default",
  sent: "blue",
  accepted: "success",
  rejected: "error",
  cancelled: "default",
};

const STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

// Optional Tally-style fields, grouped for the collapsible form sections.
const OPTIONAL_DATE_FIELDS = ["delivery_note_date", "buyers_order_date", "date_of_supply"];

export function QuotationsPage() {
  const { user } = useAuth();
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Quotation | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const lineItems = Form.useWatch("items", form) as DocumentLineItem[] | undefined;

  const canDelete = user?.role === "super_admin" || user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Quotation[]; meta: { total: number } }>(
        `/quotations?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setQuotations(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load quotations");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => setCompanies(res.data))
      .catch(() => {});
    api
      .get<{ data: Customer[] }>("/customers?perPage=200")
      .then((res) => setCustomers(res.data))
      .catch(() => {});
    api
      .get<{ data: Item[] }>("/items?perPage=200")
      .then((res) => setItems(res.data))
      .catch(() => {});
  }, []);

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    (lineItems || []).forEach((line) => {
      const qty = Number(line?.qty) || 0;
      const rate = Number(line?.rate) || 0;
      const taxRate = Number(line?.tax_rate) || 0;
      const base = qty * rate;
      subtotal += base;
      tax += (base * taxRate) / 100;
    });
    return { subtotal, tax, grand: subtotal + tax };
  }, [lineItems]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      issue_date: dayjs(),
      company_id: companies[0]?.id,
      items: [{ item_id: null, description: "", hsn_code: "", qty: 1, unit: "pcs", rate: 0, tax_rate: 18 }],
    });
    setModalOpen(true);
  }

  async function openEdit(record: Quotation) {
    try {
      const res = await api.get<{ quotation: Quotation; items: DocumentLineItem[] }>(`/quotations/${record.id}`);
      const q = res.quotation;
      setEditing(q);
      const values: Record<string, unknown> = {
        company_id: q.company_id,
        customer_id: q.customer_id,
        issue_date: dayjs(q.issue_date),
        notes: q.notes,
        consignee_name: q.consignee_name,
        consignee_address: q.consignee_address,
        consignee_gstin: q.consignee_gstin,
        consignee_state: q.consignee_state,
        transport_mode: q.transport_mode,
        vehicle_number: q.vehicle_number,
        place_of_supply: q.place_of_supply,
        buyers_order_no: q.buyers_order_no,
        dispatch_doc_no: q.dispatch_doc_no,
        dispatched_through: q.dispatched_through,
        destination: q.destination,
        terms_of_delivery: q.terms_of_delivery,
        delivery_note: q.delivery_note,
        mode_terms_of_payment: q.mode_terms_of_payment,
        other_reference: q.other_reference,
        supplier_reference: q.supplier_reference,
        items: res.items.map((i) => ({
          item_id: i.item_id,
          description: i.description,
          hsn_code: i.hsn_code,
          qty: Number(i.qty),
          unit: i.unit,
          rate: Number(i.rate),
          tax_rate: Number(i.tax_rate),
        })),
      };
      for (const dateField of OPTIONAL_DATE_FIELDS) {
        const raw = (q as unknown as Record<string, unknown>)[dateField];
        values[dateField] = raw ? dayjs(raw as string) : undefined;
      }
      form.setFieldsValue(values);
      setModalOpen(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load quotation");
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

      if (editing) {
        await api.put(`/quotations/${editing.id}`, payload);
        message.success("Quotation updated");
      } else {
        await api.post("/quotations", payload);
        message.success("Quotation created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save quotation");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(record: Quotation, status: DocStatus) {
    try {
      await api.patch(`/quotations/${record.id}/status`, { status });
      message.success("Status updated");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function handleDelete(record: Quotation) {
    try {
      await api.delete(`/quotations/${record.id}`);
      message.success("Quotation deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete quotation");
    }
  }

  function downloadPdf(record: Quotation) {
    window.open(`/api/quotations/${record.id}/pdf`, "_blank");
  }

  const columns: ColumnsType<Quotation> = [
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
            items: (Object.keys(STATUS_LABELS) as DocStatus[]).map((s) => ({
              key: s,
              label: STATUS_LABELS[s],
              onClick: () => handleStatusChange(record, s),
            })),
          }}
        >
          <Tag color={STATUS_COLORS[status]} style={{ cursor: "pointer" }}>
            {STATUS_LABELS[status]}
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
    {
      title: "Actions",
      key: "actions",
      width: 150,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Button size="small" icon={<FilePdfOutlined />} onClick={() => downloadPdf(record)} />
          {canDelete && record.status === "draft" && (
            <Popconfirm title="Delete this quotation?" onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Quotations
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Quotation
          </Button>
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={quotations}
        loading={loading}
        size="small"
        scroll={{ x: 780 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? `Edit ${editing.doc_number}` : "New Quotation"}
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
              <Form.Item
                name="company_id"
                label="Company"
                rules={[{ required: true, message: "Company is required" }]}
              >
                <Select
                  placeholder="Select company"
                  options={companies.map((c) => ({ value: c.id, label: c.name }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={10}>
              <Form.Item
                name="customer_id"
                label="Customer"
                rules={[{ required: true, message: "Customer is required" }]}
              >
                <Select
                  showSearch
                  placeholder="Select customer"
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
                />
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
                        <Input />
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
                        <th style={{ width: 70 }}>Tax %</th>
                        <th style={{ width: 90 }}>Amount</th>
                        <th style={{ width: 32 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(({ key, name }) => {
                        const line = lineItems?.[name];
                        const lineTotal = line ? (Number(line.qty) || 0) * (Number(line.rate) || 0) : 0;
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
                    add({ item_id: null, description: "", hsn_code: "", qty: 1, unit: "pcs", rate: 0, tax_rate: 18 })
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
            <div>Subtotal: Rs. {totals.subtotal.toFixed(2)}</div>
            <div>Tax: Rs. {totals.tax.toFixed(2)}</div>
            <Typography.Text strong>Grand Total: Rs. {totals.grand.toFixed(2)}</Typography.Text>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
