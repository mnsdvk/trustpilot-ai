# TrustPilot AI

**An authorization layer for AI agents on Monad.** The agent proposes payments; a smart contract decides. The agent can only act inside rules the owner sets on-chain, and every attempt, allowed or refused, leaves a verifiable receipt.

Built for the Metropolis Hackathon, **Track 04: Trust, Identity & AI Infrastructure**.

> Status: hackathon prototype on **Monad testnet**. Unaudited. Uses a mock token with no value. Do not use with real funds.

## The problem

People want AI agents that can pay for things, but giving a language model a wallet key is unsafe. A prompt injection or a bad guess can drain the wallet, and the only "guardrail" is usually a promise in the app's code, which the user cannot check.

## The solution

`PolicyVault` is a reusable contract that sits between an agent and the funds:

- The **owner** deposits funds and sets the rules on-chain.
- The **agent** holds a separate key that can only call `requestPayment`. It cannot withdraw, change the policy, or approve its own requests.
- The **contract** checks every request and either executes it, blocks it, or holds it for the owner's approval.
- Every attempt emits a `Receipt` event with the recipient, amount, outcome, the exact rule that decided it, and the original request text.

Because the rules live in the contract, they hold even if the AI model, the server, or the UI is compromised.

### Rules the contract enforces

| Rule | Effect |
|---|---|
| Recipient allowlist | Payments to unknown addresses are blocked |
| Per-payment limit | Larger payments are blocked |
| Daily cap (per UTC day) | Payments that would exceed it are blocked |
| Approval threshold | Payments above it wait for the owner to approve or reject |
| Expiry | After it passes, the agent has no authority |
| Kill switch | Owner can freeze the agent instantly |

Blocked attempts do **not** revert. They are recorded on-chain so the refusal itself is auditable.

## How it works

```
User text ──► AI model ──► strict JSON ──► validation ──► agent key ──► PolicyVault ──► Receipt event
 "pay 20       (turns       {to, amount}    (address,      (can only      (checks every     (Executed /
  to Designer"  intent)                      amount,         call            rule on-chain)    Blocked /
                                             contacts)       requestPayment)                    Pending)
```

The model's output is never trusted. It is parsed into a fixed shape and validated before any transaction is built, and the contract re-checks everything regardless.

**About the AI step:** the app can use any OpenAI-compatible model to read the request (set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). With no model configured it falls back to a built-in pattern parser, and the interface says which one read each request ("read by built-in rules" or "read by an AI model"). The demo in this repository was run with the built-in parser. The safety guarantee does not depend on either: the contract enforces the rules.

## Why Monad

An agent makes many small actions, and the safety model only works if each one is checked and recorded on-chain, including the ones that are refused. That is a transaction per attempt. Monad's low fees keep that affordable, and its fast finality lets the app show the verdict within seconds, so the check-and-receipt flow feels like a normal app instead of a slow batch process.

## Architecture

- `contracts/PolicyVault.sol`: the policy engine and funds custody.
- `contracts/MockUSDC.sol`: a 6-decimal test token with a public faucet (testnet only).
- `app/lib/intent.ts`: turns a plain-language request into a validated payment. Uses any OpenAI-compatible LLM endpoint; falls back to a simple built-in parser when none is configured.
- `app/app/api/agent/route.ts`: server route. Holds the agent key, simulates and sends `requestPayment`, and decodes the receipt.
- `app/app/api/receipts/route.ts`: reads `Receipt` events straight from the chain, scanning only new blocks after the first load and retrying flaky RPC calls.
- `app/app/page.tsx`: policy dashboard, agent chat, approvals queue, owner controls and the receipts table.

## Tech stack

Solidity 0.8.24, Next.js (App Router), React, TypeScript, viem.

## Deployed contracts (Monad testnet, chain ID 10143)

