/**
 * Indian mobile numbers: 10 digits starting 6–9, optionally prefixed with +91, 91 or 0.
 * Returns the bare 10-digit number, or null when the input is not a valid mobile.
 */
export function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '');
  const match = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  return match ? match[1]! : null;
}

export function isValidIndianMobile(input: string): boolean {
  return normalizeIndianMobile(input) !== null;
}

/** "9876543210" → "+91 98765 43210" */
export function formatIndianMobile(tenDigits: string): string {
  if (!/^\d{10}$/.test(tenDigits)) return tenDigits;
  return `+91 ${tenDigits.slice(0, 5)} ${tenDigits.slice(5)}`;
}

/** "9876543210" → "+91 98•••••210" for showing on public pages. */
export function maskIndianMobile(tenDigits: string): string {
  if (!/^\d{10}$/.test(tenDigits)) return '•••';
  return `+91 ${tenDigits.slice(0, 2)}•••••${tenDigits.slice(7)}`;
}

/**
 * Normalises a WhatsApp number to the international digits-only form wa.me expects
 * (country code + number, no plus sign, spaces or punctuation). Bare 10-digit Indian
 * mobiles get the 91 country code.
 */
export function normalizeWhatsAppNumber(input: string): string | null {
  const indian = normalizeIndianMobile(input);
  if (indian) return `91${indian}`;
  const digits = input
    .replace(/[\s\-().]/g, '')
    .replace(/^\+/, '')
    .replace(/^00/, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return digits;
}

export function isValidPincode(input: string): boolean {
  return /^[1-9]\d{5}$/.test(input.trim());
}
