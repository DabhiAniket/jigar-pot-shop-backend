import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InventoryMovementModel, ProductModel } from '../../src/db/models';
import {
  adminClient,
  createHarness,
  createReadyAsset,
  signedInAs,
  type Harness,
} from '../helpers/harness';

let harness: Harness;
let pm: ReturnType<typeof adminClient>;
beforeAll(async () => {
  harness = await createHarness();
  pm = adminClient(await signedInAs(harness, 'product_manager'));
});
afterAll(async () => {
  await harness.close();
});

async function newCategory(name: string) {
  const response = await pm.post('/api/v1/admin/categories', { name });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

describe('product management', () => {
  it('creates a draft, refuses to publish it without images, then publishes it', async () => {
    const categoryId = await newCategory('Clay Matkas');
    const draft = await pm.post('/api/v1/admin/products', {
      name: 'Classic Clay Matka',
      price: 899_00,
      salePrice: 799_00,
      stock: 12,
      categoryId,
      sku: 'jmh-matka-10l',
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({
      slug: 'classic-clay-matka',
      status: 'draft',
      sku: 'JMH-MATKA-10L',
    });
    const id = draft.body.data.id;
    expect(
      await InventoryMovementModel.exists({ product: id, note: 'Opening stock', delta: 12 }),
    ).toBeTruthy();

    const publishWithoutImage = await pm.put(`/api/v1/admin/products/${id}`, {
      ...draft.body.data,
      categoryId,
      images: [],
      status: 'published',
    });
    expect(publishWithoutImage.status).toBe(400);
    expect(publishWithoutImage.body.error.fields.images).toBeDefined();

    const assetId = await createReadyAsset(harness);
    const published = await pm.put(`/api/v1/admin/products/${id}`, {
      ...draft.body.data,
      categoryId,
      images: [{ assetId, alt: 'Classic clay matka with lid' }],
      status: 'published',
      version: draft.body.data.updatedAt,
    });
    expect(published.status).toBe(200);
    expect(published.body.data.publishedAt).toEqual(expect.any(String));

    const storefront = await harness.request().get('/api/v1/products/classic-clay-matka');
    expect(storefront.status).toBe(200);
    expect(storefront.body.data).toMatchObject({
      name: 'Classic Clay Matka',
      price: 899_00,
      salePrice: 799_00,
      availability: 'in_stock',
    });
    expect(storefront.body.data.images[0].variants[0].url).toMatch(
      /^http:\/\/localhost:3000\/media\/img\/.+\.webp$/,
    );
  });

  it('rejects stale edits so concurrent stock changes are not overwritten', async () => {
    const created = (
      await pm.post('/api/v1/admin/products', { name: 'Stale Test Pot', price: 100_00, stock: 5 })
    ).body.data;
    await ProductModel.updateOne({ _id: created.id }, { $inc: { stock: -1 } });
    const stale = await pm.put(`/api/v1/admin/products/${created.id}`, {
      ...created,
      stock: 5,
      version: created.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_PRODUCT');
  });

  it('enforces unique SKUs and slugs, and redirects renamed slugs', async () => {
    const first = (
      await pm.post('/api/v1/admin/products', {
        name: 'Unique Surahi',
        price: 450_00,
        sku: 'SURAHI-1',
      })
    ).body.data;
    const dupSku = await pm.post('/api/v1/admin/products', {
      name: 'Other Surahi',
      price: 450_00,
      sku: 'surahi-1',
    });
    expect(dupSku.status).toBe(400);
    const dupSlug = await pm.post('/api/v1/admin/products', {
      name: 'X',
      price: 450_00,
      slug: 'unique-surahi',
    });
    expect(dupSlug.status).toBe(400);

    const assetId = await createReadyAsset(harness);
    const renamed = await pm.put(`/api/v1/admin/products/${first.id}`, {
      ...first,
      slug: 'long-neck-surahi',
      images: [{ assetId, alt: '' }],
      status: 'published',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.previousSlugs).toContain('unique-surahi');
    const old = await harness.request().get('/api/v1/products/unique-surahi');
    expect(old.body.data).toEqual({ redirectTo: 'long-neck-surahi' });
  });

  it('duplicates as a draft without SKU or stock, and deletes with orders unaffected', async () => {
    const original = (
      await pm.post('/api/v1/admin/products', {
        name: 'Kulhad Set',
        price: 299_00,
        sku: 'KUL-4',
        stock: 30,
      })
    ).body.data;
    const copy = await pm.post(`/api/v1/admin/products/${original.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({
      name: 'Kulhad Set (Copy)',
      status: 'draft',
      sku: null,
      stock: 0,
    });
    expect((await pm.delete(`/api/v1/admin/products/${copy.body.data.id}`)).status).toBe(204);
    expect((await pm.get(`/api/v1/admin/products/${copy.body.data.id}`)).status).toBe(404);
  });

  it('applies bulk actions and skips products that cannot be published', async () => {
    const withImage = await pm.post('/api/v1/admin/products', {
      name: 'Bulk With Image',
      price: 100_00,
      images: [{ assetId: await createReadyAsset(harness), alt: '' }],
    });
    const withoutImage = await pm.post('/api/v1/admin/products', {
      name: 'Bulk Without Image',
      price: 100_00,
    });
    const result = await pm.post('/api/v1/admin/products/bulk', {
      ids: [withImage.body.data.id, withoutImage.body.data.id],
      action: 'publish',
    });
    expect(result.body.data).toMatchObject({ modified: 1, skipped: 1 });
    const featured = await pm.post('/api/v1/admin/products/bulk', {
      ids: [withImage.body.data.id],
      action: 'feature',
    });
    expect(featured.status).toBe(200);
    const stored = await ProductModel.findById(withImage.body.data.id).lean();
    expect(stored).toMatchObject({ status: 'published', isFeatured: true, rank: 2 });
  });

  it('blocks deleting a category that still has products', async () => {
    const categoryId = await newCategory('Planters');
    await pm.post('/api/v1/admin/products', { name: 'Tapered Planter', price: 350_00, categoryId });
    const response = await pm.delete(`/api/v1/admin/categories/${categoryId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CATEGORY_NOT_EMPTY');
  });
});

describe('storefront catalogue', () => {
  it('lists only published products with filters, search, sorting and pagination', async () => {
    const categoryId = await newCategory('Cookware');
    const mk = async (name: string, price: number, extra: object = {}) => {
      const assetId = await createReadyAsset(harness);
      const response = await pm.post('/api/v1/admin/products', {
        name,
        price,
        categoryId,
        status: 'published',
        images: [{ assetId, alt: name }],
        stock: 5,
        tags: ['cookware'],
        ...extra,
      });
      expect(response.status).toBe(201);
    };
    await mk('Clay Handi With Lid', 1200_00);
    await mk('Clay Kadai', 950_00, { salePrice: 800_00 });
    await mk('Clay Curd Pot', 300_00, { stock: 0 });
    await pm.post('/api/v1/admin/products', {
      name: 'Hidden Draft Cookware',
      price: 1_00,
      categoryId,
    });

    const byCategory = await harness
      .request()
      .get('/api/v1/products?category=cookware&sort=price_asc');
    expect(byCategory.status).toBe(200);
    expect(byCategory.body.data.map((p: { name: string }) => p.name)).toEqual([
      'Clay Curd Pot',
      'Clay Kadai',
      'Clay Handi With Lid',
    ]);
    expect(byCategory.body.meta.total).toBe(3);
    expect(byCategory.body.category.name).toBe('Cookware');

    const inStock = await harness.request().get('/api/v1/products?category=cookware&inStock=true');
    expect(inStock.body.data.map((p: { name: string }) => p.name)).not.toContain('Clay Curd Pot');
    const onSale = await harness.request().get('/api/v1/products?category=cookware&onSale=true');
    expect(onSale.body.data.map((p: { name: string }) => p.name)).toEqual(['Clay Kadai']);
    const priceRange = await harness
      .request()
      .get('/api/v1/products?category=cookware&minPrice=500&maxPrice=1000');
    expect(priceRange.body.data.map((p: { name: string }) => p.name)).toEqual(['Clay Kadai']);

    const search = await harness.request().get('/api/v1/products?q=handi');
    expect(search.body.data[0].name).toBe('Clay Handi With Lid');

    const paged = await harness
      .request()
      .get('/api/v1/products?category=cookware&limit=2&page=2&sort=price_asc');
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.meta).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });

    expect((await harness.request().get('/api/v1/products?limit=1000')).status).toBe(400);
    // Operator syntax is never parsed into an object: the bracketed key is inert and dropped…
    const injected = await harness.request().get('/api/v1/products?category[$ne]=x&limit=48');
    const unfiltered = await harness.request().get('/api/v1/products?limit=48');
    expect(injected.status).toBe(200);
    expect(injected.body.meta.total).toBe(unfiltered.body.meta.total);
    // …and non-string values (repeated keys become arrays) are rejected outright.
    expect(
      (await harness.request().get('/api/v1/products?category=cookware&category=planters')).status,
    ).toBe(400);
  });

  it('serves categories with published counts and a sitemap', async () => {
    const categories = await harness.request().get('/api/v1/categories');
    expect(categories.status).toBe(200);
    const cookware = categories.body.data.find((c: { slug: string }) => c.slug === 'cookware');
    expect(cookware.productCount).toBe(3);
    const sitemap = await harness.request().get('/api/v1/seo/sitemap');
    expect(sitemap.body.data.products.length).toBeGreaterThan(0);
    expect(sitemap.headers['cache-control']).toMatch(/public/);
  });
});

describe('inventory', () => {
  it('adjusts stock atomically and keeps an audit trail', async () => {
    const product = (
      await pm.post('/api/v1/admin/products', { name: 'Inventory Pot', price: 100_00, stock: 2 })
    ).body.data;
    const restock = await pm.post('/api/v1/admin/inventory/adjust', {
      productId: product.id,
      mode: 'delta',
      quantity: 8,
      reason: 'restock',
      note: 'Kiln batch 14',
    });
    expect(restock.status).toBe(201);
    expect(restock.body.data).toEqual({ delta: 8, stockAfter: 10 });
    const set = await pm.post('/api/v1/admin/inventory/adjust', {
      productId: product.id,
      mode: 'set',
      quantity: 7,
      reason: 'damaged',
    });
    expect(set.body.data).toEqual({ delta: -3, stockAfter: 7 });
    const negative = await pm.post('/api/v1/admin/inventory/adjust', {
      productId: product.id,
      mode: 'delta',
      quantity: -50,
      reason: 'damaged',
    });
    expect(negative.status).toBe(400);
    const movements = await pm.get(`/api/v1/admin/inventory/movements?productId=${product.id}`);
    expect(movements.body.data.map((m: { delta: number }) => m.delta)).toEqual([-3, 8, 2]);
  });
});
