import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Layout, Menu, Drawer, Grid, Dropdown, Avatar, Space, Typography } from "antd";
import {
  TeamOutlined,
  MenuOutlined,
  UserOutlined,
  LogoutOutlined,
  ContactsOutlined,
  TagsOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { useAuth } from "../context/AuthContext";
import logo from "../assets/logo-black.png";

const { Header, Sider, Content } = Layout;
const { useBreakpoint } = Grid;

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const [drawerOpen, setDrawerOpen] = useState(false);

  const navItems = user
    ? [
        { key: "/quotations", icon: <FileTextOutlined />, label: "Quotations" },
        { key: "/customers", icon: <ContactsOutlined />, label: "Customers" },
        { key: "/items", icon: <TagsOutlined />, label: "Items" },
        ...(user.role !== "staff" ? [{ key: "/users", icon: <TeamOutlined />, label: "Users" }] : []),
      ]
    : [];

  const selectedKey = navItems.find((item) => location.pathname.startsWith(item.key))?.key ?? "/";

  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[selectedKey]}
      items={navItems}
      onClick={({ key }) => {
        navigate(key);
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
        <Sider breakpoint="md" width={200} style={{ borderInlineEnd: "1px solid #f0f0f0" }}>
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
          width={220}
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
