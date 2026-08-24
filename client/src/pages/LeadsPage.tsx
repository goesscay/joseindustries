import { useCallback, useEffect, useState } from "react";
import {
  Table,
  Button,
  Input,
  Select,
  Space,
  Modal,
  Form,
  Row,
  Col,
  DatePicker,
  InputNumber,
  message,
  Popconfirm,
  Typography,
  Tag,
  Dropdown,
  Divider,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, SwapOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Lead, LeadSource, LeadStatus } from "../types";

const PAGE_SIZE = 10;

const SOURCE_OPTIONS: { value: LeadSource; label: string }[] = [
  { value: "website", label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "cold_call", label: "Cold Call" },
  { value: "walk_in", label: "Walk-in" },
  { value: "advertisement", label: "Advertisement" },
  { value: "social_media", label: "Social Media" },
  { value: "trade_show", label: "Trade Show" },
  { value: "existing_customer", label: "Existing Customer" },
  { value: "other", label: "Other" },
];
const SOURCE_LABELS: Record<LeadSource, string> = Object.fromEntries(
  SOURCE_OPTIONS.map((o) => [o.value, o.label])
) as Record<LeadSource, string>;

const STATUS_OPTIONS: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "proposal", label: "Proposal Sent" },
  { value: "negotiation", label: "Negotiation" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];
const STATUS_LABELS: Record<LeadStatus, string> = Object.fromEntries(
  STATUS_OPTIONS.map((o) => [o.value, o.label])
) as Record<LeadStatus, string>;
const STATUS_COLORS: Record<LeadStatus, string> = {
  new: "default",
  contacted: "blue",
  qualified: "cyan",
  proposal: "gold",
  negotiation: "orange",
  won: "success",
  lost: "error",
};

