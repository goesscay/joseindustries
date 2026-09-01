import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Table,
  Button,
  Modal,
  Form,
  Select,
  DatePicker,
  Input,
  InputNumber,
  Space,
  Typography,
  Tag,
  message,
  Popconfirm,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EyeOutlined, UndoOutlined, DeleteOutlined } from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { ChartOfAccount, Company, Journal, JournalLine } from "../types";

const { RangePicker } = DatePicker;
const PAGE_SIZE = 20;

// Every document-posted journal sets its own source_type (see
// src/services/accounting.ts's posting functions) - this only needs to
// label the ones a user would actually see created outside this page.
// Anything unlisted still gets a readable fallback below rather than
// showing the raw snake_case value.
const SOURCE_LABELS: Record<string, string> = {
  tax_invoice: "Tax Invoice",
  tax_invoice_cogs: "Tax Invoice (COGS)",
  quotation: "Quotation",
  proforma_invoice: "Proforma Invoice",
  delivery_challan: "Delivery Challan",
  receipt: "Receipt",
  purchase_bill: "Purchase Bill",
  vendor_payment: "Vendor Payment",
  expense: "Expense",
  opening_stock: "Opening Stock",
  stock_adjustment: "Stock Adjustment",
};

function sourceLabel(sourceType: string | null): string {
  if (!sourceType) return "Manual";
  return SOURCE_LABELS[sourceType] ?? sourceType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface LineFormValue {
  account_id?: number;
  debit?: number;
  credit?: number;
  description?: string;
}

export function JournalEntriesPage() {
  const { can } = useAuth();
  const canCreate = can("accounting.journals", "create");
  // journals.ts gates POST /:id/reverse with the "edit" action - matching
  // that here rather than introducing a different permission shape for the
  // same underlying capability.
  const canReverse = can("accounting.journals", "edit");

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const [viewJournal, setViewJournal] = useState<{ journal: Journal; lines: JournalLine[] } | null>(null);
  const [reversing, setReversing] = useState(false);

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.data);
        setCompanyId((prev) => prev ?? res.data[0]?.id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        company_id: String(companyId),
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      if (range) {
        params.set("from", range[0].format("YYYY-MM-DD"));
        params.set("to", range[1].format("YYYY-MM-DD"));
      }
      const res = await api.get<{ data: Journal[]; total: number }>(`/journals?${params.toString()}`);
      setJournals(res.data);
      setTotal(res.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load journal entries");
    } finally {
      setLoading(false);
    }
  }, [companyId, page, range]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!companyId) return;
    api
      .get<{ data: ChartOfAccount[] }>(`/chart-of-accounts?company_id=${companyId}`)
      .then((res) => setAccounts(res.data))
      .catch(() => {});
  }, [companyId]);

  // A journal may only post to a leaf account, never a summary/header node
  // (1000 Assets, 1100 Current Assets, ...) - identified here as "any
  // account that is itself someone else's parent_id", which holds for both
  // the seeded header rows and any future custom grouping account, unlike
  // filtering on category (blank for headers, but also blank on a
  // brand-new custom leaf account before anyone sets one).
  const parentIds = useMemo(() => new Set(accounts.filter((a) => a.parent_id).map((a) => a.parent_id as number)), [accounts]);
  const accountOptions = useMemo(
    () =>
      accounts
        .filter((a) => a.is_active && !parentIds.has(a.id))
        .map((a) => ({ value: a.id, label: `${a.account_code} - ${a.name}` })),
    [accounts, parentIds]
  );
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const watchedLines: LineFormValue[] = Form.useWatch("lines", form) ?? [];
  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const l of watchedLines) {
      debit += Number(l?.debit) || 0;
      credit += Number(l?.credit) || 0;
    }
    return { debit: round2(debit), credit: round2(credit) };
  }, [watchedLines]);
  const isBalanced = totals.debit > 0 && totals.debit === totals.credit;

  function openCreate() {
    form.resetFields();
    form.setFieldsValue({
      company_id: companyId,
      journal_date: dayjs(),
      lines: [
        { account_id: undefined, debit: undefined, credit: undefined, description: undefined },
        { account_id: undefined, debit: undefined, credit: undefined, description: undefined },
      ],
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    if (!isBalanced) {
      message.error("Total debits must equal total credits before this can be posted");
      return;
    }
    setSaving(true);
    try {
      await api.post("/journals", {
        company_id: values.company_id,
        journal_date: values.journal_date.format("YYYY-MM-DD"),
        reference: values.reference || null,
        description: values.description || null,
        lines: (values.lines as LineFormValue[]).map((l) => ({
          account_id: l.account_id,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          description: l.description || null,
        })),
      });
      message.success("Journal entry posted");
      setModalOpen(false);
      if (companyId === values.company_id) {
        load();
      } else {
        setCompanyId(values.company_id);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to post journal entry");
    } finally {
      setSaving(false);
    }
  }

  async function openView(record: Journal) {
    try {
      const res = await api.get<{ journal: Journal; lines: JournalLine[] }>(`/journals/${record.id}`);
      setViewJournal(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load journal entry");
    }
  }

  async function handleReverse(journal: Journal) {
    setReversing(true);
    try {
      await api.post(`/journals/${journal.id}/reverse`, {});
      message.success("Journal entry reversed");
      setViewJournal(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to reverse journal entry");
    } finally {
      setReversing(false);
    }
  }

  const columns: ColumnsType<Journal> = [
    {
      title: "Date",
      dataIndex: "journal_date",
      key: "journal_date",
      render: (d: string) => dayjs(d).format("DD MMM YYYY"),
    },
    { title: "Reference", dataIndex: "reference", key: "reference", render: (v: string | null) => v || "-" },
    { title: "Description", dataIndex: "description", key: "description", render: (v: string | null) => v || "-" },
    {
      title: "Source",
      dataIndex: "source_type",
      key: "source_type",
      render: (v: string | null) => <Tag color={v ? "blue" : "green"}>{sourceLabel(v)}</Tag>,
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (v: string) => <Tag color={v === "posted" ? "success" : "default"}>{v === "posted" ? "Posted" : "Reversed"}</Tag>,
    },
    {
      title: "Actions",
      key: "actions",
      width: 90,
      render: (_, record) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => openView(record)} title="View" />
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Journal Entries
        </Typography.Title>
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New Journal Entry
          </Button>
        )}
      </Space>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => {
            setCompanyId(v);
            setPage(1);
          }}
        />
        <RangePicker
          value={range}
          format="DD MMM YYYY"
          allowClear
          onChange={(v) => {
            setRange(v && v[0] && v[1] ? [v[0], v[1]] : null);
            setPage(1);
          }}
        />
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={journals}
        loading={loading}
        size="small"
        scroll={{ x: 700 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title="New Journal Entry"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={760}
        destroyOnClose
        okButtonProps={{ disabled: !isBalanced }}
        okText="Post Journal Entry"
      >
        <Form form={form} layout="vertical">
          <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
            <Form.Item name="company_id" label="Company" rules={[{ required: true, message: "Required" }]} style={{ flex: 1 }}>
              <Select options={companies.map((c) => ({ value: c.id, label: c.name }))} />
            </Form.Item>
            <Form.Item name="journal_date" label="Date" rules={[{ required: true, message: "Required" }]} style={{ flex: 1 }}>
              <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="reference" label="Reference (optional)" style={{ flex: 1 }}>
              <Input />
            </Form.Item>
          </div>

          <Form.Item
            name="description"
            label="Description"
            rules={[{ required: true, message: "A description helps identify this entry later" }]}
          >
            <Input placeholder="e.g. GST payment for July 2026" />
          </Form.Item>

          <Form.List name="lines">
            {(fields, { add, remove }) => (
              <div style={{ marginBottom: 16 }}>
                <Typography.Text strong>Lines</Typography.Text>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", marginTop: 8, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", fontSize: 12, color: "#888" }}>
                        <th style={{ minWidth: 220 }}>Account</th>
                        <th style={{ minWidth: 160 }}>Description</th>
                        <th style={{ width: 120 }}>Debit</th>
                        <th style={{ width: 120 }}>Credit</th>
                        <th style={{ width: 36 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map((field) => (
                        <tr key={field.key}>
                          <td>
                            <Form.Item
                              name={[field.name, "account_id"]}
                              rules={[{ required: true, message: "Required" }]}
                              style={{ marginBottom: 8 }}
                            >
                              <Select
                                showSearch
                                placeholder="Select account"
                                options={accountOptions}
                                filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
                              />
                            </Form.Item>
                          </td>
                          <td>
                            <Form.Item name={[field.name, "description"]} style={{ marginBottom: 8 }}>
                              <Input placeholder="Optional" />
                            </Form.Item>
                          </td>
                          <td>
                            <Form.Item name={[field.name, "debit"]} style={{ marginBottom: 8 }}>
                              <InputNumber
                                min={0}
                                style={{ width: "100%" }}
                                onChange={(v) => {
                                  if (v) form.setFields([{ name: ["lines", field.name, "credit"], value: undefined }]);
                                }}
                              />
                            </Form.Item>
                          </td>
                          <td>
                            <Form.Item name={[field.name, "credit"]} style={{ marginBottom: 8 }}>
                              <InputNumber
                                min={0}
                                style={{ width: "100%" }}
                                onChange={(v) => {
                                  if (v) form.setFields([{ name: ["lines", field.name, "debit"], value: undefined }]);
                                }}
                              />
                            </Form.Item>
                          </td>
                          <td>
                            {fields.length > 2 && (
                              <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button icon={<PlusOutlined />} onClick={() => add({ account_id: undefined, debit: undefined, credit: undefined })}>
                  Add Line
                </Button>
              </div>
            )}
          </Form.List>

          <div style={{ textAlign: "right", borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
            <div>Total Debit: Rs. {totals.debit.toFixed(2)}</div>
            <div>Total Credit: Rs. {totals.credit.toFixed(2)}</div>
            <Typography.Text strong type={isBalanced ? "success" : "danger"}>
              {isBalanced ? "Balanced" : `Not balanced - difference: Rs. ${Math.abs(totals.debit - totals.credit).toFixed(2)}`}
            </Typography.Text>
          </div>
        </Form>
      </Modal>

      <Modal
        title={viewJournal ? `Journal Entry #${viewJournal.journal.id}` : ""}
        open={!!viewJournal}
        onCancel={() => setViewJournal(null)}
        footer={null}
        width={640}
      >
        {viewJournal && (
          <>
            <p>
              <strong>Date:</strong> {dayjs(viewJournal.journal.journal_date).format("DD MMM YYYY")}
            </p>
            <p>
              <strong>Reference:</strong> {viewJournal.journal.reference || "-"}
            </p>
            <p>
              <strong>Description:</strong> {viewJournal.journal.description || "-"}
            </p>
            <p>
              <strong>Source:</strong> {sourceLabel(viewJournal.journal.source_type)}
            </p>
            <p>
              <strong>Status:</strong>{" "}
              <Tag color={viewJournal.journal.status === "posted" ? "success" : "default"}>
                {viewJournal.journal.status === "posted" ? "Posted" : "Reversed"}
              </Tag>
            </p>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={viewJournal.lines}
              columns={[
                {
                  title: "Account",
                  key: "account",
                  render: (_, l: JournalLine) => {
                    const a = accountsById.get(l.account_id);
                    return a ? `${a.account_code} - ${a.name}` : `#${l.account_id}`;
                  },
                },
                { title: "Description", dataIndex: "description", key: "description", render: (v: string | null) => v || "-" },
                {
                  title: "Debit",
                  dataIndex: "debit",
                  key: "debit",
                  align: "right",
                  render: (v: string) => (Number(v) ? Number(v).toFixed(2) : ""),
                },
                {
                  title: "Credit",
                  dataIndex: "credit",
                  key: "credit",
                  align: "right",
                  render: (v: string) => (Number(v) ? Number(v).toFixed(2) : ""),
                },
              ]}
            />
            {canReverse && viewJournal.journal.status === "posted" && viewJournal.journal.source_type === null && (
              <div style={{ marginTop: 16, textAlign: "right" }}>
                <Popconfirm
                  title="Reverse this journal entry?"
                  description="This posts an offsetting entry dated today. The original is kept for the audit trail, never deleted."
                  onConfirm={() => handleReverse(viewJournal.journal)}
                >
                  <Button danger icon={<UndoOutlined />} loading={reversing}>
                    Reverse
                  </Button>
                </Popconfirm>
              </div>
            )}
            {viewJournal.journal.status === "posted" && viewJournal.journal.source_type !== null && (
              <Typography.Text type="secondary" style={{ display: "block", marginTop: 16 }}>
                This entry was posted automatically by a {sourceLabel(viewJournal.journal.source_type)} - reverse or
                correct it via that document instead of from here.
              </Typography.Text>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
