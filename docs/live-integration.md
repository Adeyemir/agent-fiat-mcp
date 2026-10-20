# Verification

The direct route is **Circle Agent Wallet USDC on Arc → PAJ → NGN in a Nigerian bank account**.

## Live evidence

On **October 20, 2026**, one user-approved payout completed through this route:

1. PAJ verified the explicitly supplied recipient and full holder name.
2. A fresh production Arc order was prepared and reviewed.
3. Circle confirmed the USDC transfer to that order's funding address.
4. PAJ returned `COMPLETED`; its transaction signature, sender, recipient, chain, token and amount matched the Circle transfer.
5. The recipient confirmed receiving the NGN in their bank account.

This is a completed live test with bank receipt confirmed by the recipient. The MCP itself does not access a bank statement or bank-credit feed.

## Coverage

| Behavior                                                              | Evidence                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------ |
| Agent-wallet ownership and Arc USDC balance                           | Live checks and automated tests.                       |
| One-off recipient verification                                        | Live payout and automated tests.                       |
| Human approval and direct Arc transfer                                | Live payout and automated tests.                       |
| PAJ receipt matched to Circle                                         | Live payout and automated tests.                       |
| Actual NGN bank receipt                                               | Recipient confirmation after the live payout.          |
| Declined approval, expiry, changing fees and changed recipients       | Controlled automated tests.                            |
| Concurrent execution, interrupted submissions and restart persistence | Controlled automated tests.                            |
| Service discovery, booking and merchant fulfilment                    | Supplied by the application using these payment tools. |

The automated suite uses fake providers, fake Circle executables and temporary databases. It does not fund live orders.

## Hosted service verification

On October 20, 2026, the deployed Cloudflare API passed live readiness checks from a client with no PAJ key: NGN rates, active Arc support, bank-directory access and the authenticated Circle agent wallet all passed. No payout order was created or funded during these checks.

Seven local Worker/D1 integration tests cover request signatures, replay protection, order isolation, idempotent and uncertain order creation, usage limits, blocked upstream redirects, private connection identity persistence and the existing approval/receipt lifecycle through the hosted API. Provider responses and wallet transfers in those tests are controlled fixtures. The bank-credit evidence above remains the earlier direct-route live payout.

## Provider contract

The implementation follows [PAJ v2](https://docs.paj.cash/) with Business API key authentication, recipient verification by bank code and account number, fresh Arc orders and `GET /transaction/{id}` polling. Arc USDC uses the six-decimal ERC-20 interface at `0x3600000000000000000000000000000000000000`.

The live chain flag controls availability. Rates include the business fee and are applied when PAJ observes the deposit. Order funding addresses are temporary and belong to one chain.

PAJ's settled receipt can replace the quote's `address` with the sender and `createdAt` with the deposit time. The service accepts this receipt only after matching it to the confirmed Circle transfer. It retains the original order separately for reconciliation.

See [usage](usage.md) for amount semantics, approval, status interpretation and recovery.
