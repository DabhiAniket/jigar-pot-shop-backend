export const ORDER_STATUSES = [
  'pending',
  'awaiting_confirmation',
  'confirmed',
  'processing',
  'ready_for_dispatch',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  awaiting_confirmation: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  processing: 'Processing',
  ready_for_dispatch: 'Ready for dispatch / pickup',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/**
 * Allowed transitions. Every order starts as `pending`; nothing moves automatically —
 * in particular, a customer opening WhatsApp never confirms an order.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['awaiting_confirmation', 'confirmed', 'cancelled'],
  awaiting_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['ready_for_dispatch', 'cancelled'],
  ready_for_dispatch: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
  cancelled: ['refunded'],
  refunded: [],
};

export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'awaiting_confirmation',
  'confirmed',
  'processing',
  'ready_for_dispatch',
  'shipped',
];

export const IN_PROGRESS_ORDER_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'processing',
  'ready_for_dispatch',
  'shipped',
];

/** Orders that count towards sales figures. */
export const REVENUE_ORDER_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'processing',
  'ready_for_dispatch',
  'shipped',
  'delivered',
];

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[from];
}

/**
 * Stock reserved at checkout is returned to inventory when an order is cancelled.
 * Refunds after delivery do not restock automatically: returned pottery may be damaged,
 * so staff record a manual inventory adjustment instead.
 */
export function transitionRestocksInventory(to: OrderStatus): boolean {
  return to === 'cancelled';
}
