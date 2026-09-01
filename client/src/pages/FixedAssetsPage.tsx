import { useCallback, useEffect, useState } from "react";
import {
  Table,
  Button,
  Input,
  Space,
  Modal,
  Form,
  DatePicker,
  InputNumber,
  Select,
  message,
  Popconfirm,
  Typography,
  Tag,
  Descriptions,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EyeOutlined, DeleteOutlined, StopOutlined, CalculatorOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company, ChartOfAccount, FixedAsset, FixedAssetDetail, DepreciationRunResult } from "../types";

const PAGE_SIZE = 10;

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_COLORS: Record<FixedAsset["status"], string> = { active: "success", disposed: "default" };

export function FixedAssetsPage() {
  const { can } = useAuth();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();
  const createCompanyId = Form.useWatch("company_id", createForm);
  const [createChartAccounts, setCreateChartAccounts] = useState<ChartOfAccount[]>([]);

  const [viewDetail, setViewDetail] = useState<FixedAssetDetail | null>(null);

  const [disposeAsset, setDisposeAsset] = useState<FixedAsset | null>(null);
  const [disposing, setDisposing] = useState(false);
  const [disposeForm] = Form.useForm();
  const [disposeChartAccounts, setDisposeChartAccounts] = useState<ChartOfAccount[]>([]);

  const [runOpen, setRunOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runForm] = Form.useForm();
  const [runResult, setRunResult] = useState<DepreciationRunResult | null>(null);

  const canCreate = can("accounting.fixed_assets", "create");
  const canEdit = can("accounting.fixed_assets", "edit");
  const canDelete = can("accounting.fixed_assets", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: FixedAsset[]; meta: { total: number } }>(
        `/fixed-assets?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setAssets(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load fixed assets");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
  }, []);

  // Same "true leaf" filter AccountsPage/JournalEntriesPage already use for
  // a contra-account picker: any postable account except a summary/header
  // node (identified as "any account that is itself someone else's parent_id").
  function leafOptions(chartAccounts: ChartOfAccount[]) {
    const parentIds = new Set(chartAccounts.filter((a) => a.parent_id).map((a) => a.parent_id as number));
    return chartAccounts
      .filter((a) => a.is_active && !parentIds.has(a.id))
      .map((a) => ({ value: a.id, label: `${a.account_code} - ${a.name}` }));
  }

  useEffect(() => {
    if (createCompanyId) {
      api.get<{ data: ChartOfAccount[] }>(`/chart-of-accounts?company_id=${createCompanyId}`).then((res) => setCreateChartAccounts(res.data)).catch(() => {});
    } else {
      setCreateChartAccounts([]);
    }
  }, [createCompanyId]);

  function openCreate() {
    createForm.resetFields();
    createForm.setFieldsValue({ company_id: companies[0]?.id, purchase_date: dayjs(), salvage_value: 0 });
    setCreateOpen(true);
  }

  async function handleCreate() {
    const values = await createForm.validateFields();
    setCreating(true);
    try {
      const res = await api.post<{ asset: FixedAsset; journal: { id: number } }>("/fixed-assets", {
        company_id: values.company_id,
        asset_name: values.asset_name,
        category: values.category || null,
        purchase_date: values.purchase_date.format("YYYY-MM-DD"),
        cost: values.cost,
        salvage_value: values.salvage_value || 0,
        useful_life_months: Math.round(Number(values.useful_life_years) * 12),
        contra_account_id: values.contra_account_id,
        notes: values.notes || null,
      });
      message.success(`Fixed asset recorded (Journal #${res.journal.id})`);
      setCreateOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to record fixed asset");
    } finally {
      setCreating(false);
    }
  }

  async function openView(record: FixedAsset) {
    try {
      const res = await api.get<FixedAssetDetail>(`/fixed-assets/${record.id}`);
      setViewDetail(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load fixed asset");
    }
  }

  async function handleDelete(record: FixedAsset) {
    try {
      await api.delete(`/fixed-assets/${record.id}`);
      message.success("Fixed asset deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete fixed asset");
    }
  }

  function openDispose(record: FixedAsset) {
    setDisposeAsset(record);
    disposeForm.resetFields();
    disposeForm.setFieldsValue({ disposal_date: dayjs(), disposal_amount: 0 });
    api.get<{ data: ChartOfAccount[] }>(`/chart-of-accounts?company_id=${record.company_id}`).then((res) => setDisposeChartAccounts(res.data)).catch(() => {});
  }

  async function handleDispose() {
    if (!disposeAsset) return;
    const values = await disposeForm.validateFields();
    setDisposing(true);
    try {
      await api.post(`/fixed-assets/${disposeAsset.id}/dispose`, {
        disposal_date: values.disposal_date.format("YYYY-MM-DD"),
        disposal_amount: values.disposal_amount || 0,
        contra_account_id: values.contra_account_id || null,
      });
      message.success("Fixed asset disposed");
      setDisposeAsset(null);
      setViewDetail(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to dispose fixed asset");
    } finally {
      setDisposing(false);
    }
  }

  function openRun() {
    runForm.resetFields();
    runForm.setFieldsValue({ company_id: companies[0]?.id, period_end_date: dayjs().endOf("month") });
    setRunResult(null);
    setRunOpen(true);
  }

  async function handleRun() {
    const values = await runForm.validateFields();
    setRunning(true);
    try {
      const res = await api.post<DepreciationRunResult>("/fixed-assets/depreciation/run", {
        company_id: values.company_id,
        period_end_date: values.period_end_date.format("YYYY-MM-DD"),
      });
      setRunResult(res);
      message.success(`Depreciation run complete: ${res.posted.length} posted, ${res.skipped.length} skipped`);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Depreciation run failed");
    } finally {
      setRunning(false);
    }
  }

  async function handleDeleteEntry(entryId: number, assetId: number) {
    try {
      await api.delete(`/fixed-assets/depreciation-entries/${entryId}`);
      message.success("Depreciation entry deleted");
      const res = await api.get<FixedAssetDetail>(`/fixed-assets/${assetId}`);
      setViewDetail(res);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete depreciation entry");
    }
  }

  const columns: ColumnsType<FixedAsset> = [
    { title: "No.", dataIndex: "asset_no", key: "asset_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Asset", dataIndex: "asset_name", key: "asset_name" },
    { title: "Category", dataIndex: "category", key: "category", render: (v: string | null) => v || "-" },
    { title: "Purchased", dataIndex: "purchase_date", key: "purchase_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Cost", dataIndex: "cost", key: "cost", align: "right", render: (v: string) => formatMoney(Number(v)) },
    {
      title: "Accum. Depr.",
      dataIndex: "accumulated_depreciation",
      key: "accumulated_depreciation",
      align: "right",
      render: (v: string) => formatMoney(Number(v || 0)),
    },
    { title: "Book Value", dataIndex: "book_value", key: "book_value", align: "right", render: (v: number) => formatMoney(v ?? 0) },
    { title: "Status", dataIndex: "status", key: "status", render: (v: FixedAsset["status"]) => <Tag color={STATUS_COLORS[v]}>{v}</Tag> },
    {
      title: "Actions",
      key: "actions",
      width: 130,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => openView(record)} title="View" />
          {canEdit && record.status === "active" && (
            <Button size="small" icon={<StopOutlined />} onClick={() => openDispose(record)} title="Dispose" />
          )}
          {canDelete && record.status === "active" && Number(record.accumulated_depreciation || 0) === 0 && (
            <Popconfirm title="Delete this fixed asset?" description="Reverses its acquisition journal." onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} title="Delete" />
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
          Fixed Assets
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search asset no. or name"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          {canEdit && (
            <Button icon={<CalculatorOutlined />} onClick={openRun}>
              Run Depreciation
            </Button>
          )}
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New Fixed Asset
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={assets}
        loading={loading}
        size="small"
        scroll={{ x: 1000 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal title="New Fixed Asset" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={handleCreate} confirmLoading={creating} destroyOnClose>
        <Form form={createForm} layout="vertical">
          <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
            <Select
              placeholder="Select company"
              options={companies.map((c) => ({ value: c.id, label: c.name }))}
              onChange={() => createForm.setFieldsValue({ contra_account_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="asset_name" label="Asset Name" rules={[{ required: true, message: "Asset name is required" }]}>
            <Input placeholder="e.g. Dell Laptop, Office Furniture Set" />
          </Form.Item>
          <Form.Item name="category" label="Category (optional)">
            <Input placeholder="e.g. Computer, Furniture, Vehicle" />
          </Form.Item>
          <Form.Item name="purchase_date" label="Purchase Date" rules={[{ required: true, message: "Purchase date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="cost" label="Cost" rules={[{ required: true, message: "Cost is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.01} />
          </Form.Item>
          <Form.Item name="salvage_value" label="Salvage Value (at end of useful life)">
            <InputNumber style={{ width: "100%" }} min={0} />
          </Form.Item>
          <Form.Item name="useful_life_years" label="Useful Life (Years)" rules={[{ required: true, message: "Useful life is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0.1} step={0.5} placeholder="e.g. 3, 5, 10" />
          </Form.Item>
          <Form.Item
            name="contra_account_id"
            label="Paid From / Payable To"
            rules={[{ required: true, message: "Select which account this was paid from" }]}
          >
            <Select
              showSearch
              placeholder="e.g. Bank, Cash, Accounts Payable"
              options={leafOptions(createChartAccounts)}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={viewDetail ? `Fixed Asset ${viewDetail.asset.asset_no}` : ""} open={!!viewDetail} onCancel={() => setViewDetail(null)} footer={null} width={720}>
        {viewDetail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="Asset">{viewDetail.asset.asset_name}</Descriptions.Item>
              <Descriptions.Item label="Category">{viewDetail.asset.category || "-"}</Descriptions.Item>
              <Descriptions.Item label="Purchase Date">{dayjs(viewDetail.asset.purchase_date).format("DD MMM YYYY")}</Descriptions.Item>
              <Descriptions.Item label="Status">
                <Tag color={STATUS_COLORS[viewDetail.asset.status]}>{viewDetail.asset.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Cost">Rs. {formatMoney(Number(viewDetail.asset.cost))}</Descriptions.Item>
              <Descriptions.Item label="Salvage Value">Rs. {formatMoney(Number(viewDetail.asset.salvage_value))}</Descriptions.Item>
              <Descriptions.Item label="Useful Life">{viewDetail.asset.useful_life_months} months</Descriptions.Item>
              <Descriptions.Item label="Method">Straight Line</Descriptions.Item>
              <Descriptions.Item label="Accumulated Depreciation">Rs. {formatMoney(viewDetail.accumulatedDepreciation)}</Descriptions.Item>
              <Descriptions.Item label="Book Value">
                <Typography.Text strong>Rs. {formatMoney(viewDetail.bookValue)}</Typography.Text>
              </Descriptions.Item>
              {viewDetail.asset.status === "disposed" && (
                <>
                  <Descriptions.Item label="Disposal Date">{dayjs(viewDetail.asset.disposal_date).format("DD MMM YYYY")}</Descriptions.Item>
                  <Descriptions.Item label="Disposal Amount">Rs. {formatMoney(Number(viewDetail.asset.disposal_amount))}</Descriptions.Item>
                </>
              )}
            </Descriptions>

            <Typography.Text strong style={{ display: "block", marginTop: 16, marginBottom: 8 }}>
              Depreciation Schedule
            </Typography.Text>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={viewDetail.entries}
              locale={{ emptyText: "No depreciation posted yet" }}
              columns={[
                { title: "Period Ending", dataIndex: "period_end_date", key: "period_end_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
                { title: "Amount", dataIndex: "amount", key: "amount", align: "right", render: (v: string) => formatMoney(Number(v)) },
                {
                  title: "",
                  key: "actions",
                  width: 60,
                  render: (_, entry, index) =>
                    canDelete && index === viewDetail.entries.length - 1 && viewDetail.asset.status === "active" ? (
                      <Popconfirm title="Delete this depreciation entry?" description="Reverses its journal." onConfirm={() => handleDeleteEntry(entry.id, viewDetail.asset.id)}>
                        <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                      </Popconfirm>
                    ) : null,
                },
              ]}
            />

            {canEdit && viewDetail.asset.status === "active" && (
              <div style={{ marginTop: 16, textAlign: "right" }}>
                <Button danger icon={<StopOutlined />} onClick={() => openDispose(viewDetail.asset)}>
                  Dispose
                </Button>
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal
        title={disposeAsset ? `Dispose ${disposeAsset.asset_name}` : "Dispose Fixed Asset"}
        open={!!disposeAsset}
        onCancel={() => setDisposeAsset(null)}
        onOk={handleDispose}
        confirmLoading={disposing}
        destroyOnClose
      >
        <Form form={disposeForm} layout="vertical">
          <Form.Item name="disposal_date" label="Disposal Date" rules={[{ required: true, message: "Disposal date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="disposal_amount" label="Disposal Proceeds (0 if scrapped)">
            <InputNumber style={{ width: "100%" }} min={0} />
          </Form.Item>
          <Form.Item name="contra_account_id" label="Received Into (required if proceeds > 0)">
            <Select
              showSearch
              allowClear
              placeholder="e.g. Bank, Cash, Accounts Receivable"
              options={leafOptions(disposeChartAccounts)}
              filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="Run Depreciation" open={runOpen} onCancel={() => setRunOpen(false)} onOk={handleRun} confirmLoading={running} okText="Run">
        <Form form={runForm} layout="vertical">
          <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Company is required" }]}>
            <Select options={companies.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="period_end_date" label="Period Ending" rules={[{ required: true, message: "Period end date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
        </Form>
        {runResult && (
          <div style={{ marginTop: 8 }}>
            <Typography.Text strong>Posted ({runResult.posted.length})</Typography.Text>
            {runResult.posted.map((p) => (
              <div key={p.assetId} style={{ fontSize: 12 }}>
                {p.assetName}: Rs. {formatMoney(p.amount)} (Journal #{p.journalId})
              </div>
            ))}
            {runResult.skipped.length > 0 && (
              <>
                <Typography.Text strong style={{ display: "block", marginTop: 8 }}>
                  Skipped ({runResult.skipped.length})
                </Typography.Text>
                {runResult.skipped.map((s) => (
                  <div key={s.assetId} style={{ fontSize: 12, color: "#888" }}>
                    {s.assetName}: {s.reason}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
