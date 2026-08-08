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
  Tabs,
  Switch,
  Checkbox,
  Alert,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, StopOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { AppUser, Role, ModuleAccess, Account } from "../types";
import { assignableRoles, canManageTarget, ROLE_COLORS, ROLE_LABELS } from "../utils/roles";
import { PERMISSION_MODULES, PermissionAction } from "../constants/permissions";

const PAGE_SIZE = 10;

const ACTIONS: { key: PermissionAction; label: string; field: keyof ModuleAccess }[] = [
  { key: "view", label: "View", field: "can_view" },
  { key: "create", label: "Create", field: "can_create" },
  { key: "edit", label: "Edit", field: "can_edit" },
  { key: "delete", label: "Delete", field: "can_delete" },
];

const MODULE_GROUPS = Array.from(new Set(PERMISSION_MODULES.map((m) => m.group)));

function emptyModulesMap(): Record<string, ModuleAccess> {
  const map: Record<string, ModuleAccess> = {};
  for (const m of PERMISSION_MODULES) {
    map[m.key] = { can_view: false, can_create: false, can_edit: false, can_delete: false };
  }
  return map;
}

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
  const selectedRole = Form.useWatch("role", form) as Role | undefined;

  // ---- Access tab state (only meaningful while role === "staff") ----
  const [accessLoading, setAccessLoading] = useState(false);
  const [permissionsRestricted, setPermissionsRestricted] = useState(false);
  const [moduleAccess, setModuleAccess] = useState<Record<string, ModuleAccess>>(emptyModulesMap());
  const [accountsRestricted, setAccountsRestricted] = useState(false);
  const [allowedAccountIds, setAllowedAccountIds] = useState<number[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);

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

  useEffect(() => {
    api.get<{ data: Account[] }>("/accounts").then((res) => setAllAccounts(res.data)).catch(() => {});
  }, []);

  function resetAccessState() {
    setPermissionsRestricted(false);
    setModuleAccess(emptyModulesMap());
    setAccountsRestricted(false);
    setAllowedAccountIds([]);
  }

  function openCreateModal() {
    setEditingUser(null);
    form.resetFields();
    resetAccessState();
    setModalOpen(true);
  }

  async function openEditModal(record: AppUser) {
    setEditingUser(record);
    form.setFieldsValue({ name: record.name, email: record.email, role: record.role, password: "" });
    resetAccessState();
    setModalOpen(true);

    if (record.role !== "staff") return;
    setAccessLoading(true);
    try {
      const [perms, accounts] = await Promise.all([
        api.get<{ restricted: boolean; modules: Record<string, ModuleAccess> }>(`/users/${record.id}/permissions`),
        api.get<{ restricted: boolean; accountIds: number[] }>(`/users/${record.id}/account-access`),
      ]);
      setPermissionsRestricted(perms.restricted);
      if (perms.restricted) {
        setModuleAccess({ ...emptyModulesMap(), ...perms.modules });
      }
      setAccountsRestricted(accounts.restricted);
      setAllowedAccountIds(accounts.accountIds);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load access settings");
    } finally {
      setAccessLoading(false);
    }
  }

  function toggleFlag(moduleKey: string, field: keyof ModuleAccess, checked: boolean) {
    setModuleAccess((prev) => ({
      ...prev,
      [moduleKey]: {
        ...prev[moduleKey],
        [field]: checked,
        // Any write action implies you can also see the module.
        can_view: field === "can_view" ? checked : checked || prev[moduleKey].can_view,
      },
    }));
  }

  async function saveAccessForUser(userId: number) {
    await Promise.all([
      api.put(`/users/${userId}/permissions`, { restricted: permissionsRestricted, modules: moduleAccess }),
      api.put(`/users/${userId}/account-access`, { restricted: accountsRestricted, accountIds: allowedAccountIds }),
    ]);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      let userId: number;
      if (editingUser) {
        await api.put(`/users/${editingUser.id}`, {
          name: values.name,
          email: values.email,
          ...(values.password ? { password: values.password } : {}),
        });
        if (values.role !== editingUser.role) {
          await api.patch(`/users/${editingUser.id}/role`, { role: values.role });
        }
        userId = editingUser.id;
        message.success("User updated");
      } else {
        const res = await api.post<{ user: AppUser }>("/users", values);
        userId = res.user.id;
        message.success("User created");
      }

      if (values.role === "staff") {
        await saveAccessForUser(userId);
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
      title: "Access",
      key: "access",
      render: (_, record) => {
        if (record.role !== "staff") return <Tag>Full</Tag>;
        if (!record.permissions.restricted && !record.accountAccess.restricted) return <Tag>Full</Tag>;
        return <Tag color="orange">Restricted</Tag>;
      },
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

  const detailsTab = (
    <Form form={form} layout="vertical" size="middle">
      <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
        <Input />
      </Form.Item>
      <Form.Item name="email" label="Email" rules={[{ required: true, type: "email", message: "Valid email is required" }]}>
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
  );

  const accessTab = (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Super Admin and Admin always have full access to everything. These controls only ever restrict a Staff account."
      />

      <Space align="center" style={{ marginBottom: 12 }}>
        <Switch checked={permissionsRestricted} onChange={setPermissionsRestricted} loading={accessLoading} />
        <Typography.Text strong>Restrict module access</Typography.Text>
      </Space>
      {!permissionsRestricted ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 20 }}
          message="This user has full view/create/edit/delete access to every module (default for a new Staff account)."
        />
      ) : (
        <div style={{ overflowX: "auto", marginBottom: 20 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #f0f0f0" }}>
                <th style={{ padding: "6px 8px" }}>Module</th>
                {ACTIONS.map((a) => (
                  <th key={a.key} style={{ padding: "6px 8px", textAlign: "center", width: 70 }}>
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MODULE_GROUPS.flatMap((group) => [
                <tr key={`group-${group}`}>
                  <td colSpan={5} style={{ padding: "10px 8px 2px", fontWeight: 600, color: "#888" }}>
                    {group}
                  </td>
                </tr>,
                ...PERMISSION_MODULES.filter((m) => m.group === group).map((m) => (
                  <tr key={m.key} style={{ borderBottom: "1px solid #fafafa" }}>
                    <td style={{ padding: "4px 8px" }}>{m.label}</td>
                    {ACTIONS.map((a) => (
                      <td key={a.key} style={{ padding: "4px 8px", textAlign: "center" }}>
                        <Checkbox
                          checked={moduleAccess[m.key]?.[a.field] ?? false}
                          onChange={(e) => toggleFlag(m.key, a.field, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}

      <Space align="center" style={{ marginBottom: 12 }}>
        <Switch checked={accountsRestricted} onChange={setAccountsRestricted} loading={accessLoading} />
        <Typography.Text strong>Restrict Bank &amp; Cash account access</Typography.Text>
      </Space>
      {!accountsRestricted ? (
        <Alert
          type="warning"
          showIcon
          message="This user can see and use every Bank & Cash account (default for a new Staff account)."
        />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Only the accounts selected below will be visible to this user, and only these may be used when recording
            Receipts, Vendor Payments, or Transfers.
          </Typography.Paragraph>
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            placeholder="Select accounts this user may access"
            value={allowedAccountIds}
            onChange={setAllowedAccountIds}
            options={allAccounts.map((a) => ({
              value: a.id,
              label: `${a.name}${a.company_code ? ` (${a.company_code})` : ""}`,
            }))}
          />
        </>
      )}
    </div>
  );

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
        scroll={{ x: 720 }}
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
        width={selectedRole === "staff" ? 720 : 480}
      >
        {selectedRole === "staff" ? (
          <Tabs
            items={[
              { key: "details", label: "Details", children: detailsTab },
              { key: "access", label: "Access", children: accessTab },
            ]}
          />
        ) : (
          detailsTab
        )}
      </Modal>
    </div>
  );
}
