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
  message,
  Popconfirm,
  Typography,
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company, Item, PurchaseBill, PurchaseBillItem, PurchaseBillStatus, Vendor } from "../types";

const PAGE_SIZE = 10;

const STATUS_LABELS: Record<PurchaseBillStatus, string> = {
  draft: "Draft",
  received: "Received",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<PurchaseBillStatus, string> = {
  draft: "default",
  received: "success",
  cancelled: "default",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface LineFormValue {
  item_id: number | null;
  description: string;
  hsn_code: string | null;
  qty: number;
  unit: string;
  rate: number;
  tax_rate: number;
}

export function PurchaseBillsPage() {
  const { can } = useAuth();
  const [bills, setBills] = useState<PurchaseBill[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseBill | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const lineItems = Form.useWatch("items", form) as LineFormValue[] | undefined;

  const canCreate = can("purchases.bills", "create");
  const canEdit = can("purchases.bills", "edit");
  const canDelete = can("purchases.bills", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: PurchaseBill[]; meta: { total: number } }>(
        `/purchase-bills?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setBills(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load purchase bills");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
    api.get<{ data: Vendor[] }>("/vendors?perPage=200").then((res) => setVendors(res.data)).catch(() => {});
    api.get<{ data: Item[] }>("/items?perPage=200").then((res) => setItems(res.data)).catch(() => {});
  }, []);

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    (lineItems || []).forEach((line) => {
      const qty = Number(line?.qty) || 0;
      const rate = Number(line?.rate) || 0;
      const taxRate = Number(line?.tax_rate) || 0;
      const taxable = round2(qty * rate);
      subtotal += taxable;
      tax += round2((taxable * taxRate) / 100);
    });
    subtotal = round2(subtotal);
    tax = round2(tax);
    return { subtotal, tax, total: round2(subtotal + tax) };
  }, [lineItems]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      bill_date: dayjs(),
      company_id: companies[0]?.id,
      status: "draft",
      items: [{ item_id: null, description: "", hsn_code: "", qty: 1, unit: "pcs", rate: 0, tax_rate: 18 }],
    });
    setModalOpen(true);
  }

  async function openEdit(record: PurchaseBill) {
    try {
      const res = await api.get<{ bill: PurchaseBill; items: PurchaseBillItem[] }>(`/purchase-bills/${record.id}`);
      setEditing(res.bill);
      form.setFieldsValue({
        company_id: res.bill.company_id,
        vendor_id: res.bill.vendor_id,
        bill_date: dayjs(res.bill.bill_date),
        due_date: res.bill.due_date ? dayjs(res.bill.due_date) : undefined,
        reference_no: res.bill.reference_no,
        notes: res.bill.notes,
        status: res.bill.status,
        items: res.items.map((i) => ({
          item_id: i.item_id,
          description: i.description,
          hsn_code: i.hsn_code,
          qty: Number(i.qty),
          unit: i.unit,
          rate: Number(i.rate),
          tax_rate: Number(i.tax_rate),
        })),
      });
      setModalOpen(true);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load purchase bill");
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
      const payload = { ...values, bill_date: values.bill_date.format("YYYY-MM-DD"), due_date: values.due_date ? values.due_date.format("YYYY-MM-DD") : null };
      if (editing) {
        const res = await api.put<{ bill: PurchaseBill; journal: { id: number } | null }>(`/purchase-bills/${editing.id}`, payload);
        message.success(res.journal ? `Purchase bill updated (Journal #${res.journal.id} posted)` : "Purchase bill updated");
      } else {
        const res = await api.post<{ bill: PurchaseBill; journal: { id: number } | null }>("/purchase-bills", payload);
        message.success(res.journal ? `Purchase bill created (Journal #${res.journal.id} posted)` : "Purchase bill created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save purchase bill");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: PurchaseBill) {
    try {
      await api.delete(`/purchase-bills/${record.id}`);
      message.success("Purchase bill deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete purchase bill");
    }
  }

  const columns: ColumnsType<PurchaseBill> = [
    { title: "No.", dataIndex: "bill_no", key: "bill_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Vendor", dataIndex: "vendor_name", key: "vendor_name" },
    { title: "Bill Date", dataIndex: "bill_date", key: "bill_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    {
      title: "Due Date",
      dataIndex: "due_date",
      key: "due_date",
      render: (d: string | null) => (d ? dayjs(d).format("DD MMM YYYY") : "-"),
    },
    { title: "Subtotal", dataIndex: "subtotal", key: "subtotal", render: (v: string) => `Rs. ${Number(v).toFixed(2)}` },
    { title: "Tax", dataIndex: "tax_amount", key: "tax_amount", render: (v: string) => `Rs. ${Number(v).toFixed(2)}` },
    { title: "Total", dataIndex: "total_amount", key: "total_amount", render: (v: string) => `Rs. ${Number(v).toFixed(2)}` },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: PurchaseBillStatus) => <Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>,
    },
    {
      title: "Actions",
      key: "actions",
      width: 110,
      render: (_, record) => (
        <Space size="small">
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled title="View only" />
          )}
          {canDelete && record.status === "draft" && (
            <Popconfirm title="Delete this purchase bill?" onConfirm={() => handleDelete(record)}>
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
          Purchase Bills
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search number or vendor"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New Purchase Bill
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={bills}
        loading={loading}
        size="small"
        scroll={{ x: 900 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? `Edit ${editing.bill_no}` : "New Purchase Bill"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={820}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Space.Compact style={{ width: "100%", marginBottom: 16 }}>
            <Form.Item
              name="company_id"
              label="Company"
              rules={[{ required: true, message: "Company is required" }]}
              style={{ width: "34%", marginBottom: 0 }}
            >
              <Select
                placeholder="Select company"
                style={{ width: "100%" }}
                options={companies.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
            <Form.Item
              name="vendor_id"
              label="Vendor"
              rules={[{ required: true, message: "Vendor is required" }]}
              style={{ width: "36%", marginBottom: 0 }}
            >
              <Select
                showSearch
                placeholder="Select vendor"
                style={{ width: "100%" }}
                options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
              />
            </Form.Item>
            <Form.Item name="status" label="Status" style={{ width: "30%", marginBottom: 0 }}>
              <Select
                style={{ width: "100%" }}
                options={(Object.keys(STATUS_LABELS) as PurchaseBillStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
              />
            </Form.Item>
          </Space.Compact>

          <Space.Compact style={{ width: "100%", marginBottom: 16 }}>
            <Form.Item
              name="bill_date"
              label="Bill Date"
              rules={[{ required: true, message: "Bill date is required" }]}
              style={{ width: "34%", marginBottom: 0 }}
            >
              <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="due_date" label="Due Date" style={{ width: "33%", marginBottom: 0 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="reference_no" label="Reference No" style={{ width: "33%", marginBottom: 0 }}>
              <Input placeholder="Vendor's own bill/invoice no" />
            </Form.Item>
          </Space.Compact>

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
                        let lineTotal = 0;
                        if (line) {
                          const taxable = round2((Number(line.qty) || 0) * (Number(line.rate) || 0));
                          const tax = round2((taxable * (Number(line.tax_rate) || 0)) / 100);
                          lineTotal = round2(taxable + tax);
                        }
                        return (
                          <tr key={key}>
                            <td>
                              <Select
                                allowClear
                                showSearch
                                placeholder="From catalog"
                                size="small"
                                style={{ width: "100%" }}
                                options={items.map((i) => ({ value: i.id, label: i.name }))}
                                filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
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
                                <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => remove(name)} />
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
                  onClick={() => add({ item_id: null, description: "", hsn_code: "", qty: 1, unit: "pcs", rate: 0, tax_rate: 18 })}
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
            <div>Subtotal (Taxable Value): Rs. {totals.subtotal.toFixed(2)}</div>
            <div>Tax: Rs. {totals.tax.toFixed(2)}</div>
            <Typography.Text strong>Total: Rs. {totals.total.toFixed(2)}</Typography.Text>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
