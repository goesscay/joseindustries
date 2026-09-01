import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, Select, DatePicker, InputNumber, Checkbox, message, Popconfirm, Typography, Tag, Empty } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, DeleteOutlined, FolderOpenOutlined, EyeOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Account, BankReconciliation, BankReconciliationLine, BankReconciliationWorksheet } from "../types";

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SOURCE_LABELS: Record<string, string> = {
  receipt: "Receipt",
  vendor_payment: "Vendor Payment",
  bank_cash_entry: "Journal Entry",
  account_transfer: "Transfer",
  account_opening_balance: "Opening Balance",
};

const STATUS_COLORS: Record<BankReconciliation["status"], string> = { in_progress: "processing", completed: "success" };

export function BankReconciliationPage() {
  const { can } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<number | undefined>(undefined);
  const [history, setHistory] = useState<BankReconciliation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [startOpen, setStartOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startForm] = Form.useForm();

  const [worksheet, setWorksheet] = useState<BankReconciliationWorksheet | null>(null);
  const [worksheetLoading, setWorksheetLoading] = useState(false);
  const [busyLineId, setBusyLineId] = useState<number | null>(null);
  const [completing, setCompleting] = useState(false);

  const canCreate = can("banking.reconciliation", "create");
  const canEdit = can("banking.reconciliation", "edit");
  const canDelete = can("banking.reconciliation", "delete");

  useEffect(() => {
    api.get<{ data: Account[] }>("/accounts").then((res) => {
      setAccounts(res.data);
      if (res.data.length && accountId === undefined) setAccountId(res.data[0].id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHistory = useCallback(async (id: number) => {
    setHistoryLoading(true);
    try {
      const res = await api.get<{ data: BankReconciliation[] }>(`/bank-reconciliations?account_id=${id}`);
      setHistory(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load reconciliation history");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (accountId) loadHistory(accountId);
  }, [accountId, loadHistory]);

  const hasInProgress = history.some((h) => h.status === "in_progress");

  function openStart() {
    startForm.resetFields();
    startForm.setFieldsValue({ statement_date: dayjs() });
    setStartOpen(true);
  }

  async function handleStart() {
    if (!accountId) return;
    const values = await startForm.validateFields();
    setStarting(true);
    try {
      const res = await api.post<BankReconciliationWorksheet>("/bank-reconciliations", {
        account_id: accountId,
        statement_date: values.statement_date.format("YYYY-MM-DD"),
        statement_balance: values.statement_balance,
      });
      message.success("Reconciliation started");
      setStartOpen(false);
      setWorksheet(res);
      loadHistory(accountId);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to start reconciliation");
    } finally {
      setStarting(false);
    }
  }

  async function openWorksheet(id: number) {
    setWorksheetLoading(true);
    try {
      const res = await api.get<BankReconciliationWorksheet>(`/bank-reconciliations/${id}`);
      setWorksheet(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load reconciliation");
    } finally {
      setWorksheetLoading(false);
    }
  }

  async function handleDelete(record: BankReconciliation) {
    try {
      await api.delete(`/bank-reconciliations/${record.id}`);
      message.success("Reconciliation deleted");
      if (accountId) loadHistory(accountId);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete reconciliation");
    }
  }

  async function handleReopen(id: number) {
    try {
      const res = await api.post<BankReconciliationWorksheet>(`/bank-reconciliations/${id}/reopen`);
      message.success("Reconciliation reopened");
      setWorksheet(res);
      if (accountId) loadHistory(accountId);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to reopen reconciliation");
    }
  }

  async function toggleLine(line: BankReconciliationLine, clearing: boolean) {
    if (!worksheet) return;
    setBusyLineId(line.id);
    try {
      const res = await api.patch<BankReconciliationWorksheet>(`/bank-reconciliations/${worksheet.reconciliation.id}/lines`, {
        clear: clearing ? [line.id] : [],
        unclear: clearing ? [] : [line.id],
      });
      setWorksheet(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update entry");
    } finally {
      setBusyLineId(null);
    }
  }

  async function handleComplete() {
    if (!worksheet) return;
    setCompleting(true);
    try {
      const res = await api.post<BankReconciliationWorksheet>(`/bank-reconciliations/${worksheet.reconciliation.id}/complete`);
      message.success("Reconciliation completed");
      setWorksheet(res);
      if (accountId) loadHistory(accountId);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to complete reconciliation");
    } finally {
      setCompleting(false);
    }
  }

  const historyColumns: ColumnsType<BankReconciliation> = [
    { title: "Statement Date", dataIndex: "statement_date", key: "statement_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Statement Balance", dataIndex: "statement_balance", key: "statement_balance", render: (v: string) => `Rs. ${formatMoney(Number(v))}` },
    { title: "Status", dataIndex: "status", key: "status", render: (v: BankReconciliation["status"]) => <Tag color={STATUS_COLORS[v]}>{v === "in_progress" ? "In Progress" : "Completed"}</Tag> },
    { title: "Completed", dataIndex: "completed_at", key: "completed_at", render: (v: string | null) => (v ? dayjs(v).format("DD MMM YYYY") : "-") },
    {
      title: "Actions",
      key: "actions",
      width: 160,
      render: (_, record) => (
        <Space size="small">
          {record.status === "in_progress" ? (
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => openWorksheet(record.id)} title="Open">
              Open
            </Button>
          ) : (
            <Button size="small" icon={<EyeOutlined />} onClick={() => openWorksheet(record.id)} title="View" />
          )}
          {record.status === "completed" && canEdit && (
            <Popconfirm title="Reopen this reconciliation?" description="Puts it back in progress so you can un-clear specific entries." onConfirm={() => handleReopen(record.id)}>
              <Button size="small" icon={<UndoOutlined />} title="Reopen" />
            </Popconfirm>
          )}
          {record.status === "in_progress" && canDelete && (
            <Popconfirm title="Delete this reconciliation?" description="Releases every entry it had cleared." onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} title="Delete" />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  // `isClearedTable` distinguishes which of the two tables below is being
  // rendered - the checkbox is always pre-checked in the Cleared table
  // (unchecking it un-clears the line) and always unchecked in the
  // Uncleared table (checking it clears the line).
  const lineColumns = (isClearedTable: boolean): ColumnsType<BankReconciliationLine> => [
    {
      title: "",
      key: "check",
      width: 40,
      render: (_, line) => (
        <Checkbox
          checked={isClearedTable}
          disabled={worksheet?.reconciliation.status !== "in_progress" || busyLineId === line.id}
          onChange={() => toggleLine(line, !isClearedTable)}
        />
      ),
    },
    { title: "Date", dataIndex: "journal_date", key: "journal_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Type", dataIndex: "source_type", key: "source_type", render: (v: string | null) => (v ? SOURCE_LABELS[v] ?? v : "-") },
    { title: "Particulars", dataIndex: "description", key: "description" },
    { title: "Debit", dataIndex: "debit", key: "debit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "Credit", dataIndex: "credit", key: "credit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
  ];

  const clearedBookBalance = worksheet ? round2(worksheet.openingBalance + worksheet.clearedTotal) : 0;
  function round2(n: number) {
    return Math.round(n * 100) / 100;
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Bank Reconciliation
        </Typography.Title>
        <Space>
          <Select
            style={{ width: 280 }}
            placeholder="Select account"
            value={accountId}
            onChange={(v) => {
              setAccountId(v);
              setWorksheet(null);
            }}
            options={accounts.map((a) => ({ value: a.id, label: `${a.name} (Rs. ${formatMoney(Number(a.balance ?? 0))})` }))}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openStart} disabled={!accountId || hasInProgress} title={hasInProgress ? "Finish or delete the in-progress reconciliation first" : ""}>
              Start Reconciliation
            </Button>
          )}
        </Space>
      </Space>

      <Table rowKey="id" columns={historyColumns} dataSource={history} loading={historyLoading} size="small" pagination={false} locale={{ emptyText: <Empty description="No reconciliations yet for this account" /> }} />

      <Modal title="Start Bank Reconciliation" open={startOpen} onCancel={() => setStartOpen(false)} onOk={handleStart} confirmLoading={starting} destroyOnClose>
        <Form form={startForm} layout="vertical">
          <Form.Item name="statement_date" label="Statement Date" rules={[{ required: true, message: "Statement date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="statement_balance" label="Statement Ending Balance" rules={[{ required: true, message: "Statement balance is required" }]}>
            <InputNumber style={{ width: "100%" }} placeholder="As shown on your bank statement" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={worksheet ? `Reconcile as of ${dayjs(worksheet.reconciliation.statement_date).format("DD MMM YYYY")}` : "Reconciliation"}
        open={!!worksheet}
        onCancel={() => setWorksheet(null)}
        width={900}
        footer={
          worksheet?.reconciliation.status === "in_progress" && canEdit ? (
            <Popconfirm title="Complete this reconciliation?" onConfirm={handleComplete} disabled={Math.abs(worksheet.difference) > 0.01}>
              <Button type="primary" disabled={Math.abs(worksheet.difference) > 0.01} loading={completing}>
                Complete Reconciliation
              </Button>
            </Popconfirm>
          ) : (
            <Button onClick={() => setWorksheet(null)}>Close</Button>
          )
        }
      >
        {worksheet && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Tag color={STATUS_COLORS[worksheet.reconciliation.status]}>
                {worksheet.reconciliation.status === "in_progress" ? "In Progress" : "Completed"}
              </Tag>
              <Typography.Text type="secondary">Statement Balance: Rs. {formatMoney(Number(worksheet.reconciliation.statement_balance))}</Typography.Text>
            </Space>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 16, background: "rgba(0,0,0,0.02)", padding: 12, borderRadius: 6 }}>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>Opening (already reconciled)</div>
                <div>Rs. {formatMoney(worksheet.openingBalance)}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>+ Cleared this session</div>
                <div>Rs. {formatMoney(worksheet.clearedTotal)}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>= Cleared Book Balance</div>
                <div>Rs. {formatMoney(clearedBookBalance)}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>Statement Balance</div>
                <div>Rs. {formatMoney(Number(worksheet.reconciliation.statement_balance))}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>Difference</div>
                <Typography.Text strong type={Math.abs(worksheet.difference) > 0.01 ? "danger" : "success"}>
                  Rs. {formatMoney(worksheet.difference)}
                </Typography.Text>
              </div>
            </div>

            <Typography.Text strong>Uncleared Entries</Typography.Text>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={worksheet.unclearedLines}
              columns={lineColumns(false)}
              style={{ marginBottom: 16, marginTop: 8 }}
              locale={{ emptyText: "Nothing left to clear" }}
            />

            <Typography.Text strong>Cleared Entries (this reconciliation)</Typography.Text>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={worksheet.clearedLines}
              columns={lineColumns(true)}
              style={{ marginTop: 8 }}
              locale={{ emptyText: "No entries cleared yet" }}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
