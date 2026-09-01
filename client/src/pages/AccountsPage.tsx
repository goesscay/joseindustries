import { useCallback, useEffect, useState } from "react";
import {
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Drawer,
  message,
  Popconfirm,
  Typography,
  Tag,
  Radio,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, SwapOutlined, BookOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Account, AccountType, ChartOfAccount, Company, JournalDirection, LedgerEntry } from "../types";

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SOURCE_LABELS: Record<LedgerEntry["source_type"], string> = {
  receipt: "Receipt",
  vendor_payment: "Vendor Payment",
  bank_cash_entry: "Journal Entry",
  account_transfer: "Transfer",
  account_opening_balance: "Opening Balance",
};

// An entry can only be reversed from this ledger view if it's one Phase B
// posts itself (bank_cash_entry/account_transfer) - a Receipt/Vendor
// Payment is reversed via its own module, and an opening balance is
// corrected by editing the account itself, not deleted from the ledger row.
const DELETABLE_SOURCE_TYPES: LedgerEntry["source_type"][] = ["bank_cash_entry", "account_transfer"];

export function AccountsPage() {
  const { user, can } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSaving, setTransferSaving] = useState(false);
  const [transferForm] = Form.useForm();
  const transferCompanyId = Form.useWatch("company_id", transferForm);

  const [ledgerAccount, setLedgerAccount] = useState<Account | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [ledgerOpeningBalance, setLedgerOpeningBalance] = useState(0);
  const [ledgerClosingBalance, setLedgerClosingBalance] = useState(0);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [entrySaving, setEntrySaving] = useState(false);
  const [entryForm] = Form.useForm();
  const [chartAccounts, setChartAccounts] = useState<ChartOfAccount[]>([]);

  const canCreate = can("banking.accounts", "create");
  const canEdit = can("banking.accounts", "edit");
  const canDelete = can("banking.accounts", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Account[] }>("/accounts");
      setAccounts(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
  }, []);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ company_id: companies[0]?.id, account_type: "bank", opening_balance: 0 });
    setModalOpen(true);
  }

  function openEdit(record: Account) {
    setEditing(record);
    form.setFieldsValue({
      ...record,
      opening_balance: Number(record.opening_balance),
      is_active: Boolean(record.is_active),
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/accounts/${editing.id}`, values);
        message.success("Account updated");
      } else {
        await api.post("/accounts", values);
        message.success("Account created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save account");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: Account) {
    try {
      await api.delete(`/accounts/${record.id}`);
      message.success("Account deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete account");
    }
  }

  function openTransfer() {
    transferForm.resetFields();
    transferForm.setFieldsValue({ company_id: companies[0]?.id, entry_date: dayjs() });
    setTransferOpen(true);
  }

  async function handleTransferSubmit() {
    const values = await transferForm.validateFields();
    setTransferSaving(true);
    try {
      await api.post("/account-transfers", {
        from_account_id: values.from_account_id,
        to_account_id: values.to_account_id,
        amount: values.amount,
        entry_date: values.entry_date.format("YYYY-MM-DD"),
        notes: values.notes,
      });
      message.success("Transfer recorded");
      setTransferOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to record transfer");
    } finally {
      setTransferSaving(false);
    }
  }

  const loadLedger = useCallback(async (accountId: number) => {
    setLedgerLoading(true);
    try {
      const res = await api.get<{
        account: Account;
        openingBalance: number;
        entries: LedgerEntry[];
        closingBalance: number;
      }>(`/accounts/${accountId}/ledger`);
      setLedgerAccount(res.account);
      setLedgerEntries(res.entries);
      setLedgerOpeningBalance(res.openingBalance);
      setLedgerClosingBalance(res.closingBalance);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load ledger");
    } finally {
      setLedgerLoading(false);
    }
  }, []);

  function openLedger(record: Account) {
    setLedgerAccount(record);
    loadLedger(record.id);
    api
      .get<{ data: ChartOfAccount[] }>(`/chart-of-accounts?company_id=${record.company_id}`)
      .then((res) => setChartAccounts(res.data))
      .catch(() => {});
  }

  // Same "true leaf" filter as the Journal Entries page (Phase A) - a
  // contra account can be any postable account except a summary/header
  // node (1000 Assets, 1100 Current Assets, ...), identified as "any
  // account that is itself someone else's parent_id".
  const parentIds = new Set(chartAccounts.filter((a) => a.parent_id).map((a) => a.parent_id as number));
  const contraAccountOptions = chartAccounts
    .filter((a) => a.is_active && !parentIds.has(a.id))
    .map((a) => ({ value: a.id, label: `${a.account_code} - ${a.name}` }));

  function openAddEntry() {
    entryForm.resetFields();
    entryForm.setFieldsValue({ entry_date: dayjs(), direction: "out" });
    setEntryModalOpen(true);
  }

  async function handleEntrySubmit() {
    if (!ledgerAccount) return;
    const values = await entryForm.validateFields();
    setEntrySaving(true);
    try {
      await api.post("/bank-cash-entries", {
        account_id: ledgerAccount.id,
        contra_account_id: values.contra_account_id,
        entry_date: values.entry_date.format("YYYY-MM-DD"),
        direction: values.direction,
        amount: values.amount,
        particulars: values.particulars,
        notes: values.notes,
      });
      message.success("Journal entry added");
      setEntryModalOpen(false);
      loadLedger(ledgerAccount.id);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to add entry");
    } finally {
      setEntrySaving(false);
    }
  }

  async function handleDeleteEntry(entry: LedgerEntry) {
    if (!ledgerAccount || !DELETABLE_SOURCE_TYPES.includes(entry.source_type)) return;
    const path = entry.source_type === "account_transfer" ? "account-transfers" : "bank-cash-entries";
    try {
      await api.delete(`/${path}/${entry.source_id}`);
      message.success("Entry deleted");
      loadLedger(ledgerAccount.id);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete entry");
    }
  }

  const accountOptions = (companyId: number | undefined) =>
    accounts
      .filter((a) => !companyId || a.company_id === companyId)
      .map((a) => ({ value: a.id, label: `${a.name} (Rs. ${formatMoney(Number(a.balance ?? 0))})` }));

  const columns: ColumnsType<Account> = [
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Name", dataIndex: "name", key: "name" },
    {
      title: "Type",
      dataIndex: "account_type",
      key: "account_type",
      width: 90,
      render: (v: AccountType) => <Tag>{v === "cash" ? "Cash" : "Bank"}</Tag>,
    },
    {
      title: "Bank Details",
      key: "bank_details",
      render: (_, record) =>
        record.account_type === "bank" ? (
          <span style={{ fontSize: 12, color: "#666" }}>
            {record.bank_name} {record.account_number ? `- ${record.account_number}` : ""}
          </span>
        ) : (
          "-"
        ),
    },
    {
      title: "Balance",
      key: "balance",
      render: (_, record) => (
        <Typography.Text strong={Number(record.balance ?? 0) < 0} type={Number(record.balance ?? 0) < 0 ? "danger" : undefined}>
          Rs. {formatMoney(Number(record.balance ?? 0))}
        </Typography.Text>
      ),
    },
    {
      title: "Actions",
      key: "actions",
      width: 160,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<BookOutlined />} onClick={() => openLedger(record)} title="View Ledger" />
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled title="View only" />
          )}
          {canDelete && (
            <Popconfirm title="Delete this account?" onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const ledgerColumns: ColumnsType<LedgerEntry> = [
    { title: "Date", dataIndex: "entry_date", key: "entry_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Type", dataIndex: "source_type", key: "source_type", render: (v: LedgerEntry["source_type"]) => SOURCE_LABELS[v] },
    { title: "Particulars", dataIndex: "particulars", key: "particulars" },
    {
      title: "In",
      key: "in",
      align: "right",
      render: (_, record) => (record.direction === "in" ? formatMoney(record.amount) : ""),
    },
    {
      title: "Out",
      key: "out",
      align: "right",
      render: (_, record) => (record.direction === "out" ? formatMoney(record.amount) : ""),
    },
    {
      title: "Balance",
      dataIndex: "running_balance",
      key: "running_balance",
      align: "right",
      render: (v: number) => formatMoney(v),
    },
    {
      title: "",
      key: "actions",
      width: 40,
      render: (_, record) =>
        DELETABLE_SOURCE_TYPES.includes(record.source_type) && canDelete ? (
          <Popconfirm title="Delete this entry?" onConfirm={() => handleDeleteEntry(record)}>
            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Bank &amp; Cash Accounts
        </Typography.Title>
        <Space>
          <Button icon={<SwapOutlined />} onClick={openTransfer}>
            Transfer
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add Account
            </Button>
          )}
        </Space>
      </Space>

      <Table rowKey="id" columns={columns} dataSource={accounts} loading={loading} size="small" scroll={{ x: 760 }} pagination={false} />

      <Modal
        title={editing ? "Edit Account" : "Add Account"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
            <Select placeholder="Select company" options={companies.map((c) => ({ value: c.id, label: c.name }))} disabled={!!editing} />
          </Form.Item>
          <Form.Item name="account_type" label="Type" rules={[{ required: true }]}>
            <Radio.Group options={[{ label: "Bank", value: "bank" }, { label: "Cash", value: "cash" }]} />
          </Form.Item>
          <Form.Item name="name" label="Account Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input placeholder="e.g. HDFC Current Account" />
          </Form.Item>
          <Form.Item name="bank_name" label="Bank Name">
            <Input />
          </Form.Item>
          <Form.Item name="account_number" label="Account No.">
            <Input />
          </Form.Item>
          <Form.Item name="ifsc" label="IFSC Code">
            <Input />
          </Form.Item>
          <Form.Item name="opening_balance" label="Opening Balance">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Transfer Between Accounts"
        open={transferOpen}
        onCancel={() => setTransferOpen(false)}
        onOk={handleTransferSubmit}
        confirmLoading={transferSaving}
        destroyOnClose
      >
        <Form form={transferForm} layout="vertical" size="middle">
          <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
            <Select
              placeholder="Select company"
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
              onChange={() => transferForm.setFieldsValue({ from_account_id: undefined, to_account_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="from_account_id" label="From Account" rules={[{ required: true, message: "Source account is required" }]}>
            <Select placeholder="Select account" options={accountOptions(transferCompanyId)} />
          </Form.Item>
          <Form.Item name="to_account_id" label="To Account" rules={[{ required: true, message: "Destination account is required" }]}>
            <Select placeholder="Select account" options={accountOptions(transferCompanyId)} />
          </Form.Item>
          <Form.Item name="amount" label="Amount" rules={[{ required: true, message: "Amount is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item name="entry_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={ledgerAccount ? `${ledgerAccount.name} - Ledger` : "Ledger"}
        open={!!ledgerAccount}
        onClose={() => setLedgerAccount(null)}
        width={720}
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={openAddEntry}>
            Add Entry
          </Button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Typography.Text>Opening Balance: Rs. {formatMoney(ledgerOpeningBalance)}</Typography.Text>
          <br />
          <Typography.Text strong>Closing Balance: Rs. {formatMoney(ledgerClosingBalance)}</Typography.Text>
        </div>
        <Table
          rowKey={(r) => `${r.source_type}-${r.source_id}`}
          columns={ledgerColumns}
          dataSource={ledgerEntries}
          loading={ledgerLoading}
          size="small"
          pagination={false}
          scroll={{ x: 600 }}
        />
      </Drawer>

      <Modal
        title="Add Journal Entry"
        open={entryModalOpen}
        onCancel={() => setEntryModalOpen(false)}
        onOk={handleEntrySubmit}
        confirmLoading={entrySaving}
        destroyOnClose
      >
        <Form form={entryForm} layout="vertical" size="middle">
          <Form.Item name="direction" label="Direction" rules={[{ required: true }]}>
            <Radio.Group options={[{ label: "Money In", value: "in" as JournalDirection }, { label: "Money Out", value: "out" as JournalDirection }]} />
          </Form.Item>
          <Form.Item
            name="contra_account_id"
            label="Account (the other side of this entry)"
            rules={[{ required: true, message: "Select which account this money moved against" }]}
          >
            <Select
              showSearch
              placeholder="e.g. Bank Charges, Interest Income, Capital"
              options={contraAccountOptions}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="particulars" label="Particulars" rules={[{ required: true, message: "Particulars is required" }]}>
            <Input placeholder="e.g. Bank charges, Owner's capital, Petty cash withdrawal" />
          </Form.Item>
          <Form.Item name="amount" label="Amount" rules={[{ required: true, message: "Amount is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item name="entry_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
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
