import { NextResponse } from "next/server";
import { createWalletClient, formatUnits, http, isAddress, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { vaultAbi } from "@/lib/abi";
import { monadTestnet, publicClient, requireVault, TOKEN_DECIMALS } from "@/lib/chain";
import { parseIntent } from "@/lib/intent";
import type { Contact } from "@/lib/intent";
import { outcomeName, reasonName, REASON_TEXT } from "@/lib/labels";

export const runtime = "nodejs";

/** Contacts only map a name to an address. The contract still decides whether a payment is allowed. */
function cleanContacts(input: unknown): Contact[] {
  if (!Array.isArray(input)) return [];
  const out: Contact[] = [];
  for (const item of input.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name === "string" && typeof o.address === "string" && isAddress(o.address)) {
      out.push({ name: o.name.slice(0, 30), address: o.address });
    }
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { message?: unknown; contacts?: unknown };
    const message = typeof body.message === "string" ? body.message : "";

    const intent = await parseIntent(message, cleanContacts(body.contacts));
    if (!intent.ok) {
      return NextResponse.json({ kind: "reply", reply: intent.reply });
    }

    const vault = requireVault();
    const pk = process.env.AGENT_PRIVATE_KEY;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      return NextResponse.json({ kind: "error", error: "AGENT_PRIVATE_KEY is missing or malformed in .env.local." }, { status: 500 });
    }

    const account = privateKeyToAccount(pk as `0x${string}`);
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(monadTestnet.rpcUrls.default.http[0]) });

    // Only the agent key signs. The contract decides whether the payment goes through.
    const intentText = message.trim().slice(0, 200);
    const { request } = await publicClient.simulateContract({
      address: vault,
      abi: vaultAbi,
      functionName: "requestPayment",
      args: [intent.to, intent.amountUnits, intentText],
      account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const logs = parseEventLogs({ abi: vaultAbi, eventName: "Receipt", logs: receipt.logs });
    const ev = logs.find((l) => l.address.toLowerCase() === vault.toLowerCase());
    if (!ev) {
      return NextResponse.json({ kind: "error", error: "The transaction was mined but no receipt event was found.", txHash: hash }, { status: 500 });
    }

    const outcome = outcomeName(ev.args.outcome);
    const reason = reasonName(ev.args.reason);
    return NextResponse.json({
      kind: "result",
      parsedBy: intent.via,
      id: ev.args.id.toString(),
      to: ev.args.to,
      amount: formatUnits(ev.args.amount, TOKEN_DECIMALS),
      outcome,
      reason,
      explanation: REASON_TEXT[reason],
      txHash: hash,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ kind: "error", error: msg.slice(0, 400) }, { status: 500 });
  }
}
