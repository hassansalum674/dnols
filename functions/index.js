import { onRequest } from "firebase-functions/v2/https";

const plans = {
  basic: {
    id: "basic",
    name: "Basic Verification",
    price: 199,
    interval: "month",
    description: "Up to 10 capabilities, standard verification, public registry listing."
  },
  professional: {
    id: "professional",
    name: "Professional Registry",
    price: 799,
    interval: "month",
    description: "Unlimited capabilities, priority listing, reputation monitoring."
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise Registry",
    price: 2499,
    interval: "month",
    description: "Private registry option, custom SLA, dedicated support."
  }
};

const seedManifests = [
  {
    namespace: "com.najd.procurement",
    name: "Najd Procurement Exchange",
    summary:
      "Verified procurement capabilities for agents that need to source vendors, request quotes, and check supplier compliance.",
    publisher: {
      name: "Najd Procurement Exchange",
      domain: "najd-procurement.example"
    },
    capabilities: [
      {
        id: "request-supplier-quotes",
        name: "Request Supplier Quotes",
        description: "Submit a sourcing request and receive ranked supplier quotes.",
        tags: ["procurement", "rfq", "suppliers"]
      }
    ],
    endpoints: {
      baseUrl: "https://api.najd-procurement.example",
      protocols: [{ type: "rest", url: "https://api.najd-procurement.example/v1" }]
    },
    trust: { verificationStatus: "verified" },
    score: { score: 96 }
  },
  {
    namespace: "com.orbit.logistics",
    name: "Orbit Logistics Network",
    summary:
      "Agent-ready logistics capabilities for quoting freight lanes and tracking delivery exceptions.",
    publisher: {
      name: "Orbit Logistics Network",
      domain: "orbit-logistics.example"
    },
    capabilities: [
      {
        id: "quote-freight-lane",
        name: "Quote Freight Lane",
        description: "Return freight pricing, carrier options, and delivery estimates.",
        tags: ["logistics", "freight", "pricing"]
      }
    ],
    endpoints: {
      baseUrl: "https://api.orbit-logistics.example",
      protocols: [{ type: "rest", url: "https://api.orbit-logistics.example/v1" }]
    },
    trust: { verificationStatus: "self-attested" },
    score: { score: 84 }
  },
  {
    namespace: "io.saasguard.security",
    name: "SaaSGuard Security Evidence API",
    summary:
      "Security and compliance evidence capabilities for agents evaluating vendors before procurement.",
    publisher: {
      name: "SaaSGuard",
      domain: "saasguard.example"
    },
    capabilities: [
      {
        id: "fetch-vendor-evidence",
        name: "Fetch Vendor Evidence",
        description: "Retrieve compliance evidence and security questionnaire answers.",
        tags: ["security", "compliance", "vendor-risk"]
      }
    ],
    endpoints: {
      baseUrl: "https://api.saasguard.example",
      protocols: [
        { type: "rest", url: "https://api.saasguard.example/v1" },
        { type: "mcp", url: "https://mcp.saasguard.example" },
        { type: "a2a", url: "https://agents.saasguard.example/a2a" }
      ]
    },
    trust: { verificationStatus: "verified" },
    score: { score: 100 }
  }
];

