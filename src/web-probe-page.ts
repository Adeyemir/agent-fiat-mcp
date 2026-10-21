import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

// Reference lock and accessibility decisions are recorded in docs/web-connector.md.
const css = [
  ":root{color-scheme:light;--ink:#1b1b1b;--muted:#60646c;--line:#e9e9e9;--accent:#088177}",
  "*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,sans-serif}",
  "main{max-width:568px;margin:0 auto;padding:48px 24px 64px}.brand{font-size:16px;font-weight:700;letter-spacing:-.02em;margin:0 0 48px}",
  ".label{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 12px}",
  "h1{font-size:32px;line-height:1.2;letter-spacing:-.035em;text-wrap:balance;margin:0 0 16px}h2{font-size:16px;margin:0}",
  "p{margin:0 0 24px}.muted,small{color:var(--muted)}small{display:block;font-size:13px;line-height:1.5}",
  ".scope{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:28px 0;padding:20px 0}.scope p:last-child{margin:12px 0 0}",
  ".app{font-size:18px;font-weight:600;overflow-wrap:anywhere;margin:0}.origin{overflow-wrap:anywhere;margin:4px 0 0;color:var(--muted);font-size:14px}",
  ".actions{display:flex;gap:12px;margin-top:28px}button{font:inherit;font-weight:600;min-height:48px;padding:10px 24px;border:1px solid var(--line);border-radius:6px;cursor:pointer;background:#fff;color:var(--ink)}",
  "button.primary{flex:1;background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{background:#06736a}button:hover{border-color:var(--ink)}",
  "button:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:4px}a{color:var(--accent);text-underline-offset:3px}",
  "code{display:block;background:#f0f0f3;padding:16px;overflow-wrap:anywhere;font-size:14px;line-height:1.5;margin:24px 0}footer{margin-top:32px}",
  "@media(max-width:400px){main{padding:28px 20px}.brand{margin-bottom:36px}.actions{flex-direction:column}.actions button{width:100%}h1{font-size:28px}}",
].join("\n");
const styleHash = createHash("sha256").update(css).digest("base64");

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function page(title: string, content: string) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" +
    escapeHtml(title) +
    " · Naira Offramp</title><style>" +
    css +
    '</style></head><body><main><p class="brand">Naira Offramp</p>' +
    content +
    "</main></body></html>"
  );
}

export function consentPage(request: string, clientName: string, callbackOrigin: string) {
  return page(
    "Connect a compatibility test",
    '<p class="label">Connection test</p><h1>Check your chat connection</h1>' +
      '<p class="muted">Allow this app to check its connection and ask you to try a sample approval.</p>' +
      '<div class="scope"><small>Requesting app</small><p class="app">' +
      escapeHtml(clientName) +
      '</p><p class="origin">Return address: ' +
      escapeHtml(callbackOrigin) +
      "</p><small>The app name is supplied by the requesting client.</small></div>" +
      "<h2>Test access only</h2><p>This connection cannot access a wallet, create a payment order or send money.</p>" +
      '<form method="post" action="/consent"><input type="hidden" name="request" value="' +
      escapeHtml(request) +
      '"><div class="actions"><button name="decision" value="deny">Cancel</button>' +
      '<button class="primary" name="decision" value="allow">Connect test</button></div></form>' +
      "<footer><small>No Circle login or API keys are needed for this test. Connecting here does not approve a payment.</small></footer>",
  );
}

export function landingPage(endpoint: string) {
  return page(
    "Web connection test",
    '<p class="label">Connection test</p><h1>Try Naira Offramp in your chat app</h1>' +
      '<p class="muted">This preview checks your chat connection and lets you try a harmless approval in this browser.</p>' +
      "<h2>Add this connector address</h2><code>" +
      escapeHtml(endpoint) +
      "</code><p>In your chat app, add a custom MCP connector with this address. Choose OAuth if asked, then review the connection test permissions.</p>" +
      '<div class="scope"><h2>Then ask your agent</h2><p>“Check the Naira Offramp connection, then start a browser approval test and show me its link.”</p></div>' +
      "<h2>Payments are off</h2><p>This preview has no wallet connection. Your current wallet, recipients and payout history remain outside this test.</p>" +
      "<footer><small>Availability depends on your chat app and account. A successful connection test does not establish payment support.</small></footer>",
  );
}

export type BrowserApprovalStatus = "pending" | "approved" | "declined" | "cancelled" | "expired";

export function browserApprovalPage(input: {
  testId: string;
  status: BrowserApprovalStatus;
  expiresAt: string;
  csrf: string;
}) {
  const titles: Record<BrowserApprovalStatus, string> = {
    pending: "Try a browser approval",
    approved: "Test approved",
    declined: "Test declined",
    cancelled: "Test cancelled",
    expired: "Test expired",
  };
  const content =
    '<p class="label">Connection test</p><h1>' +
    titles[input.status] +
    "</h1>" +
    (input.status === "pending"
      ? '<p class="muted">Choose whether to approve this harmless test. This choice cannot approve a payment.</p>'
      : '<p class="muted">Return to your chat and ask the agent to check this test’s status.</p>') +
    '<div class="scope"><small>Test reference</small><p class="app">' +
    escapeHtml(input.testId) +
    "</p><small>Only the browser session used to connect this test can respond.</small></div>" +
    "<h2>No money will move</h2><p>No wallet is connected. No payment order exists in this test.</p>" +
    (input.status === "pending"
      ? "<small>Expires: " +
        escapeHtml(new Date(input.expiresAt).toUTCString()) +
        "</small>" +
        '<form method="post" action="/browser-approval/' +
        escapeHtml(input.testId) +
        '">' +
        '<input type="hidden" name="csrf" value="' +
        escapeHtml(input.csrf) +
        '">' +
        '<div class="actions"><button name="decision" value="decline">Decline</button>' +
        '<button name="decision" value="cancel">Cancel test</button>' +
        '<button class="primary" name="decision" value="approve">Approve test</button></div></form>'
      : input.status === "expired"
        ? "<p>Ask the agent to start a new browser approval test.</p>"
        : "<p>Your choice is saved for this test. It cannot be changed by refreshing the page.</p>") +
    "<footer><small>This checks a browser interaction, not your identity or wallet ownership. Never enter credentials on this test page.</small></footer>";
  return page(titles[input.status], content);
}

export function messagePage(title: string, message: string) {
  return page(
    title,
    '<p class="label">Connection test</p><h1>' +
      escapeHtml(title) +
      '</h1><p class="muted">' +
      escapeHtml(message) +
      "</p>",
  );
}

export function pageHeaders(res: ServerResponse, formRedirect?: URL) {
  res.setHeader("Cache-Control", "no-store");
  // `no-referrer` makes navigation-mode form POSTs send Origin: null, breaking
  // the consent endpoint's exact-origin CSRF check (Fetch § Origin header).
  // Keep the origin for our own form, without sending referrers to the client.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'sha256-" +
      styleHash +
      "'; frame-ancestors 'none'; form-action 'self'" +
      (formRedirect ? " " + formRedirect.origin : "") +
      "; base-uri 'none'",
  );
}

export function sendPage(res: ServerResponse, status: number, html: string, formRedirect?: URL) {
  pageHeaders(res, formRedirect);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
