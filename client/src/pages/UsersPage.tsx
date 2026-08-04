import { useCallback, useEffect, useState } from "react";
import {
  Table,
  Button,
  Input,
  Tag,
  Space,
  Modal,
  Form,
  Select,
  message,
  Popconfirm,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, StopOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { AppUser, Role } from "../types";
import { assignableRoles, canManageTarget, ROLE_COLORS, ROLE_LABELS } from "../utils/roles";

const PAGE_SIZE = 10;

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AppUser | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: AppUser[]; meta: { total: number } }>(
        `/users?page=${page}&perPage=${PAGE_SIZE}&search=${encodeURIComponent(search)}`
      );
      setUsers(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  function openCreateModal() {
    setEditingUser(null);
    form.resetFields();
    setModalOpen(true);
  }

  function openEditModal(record: AppUser) {
    setEditingUser(record);
    form.setFieldsValue({ name: record.name, email: record.email, role: record.role, password: "" });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editingUser) {
        await api.put(`/users/${editingUser.id}`, {
          name: values.name,
          email: values.email,
          ...(values.password ? { password: values.password } : {}),
        });
        if (values.role !== editingUser.role) {
          await api.patch(`/users/${editingUser.id}/role`, { role: values.role });
        }
        message.success("User updated");
      } else {
        await api.post("/users", values);
        message.success("User created");
      }
      setModalOpen(false);
      loadUsers();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save user");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus(record: AppUser) {
    try {
      await api.patch(`/users/${record.id}/status`, {
        status: record.status === "active" ? "inactive" : "active",
      });
      message.success(record.status === "active" ? "User deactivated" : "User activated");
      loadUsers();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function handleDelete(record: AppUser) {
    try {
      await api.delete(`/users/${record.id}`);
      message.success("User deleted");
      loadUsers();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  const columns: ColumnsType<AppUser> = [
    { title: "Name", dataIndex: "name", key: "name" },
    { title: "Email", dataIndex: "email", key: "email" },
    {
      title: "Role",
      dataIndex: "role",
      key: "role",
      render: (role: Role) => <Tag color={ROLE_COLORS[role]}>{ROLE_LABELS[role]}</Tag>,
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>{status === "active" ? "Active" : "Inactive"}</Tag>
      ),
    },
    {
      title: "Actions",
      key: "actions",
      width: 160,
      render: (_, record) => {
        if (!currentUser || !canManageTarget(currentUser.role, record.role)) return null;
        const isSelf = record.id === currentUser.id;
        return (
          <Space size="small">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(record)} />
            {!isSelf && (
              <Button
                size="small"
                icon={record.status === "active" ? <StopOutlined /> : <CheckCircleOutlined />}
                onClick={() => handleToggleStatus(record)}
              />
            )}
            {!isSelf && currentUser.role === "super_admin" && (
              <Popconfirm title="Delete this user?" onConfirm={() => handleDelete(record)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Users
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="Search name or email"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            Add User
          </Button>
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={loading}
        size="small"
        scroll={{ x: 640 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          onChange: setPage,
          showSizeChanger: false,
        }}
      />

      <Modal
        title={editingUser ? "Edit User" : "Add User"}
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
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: "email", message: "Valid email is required" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label={editingUser ? "New Password" : "Password"}
            rules={editingUser ? [] : [{ required: true, message: "Password is required" }]}
            extra={editingUser ? "Leave blank to keep the current password" : undefined}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true, message: "Role is required" }]}>
            <Select
              options={(currentUser ? assignableRoles(currentUser.role) : []).map((role) => ({
                value: role,
                label: ROLE_LABELS[role],
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
