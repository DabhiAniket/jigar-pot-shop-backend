import type { FulfillmentMethod } from './constants';
import { formatINR, type Paise } from './money';

export interface WhatsAppOrderItem {
  name: string;
  variantName?: string | null;
  quantity: number;
  lineTotal: Paise;
}

export interface WhatsAppAddress {
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface WhatsAppOrderSummary {
  storeName: string;
  orderNumber: string;
  customerName: string;
  items: readonly WhatsAppOrderItem[];
  subtotal: Paise;
  discountTotal: Paise;
  deliveryCharge: Paise;
  total: Paise;
  fulfillment: FulfillmentMethod;
  address?: WhatsAppAddress | null;
  notes?: string | null;
}

const MAX_ITEMS_IN_MESSAGE = 25;

export function formatAddressLine(address: WhatsAppAddress): string {
  return [
    address.line1,
    address.line2,
    address.landmark ? `Near ${address.landmark}` : null,
    address.city,
    `${address.state} ${address.pincode}`,
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
}

/** Builds the customer's order message from a saved order (never from client-side cart state). */
export function buildOrderWhatsAppMessage(order: WhatsAppOrderSummary): string {
  const shown = order.items.slice(0, MAX_ITEMS_IN_MESSAGE);
  const itemLines = shown.map((item) => {
    const name = item.variantName ? `${item.name} (${item.variantName})` : item.name;
    return `- ${name} × ${item.quantity} — ${formatINR(item.lineTotal)}`;
  });
  const hidden = order.items.length - shown.length;
  if (hidden > 0) itemLines.push(`…and ${hidden} more item${hidden === 1 ? '' : 's'}`);

  const delivery =
    order.fulfillment === 'pickup'
      ? 'Store pickup'
      : order.deliveryCharge === 0
        ? 'Free'
        : formatINR(order.deliveryCharge);

  const lines = [
    `Hello ${order.storeName}!`,
    '',
    'I would like to confirm my order.',
    '',
    `Order ID: ${order.orderNumber}`,
    `Customer: ${order.customerName}`,
    '',
    'Items:',
    ...itemLines,
    '',
    `Subtotal: ${formatINR(order.subtotal)}`,
    `Discount: ${order.discountTotal > 0 ? `-${formatINR(order.discountTotal)}` : formatINR(0)}`,
    `Delivery: ${delivery}`,
    `Total: ${formatINR(order.total)}`,
    '',
    order.fulfillment === 'pickup' || !order.address
      ? 'Fulfilment: I will pick up the order from the store.'
      : `Delivery address: ${formatAddressLine(order.address)}`,
  ];
  if (order.notes?.trim()) lines.push('', `Notes: ${order.notes.trim()}`);
  lines.push(
    '',
    order.fulfillment === 'pickup'
      ? 'Please confirm availability and pickup details.'
      : 'Please confirm availability and delivery details.',
  );
  return lines.join('\n');
}

/**
 * Official click-to-chat link. `phoneDigits` must already be in international format
 * without "+", spaces or punctuation (see normalizeWhatsAppNumber).
 */
export function buildWhatsAppUrl(phoneDigits: string, message?: string): string {
  if (!/^[1-9]\d{7,14}$/.test(phoneDigits)) {
    throw new Error('WhatsApp number must be digits only, in international format');
  }
  const base = `https://wa.me/${phoneDigits}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/** Message an admin sends when contacting a customer about their order. */
export function buildCustomerContactMessage(input: {
  storeName: string;
  customerName: string;
  orderNumber: string;
}): string {
  return `Hello ${input.customerName}, this is ${input.storeName} regarding your order ${input.orderNumber}.`;
}
