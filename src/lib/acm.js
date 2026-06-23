import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const REQUIRED_TOP_LEVEL_FIELDS = [
  "acmVersion",
  "namespace",
  "publisher",
  "capabilities",
  "endpoints"
];

const NAMESPACE_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const DID_PATTERN = /^did:[a-z0-9]+:.+/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const URI_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function readJsonFile(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function loadManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && extname(entry.name) === ".json")
    .map((entry) => join(directory, entry.name))
    .sort();

  return Promise.all(
    files.map(async (filePath) => {
      const manifest = await readJsonFile(filePath);
      return {
        filePath,
        manifest,
        validation: validateManifest(manifest),
        score: scoreManifest(manifest)
      };
    })
  );
}

export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(manifest)) {
    return {
      valid: false,
      errors: ["Manifest must be a JSON object."],
      warnings
    };
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (manifest[field] === undefined) {
      errors.push(`Missing required field: ${field}.`);
    }
  }

  if (!/^0\.1\.\d+$/.test(valueAsString(manifest.acmVersion))) {
    errors.push("acmVersion must match 0.1.x.");
  }

  if (!NAMESPACE_PATTERN.test(valueAsString(manifest.namespace))) {
    errors.push("namespace must use reverse-DNS format, for example com.acme.service.");
  }

  if (manifest.name !== undefined && !isNonEmptyString(manifest.name, 2)) {
    errors.push("name must be a string with at least 2 characters.");
  }

  if (manifest.summary !== undefined && !isNonEmptyString(manifest.summary, 20)) {
    errors.push("summary must be a string with at least 20 characters.");
  }

  validatePublisher(manifest.publisher, errors, warnings);
  validateCapabilities(manifest.capabilities, errors, warnings);
  validatePricing(manifest.pricing, errors, warnings);
  validateTrust(manifest.trust, errors, warnings);
  validateEndpoints(manifest.endpoints, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function scoreManifest(manifest) {
  const validation = validateManifest(manifest);
  let score = validation.valid ? 55 : Math.max(0, 35 - validation.errors.length * 7);
  const reasons = [];

  if (manifest.summary) {
    score += 5;
    reasons.push("Includes LLM-readable service summary.");
  }

  if (manifest.publisher?.did) {
    score += 7;
    reasons.push("Provides DID-based publisher identity.");
  }

  if (manifest.trust?.verificationStatus === "verified") {
    score += 10;
    reasons.push("Publisher is marked verified.");
  } else if (manifest.trust?.verificationStatus === "self-attested") {
    score += 4;
    reasons.push("Publisher includes self-attested trust metadata.");
  }

  if (manifest.trust?.credentials?.length) {
    score += 6;
    reasons.push("Links external trust credentials.");
  }

  if (manifest.trust?.reputation?.score !== undefined) {
    score += 5;
    reasons.push("Includes runtime reputation data.");
  }

  if (manifest.pricing?.model) {
    score += 5;
    reasons.push("Exposes pricing logic for agent evaluation.");
  }

  const protocols = manifest.endpoints?.protocols ?? [];
  if (protocols.some((protocol) => protocol.type === "mcp")) {
    score += 4;
    reasons.push("Publishes an MCP endpoint.");
  }

  if (protocols.some((protocol) => protocol.type === "a2a")) {
    score += 4;
    reasons.push("Publishes an A2A endpoint.");
  }

  if (manifest.endpoints?.sla) {
    score += 4;
    reasons.push("Includes SLA metadata.");
  }

  const hasExamples = (manifest.capabilities ?? []).some(
    (capability) => capability.examples?.length
  );
  if (hasExamples) {
    score += 5;
    reasons.push("Includes example invocations.");
  }

  const hasExecutionMetadata = (manifest.capabilities ?? []).some(
    (capability) => capability.execution?.path && capability.execution?.method
  );
  if (hasExecutionMetadata) {
    score += 5;
    reasons.push("Includes executable API call metadata.");
  }

  const cappedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: cappedScore,
    grade: gradeScore(cappedScore),
    reasons,
    validation
  };
}

