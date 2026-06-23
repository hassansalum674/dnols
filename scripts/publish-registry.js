#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "data", "public-profiles.json");
const publicDir = join(root, "public");
const agentsDir = join(publicDir, "agents");
const baseUrl = process.env.DNOLS_PUBLIC_BASE_URL || "https://dnols.com";

const raw = await readFile(sourcePath, "utf8");
const profiles = JSON.parse(raw);
const approvedProfiles = profiles.filter((profile) => ["approved", "published"].includes(profile.reviewStatus));
const listings = approvedProfiles.map(toPublicListing);

await mkdir(agentsDir, { recursive: true });
await writeJson(join(publicDir, "registry.json"), {
  registry: "Dnols",
  mode: "static-spark",
  generatedAt: new Date().toISOString(),
  positioning: "Business agent profiles for discovery, structured deal requests, and human-approved execution.",
  count: listings.length,
  manifests: listings
});
await writeJson(join(agentsDir, "index.json"), {
  registry: "Dnols",
  generatedAt: new Date().toISOString(),
  count: listings.length,
  agents: listings.map((listing) => ({
    namespace: listing.namespace,
    name: listing.name,
    url: `${baseUrl}/agents/${listing.namespace}.json`
  }))
});

for (const listing of listings) {
  await writeJson(join(agentsDir, `${listing.namespace}.json`), listing);
}

await writeFile(join(publicDir, "sitemap.xml"), buildSitemap(listings), "utf8");
await writeFile(join(publicDir, "robots.txt"), buildRobots(), "utf8");

console.log(`Published ${listings.length} public Dnols agent listing(s).`);

function toPublicListing(profile) {
  assertNoPrivateAgentFields(profile);
  const capability = profile.agentConfig?.capability || {};
  const rules = profile.agentConfig?.negotiationRules || {};
  const execution = profile.agentConfig?.execution || {};
  const escalation = profile.agentConfig?.escalationRules || {};
  const namespace = profile.namespace || `com.dnols.${slugify(profile.businessName)}`;
  const capabilityName = capability.name || profile.capabilityName || "Business service";
  const currency = firstValue(rules.currencies || profile.currency || "USD");

  assertPublicField(profile.businessName, `${namespace}: businessName`);
  assertPublicField(profile.domain, `${namespace}: domain`);
  assertPublicField(profile.region, `${namespace}: region`);
  assertPublicField(capabilityName, `${namespace}: capability`);

  return {
    schemaVersion: 1,
    namespace,
    name: profile.businessName,
    summary: profile.summary || capability.description || profile.capabilityDescription || "Business agent profile published by Dnols.",
    category: profile.category || "business-service",
    country: profile.country || "",
    region: profile.region || "",
    language: profile.agentConfig?.instructions?.language || profile.language || "English",
    domain: profile.domain,
    publicUrl: `https://${profile.domain}`,
    profileUrl: `${baseUrl}/agents/${namespace}.json`,
    tags: splitTags(capability.tags || profile.tags),
    trust: profile.trust || "self-attested",
    score: Number(profile.readinessScore) || 0,
    capabilities: [
      {
        id: slugify(capabilityName),
        name: capabilityName,
        description: capability.description || profile.capabilityDescription || profile.summary || "",
        tags: splitTags(capability.tags || profile.tags),
        inputNeeded: capability.inputNeeded || "Buyer request details, budget, region, and deadline.",
        outputProvided: capability.outputProvided || "Quote or approval-ready deal summary.",
        turnaround: capability.turnaround || "",
        priceModel: capability.priceModel || profile.pricingModel || "quote",
        requiresHumanConfirmation: capability.requiresConfirmation !== false
      }
    ],
    agentProfile: {
      status: "published",
      dealRequests: true,
      humanApprovalRequired: true,
      maxAutonomousDealValue: numberOrZero(rules.maxDealValue || profile.maxDealValue),
      approvalRequiredAbove: numberOrZero(rules.approvalRequiredAbove || profile.approvalRequiredAbove),
      currency,
      executionMode: execution.executionMode || profile.executionPreference || "manual"
    },
    execution: {
      mode: execution.executionMode || profile.executionPreference || "manual",
      protocol: profile.protocol || "rest",
      endpointMetadata: execution.endpoint || profile.endpoint ? "metadata_available" : "manual_only",
      authType: execution.authType || profile.authType || "none",
      requiresConfirmation: true
    },
    contact: {
      approvalEmail: escalation.approvalEmail || profile.approvalEmail || "",
      publicContact: profile.publicContact || profile.approvalEmail || ""
    }
  };
}

function assertNoPrivateAgentFields(profile) {
  const namespace = profile.namespace || profile.businessName || "profile";
  if (profile.agentConfig?.instructions?.privateRules) {
    throw new Error(`${namespace}: remove private agent rules before publishing.`);
  }
  if (profile.agentConfig?.negotiationRules?.minimumPrice) {
    throw new Error(`${namespace}: remove private minimum price before publishing.`);
  }
  if (profile.agentConfig?.execution?.headers || profile.agentConfig?.execution?.apiKey || profile.agentConfig?.execution?.token) {
    throw new Error(`${namespace}: remove execution secrets before publishing.`);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildSitemap(listings) {
  const urls = [
    "",
    "/onboarding",
    "/deals",
    "/approvals",
    "/registry.json",
    "/agents/index.json",
    ...listings.map((listing) => `/agents/${listing.namespace}.json`)
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((url) => `  <url>\n    <loc>${baseUrl}${url}</loc>\n  </url>`)
    .join("\n")}\n</urlset>\n`;
}

function buildRobots() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`;
}

function assertPublicField(value, label) {
  if (!String(value || "").trim()) {
    throw new Error(`Missing required public field: ${label}`);
  }
}

function numberOrZero(value) {
  return Number(value) || 0;
}

function firstValue(value) {
  return String(value || "USD").split(",")[0].trim() || "USD";
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "business";
}
