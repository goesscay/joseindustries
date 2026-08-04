import { theme, ThemeConfig } from "antd";

export const appTheme: ThemeConfig = {
  algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm],
  token: {
    colorPrimary: "#16A34A",
    colorLink: "#16A34A",
    borderRadius: 6,
    fontSize: 13,
  },
  components: {
    Layout: {
      headerBg: "#ffffff",
      siderBg: "#ffffff",
      bodyBg: "#f5f7f6",
    },
    Menu: {
      itemBg: "#ffffff",
      itemSelectedBg: "#e8f6ee",
      itemSelectedColor: "#16A34A",
    },
  },
};
