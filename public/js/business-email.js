export const BUSINESS_EMAIL_ERROR = "Use a business email address.";

export const PERSONAL_EMAIL_DOMAINS = Object.freeze([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "email.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "yandex.ru",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.com",
  "mail.ru",
  "inbox.com",
  "qq.com",
  "163.com",
  "126.com",
  "rediffmail.com"
]);

const PERSONAL_DOMAIN_SET = new Set(PERSONAL_EMAIL_DOMAINS);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function getEmailDomain(value) {
  const email = normalizeEmail(value);
  const atIndex = email.lastIndexOf("@");
  return atIndex === -1 ? "" : email.slice(atIndex + 1);
}

export function isPersonalEmailDomain(domain) {
  return PERSONAL_DOMAIN_SET.has(String(domain ?? "").trim().toLowerCase());
}

export function validateBusinessEmail(value) {
  const email = normalizeEmail(value);
  const domain = getEmailDomain(email);
  const labels = domain.split(".");

  if (!EMAIL_PATTERN.test(email)) {
    return { valid: false, email, domain, message: BUSINESS_EMAIL_ERROR };
  }

  if (
    labels.length < 2 ||
    labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label)) ||
    labels.at(-1).length < 2 ||
    isPersonalEmailDomain(domain)
  ) {
    return { valid: false, email, domain, message: BUSINESS_EMAIL_ERROR };
  }

  return { valid: true, email, domain };
}

export function assertBusinessEmail(value) {
  const validation = validateBusinessEmail(value);
  if (!validation.valid) {
    throw new Error(BUSINESS_EMAIL_ERROR);
  }
  return validation;
}
