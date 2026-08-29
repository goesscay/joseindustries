import { useEffect, useMemo, useState } from "react";
import { Tabs, Select, DatePicker, Radio, Table, Typography, Space, Button, message, Statistic, Row, Col, Card, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import { api } from "../api/client";
import {
  BalanceSheetResult,
  BalanceSheetRow,
  CashFlowResult,
  ChartOfAccount,
  Company,
  Customer,
  GeneralLedgerEntry,
  GeneralLedgerResult,
  LedgerAccountType,
  ProfitAndLossResult,
  ProfitAndLossRow,
  TrialBalanceResult,
  TrialBalanceRow,
  Vendor,
} from "../types";

const { RangePicker } = DatePicker;

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function useCompaniesAndParties() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
    api.get<{ data: Customer[] }>("/customers?perPage=500").then((res) => setCustomers(res.data)).catch(() => {});
    api.get<{ data: Vendor[] }>("/vendors?perPage=500").then((res) => setVendors(res.data)).catch(() => {});
  }, []);

  return { companies, customers, vendors };
}

interface DayBookEntry {
  entry_date: string;
  source_type: "receipt" | "vendor_payment" | "journal_entry";
  account_name: string;
  direction: "in" | "out";
  amount: number;
  particulars: string;
}

const SOURCE_LABELS: Record<DayBookEntry["source_type"], string> = {
  receipt: "Receipt",
  vendor_payment: "Vendor Payment",
  journal_entry: "Journal Entry",
};

function DayBookTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<DayBookEntry[]>([]);
  const [totals, setTotals] = useState({ totalIn: 0, totalOut: 0, net: 0 });

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  async function load() {
    if (!companyId) return;
    setLoading(true);
    try {
      const res = await api.get<{ entries: DayBookEntry[]; totalIn: number; totalOut: number; net: number }>(
        `/reports/day-book?company_id=${companyId}&from=${range[0].format("YYYY-MM-DD")}&to=${range[1].format("YYYY-MM-DD")}`
      );
      setEntries(res.entries);
      setTotals({ totalIn: res.totalIn, totalOut: res.totalOut, net: res.net });
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load day book");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range]);

  const columns: ColumnsType<DayBookEntry> = [
    { title: "Date", dataIndex: "entry_date", key: "entry_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Account", dataIndex: "account_name", key: "account_name" },
    { title: "Type", dataIndex: "source_type", key: "source_type", render: (v: DayBookEntry["source_type"]) => SOURCE_LABELS[v] },
    { title: "Particulars", dataIndex: "particulars", key: "particulars" },
    { title: "In", key: "in", align: "right", render: (_, r) => (r.direction === "in" ? formatMoney(r.amount) : "") },
    { title: "Out", key: "out", align: "right", render: (_, r) => (r.direction === "out" ? formatMoney(r.amount) : "") },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <RangePicker
          value={range}
          format="DD MMM YYYY"
          onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])}
          allowClear={false}
        />
      </Space>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={8}>
          <Card size="small">
            <Statistic title="Total In" value={totals.totalIn} precision={2} prefix="Rs." />
          </Card>
        </Col>
        <Col xs={8}>
          <Card size="small">
            <Statistic title="Total Out" value={totals.totalOut} precision={2} prefix="Rs." />
          </Card>
        </Col>
        <Col xs={8}>
          <Card size="small">
            <Statistic
              title="Net"
              value={totals.net}
              precision={2}
              prefix="Rs."
              valueStyle={{ color: totals.net >= 0 ? "#3f8600" : "#cf1322" }}
            />
          </Card>
        </Col>
      </Row>

      <Table rowKey={(_, i) => String(i)} columns={columns} dataSource={entries} loading={loading} size="small" pagination={false} scroll={{ x: 700 }} />
    </div>
  );
}

