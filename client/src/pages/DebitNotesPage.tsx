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
import { DebitNote, DebitNoteItem, PurchaseBill, PurchaseBillItem } from "../types";

const PAGE_SIZE = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const STATUS_COLORS: Record<DebitNote["status"], string> = { draft: "default", cancelled: "error" };

// One editable row in the "New Debit Note" modal - seeded from the source
// bill's own purchase_bill_items and never allowed to exceed that line's
// original quantity (the server re-validates this independently).
interface EditableLine {
  purchase_bill_item_id: number;
  item_id: number | null;
  description: string;
  originalQty: number;
  unit: string;
  rate: number;
  tax_rate: number;
  qty: number;
  restock: boolean;
}

export function DebitNotesPage() {
  const { can } = useAuth();
  const [notes, setNotes] = useState<DebitNote[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [selectedBill, setSelectedBill] = useState<PurchaseBill | null>(null);
  const [editableLines, setEditableLines] = useState<EditableLine[]>([]);
  const [loadingBill, setLoadingBill] = useState(false);

  const [viewNote, setViewNote] = useState<{ debitNote: DebitNote; items: DebitNoteItem[] } | null>(null);

  const canCreate = can("purchases.debit_notes", "create");
  const canEdit = can("purchases.debit_notes", "edit");
  const canDelete = can("purchases.debit_notes", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: DebitNote[]; meta: { total: number } }>(
        `/debit-notes?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setNotes(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load debit notes");
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
    setSelectedBill(null);
    setEditableLines([]);
    setModalOpen(true);
  }

  async function handleBillSelected(billId: number | undefined) {
    form.setFieldsValue({ purchase_bill_id: billId });
    if (!billId) {
      setSelectedBill(null);
      setEditableLines([]);
      return;
    }
    setLoadingBill(true);
    try {
      const res = await api.get<{ bill: PurchaseBill; items: PurchaseBillItem[] }>(`/purchase-bills/${billId}`);
      setSelectedBill(res.bill);
      setEditableLines(
        res.items.map((i) => ({
          purchase_bill_item_id: i.id!,
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
      message.error(err instanceof Error ? err.message : "Failed to load the selected bill");
      setSelectedBill(null);
      setEditableLines([]);
    } finally {
      setLoadingBill(false);
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
    return { subtotal, tax, totalAmount: round2(subtotal + tax) };
  })();

  async function handleSubmit() {
    const values = await form.validateFields();
    const debitedLines = editableLines.filter((l) => l.qty > 0);
    if (debitedLines.length === 0) {
      message.error("Debit at least one line item");
      return;
    }
    setSaving(true);
    try {
      const { journal } = await api.post<{ journal: { id: number } | null }>("/debit-notes", {
        purchase_bill_id: values.purchase_bill_id,
        issue_date: values.issue_date.format("YYYY-MM-DD"),
        reason: values.reason || null,
        notes: values.notes || null,
        items: debitedLines.map((l) => ({ purchase_bill_item_id: l.purchase_bill_item_id, qty: l.qty, restock: l.restock })),
      });
      message.success(`Debit note created (Journal #${journal?.id})`);
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to create debit note");
    } finally {
      setSaving(false);
    }
  }

  async function openView(record: DebitNote) {
    try {
      const res = await api.get<{ debitNote: DebitNote; items: DebitNoteItem[] }>(`/debit-notes/${record.id}`);
      setViewNote(res);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load debit note");
    }
  }

  async function handleCancel(record: DebitNote) {
    try {
      await api.patch(`/debit-notes/${record.id}/status`, { status: "cancelled" });
      message.success("Debit note cancelled");
      setViewNote(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to cancel debit note");
    }
  }

  async function handleDelete(record: DebitNote) {
    try {
      await api.delete(`/debit-notes/${record.id}`);
      message.success("Debit note deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete debit note");
    }
  }

  const columns: ColumnsType<DebitNote> = [
    { title: "No.", dataIndex: "debit_note_no", key: "debit_note_no" },
    { title: "Company", dataIndex: "company_code", key: "company_code", width: 90 },
    { title: "Vendor", dataIndex: "vendor_name", key: "vendor_name" },
    { title: "Against Bill", dataIndex: "source_bill_no", key: "source_bill_no" },
    { title: "Date", dataIndex: "issue_date", key: "issue_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Status", dataIndex: "status", key: "status", render: (v: DebitNote["status"]) => <Tag color={STATUS_COLORS[v]}>{v}</Tag> },
    { title: "Total", dataIndex: "total_amount", key: "total_amount", render: (v: string) => `Rs. ${Number(v).toFixed(2)}` },
    {
      title: "Actions",
      key: "actions",
      width: 130,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => openView(record)} title="View" />
          {canEdit && record.status === "draft" && (
            <Popconfirm title="Cancel this debit note?" description="Reverses its journal and any stock effect." onConfirm={() => handleCancel(record)}>
              <Button size="small" danger icon={<StopOutlined />} title="Cancel" />
            </Popconfirm>
          )}
          {canDelete && record.status === "draft" && (
            <Popconfirm title="Delete this debit note?" onConfirm={() => handleDelete(record)}>
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
          Debit Notes
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search number or vendor"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 240 }}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              New Debit Note
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
        title="New Debit Note"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={760}
        destroyOnClose
        okButtonProps={{ disabled: editableLines.every((l) => l.qty <= 0) }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="purchase_bill_id" label="Against Purchase Bill" rules={[{ required: true, message: "Select the bill to debit" }]}>
            <RemoteSelect<PurchaseBill>
              searchPath="/purchase-bills"
              mapOption={(b) => ({ value: b.id, label: `${b.bill_no} - ${b.vendor_name ?? ""}` })}
              placeholder="Search bill number or vendor"
              onChange={handleBillSelected}
              loading={loadingBill}
            />
          </Form.Item>

          {selectedBill && (
            <>
              <Typography.Text type="secondary">
                Vendor: {selectedBill.vendor_name} &nbsp;|&nbsp; Bill total: Rs. {Number(selectedBill.total_amount).toFixed(2)}
              </Typography.Text>

              <div style={{ overflowX: "auto", marginTop: 12, marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: 12, color: "#888" }}>
                      <th style={{ minWidth: 180 }}>Description</th>
                      <th style={{ width: 80 }}>Billed</th>
                      <th style={{ width: 100 }}>Rate</th>
                      <th style={{ width: 70 }}>Tax %</th>
                      <th style={{ width: 110 }}>Qty to Debit</th>
                      <th style={{ width: 80 }}>Returns Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editableLines.map((line, index) => (
                      <tr key={line.purchase_bill_item_id}>
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
                <Typography.Text strong>Total: Rs. {totals.totalAmount.toFixed(2)}</Typography.Text>
              </div>
            </>
          )}

          <Form.Item name="issue_date" label="Date" rules={[{ required: true, message: "Date is required" }]}>
            <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reason" label="Reason (optional)">
            <Input placeholder="e.g. Goods returned - quality issue" />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={viewNote ? `Debit Note ${viewNote.debitNote.debit_note_no}` : ""}
        open={!!viewNote}
        onCancel={() => setViewNote(null)}
        footer={null}
        width={640}
      >
        {viewNote && (
          <>
            <p>
              <strong>Vendor:</strong> {viewNote.debitNote.vendor_name}
            </p>
            <p>
              <strong>Against Bill:</strong> {viewNote.debitNote.source_bill_no}
            </p>
            <p>
              <strong>Date:</strong> {dayjs(viewNote.debitNote.issue_date).format("DD MMM YYYY")}
            </p>
            <p>
              <strong>Reason:</strong> {viewNote.debitNote.reason || "-"}
            </p>
            <p>
              <strong>Status:</strong> <Tag color={STATUS_COLORS[viewNote.debitNote.status]}>{viewNote.debitNote.status}</Tag>
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
                { title: "Returned", dataIndex: "restock", key: "restock", render: (v: boolean | number) => (v ? "Yes" : "No") },
                { title: "Line Total", dataIndex: "line_total", key: "line_total", render: (v: number) => Number(v).toFixed(2) },
              ]}
            />
            <div style={{ marginTop: 12, textAlign: "right" }}>
              <Typography.Text strong>Total: Rs. {Number(viewNote.debitNote.total_amount).toFixed(2)}</Typography.Text>
            </div>
            {canEdit && viewNote.debitNote.status === "draft" && (
              <div style={{ marginTop: 16, textAlign: "right" }}>
                <Popconfirm title="Cancel this debit note?" description="Reverses its journal and any stock effect." onConfirm={() => handleCancel(viewNote.debitNote)}>
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
