/**
 * ILLUSTRATIVE DEMO CATALOGUE for development and demos only. Names, prices, sizes and stock are
 * sample values — replace them with the shop's real products through the admin panel. Images are
 * procedural renders (tools/pottery-renderer), not photographs of actual stock.
 */
export interface DemoCategory {
  slug: string;
  name: string;
  nameGu: string;
  description: string;
}

export interface DemoProduct {
  slug: string;
  category: string;
  name: string;
  nameGu?: string;
  shortDescription: string;
  description: string;
  price: number; // rupees
  salePrice?: number;
  stock: number;
  availability?: 'in_stock' | 'made_to_order';
  variants?: { name: string; price: number; salePrice?: number; stock: number }[];
  specs: {
    material?: string;
    finish?: string;
    color?: string;
    heightCm?: number;
    diameterCm?: number;
    capacityLitres?: number;
    weightKg?: number;
  };
  tags: string[];
  featured?: boolean;
  bestseller?: boolean;
}

export const DEMO_CATEGORIES: DemoCategory[] = [
  {
    slug: 'clay-matkas',
    name: 'Clay Matkas',
    nameGu: 'માટીના માટલાં',
    description: 'Round earthen pots that keep drinking water naturally cool.',
  },
  {
    slug: 'earthen-water-pots',
    name: 'Earthen Water Pots',
    nameGu: 'પાણીના માટીના વાસણ',
    description: 'Surahis, bottles and dispensers for everyday water.',
  },
  {
    slug: 'clay-cookware',
    name: 'Traditional Clay Cookware',
    nameGu: 'માટીના રસોઈ વાસણ',
    description: 'Handis, kadais and curd pots for slow, earthy cooking.',
  },
  {
    slug: 'decorative-pots',
    name: 'Decorative Pots',
    nameGu: 'સુશોભન માટલાં',
    description: 'Hand-painted vases and pots that bring craft into the home.',
  },
  {
    slug: 'planters',
    name: 'Planters',
    nameGu: 'કુંડા',
    description: 'Breathable terracotta planters for balconies, windows and gardens.',
  },
  {
    slug: 'handcrafted-pottery',
    name: 'Handcrafted Pottery',
    nameGu: 'હસ્તકલા માટીકામ',
    description: 'Kulhads, gullaks and small pieces made by hand.',
  },
  {
    slug: 'festival-collection',
    name: 'Diwali & Festival Collection',
    nameGu: 'દિવાળી અને તહેવાર સંગ્રહ',
    description: 'Diyas and festive pots for celebrations.',
  },
  {
    slug: 'other-products',
    name: 'Other Products',
    nameGu: 'અન્ય ઉત્પાદનો',
    description: 'Everyday household items available in store.',
  },
];

