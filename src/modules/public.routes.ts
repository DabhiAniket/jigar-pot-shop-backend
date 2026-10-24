import { Router, type Response } from 'express';
import {
  cartQuoteSchema,
  checkoutSchema,
  idempotencyKeySchema,
  orderNumberSchema,
  orderTrackSchema,
  POLICY_KEYS,
  productListQuerySchema,
  slugSchema,
  type CreateOrderResponse,
  type HomePageDTO,
  type PolicyDTO,
  type PolicyKey,
  type PublicStoreSettings,
} from '@jmh/shared';
import { z } from 'zod';
import type { AppContext } from '../context';
import { CategoryModel, OrderModel, ProductModel, PromotionModel, type Order } from '../db/models';
import { AppError, notFound } from '../lib/errors';
import { parseInput } from '../lib/validate';
import { imageDTO } from '../media/serialize';
import type { LimiterFactory } from '../middleware/rate-limit';
import { quoteCart } from './cart/cart.service';
import { listPublicCategories } from './catalog/category.service';
import {
  getPublicProduct,
  homeProductSections,
  listPublicProducts,
  relatedProducts,
} from './catalog/product.service';
import { publicOrderDTO } from './orders/order.serialize';
import { createOrder, orderAccessToken, verifyOrderAccessToken } from './orders/order.service';
import {
  getHomeContent,
  getStoreSettings,
  resolveWhatsAppNumber,
} from './settings/settings.service';

/** Public catalogue responses may be cached by browsers briefly and by CDNs a little longer. */
function publicCache(res: Response, seconds = 60): void {
  res.set(
    'Cache-Control',
    `public, max-age=${Math.min(seconds, 30)}, s-maxage=${seconds}, stale-while-revalidate=300`,
  );
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
}

const POLICY_TITLES: Record<PolicyKey, string> = {
  shipping: 'Shipping & Delivery Policy',
  returns: 'Returns & Refunds Policy',
  privacy: 'Privacy Policy',
  terms: 'Terms & Conditions',
};