export function summarizeManifest(manifest) {
  const capabilities = manifest.capabilities ?? [];
  const tags = Array.from(
    new Set(capabilities.flatMap((capability) => capability.tags ?? []))
  ).sort();

  return {
    namespace: manifest.namespace,
    name: manifest.name,
    summary: manifest.summary,
    publisher: manifest.publisher,
    capabilityCount: capabilities.length,
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      tags: capability.tags ?? []
    })),
    tags,
    pricing: manifest.pricing,
    trust: manifest.trust,
    endpoints: manifest.endpoints,
    score: scoreManifest(manifest)
  };
}

export function searchManifests(records, query = "", filters = {}) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  return records
    .filter((record) => record.validation.valid)
    .map((record) => {
      const manifest = record.manifest;
      const searchable = [
        manifest.namespace,
        manifest.name,
        manifest.summary,
        manifest.publisher?.name,
        ...(manifest.capabilities ?? []).flatMap((capability) => [
          capability.id,
          capability.name,
          capability.description,
          ...(capability.tags ?? [])
        ])
      ]
        .join(" ")
        .toLowerCase();

      const protocols = new Set(
        (manifest.endpoints?.protocols ?? []).map((protocol) => protocol.type)
      );
      const trustStatus = manifest.trust?.verificationStatus ?? "unverified";
      const tagSet = new Set(
        (manifest.capabilities ?? []).flatMap((capability) => capability.tags ?? [])
      );

      if (filters.protocol && !protocols.has(filters.protocol)) {
        return null;
      }

      if (filters.verified === "true" && trustStatus !== "verified") {
        return null;
      }

      if (filters.tag && !tagSet.has(filters.tag)) {
        return null;
      }

      const matchScore = terms.reduce((total, term) => {
        if (!searchable.includes(term)) {
          return total;
        }

        if ((manifest.namespace ?? "").toLowerCase().includes(term)) {
          return total + 12;
        }

        if ((manifest.name ?? "").toLowerCase().includes(term)) {
          return total + 10;
        }

        if (Array.from(tagSet).some((tag) => tag.includes(term))) {
          return total + 8;
        }

        return total + 4;
      }, 0);

      if (terms.length > 0 && matchScore === 0) {
        return null;
      }

      return {
        ...summarizeManifest(manifest),
        matchScore,
        registryScore: record.score.score
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const scoreDelta = b.matchScore - a.matchScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return b.registryScore - a.registryScore;
    });
}

export function toMcpServerManifest(manifest) {
  return {
    name: manifest.namespace,
    displayName: manifest.name,
    description: manifest.summary,
    tools: (manifest.capabilities ?? []).map((capability) => ({
      name: capability.id,
      description: capability.description,
      inputSchema: capability.inputSchema
    })),
    transport: {
      type: "http",
      url:
        manifest.endpoints?.protocols?.find((protocol) => protocol.type === "mcp")?.url ??
        manifest.endpoints?.baseUrl
    },
    trust: manifest.trust
  };
}

export function toA2aAgentCard(manifest) {
  return {
    name: manifest.name,
    description: manifest.summary,
    url:
      manifest.endpoints?.protocols?.find((protocol) => protocol.type === "a2a")?.url ??
      manifest.endpoints?.baseUrl,
    provider: {
      organization: manifest.publisher?.name,
      url: `https://${manifest.publisher?.domain}`
    },
    skills: (manifest.capabilities ?? []).map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      tags: capability.tags ?? [],
      inputModes: capability.mediaTypes ?? ["application/json"],
      outputModes: ["application/json"]
    })),
    security: manifest.endpoints?.auth
  };
}

function validatePublisher(publisher, errors, warnings) {
  if (!isPlainObject(publisher)) {
    errors.push("publisher must be an object.");
    return;
  }

  if (!isNonEmptyString(publisher.name, 2)) {
    errors.push("publisher.name is required.");
  }

  if (!DOMAIN_PATTERN.test(valueAsString(publisher.domain))) {
    errors.push("publisher.domain must be a valid domain.");
  }

  if (publisher.did && !DID_PATTERN.test(publisher.did)) {
    errors.push("publisher.did must be a valid DID.");
  }

  if (!publisher.did) {
    warnings.push("publisher.did is recommended for cryptographic identity.");
  }

  if (publisher.contact && !EMAIL_PATTERN.test(publisher.contact)) {
    errors.push("publisher.contact must be an email address.");
  }
}

