import { useEffect, useState } from "react";
import { Tabs, Select, DatePicker, Table, Typography, Space, message, Statistic, Row, Col, Card, Tag, Alert } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import { api } from "../api/client";
import {
  Company,
  Gstr1HsnRow,
  Gstr1InvoiceRow,
  Gstr1Result,
  Gstr3bResult,
  Gstr3bSection,
} from "../types";

const { RangePicker } = DatePicker;

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_COLORS: Record<string, string> = {
  draft: "default",
  sent: "blue",
  accepted: "green",
  rejected: "red",
  cancelled: "red",
};

// Phase 11B - GSTR-1 preparation. Built entirely from source documents
// (documents + document_items) via /api/accounting/gst-returns/gstr1 -
// never the ledger, since invoice/line-level detail (invoice numbers,
// customer GSTIN, per-line HSN) is inherently a source-document fact the
// ledger has no concept of. This is an internal preparation tool only -
// there is no GST portal filing/submission of any kind.
function Gstr1Tab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Gstr1Result | null>(null);

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
      const res = await api.get<Gstr1Result>(`/accounting/gst-returns/gstr1?${params.toString()}`);
      setData(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load GSTR-1 data");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range]);

  const invoiceColumns: ColumnsType<Gstr1InvoiceRow> = [
    { title: "Invoice No.", dataIndex: "docNumber", key: "docNumber" },
    { title: "Date", dataIndex: "issueDate", key: "issueDate", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (s: string) => <Tag color={STATUS_COLORS[s] || "default"}>{s}</Tag>,
    },
    { title: "Customer", dataIndex: "customerName", key: "customerName" },
    { title: "GSTIN", dataIndex: "customerGstin", key: "customerGstin", render: (v: string | null) => v || "-" },
    { title: "Taxable Value", dataIndex: "taxableValue", key: "taxableValue", align: "right", render: (v: number) => formatMoney(v) },
    { title: "CGST", dataIndex: "cgst", key: "cgst", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "SGST", dataIndex: "sgst", key: "sgst", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "IGST", dataIndex: "igst", key: "igst", align: "right", render: (v: number) => (v ? formatMoney(v) : "") },
    { title: "Total", dataIndex: "grandTotal", key: "grandTotal", align: "right", render: (v: number) => <b>{formatMoney(v)}</b> },
  ];

  const hsnColumns: ColumnsType<Gstr1HsnRow> = [
    { title: "HSN/SAC", dataIndex: "hsnCode", key: "hsnCode" },
    { title: "Tax Rate %", dataIndex: "taxRate", key: "taxRate", align: "right" },
    { title: "Qty", dataIndex: "qty", key: "qty", align: "right" },
    { title: "Taxable Value", dataIndex: "taxableValue", key: "taxableValue", align: "right", render: (v: number) => formatMoney(v) },
    { title: "Tax Amount", dataIndex: "taxTotal", key: "taxTotal", align: "right", render: (v: number) => formatMoney(v) },
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
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {data && (
        <>
          {data.draftCount > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${data.draftCount} invoice(s) below are still in Draft status - included in the totals since they already carry a posted accounting entry, but worth reviewing before filing.`}
            />
          )}

          <Typography.Title level={5}>B2B Invoices</Typography.Title>
          <Table
            rowKey="documentId"
            columns={invoiceColumns}
            dataSource={data.b2b.invoices}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 900 }}
            summary={() => (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={5}>
                    <b>Total</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <b>{formatMoney(data.b2b.totalTaxableValue)}</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <b>{formatMoney(data.b2b.totalCgst)}</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">
                    <b>{formatMoney(data.b2b.totalSgst)}</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">
                    <b>{formatMoney(data.b2b.totalIgst)}</b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right" />
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            B2C (Others)
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            Reported as one combined total, not state-wise - customers in this system have no reliable state code.
          </Typography.Paragraph>
          <Row gutter={16}>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Invoice Count" value={data.b2c.invoiceCount} />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Taxable Value" value={data.b2c.totalTaxableValue} precision={2} prefix="Rs." />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="CGST" value={data.b2c.totalCgst} precision={2} prefix="Rs." />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="SGST + IGST" value={data.b2c.totalSgst + data.b2c.totalIgst} precision={2} prefix="Rs." />
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            HSN Summary
          </Typography.Title>
          <Table
            rowKey={(r) => `${r.hsnCode}-${r.taxRate}`}
            columns={hsnColumns}
            dataSource={data.hsnSummary}
            loading={loading}
            size="small"
            pagination={false}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Cancelled Invoices
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            Excluded from every total above; listed here so the invoice number sequence stays visibly complete.
          </Typography.Paragraph>
          <Table
            rowKey="documentId"
            columns={invoiceColumns}
            dataSource={data.cancelledInvoices}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 900 }}
            locale={{ emptyText: "No cancelled invoices in this period" }}
          />

          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 24 }}
            message="Not tracked in this system"
            description={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {data.unsupported.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            }
          />
        </>
      )}
    </div>
  );
}

// Phase 11B - GSTR-3B preparation. A reshaping of the existing,
// unmodified ledger-based getGstSummary()/getProfitAndLoss() figures into
// the standard 3.1/4 table layout - via /api/accounting/gst-returns/gstr3b.
function Gstr3bTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Gstr3bResult | null>(null);

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
      const res = await api.get<Gstr3bResult>(`/accounting/gst-returns/gstr3b?${params.toString()}`);
      setData(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load GSTR-3B data");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, range]);

  const sectionColumns: ColumnsType<Gstr3bSection> = [
    { title: "Section", dataIndex: "label", key: "label" },
    {
      title: "Taxable Value",
      dataIndex: "taxableValue",
      key: "taxableValue",
      align: "right",
      render: (v: number | null, r) => (r.notTracked ? <Tag color="orange">Not tracked</Tag> : v !== null ? formatMoney(v) : "-"),
    },
    {
      title: "IGST",
      dataIndex: "igst",
      key: "igst",
      align: "right",
      render: (v: number | null, r) => (r.notTracked ? "-" : v !== null ? formatMoney(v) : "-"),
    },
    {
      title: "CGST",
      dataIndex: "cgst",
      key: "cgst",
      align: "right",
      render: (v: number | null, r) => (r.notTracked ? "-" : v !== null ? formatMoney(v) : "-"),
    },
    {
      title: "SGST",
      dataIndex: "sgst",
      key: "sgst",
      align: "right",
      render: (v: number | null, r) => (r.notTracked ? "-" : v !== null ? formatMoney(v) : "-"),
    },
    { title: "Note", dataIndex: "note", key: "note", render: (v: string | undefined) => v || "" },
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
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {data && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={12}>
              <Card size="small">
                <Statistic
                  title="Net GST Payable"
                  value={data.netGstPayable}
                  precision={2}
                  prefix="Rs."
                  valueStyle={{ color: data.netGstPayable > 0 ? "#cf1322" : undefined }}
                />
              </Card>
            </Col>
            <Col xs={12}>
              <Card size="small">
                <Statistic
                  title="Net GST Refundable"
                  value={data.netGstRefundable}
                  precision={2}
                  prefix="Rs."
                  valueStyle={{ color: data.netGstRefundable > 0 ? "#3f8600" : undefined }}
                />
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5}>Table 3.1 - Outward Supplies</Typography.Title>
          <Table
            rowKey="label"
            columns={sectionColumns}
            dataSource={data.outwardSupplies}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 800 }}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            Table 4 - Eligible ITC
          </Typography.Title>
          <Table
            rowKey="label"
            columns={sectionColumns}
            dataSource={data.itc}
            loading={loading}
            size="small"
            pagination={false}
            scroll={{ x: 800 }}
          />

          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 24 }}
            message="Not tracked in this system"
            description={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {data.unsupported.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            }
          />
        </>
      )}
    </div>
  );
}

export function GstReturnsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => setCompanies(res.data))
      .catch(() => {});
  }, []);

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        GST Returns
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Internal GSTR-1/GSTR-3B preparation only - there is no GST portal filing or submission integration. Review and
        file these figures yourself on the government portal.
      </Typography.Paragraph>
      <Tabs
        defaultActiveKey="gstr1"
        items={[
          { key: "gstr1", label: "GSTR-1", children: <Gstr1Tab companies={companies} /> },
          { key: "gstr3b", label: "GSTR-3B", children: <Gstr3bTab companies={companies} /> },
        ]}
      />
    </div>
  );
}
