import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Typography, Row, Col, Statistic, Select, Space, Table, Tag, List, Button, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  WalletOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  PlusOutlined,
  AuditOutlined,
  AccountBookOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABELS } from "../utils/roles";
import { Company, DocStatus } from "../types";

const STATUS_COLORS: Record<DocStatus, string> = {
  draft: "default",
  sent: "blue",
  accepted: "success",
  rejected: "error",
  cancelled: "default",
};

const DOC_TYPE_ROUTES: Record<string, string> = {
  quotation: "/quotations",
  proforma_invoice: "/proforma-invoices",
  delivery_challan: "/delivery-challans",
  tax_invoice: "/tax-invoices",
};

interface RecentDocument {
  id: number;
  doc_type: string;
  doc_type_label: string;
  doc_number: string;
  party_name: string;
  issue_date: string;
  grand_total: number;
  status: DocStatus;
}

interface RecentActivity {
  entry_date: string;
  direction: "in" | "out";
  amount: number;
  particulars: string;
}

interface DashboardSummary {
  cashBankBalance: number;
  totalReceivable: number;
  totalPayable: number;
  monthRevenue: number;
  monthExpenses: number;
  netProfitThisMonth: number;
  recentDocuments: RecentDocument[];
  recentActivity: RecentActivity[];
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  useEffect(() => {
    api.get<{ data: Company[] }>("/companies").then((res) => setCompanies(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (companyId) params.set("company_id", String(companyId));
    api
      .get<DashboardSummary>(`/dashboard/summary?${params.toString()}`)
      .then(setSummary)
      .catch((err) => message.error(err instanceof Error ? err.message : "Failed to load dashboard"))
      .finally(() => setLoading(false));
  }, [companyId]);

  const documentColumns: ColumnsType<RecentDocument> = [
    { title: "No.", dataIndex: "doc_number", key: "doc_number" },
    { title: "Type", dataIndex: "doc_type_label", key: "doc_type_label" },
    { title: "Party", dataIndex: "party_name", key: "party_name" },
    { title: "Date", dataIndex: "issue_date", key: "issue_date", render: (d: string) => dayjs(d).format("DD MMM YYYY") },
    { title: "Amount", dataIndex: "grand_total", key: "grand_total", align: "right", render: (v: number) => `Rs. ${formatMoney(v)}` },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (v: DocStatus) => <Tag color={STATUS_COLORS[v]}>{v}</Tag>,
    },
  ];

  return (
    <div>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Welcome, {user?.name}
          </Typography.Title>
          <Typography.Text type="secondary">Signed in as {user ? ROLE_LABELS[user.role] : ""}.</Typography.Text>
        </div>
        <Select
          placeholder="All Companies"
          allowClear
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
      </Space>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="Cash & Bank Balance"
              value={summary?.cashBankBalance ?? 0}
              precision={2}
              prefix="Rs."
              valueStyle={{ color: (summary?.cashBankBalance ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic title="Outstanding Receivable" value={summary?.totalReceivable ?? 0} precision={2} prefix="Rs." valueStyle={{ color: "#1677ff" }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic title="Outstanding Payable" value={summary?.totalPayable ?? 0} precision={2} prefix="Rs." valueStyle={{ color: "#cf1322" }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small" loading={loading}>
            <Statistic
              title="Net Profit This Month"
              value={summary?.netProfitThisMonth ?? 0}
              precision={2}
              prefix="Rs."
              valueStyle={{ color: (summary?.netProfitThisMonth ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}
            />
          </Card>
        </Col>
      </Row>

      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<PlusOutlined />} onClick={() => navigate("/quotations")}>
          New Quotation
        </Button>
        <Button icon={<AuditOutlined />} onClick={() => navigate("/tax-invoices")}>
          New Tax Invoice
        </Button>
        <Button icon={<AccountBookOutlined />} onClick={() => navigate("/expenses")}>
          New Expense
        </Button>
        <Button icon={<WalletOutlined />} onClick={() => navigate("/receipts")}>
          New Receipt
        </Button>
      </Space>

      <Row gutter={16}>
        <Col xs={24} lg={16}>
          <Card title="Recent Documents" size="small">
            <Table
              rowKey="id"
              columns={documentColumns}
              dataSource={summary?.recentDocuments ?? []}
              loading={loading}
              size="small"
              pagination={false}
              scroll={{ x: 500 }}
              onRow={(record) => ({
                style: { cursor: "pointer" },
                onClick: () => DOC_TYPE_ROUTES[record.doc_type] && navigate(DOC_TYPE_ROUTES[record.doc_type]),
              })}
            />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="Recent Activity" size="small">
            <List
              loading={loading}
              dataSource={summary?.recentActivity ?? []}
              locale={{ emptyText: "No recent activity" }}
              renderItem={(item) => (
                <List.Item>
                  <Space style={{ width: "100%", justifyContent: "space-between" }}>
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{item.particulars}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(item.entry_date).format("DD MMM YYYY")}
                      </Typography.Text>
                    </Space>
                    <Typography.Text style={{ color: item.direction === "in" ? "#3f8600" : "#cf1322" }}>
                      {item.direction === "in" ? <ArrowUpOutlined /> : <ArrowDownOutlined />} Rs. {formatMoney(item.amount)}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