function validateCapabilities(capabilities, errors, warnings) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    errors.push("capabilities must contain at least one capability.");
    return;
  }

  const ids = new Set();
  for (const [index, capability] of capabilities.entries()) {
    const prefix = `capabilities[${index}]`;
    if (!isPlainObject(capability)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    if (!/^[a-z][a-z0-9-]{2,80}$/.test(valueAsString(capability.id))) {
      errors.push(`${prefix}.id must be kebab-case and at least 3 characters.`);
    }

    if (ids.has(capability.id)) {
      errors.push(`${prefix}.id duplicates another capability.`);
    }
    ids.add(capability.id);

    if (!isNonEmptyString(capability.name, 2)) {
      errors.push(`${prefix}.name is required.`);
    }

    if (!isNonEmptyString(capability.description, 20)) {
      errors.push(`${prefix}.description must be at least 20 characters.`);
    }

    if (!Array.isArray(capability.tags) || capability.tags.length === 0) {
      errors.push(`${prefix}.tags must include at least one semantic tag.`);
    }

    if (!isPlainObject(capability.inputSchema)) {
      errors.push(`${prefix}.inputSchema must be a JSON Schema object.`);
    }

    if (!isPlainObject(capability.outputSchema)) {
      errors.push(`${prefix}.outputSchema must be a JSON Schema object.`);
    }

    if (!capability.examples?.length) {
      warnings.push(`${prefix}.examples helps agents understand invocation intent.`);
    }

    if (!capability.execution) {
      warnings.push(`${prefix}.execution is recommended so agents can invoke the capability.`);
    }
  }
}

function validatePricing(pricing, errors, warnings) {
  if (!pricing) {
    warnings.push("pricing is recommended so agents can compare options.");
    return;
  }

  if (!["free", "subscription", "usage", "quote"].includes(pricing.model)) {
    errors.push("pricing.model must be free, subscription, usage, or quote.");
  }

  if (pricing.currency && !/^[A-Z]{3}$/.test(pricing.currency)) {
    errors.push("pricing.currency must be an ISO-style 3 letter currency code.");
  }
}

function validateTrust(trust, errors, warnings) {
  if (!trust) {
    warnings.push("trust metadata is recommended for autonomous commerce.");
    return;
  }

  if (
    trust.verificationStatus &&
    !["unverified", "self-attested", "verified"].includes(trust.verificationStatus)
  ) {
    errors.push("trust.verificationStatus is invalid.");
  }

  if (trust.credentials) {
    for (const [index, credential] of trust.credentials.entries()) {
      if (!credential.type || !credential.issuer || !URI_PATTERN.test(valueAsString(credential.url))) {
        errors.push(`trust.credentials[${index}] must include type, issuer, and URL.`);
      }
    }
  }
}

function validateEndpoints(endpoints, errors, warnings) {
  if (!isPlainObject(endpoints)) {
    errors.push("endpoints must be an object.");
    return;
  }

  if (!URI_PATTERN.test(valueAsString(endpoints.baseUrl))) {
    errors.push("endpoints.baseUrl must be an HTTP(S) URL.");
  }

  if (endpoints.manifestUrl && !URI_PATTERN.test(endpoints.manifestUrl)) {
    errors.push("endpoints.manifestUrl must be an HTTP(S) URL.");
  }

  if (!endpoints.manifestUrl) {
    warnings.push("endpoints.manifestUrl is recommended for well-known discovery.");
  }

  if (endpoints.protocols) {
    for (const [index, protocol] of endpoints.protocols.entries()) {
      if (!["rest", "mcp", "a2a"].includes(protocol.type)) {
        errors.push(`endpoints.protocols[${index}].type is invalid.`);
      }

      if (!URI_PATTERN.test(valueAsString(protocol.url))) {
        errors.push(`endpoints.protocols[${index}].url must be an HTTP(S) URL.`);
      }
    }
  }

  if (!endpoints.auth?.type) {
    warnings.push("endpoints.auth.type is recommended.");
  }
}

function gradeScore(score) {
  if (score >= 90) {
    return "A";
  }

  if (score >= 80) {
    return "B";
  }

  if (score >= 70) {
    return "C";
  }

  if (score >= 60) {
    return "D";
  }

  return "F";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value, minLength = 1) {
  return typeof value === "string" && value.trim().length >= minLength;
}

function valueAsString(value) {
  return typeof value === "string" ? value : "";
}