export function LeadsPage() {
  const { can } = useAuth();
  const canCreate = can("sales.leads", "create");
  const canEdit = can("sales.leads", "edit");
  const canDelete = can("sales.leads", "delete");
  const canConvert = canEdit && can("contacts.customers", "create");

  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | undefined>();
  const [loading, setLoading] = useState(false);

  const [assignableUsers, setAssignableUsers] = useState<{ id: number; name: string }[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const [lostModalLead, setLostModalLead] = useState<Lead | null>(null);
  const [lostReason, setLostReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: String(PAGE_SIZE),
        search,
      });
      if (statusFilter) params.set("status", statusFilter);
      const res = await api.get<{ data: Lead[]; meta: { total: number } }>(`/leads?${params.toString()}`);
      setLeads(res.data);
      setTotal(res.meta.total);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to load leads");
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ data: { id: number; name: string }[] }>("/leads/assignable-users")
      .then((res) => setAssignableUsers(res.data))
      .catch(() => {});
  }, []);

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ source: "other", estimated_value: 0 });
    setModalOpen(true);
  }

  function openEdit(record: Lead) {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      contact_person: record.contact_person,
      designation: record.designation,
      phone: record.phone,
      email: record.email,
      source: record.source,
      industry: record.industry,
      estimated_value: Number(record.estimated_value) || 0,
      expected_close_date: record.expected_close_date ? dayjs(record.expected_close_date) : undefined,
      gstin: record.gstin,
      state: record.state,
      address: record.address,
      assigned_to: record.assigned_to ?? undefined,
      next_follow_up_date: record.next_follow_up_date ? dayjs(record.next_follow_up_date) : undefined,
      notes: record.notes,
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        ...values,
        expected_close_date: values.expected_close_date ? values.expected_close_date.format("YYYY-MM-DD") : null,
        next_follow_up_date: values.next_follow_up_date ? values.next_follow_up_date.format("YYYY-MM-DD") : null,
      };
      if (editing) {
        await api.put(`/leads/${editing.id}`, payload);
        message.success("Lead updated");
      } else {
        await api.post("/leads", payload);
        message.success("Lead created");
      }
      setModalOpen(false);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save lead");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(record: Lead, status: LeadStatus) {
    if (status === "lost") {
      setLostReason("");
      setLostModalLead(record);
      return;
    }
    try {
      await api.patch(`/leads/${record.id}/status`, { status });
      message.success("Status updated");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function confirmLost() {
    if (!lostModalLead) return;
    try {
      await api.patch(`/leads/${lostModalLead.id}/status`, { status: "lost", lost_reason: lostReason || undefined });
      message.success("Lead marked lost");
      setLostModalLead(null);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  async function handleConvert(record: Lead) {
    try {
      const res = await api.post<{ customer: { id: number; name: string } }>(`/leads/${record.id}/convert`, {});
      message.success(`Converted to Customer "${res.customer.name}"`);
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to convert lead");
    }
  }

  async function handleDelete(record: Lead) {
    try {
      await api.delete(`/leads/${record.id}`);
      message.success("Lead deleted");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to delete lead");
    }
  }

  const columns: ColumnsType<Lead> = [
    {
      title: "Lead",
      key: "name",
      render: (_, record) => (
        <div>
          <div>{record.name}</div>
          {record.contact_person && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.contact_person}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: "Contact",
      key: "contact",
      render: (_, record) => (
        <div>
          {record.phone && <div>{record.phone}</div>}
          {record.email && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.email}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: "Source",
      dataIndex: "source",
      key: "source",
      render: (v: LeadSource) => SOURCE_LABELS[v] ?? v,
    },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (status: LeadStatus, record) =>
        canEdit && !record.converted_customer_id ? (
          <Dropdown
            menu={{
              items: STATUS_OPTIONS.map((o) => ({
                key: o.value,
                label: o.label,
                onClick: () => handleStatusChange(record, o.value),
              })),
            }}
          >
            <Tag color={STATUS_COLORS[status]} style={{ cursor: "pointer" }}>
              {STATUS_LABELS[status]}
            </Tag>
          </Dropdown>
        ) : (
          <Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>
        ),
    },
    {
      title: "Assigned To",
      dataIndex: "assigned_to_name",
      key: "assigned_to_name",
      render: (v: string | undefined) => v || "-",
    },
    {
      title: "Est. Value",
      dataIndex: "estimated_value",
      key: "estimated_value",
      render: (v: string) => (Number(v) ? `Rs. ${Number(v).toFixed(2)}` : "-"),
    },
    {
      title: "Expected Close",
      dataIndex: "expected_close_date",
      key: "expected_close_date",
      render: (v: string | null) => (v ? dayjs(v).format("DD MMM YYYY") : "-"),
    },
    {
      title: "Actions",
      key: "actions",
      width: 150,
      render: (_, record) => (
        <Space size="small">
          {canEdit ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          ) : (
            <Button size="small" icon={<EditOutlined />} disabled title="View only" />
          )}
          {canConvert && !record.converted_customer_id && (
            <Popconfirm title="Convert this lead into a Customer?" onConfirm={() => handleConvert(record)}>
              <Button size="small" icon={<SwapOutlined />} title="Convert to Customer" />
            </Popconfirm>
          )}
          {record.converted_customer_id && <Tag color="success">Converted</Tag>}
          {canDelete && (
            <Popconfirm title="Delete this lead?" onConfirm={() => handleDelete(record)}>
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
          Leads
        </Typography.Title>
        <Space wrap>
          <Input.Search
            placeholder="Search name, contact, phone, email"
            allowClear
            onSearch={(value) => {
              setPage(1);
              setSearch(value);
            }}
            style={{ width: 220 }}
          />
          <Select
            allowClear
            placeholder="All stages"
            style={{ width: 160 }}
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(value) => {
              setPage(1);
              setStatusFilter(value);
            }}
          />
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Add Lead
            </Button>
          )}
        </Space>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={leads}
        loading={loading}
        size="small"
        scroll={{ x: 900 }}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
      />

      <Modal
        title={editing ? "Edit Lead" : "Add Lead"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={saving}
        width={680}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="middle">
          <Form.Item name="name" label="Lead / Company Name" rules={[{ required: true, message: "Name is required" }]}>
            <Input placeholder="e.g. Acme Furniture Co." />
          </Form.Item>

          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="contact_person" label="Contact Person">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="designation" label="Designation / Job Title">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="phone" label="Phone">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="email" label="Email" rules={[{ type: "email", message: "Enter a valid email" }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>

          <Divider style={{ margin: "4px 0 16px" }} />

          <Row gutter={12}>
            <Col xs={24} sm={8}>
              <Form.Item name="source" label="Lead Source" rules={[{ required: true }]}>
                <Select options={SOURCE_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="industry" label="Industry">
                <Input placeholder="e.g. Aerospace, Education" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="assigned_to" label="Assigned To">
                <Select
                  allowClear
                  showSearch
                  placeholder="Unassigned"
                  options={assignableUsers.map((u) => ({ value: u.id, label: u.name }))}
                  filterOption={(input, option) => (option?.label as string).toLowerCase().includes(input.toLowerCase())}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="estimated_value" label="Estimated Deal Value">
                <InputNumber style={{ width: "100%" }} min={0} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="expected_close_date" label="Expected Close Date">
                <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="next_follow_up_date" label="Next Follow-up Date">
                <DatePicker format="DD MMM YYYY" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider style={{ margin: "4px 0 16px" }} />

          <Row gutter={12}>
            <Col xs={24} sm={8}>
              <Form.Item name="gstin" label="GSTIN">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={16}>
              <Form.Item name="state" label="State" extra="Used to work out CGST+SGST vs IGST if this lead becomes a Customer.">
                <Input placeholder="e.g. Tamil Nadu" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="notes" label="Notes / Requirements">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Mark Lead as Lost"
        open={!!lostModalLead}
        onCancel={() => setLostModalLead(null)}
        onOk={confirmLost}
        okText="Mark Lost"
        okButtonProps={{ danger: true }}
      >
        <Typography.Paragraph type="secondary">
          Optionally record why this lead was lost (helps spot patterns later).
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={lostReason}
          onChange={(e) => setLostReason(e.target.value)}
          placeholder="e.g. Went with a competitor on price"
        />
      </Modal>
    </div>
  );
}
