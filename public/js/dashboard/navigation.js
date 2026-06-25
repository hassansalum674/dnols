export const sections = [
  ["home", "Home", "What needs your attention right now?"],
  ["conversations", "Conversations", "Live SMS approval threads."],
  ["deals", "Deals", "Read-only status for every deal."],
  ["agent", "My Agent", "Configure what your agent can do."],
  ["settings", "Settings", "Phone, email, password, and logout."]
];

export const mobileSectionIds = new Set(sections.map(([id]) => id));

export const routeIndex = [
  route("Home", "home", "", "attention pending deals weekly value", true),
  route("Conversations", "conversations", "", "chat messages agent owner other agents", true),
  route("Deals", "deals", "", "deals active complete status sms", true),
  route("My Agent", "agent", "", "business rules pricing approver service area", true),
  route("Settings", "settings", "", "sms phone email password logout", true)
];

function route(label, section, focus, keywords, mobile) {
  return { label, section, focus, keywords, mobile };
}
