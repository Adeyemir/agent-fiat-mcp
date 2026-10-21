import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  browserApprovalPage,
  messagePage,
  sendPage,
  type BrowserApprovalStatus,
} from "./web-probe-page.js";

const TEST_TTL_MS = 5 * 60_000;
const RETENTION_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Test = {
  id: string;
  owner: string;
  status: BrowserApprovalStatus;
  csrf: string;
  createdAtMs: number;
  expiresAtMs: number;
  respondedAtMs?: number;
};
type Reply = { result: Record<string, unknown> } | { error: { code: string; message: string } };
type Binding = {
  hasBrowserBinding(connectionId: string): boolean;
  verifyBrowserBinding(connectionId: string, req: IncomingMessage): boolean;
};
export type BrowserProbeEvent = {
  event: "probe_browser_test";
  test: string;
  stage: "created" | "page_served" | "approved" | "declined" | "cancelled" | "rejected";
  reason?: "browser_binding_required" | "expired" | "already_saved" | "invalid_response";
};

/** Synthetic UI test only. No identity, wallet, order or payment authority. */
export class BrowserApprovalProbe {
  private readonly tests = new Map<string, Test>();
  constructor(
    private readonly origin: URL,
    private readonly binding: Binding,
    private readonly now: () => number = Date.now,
    private readonly onEvent: (event: BrowserProbeEvent) => void = () => {},
  ) {}

  private event(
    test: Test,
    stage: BrowserProbeEvent["stage"],
    reason?: BrowserProbeEvent["reason"],
  ) {
    this.onEvent({
      event: "probe_browser_test",
      test: createHash("sha256").update(test.id).digest("hex").slice(0, 16),
      stage,
      ...(reason ? { reason } : {}),
    });
  }

  private prune() {
    for (const [id, test] of this.tests) {
      if (test.createdAtMs + RETENTION_MS <= this.now()) this.tests.delete(id);
      else if (test.status === "pending" && test.expiresAtMs <= this.now()) test.status = "expired";
    }
  }

  private view(test: Test) {
    const responded = ["approved", "declined", "cancelled"].includes(test.status);
    return {
      stage: "browser_approval_probe",
      testId: test.id,
      status: test.status,
      expiresAt: new Date(test.expiresAtMs).toISOString(),
      ...(test.respondedAtMs === undefined
        ? {}
        : { respondedAt: new Date(test.respondedAtMs).toISOString() }),
      testAccepted: test.status === "approved",
      browserBoundResponseObserved: responded,
      humanInteractionIndependentlyVerified: false,
      approvalUiVerified: false,
      walletConnected: false,
      paymentExecutionAvailable: false,
    };
  }

  start(connectionId: string): Reply {
    this.prune();
    if (!this.binding.hasBrowserBinding(connectionId))
      return {
        error: {
          code: "BROWSER_RECONNECT_REQUIRED",
          message:
            "Reconnect this test connector in your browser to establish its browser session. Do not restart Circle login.",
        },
      };
    const owned = [...this.tests.values()].filter((test) => test.owner === connectionId);
    if (
      this.tests.size >= 128 ||
      owned.length >= 16 ||
      owned.filter((test) => test.status === "pending").length >= 4
    )
      return {
        error: {
          code: "BROWSER_TEST_LIMIT",
          message:
            "Too many browser tests. Complete a pending test or wait for older tests to expire.",
        },
      };
    const test: Test = {
      id: randomUUID(),
      owner: connectionId,
      status: "pending",
      csrf: randomBytes(32).toString("base64url"),
      createdAtMs: this.now(),
      expiresAtMs: this.now() + TEST_TTL_MS,
    };
    this.tests.set(test.id, test);
    this.event(test, "created");
    return {
      result: {
        ...this.view(test),
        browserUrl: new URL("/browser-approval/" + test.id, this.origin).href,
        browserBindingRequired: true,
        instructions:
          "Show this URL unchanged to the human. Have them open it in the browser used to connect this test connector, choose Approve test, Decline or Cancel test, then return to chat. Check get_browser_approval_test afterward. Do not open or submit the page on their behalf. This is never payment approval.",
      },
    };
  }

