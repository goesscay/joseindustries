import { useCallback, useEffect, useState } from "react";
import { Table, Button, Input, Space, Modal, Form, Select, DatePicker, InputNumber, message, Popconfirm, Typography, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { RemoteSelect } from "../components/RemoteSelect";
import { Company, Expense, ExpenseCategory, Vendor } from "../types";

const PAGE_SIZE = 10;

export function ExpensesPage() {
  const { user, can } = useAuth();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canCreate = can("expenses.expenses", "create");
  const canEdit = can("expenses.expenses", "edit");
  const canDelete = can("expenses.expenses", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Expense[]; meta: { total: number } }>(
        `/expenses?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setExpenses(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load expenses");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
    // No bulk vendor preload anymore - the Vendor field's RemoteSelect
    // below searches the server directly; `vendors` here now only ever
    // holds the specific record (the one being edited, if any) that must
    // stay selectable regardless of search text - see ensureVendorLoaded.
    api.get<{ data: ExpenseCategory[] }>("/expense-categories").then((res) => setCategories(res.data)).catch(() => {});
  }, []);

  // Same gap as the customer field elsewhere in this app: the Vendor
  // dropdown is only ever populated from a live server search now, so
  // resolving the *currently selected* vendor when opening the edit form
  // needs its own direct fetch, merged in as an extra option.
  async function ensureVendorLoaded(vendorId: number | null | undefined) {
    if (!vendorId || vendors.some((v) => v.id === vendorId)) return;
    try {
      const res = await api.get<{ vendor: Vendor }>(`/vendors/${vendorId}`);
      setVendors((prev) => (prev.some((v) => v.id === vendorId) ? prev : [...prev, res.vendor]));
    } catch {
      // Vendor genuinely gone - leave the id showing rather than fail the
      // whole edit.
    }
  }

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      expense_date: dayjs(),
      company_id: companies[0]?.id,
      amount: 0,
      tax_amount: 0,
    });
    setModalOpen(true);
  }

  async function openEdit(record: Expense) {
    await ensureVendorLoaded(record.vendor_id);
    setEditing(record);
    form.setFieldsValue({
      company_id: record.company_id,
      vendor_id: record.vendor_id,
      category_id: record.category_id,
      expense_date: dayjs(record.expense_date),
      description: record.description,
      amount: Number(record.amount),
      tax_amount: Number(record.tax_amount),
      reference_no: record.reference_no,
      notes: record.notes,
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = { ...values, expense_date: values.expense_date.format("YYYY-MM-DD") };
      if (editing) {
        const { journal } = await api.put<{ journal: { id: number } | null }>(`/expenses/${editing.id}`, payload);
        message.success(journal ? `Expense updated (Journal #${journal.id} posted)` : "Expense updated");
      } else {
        const { journal } = await api.post<{ journal: { id: number } | null }>("/expenses", payload);
        message.success(journal ? `Expense created (Journal #${journal.id} posted)` : "Expense created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save expense");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: Expense) {
    try {
      await api.delete(`/expenses/${record.id}`);
      message.success("Expense deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete expense");
    }
  }

  const columns: ColumnsType<Expense> = [
    { title: "No.", dataIndex: "expense_no", key: "expense_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Vendor", dataIndex: "vendor_name", key: "vendor_name", render: (v) => v || "-" },
    { title: "Category", dataIndex: "category_name", key: "category_name", render: (v) => v || "-" },
    {
      title: "Date",
      dataIndex: "expense_date",
      key: "expense_date",
      render: (d: string) => dayjs(d).format("DD MMM YYYY"),
    },
    {
      title: "Total",
      dataIndex: "total_amount",
      key: "total_amount",
      render: (v: string) => `Rs. ${Number(v).toFixed(2)}`,
    },
    {
      title: "Paid",
      key: "paid_amount",
      render: (_: unknown, record: Expense) => `Rs. ${Number(record.paid_amount ?? 0).toFixed(2)}`,
    },
    {
      title: "Balance Due",
      key: "balance_due",
      render: (_: unknown, record: Expense) => {
        const balance = Number(record.total_amount) - Number(record.paid_amount ?? 0);
        return <Tag color={balance > 0.001 ? "warning" : "success"}>{`Rs. ${balance.toFixed(2)}`}</Tag>;
      },
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
          {canDelete && (
            <Popconfirm title="Delete this expense?" onConfirm={() => handleDelete(record)}>
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
          Expenses
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search number, vendor, description"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 240 }}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New Expense
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={expenses}
        loading={loading}
        size="small"
        scroll={{ x: 900 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? `Edit ${editing.expense_no}` : "New Expense"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
            <Select placeholder="Select company" options={companies.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="vendor_id" label="Vendor (optional)">
            <RemoteSelect<Vendor>
              allowClear
              searchPath="/vendors"
              mapOption={(v) => ({ value: v.id, label: v.name })}
              extraOptions={vendors.map((v) => ({ value: v.id, label: v.name }))}
              placeholder="Select vendor"
            />
          </Form.Item>
          <Form.Item name="category_id" label="Category">
            <Select
              allowClear
              placeholder="Select category"
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input placeholder="e.g. Plywood purchase - August" />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              name="amount"
              label="Amount"
              rules={[{ required: true, message: "Amount is required" }]}
              style={{ width: "50%", marginBottom: 0 }}
            >
              <InputNumber style={{ width: "100%" }} min={0} />
            </Form.Item>
            <Form.Item name="tax_amount" label="Tax (GST) Amount" style={{ width: "50%", marginBottom: 0 }}>
              <InputNumber style={{ width: "100%" }} min={0} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="expense_date" label="Date" rules={[{ required: true, message: "Date is required" }]} style={{ marginTop: 16 }}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reference_no" label="Reference No (Bill/Invoice No)">
            <Input />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
