import { createInterface } from "node:readline/promises";
import type { Config } from "./config.js";
import { requireThat } from "./errors.js";
import { PajClient } from "./providers/paj.js";
import { savePajSession } from "./provider-session.js";

export async function providerLogin(config: Config) {
  requireThat(process.stdin.isTTY && process.stdout.isTTY, "INTERACTIVE_TERMINAL_REQUIRED", "Run provider:login yourself in an interactive terminal. Do not send API keys or OTPs through an agent tool.");
  requireThat(config.pajApiKey, "PROVIDER_API_KEY_REQUIRED", "Add PAJ_API_KEY to your local environment or ignored .env file, then run provider:login. Obtain it from your PAJ Business dashboard first.");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const email = config.pajEmail ?? (await reader.question("PAJ account email: ")).trim();
    const confirmed = await reader.question(`Send a PAJ login OTP to ${email} in ${config.pajEnvironment}? Type SEND: `);
    requireThat(confirmed === "SEND", "APPROVAL_REQUIRED", "No PAJ login OTP was requested.");
    const client = new PajClient(config.pajEnvironment);
    await client.initiateSession(email, config.pajApiKey);
    const otp = (await reader.question("Enter the one-time code PAJ sent you: ")).trim();
    const session = await client.verifySession(email, otp, config.pajApiKey);
    savePajSession(config, session);
    console.log(JSON.stringify({ authenticated: true, environment: session.environment, expiresAt: session.expiresAt, livePayoutsAvailable: false, message: "Session saved to your private local profile. No payout was created and no funds moved." }, null, 2));
  } finally { reader.close(); }
}
