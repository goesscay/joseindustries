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
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, FilePdfOutlined, ThunderboltOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { QuickAddCustomerModal } from "../components/QuickAddCustomerModal";
import { RemoteSelect } from "../components/RemoteSelect";
import { Account, Company, Customer, OutstandingInvoice, PaymentMode, Receipt, ReceiptAllocation } from "../types";

const PAGE_SIZE = 10;

const PAYMENT_MODE_OPTIONS: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// One row of the "auto-allocate against outstanding invoices" table in the
// New Receipt modal - `applied` starts out oldest-invoice-first via
// autoFillOldestFirst, but the user can edit it directly afterward (an
// explicit override, never silently overwritten again unless they change
// the Amount Received field or hit Reset).
interface AllocationRow {
  tax_invoice_id: number;
  doc_number: string;
  issue_date: string;
  balance_due: number;
  applied: number;
}

function autoFillOldestFirst(rows: AllocationRow[], amount: number): AllocationRow[] {
  let remaining = amount;
  return rows.map((r) => {
    const applied = round2(Math.max(0, Math.min(r.balance_due, remaining)));
    remaining = round2(remaining - applied);
    return { ...r, applied };
  });
}

export function ReceiptsPage() {
  const { user, can } = useAuth();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [listCompanyFilter, setListCompanyFilter] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [quickAddCustomerOpen, setQuickAddCustomerOpen] = useState(false);
  const [editing, setEditing] = useState<Receipt | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const [allocationRows, setAllocationRows] = useState<AllocationRow[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);

  const canCreate = can("sales.receipts", "create");
  const canEdit = can("sales.receipts", "edit");
  const canDelete = can("sales.receipts", "delete");
  const canCreateCustomer = can("contacts.customers", "create");
  const selectedCustomerId = Form.useWatch("customer_id", form);
  const selectedCompanyId = Form.useWatch("company_id", form);
  const amount = Form.useWatch("amount", form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const companyParam = listCompanyFilter ? `&company_id=${listCompanyFilter}` : "";
      const res = await api.get<{ data: Receipt[]; meta: { total: number } }>(
        `/receipts?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}${companyParam}`
      );
      setReceipts(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load receipts");
    } finally {
      setLoading(false);
    }
  }, [page, search, listCompanyFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
    api.get<{ data: Account[] }>("/accounts").then((res) => setAccounts(res.data)).catch(() => {});
  }, []);

  const accountOptions = accounts
    .filter((a) => !selectedCompanyId || a.company_id === selectedCompanyId)
    .map((a) => ({ value: a.id, label: a.name }));

  // Fetches this customer's outstanding invoices (net of prior receipts and
  // Credit Notes - see receipts.ts's getOutstandingInvoices) whenever the
  // Company or Customer changes, then auto-fills oldest-invoice-first
  // against whatever Amount Received is already entered (0 the first time,
  // or the receipt's own existing amount when opening it for edit).
  const loadOutstandingInvoices = useCallback(
    async (companyId: number, customerId: number, keepApplied?: Map<number, number>) => {
      setInvoicesLoading(true);
      try {
        const excludeParam = editing ? `&exclude_receipt_id=${editing.id}` : "";
        const res = await api.get<{ data: OutstandingInvoice[] }>(
          `/receipts/outstanding-invoices?company_id=${companyId}&customer_id=${customerId}${excludeParam}`
        );
        const rows: AllocationRow[] = res.data.map((inv) => ({
          tax_invoice_id: inv.id,
          doc_number: inv.doc_number,
          issue_date: inv.issue_date,
          balance_due: inv.balance_due,
          applied: keepApplied?.get(inv.id) ?? 0,
        }));
        setAllocationRows(keepApplied ? rows : autoFillOldestFirst(rows, Number(form.getFieldValue("amount")) || 0));
      } catch (err) {
        message.error(err instanceof Error ? err.message : "Failed to load outstanding invoices");
        setAllocationRows([]);
      } finally {
        setInvoicesLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing]
  );

  useEffect(() => {
    if (selectedCompanyId && selectedCustomerId) {
      loadOutstandingInvoices(selectedCompanyId, selectedCustomerId);
    } else {
      setAllocationRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId, selectedCustomerId]);

  function reapplyAmountToRows(newAmount: number) {
    setAllocationRows((prev) => autoFillOldestFirst(prev, newAmount));
  }

  function updateRowApplied(taxInvoiceId: number, value: number) {
    setAllocationRows((prev) =>
      prev.map((r) => (r.tax_invoice_id === taxInvoiceId ? { ...r, applied: Math.max(0, Math.min(r.balance_due, value)) } : r))
    );
  }

  const totalApplied = round2(allocationRows.reduce((s, r) => s + r.applied, 0));
  const unallocated = round2((Number(amount) || 0) - totalApplied);

  // The customer dropdown is only ever populated from the first page of
  // /customers (capped server-side at 100 rows) - a customer sitting
  // outside that page has no matching option, so the Select falls back to
  // showing the raw numeric customer_id instead of a name. Fetch that one
  // customer directly and merge it in so editing a receipt always resolves
  // to a real name, regardless of how many customers exist.
  async function ensureCustomerLoaded(customerId: number) {
    if (customers.some((c) => c.id === customerId)) return;
    try {
      const res = await api.get<{ customer: Customer }>(`/customers/${customerId}`);
      setCustomers((prev) => (prev.some((c) => c.id === customerId) ? prev : [...prev, res.customer]));
    } catch {
      // Customer genuinely gone (shouldn't happen - customers with
      // existing documents can't be deleted) - leave the id showing rather
      // than fail the whole edit.
    }
  }

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      received_date: dayjs(),
      company_id: companies[0]?.id,
      payment_mode: "cash",
    });
    setAllocationRows([]);
    setModalOpen(true);
  }

  async function openEdit(record: Receipt) {
    await ensureCustomerLoaded(record.customer_id);
    setEditing(record);
    form.setFieldsValue({
      company_id: record.company_id,
      customer_id: record.customer_id,
      account_id: record.account_id,
      amount: Number(record.amount),
      payment_mode: record.payment_mode,
      reference_no: record.reference_no,
      received_date: dayjs(record.received_date),
      notes: record.notes,
    });
    setModalOpen(true);
    try {
      const res = await api.get<{ receipt: Receipt; allocations: ReceiptAllocation[] }>(`/receipts/${record.id}`);
      const keepApplied = new Map(res.allocations.map((a) => [a.tax_invoice_id, Number(a.amount)]));
      await loadOutstandingInvoices(record.company_id, record.customer_id, keepApplied);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load this receipt's invoice allocations");
    }
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const allocations = allocationRows.filter((r) => r.applied > 0).map((r) => ({ tax_invoice_id: r.tax_invoice_id, amount: r.applied }));
      const payload = { ...values, received_date: values.received_date.format("YYYY-MM-DD"), allocations };
      if (editing) {
        const { journal } = await api.put<{ journal: { id: number } | null }>(`/receipts/${editing.id}`, payload);
        message.success(journal ? `Receipt updated (Journal #${journal.id} posted)` : "Receipt updated");
      } else {
        const { journal } = await api.post<{ journal: { id: number } | null }>("/receipts", payload);
        message.success(journal ? `Receipt created (Journal #${journal.id} posted)` : "Receipt created");
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
    {
      title: "Against Invoice",
      key: "invoice_number",
      render: (_, r) =>
        Number(r.allocation_count ?? 0) > 1 ? <Tag>{r.allocation_count} invoices</Tag> : r.invoice_number || "-",
    },
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
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled title="View only" />
          )}
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
        <Space wrap>
          <Select
            placeholder="All Companies"
            allowClear
            value={listCompanyFilter}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(value) => {
              setPage(1);
              setListCompanyFilter(value);
            }}
            style={{ width: 180 }}
          />
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
              New Receipt
            </Button>
          )}
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
        width={720}
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
          <Form.Item label="Customer" required>
            <div style={{ display: "flex", gap: 8 }}>
              <Form.Item
                name="customer_id"
                rules={[{ required: true, message: "Customer is required" }]}
                style={{ flex: 1, marginBottom: 0 }}
              >
                <RemoteSelect<Customer>
                  searchPath="/customers"
                  mapOption={(c) => ({ value: c.id, label: c.name })}
                  extraOptions={customers.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Select customer"
                />
              </Form.Item>
              {canCreateCustomer && (
                <Button icon={<PlusOutlined />} onClick={() => setQuickAddCustomerOpen(true)} title="Add new customer" />
              )}
            </div>
          </Form.Item>
          <Form.Item
            name="amount"
            label="Amount Received"
            rules={[{ required: true, message: "Amount is required" }]}
          >
            <InputNumber
              style={{ width: "100%" }}
              min={0.01}
              onChange={(v) => reapplyAmountToRows(Number(v) || 0)}
            />
          </Form.Item>

          {selectedCustomerId && (
            <div style={{ marginBottom: 16 }}>
              <Space style={{ marginBottom: 8, width: "100%", justifyContent: "space-between" }}>
                <Typography.Text strong>Apply Against Outstanding Invoices</Typography.Text>
                <Button
                  size="small"
                  icon={<ThunderboltOutlined />}
                  onClick={() => reapplyAmountToRows(Number(amount) || 0)}
                >
                  Reset to Auto (Oldest First)
                </Button>
              </Space>
              <Table
                rowKey="tax_invoice_id"
                size="small"
                pagination={false}
                loading={invoicesLoading}
                dataSource={allocationRows}
                locale={{ emptyText: "No outstanding invoices for this customer" }}
                columns={[
                  { title: "Invoice", dataIndex: "doc_number", key: "doc_number" },
                  { title: "Date", dataIndex: "issue_date", key: "issue_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
                  { title: "Balance Due", dataIndex: "balance_due", key: "balance_due", align: "right", render: (v: number) => formatMoney(v) },
                  {
                    title: "Amount to Apply",
                    key: "applied",
                    width: 160,
                    render: (_, row) => (
                      <InputNumber
                        style={{ width: "100%" }}
                        min={0}
                        max={row.balance_due}
                        value={row.applied}
                        onChange={(v) => updateRowApplied(row.tax_invoice_id, Number(v) || 0)}
                      />
                    ),
                  },
                ]}
              />
              <div style={{ marginTop: 8, textAlign: "right" }}>
                <Typography.Text type="secondary">Applied: Rs. {formatMoney(totalApplied)}</Typography.Text>
                {"  "}
                <Typography.Text type={unallocated > 0.01 ? "warning" : "secondary"} strong={unallocated > 0.01}>
                  {unallocated > 0.01 ? `On Account (unapplied): Rs. ${formatMoney(unallocated)}` : ""}
                </Typography.Text>
                {unallocated < -0.01 && (
                  <Typography.Text type="danger" strong>
                    Applied exceeds amount received by Rs. {formatMoney(-unallocated)}
                  </Typography.Text>
                )}
              </div>
            </div>
          )}

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
