import {
  buildCustomerContactMessage,
  buildWhatsAppUrl,
  maskIndianMobile,
  nextOrderStatuses,
  type AdminOrderDetail,
  type AdminOrderListItem,
  type CancellationRequestDTO,
  type CustomerOrderDTO,
  type CustomerOrderListItem,
  type OrderItemDTO,
  type OrderPricingDTO,
  type PublicOrderDTO,
  type ShipmentDTO,
} from '@jmh/shared';
import type { Order, StoreSettingsDoc } from '../../db/models';
import type { Storage } from '../../storage/storage';
import { orderWhatsAppUrl } from './order.service';

function itemDTO(item: Order['items'][number], storage: Storage): OrderItemDTO {
  return {
    productId: item.product.toString(),
    variantId: item.variant?.toString() ?? null,
    slug: item.slug,
    name: item.name,
    variantName: item.variantName,
    sku: item.sku,
    image: item.imageKey ? storage.publicUrl(item.imageKey) : null,
    listPrice: item.listPrice,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    lineSubtotal: item.lineSubtotal,
    lineDiscount: item.lineDiscount,
    lineTotal: item.lineTotal,
  };
}

function pricingDTO(order: Order): OrderPricingDTO {
  const applied = order.pricing.appliedPromotion;
  return {
    subtotal: order.pricing.subtotal,
    discountTotal: order.pricing.discountTotal,
    deliveryCharge: order.pricing.deliveryCharge,
    total: order.pricing.total,
    appliedPromotion: applied
      ? {
          id: applied.id.toString(),
          name: applied.name,
          code: applied.code,
          amount: applied.amount,
        }
      : null,
  };
}

export function publicOrderDTO(
  order: Order,
  storage: Storage,
  settings: StoreSettingsDoc,
  envWhatsapp: string | null,
): PublicOrderDTO {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    channel: order.channel,
    fulfillment: order.fulfillment,
    createdAt: order.createdAt.toISOString(),
    customerName: order.customer.name,
    phoneMasked: maskIndianMobile(order.customer.phone),
    address: order.address
      ? {
          line1: order.address.line1,
          line2: order.address.line2 ?? null,
          landmark: order.address.landmark ?? null,
          city: order.address.city,
          state: order.address.state,
          pincode: order.address.pincode,
        }
      : null,
    items: order.items.map((item) => itemDTO(item, storage)),
    pricing: pricingDTO(order),
    notes: order.notes,
    history: order.statusHistory.map((event) => ({ status: event.to, at: event.at.toISOString() })),
    whatsappUrl: orderWhatsAppUrl(order, settings, envWhatsapp),
  };
}

export function adminOrderListItem(order: Order): AdminOrderListItem {
  return {
    id: order._id.toString(),
    orderNumber: order.orderNumber,
    status: order.status,
    channel: order.channel,
    fulfillment: order.fulfillment,
    customerName: order.customer.name,
    phone: order.customer.phone,
    city: order.address?.city ?? null,
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    total: order.pricing.total,
    createdAt: order.createdAt.toISOString(),
    cancellationRequest: order.cancellationRequest?.status ?? null,
    allowedTransitions: [...nextOrderStatuses(order.status)],
    hasShipment: Boolean(order.shipment),
  };
}

function shipmentDTO(order: Order): ShipmentDTO | null {
  const shipment = order.shipment;
  if (!shipment) return null;
  return {
    provider: shipment.provider,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
    shippedAt: shipment.shippedAt.toISOString(),
    estimatedDelivery: shipment.estimatedDelivery,
    notes: shipment.notes,
  };
}

function cancellationRequestDTO(order: Order): CancellationRequestDTO | null {
  const request = order.cancellationRequest;
  if (!request) return null;
  return {
    status: request.status,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    resolutionNote: request.resolutionNote,
  };
}

