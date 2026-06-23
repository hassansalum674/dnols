const form = document.querySelector("#search-form");
const queryInput = document.querySelector("#query");
const protocolInput = document.querySelector("#protocol");
const verifiedInput = document.querySelector("#verified");
const results = document.querySelector("#results");
const manifestForm = document.querySelector("#manifest-form");
const websiteGeneratorForm = document.querySelector("#website-generator-form");
const websiteGeneratorResult = document.querySelector("#website-generator-result");
const validationStatus = document.querySelector("#validation-status");
const validationMessages = document.querySelector("#validation-messages");
const reviewSummary = document.querySelector("#review-summary");
const plansContainer = document.querySelector("#plans");
const previousStepButton = document.querySelector("#prev-step");
const nextStepButton = document.querySelector("#next-step");
const submitManifestButton = document.querySelector("#submit-manifest");
const stepIndicators = Array.from(document.querySelectorAll("[data-step-indicator]"));
const wizardPanels = Array.from(document.querySelectorAll("[data-step]"));
const queryLinks = Array.from(document.querySelectorAll("[data-query-link]"));

let currentStep = 0;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadResults();
});

queryInput.addEventListener("input", debounce(loadResults, 200));
protocolInput.addEventListener("change", loadResults);
verifiedInput.addEventListener("change", loadResults);

manifestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitOnboarding();
});

manifestForm.addEventListener("input", () => {
  renderReviewSummary();
  setValidationState("Waiting for submission", "", []);
});

websiteGeneratorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await generateFromWebsite();
});

previousStepButton.addEventListener("click", () => moveStep(-1));
nextStepButton.addEventListener("click", () => moveStep(1));
queryLinks.forEach((link) => {
  link.addEventListener("click", () => {
    queryInput.value = link.dataset.queryLink;
    loadResults();
  });
});

loadResults();
loadPlans();
renderWizard();

async function loadResults() {
  const params = new URLSearchParams();
  if (queryInput.value.trim()) {
    params.set("q", queryInput.value.trim());
  }

  if (protocolInput.value) {
    params.set("protocol", protocolInput.value);
  }

  if (verifiedInput.checked) {
    params.set("verified", "true");
  }

  const response = await fetch(`/api/manifests?${params.toString()}`);
  const payload = await response.json();
  renderResults(payload.results ?? []);
}

function renderResults(items) {
  if (items.length === 0) {
    results.innerHTML = `<div class="result-card"><h3>No matching listings</h3><p>Try a broader search or clear the connection filters.</p></div>`;
    return;
  }

  results.innerHTML = items.map(renderCard).join("");
}

function renderCard(item) {
  const protocols = item.endpoints?.protocols?.map((protocol) => connectionLabel(protocol.type)) ?? [];
  const verification = item.trust?.verificationStatus ?? "unverified";
  const score = item.score?.score ?? item.registryScore;
  const tags = item.tags.slice(0, 6).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const capabilities = item.capabilities
    .slice(0, 2)
    .map((capability) => escapeHtml(capability.name))
    .join(", ");

  return `
    <article class="result-card">
      <header>
        <div>
          <h3>${escapeHtml(item.name)}</h3>
          <p><strong>${escapeHtml(item.namespace)}</strong></p>
        </div>
        <span class="score">${score}/100</span>
      </header>
      <p>${escapeHtml(item.summary)}</p>
      <div class="tags">${tags}</div>
      <p><strong>Capabilities:</strong> ${capabilities}</p>
      <p><strong>Trust:</strong> ${escapeHtml(verification)} · <strong>Connections:</strong> ${protocols.join(", ") || "Standard web"}</p>
      <div class="links">
        <a href="/api/manifests/${encodeURIComponent(item.namespace)}" target="_blank">Details</a>
        <a href="/api/adapters/mcp/${encodeURIComponent(item.namespace)}" target="_blank">MCP</a>
        <a href="/api/adapters/a2a/${encodeURIComponent(item.namespace)}" target="_blank">A2A</a>
      </div>
    </article>
  `;
}

function formPayload() {
  const formData = new FormData(manifestForm);
  return Object.fromEntries(formData.entries());
}

function moveStep(direction) {
  if (direction > 0 && !validateCurrentStep()) {
    return;
  }

  currentStep = Math.max(0, Math.min(wizardPanels.length - 1, currentStep + direction));
  renderWizard();
}

function renderWizard() {
  wizardPanels.forEach((panel, index) => {
    panel.classList.toggle("active", index === currentStep);
  });

  stepIndicators.forEach((indicator, index) => {
    indicator.classList.toggle("active", index === currentStep);
    indicator.classList.toggle("complete", index < currentStep);
  });

  previousStepButton.hidden = currentStep === 0;
  nextStepButton.hidden = currentStep === wizardPanels.length - 1;
  submitManifestButton.hidden = currentStep !== wizardPanels.length - 1;
  renderReviewSummary();
}

function validateCurrentStep() {
  const fields = Array.from(wizardPanels[currentStep].querySelectorAll("input, textarea, select"));
  const invalidField = fields.find((field) => !field.checkValidity());
  if (!invalidField) {
    return true;
  }

  invalidField.reportValidity();
  return false;
}

