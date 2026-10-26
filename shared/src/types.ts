import type {
  Availability,
  CheckoutChannel,
  FulfillmentMethod,
  ImageVariantName,
  InventoryReason,
  MediaStatus,
  ProductStatus,
  PromotionScope,
  PromotionType,
} from './constants';
import type { Paise } from './money';
import type { OrderStatus } from './order-status';
import type { AdminRole, Permission } from './permissions';
import type { PromoCodeStatus } from './pricing';
import type { Weekday } from './schemas/settings';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field path ("customer.phone") → messages, for form errors. */
    fields?: Record<string, string[]>;
    requestId?: string;
  };
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

export interface ImageVariantDTO {
  name: ImageVariantName;
  url: string;
  width: number;
  height: number;
}

export interface ImageDTO {
  assetId: string;
  alt: string;
  width: number;
  height: number;
  /** Tiny inline WebP used as a blurred placeholder while the real image loads. */
  placeholder: string | null;
  variants: ImageVariantDTO[];
}

export interface SeoFields {
  title: string | null;
  description: string | null;
}

export interface CategorySummary {
  id: string;
  name: string;
  nameGu: string | null;
  slug: string;
}

export interface CategoryDTO extends CategorySummary {
  description: string;
  image: ImageDTO | null;
  sortOrder: number;
  productCount: number;
  seo: SeoFields;
}

export interface ProductSpecs {
  material: string | null;
  finish: string | null;
  color: string | null;
  heightCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
  diameterCm: number | null;
  capacityLitres: number | null;
  weightKg: number | null;
}

export interface ProductSummary {
  id: string;
  name: string;
  nameGu: string | null;
  slug: string;
  category: CategorySummary | null;
  image: ImageDTO | null;
  secondaryImage: ImageDTO | null;
  /** Regular price of the cheapest purchasable option. */
  price: Paise;
  salePrice: Paise | null;
  /** What the customer pays for the cheapest option ("from ₹…" when variants differ). */
  effectivePrice: Paise;
  hasPriceRange: boolean;
  hasVariants: boolean;
  availability: Availability;
  lowStock: boolean;
  isFeatured: boolean;
  isBestseller: boolean;
  publishedAt: string | null;
}

export interface VariantDTO {
  id: string;
  name: string;
  sku: string | null;
  price: Paise;
  salePrice: Paise | null;
  availability: Availability;
  /** Largest quantity a customer may add (bounded by stock and the per-line limit). */
  maxQuantity: number;
  lowStock: boolean;
}

export interface ProductDetail extends ProductSummary {
  sku: string | null;
  shortDescription: string;
  description: string;
  images: ImageDTO[];
  variants: VariantDTO[];
  specs: ProductSpecs;
  shippingInfo: string;
  tags: string[];
  seo: SeoFields;
  maxQuantity: number;
  updatedAt: string;
}

/** Returned instead of a product when an old slug was renamed. */
export interface ProductRedirect {
  redirectTo: string;
}

export interface PromotionBannerDTO {
  id: string;
  name: string;
  headline: string;
  subtext: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  endsAt: string;
  code: string | null;
}

export interface OpeningHoursDTO {
  day: Weekday;
  isOpen: boolean;
  opens: string;
  closes: string;
}

export interface PublicStoreSettings {
  storeName: string;
  legalName: string | null;
  tagline: string | null;
  phone: string | null;
  whatsappNumber: string | null;
  email: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    mapUrl: string | null;
  };
  openingHours: OpeningHoursDTO[];
  social: {
    instagram: string | null;
    facebook: string | null;
    youtube: string | null;
    x: string | null;
  };
  delivery: {
    deliveryEnabled: boolean;
    pickupEnabled: boolean;
    flatCharge: Paise;
    freeDeliveryThreshold: Paise | null;
    note: string | null;
  };
  seo: { defaultTitle: string | null; defaultDescription: string | null };
  policiesAvailable: Record<PolicyKey, boolean>;
  banners: PromotionBannerDTO[];
}

