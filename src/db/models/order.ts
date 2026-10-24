import { model, Schema, type HydratedDocument, type Types } from 'mongoose';
import {
  CHECKOUT_CHANNELS,
  FULFILLMENT_METHODS,
  INVENTORY_REASONS,
  ORDER_STATUSES,
  type CheckoutChannel,
  type FulfillmentMethod,
  type InventoryReason,
  type OrderStatus,
} from '@jmh/shared';
import { addressSchema, integerValidator, type AddressSnapshot } from './shared-schemas';

/** Snapshot of what was bought, so history survives product renames and price changes. */
export interface OrderItem {
  product: Types.ObjectId;
  variant: Types.ObjectId | null;
  slug: string;
  name: string;
  variantName: string | null;
  sku: string | null;
  imageKey: string | null;
  categoryId: Types.ObjectId | null;
  listPrice: number;
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  lineDiscount: number;
  lineTotal: number;
  inventoryTracked: boolean;
}

export interface OrderStatusEvent {
  from: OrderStatus | null;
  to: OrderStatus;
  at: Date;
  note: string | null;
  by: Types.ObjectId | null;
  byName: string | null;
}

export interface Order {
  _id: Types.ObjectId;
  orderNumber: string;
  status: OrderStatus;
  channel: CheckoutChannel;
  fulfillment: FulfillmentMethod;
  customer: { name: string; phone: string; whatsapp: string | null };
  customerId: Types.ObjectId | null;
  address: AddressSnapshot | null;
  notes: string | null;
  items: OrderItem[];
  pricing: {
    subtotal: number;
    discountTotal: number;
    deliveryCharge: number;
    total: number;
    currency: 'INR';
    appliedPromotion: {
      id: Types.ObjectId;
      name: string;
      code: string | null;
      amount: number;
    } | null;
  };
  promoCode: string | null;
  statusHistory: OrderStatusEvent[];
  internalNotes: { text: string; at: Date; by: Types.ObjectId; byName: string }[];
  cancellationReason: string | null;
  inventory: { committed: boolean; restockedAt: Date | null };
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<OrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variant: { type: Schema.Types.ObjectId, default: null },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    variantName: { type: String, default: null },
    sku: { type: String, default: null },
    imageKey: { type: String, default: null },
    categoryId: { type: Schema.Types.ObjectId, default: null },
    listPrice: { type: Number, required: true, validate: integerValidator },
    unitPrice: { type: Number, required: true, validate: integerValidator },
    quantity: { type: Number, required: true, min: 1, validate: integerValidator },
    lineSubtotal: { type: Number, required: true, validate: integerValidator },
    lineDiscount: { type: Number, required: true, validate: integerValidator },
    lineTotal: { type: Number, required: true, validate: integerValidator },
    inventoryTracked: { type: Boolean, required: true },
  },
  { _id: false },
);

const orderSchema = new Schema<Order>(
  {
    orderNumber: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending' },
    channel: { type: String, enum: CHECKOUT_CHANNELS, required: true },
    fulfillment: { type: String, enum: FULFILLMENT_METHODS, required: true },
    customer: {
      type: new Schema(
        {
          name: { type: String, required: true, maxlength: 80 },
          phone: { type: String, required: true, match: /^[6-9]\d{9}$/ },
          whatsapp: { type: String, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    address: { type: addressSchema, default: null },
    notes: { type: String, default: null, maxlength: 500 },
    items: { type: [orderItemSchema], required: true },
    pricing: {
      type: new Schema(
        {
          subtotal: { type: Number, required: true },
          discountTotal: { type: Number, required: true },
          deliveryCharge: { type: Number, required: true },
          total: { type: Number, required: true },
          currency: { type: String, default: 'INR' },
          appliedPromotion: {
            type: new Schema(
              {
                id: Schema.Types.ObjectId,
                name: String,
                code: { type: String, default: null },
                amount: Number,
              },
              { _id: false },
            ),
            default: null,
          },
        },
        { _id: false },
      ),
      required: true,
    },
    promoCode: { type: String, default: null },
    statusHistory: {
      type: [
        new Schema(
          {
            from: { type: String, default: null },
            to: { type: String, required: true },
            at: { type: Date, required: true },
            note: { type: String, default: null },
            by: { type: Schema.Types.ObjectId, default: null },
            byName: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    internalNotes: {
      type: [
        new Schema(
          { text: String, at: Date, by: Schema.Types.ObjectId, byName: String },
          { _id: false },
        ),
      ],
      default: [],
    },
    cancellationReason: { type: String, default: null },
    inventory: {
      type: new Schema(
        {
          committed: { type: Boolean, default: false },
          restockedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    idempotencyKey: { type: String, default: null },
    requestHash: { type: String, default: null },
  },
  { timestamps: true },
);
orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ 'customer.phone': 1, createdAt: -1 });
orderSchema.index({ customerId: 1, createdAt: -1 });

export const OrderModel = model<Order>('Order', orderSchema);
export type OrderDocument = HydratedDocument<Order>;

export interface Customer {
  _id: Types.ObjectId;
  phone: string;
  name: string;
  whatsapp: string | null;
  lastAddress: AddressSnapshot | null;
  city: string | null;
  orderCount: number;
  firstOrderAt: Date;
  lastOrderAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<Customer>(
  {
    phone: { type: String, required: true, match: /^[6-9]\d{9}$/ },
    name: { type: String, required: true, maxlength: 80 },
    whatsapp: { type: String, default: null },
    lastAddress: { type: addressSchema, default: null },
    city: { type: String, default: null },
    orderCount: { type: Number, default: 0 },
    firstOrderAt: { type: Date, required: true },
    lastOrderAt: { type: Date, required: true },
  },
  { timestamps: true },
);
customerSchema.index({ phone: 1 }, { unique: true });
customerSchema.index({ lastOrderAt: -1 });

export const CustomerModel = model<Customer>('Customer', customerSchema);

export interface InventoryMovement {
  _id: Types.ObjectId;
  product: Types.ObjectId;
  variant: Types.ObjectId | null;
  productName: string;
  variantName: string | null;
  delta: number;
  stockAfter: number | null;
  reason: InventoryReason;
  order: Types.ObjectId | null;
  orderNumber: string | null;
  note: string | null;
  actor: Types.ObjectId | null;
  actorName: string | null;
  createdAt: Date;
}

const inventoryMovementSchema = new Schema<InventoryMovement>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variant: { type: Schema.Types.ObjectId, default: null },
    productName: { type: String, required: true },
    variantName: { type: String, default: null },
    delta: { type: Number, required: true, validate: integerValidator },
    stockAfter: { type: Number, default: null },
    reason: { type: String, enum: INVENTORY_REASONS, required: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    orderNumber: { type: String, default: null },
    note: { type: String, default: null, maxlength: 300 },
    actor: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    actorName: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
inventoryMovementSchema.index({ product: 1, createdAt: -1 });
inventoryMovementSchema.index({ createdAt: -1 });
// One movement per (order, reason, line): a retried or duplicated cancellation can never
// restock twice, and an order can never deduct the same line twice.
inventoryMovementSchema.index(
  { order: 1, reason: 1, product: 1, variant: 1 },
  { unique: true, partialFilterExpression: { order: { $type: 'objectId' } } },
);

export const InventoryMovementModel = model<InventoryMovement>(
  'InventoryMovement',
  inventoryMovementSchema,
);
