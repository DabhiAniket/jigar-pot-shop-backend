import { Router } from 'express';
import {
  hasPermission,
  IN_PROGRESS_ORDER_STATUSES,
  REVENUE_ORDER_STATUSES,
  type DashboardDTO,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { OrderModel, ProductModel, type Order } from '../../db/models';
import { requirePermission } from '../../middleware/auth';
import { listInventory } from '../inventory/inventory.service';
import { adminOrderListItem } from '../orders/order.serialize';

/**
 * Live figures straight from the database. Each section is only computed (and returned) when
 * the admin's role may see it, so product managers never receive order or customer data.
 */
export function dashboardAdminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/', requirePermission('dashboard:read'), async (req, res) => {
    const role = req.admin!.role;
    const data: DashboardDTO = {
      generatedAt: new Date().toISOString(),
      catalog: null,
      orders: null,
    };

    const catalogTask = hasPermission(role, 'products:read')
      ? (async () => {
          const [totalProducts, publishedProducts, draftProducts, stockStats, lowStock] =
            await Promise.all([
              ProductModel.countDocuments({ status: { $ne: 'archived' } }),
              ProductModel.countDocuments({ status: 'published' }),
              ProductModel.countDocuments({ status: 'draft' }),
              ProductModel.aggregate<{ low: number; out: number }>([
                {
                  $match: {
                    status: { $ne: 'archived' },
                    trackInventory: true,
                    availability: 'in_stock',
                  },
                },
                {
                  $group: {
                    _id: null,
                    out: { $sum: { $cond: [{ $lte: ['$stock', 0] }, 1, 0] } },
                    low: {
                      $sum: {
                        $cond: [
                          {
                            $and: [
                              { $gt: ['$stock', 0] },
                              { $lte: ['$stock', '$lowStockThreshold'] },
                            ],
                          },
                          1,
                          0,
                        ],
                      },
                    },
                  },
                },
              ]),
              listInventory(ctx, { filter: 'low', page: 1, limit: 8 }),
            ]);
          data.catalog = {
            totalProducts,
            publishedProducts,
            draftProducts,
            lowStockProducts: stockStats[0]?.low ?? 0,
            outOfStockProducts: stockStats[0]?.out ?? 0,
            lowStock: lowStock.rows.slice(0, 8),
          };
        })()
      : Promise.resolve();

    const ordersTask = hasPermission(role, 'orders:read')
      ? (async () => {
          const since = new Date(Date.now() - 30 * 86_400_000);
          const [statusCounts, sales, recent, top] = await Promise.all([
            OrderModel.aggregate<{ _id: string; count: number }>([
              { $group: { _id: '$status', count: { $sum: 1 } } },
            ]),
            OrderModel.aggregate<{ _id: null; total: number; last30: number; orders30: number }>([
              { $match: { status: { $in: [...REVENUE_ORDER_STATUSES] } } },
              {
                $group: {
                  _id: null,
                  total: { $sum: '$pricing.total' },
                  last30: {
                    $sum: { $cond: [{ $gte: ['$createdAt', since] }, '$pricing.total', 0] },
                  },
                  orders30: { $sum: { $cond: [{ $gte: ['$createdAt', since] }, 1, 0] } },
                },
              },
            ]),
            OrderModel.find().sort({ createdAt: -1 }).limit(8).lean<Order[]>(),
            OrderModel.aggregate<{ _id: string; name: string; quantity: number; revenue: number }>([
              { $match: { status: { $in: [...REVENUE_ORDER_STATUSES] } } },
              { $unwind: '$items' },
              {
                $group: {
                  _id: '$items.product',
                  name: { $last: '$items.name' },
                  quantity: { $sum: '$items.quantity' },
                  revenue: { $sum: '$items.lineTotal' },
                },
              },
              { $sort: { quantity: -1, revenue: -1 } },
              { $limit: 5 },
            ]),
          ]);
          const count = (statuses: readonly string[]) =>
            statusCounts
              .filter((row) => statuses.includes(row._id))
              .reduce((sum, row) => sum + row.count, 0);
          data.orders = {
            totalOrders: statusCounts.reduce((sum, row) => sum + row.count, 0),
            pendingOrders: count(['pending', 'awaiting_confirmation']),
            inProgressOrders: count(IN_PROGRESS_ORDER_STATUSES),
            completedOrders: count(['delivered']),
            cancelledOrders: count(['cancelled', 'refunded']),
            salesTotal: sales[0]?.total ?? 0,
            salesLast30Days: sales[0]?.last30 ?? 0,
            ordersLast30Days: sales[0]?.orders30 ?? 0,
            recentOrders: recent.map(adminOrderListItem),
            topProducts: top.map((row) => ({
              productId: String(row._id),
              name: row.name,
              quantity: row.quantity,
              revenue: row.revenue,
            })),
          };
        })()
      : Promise.resolve();

    await Promise.all([catalogTask, ordersTask]);
    res.set('Cache-Control', 'no-store').json({ data });
  });

  return router;
}
