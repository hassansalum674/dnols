import { buildOnboardingResult } from "./manifest-builder.js";

const DEFAULT_TIMEOUT_MS = 8000;

export async function generateManifestFromWebsite(input = {}) {
  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl ?? input.url);
  const html = await fetchWebsiteHtml(websiteUrl);
  const profile = extractWebsiteProfile(websiteUrl, html);
  const result = buildOnboardingResult({
    publisherName: input.publisherName || profile.name,
    domain: profile.domain,
    namespace: input.namespace || namespaceFromDomain(profile.domain),
    contact: input.contact || profile.contact,
    serviceName: input.serviceName || profile.serviceName,
    summary: input.summary || profile.summary,
    capabilityId: input.capabilityId || capabilityIdFromText(profile.serviceName),
    capabilityDescription: input.capabilityDescription || profile.capabilityDescription,
    tags: input.tags || profile.tags.join(", "),
    baseUrl: input.baseUrl || profile.baseUrl,
    protocol: input.protocol || profile.protocol,
    authType: input.authType || "apiKey",
    pricingModel: input.pricingModel || profile.pricingModel
  });

  return {
    source: {
      websiteUrl,
      extracted: profile.extracted
    },
    ...result
  };
}

export function extractWebsiteProfile(websiteUrl, html) {
  const url = new URL(websiteUrl);
  const title = extractTitle(html);
  const description =
    extractMeta(html, "description") ||
    extractMeta(html, "og:description") ||
    firstHeading(html) ||
    `Agent-ready services from ${url.hostname}.`;
  const siteName = extractMeta(html, "og:site_name") || cleanTitle(title) || domainLabel(url.hostname);
  const headings = extractHeadings(html);
  const links = extractLinks(html, url);
  const apiLink = findLink(links, ["api", "developer", "docs", "documentation"]);
  const pricingLink = findLink(links, ["pricing", "plans"]);
  const contactLink = findLink(links, ["contact", "support", "sales"]);
  const tags = inferTags(`${title} ${description} ${headings.join(" ")}`);
  const serviceName = inferServiceName(siteName, headings, tags);

  return {
    name: siteName,
    domain: url.hostname.replace(/^www\./, ""),
    contact: inferContact(contactLink, url.hostname),
    serviceName,
    summary: sentence(description, `Agent-ready services from ${siteName}.`),
    capabilityDescription: inferCapabilityDescription(serviceName, description, apiLink),
    tags,
    baseUrl: apiLink?.href ?? `${url.origin.replace(/\/$/, "")}/api`,
    protocol: apiLink ? "rest" : "rest",
    pricingModel: pricingLink ? "subscription" : "quote",
    extracted: {
      title,
      description,
      headings: headings.slice(0, 8),
      relevantLinks: [apiLink, pricingLink, contactLink].filter(Boolean)
    }
  };
}

async function fetchWebsiteHtml(websiteUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(websiteUrl, {
      headers: {
        "User-Agent": "ACMRegistryBot/0.1 (+https://agent-discovery.example/bot)"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Website returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error("Website did not return HTML.");
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWebsiteUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("websiteUrl is required.");
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("websiteUrl must be HTTP or HTTPS.");
  }

  return url.toString();
}

function extractTitle(html) {
  return decodeEntities(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
}

function extractMeta(html, name) {
  const escaped = escapeRegex(name);
  return decodeEntities(
    matchFirst(
      html,
      new RegExp(
        `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        "i"
      )
    ) ||
      matchFirst(
        html,
        new RegExp(
          `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
          "i"
        )
      )
  );
}

function extractHeadings(html) {
  return Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((match) => decodeEntities(stripTags(match[1])).trim())
    .filter(Boolean)
    .slice(0, 20);
}

function firstHeading(html) {
  return extractHeadings(html)[0] ?? "";
}

function extractLinks(html, baseUrl) {
  return Array.from(html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
    .map((match) => {
      try {
        return {
          href: new URL(match[1], baseUrl).toString(),
          text: decodeEntities(stripTags(match[2])).trim()
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findLink(links, keywords) {
  return links.find((link) => {
    const haystack = `${link.href} ${link.text}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function inferTags(text) {
  const lower = text.toLowerCase();
  const tags = [];
  const rules = [
    ["procurement", ["procurement", "supplier", "sourcing", "rfq"]],
    ["logistics", ["logistics", "shipping", "freight", "delivery"]],
    ["security", ["security", "compliance", "soc 2", "risk"]],
    ["payments", ["payment", "billing", "checkout", "invoice"]],
    ["commerce", ["commerce", "store", "retail", "marketplace"]],
    ["analytics", ["analytics", "reporting", "dashboard", "insight"]],
    ["support", ["support", "ticket", "customer service", "helpdesk"]]
  ];

  for (const [tag, words] of rules) {
    if (words.some((word) => lower.includes(word))) {
      tags.push(tag);
    }
  }

  if (!tags.length) {
    tags.push("business-service");
  }

  tags.push("website-generated");
  return Array.from(new Set(tags));
}

function inferServiceName(siteName, headings, tags) {
  const candidate = headings.find((heading) => heading.length >= 8 && heading.length <= 90);
  if (candidate) {
    return candidate;
  }

  const primaryTag = tags[0]?.replace(/-/g, " ") ?? "business";
  return `${siteName} ${titleCase(primaryTag)} Service`;
}

function inferCapabilityDescription(serviceName, description, apiLink) {
  const apiHint = apiLink ? " Public API documentation was detected and used as the likely execution surface." : "";
  return sentence(
    `${serviceName}: ${description}${apiHint}`,
    `Let agents request ${serviceName} using the company's public service metadata.`
  );
}

function capabilityIdFromText(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "website-generated-capability"
  );
}

function namespaceFromDomain(domain) {
  return domain
    .split(".")
    .reverse()
    .map((part) => part.toLowerCase().replace(/[^a-z0-9-]/g, ""))
    .filter(Boolean)
    .join(".");
}

function inferContact(contactLink, hostname) {
  if (contactLink?.href?.startsWith("mailto:")) {
    return contactLink.href.replace("mailto:", "");
  }

  return `agents@${hostname.replace(/^www\./, "")}`;
}

function domainLabel(hostname) {
  return titleCase(hostname.replace(/^www\./, "").split(".")[0].replace(/-/g, " "));
}

function cleanTitle(value) {
  return String(value ?? "")
    .split(/[|–-]/)[0]
    .trim();
}

function sentence(value, fallback) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  if (clean.length >= 20) {
    return clean.slice(0, 600);
  }

  return fallback;
}

function stripTags(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function matchFirst(value, pattern) {
  return value.match(pattern)?.[1]?.trim() ?? "";
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
