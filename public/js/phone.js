export const EAST_AFRICAN_COUNTRIES = Object.freeze([
  { name: "Kenya", iso2: "KE", countryCode: "254" },
  { name: "Tanzania", iso2: "TZ", countryCode: "255" },
  { name: "Uganda", iso2: "UG", countryCode: "256" },
  { name: "Rwanda", iso2: "RW", countryCode: "250" },
  { name: "Burundi", iso2: "BI", countryCode: "257" },
  { name: "Ethiopia", iso2: "ET", countryCode: "251" },
  { name: "South Sudan", iso2: "SS", countryCode: "211" },
  { name: "Somalia", iso2: "SO", countryCode: "252" },
  { name: "Democratic Republic of Congo", iso2: "CD", countryCode: "243" }
]);

export const EAST_AFRICAN_PHONE_ERROR =
  "Enter an East African phone number with a supported country code, e.g. +254712345678.";

const COUNTRY_BY_CODE = new Map(EAST_AFRICAN_COUNTRIES.map((country) => [country.countryCode, country]));
const COUNTRY_CODES = EAST_AFRICAN_COUNTRIES.map((country) => country.countryCode).sort((a, b) => b.length - a.length);

export function normalizeEastAfricaPhone(value, options = {}) {
  const raw = String(value ?? "").trim();
  const preferredCountry = resolveEastAfricaCountry(options.countryCode || options.phoneCountryCode || options.country);
  const digits = raw.replace(/^00/, "").replace(/\D/g, "");

  if (!digits) {
    return invalidPhone(raw, preferredCountry);
  }

  const matchedCode = COUNTRY_CODES.find((code) => digits.startsWith(code));
  const country = matchedCode ? COUNTRY_BY_CODE.get(matchedCode) : preferredCountry;
  if (!country) {
    return invalidPhone(raw, preferredCountry);
  }

  const nationalNumber = matchedCode
    ? digits.slice(country.countryCode.length)
    : digits.replace(/^0+/, "");
  const e164Digits = `${country.countryCode}${nationalNumber}`;

  if (
    !nationalNumber ||
    nationalNumber.length < 6 ||
    nationalNumber.length > 12 ||
    e164Digits.length > 15
  ) {
    return invalidPhone(raw, country);
  }

  return {
    valid: true,
    input: raw,
    phone: `+${e164Digits}`,
    e164: `+${e164Digits}`,
    digits: e164Digits,
    country: country.name,
    countryIso2: country.iso2,
    countryCode: country.countryCode,
    nationalNumber
  };
}

export function validateEastAfricaPhone(value, options = {}) {
  return normalizeEastAfricaPhone(value, options);
}

export function resolveEastAfricaCountry(value) {
  const normalized = String(value ?? "").trim().replace(/^\+/, "").toLowerCase();
  if (!normalized) return null;
  return EAST_AFRICAN_COUNTRIES.find(
    (country) =>
      country.countryCode === normalized ||
      country.iso2.toLowerCase() === normalized ||
      country.name.toLowerCase() === normalized
  ) || null;
}

function invalidPhone(input, country = null) {
  return {
    valid: false,
    input,
    phone: "",
    e164: "",
    country: country?.name || "",
    countryIso2: country?.iso2 || "",
    countryCode: country?.countryCode || "",
    nationalNumber: "",
    message: EAST_AFRICAN_PHONE_ERROR
  };
}
