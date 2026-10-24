export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Manually managed availability. Tracked stock can still force `out_of_stock`. */
export const AVAILABILITY = ['in_stock', 'out_of_stock', 'made_to_order'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
  made_to_order: 'Made to order',
};

export const FULFILLMENT_METHODS = ['delivery', 'pickup'] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

export const FULFILLMENT_LABELS: Record<FulfillmentMethod, string> = {
  delivery: 'Home delivery',
  pickup: 'Store pickup',
};

/** How the customer chose to complete checkout. */
export const CHECKOUT_CHANNELS = ['whatsapp', 'website'] as const;
export type CheckoutChannel = (typeof CHECKOUT_CHANNELS)[number];

export const PROMOTION_TYPES = ['percentage', 'fixed_amount'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_SCOPES = ['all', 'categories', 'products'] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];

export const INVENTORY_REASONS = [
  'order_placed',
  'order_cancelled',
  'manual_adjustment',
  'restock',
  'damaged',
  'return',
] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];

export const IMAGE_VARIANTS = ['thumb', 'card', 'standard', 'large'] as const;
export type ImageVariantName = (typeof IMAGE_VARIANTS)[number];

/** Target widths in pixels; images are never upscaled past their source width. */
export const IMAGE_VARIANT_WIDTHS: Record<ImageVariantName, number> = {
  thumb: 240,
  card: 560,
  standard: 1080,
  large: 1800,
};

export const MEDIA_STATUSES = ['processing', 'ready', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const LIMITS = {
  maxCartLines: 50,
  maxLineQuantity: 20,
  maxPageSize: 48,
  defaultPageSize: 24,
  maxAdminPageSize: 100,
  maxImagesPerProduct: 12,
  maxVariantsPerProduct: 30,
  maxSearchLength: 80,
} as const;

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'name_asc', 'featured'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const PRODUCT_SORT_LABELS: Record<ProductSort, string> = {
  featured: 'Featured',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  name_asc: 'Name: A–Z',
};
