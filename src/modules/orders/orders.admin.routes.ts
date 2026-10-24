import { Router } from 'express';
import { Types, type QueryFilter } from 'mongoose';
import {
  adminCustomerListQuerySchema,
  adminOrderListQuerySchema,
  normalizeIndianMobile,
  objectIdSchema,
  orderNoteSchema,
  orderStatusUpdateSchema,
  ORDER_STATUS_LABELS,
  REVENUE_ORDER_STATUSES,
  type AdminCustomerDetail,
  type AdminCustomerListItem,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { CustomerModel, OrderModel, type Customer, type Order } from '../../db/models';
import { notFound } from '../../lib/errors';
import { escapeRegex, parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { audit } from '../audit/audit.service';
import { getStoreSettings } from '../settings/settings.service';
import { adminOrderDetail, adminOrderListItem } from './order.serialize';
import { addInternalNote, updateOrderStatus } from './order.service';

/** Interprets YYYY-MM-DD as a calendar day in India. */
function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

export function ordersAdminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/orders', requirePermission('orders:read'), async (req, res) => {
    const query = parseInput(adminOrderListQuerySchema, req.query);
    const filter: QueryFilter<Order> = {};
    if (query.status) filter.status = query.status;
    if (query.channel) filter.channel = query.channel;
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: istDayStart(query.from) } : {}),
        ...(query.to ? { $lt: new Date(istDayStart(query.to).getTime() + 86_400_000) } : {}),
      };
    }
    if (query.q) {
      const phone = normalizeIndianMobile(query.q);
      const term = query.q.trim();
      if (phone) filter['customer.phone'] = phone;
      else if (/^[a-z]{2,6}-\d{6}-[0-9a-z]{5}$/i.test(term))
        filter.orderNumber = term.toUpperCase();
      else {
        const pattern = new RegExp(escapeRegex(term), 'i');
        filter.$or = [
          { orderNumber: pattern },
          { 'customer.name': pattern },
          { 'customer.phone': pattern },
        ];
      }
    }
    const [orders, total] = await Promise.all([
      OrderModel.find(filter)
        .select(
          'orderNumber status channel fulfillment customer address.city items.quantity pricing.total createdAt',
        )
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<Order[]>(),
      OrderModel.countDocuments(filter),
    ]);
    res.set('Cache-Control', 'no-store').json({
      data: orders.map(adminOrderListItem),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/orders/:id', requirePermission('orders:read'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const order = await OrderModel.findById(id).lean<Order>();
    if (!order) throw notFound('Order');
    const settings = await getStoreSettings();
    res
      .set('Cache-Control', 'no-store')
      .json({ data: adminOrderDetail(order, ctx.storage, settings) });
  });

  router.post('/orders/:id/status', requirePermission('orders:write'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const input = parseInput(orderStatusUpdateSchema, req.body);
    const order = await updateOrderStatus(id, input, req.admin!);
    await audit(req, {
      action: 'order.status_change',
      entityType: 'order',
      entityId: id,
      summary: `Order ${order.orderNumber} → ${ORDER_STATUS_LABELS[order.status]}${input.cancellationReason ? ` (reason: ${input.cancellationReason})` : ''}`,
    });
    void ctx.cache.invalidate('catalog');
    const settings = await getStoreSettings();
    res.json({ data: adminOrderDetail(order, ctx.storage, settings) });
  });

  router.post('/orders/:id/notes', requirePermission('orders:write'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const input = parseInput(orderNoteSchema, req.body);
    const order = await addInternalNote(id, input.text, req.admin!);
    await audit(req, {
      action: 'order.note',
      entityType: 'order',
      entityId: id,
      summary: `Added a note to order ${order.orderNumber}`,
    });
    const settings = await getStoreSettings();
    res.json({ data: adminOrderDetail(order, ctx.storage, settings) });
  });

  router.get('/customers', requirePermission('customers:read'), async (req, res) => {
    const query = parseInput(adminCustomerListQuerySchema, req.query);
    const filter: QueryFilter<Customer> = {};
    if (query.q) {
      const phone = normalizeIndianMobile(query.q);
      if (phone) filter.phone = phone;
      else {
        const pattern = new RegExp(escapeRegex(query.q), 'i');
        filter.$or = [{ name: pattern }, { phone: pattern }, { city: pattern }];
      }
    }
    const [customers, total] = await Promise.all([
      CustomerModel.find(filter)
        .sort({ lastOrderAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<Customer[]>(),
      CustomerModel.countDocuments(filter),
    ]);
    const data: AdminCustomerListItem[] = customers.map(customerListItem);
    res.set('Cache-Control', 'no-store').json({
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  router.get('/customers/:id', requirePermission('customers:read'), async (req, res) => {
    const id = parseInput(objectIdSchema, req.params.id);
    const customer = await CustomerModel.findById(id).lean<Customer>();
    if (!customer) throw notFound('Customer');
    const [orders, totals] = await Promise.all([
      OrderModel.find({ customerId: customer._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean<Order[]>(),
      OrderModel.aggregate<{ total: number }>([
        {
          $match: {
            customerId: new Types.ObjectId(id),
            status: { $in: [...REVENUE_ORDER_STATUSES] },
          },
        },
        { $group: { _id: null, total: { $sum: '$pricing.total' } } },
      ]),
    ]);
    const data: AdminCustomerDetail = {
      ...customerListItem(customer),
      lastAddress: customer.lastAddress
        ? {
            line1: customer.lastAddress.line1,
            line2: customer.lastAddress.line2 ?? null,
            landmark: customer.lastAddress.landmark ?? null,
            city: customer.lastAddress.city,
            state: customer.lastAddress.state,
            pincode: customer.lastAddress.pincode,
          }
        : null,
      totalSpent: totals[0]?.total ?? 0,
      orders: orders.map(adminOrderListItem),
    };
    res.set('Cache-Control', 'no-store').json({ data });
  });

  return router;
}

function customerListItem(customer: Customer): AdminCustomerListItem {
  return {
    id: customer._id.toString(),
    name: customer.name,
    phone: customer.phone,
    whatsapp: customer.whatsapp,
    city: customer.city,
    orderCount: customer.orderCount,
    firstOrderAt: customer.firstOrderAt.toISOString(),
    lastOrderAt: customer.lastOrderAt.toISOString(),
  };
}
