import type { Config } from "./config.js";

// Compatibility command for earlier checkouts. V2 has no login/OTP exchange.
export async function providerLogin(config: Config) {
  console.log(JSON.stringify({ apiVersion: "v2", apiKeyConfigured: Boolean(config.pajApiKey), loginRequired: false, nextStep: "Configure PAJ_API_KEY locally, then run npm run provider:check. V2 uses x-api-key directly; legacy session files are ignored." }, null, 2));
}
