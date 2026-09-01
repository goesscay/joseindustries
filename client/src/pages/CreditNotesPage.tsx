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
  Checkbox,
  message,
  Popconfirm,
  Typography,
  Tag,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EyeOutlined, DeleteOutlined, StopOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { RemoteSelect } from "../components/RemoteSelect";
import { CreditNote, CreditNoteItem, DocumentLineItem, SalesDocument } from "../types";

const PAGE_SIZE = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const STATUS_COLORS: Record<CreditNote["status"], string> = { draft: "default", cancelled: "error" };

// One editable row in the "New Credit Note" modal - seeded from the source
// invoice's own document_items and never allowed to exceed that line's
// original quantity (the server re-validates this independently; this is
// just the same rule surfaced live in the UI).
interface EditableLine {
  document_item_id: number;
  item_id: number | null;
  description: string;
  originalQty: number;
  unit: string;
  rate: number;
  tax_rate: number;
  qty: number;
  restock: boolean;
}

export function CreditNotesPage() {
  const { can } = useAuth();
  const [notes, setNotes] = useState<CreditNote[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [selectedInvoice, setSelectedInvoice] = useState<SalesDocument | null>(null);
  const [editableLines, setEditableLines] = useState<EditableLine[]>([]);
  const [loadingInvoice, setLoadingInvoice] = useState(false);

  const [viewNote, setViewNote] = useState<{ creditNote: CreditNote; items: CreditNoteItem[] } | null>(null);

  const canCreate = can("sales.credit_notes", "create");
  const canEdit = can("sales.credit_notes", "edit");
  const canDelete = can("sales.credit_notes", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: CreditNote[]; meta: { total: number } }>(
        `/credit-notes?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setNotes(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load credit notes");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    form.resetFields();
    form.setFieldsValue({ issue_date: dayjs() });
    setSelectedInvoice(null);
    setEditableLines([]);
    setModalOpen(true);
  }

  async function handleInvoiceSelected(invoiceId: number | undefined) {
    form.setFieldsValue({ tax_invoice_id: invoiceId });
    if (!invoiceId) {
      setSelectedInvoice(null);
      setEditableLines([]);
      return;
    }
    setLoadingInvoice(true);
    try {
      const res = await api.get<{ document: SalesDocument; items: DocumentLineItem[] }>(`/tax-invoices/${invoiceId}`);
      setSelectedInvoice(res.document);
      setEditableLines(
        res.items.map((i) => ({
          document_item_id: i.id!,
          item_id: i.item_id,
          description: i.description,
          originalQty: Number(i.qty),
          unit: i.unit,
          rate: Number(i.rate),
          tax_rate: Number(i.tax_rate),
          qty: Number(i.qty),
          restock: true,
        }))
      );
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load the selected invoice");
      setSelectedInvoice(null);
      setEditableLines([]);
    } finally {
      setLoadingInvoice(false);
    }
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setEditableLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const totals = (() => {
    let subtotal = 0;
    let tax = 0;
    for (const line of editableLines) {
      if (line.qty <= 0) continue;
      const taxable = round2(line.qty * line.rate);
      subtotal += taxable;
      tax += round2((taxable * line.tax_rate) / 100);
    }
    subtotal = round2(subtotal);
    tax = round2(tax);
    return { subtotal, tax, grandTotal: round2(subtotal + tax) };
  })();

  async function handleSubmit() {
    const values = await form.validateFields();
    const creditedLines = editableLines.filter((l) => l.qty > 0);
    if (creditedLines.length === 0) {
      message.error("Credit at least one line item");
      return;
    }
    setSaving(true);
    try {
      const { journal, stockJournal } = await api.post<{
        journal: { id: number } | null;
        stockJournal: { id: number } | null;
      }>("/credit-notes", {
        tax_invoice_id: values.tax_invoice_id,
        issue_date: values.issue_date.format("YYYY-MM-DD"),
        reason: values.reason || null,
        notes: values.notes || null,
        items: creditedLines.map((l) => ({ document_item_id: l.document_item_id, qty: l.qty, restock: l.restock })),
      });
      message.success(
        `Credit note created (Journal #${journal?.id}${stockJournal ? `, stock reversal #${stockJournal.id}` : ""})`
      );
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to create credit note");
    } finally {
      setSaving(false);
    }
  }

  async function openView(record: CreditNote) {
    try {
      const res = await api.get<{ creditNote: CreditNote; items: CreditNoteItem[] }>(`/credit-notes/${record.id}`);
      setViewNote(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load credit note");
    }
  }

  async function handleCancel(record: CreditNote) {
    try {
      await api.patch(`/credit-notes/${record.id}/status`, { status: "cancelled" });
      message.success("Credit note cancelled");
      setViewNote(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to cancel credit note");
    }
  }

  async function handleDelete(record: CreditNote) {
    try {
      await api.delete(`/credit-notes/${record.id}`);
      message.success("Credit note deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete credit note");
    }
  }

  const columns: ColumnsType<CreditNote> = [
    { title: "No.", dataIndex: "credit_note_no", key: "credit_note_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Customer", dataIndex: "customer_name", key: "customer_name" },
    { title: "Against Invoice", dataIndex: "source_invoice_no", key: "source_invoice_no" },
    { title: "Date", dataIndex: "issue_date", key: "issue_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Status", dataIndex: "status", key: "status", render: (v: CreditNote["status"]) => <Tag color={STATUS_COLORS[v]}>{v}</Tag> },
    { title: "Total", dataIndex: "grand_total", key: "grand_total", render: (v: string) => `Rs. ${Number(v).toFixed(2)}` },
    {
      title: "Actions",
      key: "actions",
      width: 130,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => openView(record)} title="View" />
          {canEdit && record.status === "draft" && (
            <Popconfirm title="Cancel this credit note?" description="Reverses its journal and any stock effect." onConfirm={() => handleCancel(record)}>
              <Button size="small" danger icon={<StopOutlined />} title="Cancel" />
            </Popconfirm>
          )}
          {canDelete && record.status === "draft" && (
            <Popconfirm title="Delete this credit note?" onConfirm={() => handleDelete(record)}>
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
          Credit Notes
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search number or customer"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 240 }}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New Credit Note
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={notes}
        loading={loading}
        size="small"
        scroll={{ x: 900 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title="New Credit Note"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={760}
        destroyOnClose
        okButtonProps={{ disabled: editableLines.every((l) => l.qty <= 0) }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="tax_invoice_id" label="Against Tax Invoice" rules={[{ required: true, message: "Select the invoice to credit" }]}>
            <RemoteSelect<SalesDocument>
              searchPath="/tax-invoices"
              mapOption={(d) => ({ value: d.id, label: `${d.doc_number} - ${d.customer_name ?? ""}` })}
              placeholder="Search invoice number or customer"
              onChange={handleInvoiceSelected}
              loading={loadingInvoice}
            />
          </Form.Item>

          {selectedInvoice && (
            <>
              <Typography.Text type="secondary">
                Customer: {selectedInvoice.customer_name} &nbsp;|&nbsp; Invoice total: Rs. {Number(selectedInvoice.grand_total).toFixed(2)}
              </Typography.Text>

              <div style={{ overflowX: "auto", marginTop: 12, marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: 12, color: "#888" }}>
                      <th style={{ minWidth: 180 }}>Description</th>
                      <th style={{ width: 80 }}>Invoiced</th>
                      <th style={{ width: 100 }}>Rate</th>
                      <th style={{ width: 70 }}>Tax %</th>
                      <th style={{ width: 110 }}>Qty to Credit</th>
                      <th style={{ width: 80 }}>Restock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableLines.map((line, index) => (
                      <tr key={line.document_item_id}>
                        <td>{line.description}</td>
                        <td>
                          {line.originalQty} {line.unit}
                        </td>
                        <td>{line.rate.toFixed(2)}</td>
                        <td>{line.tax_rate}%</td>
                        <td>
                          <InputNumber
                            min={0}
                            max={line.originalQty}
                            value={line.qty}
                            onChange={(v) => updateLine(index, { qty: Number(v) || 0 })}
                            style={{ width: "100%" }}
                          />
                        </td>
                        <td>
                          <Checkbox
                            checked={line.restock}
                            disabled={!line.item_id}
                            onChange={(e) => updateLine(index, { restock: e.target.checked })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ textAlign: "right", borderTop: "1px solid #f0f0f0", paddingTop: 12, marginBottom: 16 }}>
                <div>Subtotal: Rs. {totals.subtotal.toFixed(2)}</div>
                <div>Tax: Rs. {totals.tax.toFixed(2)}</div>
                <Typography.Text strong>Grand Total: Rs. {totals.grandTotal.toFixed(2)}</Typography.Text>
              </div>
            </>
          )}

          <Form.Item name="issue_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reason" label="Reason (optional)">
            <Input placeholder="e.g. Goods returned - damaged in transit" />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={viewNote ? `Credit Note ${viewNote.creditNote.credit_note_no}` : ""}
        open={!!viewNote}
        onCancel={() => setViewNote(null)}
        footer={null}
        width={640}
      >
        {viewNote && (
          <>
            <p>
              <strong>Customer:</strong> {viewNote.creditNote.customer_name}
            </p>
            <p>
              <strong>Against Invoice:</strong> {viewNote.creditNote.source_invoice_no}
            </p>
            <p>
              <strong>Date:</strong> {dayjs(viewNote.creditNote.issue_date).format("DD MMM YYYY")}
            </p>
            <p>
              <strong>Reason:</strong> {viewNote.creditNote.reason || "-"}
            </p>
            <p>
              <strong>Status:</strong> <Tag color={STATUS_COLORS[viewNote.creditNote.status]}>{viewNote.creditNote.status}</Tag>
            </p>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={viewNote.items}
              columns={[
                { title: "Description", dataIndex: "description", key: "description" },
                { title: "Qty", dataIndex: "qty", key: "qty" },
                { title: "Rate", dataIndex: "rate", key: "rate", render: (v: number) => Number(v).toFixed(2) },
                { title: "Restocked", dataIndex: "restock", key: "restock", render: (v: boolean | number) => (v ? "Yes" : "No") },
                { title: "Line Total", dataIndex: "line_total", key: "line_total", render: (v: number) => Number(v).toFixed(2) },
              ]}
            />
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <Typography.Text strong>Grand Total: Rs. {Number(viewNote.creditNote.grand_total).toFixed(2)}</Typography.Text>
            </div>
            {canEdit && viewNote.creditNote.status === "draft" && (
              <div style={{ marginTop: 16, textAlign: "right" }}>
                <Popconfirm title="Cancel this credit note?" description="Reverses its journal and any stock effect." onConfirm={() => handleCancel(viewNote.creditNote)}>
                  <Button danger icon={<StopOutlined />}>
                    Cancel
                  </Button>
                </Popconfirm>
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
