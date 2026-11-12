import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Col, DatePicker, Radio, Row, Select, Space, Statistic, Table, Tabs, Tag, Typography, message } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import { api } from "../api/client";
import { RemoteSelect } from "../components/RemoteSelect";
import { GST_REPORT_OPTIONS } from "../constants/gst";
import type { Company, GstType } from "../types";

const { RangePicker } = DatePicker;

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Indian financial year (1 Apr - 31 Mar) containing today, up to today. */
function currentFinancialYearRange(): [Dayjs, Dayjs] {
  const today = dayjs();
  const startYear = today.month() >= 3 ? today.year() : today.year() - 1;
  return [dayjs(`${startYear}-04-01`), today];
}

function downloadCsv(filename: string, headers: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  // BOM so Excel reads UTF-8 (rupee signs, vendor names) correctly.
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type BillStatus = "active" | "all" | "draft" | "received" | "cancelled";

const STATUS_OPTIONS: { value: BillStatus; label: string }[] = [
  { value: "active", label: "All except cancelled" },
  { value: "received", label: "Received" },
  { value: "draft", label: "Draft" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "Everything" },
];

interface Filters {
  companyId: number | undefined;
  range: [Dayjs, Dayjs];
  gst: GstType | "all";
  vendorId: number | undefined;
  status: BillStatus;
}

function queryString(f: Filters, extra: Record<string, string> = {}, includeStatus = true): string {
  const q = new URLSearchParams({ from: f.range[0].format("YYYY-MM-DD"), to: f.range[1].format("YYYY-MM-DD"), ...extra });
  if (f.companyId) q.set("company_id", String(f.companyId));
  if (f.vendorId) q.set("vendor_id", String(f.vendorId));
  if (f.gst !== "all") q.set("gst_type", f.gst);
  if (includeStatus && f.status !== "active") q.set("status", f.status);
  return q.toString();
}

/** Fetches one report whenever its URL changes; the report is dropped while a new one loads. */
function useReport<T>(path: string, query: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<T>(`/reports/purchases/${path}?${query}`)
      .then((res) => !cancelled && setData(res))
      .catch((err) => !cancelled && message.error(err instanceof Error ? err.message : "Failed to load report"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, query]);

  return { data, loading };
}

function GstTag({ v }: { v: GstType }) {
  return v === "non_gst" ? <Tag color="orange">Without GST</Tag> : <Tag color="green">With GST</Tag>;
}

function StatusTag({ v }: { v: string }) {
  return <Tag color={v === "received" ? "green" : v === "cancelled" ? "red" : "default"}>{v.charAt(0).toUpperCase() + v.slice(1)}</Tag>;
}

const money = (v: number) => formatMoney(v);
const moneyOrBlank = (v: number) => (v ? formatMoney(v) : "");

// ---------------------------------------------------------------------------
// Purchase Register
// ---------------------------------------------------------------------------

interface RegisterBill {
  id: number;
  bill_date: string;
  reference_no: string | null;
  bill_no: string;
  company_code: string;
  gst_type: GstType;
  status: string;
  vendor_name: string;
  vendor_gstin: string | null;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  round_off: number;
  total: number;
}

interface RegisterResult {
  bills: RegisterBill[];
  totals: { count: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number; round_off: number; total: number };
}

function RegisterTab({ filters }: { filters: Filters }) {
  const { data, loading } = useReport<RegisterResult>("register", queryString(filters));

  const columns: ColumnsType<RegisterBill> = [
    { title: "Bill Date", dataIndex: "bill_date", key: "bill_date", width: 110, render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Reference", dataIndex: "reference_no", key: "reference_no", render: (v: string | null) => v || "-" },
    { title: "Bill No.", dataIndex: "bill_no", key: "bill_no" },
    { title: "Vendor", dataIndex: "vendor_name", key: "vendor_name" },
    { title: "GSTIN", dataIndex: "vendor_gstin", key: "vendor_gstin", render: (v: string | null) => v || "-" },
    { title: "Book", dataIndex: "gst_type", key: "gst_type", render: (v: GstType) => <GstTag v={v} /> },
    { title: "Status", dataIndex: "status", key: "status", render: (v: string) => <StatusTag v={v} /> },
    { title: "Taxable", dataIndex: "taxable", key: "taxable", align: "right", render: money },
    { title: "CGST", dataIndex: "cgst", key: "cgst", align: "right", render: moneyOrBlank },
    { title: "SGST", dataIndex: "sgst", key: "sgst", align: "right", render: moneyOrBlank },
    { title: "IGST", dataIndex: "igst", key: "igst", align: "right", render: moneyOrBlank },
    { title: "Round Off", dataIndex: "round_off", key: "round_off", align: "right", render: moneyOrBlank },
    { title: "Total", dataIndex: "total", key: "total", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `purchase-register-${filters.range[0].format("YYYYMMDD")}-${filters.range[1].format("YYYYMMDD")}.csv`,
      ["Bill Date", "Reference", "Bill No", "Vendor", "GSTIN", "Book", "Status", "Taxable", "CGST", "SGST", "IGST", "Round Off", "Total"],
      data.bills.map((b) => [dayjs(b.bill_date).format("YYYY-MM-DD"), b.reference_no, b.bill_no, b.vendor_name, b.vendor_gstin, b.gst_type === "non_gst" ? "Without GST" : "With GST", b.status, b.taxable, b.cgst, b.sgst, b.igst, b.round_off, b.total])
    );
  }

  const t = data?.totals;
  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Bills" value={t?.count ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Taxable Value" value={formatMoney(t?.taxable ?? 0)} prefix="Rs." /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="GST (Input Tax)" value={formatMoney(t?.tax ?? 0)} prefix="Rs." /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Total Purchases" value={formatMoney(t?.total ?? 0)} prefix="Rs." /></Card></Col>
      </Row>
      <div style={{ marginBottom: 12, textAlign: "right" }}>
        <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!data?.bills.length}>
          Download CSV
        </Button>
      </div>
      <Table<RegisterBill>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.bills ?? []}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        scroll={{ x: "max-content" }}
        summary={() =>
          t && data!.bills.length ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={7}><b>Total</b></Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right"><b>{formatMoney(t.taxable)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={8} align="right"><b>{formatMoney(t.cgst)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={9} align="right"><b>{formatMoney(t.sgst)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={10} align="right"><b>{formatMoney(t.igst)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={11} align="right"><b>{formatMoney(t.round_off)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={12} align="right"><b>{formatMoney(t.total)}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor-wise
// ---------------------------------------------------------------------------

interface VendorRow {
  vendor_id: number;
  vendor_name: string;
  vendor_gstin: string | null;
  bills: number;
  taxable: number;
  tax: number;
  total: number;
  debit_notes: number;
  paid: number;
  balance: number;
}

interface VendorSummaryResult {
  vendors: VendorRow[];
  totals: { vendors: number; bills: number; taxable: number; tax: number; total: number; debit_notes: number; paid: number; balance: number };
}

function VendorSummaryTab({ filters }: { filters: Filters }) {
  const { data, loading } = useReport<VendorSummaryResult>("vendor-summary", queryString(filters, {}, false));

  const columns: ColumnsType<VendorRow> = [
    { title: "Vendor", dataIndex: "vendor_name", key: "vendor_name" },
    { title: "GSTIN", dataIndex: "vendor_gstin", key: "vendor_gstin", render: (v: string | null) => v || "-" },
    { title: "Bills", dataIndex: "bills", key: "bills", align: "right", width: 70 },
    { title: "Taxable", dataIndex: "taxable", key: "taxable", align: "right", render: money },
    { title: "GST", dataIndex: "tax", key: "tax", align: "right", render: moneyOrBlank },
    { title: "Billed", dataIndex: "total", key: "total", align: "right", render: money },
    { title: "Debit Notes", dataIndex: "debit_notes", key: "debit_notes", align: "right", render: moneyOrBlank },
    { title: "Paid", dataIndex: "paid", key: "paid", align: "right", render: moneyOrBlank },
    { title: "Balance Payable", dataIndex: "balance", key: "balance", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `purchases-by-vendor-${filters.range[0].format("YYYYMMDD")}-${filters.range[1].format("YYYYMMDD")}.csv`,
      ["Vendor", "GSTIN", "Bills", "Taxable", "GST", "Billed", "Debit Notes", "Paid", "Balance Payable"],
      data.vendors.map((v) => [v.vendor_name, v.vendor_gstin, v.bills, v.taxable, v.tax, v.total, v.debit_notes, v.paid, v.balance])
    );
  }

  const t = data?.totals;
  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Billed, Debit Notes and Paid are for the selected dates. Balance Payable is as on the end date and matches the vendor's Party Ledger (it also counts earlier periods and Expenses)."
      />
      <div style={{ marginBottom: 12, textAlign: "right" }}>
        <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!data?.vendors.length}>
          Download CSV
        </Button>
      </div>
      <Table<VendorRow>
        rowKey="vendor_id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.vendors ?? []}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        scroll={{ x: "max-content" }}
        summary={() =>
          t && data!.vendors.length ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}><b>Total ({t.vendors} vendors)</b></Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right"><b>{t.bills}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right"><b>{formatMoney(t.taxable)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right"><b>{formatMoney(t.tax)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right"><b>{formatMoney(t.total)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right"><b>{formatMoney(t.debit_notes)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right"><b>{formatMoney(t.paid)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={8} align="right"><b>{formatMoney(t.balance)}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item-wise / HSN-wise
// ---------------------------------------------------------------------------

interface ItemLine {
  description: string | null;
  hsn_code: string | null;
  unit: string | null;
  tax_rate: number | null;
  bills: number;
  qty: number | null;
  taxable: number;
  tax: number;
  total: number;
}

interface ItemSummaryResult {
  mode: "item" | "hsn";
  lines: ItemLine[];
  totals: { taxable: number; tax: number; total: number };
}

function ItemSummaryTab({ filters }: { filters: Filters }) {
  const [mode, setMode] = useState<"item" | "hsn">("item");
  const { data, loading } = useReport<ItemSummaryResult>("item-summary", queryString(filters, { mode }));
  // Ignore a response for the other mode while a switch is still loading.
  const lines = data?.mode === mode ? data.lines : [];
  const t = data?.mode === mode ? data.totals : undefined;

  const itemColumns: ColumnsType<ItemLine> = [
    { title: "Item", dataIndex: "description", key: "description" },
    { title: "HSN", dataIndex: "hsn_code", key: "hsn_code", width: 100, render: (v: string | null) => v || "-" },
    { title: "Bills", dataIndex: "bills", key: "bills", align: "right", width: 70 },
    { title: "Qty", dataIndex: "qty", key: "qty", align: "right", render: (v: number | null, r) => `${v ?? 0} ${r.unit ?? ""}`.trim() },
    { title: "Taxable", dataIndex: "taxable", key: "taxable", align: "right", render: money },
    { title: "GST", dataIndex: "tax", key: "tax", align: "right", render: moneyOrBlank },
    { title: "Total", dataIndex: "total", key: "total", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];
  const hsnColumns: ColumnsType<ItemLine> = [
    { title: "HSN / SAC", dataIndex: "hsn_code", key: "hsn_code", render: (v: string | null) => v || "(not set)" },
    { title: "GST Rate", dataIndex: "tax_rate", key: "tax_rate", align: "right", render: (v: number | null) => `${v ?? 0}%` },
    { title: "Bills", dataIndex: "bills", key: "bills", align: "right", width: 70 },
    { title: "Taxable", dataIndex: "taxable", key: "taxable", align: "right", render: money },
    { title: "GST", dataIndex: "tax", key: "tax", align: "right", render: moneyOrBlank },
    { title: "Total", dataIndex: "total", key: "total", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];

  function exportCsv() {
    if (!lines.length) return;
    const stamp = `${filters.range[0].format("YYYYMMDD")}-${filters.range[1].format("YYYYMMDD")}`;
    if (mode === "item") {
      downloadCsv(`purchases-by-item-${stamp}.csv`, ["Item", "HSN", "Bills", "Qty", "Unit", "Taxable", "GST", "Total"], lines.map((l) => [l.description, l.hsn_code, l.bills, l.qty, l.unit, l.taxable, l.tax, l.total]));
    } else {
      downloadCsv(`purchases-by-hsn-${stamp}.csv`, ["HSN/SAC", "GST Rate", "Bills", "Taxable", "GST", "Total"], lines.map((l) => [l.hsn_code, l.tax_rate, l.bills, l.taxable, l.tax, l.total]));
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
          <Radio.Button value="item">Item-wise</Radio.Button>
          <Radio.Button value="hsn">HSN-wise</Radio.Button>
        </Radio.Group>
        <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!lines.length}>
          Download CSV
        </Button>
      </Space>
      <Table<ItemLine>
        rowKey={(r) => `${r.description ?? ""}|${r.hsn_code ?? ""}|${r.unit ?? ""}|${r.tax_rate ?? ""}`}
        size="small"
        loading={loading}
        columns={mode === "item" ? itemColumns : hsnColumns}
        dataSource={lines}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        scroll={{ x: "max-content" }}
        summary={() =>
          t && lines.length ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={mode === "item" ? 4 : 3}><b>Total</b></Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right"><b>{formatMoney(t.taxable)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right"><b>{formatMoney(t.tax)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right"><b>{formatMoney(t.total)}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month-wise
// ---------------------------------------------------------------------------

interface MonthRow {
  month: string;
  bills: number;
  taxable: number;
  tax: number;
  round_off: number;
  total: number;
  debit_notes: number;
  net: number;
}

interface MonthlyResult {
  months: MonthRow[];
  totals: { bills: number; taxable: number; tax: number; round_off: number; total: number; debit_notes: number; net: number };
}

function MonthlyTab({ filters }: { filters: Filters }) {
  const { data, loading } = useReport<MonthlyResult>("monthly", queryString(filters));

  const columns: ColumnsType<MonthRow> = [
    { title: "Month", dataIndex: "month", key: "month", render: (m: string) => dayjs(`${m}-01`).format("MMMM YYYY") },
    { title: "Bills", dataIndex: "bills", key: "bills", align: "right", width: 70 },
    { title: "Taxable", dataIndex: "taxable", key: "taxable", align: "right", render: money },
    { title: "GST", dataIndex: "tax", key: "tax", align: "right", render: moneyOrBlank },
    { title: "Round Off", dataIndex: "round_off", key: "round_off", align: "right", render: moneyOrBlank },
    { title: "Billed", dataIndex: "total", key: "total", align: "right", render: money },
    { title: "Debit Notes", dataIndex: "debit_notes", key: "debit_notes", align: "right", render: moneyOrBlank },
    { title: "Net Purchases", dataIndex: "net", key: "net", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `purchases-by-month-${filters.range[0].format("YYYYMMDD")}-${filters.range[1].format("YYYYMMDD")}.csv`,
      ["Month", "Bills", "Taxable", "GST", "Round Off", "Billed", "Debit Notes", "Net Purchases"],
      data.months.map((m) => [m.month, m.bills, m.taxable, m.tax, m.round_off, m.total, m.debit_notes, m.net])
    );
  }

  const t = data?.totals;
  return (
    <div>
      <div style={{ marginBottom: 12, textAlign: "right" }}>
        <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!data?.months.length}>
          Download CSV
        </Button>
      </div>
      <Table<MonthRow>
        rowKey="month"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.months ?? []}
        pagination={false}
        scroll={{ x: "max-content" }}
        summary={() =>
          t && data!.months.length ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}><b>Total</b></Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right"><b>{t.bills}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right"><b>{formatMoney(t.taxable)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right"><b>{formatMoney(t.tax)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right"><b>{formatMoney(t.round_off)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right"><b>{formatMoney(t.total)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right"><b>{formatMoney(t.debit_notes)}</b></Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right"><b>{formatMoney(t.net)}</b></Table.Summary.Cell>
            </Table.Summary.Row>
          ) : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PurchaseReportsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>(currentFinancialYearRange);
  const [gst, setGst] = useState<GstType | "all">("all");
  const [vendorId, setVendorId] = useState<number | undefined>();
  const [status, setStatus] = useState<BillStatus>("active");
  const [tab, setTab] = useState("register");

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
  }, []);

  const filters = useMemo<Filters>(() => ({ companyId, range, gst, vendorId, status }), [companyId, range, gst, vendorId, status]);
  const onRange = useCallback((v: [Dayjs | null, Dayjs | null] | null) => v && v[0] && v[1] && setRange([v[0], v[1]]), []);

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Purchase Reports
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select<number>
          allowClear
          placeholder="All companies"
          style={{ width: 220 }}
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={onRange} allowClear={false} />
        <Select value={gst} options={GST_REPORT_OPTIONS} onChange={setGst} style={{ width: 220 }} />
        <RemoteSelect<{ id: number; name: string }>
          searchPath="/vendors"
          mapOption={(v) => ({ value: v.id, label: v.name })}
          placeholder="All vendors"
          allowClear
          style={{ width: 220 }}
          value={vendorId}
          onChange={setVendorId}
        />
        {tab !== "vendors" && <Select value={status} options={STATUS_OPTIONS} onChange={setStatus} style={{ width: 190 }} />}
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        destroyOnHidden
        items={[
          { key: "register", label: "Purchase Register", children: <RegisterTab filters={filters} /> },
          { key: "vendors", label: "Vendor-wise", children: <VendorSummaryTab filters={filters} /> },
          { key: "items", label: "Item / HSN-wise", children: <ItemSummaryTab filters={filters} /> },
          { key: "monthly", label: "Month-wise", children: <MonthlyTab filters={filters} /> },
        ]}
      />
    </div>
  );
}
