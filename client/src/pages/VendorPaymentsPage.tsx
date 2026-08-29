import { useCallback, useEffect, useState } from "react";
import { Table, Button, Input, Space, Modal, Form, Select, DatePicker, InputNumber, message, Popconfirm, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Account, Company, Expense, PaymentMode, Vendor, VendorPayment } from "../types";

const PAGE_SIZE = 10;

const PAYMENT_MODE_OPTIONS: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

export function VendorPaymentsPage() {
  const { user, can } = useAuth();
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VendorPayment | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canCreate = can("expenses.vendor_payments", "create");
  const canEdit = can("expenses.vendor_payments", "edit");
  const canDelete = can("expenses.vendor_payments", "delete");
  const selectedVendorId = Form.useWatch("vendor_id", form);
  const selectedCompanyId = Form.useWatch("company_id", form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: VendorPayment[]; meta: { total: number } }>(
        `/vendor-payments?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setPayments(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load vendor payments");
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
    api.get<{ data: Expense[] }>("/expenses?perPage=200").then((res) => setExpenses(res.data)).catch(() => {});
    api.get<{ data: Account[] }>("/accounts").then((res) => setAccounts(res.data)).catch(() => {});
  }, []);

  const expenseOptions = expenses
    .filter((exp) => !selectedVendorId || exp.vendor_id === selectedVendorId)
    .map((exp) => {
      const balance = Number(exp.total_amount) - Number(exp.paid_amount ?? 0);
      return { value: exp.id, label: `${exp.expense_no} - Balance Rs. ${balance.toFixed(2)}` };
    });

  const accountOptions = accounts
    .filter((a) => !selectedCompanyId || a.company_id === selectedCompanyId)
    .map((a) => ({ value: a.id, label: a.name }));

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      paid_date: dayjs(),
      company_id: companies[0]?.id,
      payment_mode: "cash",
    });
    setModalOpen(true);
  }

  function openEdit(record: VendorPayment) {
    setEditing(record);
    form.setFieldsValue({
      company_id: record.company_id,
      vendor_id: record.vendor_id,
      expense_id: record.expense_id,
      account_id: record.account_id,
      amount: Number(record.amount),
      payment_mode: record.payment_mode,
      reference_no: record.reference_no,
      paid_date: dayjs(record.paid_date),
      notes: record.notes,
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = { ...values, paid_date: values.paid_date.format("YYYY-MM-DD") };
      if (editing) {
        const { journal } = await api.put<{ journal: { id: number } | null }>(`/vendor-payments/${editing.id}`, payload);
        message.success(journal ? `Vendor payment updated (Journal #${journal.id} posted)` : "Vendor payment updated");
      } else {
        const { journal } = await api.post<{ journal: { id: number } | null }>("/vendor-payments", payload);
        message.success(journal ? `Vendor payment created (Journal #${journal.id} posted)` : "Vendor payment created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save vendor payment");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: VendorPayment) {
    try {
      await api.delete(`/vendor-payments/${record.id}`);
      message.success("Vendor payment deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete vendor payment");
    }
  }

  const columns: ColumnsType<VendorPayment> = [
    { title: "No.", dataIndex: "payment_no", key: "payment_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Vendor", dataIndex: "vendor_name", key: "vendor_name" },
    { title: "Against Expense", dataIndex: "expense_number", key: "expense_number", render: (v) => v || "-" },
    {
      title: "Date",
      dataIndex: "paid_date",
      key: "paid_date",
      render: (d: string) => dayjs(d).format("DD MMM YYYY"),
    },
    {
      title: "Mode",
      dataIndex: "payment_mode",
      key: "payment_mode",
      render: (v: PaymentMode) => PAYMENT_MODE_OPTIONS.find((o) => o.value === v)?.label ?? v,
    },
    {
      title: "Amount",
      dataIndex: "amount",
      key: "amount",
      render: (v: string) => `Rs. ${Number(v).toFixed(2)}`,
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
            <Popconfirm title="Delete this payment?" onConfirm={() => handleDelete(record)}>
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
          Vendor Payments
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
              New Payment
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={payments}
        loading={loading}
        size="small"
        scroll={{ x: 800 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? `Edit ${editing.payment_no}` : "New Vendor Payment"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
            <Select
              placeholder="Select company"
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
              onChange={() => form.setFieldsValue({ account_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: "Vendor is required" }]}>
            <Select
              showSearch
              placeholder="Select vendor"
              options={vendors.map((v) => ({ value: v.id, label: v.name }))}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
              onChange={() => form.setFieldsValue({ expense_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="expense_id" label="Against Expense (optional)">
            <Select
              allowClear
              showSearch
              placeholder="Select expense"
              options={expenseOptions}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="amount" label="Amount Paid" rules={[{ required: true, message: "Amount is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item name="payment_mode" label="Payment Mode" rules={[{ required: true }]}>
            <Select options={PAYMENT_MODE_OPTIONS} />
          </Form.Item>
          <Form.Item name="account_id" label="Paid From (Account)">
            <Select allowClear placeholder="Select account" options={accountOptions} />
          </Form.Item>
          <Form.Item name="reference_no" label="Reference No (Cheque/Transaction No)">
            <Input />
          </Form.Item>
          <Form.Item name="paid_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
