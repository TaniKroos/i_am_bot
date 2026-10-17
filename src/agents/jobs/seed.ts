/**
 * Starter companies to probe across Greenhouse/Lever/Ashby. Names that don't resolve are recorded in
 * unresolved_companies (they likely use Workday or their own site — handled by later adapters).
 * Tier 1 = poll every few minutes. Edit freely; the directory also grows on its own over time.
 */
export const SEED_TIER1 = [
  // AI / dev tools (often hire remote or in India)
  "Anthropic", "OpenAI", "Sarvam", "Composio", "Supabase", "PostHog", "Vercel", "Replit", "Perplexity", "ElevenLabs",
  "Hasura", "Appsmith", "ToolJet", "Airbyte", "Postman", "BrowserStack", "Rocketlane", "Atlan", "Mindtickle", "Whatfix",
  // India product companies
  "Razorpay", "CRED", "Groww", "PhonePe", "Zepto", "Meesho", "Swiggy", "Juspay", "Cashfree", "Setu", "Jupiter",
  "smallcase", "Upstox", "Zerodha", "Dream11", "Dream Sports", "ShareChat", "Ola", "Rapido", "Porter", "Urban Company",
  "Lenskart", "Nykaa", "Spinny", "CARS24", "Acko", "slice", "Fi", "Khatabook", "Apna", "Unacademy", "PhysicsWallah",
];

export const SEED_TIER2 = [
  "Stripe", "Databricks", "MongoDB", "GitLab", "Cloudflare", "Coinbase", "Figma", "Notion", "Ramp", "Linear", "Retool",
  "Deel", "Remote", "Airtable", "Dropbox", "Twilio", "Okta", "Elastic", "HashiCorp", "Confluent", "Datadog", "New Relic",
  "Zscaler", "Nutanix", "Rubrik", "Druva", "Chargebee", "Freshworks", "Innovaccer", "HackerRank", "Sprinklr", "InMobi",
  "Glance", "Vymo", "Observe.AI", "Uniphore", "Gupshup", "Yellow.ai", "Haptik", "Exotel", "CleverTap", "MoEngage",
  "WebEngage", "Netcore", "Capillary", "Darwinbox", "Keka", "Springworks", "Pine Labs", "MobiKwik", "Perfios", "M2P",
  "Zeta", "Delhivery", "Shiprocket", "Licious", "CarDekho", "Policybazaar", "Paytm", "Udaan", "Groyyo", "Ather Energy",
  "Navi", "Scaler", "upGrad", "Vedantu", "Simpl", "OneCard", "Turing", "Toptal", "GitHub", "Canonical", "Automattic",
  "Zapier", "Doist", "Hotjar", "Mattermost", "Sourcegraph", "Grafana Labs", "Temporal", "Clerk", "Neon", "Render",
  "Railway", "Fly.io", "Modal", "Pinecone", "Weaviate", "Qdrant", "LangChain", "LlamaIndex", "Cohere", "Mistral",
  "Hugging Face", "Scale AI", "Glean", "Writer", "Jasper", "Harvey", "Sierra", "Decagon", "Cursor", "Anysphere",
  "Lovable", "Bolt", "Cognition", "Factory", "Warp", "Raycast", "Zed", "Mercor", "Juspay", "Fyle", "Plivo", "Exotel",
  "Freshdesk", "Wingify", "VWO", "LambdaTest", "Sigmoid", "Tiger Analytics", "Fractal", "Quizizz", "Classplus",
  "Eloelo", "Pocket FM", "KukuFM", "STAGE", "Bobble AI", "Gameskraft", "Games24x7", "MPL", "WinZO", "Zupee",
];
