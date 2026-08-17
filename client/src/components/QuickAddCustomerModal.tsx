import { useState } from "react";
import { Modal, Form, Input, message } from "antd";
import { api } from "../api/client";
import { Customer } from "../types";

interface QuickAddCustomerModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the newly-created customer right after a successful save, so the caller can select it and refresh its own customer list. */
  onCreated: (customer: Customer) => void;
}

/**
 * A lightweight "add a customer without leaving the document" modal, opened
 * from the small + button next to the Customer picker on sales documents and
 * Receipts. Only asks for what's actually useful mid-document - full contact
 * details (billing/shipping address, etc.) can still be filled in later from
 * the Customers page.
 */
export function QuickAddCustomerModal({ open, onClose, onCreated }: QuickAddCustomerModalProps) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.post<{ customer: Customer }>("/customers", values);
      message.success(`Customer "${res.customer.name}" added`);
      form.resetFields();
      onCreated(res.customer);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to add customer");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    form.resetFields();
    onClose();
  }

  return (
    <Modal
      title="Add New Customer"
      open={open}
      onCancel={handleCancel}
      onOk={handleSubmit}
      confirmLoading={saving}
      destroyOnClose
      width={480}
    >
      <Form form={form} layout="vertical" size="middle">
        <Form.Item name="name" label="Name" rules={[{ required: true, message: "Name is required" }]}>
          <Input placeholder="Customer / company name" autoFocus />
        </Form.Item>
        <Form.Item name="phone" label="Phone">
          <Input />
        </Form.Item>
        <Form.Item name="email" label="Email">
          <Input />
        </Form.Item>
        <Form.Item name="gstin" label="GSTIN">
          <Input />
        </Form.Item>
        <Form.Item name="state" label="State" extra="Used to work out CGST+SGST vs IGST on documents for this customer.">
          <Input placeholder="e.g. Tamil Nadu" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