export const api = onRequest({ cors: true, region: "us-central1" }, async (request, response) => {
  try {
    const url = new URL(request.url, originFromRequest(request));
    const path = url.pathname;

    if (request.method === "GET" && path === "/api/plans") {
      json(response, 200, {
        plans: Object.values(plans).map((plan) => ({
          ...plan,
          checkoutConfigured: Boolean(paymentLinkFor(plan.id))
        }))
      });
      return;
    }

    if (request.method === "POST" && path === "/api/checkout") {
      const body = request.body ?? {};
      const plan = plans[body.planId];
      if (!plan) {
        json(response, 404, {
          ok: false,
          error: "unknown_plan"
        });
        return;
      }

      json(response, 200, {
        ok: true,
        plan,
        checkoutUrl:
          paymentLinkFor(plan.id) ??
          `${originFromRequest(request)}/checkout-demo.html?plan=${encodeURIComponent(plan.id)}`,
        mode: paymentLinkFor(plan.id) ? "stripe_payment_link" : "demo"
      });
      return;
    }

    if (request.method === "POST" && path === "/api/build-manifest") {
      const result = buildListing(request.body ?? {});
      json(response, result.accepted ? 200 : 422, result);
      return;
    }

    if (request.method === "POST" && path === "/api/generate-from-website") {
      try {
        const result = await generateFromWebsite(request.body ?? {});
        json(response, result.accepted ? 200 : 422, result);
      } catch (error) {
        json(response, 422, {
          accepted: false,
          message: error instanceof Error ? error.message : "Could not generate from website."
        });
      }
      return;
    }

    if (request.method === "GET" && path === "/api/manifests") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const protocol = url.searchParams.get("protocol");
      const results = seedManifests.filter((manifest) => {
        const text = JSON.stringify(manifest).toLowerCase();
        const matchesQuery = !query || text.includes(query);
        const matchesProtocol =
          !protocol || manifest.endpoints.protocols.some((item) => item.type === protocol);
        return matchesQuery && matchesProtocol;
      });
      json(response, 200, { count: results.length, results });
      return;
    }

    if (request.method === "GET" && path.startsWith("/api/manifests/")) {
      const namespace = decodeURIComponent(path.replace("/api/manifests/", ""));
      const manifest = seedManifests.find((item) => item.namespace === namespace);
      json(response, manifest ? 200 : 404, manifest ?? { error: "not_found" });
      return;
    }

    if (
      request.method === "GET" &&
      (path === "/registry.json" || path === "/.well-known/agent-registry.json")
    ) {
      const origin = originFromRequest(request);
      json(response, 200, {
        registry: "Dnols",
        generatedAt: new Date().toISOString(),
        count: seedManifests.length,
        manifests: seedManifests.map((manifest) => ({
          namespace: manifest.namespace,
          name: manifest.name,
          summary: manifest.summary,
          tags: manifest.capabilities.flatMap((capability) => capability.tags),
          trust: manifest.trust.verificationStatus,
          score: manifest.score.score,
          urls: {
            manifest: `${origin}/api/manifests/${encodeURIComponent(manifest.namespace)}`,
            wellKnown: `${origin}/.well-known/agent-capabilities.json?namespace=${encodeURIComponent(
              manifest.namespace
            )}`
          }
        }))
      });
      return;
    }

    if (request.method === "GET" && path === "/robots.txt") {
      text(
        response,
        200,
        `User-agent: *\nAllow: /\n\nSitemap: ${originFromRequest(request)}/sitemap.xml\n`
      );
      return;
    }

    if (request.method === "GET" && path === "/sitemap.xml") {
      const origin = originFromRequest(request);
      response
        .status(200)
        .type("application/xml")
        .send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc></url>
  <url><loc>${origin}/onboarding</loc></url>
  <url><loc>${origin}/registry.json</loc></url>
</urlset>
`);
      return;
    }

    json(response, 404, {
      error: "not_found"
    });
  } catch (error) {
    json(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unexpected error"
    });
  }
});

function buildListing(input) {
  const manifest = buildManifest(input);
  const validation = validateManifest(manifest);
  const score = scoreManifest(manifest);
  return {
    accepted: validation.valid,
    validation,
    score,
    manifest,
    nextSteps: validation.valid
      ? [
          "Listing package is ready.",
          "Publish it at your domain's /.well-known/agent-capabilities.json URL.",
          "Submit your domain for verification."
        ]
      : ["Fix the required fields and submit again."]
  };
}

function buildManifest(input) {
  const domain = clean(input.domain);
  const capabilityId = clean(input.capabilityId);
  const baseUrl = clean(input.baseUrl).replace(/\/$/, "");
  return {
    acmVersion: "0.1.0",
    namespace: clean(input.namespace),
    name: clean(input.serviceName),
    summary: clean(input.summary),
    publisher: {
      name: clean(input.publisherName),
      domain,
      did: domain ? `did:web:${domain}` : "",
      contact: clean(input.contact)
    },
    capabilities: [
      {
        id: capabilityId,
        name: clean(input.serviceName),
        description: clean(input.capabilityDescription),
        tags: clean(input.tags)
          .split(",")
          .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
          .filter(Boolean),
        inputSchema: {
          type: "object",
          required: ["request"],
          properties: {
            request: { type: "string" }
          }
        },
        outputSchema: {
          type: "object",
          required: ["result"],
          properties: {
            result: { type: "string" }
          }
        },
        execution: {
          method: "POST",
          path: `/v1/capabilities/${capabilityId}/invoke`,
          mode: clean(input.pricingModel) === "quote" ? "quote" : "workflow",
          requiresConfirmation: clean(input.pricingModel) !== "free",
          idempotencyKeyRequired: clean(input.pricingModel) !== "free"
        }
      }
    ],
    pricing: {
      model: clean(input.pricingModel) || "usage",
      currency: "USD",
      plans: [{ name: "Default plan", price: 0, unit: "request" }]
    },
    trust: {
      verificationStatus: "self-attested",
      credentials: [],
      reputation: { score: 0, transactionCount: 0, disputeRate: 0 }
    },
    endpoints: {
      baseUrl,
      manifestUrl: domain ? `https://${domain}/.well-known/agent-capabilities.json` : "",
      protocols: [{ type: clean(input.protocol) || "rest", url: baseUrl }],
      auth: { type: clean(input.authType) || "apiKey" },
      rateLimits: { requestsPerMinute: 60 },
      sla: { availability: 99.5, p95LatencyMs: 500 }
    }
  };
}

