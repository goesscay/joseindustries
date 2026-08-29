import { useEffect, useMemo, useState } from "react";
import { Table, Select, Input, Space, Typography, Tag, Radio } from "antd";
import type { ColumnsType } from "antd/es/table";
import { SearchOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { ChartOfAccount, Company, LedgerAccountType } from "../types";

const TYPE_LABELS: Record<LedgerAccountType, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

const TYPE_COLORS: Record<LedgerAccountType, string> = {
  asset: "blue",
  liability: "volcano",
  equity: "purple",
  revenue: "green",
  expense: "orange",
};

interface AccountRow extends ChartOfAccount {
  children?: AccountRow[];
}

/** Flat rows (as the API returns them) -> a tree via parent_id, for the
 * Table's built-in nested-row rendering. A row whose parent isn't in this
 * company's list (shouldn't happen, but data can outlive assumptions)
 * falls back to being shown at the top level rather than silently dropped. */
function buildTree(rows: ChartOfAccount[]): AccountRow[] {
  const byId = new Map<number, AccountRow>(rows.map((r) => [r.id, { ...r, children: undefined }]));
  const roots: AccountRow[] = [];
  for (const row of byId.values()) {
    const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(row);
    } else {
      roots.push(row);
    }
  }
  const byCode = (a: AccountRow, b: AccountRow) => a.account_code.localeCompare(b.account_code, undefined, { numeric: true });
  const sortTree = (list: AccountRow[]) => {
    list.sort(byCode);
    for (const item of list) if (item.children) sortTree(item.children);
  };
  sortTree(roots);
  return roots;
}

/** True if this row or any descendant matches the search/type/status
 * filters - used to keep a parent visible (so the tree stays navigable)
 * whenever a matching child exists underneath it, even if the parent
 * itself doesn't match. */
function filterTree(rows: AccountRow[], predicate: (r: AccountRow) => boolean): AccountRow[] {
  const result: AccountRow[] = [];
  for (const row of rows) {
    const children = row.children ? filterTree(row.children, predicate) : undefined;
    if (predicate(row) || (children && children.length)) {
      result.push({ ...row, children: children && children.length ? children : undefined });
    }
  }
  return result;
}

export function ChartOfAccountsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<LedgerAccountType | undefined>();
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("active");

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.data);
        if (res.data.length) setCompanyId((prev) => prev ?? res.data[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    api
      .get<{ data: ChartOfAccount[] }>(`/chart-of-accounts?company_id=${companyId}`)
      .then((res) => setAccounts(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [companyId]);

  const tree = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = (r: AccountRow) => {
      if (statusFilter === "active" && !r.is_active) return false;
      if (statusFilter === "inactive" && r.is_active) return false;
      if (typeFilter && r.account_type !== typeFilter) return false;
      if (term && !r.name.toLowerCase().includes(term) && !r.account_code.includes(term)) return false;
      return true;
    };
    return filterTree(buildTree(accounts), matches);
  }, [accounts, search, typeFilter, statusFilter]);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const columns: ColumnsType<AccountRow> = [
    { title: "Code", dataIndex: "account_code", key: "account_code", width: 90 },
    { title: "Account Name", dataIndex: "name", key: "name" },
    {
      title: "Parent",
      key: "parent",
      render: (_, r) => (r.parent_id ? byId.get(r.parent_id)?.name ?? "-" : "-"),
    },
    {
      title: "Type",
      dataIndex: "account_type",
      key: "account_type",
      render: (t: LedgerAccountType) => <Tag color={TYPE_COLORS[t]}>{TYPE_LABELS[t]}</Tag>,
      filters: (Object.keys(TYPE_LABELS) as LedgerAccountType[]).map((t) => ({ text: TYPE_LABELS[t], value: t })),
      onFilter: (value, r) => r.account_type === value,
    },
    { title: "Category", dataIndex: "category", key: "category", render: (v: string | null) => v ?? "-" },
    {
      title: "Normal Balance",
      dataIndex: "normal_balance",
      key: "normal_balance",
      render: (v: string) => (v === "debit" ? "Debit" : "Credit"),
    },
    {
      title: "Status",
      key: "status",
      render: (_, r) => (r.is_active ? <Tag color="green">Active</Tag> : <Tag>Inactive</Tag>),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Chart of Accounts
      </Typography.Title>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Company"
          style={{ width: 200 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
        <Input
          placeholder="Search code or name"
          prefix={<SearchOutlined />}
          style={{ width: 220 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
        <Select
          placeholder="All Types"
          allowClear
          style={{ width: 160 }}
          value={typeFilter}
          options={(Object.keys(TYPE_LABELS) as LedgerAccountType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
          onChange={setTypeFilter}
        />
        <Radio.Group value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <Radio.Button value="active">Active</Radio.Button>
          <Radio.Button value="inactive">Inactive</Radio.Button>
          <Radio.Button value="all">All</Radio.Button>
        </Radio.Group>
      </Space>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={tree}
        loading={loading}
        size="small"
        pagination={false}
        scroll={{ x: 800 }}
        defaultExpandAllRows
      />
    </div>
  );
}
