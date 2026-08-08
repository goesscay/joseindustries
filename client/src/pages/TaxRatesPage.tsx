import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, Input, InputNumber, Switch, message, Popconfirm, Typography, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { TaxRate } from "../types";

export function TaxRatesPage() {
  const { user, can } = useAuth();
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TaxRate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canCreate = can("settings.tax_gst", "create");
  const canEdit = can("settings.tax_gst", "edit");
  const canDelete = can("settings.tax_gst", "delete");
  const canManage = canEdit || canDelete;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: TaxRate[] }>("/tax-rates");
      setTaxRates(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load tax rates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ is_default: false });
    setModalOpen(true);
  }

  function openEdit(record: TaxRate) {
    setEditing(record);
    form.setFieldsValue({ label: record.label, rate: Number(record.rate), is_default: Boolean(record.is_default) });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/tax-rates/${editing.id}`, values);
        message.success("Tax rate updated");
      } else {
        await api.post("/tax-rates", values);
        message.success("Tax rate created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save tax rate");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: TaxRate) {
    try {
      await api.delete(`/tax-rates/${record.id}`);
      message.success("Tax rate deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete tax rate");
    }
  }

  const columns: ColumnsType<TaxRate> = [
    { title: "Label", dataIndex: "label", key: "label" },
    { title: "Rate", dataIndex: "rate", key: "rate", render: (v: string) => `${Number(v)}%` },
    {
      title: "Default",
      dataIndex: "is_default",
      key: "is_default",
      render: (v: boolean | number) => (v ? <Tag color="green">Default</Tag> : null),
    },
    {
      title: "Actions",
      key: "actions",
      width: 110,
      render: (_, record) =>
        canManage && (
          <Space size="small">
            {canEdit ? (
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
            ) : (
              <Button size="small" icon={<EditOutlined />} disabled title="View only" />
            )}
            {canDelete && (
              <Popconfirm title="Delete this tax rate?" onConfirm={() => handleDelete(record)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
          </Space>
        ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Tax &amp; GST
          </Typography.Title>
          <Typography.Text type="secondary">
            GST rate slabs used across Items and document line items. GST split (CGST+SGST vs IGST) is always computed
            automatically from company/customer state, never set manually here.
          </Typography.Text>
        </div>
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Rate
          </Button>
        )}
      </Space>

      <Table rowKey="id" columns={columns} dataSource={taxRates} loading={loading} size="small" pagination={false} />

      <Modal
        title={editing ? "Edit Tax Rate" : "Add Tax Rate"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="label" label="Label" rules={[{ required: true, message: "Label is required" }]}>
            <Input placeholder="e.g. GST 18%" />
          </Form.Item>
          <Form.Item name="rate" label="Rate (%)" rules={[{ required: true, message: "Rate is required" }]}>
            <InputNumber style={{ width: "100%" }} min={0} max={100} />
          </Form.Item>
          <Form.Item name="is_default" label="Default rate for new items" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