function renderReviewSummary() {
  const payload = formPayload();
  reviewSummary.innerHTML = `
    <article><span>Business</span><strong>${escapeHtml(payload.publisherName || "Not set")}</strong></article>
    <article><span>Listing ID</span><strong>${escapeHtml(payload.namespace || "Not set")}</strong></article>
    <article><span>Action</span><strong>${escapeHtml(payload.serviceName || "Not set")}</strong></article>
    <article><span>Access</span><strong>${escapeHtml(connectionLabel(payload.protocol || "rest"))} · ${escapeHtml(authLabel(payload.authType || "apiKey"))}</strong></article>
  `;
}

async function submitOnboarding() {
  if (!validateCurrentStep()) {
    return;
  }

  setValidationState("Building listing", "", [
    { type: "ok", text: "We are building and checking your agent-ready listing." }
  ]);

  const response = await fetch("/api/build-manifest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(formPayload())
  });
  const result = await response.json();

  if (result.accepted) {
    setValidationState("Listing ready", "valid", [
      { type: "ok", text: `Listing built and checked. Readiness score: ${result.score.score}/100.` },
      ...result.nextSteps.map((step) => ({ type: "ok", text: step })),
      ...result.validation.warnings.map((warning) => ({ type: "warning", text: warning }))
    ]);
    return;
  }

  setValidationState("Needs fixes", "invalid", [
    ...result.validation.errors.map((error) => ({ type: "error", text: error })),
    ...result.validation.warnings.map((warning) => ({ type: "warning", text: warning }))
  ]);
}

async function generateFromWebsite() {
  websiteGeneratorResult.innerHTML = `<p class="ok">Reading public website data and drafting your listing...</p>`;
  const payload = Object.fromEntries(new FormData(websiteGeneratorForm).entries());

  try {
    const response = await fetch("/api/generate-from-website", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      const errors = result.validation?.errors ?? [result.message ?? "Could not generate from this website."];
      websiteGeneratorResult.innerHTML = errors
        .map((error) => `<p class="error">${escapeHtml(error)}</p>`)
        .join("");
      return;
    }

    populateFormFromManifest(result.manifest);
    currentStep = 0;
    renderWizard();
    websiteGeneratorResult.innerHTML = `
      <p class="ok">Draft created from ${escapeHtml(result.source.websiteUrl)}. Review each step before submitting.</p>
      <p>Detected: ${escapeHtml(result.source.extracted.title || result.manifest.publisher.name)}</p>
    `;
    setValidationState("Draft generated", "valid", [
      { type: "ok", text: `Website draft scored ${result.score.score}/100 after backend validation.` }
    ]);
  } catch (error) {
    websiteGeneratorResult.innerHTML = `<p class="error">${escapeHtml(error.message || "Website generation failed.")}</p>`;
  }
}

function populateFormFromManifest(manifest) {
  const capability = manifest.capabilities?.[0] ?? {};
  const protocol = manifest.endpoints?.protocols?.[0] ?? {};
  const values = {
    publisherName: manifest.publisher?.name,
    domain: manifest.publisher?.domain,
    namespace: manifest.namespace,
    contact: manifest.publisher?.contact,
    serviceName: manifest.name,
    summary: manifest.summary,
    capabilityId: capability.id,
    capabilityDescription: capability.description,
    tags: (capability.tags ?? []).join(", "),
    baseUrl: manifest.endpoints?.baseUrl,
    protocol: protocol.type,
    authType: manifest.endpoints?.auth?.type,
    pricingModel: manifest.pricing?.model
  };

  for (const [name, value] of Object.entries(values)) {
    const field = manifestForm.elements.namedItem(name);
    if (field && value) {
      field.value = value;
    }
  }
}

async function loadPlans() {
  const response = await fetch("/api/plans");
  const payload = await response.json();
  plansContainer.innerHTML = payload.plans.map(renderPlan).join("");

  plansContainer.querySelectorAll("[data-plan-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const checkoutResponse = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ planId: button.dataset.planId })
      });
      const checkout = await checkoutResponse.json();
      if (checkout.checkoutUrl) {
        window.location.href = checkout.checkoutUrl;
      }
    });
  });
}

function renderPlan(plan) {
  return `
    <article class="plan-card">
      <h3>${escapeHtml(plan.name)}</h3>
      <p>${escapeHtml(plan.description)}</p>
      <strong>$${plan.price}<span>/${escapeHtml(plan.interval)}</span></strong>
      <button data-plan-id="${escapeHtml(plan.id)}">Start Checkout</button>
      <small>${plan.checkoutConfigured ? "Live payment link configured" : "Demo checkout until Stripe link is configured"}</small>
    </article>
  `;
}

function setValidationState(label, statusClass, messages) {
  validationStatus.textContent = label;
  validationStatus.className = `status-pill ${statusClass}`.trim();
  validationMessages.innerHTML = messages
    .map((message) => `<p class="${message.type}">${escapeHtml(message.text)}</p>`)
    .join("");
}

function debounce(callback, delay) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => callback(...args), delay);
  };
}

function connectionLabel(value) {
  return {
    rest: "Standard web",
    mcp: "Tool-ready",
    a2a: "Agent-ready"
  }[value] ?? "Standard web";
}

function authLabel(value) {
  return {
    apiKey: "API key",
    oauth2: "Secure login",
    "did-signature": "Verified identity",
    none: "No login"
  }[value] ?? "API key";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
