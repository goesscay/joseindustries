import { useCallback, useEffect, useState } from "react";
import { Table, Button, Input, Space, Modal, Form, message, Popconfirm, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Vendor } from "../types";

const PAGE_SIZE = 10;

export function VendorsPage() {
  const { user, can } = useAuth();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canCreate = can("contacts.vendors", "create");
  const canEdit = can("contacts.vendors", "edit");
  const canDelete = can("contacts.vendors", "delete");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Vendor[]; meta: { total: number } }>(
        `/vendors?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setVendors(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load vendors");
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
    setModalOpen(true);
  }

  function openEdit(record: Vendor) {
    setEditing(record);
    form.setFieldsValue(record);
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/vendors/${editing.id}`, values);
        message.success("Vendor updated");
      } else {
        await api.post("/vendors", values);
        message.success("Vendor created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save vendor");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: Vendor) {
    try {
      await api.delete(`/vendors/${record.id}`);
      message.success("Vendor deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete vendor");
    }
  }

  const columns: ColumnsType<Vendor> = [
    { title: "Name", dataIndex: "name", key: "name" },
    { title: "Phone", dataIndex: "phone", key: "phone" },
    { title: "GSTIN", dataIndex: "gstin", key: "gstin" },
    { title: "State", dataIndex: "state", key: "state" },
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
            <Popconfirm title="Delete this vendor?" onConfirm={() => handleDelete(record)}>
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
          Vendors
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search name, phone, email"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Add Vendor
          </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={vendors}
        loading={loading}
        size="small"
        scroll={{ x: 640 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? "Edit Vendor" : "Add Vendor"}
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
          <Form.Item name="phone" label="Phone">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input />
          </Form.Item>
          <Form.Item name="gstin" label="GSTIN">
            <Input />
          </Form.Item>
          <Form.Item name="state" label="State">
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
