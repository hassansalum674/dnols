const PAYMENT_LINKS = {
  basic: process.env.STRIPE_BASIC_PAYMENT_LINK,
  professional: process.env.STRIPE_PRO_PAYMENT_LINK,
  enterprise: process.env.STRIPE_ENTERPRISE_PAYMENT_LINK
};

const PLANS = {
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

export function listPlans() {
  return Object.values(PLANS).map((plan) => ({
    ...plan,
    checkoutConfigured: Boolean(PAYMENT_LINKS[plan.id])
  }));
}

export function createCheckout(planId, origin) {
  const plan = PLANS[planId];
  if (!plan) {
    return {
      ok: false,
      statusCode: 404,
      error: "unknown_plan",
      message: `Unknown plan: ${planId}`
    };
  }

  const paymentLink = PAYMENT_LINKS[plan.id];
  if (paymentLink) {
    return {
      ok: true,
      mode: "stripe_payment_link",
      plan,
      checkoutUrl: paymentLink
    };
  }

  return {
    ok: true,
    mode: "demo",
    plan,
    checkoutUrl: `${origin}/checkout-demo.html?plan=${encodeURIComponent(plan.id)}`,
    message:
      "Set STRIPE_BASIC_PAYMENT_LINK, STRIPE_PRO_PAYMENT_LINK, or STRIPE_ENTERPRISE_PAYMENT_LINK to use live Stripe Payment Links."
  };
}