const CLAY = 'Unglazed terracotta';

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    slug: 'classic-clay-matka',
    category: 'clay-matkas',
    name: 'Classic Clay Matka with Lid',
    nameGu: 'ઢાંકણવાળું માટલું',
    shortDescription:
      'A round terracotta water pot with a fitted lid and hand-painted zigzag band.',
    description:
      'The everyday matka, made the traditional way. Its porous walls let a little water evaporate, which keeps the rest naturally cool — no electricity needed.\n\nThe cream zigzag and dot band is painted by hand, so every pot is slightly different.',
    price: 899,
    stock: 24,
    variants: [
      { name: '10 litres', price: 899, stock: 14 },
      { name: '15 litres', price: 1199, stock: 10 },
    ],
    specs: {
      material: CLAY,
      finish: 'Hand-painted band',
      color: 'Terracotta',
      heightCm: 32,
      diameterCm: 30,
      weightKg: 3.2,
    },
    tags: ['water', 'summer', 'matka', 'cooling'],
    featured: true,
    bestseller: true,
  },
  {
    slug: 'black-clay-matka',
    category: 'clay-matkas',
    name: 'Black Clay Matka',
    nameGu: 'કાળું માટલું',
    shortDescription: 'Burnished black clay with fine etched line bands.',
    description:
      'Fired in a smoky, oxygen-starved kiln to turn the clay deep charcoal, then burnished by hand for a soft sheen.',
    price: 1249,
    salePrice: 1099,
    stock: 8,
    specs: {
      material: 'Black clay',
      finish: 'Burnished',
      color: 'Charcoal black',
      capacityLitres: 12,
      heightCm: 31,
      diameterCm: 29,
    },
    tags: ['water', 'matka', 'black pottery'],
    featured: true,
  },
  {
    slug: 'plain-terracotta-matka',
    category: 'clay-matkas',
    name: 'Plain Terracotta Matka',
    shortDescription: 'An honest, unpainted matka showing the marks of the wheel.',
    description:
      'No paint, no glaze — just well-fired clay with visible throwing lines. Ideal for those who prefer the pure earthen look.',
    price: 599,
    stock: 30,
    specs: { material: CLAY, finish: 'Natural', capacityLitres: 10, heightCm: 30, diameterCm: 29 },
    tags: ['water', 'matka', 'plain'],
    bestseller: true,
  },
  {
    slug: 'matka-with-tap',
    category: 'earthen-water-pots',
    name: 'Clay Water Dispenser with Tap',
    nameGu: 'નળવાળું માટલું',
    shortDescription: 'A lidded water pot with a brass-tone tap for easy pouring.',
    description:
      'Pour cool water without dipping a ladle. The tap is fitted near the base and the lid keeps dust out.',
    price: 1399,
    salePrice: 1249,
    stock: 12,
    variants: [
      { name: '12 litres', price: 1399, salePrice: 1249, stock: 7 },
      { name: '18 litres', price: 1799, salePrice: 1599, stock: 5 },
    ],
    specs: { material: CLAY, finish: 'Painted band', heightCm: 38, diameterCm: 31 },
    tags: ['water', 'tap', 'dispenser'],
    featured: true,
    bestseller: true,
  },
  {
    slug: 'clay-surahi',
    category: 'earthen-water-pots',
    name: 'Clay Surahi',
    nameGu: 'સુરાહી',
    shortDescription: 'A long-necked water carafe with a dotted pattern.',
    description:
      'The narrow neck limits evaporation at the top while the round body keeps water cool. Fits neatly on a table or windowsill.',
    price: 449,
    stock: 20,
    specs: { material: CLAY, capacityLitres: 2, heightCm: 34, diameterCm: 18 },
    tags: ['water', 'surahi', 'carafe'],
    bestseller: true,
  },
  {
    slug: 'clay-water-bottle',
    category: 'earthen-water-pots',
    name: 'Clay Water Bottle',
    nameGu: 'માટીની બોટલ',
    shortDescription: 'A one-litre clay bottle with a clay cap.',
    description:
      'Carry the coolness of a matka to your desk. Rinse with water and let it dry upside down after use.',
    price: 349,
    stock: 26,
    specs: { material: CLAY, capacityLitres: 1, heightCm: 26 },
    tags: ['water', 'bottle'],
  },
  {
    slug: 'clay-handi-with-lid',
    category: 'clay-cookware',
    name: 'Clay Handi with Lid',
    nameGu: 'માટીની હાંડી',
    shortDescription: 'A wide cooking pot for slow-cooked dals, curries and biryani.',
    description:
      'Clay heats gently and evenly and holds moisture, which suits slow cooking. Season before first use and heat gradually on a low flame.',
    price: 749,
    stock: 15,
    variants: [
      { name: '1.5 litres', price: 749, stock: 9 },
      { name: '3 litres', price: 999, stock: 6 },
    ],
    specs: { material: CLAY, finish: 'Natural', color: 'Fired brown', diameterCm: 24 },
    tags: ['cookware', 'handi', 'slow cooking'],
    featured: true,
  },
  {
    slug: 'clay-kadai',
    category: 'clay-cookware',
    name: 'Clay Kadai with Handles',
    nameGu: 'માટીની કઢાઈ',
    shortDescription: 'A shallow, wok-shaped vessel with two loop handles.',
    description:
      'For sabzis, stir-fries and serving at the table. Heat slowly and avoid sudden temperature changes.',
    price: 699,
    salePrice: 629,
    stock: 10,
    specs: { material: CLAY, diameterCm: 28 },
    tags: ['cookware', 'kadai'],
  },
  {
    slug: 'clay-curd-pot',
    category: 'clay-cookware',
    name: 'Clay Curd Pot',
    nameGu: 'દહીંની હાંડલી',
    shortDescription: 'A small wide-mouthed pot for setting thick curd.',
    description: 'The porous clay draws away excess water, so curd sets thick and mildly sweet.',
    price: 199,
    stock: 40,
    specs: { material: CLAY, capacityLitres: 0.5 },
    tags: ['cookware', 'curd', 'dahi'],
    bestseller: true,
  },
  {
    slug: 'painted-decorative-vase',
    category: 'decorative-pots',
    name: 'Hand-painted Decorative Vase',
    shortDescription: 'A tall, slender vase with painted folk motifs.',
    description:
      'Display it on its own or with dried flowers. For decorative use — not watertight.',
    price: 1099,
    stock: 6,
    specs: { material: 'Terracotta, acrylic paint', heightCm: 45 },
    tags: ['decor', 'vase'],
    featured: true,
  },
  {
    slug: 'folk-art-round-pot',
    category: 'decorative-pots',
    name: 'Folk Art Round Pot',
    shortDescription: 'A round pot painted in terracotta, cream, black and mustard.',
    description:
      'Painted by hand in a traditional folk style. Each piece varies slightly in pattern and tone.',
    price: 1499,
    stock: 4,
    availability: 'made_to_order',
    specs: { material: 'Terracotta, natural pigments', heightCm: 26 },
    tags: ['decor', 'folk art'],
  },
  {
    slug: 'cylinder-planter-with-saucer',
    category: 'planters',
    name: 'Cylinder Planter with Saucer',
    nameGu: 'થાળીવાળું કુંડું',
    shortDescription: 'A clean-lined planter with a matching saucer and drainage hole.',
    description:
      'Terracotta breathes, so roots get air and excess moisture escapes — good for most indoor plants.',
    price: 549,
    stock: 18,
    variants: [
      { name: '6 inch', price: 549, stock: 10 },
      { name: '8 inch', price: 749, stock: 8 },
    ],
    specs: { material: CLAY, finish: 'Natural' },
    tags: ['planter', 'garden', 'indoor plants'],
    featured: true,
  },
  {
    slug: 'tapered-terracotta-planter',
    category: 'planters',
    name: 'Tapered Terracotta Planter',
    nameGu: 'માટીનું કુંડું',
    shortDescription: 'The classic flower pot with a thick rolled rim.',
    description: 'A garden essential. Includes a drainage hole.',
    price: 249,
    stock: 50,
    specs: { material: CLAY, heightCm: 18, diameterCm: 20 },
    tags: ['planter', 'garden'],
    bestseller: true,
  },
  {
    slug: 'bowl-planter',
    category: 'planters',
    name: 'Wide Bowl Planter',
    shortDescription: 'A shallow bowl for succulents, herbs and floating flowers.',
    description:
      'Low and wide — ideal for succulent arrangements or as an urli-style display with flowers.',
    price: 649,
    stock: 9,
    specs: { material: CLAY, heightCm: 12, diameterCm: 34 },
    tags: ['planter', 'succulents', 'urli'],
  },
  {
    slug: 'kulhad-set',
    category: 'handcrafted-pottery',
    name: 'Kulhad Set of 4',
    nameGu: 'કુલ્હડ (૪ નો સેટ)',
    shortDescription: 'Four handmade clay cups for chai, lassi or buttermilk.',
    description: 'Chai tastes earthier from a kulhad. Rinse with water before first use.',
    price: 299,
    salePrice: 249,
    stock: 35,
    specs: { material: CLAY, capacityLitres: 0.15 },
    tags: ['kulhad', 'chai', 'cups'],
    bestseller: true,
  },
  {
    slug: 'clay-gullak',
    category: 'handcrafted-pottery',
    name: 'Clay Gullak (Money Bank)',
    nameGu: 'ગલ્લો',
    shortDescription: 'A round money bank with a coin slot and top knob.',
    description: 'A traditional way to save coins — and a lovely gift for children.',
    price: 179,
    stock: 22,
    specs: { material: CLAY, heightCm: 14 },
    tags: ['gullak', 'gift', 'kids'],
  },
  {
    slug: 'diya-set',
    category: 'festival-collection',
    name: 'Clay Diya Set of 6',
    nameGu: 'માટીના દીવા (૬ નો સેટ)',
    shortDescription: 'Six handmade oil lamps for Diwali and every celebration.',
    description:
      'Fill with ghee or oil and a cotton wick. Soak in water for an hour before first use so the clay absorbs less oil.',
    price: 149,
    stock: 80,
    specs: { material: CLAY },
    tags: ['diwali', 'diya', 'festival'],
    featured: true,
    bestseller: true,
  },
  {
    slug: 'decorated-festive-kalash',
    category: 'festival-collection',
    name: 'Decorated Festive Kalash',
    nameGu: 'શણગારેલો કળશ',
    shortDescription: 'A festive pot painted in red, mustard-gold and white.',
    description: 'For pujas, weddings and festive decor. Painted by hand.',
    price: 699,
    salePrice: 599,
    stock: 12,
    specs: { material: 'Terracotta, acrylic paint', heightCm: 22 },
    tags: ['diwali', 'kalash', 'festival', 'puja'],
  },
];
