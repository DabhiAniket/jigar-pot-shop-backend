import {
  homeContentSchema,
  storeSettingsSchema,
  type HomeContentInputRaw,
  type StoreSettingsInputRaw,
} from '@jmh/shared';
import {
  HomeContentModel,
  StoreSettingsModel,
  type HomeContentDoc,
  type StoreSettingsDoc,
} from '../../db/models';

/**
 * Defaults deliberately avoid inventing business details: no phone, address, delivery fees or
 * policies. Delivery stays off (pickup only) until an admin configures charges.
 */
export const DEFAULT_STORE_SETTINGS: StoreSettingsInputRaw = {
  storeName: 'Jigar Matka House',
  legalName: null,
  tagline: 'Handcrafted clay pots and timeless earthenware',
  phone: null,
  whatsappNumber: null,
  email: null,
  gstin: null,
  address: { line1: null, line2: null, city: null, state: null, pincode: null, mapUrl: null },
  openingHours: [],
  social: { instagram: null, facebook: null, youtube: null, x: null },
  delivery: {
    deliveryEnabled: false,
    pickupEnabled: true,
    flatCharge: 0,
    freeDeliveryThreshold: null,
    note: null,
  },
  policies: { shipping: '', returns: '', privacy: '', terms: '' },
  seo: {
    defaultTitle: 'Jigar Matka House — Handcrafted Clay Pots & Earthenware',
    defaultDescription:
      'Discover handcrafted clay matkas, earthen water pots, terracotta cookware, planters and decorative pottery from Jigar Matka House.',
  },
};

export const DEFAULT_HOME_CONTENT: HomeContentInputRaw = {
  hero: {
    eyebrow: 'Handcrafted earthenware',
    headline: 'માટીની ખુશ્બૂ, પરંપરાનો સ્પર્શ',
    headlineLang: 'gu',
    subheadline: 'Discover handcrafted clay pots and timeless earthenware for your home.',
    primaryCta: { label: 'Shop Products', href: '/shop' },
    secondaryCta: { label: 'Explore Our Craft', href: '/#craft' },
    image: null,
    video: { mp4Url: null, webmUrl: null, posterUrl: null },
  },
  story: {
    enabled: true,
    chapters: [
      {
        title: 'Shaped by hand',
        body: 'Every matka begins as a lump of river clay, centred and drawn up on the potter’s wheel.',
      },
      {
        title: 'Fired for strength',
        body: 'Sun-dried, then kiln-fired until the clay rings like a bell when tapped.',
      },
      {
        title: 'Naturally cool',
        body: 'Unglazed walls breathe, so water stored inside stays naturally cool and earthy.',
      },
      {
        title: 'Painted with tradition',
        body: 'Folk motifs — zigzags, dots and petals — are painted by hand, so no two pieces are identical.',
      },
    ],
  },
  craft: {
    enabled: true,
    title: 'The quiet beauty of clay',
    body: 'Clay is one of the oldest materials people have cooked, stored and celebrated with. It keeps water cool without electricity, lets food cook slowly and evenly, and returns to the earth at the end of its life. Our collection brings these everyday traditions into the modern home.',
    points: [
      {
        title: 'Natural material',
        body: 'Earthen clay without synthetic coatings on our unglazed pieces.',
      },
      {
        title: 'Handmade',
        body: 'Thrown, shaped and finished by hand, so each piece carries small variations.',
      },
      {
        title: 'Made to be used',
        body: 'Water pots, cookware and planters designed for daily life, not just display.',
      },
    ],
  },
  featuredCategoryIds: [],
  sections: {
    bestsellers: true,
    newArrivals: true,
    offers: true,
    recentlyViewed: true,
    visitStore: true,
  },
};

let settingsCache: { value: StoreSettingsDoc; expires: number } | null = null;
const SETTINGS_TTL_MS = 15_000;

export async function getStoreSettings(): Promise<StoreSettingsDoc> {
  if (settingsCache && settingsCache.expires > Date.now()) return settingsCache.value;
  let settings = await StoreSettingsModel.findById('store').lean<StoreSettingsDoc>();
  if (!settings) {
    const defaults = storeSettingsSchema.parse(DEFAULT_STORE_SETTINGS);
    settings = await StoreSettingsModel.findOneAndUpdate(
      { _id: 'store' },
      { $setOnInsert: { ...defaults, policiesUpdatedAt: null } },
      { upsert: true, returnDocument: 'after', lean: true },
    ).lean<StoreSettingsDoc>();
  }
  settingsCache = { value: settings!, expires: Date.now() + SETTINGS_TTL_MS };
  return settings!;
}

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

export async function getHomeContent(): Promise<HomeContentDoc> {
  let content = await HomeContentModel.findById('home').lean<HomeContentDoc>();
  if (!content) {
    const defaults = homeContentSchema.parse(DEFAULT_HOME_CONTENT);
    content = await HomeContentModel.findOneAndUpdate(
      { _id: 'home' },
      { $setOnInsert: { ...defaults, hero: { ...defaults.hero, image: null } } },
      { upsert: true, returnDocument: 'after' },
    ).lean<HomeContentDoc>();
  }
  return content!;
}

/** The business WhatsApp number: admin setting first, environment fallback second. */
export function resolveWhatsAppNumber(
  settings: StoreSettingsDoc,
  envNumber: string | null,
): string | null {
  return settings.whatsappNumber ?? envNumber ?? null;
}