  read(connectionId: string, testId: string): Reply {
    this.prune();
    const test = this.tests.get(testId);
    if (!test || test.owner !== connectionId)
      return {
        error: {
          code: "BROWSER_TEST_NOT_FOUND",
          message:
            "This browser test is unavailable for this connection. Start a new test if needed.",
        },
      };
    return { result: this.view(test) };
  }

  private browserTest(testId: string, req: IncomingMessage, res: ServerResponse) {
    this.prune();
    const test = UUID.test(testId) ? this.tests.get(testId) : undefined;
    if (!test) {
      sendPage(
        res,
        404,
        messagePage("Test unavailable", "Ask your agent to start a new browser approval test."),
      );
      return;
    }
    if (!this.binding.verifyBrowserBinding(test.owner, req)) {
      this.event(test, "rejected", "browser_binding_required");
      sendPage(
        res,
        403,
        messagePage(
          "Use the connected browser",
          "Open this link in the browser used to connect the test connector. If that browser session expired, reconnect the test connector. A link alone cannot approve a test.",
        ),
      );
      return;
    }
    return test;
  }

  show(testId: string, req: IncomingMessage, res: ServerResponse) {
    const test = this.browserTest(testId, req, res);
    if (test) {
      this.event(test, "page_served");
      sendPage(
        res,
        200,
        browserApprovalPage({
          testId: test.id,
          status: test.status,
          expiresAt: new Date(test.expiresAtMs).toISOString(),
          csrf: test.csrf,
        }),
      );
    }
  }

  async respond(testId: string, req: IncomingMessage, res: ServerResponse) {
    if (
      req.headers.origin !== this.origin.origin ||
      req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded"
    ) {
      sendPage(
        res,
        403,
        messagePage("Response refused", "Use the test page in the connected browser to respond."),
      );
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 4096) {
        sendPage(
          res,
          413,
          messagePage("Request too large", "Return to the browser test page and try again."),
        );
        return;
      }
    }
    // Re-check the binding and expiry after the asynchronous body read, before
    // the synchronous state transition, so revocation or expiry cannot race it.
    const test = this.browserTest(testId, req, res);
    if (!test) return;
    if (test.status !== "pending") {
      this.event(test, "rejected", test.status === "expired" ? "expired" : "already_saved");
      sendPage(
        res,
        test.status === "expired" ? 410 : 409,
        messagePage(
          test.status === "expired" ? "Test expired" : "Response already saved",
          "Return to your chat and ask the agent to check this test’s status.",
        ),
      );
      return;
    }
    const form = new URLSearchParams(body);
    const csrf = form.get("csrf") ?? "";
    const decision = form.get("decision");
    if (
      form.size !== 2 ||
      form.getAll("csrf").length !== 1 ||
      form.getAll("decision").length !== 1 ||
      !["approve", "decline", "cancel"].includes(decision ?? "") ||
      Buffer.byteLength(csrf) !== Buffer.byteLength(test.csrf) ||
      !timingSafeEqual(Buffer.from(csrf), Buffer.from(test.csrf))
    ) {
      this.event(test, "rejected", "invalid_response");
      sendPage(
        res,
        403,
        messagePage(
          "Response refused",
          "Use the buttons on the browser test page. This response was not recorded.",
        ),
      );
      return;
    }
    test.status =
      decision === "approve" ? "approved" : decision === "decline" ? "declined" : "cancelled";
    test.respondedAtMs = this.now();
    this.event(test, test.status);
    // Redirect within our own origin so refreshing shows the saved result
    // without resubmitting the approval form or navigating to a chat callback.
    res.writeHead(303, { Location: "/browser-approval/" + test.id });
    res.end();
  }
}
