import { useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Layout, Menu, Drawer, Grid, Dropdown, Avatar, Space, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  HomeOutlined,
  TeamOutlined,
  MenuOutlined,
  UserOutlined,
  LogoutOutlined,
  ContactsOutlined,
  TagsOutlined,
  FileTextOutlined,
  BankOutlined,
  FileDoneOutlined,
  CarOutlined,
  AuditOutlined,
  WalletOutlined,
  ShopOutlined,
  FolderOutlined,
  AccountBookOutlined,
  MoneyCollectOutlined,
  CreditCardOutlined,
  BarChartOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  DollarOutlined,
  SettingOutlined,
  PercentageOutlined,
  NumberOutlined,
  FileProtectOutlined,
  SafetyOutlined,
  UserAddOutlined,
  ProfileOutlined,
  RollbackOutlined,
  FileAddOutlined,
  FileOutlined,
  FileSyncOutlined,
  ColumnWidthOutlined,
  TagOutlined,
  CalendarOutlined,
  LayoutOutlined,
  BellOutlined,
  HistoryOutlined,
  SwapOutlined,
  SwapLeftOutlined,
  LineChartOutlined,
  PieChartOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { useAuth } from "../context/AuthContext";
import { ROUTE_MODULE } from "../constants/routeModules";
import logo from "../assets/logo-black.png";

const { Header, Sider, Content } = Layout;
const { useBreakpoint } = Grid;

type NavItem = Required<MenuProps>["items"][number];

// Menu item keys must be unique across the whole tree, but "Bank Accounts"
// under Settings is deliberately a shortcut to the same page as "Bank &
// Cash" under Banking - give it its own key and resolve it to the real
// route on click instead of reusing "/accounts" twice.
const KEY_ALIASES: Record<string, string> = {
  "/settings/bank-accounts": "/accounts",
};

// Not implemented yet - shown in the menu per the current nav spec (so the
// full module list is visible up front) but disabled: no route, nothing to
// click through to, rather than a faked page. Grouped here by which section
// they live in purely for readability of the nav tree below.
function comingSoonLabel(text: string) {
  return (
    <span>
      {text} <span style={{ fontSize: 11, color: "#bfbfbf" }}>(Coming soon)</span>
    </span>
  );
}

export function AppLayout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const [drawerOpen, setDrawerOpen] = useState(false);

  const rawNavItems: NavItem[] = useMemo(
    () =>
      user
        ? [
            { key: "/", icon: <HomeOutlined />, label: "Dashboard" },
            {
              key: "group-sales",
              icon: <ShoppingCartOutlined />,
              label: "Sales",
              children: [
                { key: "/leads", icon: <UserAddOutlined />, label: "Leads" },
                { key: "/customers", icon: <ContactsOutlined />, label: "Customers" },
                { key: "/quotations", icon: <FileTextOutlined />, label: "Quotations" },
                { key: "/proforma-invoices", icon: <FileDoneOutlined />, label: "Proforma Invoices" },
                { key: "/sales/orders", icon: <ProfileOutlined />, label: comingSoonLabel("Sales Orders"), disabled: true },
                { key: "/delivery-challans", icon: <CarOutlined />, label: "Delivery Challans" },
                { key: "/tax-invoices", icon: <AuditOutlined />, label: "Tax Invoices" },
                { key: "/sales/credit-notes", icon: <RollbackOutlined />, label: comingSoonLabel("Credit Notes"), disabled: true },
                { key: "/receipts", icon: <WalletOutlined />, label: "Receipts" },
              ],
            },
            {
              key: "group-purchases",
              icon: <ShoppingOutlined />,
              label: "Purchases",
              children: [
                { key: "/vendors", icon: <ShopOutlined />, label: "Vendors" },
                { key: "/purchases/orders", icon: <FileAddOutlined />, label: comingSoonLabel("Purchase Orders"), disabled: true },
                { key: "/purchases/bills", icon: <FileOutlined />, label: comingSoonLabel("Purchase Bills"), disabled: true },
                { key: "/purchases/debit-notes", icon: <SwapLeftOutlined />, label: comingSoonLabel("Debit Notes"), disabled: true },
                { key: "/vendor-payments", icon: <MoneyCollectOutlined />, label: "Vendor Payments" },
              ],
            },
            {
              key: "group-expenses",
              icon: <DollarOutlined />,
              label: "Expenses",
              children: [
                { key: "/expenses", icon: <AccountBookOutlined />, label: "Expenses" },
                { key: "/expense-categories", icon: <FolderOutlined />, label: "Expense Categories" },
              ],
            },
            {
              key: "group-banking",
              icon: <CreditCardOutlined />,
              label: "Banking",
              children: [
                { key: "/accounts", icon: <CreditCardOutlined />, label: "Bank & Cash" },
                { key: "/banking/transactions", icon: <HistoryOutlined />, label: comingSoonLabel("Transactions"), disabled: true },
                { key: "/banking/transfers", icon: <SwapOutlined />, label: comingSoonLabel("Transfers"), disabled: true },
                { key: "/banking/reconciliation", icon: <FileSyncOutlined />, label: comingSoonLabel("Reconciliation"), disabled: true },
              ],
            },
            {
              key: "group-items",
              icon: <TagsOutlined />,
              label: "Items",
              children: [
                { key: "/items", icon: <TagsOutlined />, label: "Items & Services" },
                { key: "/items/categories", icon: <FolderOutlined />, label: comingSoonLabel("Categories"), disabled: true },
                { key: "/items/units", icon: <ColumnWidthOutlined />, label: comingSoonLabel("Units"), disabled: true },
                { key: "/items/price-lists", icon: <TagOutlined />, label: comingSoonLabel("Price Lists"), disabled: true },
              ],
            },
            {
              key: "group-reports",
              icon: <BarChartOutlined />,
              label: "Reports",
              children: [
                { key: "/reports/sales", icon: <LineChartOutlined />, label: comingSoonLabel("Sales Reports"), disabled: true },
                { key: "/reports/purchases", icon: <PieChartOutlined />, label: comingSoonLabel("Purchase Reports"), disabled: true },
                { key: "/reports/expenses", icon: <AccountBookOutlined />, label: comingSoonLabel("Expense Reports"), disabled: true },
                { key: "/reports/receivables", icon: <WalletOutlined />, label: comingSoonLabel("Receivables"), disabled: true },
                { key: "/reports/payables", icon: <MoneyCollectOutlined />, label: comingSoonLabel("Payables"), disabled: true },
                { key: "/reports/tax-gst", icon: <PercentageOutlined />, label: comingSoonLabel("Tax & GST"), disabled: true },
                { key: "/reports/banking", icon: <CreditCardOutlined />, label: comingSoonLabel("Banking"), disabled: true },
                { key: "/reports/inventory", icon: <DatabaseOutlined />, label: comingSoonLabel("Inventory"), disabled: true },
                { key: "/reports/financial", icon: <BarChartOutlined />, label: comingSoonLabel("Financial Reports"), disabled: true },
              ],
            },
            {
              key: "group-settings",
              icon: <SettingOutlined />,
              label: "Settings",
              children: [
                { key: "/companies", icon: <BankOutlined />, label: "Company Profile" },
                ...(user.role !== "staff"
                  ? [{ key: "/users", icon: <TeamOutlined />, label: "Users & Roles" }]
                  : []),
                { key: "/settings/bank-accounts", icon: <CreditCardOutlined />, label: "Bank Accounts" },
                { key: "/settings/tax-rates", icon: <PercentageOutlined />, label: "Tax & GST" },
                { key: "/settings/financial-year", icon: <CalendarOutlined />, label: comingSoonLabel("Financial Year"), disabled: true },
                { key: "/settings/document-numbering", icon: <NumberOutlined />, label: "Document Numbering" },
                { key: "/settings/payment-terms", icon: <FileProtectOutlined />, label: "Payment Terms" },
                { key: "/settings/invoice-templates", icon: <LayoutOutlined />, label: comingSoonLabel("Invoice Templates"), disabled: true },
                { key: "/settings/terms-conditions", icon: <SafetyOutlined />, label: "Terms & Conditions" },
                { key: "/settings/notifications", icon: <BellOutlined />, label: comingSoonLabel("Notifications"), disabled: true },
              ],
            },
          ]
        : [],
    [user]
  );

  // Drop any leaf the user can't view (per their module permissions), then
  // drop any group left with no children - keeps the sidebar honest about
  // what a restricted staff member can actually get to.
  const navItems: NavItem[] = useMemo(
    () =>
      rawNavItems
        .filter((item) => item && "key" in item && (!ROUTE_MODULE[String(item.key)] || can(ROUTE_MODULE[String(item.key)], "view")))
        .map((item) => {
          if (item && "children" in item && item.children) {
            const children = item.children.filter(
              (child) => child && "key" in child && (!ROUTE_MODULE[String(child.key)] || can(ROUTE_MODULE[String(child.key)], "view"))
            );
            return { ...item, children };
          }
          return item;
        })
        .filter((item) => !(item && "children" in item && item.children && item.children.length === 0)),
    [rawNavItems, can]
  );

  // Every leaf route key, paired with the id of the group it lives in - used
  // to highlight the active item and auto-expand its parent group.
  const leafToGroup = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of navItems) {
      if (item && "children" in item && item.children) {
        for (const child of item.children) {
          if (child && "key" in child && child.key) map.set(String(child.key), String(item.key));
        }
      }
    }
    return map;
  }, [navItems]);

  const allLeafKeys = useMemo(
    () =>
      Array.from(leafToGroup.keys())
        .concat(["/"])
        .sort((a, b) => b.length - a.length),
    [leafToGroup]
  );

  const selectedKey = allLeafKeys.find((key) => (key === "/" ? location.pathname === "/" : location.pathname.startsWith(key))) ?? "/";
  const activeGroupKey = leafToGroup.get(selectedKey);

  const [openKeys, setOpenKeys] = useState<string[]>(activeGroupKey ? [activeGroupKey] : []);

  // Re-derive on route change so navigating (e.g. via a dashboard shortcut)
  // opens the right group even if the user never clicked the menu itself.
  const [lastPath, setLastPath] = useState(location.pathname);
  if (location.pathname !== lastPath) {
    setLastPath(location.pathname);
    if (activeGroupKey && !openKeys.includes(activeGroupKey)) {
      setOpenKeys((prev) => [...prev, activeGroupKey]);
    }
  }

  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[selectedKey]}
      openKeys={openKeys}
      onOpenChange={(keys) => setOpenKeys(keys)}
      items={navItems}
      onClick={({ key }) => {
        navigate(KEY_ALIASES[key] ?? key);
        setDrawerOpen(false);
      }}
      style={{ borderInlineEnd: "none" }}
    />
  );

  const userMenuItems = [
    {
      key: "logout",
      icon: <LogoutOutlined />,
      label: "Log out",
      onClick: () => logout(),
    },
  ];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {!isMobile && (
        <Sider breakpoint="md" width={220} style={{ borderInlineEnd: "1px solid #f0f0f0", overflow: "auto" }}>
          <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img src={logo} alt="Jose Industries" style={{ height: 28 }} />
          </div>
          {menu}
        </Sider>
      )}

      {isMobile && (
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={240}
          styles={{ body: { padding: 0 } }}
          closable={false}
        >
          {menu}
        </Drawer>
      )}

      <Layout>
        <Header
          style={{
            background: "#fff",
            borderBottom: "1px solid #f0f0f0",
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Space>
            {isMobile && (
              <MenuOutlined onClick={() => setDrawerOpen(true)} style={{ fontSize: 18 }} />
            )}
            {isMobile && <img src={logo} alt="Jose Industries" style={{ height: 22 }} />}
          </Space>
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Space style={{ cursor: "pointer" }}>
              <Avatar size="small" icon={<UserOutlined />} />
              <Typography.Text>{user?.name}</Typography.Text>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ margin: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