export function publicRoutes(ctx: AppContext, limiter: LimiterFactory): Router {
  const router = Router();
  const quoteLimiter = limiter({ name: 'cart-quote', windowMs: 60_000, limit: 120 });
  const orderLimiter = limiter({
    name: 'order-create',
    windowMs: 10 * 60_000,
    limit: 30,
    message:
      'Too many orders from this network. Please wait a few minutes or contact us on WhatsApp.',
  });
  const trackLimiter = limiter({ name: 'order-track', windowMs: 10 * 60_000, limit: 30 });

  router.get('/settings', async (_req, res) => {
    const data = await ctx.cache.wrap(
      'settings',
      'public',
      60,
      async (): Promise<PublicStoreSettings> => {
        const settings = await getStoreSettings();
        const now = new Date();
        const banners = await PromotionModel.find({
          isActive: true,
          'banner.show': true,
          startsAt: { $lte: now },
          endsAt: { $gt: now },
        })
          .sort({ priority: -1, endsAt: 1 })
          .limit(3)
          .lean();
        return {
          storeName: settings.storeName,
          legalName: settings.legalName ?? null,
          tagline: settings.tagline ?? null,
          phone: settings.phone ?? null,
          whatsappNumber: resolveWhatsAppNumber(settings, ctx.config.whatsappNumber),
          email: settings.email ?? null,
          address: {
            line1: settings.address?.line1 ?? null,
            line2: settings.address?.line2 ?? null,
            city: settings.address?.city ?? null,
            state: settings.address?.state ?? null,
            pincode: settings.address?.pincode ?? null,
            mapUrl: settings.address?.mapUrl ?? null,
          },
          openingHours: settings.openingHours ?? [],
          social: {
            instagram: settings.social?.instagram ?? null,
            facebook: settings.social?.facebook ?? null,
            youtube: settings.social?.youtube ?? null,
            x: settings.social?.x ?? null,
          },
          delivery: settings.delivery,
          seo: settings.seo,
          policiesAvailable: Object.fromEntries(
            POLICY_KEYS.map((key) => [key, Boolean(settings.policies?.[key]?.trim())]),
          ) as Record<PolicyKey, boolean>,
          banners: banners.map((promotion) => ({
            id: promotion._id.toString(),
            name: promotion.name,
            headline: promotion.banner.headline ?? promotion.name,
            subtext: promotion.banner.subtext,
            ctaLabel: promotion.banner.ctaLabel,
            ctaHref: promotion.banner.ctaHref,
            endsAt: promotion.endsAt.toISOString(),
            code: promotion.code,
          })),
        };
      },
    );
    publicCache(res, 60);
    res.json({ data });
  });

  router.get('/policies/:key', async (req, res) => {
    const key = parseInput(z.enum(POLICY_KEYS), req.params.key);
    const settings = await getStoreSettings();
    const data: PolicyDTO = {
      key,
      title: POLICY_TITLES[key],
      body: settings.policies?.[key] ?? '',
      updatedAt: settings.policiesUpdatedAt?.toISOString() ?? null,
    };
    publicCache(res, 300);
    res.json({ data });
  });

  router.get('/home', async (_req, res) => {
    const data = await ctx.cache.wrap('catalog', 'home', 60, async (): Promise<HomePageDTO> => {
      const [content, categories, sections] = await Promise.all([
        getHomeContent(),
        listPublicCategories(ctx),
        homeProductSections(ctx),
      ]);
      const homeCategoryIds = new Set(
        (await CategoryModel.find({ isActive: true, showOnHome: true }).select('_id').lean()).map(
          (c) => c._id.toString(),
        ),
      );
      return {
        content: {
          hero: { ...content.hero, image: imageDTO(content.hero.image, ctx.storage) },
          story: content.story,
          craft: content.craft,
          featuredCategoryIds: content.featuredCategoryIds,
          sections: content.sections,
        },
        categories: categories.filter((category) => homeCategoryIds.has(category.id)),
        ...sections,
      };
    });
    publicCache(res, 60);
    res.json({ data });
  });

  router.get('/categories', async (_req, res) => {
    const data = await listPublicCategories(ctx);
    publicCache(res, 120);
    res.json({ data });
  });

  router.get('/products', async (req, res) => {
    const query = parseInput(productListQuerySchema, req.query);
    const cacheKey = `list:${JSON.stringify(query)}`;
    const page = await ctx.cache.wrap('catalog', cacheKey, 30, () =>
      listPublicProducts(ctx, query),
    );
    publicCache(res, 60);
    res.json(page);
  });

  router.get('/products/:slug', async (req, res) => {
    const slug = parseInput(slugSchema, req.params.slug);
    const product = await ctx.cache.wrap('catalog', `product:${slug}`, 30, () =>
      getPublicProduct(ctx, slug),
    );
    if (!product) throw notFound('Product');
    publicCache(res, 60);
    res.json({ data: product });
  });

  router.get('/products/:slug/related', async (req, res) => {
    const slug = parseInput(slugSchema, req.params.slug);
    const data = await ctx.cache.wrap('catalog', `related:${slug}`, 120, () =>
      relatedProducts(ctx, slug),
    );
    publicCache(res, 120);
    res.json({ data });
  });

  router.post('/cart/quote', quoteLimiter, async (req, res) => {
    const input = parseInput(cartQuoteSchema, req.body);
    const data = await quoteCart(ctx, input);
    noStore(res);
    res.json({ data });
  });

  router.post('/orders', orderLimiter, async (req, res) => {
    const rawKey = req.get('idempotency-key');
    const idempotencyKey = rawKey ? parseInput(idempotencyKeySchema, rawKey) : null;
    const input = parseInput(checkoutSchema, req.body);
    const { order, replayed } = await createOrder(ctx, input, idempotencyKey);
    const settings = await getStoreSettings();
    const data: CreateOrderResponse = {
      order: publicOrderDTO(order, ctx.storage, settings, ctx.config.whatsappNumber),
      accessToken: orderAccessToken(ctx.config.appSecret, order.orderNumber),
      replayed,
    };
    noStore(res);
    res.status(replayed ? 200 : 201).json({ data });
  });

  // POST so the phone number travels in the body and never appears in URLs or access logs.
  router.post('/orders/track', trackLimiter, async (req, res) => {
    const input = parseInput(orderTrackSchema, req.body);
    const order = await OrderModel.findOne({
      orderNumber: input.orderNumber,
      'customer.phone': input.phone,
    }).lean<Order>();
    if (!order)
      throw new AppError(
        404,
        'ORDER_NOT_FOUND',
        'We could not find an order with that number and phone.',
      );
    const settings = await getStoreSettings();
    noStore(res);
    res.json({ data: publicOrderDTO(order, ctx.storage, settings, ctx.config.whatsappNumber) });
  });

  router.get('/orders/:orderNumber', trackLimiter, async (req, res) => {
    const orderNumber = parseInput(orderNumberSchema, req.params.orderNumber);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token || !verifyOrderAccessToken(ctx.config.appSecret, orderNumber, token)) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    }
    const order = await OrderModel.findOne({ orderNumber }).lean<Order>();
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    const settings = await getStoreSettings();
    noStore(res);
    res.json({ data: publicOrderDTO(order, ctx.storage, settings, ctx.config.whatsappNumber) });
  });

  router.get('/seo/sitemap', async (_req, res) => {
    const data = await ctx.cache.wrap('catalog', 'sitemap', 300, async () => {
      const [products, categories] = await Promise.all([
        ProductModel.find({ status: 'published' })
          .select('slug updatedAt')
          .sort({ updatedAt: -1 })
          .limit(45_000)
          .lean(),
        CategoryModel.find({ isActive: true }).select('slug updatedAt').lean(),
      ]);
      return {
        products: products.map((product) => ({
          slug: product.slug,
          updatedAt: product.updatedAt.toISOString(),
        })),
        categories: categories.map((category) => ({
          slug: category.slug,
          updatedAt: category.updatedAt.toISOString(),
        })),
      };
    });
    publicCache(res, 300);
    res.json({ data });
  });

  return router;
}
