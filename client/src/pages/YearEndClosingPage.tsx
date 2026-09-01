import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Typography, Tag, Alert } from "antd";
import type { ColumnsType } from "antd/es/table";
import { LockOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company, FinancialYearClosing, FinancialYearClosingStatusInfo } from "../types";

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_COLORS: Record<FinancialYearClosing["status"], string> = { closed: "success", reopened: "default" };

export function YearEndClosingPage() {
  const { can } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>(undefined);
  const [history, setHistory] = useState<FinancialYearClosing[]>([]);
  const [status, setStatus] = useState<FinancialYearClosingStatusInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeForm] = Form.useForm();

  const canCreate = can("accounting.year_end_closing", "create");
  const canEdit = can("accounting.year_end_closing", "edit");

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => {
      setCompanies(res.data);
      if (res.data.length && companyId === undefined) setCompanyId(res.data[0].id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    try {
      const [historyRes, statusRes] = await Promise.all([
        api.get<{ data: FinancialYearClosing[] }>(`/financial-year-closings?company_id=${id}`),
        api.get<FinancialYearClosingStatusInfo>(`/financial-year-closings/status?company_id=${id}`),
      ]);
      setHistory(historyRes.data);
      setStatus(statusRes);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load year-end closing data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (companyId) load(companyId);
  }, [companyId, load]);

  function openClose() {
    closeForm.resetFields();
    closeForm.setFieldsValue({ financial_year: status?.suggestedFinancialYear });
    setCloseOpen(true);
  }

  async function handleClose() {
    if (!companyId) return;
    const values = await closeForm.validateFields();
    setClosing(true);
    try {
      const res = await api.post<{ closing: FinancialYearClosing }>("/financial-year-closings", {
        company_id: companyId,
        financial_year: values.financial_year,
      });
      message.success(
        `Financial year ${res.closing.financial_year} closed. Net ${Number(res.closing.net_profit) >= 0 ? "profit" : "loss"}: Rs. ${formatMoney(Math.abs(Number(res.closing.net_profit)))}${res.closing.closing_journal_id ? ` (Journal #${res.closing.closing_journal_id})` : ""}`
      );
      setCloseOpen(false);
      load(companyId);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to close financial year");
    } finally {
      setClosing(false);
    }
  }

  async function handleReopen(record: FinancialYearClosing) {
    try {
      await api.post(`/financial-year-closings/${record.id}/reopen`);
      message.success(`Financial year ${record.financial_year} reopened`);
      if (companyId) load(companyId);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to reopen financial year");
    }
  }

  const latestClosedId = history.find((h) => h.status === "closed" && h.financial_year === status?.latestClosedFinancialYear)?.id;

  const columns: ColumnsType<FinancialYearClosing> = [
    { title: "Financial Year", dataIndex: "financial_year", key: "financial_year" },
    { title: "Period", key: "period", render: (_, r) => `${dayjs(r.start_date).format("DD MMM YYYY")} - ${dayjs(r.end_date).format("DD MMM YYYY")}` },
    { title: "Status", dataIndex: "status", key: "status", render: (v: FinancialYearClosing["status"]) => <Tag color={STATUS_COLORS[v]}>{v === "closed" ? "Closed" : "Reopened"}</Tag> },
    {
      title: "Net Profit/(Loss)",
      dataIndex: "net_profit",
      key: "net_profit",
      align: "right",
      render: (v: string) => {
        const n = Number(v);
        return (
          <Typography.Text type={n < 0 ? "danger" : undefined}>
            Rs. {formatMoney(Math.abs(n))} {n < 0 ? "(Loss)" : ""}
          </Typography.Text>
        );
      },
    },
    { title: "Closed On", dataIndex: "closed_at", key: "closed_at", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    {
      title: "Actions",
      key: "actions",
      width: 100,
      render: (_, record) =>
        canEdit && record.status === "closed" && record.id === latestClosedId ? (
          <Popconfirm
            title="Reopen this financial year?"
            description="Reverses its closing journal so corrections can be made. Close it again afterward."
            onConfirm={() => handleReopen(record)}
          >
            <Button size="small" icon={<UndoOutlined />} title="Reopen">
              Reopen
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Year-End Closing
        </Typography.Title>
        <Space>
          <Select
            style={{ width: 220 }}
            placeholder="Select company"
            value={companyId}
            onChange={setCompanyId}
            options={companies.map((c) => ({ value: c.id, label: c.name }))}
          />
          {canCreate && (
            <Button type="primary" icon={<LockOutlined />} onClick={openClose}>
              Close Financial Year
            </Button>
          )}
        </Space>
      </Space>

      {status && (
        <Alert
          style={{ marginBottom: 16 }}
          type={status.lockedThroughDate ? "info" : "warning"}
          showIcon
          message={
            status.lockedThroughDate
              ? `Books are locked through ${dayjs(status.lockedThroughDate).format("DD MMM YYYY")} (FY ${status.latestClosedFinancialYear}). Nothing dated on or before this can be created, edited, or reversed.`
              : "No financial year has been closed yet for this company - the books are fully open."
          }
        />
      )}

      <Table rowKey="id" columns={columns} dataSource={history} loading={loading} size="small" pagination={false} locale={{ emptyText: "No financial years closed yet" }} />

      <Modal title="Close Financial Year" open={closeOpen} onCancel={() => setCloseOpen(false)} footer={null} destroyOnClose>
        <Form form={closeForm} layout="vertical">
          <Form.Item
            name="financial_year"
            label="Financial Year"
            rules={[{ required: true, message: "Financial year is required" }, { pattern: /^\d{2}-\d{2}$/, message: 'Must look like "25-26"' }]}
          >
            <Input placeholder="e.g. 25-26" />
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="This posts a closing journal that zeroes all Revenue/Expense activity for this financial year into Retained Earnings, then locks the entire period - nothing dated on or before its end date can be created, edited, or reversed afterward without reopening it again."
          />
          <Popconfirm title="Close this financial year?" description="This action locks the period against changes." onConfirm={handleClose}>
            <Button type="primary" danger loading={closing} block>
              Close Financial Year
            </Button>
          </Popconfirm>
        </Form>
      </Modal>
    </div>
  );
}
