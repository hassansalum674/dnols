export const sections = [
  ["overview", "Overview", ""],
  ["agent", "Agent Space", ""],
  ["profile", "Profile", ""],
  ["inbox", "Inbox", ""],
  ["sent", "Sent", ""],
  ["orders", "Agent Requests", ""],
  ["approvals", "Approvals", ""],
  ["analytics", "Analytics", ""],
  ["api", "API", ""],
  ["billing", "Billing", ""],
  ["settings", "Settings", ""]
];

export const mobileSectionIds = new Set(["overview", "agent", "inbox", "orders", "approvals", "settings"]);

export const routeIndex = [
  route("Agent Space", "agent", "agentChoices", "agent workspace space setup dashboard configure", true),
  route("Talk to agent", "agent", "agentChatPanel", "chat message talk ask agent deal order approval publishing", true),
  route("Negotiation draft", "agent", "agentNegotiationPanel", "negotiate negotiation task agent response autofill approval", true),
  route("Test agent", "agent", "agentTestPanel", "test run agent", true),
  route("Capabilities", "agent", "agentCapabilityPanel", "capability capabilities offer service tags", true),
  route("Negotiation rules", "agent", "agentNegotiationRulesPanel", "rules price deal limits discount payment terms", true),
  route("Human approval", "agent", "agentEscalationPanel", "human approval escalation phone whatsapp threshold", true),
  route("Tools", "agent", "agentToolsPanel", "api tools endpoint execution mcp a2a headers", true),
  route("Memory", "agent", "agentMemoryPanel", "memory knowledge services faqs policies blacklist", true),
  route("Recent runs", "agent", "agentActivityPanel", "activity log runs audit history", true),
  route("Incoming requests", "inbox", "", "inbox incoming request negotiation deal buyer", true),
  route("Send request", "sent", "", "send sent request target namespace deal", false),
  route("Agent Requests", "orders", "", "agent requests orders order service complete completed", true),
  route("Approvals", "approvals", "", "approval approve reject decision", true),
  route("Analytics", "analytics", "", "analytics metrics value completion", false),
  route("API", "api", "", "api execution endpoint protocol live proxy", false),
  route("Billing", "billing", "", "billing plans plan pricing upgrade", false),
  route("Settings", "settings", "", "settings account theme password notifications privacy export", true),
  route("Public publishing", "overview", "publishPanel", "publish publishing registry public listing review", false)
];

function route(label, section, focus, keywords, mobile) {
  return { label, section, focus, keywords, mobile };
}
