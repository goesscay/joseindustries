import { useEffect, useState } from "react";
import { Select, Input, Button, message, Typography, Space, Alert } from "antd";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Company } from "../types";

const DEFAULT_TERMS = [
  "Goods once sold will not be taken back unless otherwise agreed in writing.",
  "Payment shall be made according to the agreed payment terms.",
  "Any shortage or damage should be reported immediately upon receipt of goods.",
  "Warranty, where applicable, is governed by the agreed quotation / order terms.",
  "Transportation and installation charges are applicable as agreed.",
  "All disputes are subject to Chennai jurisdiction.",
  "This document is subject to applicable GST laws and regulations.",
].join("\n");

export function TermsConditionsPage() {
  const { user } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | undefined>();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const canEdit = user?.role === "super_admin" || user?.role === "admin";

  useEffect(() => {
    api
      .get<{ data: Company[] }>("/companies")
      .then((res) => {
        setCompanies(res.data);
        if (res.data.length) setCompanyId(res.data[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    api
      .get<{ company: Company }>(`/companies/${companyId}`)
      .then((res) => setText(res.company.terms_and_conditions || ""))
      .catch((err) => message.error(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [companyId]);

  async function handleSave() {
    if (!companyId) return;
    setSaving(true);
    try {
      const { company } = await api.get<{ company: Company }>(`/companies/${companyId}`);
      await api.put(`/companies/${companyId}`, { ...company, terms_and_conditions: text || null });
      message.success("Terms & Conditions updated");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Typography.Title level={4}>Terms &amp; Conditions</Typography.Title>
      <Typography.Text type="secondary">
        Printed on generated Quotation / Proforma Invoice / Delivery Challan / Tax Invoice PDFs, one line per bullet
        point. Leave blank to use the built-in default wording shown below.
      </Typography.Text>

      <Space style={{ display: "block", marginTop: 16, marginBottom: 16 }}>
        <Select
          style={{ width: 240 }}
          value={companyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCompanyId}
        />
      </Space>

      {!text && (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="No custom wording set - PDFs for this company currently use the built-in default shown below."
        />
      )}

      <Input.TextArea
        rows={10}
        value={text}
        placeholder={DEFAULT_TERMS}
        onChange={(e) => setText(e.target.value)}
        disabled={loading || !canEdit}
      />

      {canEdit && (
        <Button type="primary" onClick={handleSave} loading={saving} style={{ marginTop: 12 }}>
          Save
        </Button>
      )}
    </div>
  );
}
