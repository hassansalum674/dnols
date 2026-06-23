export function buildInvocationPlan(manifest, capabilityId, input = {}, options = {}) {
  const capability = (manifest.capabilities ?? []).find((item) => item.id === capabilityId);
  if (!capability) {
    return {
      ok: false,
      statusCode: 404,
      error: "capability_not_found",
      message: `Capability ${capabilityId} was not found on ${manifest.namespace}.`
    };
  }

  const missingFields = findMissingRequiredFields(capability.inputSchema, input);
  if (missingFields.length > 0) {
    return {
      ok: false,
      statusCode: 422,
      error: "invalid_input",
      message: "Input is missing required fields.",
      missingFields
    };
  }

  const execution = capability.execution ?? defaultExecutionFor(capability);
  const endpoint = new URL(execution.path, manifest.endpoints.baseUrl).toString();
  const auth = manifest.endpoints?.auth ?? { type: "none" };
  const liveExecutionAllowed = options.allowLiveExecution === true;
  const isExampleDomain = manifest.publisher?.domain?.endsWith(".example");

  return {
    ok: true,
    namespace: manifest.namespace,
    capability: {
      id: capability.id,
      name: capability.name,
      mode: execution.mode
    },
    request: {
      method: execution.method,
      endpoint,
      headers: buildRequiredHeaders(auth, execution),
      body: execution.method === "GET" ? undefined : input,
      query: execution.method === "GET" ? input : undefined
    },
    auth,
    controls: {
      requiresConfirmation: Boolean(execution.requiresConfirmation),
      idempotencyKeyRequired: Boolean(execution.idempotencyKeyRequired),
      liveExecutionAllowed,
      willExecuteLive: liveExecutionAllowed && !isExampleDomain
    },
    safety: execution.requiresConfirmation
      ? "This capability can change business state or spend money. Require approval before live execution."
      : "This capability is safe for read/quote style execution."
  };
}

export async function executeCapability(manifest, capabilityId, input = {}, options = {}) {
  const plan = buildInvocationPlan(manifest, capabilityId, input, options);
  if (!plan.ok) {
    return plan;
  }

  if (!plan.controls.willExecuteLive) {
    return {
      ok: true,
      mode: "demo",
      plan,
      result: mockResultFor(capabilityId, input),
      note:
        "Demo execution returned a simulated result. Set allowLiveExecution=true and use a non-.example business domain to proxy a live API call."
    };
  }

  if (!hasRequiredAuth(plan.auth, options)) {
    return {
      ok: false,
      statusCode: 401,
      error: "auth_required",
      message: `This capability requires ${plan.auth.type} credentials before live execution.`,
      plan
    };
  }

  const liveEndpoint = appendQuery(plan.request.endpoint, plan.request.query);
  const response = await fetch(liveEndpoint, {
    method: plan.request.method,
    headers: {
      "Content-Type": "application/json",
      ...resolveAuthHeaders(plan.auth, options),
      ...(options.idempotencyKey
        ? {
            "Idempotency-Key": options.idempotencyKey
          }
        : {})
    },
    body: plan.request.body ? JSON.stringify(plan.request.body) : undefined
  });

  const contentType = response.headers.get("content-type") ?? "";
  const result = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  return {
    ok: response.ok,
    mode: "live",
    statusCode: response.status,
    plan,
    result
  };
}

function hasRequiredAuth(auth, options) {
  if (auth.type === "none") {
    return true;
  }

  if (auth.type === "apiKey") {
    return Boolean(options.apiKey);
  }

  if (auth.type === "oauth2") {
    return Boolean(options.authToken);
  }

  if (auth.type === "did-signature") {
    return Boolean(options.did && options.didSignature);
  }

  return false;
}

function defaultExecutionFor(capability) {
  return {
    method: "POST",
    path: `/v1/capabilities/${capability.id}/invoke`,
    mode: "workflow",
    requiresConfirmation: true,
    idempotencyKeyRequired: true
  };
}

function findMissingRequiredFields(inputSchema = {}, input = {}) {
  return (inputSchema.required ?? []).filter((field) => input[field] === undefined || input[field] === "");
}

function buildRequiredHeaders(auth, execution) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (auth.type === "apiKey") {
    headers.Authorization = "Bearer <api-key>";
  }

  if (auth.type === "oauth2") {
    headers.Authorization = "Bearer <oauth-access-token>";
  }

  if (auth.type === "did-signature") {
    headers["X-DID"] = "<agent-did>";
    headers["X-DID-Signature"] = "<signature>";
  }

  if (execution.idempotencyKeyRequired) {
    headers["Idempotency-Key"] = "<unique-request-id>";
  }

  return headers;
}

function resolveAuthHeaders(auth, options) {
  if (auth.type === "apiKey" && options.apiKey) {
    return {
      Authorization: `Bearer ${options.apiKey}`
    };
  }

  if (auth.type === "oauth2" && options.authToken) {
    return {
      Authorization: `Bearer ${options.authToken}`
    };
  }

  if (auth.type === "did-signature") {
    return {
      "X-DID": options.did ?? "",
      "X-DID-Signature": options.didSignature ?? ""
    };
  }

  return {};
}

function appendQuery(endpoint, query) {
  if (!query || Object.keys(query).length === 0) {
    return endpoint;
  }

  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  return url.toString();
}

function mockResultFor(capabilityId, input) {
  if (capabilityId === "request-supplier-quotes") {
    return {
      quotes: [
        {
          supplierId: "SUP-1042",
          supplierName: "Riyadh Materials Co.",
          totalPrice: 18450,
          currency: "USD",
          deliveryDays: 4,
          complianceStatus: "verified"
        },
        {
          supplierId: "SUP-1188",
          supplierName: "Najd Industrial Supply",
          totalPrice: 19120,
          currency: "USD",
          deliveryDays: 3,
          complianceStatus: "verified"
        }
      ],
      request: input
    };
  }

  if (capabilityId === "verify-supplier-compliance") {
    return {
      status: "approved",
      credentials: ["KYB", "ISO-9001", "Tax-clearance"],
      supplierId: input.supplierId
    };
  }

  if (capabilityId === "quote-freight-lane") {
    return {
      rates: [
        {
          carrier: "Orbit Cold Chain",
          price: 950,
          currency: "USD",
          estimatedDeliveryDays: 2
        }
      ],
      request: input
    };
  }

  if (capabilityId === "fetch-vendor-evidence") {
    return {
      vendor: input.vendorDomain,
      evidence: ["SOC-2", "ISO-27001", "Subprocessor list"],
      freshnessDays: 21
    };
  }

  return {
    status: "accepted",
    message: "Demo execution accepted the request.",
    request: input
  };
}
