import { Types } from 'mongoose';
import {
  slugify,
  type AdminCategory,
  type CategoryDTO,
  type CategoryInput,
  type CategorySummary,
} from '@jmh/shared';
import type { AppContext } from '../../context';
import { CategoryModel, ProductModel, type Category } from '../../db/models';
import { conflict, notFound } from '../../lib/errors';
import { resolveImageRefs } from '../../media/media.service';
import { imageDTO } from '../../media/serialize';
import { categorySummary } from './product.serialize';

export async function categorySummaryMap(): Promise<Map<string, CategorySummary>> {
  const categories = await CategoryModel.find().select('name nameGu slug').lean();
  return new Map(
    categories.map((category) => [category._id.toString(), categorySummary(category)!]),
  );
}

async function publishedCounts(): Promise<Map<string, number>> {
  const rows = await ProductModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { status: 'published', category: { $ne: null } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

export function categoryDTO(category: Category, count: number, ctx: AppContext): CategoryDTO {
  return {
    id: category._id.toString(),
    name: category.name,
    nameGu: category.nameGu,
    slug: category.slug,
    description: category.description,
    image: imageDTO(category.image, ctx.storage),
    sortOrder: category.sortOrder,
    productCount: count,
    seo: { title: category.seo?.title ?? null, description: category.seo?.description ?? null },
  };
}

export async function listPublicCategories(ctx: AppContext): Promise<CategoryDTO[]> {
  return ctx.cache.wrap('catalog', 'categories', 60, async () => {
    const [categories, counts] = await Promise.all([
      CategoryModel.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      publishedCounts(),
    ]);
    return categories.map((category) =>
      categoryDTO(category, counts.get(category._id.toString()) ?? 0, ctx),
    );
  });
}

export async function listAdminCategories(ctx: AppContext): Promise<AdminCategory[]> {
  const [categories, counts] = await Promise.all([
    CategoryModel.find().sort({ sortOrder: 1, name: 1 }).lean(),
    ProductModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { category: { $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);
  const countMap = new Map(counts.map((row) => [row._id.toString(), row.count]));
  return categories.map((category) => ({
    id: category._id.toString(),
    name: category.name,
    nameGu: category.nameGu,
    slug: category.slug,
    description: category.description,
    image: imageDTO(category.image, ctx.storage),
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    showOnHome: category.showOnHome,
    productCount: countMap.get(category._id.toString()) ?? 0,
    seo: { title: category.seo?.title ?? null, description: category.seo?.description ?? null },
  }));
}

async function uniqueCategorySlug(base: string, excludeId?: Types.ObjectId): Promise<string> {
  const root = base || 'category';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const exists = await CategoryModel.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!exists) return candidate;
  }
  throw conflict('Could not generate a unique slug. Please enter one manually.');
}

export async function createCategory(input: CategoryInput): Promise<Category> {
  const slug = input.slug ?? (await uniqueCategorySlug(slugify(input.name)));
  if (input.slug && (await CategoryModel.exists({ slug: input.slug }))) {
    throw conflict('Another category already uses this URL slug.', 'SLUG_TAKEN');
  }
  const [image] = input.image ? await resolveImageRefs([input.image], 'image') : [null];
  const category = await CategoryModel.create({ ...input, slug, image: image ?? null });
  return category.toObject();
}

export async function updateCategory(id: string, input: CategoryInput): Promise<Category> {
  const category = await CategoryModel.findById(id);
  if (!category) throw notFound('Category');
  const slug = input.slug ?? category.slug;
  if (
    slug !== category.slug &&
    (await CategoryModel.exists({ slug, _id: { $ne: category._id } }))
  ) {
    throw conflict('Another category already uses this URL slug.', 'SLUG_TAKEN');
  }
  const [image] = input.image ? await resolveImageRefs([input.image], 'image') : [null];
  category.set({ ...input, slug, image: image ?? null });
  await category.save();
  return category.toObject();
}

export async function deleteCategory(id: string): Promise<Category> {
  const category = await CategoryModel.findById(id).lean();
  if (!category) throw notFound('Category');
  const products = await ProductModel.countDocuments({ category: category._id });
  if (products > 0) {
    throw conflict(
      `This category still contains ${products} product(s). Move them to another category first.`,
      'CATEGORY_NOT_EMPTY',
    );
  }
  await CategoryModel.deleteOne({ _id: category._id });
  return category;
}

export async function reorderCategories(ids: string[]): Promise<void> {
  await CategoryModel.bulkWrite(
    ids.map((id, index) => ({
      updateOne: {
        filter: { _id: new Types.ObjectId(id) },
        update: { $set: { sortOrder: index * 10 } },
      },
    })),
  );
}

export async function findActiveCategoryBySlug(slug: string): Promise<Category | null> {
  return CategoryModel.findOne({ slug, isActive: true }).lean();
}
