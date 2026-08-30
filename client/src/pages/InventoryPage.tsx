import { useEffect, useState } from "react";
import {
  Table,
  Select,
  DatePicker,
  Typography,
  Space,
  message,
  Card,
  Statistic,
  Row,
  Col,
  Form,
  InputNumber,
  Input,
  Button,
  Tag,
  Alert,
  Modal,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import { api, ApiError } from "../api/client";
import {
  Company,
  Item,
  StockLevelRow,
  StockLedgerResult,
  StockLedgerRow,
  StockTransaction,
  InsufficientStockItem,
  InventoryValuationResult,
  InventoryValuationRow,
} from "../types";

const { RangePicker } = DatePicker;

function formatQty(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMoney(n: number): string {
  return `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Renders an average-cost/inventory-value figure, or "—" when there is no
 * cost basis at all (averageCost null) - never fabricates a 0. This is the
 * ONLY place either figure is displayed; the number itself always comes
 * from the backend's getStockValuation (via StockLevelRow), never
 * recomputed here. */
function renderCostOrDash(averageCost: number | null, value: number): JSX.Element | string {
  if (averageCost === null) return <Typography.Text type="secondary">—</Typography.Text>;
  return formatMoney(value);
}

/** Shared by all four Inventory pages - company list + the current
 * selection, defaulting to the first company, exactly like every other
 * report/page in this app (GstReturnsPage, ReportsPage) already does. */
function useCompanySelector() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => setCompanies(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (companies.length && companyId === undefined) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  return { companies, companyId, setCompanyId };
}

function useTrackedItems() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    api
      .get<{ data: Item[] }>("/items?perPage=100")
      .then((res) => setItems(res.data.filter((i) => Boolean(i.track_inventory))))
      .catch(() => {});
  }, []);
  return items;
}

// ---- Stock Levels (/inventory/stock-levels) ----

export function StockLevelsPage() {
  const { companies, companyId, setCompanyId } = useCompanySelector();
  const [rows, setRows] = useState<StockLevelRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function load(id: number) {
    setLoading(true);
    try {
      const res = await api.get<{ data: StockLevelRow[] }>(`/inventory/stock-levels?company_id=${id}`);
      setRows(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load stock levels");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (companyId) load(companyId);
  }, [companyId]);

  const columns: ColumnsType<StockLevelRow> = [
    { title: "Item", dataIndex: "itemName", key: "itemName" },
    { title: "Unit", dataIndex: "unit", key: "unit" },
    { title: "Opening Qty", dataIndex: "openingQty", key: "openingQty", align: "right", render: formatQty },
    { title: "Stock In", dataIndex: "stockIn", key: "stockIn", align: "right", render: formatQty },
    { title: "Stock Out", dataIndex: "stockOut", key: "stockOut", align: "right", render: formatQty },
    {
      title: "Adjustments",
      dataIndex: "adjustments",
      key: "adjustments",
      align: "right",
      render: (v: number) => (v >= 0 ? `+${formatQty(v)}` : formatQty(v)),
    },
    {
      title: "Qty On Hand",
      dataIndex: "currentOnHand",
      key: "currentOnHand",
      align: "right",
      render: (v: number) => <b style={{ color: v < 0 ? "#cf1322" : undefined }}>{formatQty(v)}</b>,
    },
    {
      title: "Average Cost",
      dataIndex: "averageCost",
      key: "averageCost",
      align: "right",
      render: (v: number | null) => renderCostOrDash(v, v ?? 0),
    },
    {
      title: "Inventory Value",
      key: "inventoryValue",
      align: "right",
      render: (_, r) => {
        // Distinguish "no cost basis at all" (averageCost null - nothing to
        // show but a dash) from "partial cost basis" (averageCost is a real
        // figure, but hasCostGap says it only covers part of currentOnHand,
        // e.g. some quantity came from an uncosted manual adjustment) -
        // both read straight off StockLevelRow, never computed here.
        if (r.averageCost === null) {
          return r.currentOnHand !== 0 ? (
            <Tag color="default" title="On-hand quantity exists but no cost basis has ever been recorded for it">
              no cost data
            </Tag>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          );
        }
        return (
          <Space size={4}>
            {formatMoney(r.inventoryValue)}
            {r.hasCostGap && (
              <Tag color="orange" title="Some on-hand quantity has no recorded cost basis - this value only covers the costed portion">
                partial cost
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: "Tracking",
      dataIndex: "trackInventory",
      key: "trackInventory",
      render: () => <Tag color="blue">Tracked</Tag>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Stock Levels
      </Typography.Title>
      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="Company"
          style={{ width: 220 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
      </Space>
      <Table
        rowKey="itemId"
        columns={columns}
        dataSource={rows}
        loading={loading}
        size="small"
        pagination={false}
        locale={{ emptyText: "No stock-tracked items yet - enable \"Track Stock\" on an item first" }}
      />
    </div>
  );
}

// ---- Inventory Valuation (/reports/inventory) ----
//
// A dedicated point-in-time report, distinct from Stock Levels (which is
// always "as of now" and organized around movement reconciliation). Every
// figure here comes straight from GET /inventory/valuation, which itself
// is a thin wrapper around getStockValuation (Phase 12C) - there is no
// second weighted-average calculation in this component; it only renders
// what the backend already computed.

export function InventoryValuationPage() {
  const { companies, companyId, setCompanyId } = useCompanySelector();
  const [asOfDate, setAsOfDate] = useState<Dayjs>(dayjs());
  const [result, setResult] = useState<InventoryValuationResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(id: number, date: Dayjs) {
    setLoading(true);
    try {
      const res = await api.get<InventoryValuationResult>(
        `/inventory/valuation?company_id=${id}&as_of=${date.format("YYYY-MM-DD")}`
      );
      setResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load inventory valuation");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (companyId) load(companyId, asOfDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, asOfDate]);

  const columns: ColumnsType<InventoryValuationRow> = [
    { title: "Item", dataIndex: "itemName", key: "itemName" },
    { title: "HSN/SAC", dataIndex: "hsnCode", key: "hsnCode", render: (v: string | null) => v || "-" },
    { title: "Unit", dataIndex: "unit", key: "unit" },
    { title: "Quantity", dataIndex: "qty", key: "qty", align: "right", render: (v: number) => <b style={{ color: v < 0 ? "#cf1322" : undefined }}>{formatQty(v)}</b> },
    { title: "Costed Quantity", dataIndex: "costedQty", key: "costedQty", align: "right", render: formatQty },
    {
      title: "Average Cost",
      dataIndex: "averageCost",
      key: "averageCost",
      align: "right",
      render: (v: number | null) => renderCostOrDash(v, v ?? 0),
    },
    {
      title: "Inventory Value",
      key: "inventoryValue",
      align: "right",
      render: (_, r) => {
        if (r.averageCost === null) {
          return r.qty !== 0 ? (
            <Tag color="default" title="Quantity exists but no cost basis has ever been recorded for it">
              no cost data
            </Tag>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          );
        }
        return (
          <Space size={4}>
            {formatMoney(r.inventoryValue)}
            {r.hasCostGap && (
              <Tag color="orange" title="Some quantity has no recorded cost basis - this value only covers the costed portion">
                partial cost
              </Tag>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        Inventory Valuation
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Point-in-time weighted-average valuation as of the selected date - never a fabricated cost for quantity with no
        recorded cost basis.
      </Typography.Paragraph>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 220 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <DatePicker
          value={asOfDate}
          format="DD MMM YYYY"
          allowClear={false}
          onChange={(v) => v && setAsOfDate(v)}
        />
      </Space>

      {result && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Total Quantity" value={result.totalQty} precision={2} />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Total Costed Quantity" value={result.totalCostedQty} precision={2} />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Total Inventory Value" value={result.totalValue} precision={2} prefix="Rs." />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                  Cost Basis
                </Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {result.hasAnyCostGap ? (
                    <Tag color="orange">Some stock uncosted</Tag>
                  ) : (
                    <Tag color="green">Fully costed</Tag>
                  )}
                </div>
              </Card>
            </Col>
          </Row>
          <Table
            rowKey="itemId"
            columns={columns}
            dataSource={result.rows}
            loading={loading}
            size="small"
            pagination={false}
            locale={{ emptyText: "No stock-tracked items yet - enable \"Track Stock\" on an item first" }}
          />
        </>
      )}
    </div>
  );
}

// ---- Stock Ledger (/inventory/stock-ledger) ----

export function StockLedgerPage() {
  const { companies, companyId, setCompanyId } = useCompanySelector();
  const items = useTrackedItems();
  const [itemId, setItemId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf("month"), dayjs()]);
  const [result, setResult] = useState<StockLedgerResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (items.length && itemId === undefined) setItemId(items[0].id);
  }, [items, itemId]);

  async function load() {
    if (!companyId || !itemId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        company_id: String(companyId),
        item_id: String(itemId),
        from: range[0].format("YYYY-MM-DD"),
        to: range[1].format("YYYY-MM-DD"),
      });
      const res = await api.get<StockLedgerResult>(`/inventory/ledger?${params.toString()}`);
      setResult(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load stock ledger");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, itemId, range]);

  const columns: ColumnsType<StockLedgerRow> = [
    { title: "Date", dataIndex: "txnDate", key: "txnDate", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Type", dataIndex: "txnType", key: "txnType", render: (t: string) => <Tag>{t.replace("_", " ")}</Tag> },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (s: string) => <Tag color={s === "reversed" ? "red" : "green"}>{s}</Tag>,
    },
    { title: "Qty", dataIndex: "signedQty", key: "signedQty", align: "right", render: (v: number) => (v >= 0 ? `+${formatQty(v)}` : formatQty(v)) },
    { title: "Running Balance", dataIndex: "runningBalance", key: "runningBalance", align: "right", render: formatQty },
    {
      // The row's own stored cost - see StockLedgerRow.unitCost's doc
      // comment - never today's average, and a reversal row already
      // carries over the exact same cost as the row it reverses.
      title: "Unit Cost",
      dataIndex: "unitCost",
      key: "unitCost",
      align: "right",
      render: (v: number | null) => (v === null ? <Typography.Text type="secondary">—</Typography.Text> : formatMoney(v)),
    },
    {
      title: "Value Impact",
      dataIndex: "valueImpact",
      key: "valueImpact",
      align: "right",
      render: (v: number | null) =>
        v === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <span style={{ color: v < 0 ? "#cf1322" : undefined }}>{v >= 0 ? `+${formatMoney(v)}` : formatMoney(v)}</span>
        ),
    },
    { title: "Source", key: "source", render: (_, r) => (r.sourceType ? `${r.sourceType} #${r.sourceId ?? ""}` : "-") },
    { title: "Notes", dataIndex: "notes", key: "notes" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Stock Ledger
      </Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <Select
          placeholder="Item"
          style={{ width: 240 }}
          value={itemId}
          options={items.map((i) => ({ value: i.id, label: i.name }))}
          onChange={setItemId}
          showSearch
          optionFilterProp="label"
        />
        <RangePicker value={range} format="DD MMM YYYY" onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
      </Space>

      {result && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Opening Balance" value={result.openingBalance} precision={2} />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Closing Balance" value={result.closingBalance} precision={2} />
              </Card>
            </Col>
          </Row>
          <Table rowKey="id" columns={columns} dataSource={result.rows} loading={loading} size="small" pagination={false} scroll={{ x: 800 }} />
        </>
      )}
    </div>
  );
}

// ---- Opening Stock (/inventory/opening-stock) ----

export function OpeningStockPage() {
  const { companies, companyId, setCompanyId } = useCompanySelector();
  const items = useTrackedItems();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const values = await form.validateFields();
    if (!companyId) return;
    setSaving(true);
    try {
      await api.post("/inventory/opening-stock", {
        company_id: companyId,
        item_id: values.item_id,
        txn_date: values.txn_date.format("YYYY-MM-DD"),
        qty: values.qty,
        unit_cost: values.unit_cost ?? null,
        notes: values.notes || null,
      });
      message.success("Opening stock recorded");
      form.resetFields(["item_id", "qty", "unit_cost", "notes"]);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to record opening stock");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        Opening Stock
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Manual, one-time entry per company/item - never inferred from historical documents. Only one opening entry is
        allowed per item; reverse the existing one (via a compensating adjustment) before recording a new one.
      </Typography.Paragraph>
      <Card style={{ maxWidth: 480 }}>
        <Form form={form} layout="vertical" initialValues={{ txn_date: dayjs() }}>
          <Form.Item label="Company">
            <Select value={companyId} options={companies.map((c) => ({ value: c.id, label: c.name }))} onChange={setCompanyId} />
          </Form.Item>
          <Form.Item name="item_id" label="Item" rules={[{ required: true, message: "Item is required" }]}>
            <Select options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="txn_date" label="Date" rules={[{ required: true }]}>
            <DatePicker style={{ width: "100%" }} format="DD MMM YYYY" />
          </Form.Item>
          <Form.Item name="qty" label="Opening Quantity" rules={[{ required: true, message: "Quantity is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item
            name="unit_cost"
            label="Unit Cost (optional)"
            tooltip="GST-exclusive cost per unit. Leave blank if unknown - it will never be guessed; the item's weighted-average cost will simply reflect only the quantity that has a recorded cost."
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder="Leave blank if unknown" />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" onClick={handleSubmit} loading={saving}>
            Record Opening Stock
          </Button>
        </Form>
      </Card>
    </div>
  );
}

// ---- Stock Adjustments (/inventory/adjustments) ----

export function StockAdjustmentsPage() {
  const { companies, companyId, setCompanyId } = useCompanySelector();
  const items = useTrackedItems();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [lastPosted, setLastPosted] = useState<StockTransaction[]>([]);

  function confirmNegativeStock(items: InsufficientStockItem[]): Promise<boolean> {
    return new Promise((resolve) => {
      Modal.confirm({
        title: "Insufficient stock",
        content: (
          <div>
            <p>This adjustment would take the following item(s) below zero on hand:</p>
            <ul>
              {items.map((i) => (
                <li key={i.itemId}>
                  {i.itemName}: requesting {i.requestedQty}, only {i.availableQty} available
                </li>
              ))}
            </ul>
            <p>Proceed anyway?</p>
          </div>
        ),
        okText: "Proceed anyway",
        cancelText: "Cancel",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    if (!companyId) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      company_id: companyId,
      item_id: values.item_id,
      txn_date: values.txn_date.format("YYYY-MM-DD"),
      txn_type: values.txn_type,
      qty: values.qty,
      notes: values.notes,
    };
    try {
      const res = await api.post<{ transaction: StockTransaction }>("/inventory/adjustments", body);
      message.success("Adjustment recorded");
      setLastPosted((prev) => [res.transaction, ...prev].slice(0, 10));
      form.resetFields(["item_id", "qty", "notes"]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as any)?.code === "INSUFFICIENT_STOCK") {
        const proceed = await confirmNegativeStock((err.body as any).items as InsufficientStockItem[]);
        if (proceed) {
          body.confirm_negative_stock = true;
          try {
            const res = await api.post<{ transaction: StockTransaction }>("/inventory/adjustments", body);
            message.success("Adjustment recorded");
            setLastPosted((prev) => [res.transaction, ...prev].slice(0, 10));
            form.resetFields(["item_id", "qty", "notes"]);
          } catch (err2) {
            message.error(err2 instanceof Error ? err2.message : "Failed to record adjustment");
          }
        }
      } else {
        message.error(err instanceof Error ? err.message : "Failed to record adjustment");
      }
    } finally {
      setSaving(false);
    }
  }

  const columns: ColumnsType<StockTransaction> = [
    { title: "Date", dataIndex: "txn_date", key: "txn_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Type", dataIndex: "txn_type", key: "txn_type", render: (t: string) => <Tag>{t.replace("_", " ")}</Tag> },
    { title: "Qty", dataIndex: "qty", key: "qty", align: "right" },
    { title: "Notes", dataIndex: "notes", key: "notes" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        Stock Adjustments
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Manual corrections - stocktake, damage, loss, found stock. A reason is required for every adjustment.
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16, maxWidth: 480 }}
        message="An adjustment that would take an item below zero on hand warns and requires confirmation before proceeding - it is never created silently."
      />
      <Card style={{ maxWidth: 480, marginBottom: 24 }}>
        <Form form={form} layout="vertical" initialValues={{ txn_date: dayjs(), txn_type: "adjustment_in" }}>
          <Form.Item label="Company">
            <Select value={companyId} options={companies.map((c) => ({ value: c.id, label: c.name }))} onChange={setCompanyId} />
          </Form.Item>
          <Form.Item name="item_id" label="Item" rules={[{ required: true, message: "Item is required" }]}>
            <Select options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="txn_type" label="Direction" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "adjustment_in", label: "Adjustment In (increase)" },
                { value: "adjustment_out", label: "Adjustment Out (decrease)" },
              ]}
            />
          </Form.Item>
          <Form.Item name="txn_date" label="Date" rules={[{ required: true }]}>
            <DatePicker style={{ width: "100%" }} format="DD MMM YYYY" />
          </Form.Item>
          <Form.Item name="qty" label="Quantity" rules={[{ required: true, message: "Quantity is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item name="notes" label="Reason" rules={[{ required: true, message: "A reason is required" }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" onClick={handleSubmit} loading={saving}>
            Record Adjustment
          </Button>
        </Form>
      </Card>

      {lastPosted.length > 0 && (
        <>
          <Typography.Title level={5}>Recently Recorded (this session)</Typography.Title>
          <Table rowKey="id" columns={columns} dataSource={lastPosted} size="small" pagination={false} />
        </>
      )}
    </div>
  );
}