interface PartyLedgerEntry {
  entry_date: string;
  doc_number: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

function PartyLedgerTab({ customers, vendors }: { customers: Customer[]; vendors: Vendor[] }) {
  const [partyType, setPartyType] = useState<"customer" | "vendor">("customer");
  const [partyId, setPartyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("year"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [closingBalance, setClosingBalance] = useState(0);
  const [entries, setEntries] = useState<PartyLedgerEntry[]>([]);

  useEffect(() => {
    setPartyId(undefined);
  }, [partyType]);

  async function load() {
    if (!partyId) return;
    setLoading(true);
    try {
      const res = await api.get<{ openingBalance: number; entries: PartyLedgerEntry[]; closingBalance: number }>(
        `/reports/party-ledger?type=${partyType}&id=${partyId}&from=${range[0].format("YYYY-MM-DD")}&to=${range[1].format("YYYY-MM-DD")}`
      );
      setOpeningBalance(res.openingBalance);
      setEntries(res.entries);
      setClosingBalance(res.closingBalance);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load party ledger");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, range]);

  const partyOptions =
    partyType === "customer" ? customers.map((c) => ({ value: c.id, label: c.name })) : vendors.map((v) => ({ value: v.id, label: v.name }));

  const columns: ColumnsType<PartyLedgerEntry> = [
    { title: "Date", dataIndex: "entry_date", key: "entry_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "No.", dataIndex: "doc_number", key: "doc_number" },
    { title: "Description", dataIndex: "description", key: "description" },
    { title: "Debit", dataIndex: "debit", key: "debit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "Credit", dataIndex: "credit", key: "credit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "Balance", dataIndex: "balance", key: "balance", align: "right", render: (v: number) => formatMoney(v) },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Radio.Group value={partyType} onChange={(e) => setPartyType(e.target.value)}>
          <Radio.Button value="customer">Customer</Radio.Button>
          <Radio.Button value="vendor">Vendor</Radio.Button>
        </Radio.Group>
        <Select
          placeholder={`Select ${partyType}`}
          style={{ width: 240 }}
          value={partyId}
          showSearch
          options={partyOptions}
          filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
          onChange={setPartyId}
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {partyId && (
        <>
          <Typography.Text>Opening Balance: Rs. {formatMoney(openingBalance)}</Typography.Text>
          <br />
          <Typography.Text strong>
            Closing Balance: Rs. {formatMoney(closingBalance)} {closingBalance > 0.01 ? `(${partyType === "customer" ? "receivable" : "payable"})` : ""}
          </Typography.Text>
          <Table
            rowKey={(_, i) => String(i)}
            columns={columns}
            dataSource={entries}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 600 }}
            style={{ marginTop: 12 }}
          />
        </>
      )}
    </div>
  );
}

// Built entirely from the double-entry ledger (journals + journal_lines +
// chart_of_accounts) via /api/accounting/profit-loss (Phase 8) - never from
// documents/expenses directly. Income = Credit - Debit on revenue accounts,
// Expense = Debit - Credit on expense accounts - GST/Accounts Receivable/
// Accounts Payable/Bank/Cash never appear, since they're asset/liability
// accounts excluded by the backend query itself, not by anything filtered
// here.
function ProfitLossTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("year"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ProfitAndLossResult | null>(null);

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  async function load() {
    if (!companyId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        company_id: String(companyId),
        from: range[0].format("YYYY-MM-DD"),
        to: range[1].format("YYYY-MM-DD"),
      });
      const res = await api.get<ProfitAndLossResult>(`/accounting/profit-loss?${params.toString()}`);
      setData(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load profit & loss");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range]);

  const columns: ColumnsType<ProfitAndLossRow> = [
    { title: "Account Code", dataIndex: "account_code", key: "account_code", width: 110 },
    { title: "Account Name", dataIndex: "name", key: "name" },
    { title: "Amount", dataIndex: "amount", key: "amount", align: "right", render: (v: number) => `Rs. ${formatMoney(v)}` },
  ];

  function summaryRow(total: number) {
    return () => (
      <Table.Summary fixed>
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={2}>
            <b>Total</b>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={1} align="right">
            <b>Rs. {formatMoney(total)}</b>
          </Table.Summary.Cell>
        </Table.Summary.Row>
      </Table.Summary>
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {data && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={8}>
              <Card size="small">
                <Statistic title="Total Income" value={data.totalIncome} precision={2} prefix="Rs." valueStyle={{ color: "#3f8600" }} />
              </Card>
            </Col>
            <Col xs={8}>
              <Card size="small">
                <Statistic title="Total Expenses" value={data.totalExpenses} precision={2} prefix="Rs." valueStyle={{ color: "#cf1322" }} />
              </Card>
            </Col>
            <Col xs={8}>
              <Card size="small">
                <Statistic
                  title="Net Profit"
                  value={data.netProfit}
                  precision={2}
                  prefix="Rs."
                  valueStyle={{ color: data.netProfit >= 0 ? "#3f8600" : "#cf1322" }}
                />
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5}>Income</Typography.Title>
          <Table
            rowKey="account_id"
            columns={columns}
            dataSource={data.income}
            loading={loading}
            size="small"
            pagination={false}
            summary={summaryRow(data.totalIncome)}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Expenses
          </Typography.Title>
          <Table
            rowKey="account_id"
            columns={columns}
            dataSource={data.expenses}
            loading={loading}
            size="small"
            pagination={false}
            summary={summaryRow(data.totalExpenses)}
          />
        </>
      )}
    </div>
  );
}

function GstSummaryTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ outputCgst: number; outputSgst: number; outputIgst: number; outputTotal: number; inputGst: number; netPayable: number } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: range[0].format("YYYY-MM-DD"), to: range[1].format("YYYY-MM-DD") });
      if (companyId) params.set("company_id", String(companyId));
      const res = await api.get<typeof data>(`/reports/gst-summary?${params.toString()}`);
      setData(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load GST summary");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range]);

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="All Companies"
          allowClear
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {data && (
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Card size="small" loading={loading}>
              <Statistic title="Output CGST" value={data.outputCgst} precision={2} prefix="Rs." />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small" loading={loading}>
              <Statistic title="Output SGST" value={data.outputSgst} precision={2} prefix="Rs." />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small" loading={loading}>
              <Statistic title="Output IGST" value={data.outputIgst} precision={2} prefix="Rs." />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small" loading={loading}>
              <Statistic title="Output GST Total" value={data.outputTotal} precision={2} prefix="Rs." />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small" loading={loading}>
              <Statistic title="Input GST (Expenses)" value={data.inputGst} precision={2} prefix="Rs." />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small" loading={loading}>
              <Statistic
                title="Net GST Payable"
                value={data.netPayable}
                precision={2}
                prefix="Rs."
                valueStyle={{ color: data.netPayable >= 0 ? "#cf1322" : "#3f8600" }}
              />
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}

interface OutstandingRow {
  id: number;
  doc_number: string;
  party_name: string;
  date: string;
  total: number;
  paid: number;
  balance: number;
}

function OutstandingTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [receivables, setReceivables] = useState<OutstandingRow[]>([]);
  const [payables, setPayables] = useState<OutstandingRow[]>([]);
  const [totalReceivable, setTotalReceivable] = useState(0);
  const [totalPayable, setTotalPayable] = useState(0);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (companyId) params.set("company_id", String(companyId));
      const res = await api.get<{ receivables: OutstandingRow[]; totalReceivable: number; payables: OutstandingRow[]; totalPayable: number }>(
        `/reports/outstanding?${params.toString()}`
      );
      setReceivables(res.receivables);
      setPayables(res.payables);
      setTotalReceivable(res.totalReceivable);
      setTotalPayable(res.totalPayable);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load outstanding report");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const columns: ColumnsType<OutstandingRow> = [
    { title: "No.", dataIndex: "doc_number", key: "doc_number" },
    { title: "Party", dataIndex: "party_name", key: "party_name" },
    { title: "Date", dataIndex: "date", key: "date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Total", dataIndex: "total", key: "total", align: "right", render: (v: number) => formatMoney(v) },
    { title: "Paid", dataIndex: "paid", key: "paid", align: "right", render: (v: number) => formatMoney(v) },
    { title: "Balance", dataIndex: "balance", key: "balance", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="All Companies"
          allowClear
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <Button onClick={load}>Refresh</Button>
      </Space>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12}>
          <Card size="small">
            <Statistic title="Total Receivable" value={totalReceivable} precision={2} prefix="Rs." valueStyle={{ color: "#3f8600" }} />
          </Card>
        </Col>
        <Col xs={12}>
          <Card size="small">
            <Statistic title="Total Payable" value={totalPayable} precision={2} prefix="Rs." valueStyle={{ color: "#cf1322" }} />
          </Card>
        </Col>
      </Row>

      <Typography.Title level={5}>Outstanding Receivables (unpaid Tax Invoices)</Typography.Title>
      <Table rowKey="id" columns={columns} dataSource={receivables} loading={loading} size="small" pagination={false} scroll={{ x: 600 }} />

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        Outstanding Payables (unpaid Expenses)
      </Typography.Title>
      <Table rowKey="id" columns={columns} dataSource={payables} loading={loading} size="small" pagination={false} scroll={{ x: 600 }} />
    </div>
  );
}

const ACCOUNT_TYPE_LABELS: Record<LedgerAccountType, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

const GL_SOURCE_LABELS: Record<string, string> = {
  receipt: "Receipt",
  vendor_payment: "Vendor Payment",
  tax_invoice: "Tax Invoice",
};

// Built from the double-entry ledger (journals + journal_lines +
// chart_of_accounts) via /api/accounting/general-ledger - not from the
// ad-hoc source-table queries the other tabs on this page use. Only
// transactions already posted to that ledger (Phase 3 receipts/vendor
// payments, Phase 4 tax invoices) appear here - historical documents from
// before those phases were wired in do not, by design (no backfill).
function GeneralLedgerTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [typeFilter, setTypeFilter] = useState<LedgerAccountType | undefined>();
  const [accountId, setAccountId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GeneralLedgerResult | null>(null);

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  useEffect(() => {
    if (!companyId) return;
    api
      .get<{ data: ChartOfAccount[] }>(`/chart-of-accounts?company_id=${companyId}`)
      .then((res) => {
        setAccounts(res.data);
        setAccountId(undefined);
        setResult(null);
      })
      .catch(() => {});
  }, [companyId]);

  const filteredAccounts = useMemo(
    () => (typeFilter ? accounts.filter((a) => a.account_type === typeFilter) : accounts),
    [accounts, typeFilter]
  );

  async function load() {
    if (!companyId || !accountId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        company_id: String(companyId),
        account_id: String(accountId),
        from: range[0].format("YYYY-MM-DD"),
        to: range[1].format("YYYY-MM-DD"),
      });
      const res = await api.get<GeneralLedgerResult>(`/accounting/general-ledger?${params.toString()}`);
      setResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load general ledger");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, accountId, range]);

  const columns: ColumnsType<GeneralLedgerEntry> = [
    { title: "Date", dataIndex: "journal_date", key: "journal_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Reference", dataIndex: "reference", key: "reference", render: (v: string | null) => v || "-" },
    {
      title: "Source",
      dataIndex: "source_type",
      key: "source_type",
      render: (v: string | null) => (v ? GL_SOURCE_LABELS[v] ?? v : "Manual"),
    },
    { title: "Description", dataIndex: "description", key: "description", render: (v: string | null) => v || "-" },
    { title: "Debit", dataIndex: "debit", key: "debit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "Credit", dataIndex: "credit", key: "credit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    {
      title: "Balance",
      dataIndex: "running_balance",
      key: "running_balance",
      align: "right",
      render: (v: number) => <b>{formatMoney(v)}</b>,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 180 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <Select
          placeholder="All Account Types"
          allowClear
          style={{ width: 170 }}
          value={typeFilter}
          options={(Object.keys(ACCOUNT_TYPE_LABELS) as LedgerAccountType[]).map((t) => ({
            value: t,
            label: ACCOUNT_TYPE_LABELS[t],
          }))}
          onChange={setTypeFilter}
        />
        <Select
          placeholder="Select account"
          showSearch
          style={{ width: 280 }}
          value={accountId}
          options={filteredAccounts.map((a) => ({ value: a.id, label: `${a.account_code} - ${a.name}` }))}
          filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
          onChange={setAccountId}
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {!accountId && <Typography.Text type="secondary">Select an account to view its General Ledger.</Typography.Text>}

      {result && (
        <>
          <Space size="large" style={{ marginBottom: 12 }} wrap>
            <Typography.Text>Opening Balance: Rs. {formatMoney(result.openingBalance)}</Typography.Text>
            <Typography.Text strong>Closing Balance: Rs. {formatMoney(result.closingBalance)}</Typography.Text>
          </Space>
          <Table
            rowKey={(_, i) => String(i)}
            columns={columns}
            dataSource={result.entries}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 800 }}
          />
        </>
      )}
    </div>
  );
}

// Built entirely from journals + journal_lines + chart_of_accounts via
// /api/accounting/trial-balance - never from receipts/vendor_payments/
// expenses/documents/accounts.balance/the old journal_entries table.
function TrialBalanceTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [asOf, setAsOf] = useState<Dayjs>(dayjs());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrialBalanceResult | null>(null);

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  async function load() {
    if (!companyId) return;
    setLoading(true);
    try {
      const res = await api.get<TrialBalanceResult>(
        `/accounting/trial-balance?company_id=${companyId}&as_of=${asOf.format("YYYY-MM-DD")}`
      );
      setResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load trial balance");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, asOf]);

  const columns: ColumnsType<TrialBalanceRow> = [
    { title: "Account Code", dataIndex: "account_code", key: "account_code", width: 110 },
    { title: "Account Name", dataIndex: "name", key: "name" },
    { title: "Type", dataIndex: "account_type", key: "account_type", render: (t: LedgerAccountType) => ACCOUNT_TYPE_LABELS[t] },
    { title: "Debit", dataIndex: "debit", key: "debit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "Credit", dataIndex: "credit", key: "credit", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <DatePicker value={asOf} format="DD MMM YYYY" onChange={(d) => d && setAsOf(d)} allowClear={false} />
      </Space>

      {result && (
        <>
          <Table
            rowKey="account_id"
            columns={columns}
            dataSource={result.rows}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 600 }}
            summary={() => (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={3}>
                    <b>Total</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <b>{formatMoney(result.totalDebit)}</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <b>{formatMoney(result.totalCredit)}</b>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
          <div style={{ marginTop: 12 }}>
            {result.isBalanced ? (
              <Tag color="green">Balanced - Total Debit = Total Credit</Tag>
            ) : (
              <Tag color="red">
                Out of balance - Debit Rs. {formatMoney(result.totalDebit)} vs Credit Rs. {formatMoney(result.totalCredit)}{" "}
                (accounting integrity issue - figures shown as-is, not adjusted)
              </Tag>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Built entirely from journals + journal_lines + chart_of_accounts via
// /api/accounting/balance-sheet (Phase 9) - never from accounts.
// opening_balance or the old journal_entries table. The "Retained Earnings
// (Current)" row (account_id null) is a pure display computation - the
// all-time-to-date ledger Profit & Loss, not a postable chart_of_accounts
// row - shown in italics so it visually reads as different in kind from
// its real, stored-balance siblings.
function BalanceSheetTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [asOf, setAsOf] = useState<Dayjs>(dayjs());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BalanceSheetResult | null>(null);

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  async function load() {
    if (!companyId) return;
    setLoading(true);
    try {
      const res = await api.get<BalanceSheetResult>(
        `/accounting/balance-sheet?company_id=${companyId}&as_of=${asOf.format("YYYY-MM-DD")}`
      );
      setResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load balance sheet");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, asOf]);

  const columns: ColumnsType<BalanceSheetRow> = [
    { title: "Account Code", dataIndex: "account_code", key: "account_code", width: 110, render: (v: string | null) => v || "-" },
    {
      title: "Account Name",
      dataIndex: "name",
      key: "name",
      render: (v: string, r: BalanceSheetRow) => (r.account_id === null ? <i>{v}</i> : v),
    },
    {
      title: "Amount",
      dataIndex: "amount",
      key: "amount",
      align: "right",
      render: (v: number, r: BalanceSheetRow) => (r.account_id === null ? <i>Rs. {formatMoney(v)}</i> : `Rs. ${formatMoney(v)}`),
    },
  ];

  function summaryRow(total: number) {
    return () => (
      <Table.Summary fixed>
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={2}>
            <b>Total</b>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={1} align="right">
            <b>Rs. {formatMoney(total)}</b>
          </Table.Summary.Cell>
        </Table.Summary.Row>
      </Table.Summary>
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <DatePicker value={asOf} format="DD MMM YYYY" onChange={(d) => d && setAsOf(d)} allowClear={false} />
      </Space>

      {result && (
        <>
          <Typography.Title level={5}>Assets</Typography.Title>
          <Table
            rowKey={(r, i) => String(r.account_id ?? `synthetic-${i}`)}
            columns={columns}
            dataSource={result.assets}
            loading={loading}
            size="small"
            pagination={false}
            summary={summaryRow(result.totalAssets)}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Liabilities
          </Typography.Title>
          <Table
            rowKey={(r, i) => String(r.account_id ?? `synthetic-${i}`)}
            columns={columns}
            dataSource={result.liabilities}
            loading={loading}
            size="small"
            pagination={false}
            summary={summaryRow(result.totalLiabilities)}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Equity
          </Typography.Title>
          <Table
            rowKey={(r, i) => String(r.account_id ?? `synthetic-${i}`)}
            columns={columns}
            dataSource={result.equity}
            loading={loading}
            size="small"
            pagination={false}
            summary={summaryRow(result.totalEquity)}
          />

          <div style={{ marginTop: 12 }}>
            {result.isBalanced ? (
              <Tag color="green">Balanced - Assets = Liabilities + Equity</Tag>
            ) : (
              <Tag color="red">
                Out of balance - Assets Rs. {formatMoney(result.totalAssets)} vs Liabilities + Equity Rs.{" "}
                {formatMoney(result.totalLiabilities + result.totalEquity)} (accounting integrity issue - figures shown
                as-is, not adjusted)
              </Tag>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface CashFlowLine {
  category: string;
  amount: number;
}

// Built entirely from journals + journal_lines + chart_of_accounts via
// /api/accounting/cash-flow (Phase 10, indirect method) - never from
// accounts.opening_balance or the old journal_entries table. Operating
// Activities starts from Net Profit (Phase 8) and adjusts for the period's
// change in each working-capital account; Investing/Financing are the
// Fixed Assets / Capital+Loans-Drawings deltas over the same period.
// "Reconciles" compares the indirect-method net change in cash against the
// actual Cash+Bank balance change, computed independently - never forced.
function CashFlowTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("year"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CashFlowResult | null>(null);

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  async function load() {
    if (!companyId) return;
    setLoading(true);
    try {
      const res = await api.get<CashFlowResult>(
        `/accounting/cash-flow?company_id=${companyId}&from=${range[0].format("YYYY-MM-DD")}&to=${range[1].format("YYYY-MM-DD")}`
      );
      setResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load cash flow statement");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range]);

  const columns: ColumnsType<CashFlowLine> = [
    { title: "Item", dataIndex: "category", key: "category" },
    { title: "Amount", dataIndex: "amount", key: "amount", align: "right", render: (v: number) => `Rs. ${formatMoney(v)}` },
  ];

  function sectionTable(dataSource: CashFlowLine[], total: number) {
    return (
      <Table
        rowKey={(r, i) => `${r.category}-${i}`}
        columns={columns}
        dataSource={dataSource}
        loading={loading}
        size="small"
        pagination={false}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <b>Total</b>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <b>Rs. {formatMoney(total)}</b>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {result && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={8}>
              <Card size="small">
                <Statistic
                  title="Net Change in Cash"
                  value={result.netChangeInCash}
                  precision={2}
                  prefix="Rs."
                  valueStyle={{ color: result.netChangeInCash >= 0 ? "#3f8600" : "#cf1322" }}
                />
              </Card>
            </Col>
            <Col xs={8}>
              <Card size="small">
                <Statistic title="Opening Cash Balance" value={result.openingCashBalance} precision={2} prefix="Rs." />
              </Card>
            </Col>
            <Col xs={8}>
              <Card size="small">
                <Statistic title="Closing Cash Balance" value={result.closingCashBalance} precision={2} prefix="Rs." />
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5}>Operating Activities</Typography.Title>
          {sectionTable(
            [{ category: "Net Profit", amount: result.netProfit }, ...result.operatingActivities.adjustments],
            result.operatingActivities.total
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Investing Activities
          </Typography.Title>
          {sectionTable(result.investingActivities.adjustments, result.investingActivities.total)}

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Financing Activities
          </Typography.Title>
          {sectionTable(result.financingActivities.adjustments, result.financingActivities.total)}

          <div style={{ marginTop: 12 }}>
            {result.reconciles ? (
              <Tag color="green">Reconciles - Net Change in Cash matches the actual Cash + Bank balance change</Tag>
            ) : (
              <Tag color="red">
                Does not reconcile - computed Closing Cash Rs. {formatMoney(result.closingCashBalance)} vs actual Rs.{" "}
                {formatMoney(result.actualClosingCashBalance)} (accounting integrity issue - figures shown as-is, not
                adjusted)
              </Tag>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function ReportsPage() {
  const { companies, customers, vendors } = useCompaniesAndParties();

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Reports
      </Typography.Title>
      <Tabs
        defaultActiveKey="day-book"
        items={[
          { key: "day-book", label: "Day Book", children: <DayBookTab companies={companies} /> },
          { key: "party-ledger", label: "Party Ledger", children: <PartyLedgerTab customers={customers} vendors={vendors} /> },
          { key: "profit-loss", label: "Profit & Loss", children: <ProfitLossTab companies={companies} /> },
          { key: "gst-summary", label: "GST Summary", children: <GstSummaryTab companies={companies} /> },
          { key: "outstanding", label: "Outstanding", children: <OutstandingTab companies={companies} /> },
          { key: "general-ledger", label: "General Ledger", children: <GeneralLedgerTab companies={companies} /> },
          { key: "trial-balance", label: "Trial Balance", children: <TrialBalanceTab companies={companies} /> },
          { key: "balance-sheet", label: "Balance Sheet", children: <BalanceSheetTab companies={companies} /> },
          { key: "cash-flow", label: "Cash Flow", children: <CashFlowTab companies={companies} /> },
        ]}
      />
    </div>
  );
}