/** Customers may ask to cancel until the order is on its way (staff handle anything later). */
const CUSTOMER_CANCELLABLE = ['pending', 'awaiting_confirmation', 'confirmed', 'processing'];
export function canRequestCancellation(order: Order): boolean {
  return CUSTOMER_CANCELLABLE.includes(order.status) && !order.cancellationRequest;
}

export function customerOrderListItem(order: Order, storage: Storage): CustomerOrderListItem {
  const first = order.items[0];
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    total: order.pricing.total,
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    firstItem: first
      ? { name: first.name, image: first.imageKey ? storage.publicUrl(first.imageKey) : null }
      : null,
    cancellationRequest: order.cancellationRequest?.status ?? null,
  };
}

/**
 * What a customer sees of their OWN order. Deliberately omits internal notes, staff ids and
 * names, inventory state and the idempotency data.
 */
export function customerOrderDTO(
  order: Order,
  storage: Storage,
  settings: StoreSettingsDoc,
  envWhatsapp: string | null,
): CustomerOrderDTO {
  return {
    ...publicOrderDTO(order, storage, settings, envWhatsapp),
    timeline: order.statusHistory.map((event) => ({
      status: event.to,
      at: event.at.toISOString(),
      note: event.to === 'cancelled' || event.to === 'shipped' ? event.note : null,
    })),
    shipment: shipmentDTO(order),
    cancellationRequest: cancellationRequestDTO(order),
    cancelledBy: order.cancelledBy?.kind ?? null,
    cancellationReason: order.cancellationReason,
    canRequestCancellation: canRequestCancellation(order),
    payment: {
      method: 'offline',
      status: order.status === 'refunded' ? 'refunded' : 'not_processed_online',
      note: 'No online payment is taken. Payment is arranged directly with the store.',
    },
  };
}

export function adminOrderDetail(
  order: Order,
  storage: Storage,
  settings: StoreSettingsDoc,
): AdminOrderDetail {
  const contactNumber = order.customer.whatsapp ?? order.customer.phone;
  return {
    id: order._id.toString(),
    orderNumber: order.orderNumber,
    status: order.status,
    allowedTransitions: [...nextOrderStatuses(order.status)],
    channel: order.channel,
    fulfillment: order.fulfillment,
    customer: { ...order.customer },
    address: order.address
      ? {
          line1: order.address.line1,
          line2: order.address.line2 ?? null,
          landmark: order.address.landmark ?? null,
          city: order.address.city,
          state: order.address.state,
          pincode: order.address.pincode,
        }
      : null,
    notes: order.notes,
    items: order.items.map((item) => itemDTO(item, storage)),
    pricing: pricingDTO(order),
    statusHistory: order.statusHistory.map((event) => ({
      from: event.from,
      to: event.to,
      at: event.at.toISOString(),
      note: event.note,
      byName: event.byName,
    })),
    internalNotes: order.internalNotes.map((note) => ({
      text: note.text,
      at: note.at.toISOString(),
      byName: note.byName,
    })),
    cancellationReason: order.cancellationReason,
    cancelledBy: order.cancelledBy
      ? {
          kind: order.cancelledBy.kind,
          byName: order.cancelledBy.byName,
          at: order.cancelledBy.at.toISOString(),
        }
      : null,
    cancellationRequest: order.cancellationRequest
      ? {
          ...cancellationRequestDTO(order)!,
          resolvedByName: order.cancellationRequest.resolvedByName,
        }
      : null,
    shipment: shipmentDTO(order),
    hasAccount: Boolean(order.accountId),
    inventory: {
      committed: order.inventory.committed,
      restockedAt: order.inventory.restockedAt?.toISOString() ?? null,
    },
    whatsappContactUrl: buildWhatsAppUrl(
      `91${contactNumber}`,
      buildCustomerContactMessage({
        storeName: settings.storeName,
        customerName: order.customer.name,
        orderNumber: order.orderNumber,
      }),
    ),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
