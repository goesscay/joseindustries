import { useCallback, useEffect, useState } from "react";
import { Table, Button, Input, InputNumber, Space, Modal, Form, message, Popconfirm, Typography, Switch, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Item } from "../types";

const PAGE_SIZE = 10;

export function ItemsPage() {
  const { user, can } = useAuth();
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canCreate = can("items.items", "create");
  const canEdit = can("items.items", "edit");
  const canDelete = can("items.items", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Item[]; meta: { total: number } }>(
        `/items?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setItems(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load items");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ unit: "pcs", tax_rate: 18, track_inventory: false });
    setModalOpen(true);
  }

  function openEdit(record: Item) {
    setEditing(record);
    form.setFieldsValue({
      ...record,
      default_rate: Number(record.default_rate),
      tax_rate: Number(record.tax_rate),
      track_inventory: Boolean(record.track_inventory),
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/items/${editing.id}`, values);
        message.success("Item updated");
      } else {
        await api.post("/items", values);
        message.success("Item created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save item");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: Item) {
    try {
      await api.delete(`/items/${record.id}`);
      message.success("Item deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete item");
    }
  }

  const columns: ColumnsType<Item> = [
    { title: "Name", dataIndex: "name", key: "name" },
    { title: "HSN", dataIndex: "hsn_code", key: "hsn_code" },
    { title: "Unit", dataIndex: "unit", key: "unit" },
    { title: "Rate", dataIndex: "default_rate", key: "default_rate" },
    { title: "Tax %", dataIndex: "tax_rate", key: "tax_rate" },
    {
      title: "Stock Tracked",
      dataIndex: "track_inventory",
      key: "track_inventory",
      render: (v: boolean | number) => (Boolean(v) ? <Tag color="blue">Tracked</Tag> : <Tag>Not tracked</Tag>),
    },
    {
      title: "Actions",
      key: "actions",
      width: 110,
      render: (_, record) => (
        <Space size="small">
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled title="View only" />
          )}
          {canDelete && (
            <Popconfirm title="Delete this item?" onConfirm={() => handleDelete(record)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
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
          Items
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search name or HSN"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Item
          </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        size="small"
        scroll={{ x: 560 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? "Edit Item" : "Add Item"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="hsn_code" label="HSN/SAC Code">
            <Input />
          </Form.Item>
          <Form.Item name="unit" label="Unit">
            <Input />
          </Form.Item>
          <Form.Item name="default_rate" label="Default Rate">
            <InputNumber style={{ width: "100%" }} min={0} />
          </Form.Item>
          <Form.Item name="tax_rate" label="Tax Rate (%)">
            <InputNumber style={{ width: "100%" }} min={0} max={100} />
          </Form.Item>
          <Form.Item
            name="track_inventory"
            label="Track Stock"
            valuePropName="checked"
            tooltip="Only items with this enabled participate in stock tracking - leave off for services, freight, installation, etc."
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