export const POLICY_KEYS = ['shipping', 'returns', 'privacy', 'terms'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

export interface PolicyDTO {
  key: PolicyKey;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface HomeContentDTO {
  hero: {
    eyebrow: string | null;
    headline: string;
    headlineLang: 'gu' | 'en';
    subheadline: string | null;
    primaryCta: { label: string; href: string };
    secondaryCta: { label: string; href: string };
    image: ImageDTO | null;
    video: { mp4Url: string | null; webmUrl: string | null; posterUrl: string | null };
  };
  story: { enabled: boolean; chapters: { title: string; body: string }[] };
  craft: {
    enabled: boolean;
    title: string;
    body: string;
    points: { title: string; body: string }[];
  };
  featuredCategoryIds: string[];
  sections: {
    bestsellers: boolean;
    newArrivals: boolean;
    offers: boolean;
    recentlyViewed: boolean;
    visitStore: boolean;
  };
}

export interface HomePageDTO {
  content: HomeContentDTO;
  categories: CategoryDTO[];
  bestsellers: ProductSummary[];
  newArrivals: ProductSummary[];
  featured: ProductSummary[];
  offers: ProductSummary[];
}

export type CartIssueCode =
  | 'not_found'
  | 'unavailable'
  | 'out_of_stock'
  | 'insufficient_stock'
  | 'variant_required'
  | 'variant_unavailable';

export interface CartIssue {
  code: CartIssueCode;
  message: string;
}

export interface CartQuoteLine {
  key: string;
  productId: string;
  variantId: string | null;
  slug: string | null;
  name: string;
  variantName: string | null;
  image: ImageDTO | null;
  listPrice: Paise;
  unitPrice: Paise;
  quantity: number;
  requestedQuantity: number;
  maxQuantity: number;
  lineSubtotal: Paise;
  lineDiscount: Paise;
  lineTotal: Paise;
  issue: CartIssue | null;
}

export interface CartQuote {
  lines: CartQuoteLine[];
  subtotal: Paise;
  discountTotal: Paise;
  deliveryCharge: Paise;
  total: Paise;
  appliedPromotion: { id: string; name: string; code: string | null; amount: Paise } | null;
  promoCode: { code: string; status: PromoCodeStatus; message: string } | null;
  fulfillment: FulfillmentMethod;
  fulfillmentAvailable: boolean;
  delivery: PublicStoreSettings['delivery'];
  canCheckout: boolean;
}

export interface OrderAddressDTO {
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface OrderItemDTO {
  productId: string;
  variantId: string | null;
  slug: string;
  name: string;
  variantName: string | null;
  sku: string | null;
  image: string | null;
  listPrice: Paise;
  unitPrice: Paise;
  quantity: number;
  lineSubtotal: Paise;
  lineDiscount: Paise;
  lineTotal: Paise;
}

export interface OrderPricingDTO {
  subtotal: Paise;
  discountTotal: Paise;
  deliveryCharge: Paise;
  total: Paise;
  appliedPromotion: { id: string; name: string; code: string | null; amount: Paise } | null;
}

export interface OrderStatusEventDTO {
  from: OrderStatus | null;
  to: OrderStatus;
  at: string;
  note: string | null;
  byName: string | null;
}

/** What the customer sees on the confirmation and tracking pages. */
export interface PublicOrderDTO {
  orderNumber: string;
  status: OrderStatus;
  channel: CheckoutChannel;
  fulfillment: FulfillmentMethod;
  createdAt: string;
  customerName: string;
  phoneMasked: string;
  address: OrderAddressDTO | null;
  items: OrderItemDTO[];
  pricing: OrderPricingDTO;
  notes: string | null;
  history: { status: OrderStatus; at: string }[];
  whatsappUrl: string | null;
}

export interface CreateOrderResponse {
  order: PublicOrderDTO;
  /** True when the request was a retry of an order that already exists. */
  replayed: boolean;
}

export interface AdminOrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  channel: CheckoutChannel;
  fulfillment: FulfillmentMethod;
  customerName: string;
  phone: string;
  city: string | null;
  itemCount: number;
  total: Paise;
  createdAt: string;
  cancellationRequest: CancellationRequestStatus | null;
}

export interface AdminOrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  allowedTransitions: OrderStatus[];
  channel: CheckoutChannel;
  fulfillment: FulfillmentMethod;
  customer: { name: string; phone: string; whatsapp: string | null };
  address: OrderAddressDTO | null;
  notes: string | null;
  items: OrderItemDTO[];
  pricing: OrderPricingDTO;
  statusHistory: OrderStatusEventDTO[];
  internalNotes: { text: string; at: string; byName: string }[];
  cancellationReason: string | null;
  cancelledBy: { kind: CancelledBy; byName: string | null; at: string } | null;
  cancellationRequest: (CancellationRequestDTO & { resolvedByName: string | null }) | null;
  shipment: ShipmentDTO | null;
  /** Orders placed by a signed-in customer carry the account id; legacy guest orders do not. */
  hasAccount: boolean;
  inventory: { committed: boolean; restockedAt: string | null };
  whatsappContactUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCustomerListItem {
  id: string;
  name: string;
  phone: string;
  whatsapp: string | null;
  city: string | null;
  orderCount: number;
  firstOrderAt: string;
  lastOrderAt: string;
}

export interface AdminCustomerDetail extends AdminCustomerListItem {
  lastAddress: OrderAddressDTO | null;
  totalSpent: Paise;
  orders: AdminOrderListItem[];
}

export interface AdminProductVariant {
  id: string;
  name: string;
  sku: string | null;
  price: Paise | null;
  salePrice: Paise | null;
  stock: number;
  isActive: boolean;
}

export interface AdminProductImage extends ImageDTO {
  status: MediaStatus;
}

export interface AdminProductListItem {
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  status: ProductStatus;
  category: CategorySummary | null;
  thumbnail: string | null;
  price: Paise;
  salePrice: Paise | null;
  stock: number;
  trackInventory: boolean;
  hasVariants: boolean;
  lowStock: boolean;
  isFeatured: boolean;
  isBestseller: boolean;
  updatedAt: string;
}

export interface AdminProductDetail {
  id: string;
  name: string;
  nameGu: string | null;
  slug: string;
  sku: string | null;
  categoryId: string | null;
  shortDescription: string;
  description: string;
  price: Paise;
  salePrice: Paise | null;
  trackInventory: boolean;
  stock: number;
  lowStockThreshold: number;
  availability: Availability;
  images: AdminProductImage[];
  variants: AdminProductVariant[];
  specs: ProductSpecs;
  shippingInfo: string;
  tags: string[];
  isFeatured: boolean;
  isBestseller: boolean;
  status: ProductStatus;
  seo: SeoFields;
  previousSlugs: string[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCategory {
  id: string;
  name: string;
  nameGu: string | null;
  slug: string;
  description: string;
  image: ImageDTO | null;
  sortOrder: number;
  isActive: boolean;
  showOnHome: boolean;
  productCount: number;
  seo: SeoFields;
}

export interface MediaAssetDTO {
  id: string;
  status: MediaStatus;
  alt: string;
  originalFilename: string;
  sourceFormat: string | null;
  sourceBytes: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  width: number | null;
  height: number | null;
  totalBytes: number;
  placeholder: string | null;
  variants: (ImageVariantDTO & { bytes: number })[];
  error: string | null;
  usageCount: number | null;
  createdAt: string;
}

export interface AdminPromotion {
  id: string;
  name: string;
  description: string;
  type: PromotionType;
  value: number;
  maxDiscount: Paise | null;
  minOrderValue: Paise | null;
  scope: PromotionScope;
  categoryIds: string[];
  productIds: string[];
  code: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  priority: number;
  state: 'scheduled' | 'live' | 'expired' | 'disabled';
  banner: {
    show: boolean;
    headline: string | null;
    subtext: string | null;
    ctaLabel: string | null;
    ctaHref: string | null;
  };
  updatedAt: string;
}

export interface InventoryRow {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  slug: string;
  status: ProductStatus;
  stock: number;
  lowStockThreshold: number;
  thumbnail: string | null;
}

export interface InventoryMovementDTO {
  id: string;
  productId: string;
  productName: string;
  variantName: string | null;
  delta: number;
  stockAfter: number | null;
  reason: InventoryReason;
  orderNumber: string | null;
  note: string | null;
  byName: string | null;
  createdAt: string;
}

export interface AdminMe {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  permissions: Permission[];
  mustChangePassword: boolean;
  csrfToken: string;
}

export interface AdminUserDTO {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  activeSessions: number;
  createdAt: string;
}

export interface AdminSessionDTO {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AuditEventDTO {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  actorName: string | null;
  actorEmail: string | null;
  ip: string | null;
  createdAt: string;
}

export interface DashboardDTO {
  generatedAt: string;
  catalog: {
    totalProducts: number;
    publishedProducts: number;
    draftProducts: number;
    lowStockProducts: number;
    outOfStockProducts: number;
    lowStock: InventoryRow[];
  } | null;
  orders: {
    totalOrders: number;
    pendingOrders: number;
    inProgressOrders: number;
    completedOrders: number;
    cancelledOrders: number;
    salesTotal: Paise;
    salesLast30Days: Paise;
    ordersLast30Days: number;
    recentOrders: AdminOrderListItem[];
    topProducts: { productId: string; name: string; quantity: number; revenue: Paise }[];
  } | null;
}

// ── Customer accounts, server cart, own-order views ──

export interface SavedAddressDTO extends OrderAddressDTO {
  id: string;
  label: string | null;
  isDefault: boolean;
}

export interface CustomerMe {
  id: string;
  name: string;
  email: string;
  phone: string;
  addresses: SavedAddressDTO[];
  csrfToken: string;
}

export interface ShipmentDTO {
  provider: string;
  trackingNumber: string;
  trackingUrl: string | null;
  shippedAt: string;
  estimatedDelivery: string | null;
  notes: string | null;
}

export type CancellationRequestStatus = 'requested' | 'approved' | 'rejected';

export interface CancellationRequestDTO {
  status: CancellationRequestStatus;
  reason: string;
  requestedAt: string;
  resolvedAt: string | null;
  /** Visible to the customer: why a request was rejected. */
  resolutionNote: string | null;
}

/** Who ended the order: staff directly, or staff approving the customer's own request. */
export type CancelledBy = 'admin' | 'customer_request';

export interface CustomerOrderListItem {
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
  total: Paise;
  itemCount: number;
  firstItem: { name: string; image: string | null } | null;
  cancellationRequest: CancellationRequestStatus | null;
}

export interface CustomerOrderDTO extends PublicOrderDTO {
  timeline: { status: OrderStatus; at: string; note: string | null }[];
  shipment: ShipmentDTO | null;
  cancellationRequest: CancellationRequestDTO | null;
  cancelledBy: CancelledBy | null;
  cancellationReason: string | null;
  /** True while the customer may still ask for cancellation. */
  canRequestCancellation: boolean;
  /** No online payment is processed; payment is arranged with the store (WhatsApp or on pickup). */
  payment: { method: 'offline'; status: 'not_processed_online' | 'refunded'; note: string };
}

export interface ServerCartDTO {
  items: { productId: string; variantId: string | null; quantity: number }[];
  quote: CartQuote | null;
}
