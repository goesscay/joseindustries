import { useCallback, useEffect, useState } from "react";
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
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, FilePdfOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Account, Company, Customer, PaymentMode, Receipt, SalesDocument } from "../types";

const PAGE_SIZE = 10;

const PAYMENT_MODE_OPTIONS: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

export function ReceiptsPage() {
  const { user } = useAuth();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<SalesDocument[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Receipt | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canDelete = user?.role === "super_admin" || user?.role === "admin";
  const selectedCustomerId = Form.useWatch("customer_id", form);
  const selectedCompanyId = Form.useWatch("company_id", form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Receipt[]; meta: { total: number } }>(
        `/receipts?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setReceipts(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load receipts");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
    api.get<{ data: Customer[] }>("/customers?perPage=200").then((res) => setCustomers(res.data)).catch(() => {});
    api
      .get<{ data: SalesDocument[] }>("/tax-invoices?perPage=200")
      .then((res) => setInvoices(res.data))
      .catch(() => {});
    api.get<{ data: Account[] }>("/accounts").then((res) => setAccounts(res.data)).catch(() => {});
  }, []);

  const invoiceOptions = invoices
    .filter((inv) => !selectedCustomerId || inv.customer_id === selectedCustomerId)
    .map((inv) => {
      const balance = Number(inv.grand_total) - Number(inv.paid_amount ?? 0);
      return { value: inv.id, label: `${inv.doc_number} - Balance Rs. ${balance.toFixed(2)}` };
    });

  const accountOptions = accounts
    .filter((a) => !selectedCompanyId || a.company_id === selectedCompanyId)
    .map((a) => ({ value: a.id, label: a.name }));

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      received_date: dayjs(),
      company_id: companies[0]?.id,
      payment_mode: "cash",
    });
    setModalOpen(true);
  }

  function openEdit(record: Receipt) {
    setEditing(record);
    form.setFieldsValue({
      company_id: record.company_id,
      customer_id: record.customer_id,
      tax_invoice_id: record.tax_invoice_id,
      account_id: record.account_id,
      amount: Number(record.amount),
      payment_mode: record.payment_mode,
      reference_no: record.reference_no,
      received_date: dayjs(record.received_date),
      notes: record.notes,
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = { ...values, received_date: values.received_date.format("YYYY-MM-DD") };
      if (editing) {
        await api.put(`/receipts/${editing.id}`, payload);
        message.success("Receipt updated");
      } else {
        await api.post("/receipts", payload);
        message.success("Receipt created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save receipt");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: Receipt) {
    try {
      await api.delete(`/receipts/${record.id}`);
      message.success("Receipt deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete receipt");
    }
  }

  function downloadPdf(record: Receipt) {
    window.open(`/api/receipts/${record.id}/pdf`, "_blank");
  }

  const columns: ColumnsType<Receipt> = [
    { title: "No.", dataIndex: "receipt_no", key: "receipt_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Customer", dataIndex: "customer_name", key: "customer_name" },
    { title: "Against Invoice", dataIndex: "invoice_number", key: "invoice_number", render: (v) => v || "-" },
    {
      title: "Date",
      dataIndex: "received_date",
      key: "received_date",
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
      width: 130,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Button size="small" icon={<FilePdfOutlined />} onClick={() => downloadPdf(record)} />
          {canDelete && (
            <Popconfirm title="Delete this receipt?" onConfirm={() => handleDelete(record)}>
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
          Receipts
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
            New Receipt
          </Button>
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={receipts}
        loading={loading}
        size="small"
        scroll={{ x: 780 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? `Edit ${editing.receipt_no}` : "New Receipt"}
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
          <Form.Item name="customer_id" label="Customer" rules={[{ required: true, message: "Customer is required" }]}>
            <Select
              showSearch
              placeholder="Select customer"
              options={customers.map((c) => ({ value: c.id, label: c.name }))}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
              onChange={() => form.setFieldsValue({ tax_invoice_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="tax_invoice_id" label="Against Tax Invoice (optional)">
            <Select allowClear showSearch placeholder="Select invoice" options={invoiceOptions} filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())} />
          </Form.Item>
          <Form.Item name="amount" label="Amount Received" rules={[{ required: true, message: "Amount is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item name="payment_mode" label="Payment Mode" rules={[{ required: true }]}>
            <Select options={PAYMENT_MODE_OPTIONS} />
          </Form.Item>
          <Form.Item name="account_id" label="Deposited To (Account)">
            <Select allowClear placeholder="Select account" options={accountOptions} />
          </Form.Item>
          <Form.Item name="reference_no" label="Reference No (Cheque/Transaction No)">
            <Input />
          </Form.Item>
          <Form.Item name="received_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
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
