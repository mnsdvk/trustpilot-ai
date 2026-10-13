import { NextResponse } from "next/server";
import { formatUnits, parseAbiItem } from "viem";
import { promises as fs } from "node:fs";
import path from "node:path";
import { publicClient, requireVault, TOKEN_DECIMALS } from "@/lib/chain";
import { outcomeName, reasonName, REASON_TEXT } from "@/lib/labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const receiptEvent = parseAbiItem(
  "event Receipt(uint256 indexed id, address indexed agent, address indexed to, uint256 amount, uint8 outcome, uint8 reason, string intent)",
);

type Stored = {
  id: string;
  to: string;
  amount: string;
  outcome: number;
  reason: number;
  intent: string;
  txHash: string;
  block: string;
};

// Receipts already read from the chain. Only new blocks are scanned on later requests,
// so history never falls out of a sliding window and requests stay fast.
const CACHE_FILE = path.join(process.cwd(), ".receipts-cache.json");
let cache: { vault: string; lastBlock: string; logs: Stored[] } | null = null;
let loaded = false;
let running: Promise<void> | null = null;

async function loadCache(vault: string) {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as typeof cache;
    if (raw && raw.vault.toLowerCase() === vault.toLowerCase()) cache = raw;
  } catch {
    /* no cache yet */
  }
}

async function saveCache() {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
  } catch {
    /* read-only disk is fine, the memory cache still works */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public RPCs fail now and then. Retry a few times before giving up on a range. */
async function logsWithRetry(vault: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await publicClient.getLogs({ address: vault, event: receiptEvent, fromBlock, toBlock });
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function sync(vault: `0x${string}`) {
  const chunk = BigInt(process.env.LOG_CHUNK ?? "90");
  const latest = await publicClient.getBlockNumber();
  const deployBlock = BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || "0");
  const start = cache ? BigInt(cache.lastBlock) + 1n : deployBlock;
  if (start > latest) return;

  const ranges: [bigint, bigint][] = [];
  for (let from = start; from <= latest; from += chunk) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    ranges.push([from, to]);
  }

  const found: Stored[] = [];
  for (let i = 0; i < ranges.length; i += 12) {
    const batch = await Promise.all(ranges.slice(i, i + 12).map(([f, t]) => logsWithRetry(vault, f, t)));
    for (const l of batch.flat()) {
      found.push({
        id: l.args.id!.toString(),
        to: l.args.to!,
        amount: formatUnits(l.args.amount!, TOKEN_DECIMALS),
        outcome: Number(l.args.outcome!),
        reason: Number(l.args.reason!),
        intent: l.args.intent ?? "",
        txHash: l.transactionHash,
        block: l.blockNumber!.toString(),
      });
    }
  }

  // Only move the cursor forward once the whole range was read successfully.
  cache = { vault, lastBlock: latest.toString(), logs: [...(cache?.logs ?? []), ...found] };
  await saveCache();
}

export async function GET() {
  try {
    const vault = requireVault();
    await loadCache(vault);
    if (!running) running = sync(vault).finally(() => { running = null; });
    await running;

    const receipts = (cache?.logs ?? [])
      .map((l) => {
        const outcome = outcomeName(l.outcome);
        const reason = reasonName(l.reason);
        return { id: l.id, to: l.to, amount: l.amount, outcome, reason, explanation: REASON_TEXT[reason], intent: l.intent, txHash: l.txHash, block: l.block };
      })
      .sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)) || Number(BigInt(b.id) - BigInt(a.id)));

    return NextResponse.json({ receipts, latest: cache?.lastBlock ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 500 });
  }
}
