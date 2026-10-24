/**
 * All monetary amounts are stored and transported as integer paise (₹1 = 100 paise)
 * so totals never suffer from floating-point rounding.
 */
export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError('Amount must be a finite number');
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

export function isValidPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const wholeRupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const withPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats paise as Indian rupees, e.g. 123456 → "₹1,234.56", 150000 → "₹1,500". */
export function formatINR(paise: Paise): string {
  return paise % 100 === 0 ? wholeRupees.format(paise / 100) : withPaise.format(paise / 100);
}

/** Percentage saved when moving from `price` to `salePrice`, rounded down to a whole percent. */
export function discountPercent(price: Paise, salePrice: Paise | null | undefined): number | null {
  if (salePrice == null || price <= 0 || salePrice >= price) return null;
  return Math.floor(((price - salePrice) / price) * 100);
}
