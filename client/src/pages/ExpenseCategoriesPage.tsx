import { useCallback, useEffect, useState } from "react";
import { Table, Button, Space, Modal, Form, Input, message, Popconfirm, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { ExpenseCategory } from "../types";

export function ExpenseCategoriesPage() {
  const { user } = useAuth();
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const canDelete = user?.role === "super_admin" || user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: ExpenseCategory[] }>("/expense-categories");
      setCategories(res.data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load categories");
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
    setModalOpen(true);
  }

  function openEdit(record: ExpenseCategory) {
    setEditing(record);
    form.setFieldsValue(record);
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/expense-categories/${editing.id}`, values);
        message.success("Category updated");
      } else {
        await api.post("/expense-categories", values);
        message.success("Category created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save category");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(record: ExpenseCategory) {
    try {
      await api.delete(`/expense-categories/${record.id}`);
      message.success("Category deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete category");
    }
  }

  const columns: ColumnsType<ExpenseCategory> = [
    { title: "Name", dataIndex: "name", key: "name" },
    {
      title: "Actions",
      key: "actions",
      width: 110,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          {canDelete && (
            <Popconfirm title="Delete this category?" onConfirm={() => handleDelete(record)}>
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
          Expense Categories
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Add Category
        </Button>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={categories}
        loading={loading}
        size="small"
        pagination={false}
      />

      <Modal
        title={editing ? "Edit Category" : "Add Category"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input placeholder="e.g. Packaging" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