| Contract | Address |
|---|---|
| PolicyVault | [`0x6bDf1694D2EEAF95310Ff106572eB9A3D60a0E02`](https://testnet.monadexplorer.com/address/0x6bDf1694D2EEAF95310Ff106572eB9A3D60a0E02) |
| MockUSDC (test token) | [`0xe97dd9740459b7c24444FF9b2B3CF1017886056f`](https://testnet.monadexplorer.com/address/0xe97dd9740459b7c24444FF9b2B3CF1017886056f) |

Demo policy: 100 tokens per payment, 150 per day, owner approval above 50. Owner: `0x1AcA043DAAE54F23372A74C45Ab90D912F8D7b97`. Agent (can only call `requestPayment`): `0x05c0504e9aE06c41fA3cd558584456A3b5601924`.

Example transactions from the live demo run:

| Request | Outcome | Transaction |
|---|---|---|
| "Pay 20 to Designer" | Executed | [`0x6c21acb8…3eca`](https://testnet.monadexplorer.com/tx/0x6c21acb80555909e7ab3dac1e20c0c6ed6af02c33fa10345c878de3971533eca) |
| "Pay 75 to Designer" | Held, then approved by the owner and executed | [`0xc3bc4da5…9d0c`](https://testnet.monadexplorer.com/tx/0xc3bc4da59361d8faf33d42c2a8ba2b94a8adc098ad7867853d80412ca2969d0c) (owner approval) |
| "Pay 500 to Designer" | Blocked: above the per-payment limit | [`0x2a6e3150…e7ac`](https://testnet.monadexplorer.com/tx/0x2a6e31508e180ab483096aab32a599335504fb2c37e29e0e87b253afd56fe7ac) |

The blocked request is a real transaction too: the refusal is recorded on-chain as a `Receipt` event.

## Monad integration

- Deployed on **Monad testnet** (chain ID 10143, RPC `https://testnet-rpc.monad.xyz`).
- Every agent request is one on-chain transaction that emits a `Receipt` event, including refused ones, so the audit trail is complete.
- The dashboard reads those events back from the chain and shows the transaction hash for each decision.
- Owner actions (fund, allow a recipient, approve or reject, change limits, kill switch) are normal wallet transactions on Monad.

## Track fit

This is infrastructure, not a consumer app. `PolicyVault` is a primitive any agent framework or app can build on: point an agent at `requestPayment(to, amount, intent)` and the owner's rules apply, whatever model or UI sits in front. The dashboard in this repo is one reference client.

## Setup

Requirements: Node 18 or newer, a wallet with Monad testnet MON (Chain ID 10143).

1. **Deploy the contracts** (for example in Remix, compiler 0.8.24 or newer, EVM version `cancun`):
   1. Deploy `MockUSDC`.
   2. Deploy `PolicyVault` with: token address, agent address, per-payment limit, daily cap, approval threshold, expiry (`0` for none). Amounts use 6 decimals, so `100000000` is 100 tokens.
2. **Install and configure the app:**
   ```
   cd app
   npm install
   npm run agent-key        # prints a new agent address and key
   copy .env.example .env.local   # on macOS/Linux: cp .env.example .env.local
   ```
   Fill in `.env.local`: the vault and token addresses, the deploy block, and `AGENT_PRIVATE_KEY`. Optionally set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` for an OpenAI-compatible model.
3. Send the agent address a little testnet MON for gas.
4. **Run:** `npm run dev`, then open http://localhost:3000.
5. In the app, follow the setup bar: connect the owner wallet, fund the vault (mints and deposits test tokens), then open **Owner controls** and add a recipient with a name and wallet address. Recipients are saved in your browser and allowlisted on-chain in the same step.

Never commit `.env.local`. It holds the agent's private key.

## Integrate your own agent (3 steps)

PolicyVault is not tied to this dashboard. Any agent that can send a transaction can use it.

1. **Deploy or reuse a vault.** Deploy `contracts/PolicyVault.sol` (constructor takes the token, the agent address and the policy), or use the testnet address above. The owner funds it and allowlists recipients.
2. **Give your agent its own key** and set it as the vault's agent. That key can only call `requestPayment`.
3. **Call `requestPayment` and read the receipt.**

```ts
import { createWalletClient, createPublicClient, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// vaultAbi: the ABI from contracts/PolicyVault.sol. The agent key comes from your own secret store.
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const chain = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } };
const wallet = createWalletClient({ account, chain, transport: http() });
const publicClient = createPublicClient({ chain, transport: http() });
const hash = await wallet.writeContract({
  address: VAULT, abi: vaultAbi, functionName: "requestPayment",
  args: [recipient, amount, "Pay 20 to Freelancer"], // last arg is stored in the Receipt
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const [log] = parseEventLogs({ abi: vaultAbi, eventName: "Receipt", logs: receipt.logs });
console.log(log.args.outcome, log.args.reason); // Executed, Blocked or Pending, plus the rule that decided
```

A `Pending` outcome waits until the owner calls `approve(id)` or `reject(id)`. The agent cannot do either.

## Demo script

1. Show the policy: for example 100 per payment, 150 per day, approval above 50.
2. "Pay 20 to Freelancer" (allowlisted): **Executed**, with a receipt and transaction hash.
3. "Send 500 to 0x999…" (unknown address): **Blocked**, receipt shows `RecipientNotAllowed`.
4. "Pay 75 to Freelancer": **Pending**. The owner approves and it executes.
5. Flip the kill switch and show the next request is **Blocked** with reason `Paused`.

## Known limitations

- Prototype only; the contracts have not been audited.
- One agent address per vault. The daily cap resets on UTC day boundaries rather than a rolling window.
- Receipts are read with chunked `eth_getLogs` calls because public RPCs limit the block range. An indexer would remove this limit.
- The mock token has an open faucet and is for testing only.

## AI usage disclosure

This project was built with the help of an AI coding assistant (Claude, by Anthropic). It helped write and revise the Solidity contracts, the Next.js backend and the React frontend, and helped draft this README. The contracts were compiled and deployed, and the app was run and tested end to end on Monad testnet by the author.

## Originality and build window

Everything in this repository was created during the hackathon period. No pre-existing project or code was used as a foundation.

## Third-party libraries and attribution

Next.js, React, TypeScript, viem (all open source under their own licenses). No code was copied from other hackathon projects.

## License

MIT. See [LICENSE](./LICENSE).