async function generateFromWebsite(input) {
  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl);
  const html = await fetchHtml(websiteUrl);
  const url = new URL(websiteUrl);
  const title = extractTitle(html) || titleCase(url.hostname.replace(/^www\./, "").split(".")[0]);
  const description =
    extractMeta(html, "description") ||
    firstHeading(html) ||
    `Business services from ${title}.`;
  const domain = url.hostname.replace(/^www\./, "");
  return buildListing({
    publisherName: title,
    domain,
    namespace: domain.split(".").reverse().join("."),
    contact: `agents@${domain}`,
    serviceName: `${title} Agent Listing`,
    summary: description,
    capabilityId: slug(`${title} service`),
    capabilityDescription: description,
    tags: inferTags(`${title} ${description}`).join(", "),
    baseUrl: `${url.origin}/api`,
    protocol: "rest",
    authType: "apiKey",
    pricingModel: "quote"
  });
}

async function fetchHtml(websiteUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(websiteUrl, {
      headers: { "User-Agent": "DnolsBot/0.1 (+https://dnols.com)" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest.namespace) errors.push("Listing ID is required.");
  if (!manifest.publisher.name) errors.push("Business name is required.");
  if (!manifest.publisher.domain) errors.push("Website domain is required.");
  if (!manifest.name) errors.push("Service name is required.");
  if (!manifest.summary || manifest.summary.length < 20)
    errors.push("Short business summary must be at least 20 characters.");
  if (!manifest.capabilities[0].id) errors.push("Action ID is required.");
  if (!manifest.capabilities[0].description || manifest.capabilities[0].description.length < 20)
    errors.push("Agent request description must be at least 20 characters.");
  if (!manifest.capabilities[0].tags.length) errors.push("Search keywords are required.");
  if (!manifest.endpoints.baseUrl) errors.push("System link is required.");
  return { valid: errors.length === 0, errors, warnings: [] };
}

function scoreManifest(manifest) {
  let score = 55;
  if (manifest.endpoints.baseUrl) score += 10;
  if (manifest.capabilities[0].execution) score += 10;
  if (manifest.publisher.did) score += 8;
  if (manifest.pricing.model) score += 7;
  if (manifest.capabilities[0].tags.length) score += 5;
  return { score: Math.min(100, score), grade: score >= 90 ? "A" : "B" };
}

function paymentLinkFor(planId) {
  const key = {
    basic: "STRIPE_BASIC_PAYMENT_LINK",
    professional: "STRIPE_PRO_PAYMENT_LINK",
    enterprise: "STRIPE_ENTERPRISE_PAYMENT_LINK"
  }[planId];
  return key ? process.env[key] : undefined;
}

function normalizeWebsiteUrl(value) {
  const raw = clean(value);
  if (!raw) throw new Error("Website URL is required.");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function extractTitle(html) {
  return decode(match(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).split(/[|–-]/)[0].trim();
}

function extractMeta(html, name) {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return decode(match(html, pattern));
}

function firstHeading(html) {
  return decode(match(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, " "));
}

function inferTags(textValue) {
  const lower = textValue.toLowerCase();
  const tags = [];
  if (/supplier|procurement|quote|rfq/.test(lower)) tags.push("procurement");
  if (/logistics|freight|delivery|shipping/.test(lower)) tags.push("logistics");
  if (/security|compliance|risk|vendor/.test(lower)) tags.push("vendor-trust");
  if (!tags.length) tags.push("business-service");
  return [...new Set([...tags, "website-generated"])];
}

function match(value, pattern) {
  return value.match(pattern)?.[1]?.trim() ?? "";
}

function decode(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function slug(value) {
  return (
    clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "business-service"
  );
}

function titleCase(value) {
  return String(value)
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function originFromRequest(request) {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const proto = request.headers["x-forwarded-proto"] ?? "https";
  return `${proto}://${host}`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function json(response, status, payload) {
  response.status(status).json(payload);
}

function text(response, status, payload) {
  response.status(status).type("text/plain").send(payload);
}
