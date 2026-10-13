"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createWalletClient, custom, erc20Abi, formatUnits, isAddress, parseUnits } from "viem";
import type { EIP1193Provider } from "viem";
import { mockUsdcAbi, vaultAbi } from "@/lib/abi";
import { monadTestnet, publicClient, TOKEN, TOKEN_DECIMALS, VAULT } from "@/lib/chain";

/* ------------------------------------------------------------------ types */

type Receipt = {
  id: string;
  to: string;
  amount: string;
  outcome: string;
  reason: string;
  explanation: string;
  intent: string;
  txHash: string;
  block: string;
};

type AgentResult = {
  kind: "result";
  parsedBy: string;
  id: string;
  to: string;
  amount: string;
  outcome: string;
  reason: string;
  explanation: string;
  txHash: string;
};

type VaultState = {
  perTx: bigint;
  daily: bigint;
  threshold: bigint;
  paused: boolean;
  remaining: bigint;
  balance: bigint;
  owner: string;
  agent: string;
};

type Recipient = { name: string; address: string };
type Tone = "pass" | "fail" | "hold";
type Toast = { text: string; tone: Tone };

/* -------------------------------------------------------------- constants */

// The contract checks rules in this order and reports the first one that fails.
const RULES = [
  { reason: "Paused", label: "Kill switch is off" },
  { reason: "PolicyExpired", label: "Policy has not expired" },
  { reason: "RecipientNotAllowed", label: "Recipient is on the allowlist" },
  { reason: "ExceedsPerTxLimit", label: "Amount is within the per-payment limit" },
  { reason: "ExceedsDailyCap", label: "Today's total stays within the daily cap" },
  { reason: "InsufficientBalance", label: "Vault holds enough tokens" },
  { reason: "NeedsApproval", label: "Amount needs no owner approval" },
] as const;

const STORE_KEY = "trustpilot.recipients";
// Defaults to the Monad testnet explorer. Override with NEXT_PUBLIC_EXPLORER_TX_URL (must end in /tx/).
const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER_TX_URL || "https://testnet.monadexplorer.com/tx/";

/* ---------------------------------------------------------------- helpers */

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const fmt = (n: bigint) => formatUnits(n, TOKEN_DECIMALS);

function errText(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string };
  return (x.shortMessage ?? x.message ?? String(e)).slice(0, 300);
}

function toneOf(outcome: string): Tone {
  if (outcome === "Executed") return "pass";
  if (outcome === "Pending") return "hold";
  return "fail";
}

function addressUrl(address: string): string | null {
  if (!EXPLORER) return null;
  return `${EXPLORER.replace(/\/tx\/?$/, "/address/")}${address}`;
}

function isRecipient(x: unknown): x is Recipient {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.name === "string" && typeof o.address === "string" && isAddress(o.address);
}

/* ------------------------------------------------------------- components */

function Icon({ name }: { name: "user" | "spark" | "shield" | "receipt" }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "user" && (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
        </>
      )}
      {name === "spark" && <path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />}
      {name === "shield" && <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />}
      {name === "receipt" && (
        <>
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </>
      )}
    </svg>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard not available */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <span className="tx">
      <a href={`${EXPLORER}${hash}`} target="_blank" rel="noreferrer" className="tx-view" title={hash}>
        View transaction ↗
      </a>
      <CopyButton text={hash} label="transaction hash" />
    </span>
  );
}

function AddressLine({ label, address }: { label: string; address: string }) {
  const url = addressUrl(address);
  return (
    <div className="addr-line">
      <span className="addr-label">{label}</span>
      <span className="mono addr-text">{address}</span>
      <span className="addr-actions">
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="tx-view">
            View ↗
          </a>
        )}
        <CopyButton text={address} label={label} />
      </span>
    </div>
  );
}

const PIPE = [
  { key: "you", label: "You", sub: "Ask in plain words", icon: "user" },
  { key: "agent", label: "AI agent", sub: "Turns it into a payment", icon: "spark" },
  { key: "contract", label: "Policy contract", sub: "Checks every rule", icon: "shield" },
  { key: "receipt", label: "Receipt", sub: "Recorded on Monad", icon: "receipt" },
] as const;

function Pipeline({ phase, tone }: { phase: "idle" | "sending" | "done"; tone: Tone | null }) {
  return (
    <div className={`pipe ${phase}`} aria-hidden="true">
      {PIPE.map((n, i) => (
        <div key={n.key} className="pipe-seg">
          <div className={`pipe-node ${n.key} ${n.key === "receipt" && phase === "done" && tone ? tone : ""}`}>
            <span className="pipe-icon"><Icon name={n.icon} /></span>
            <span className="pipe-label">{n.label}</span>
            <span className="pipe-sub">{n.sub}</span>
          </div>
          {i < PIPE.length - 1 && <span className="pipe-link" />}
        </div>
      ))}
    </div>
  );
}

function Ladder({ result }: { result: AgentResult | null }) {
  const failIdx = result ? RULES.findIndex((r) => r.reason === result.reason) : -1;
  return (
    <ol className={`ladder ${result ? "fresh" : ""}`}>
      {RULES.map((r, j) => {
        let status: "idle" | "pass" | "fail" | "hold" | "skip" = "idle";
        if (result) {
          if (failIdx === -1 || j < failIdx) status = "pass";
          else if (j === failIdx) status = r.reason === "NeedsApproval" ? "hold" : "fail";
          else status = "skip";
        }
        const glyph = status === "pass" ? "✓" : status === "fail" ? "✕" : status === "hold" ? "!" : "·";
        const stateText =
          status === "pass" ? "Passed" : status === "fail" ? "Failed" : status === "hold" ? "Needs the owner" : status === "skip" ? "Not reached" : "";
        return (
          <li key={r.reason} className={`rung ${status}`} style={{ "--i": j } as CSSProperties}>
            <span className="mark" aria-hidden="true">{glyph}</span>
            <span className="rung-label">{r.label}</span>
            <span className="rung-state">{stateText}</span>
          </li>
        );
      })}
    </ol>
  );
}

async function getWallet() {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("No wallet found. Install MetaMask and reload the page.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const chainHex = `0x${monadTestnet.id.toString(16)}` as const;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainHex,
          chainName: monadTestnet.name,
          nativeCurrency: monadTestnet.nativeCurrency,
          rpcUrls: monadTestnet.rpcUrls.default.http as string[],
        },
      ],
    });
  }
  return createWalletClient({ account: accounts[0] as `0x${string}`, chain: monadTestnet, transport: custom(eth) });
}

/* ------------------------------------------------------------------- page */

export default function Home() {
  const [input, setInput] = useState("");
  const [lastRequest, setLastRequest] = useState("");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);

  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsErr, setReceiptsErr] = useState("");
  const [receiptsLoaded, setReceiptsLoaded] = useState(false);
  const receiptsCount = useRef(0);
  const [filter, setFilter] = useState<"all" | Tone>("all");

  const [state, setState] = useState<VaultState | null>(null);
  const [stateErr, setStateErr] = useState("");
  const [allowedMap, setAllowedMap] = useState<Record<string, boolean>>({});
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const recipientsRef = useRef<Recipient[]>([]);

  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState("");
  const [ownerErr, setOwnerErr] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [deskOpen, setDeskOpen] = useState(false);
  const [setupPref, setSetupPref] = useState<boolean | null>(null);

  const [addName, setAddName] = useState("");
  const [addAddr, setAddAddr] = useState("");
  const [fundAmt, setFundAmt] = useState("1000");
  const [pTx, setPTx] = useState("");
  const [pDaily, setPDaily] = useState("");
  const [pThresh, setPThresh] = useState("");

  const isOwner = !!wallet && !!state && wallet.toLowerCase() === state.owner.toLowerCase();

  /* ----- data loading ----- */

  const loadState = useCallback(async () => {
    if (!VAULT) return;
    try {
      const read = <T extends string>(functionName: T) =>
        publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName } as never) as Promise<unknown>;
      const [policy, paused, remaining, balance, owner, agent] = await Promise.all([
        read("policy"),
        read("paused"),
        read("remainingToday"),
        read("vaultBalance"),
        read("owner"),
        read("agent"),
      ]);
      const p = policy as readonly [bigint, bigint, bigint, bigint];
      setState({
        perTx: p[0],
        daily: p[1],
        threshold: p[2],
        paused: paused as boolean,
        remaining: remaining as bigint,
        balance: balance as bigint,
        owner: owner as string,
        agent: agent as string,
      });
      setStateErr("");
    } catch (e) {
      setStateErr(errText(e));
    }
  }, []);

  const loadAllowed = useCallback(async () => {
    if (!VAULT) return;
    const list = recipientsRef.current;
    if (list.length === 0) {
      setAllowedMap({});
      return;
    }
    try {
      const flags = await Promise.all(
        list.map((r) =>
          publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "allowed", args: [r.address as `0x${string}`] }),
        ),
      );
      setAllowedMap(Object.fromEntries(list.map((r, i) => [r.address.toLowerCase(), Boolean(flags[i])])));
    } catch {
      /* the recipient list is a convenience; the rest of the page still works */
    }
  }, []);

  const loadReceipts = useCallback(async () => {
    if (!VAULT) return;
    try {
      const res = await fetch("/api/receipts", { cache: "no-store" });
      const json = (await res.json()) as { receipts?: Receipt[]; error?: string };
      if (!res.ok || !json.receipts) throw new Error(json.error ?? "Could not load receipts");
      receiptsCount.current = json.receipts.length;
      setReceipts(json.receipts);
      setReceiptsErr("");
      setReceiptsLoaded(true);
    } catch (e) {
      // A flaky public RPC should not wipe the list. Keep what we have and only complain if there is nothing to show.
      if (receiptsCount.current === 0) setReceiptsErr(errText(e));
      setReceiptsLoaded(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadState(), loadAllowed(), loadReceipts()]);
  }, [loadState, loadAllowed, loadReceipts]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const clean = parsed.filter(isRecipient);
          recipientsRef.current = clean;
          setRecipients(clean);
        }
      }
    } catch {
      /* storage unavailable */
    }
    const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (eth) {
      eth
        .request({ method: "eth_accounts" })
        .then((accts) => {
          const first = (accts as string[])[0];
          if (first) setWallet(first);
        })
        .catch(() => undefined);
    }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadAllowed();
  }, [recipients, loadAllowed]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  function saveRecipients(next: Recipient[]) {
    recipientsRef.current = next;
    setRecipients(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  }

  /* ----- derived data ----- */

  const nameOf = useCallback(
    (address: string) => recipients.find((r) => r.address.toLowerCase() === address.toLowerCase())?.name ?? short(address),
    [recipients],
  );

  // One entry per attempt. Receipts arrive newest first, so the first one for an id is its latest state.
  const attempts = useMemo(() => {
    const groups = new Map<string, Receipt[]>();
    for (const r of receipts) {
      const g = groups.get(r.id) ?? [];
      g.push(r);
      groups.set(r.id, g);
    }
    return Array.from(groups.entries()).map(([id, list]) => ({
      id,
      latest: list[0],
      intent: [...list].reverse().find((x) => x.intent)?.intent ?? "",
      wasHeld: list.some((x) => x.outcome === "Pending"),
    }));
  }, [receipts]);

  const counts = useMemo(() => {
    const c = { pass: 0, fail: 0, hold: 0 };
    for (const a of attempts) c[toneOf(a.latest.outcome)] += 1;
    return c;
  }, [attempts]);

  const visibleAttempts = attempts.filter((a) => filter === "all" || toneOf(a.latest.outcome) === filter);

  const pendingList = attempts.filter((a) => a.latest.outcome === "Pending");

  const allowedRecipients = recipients.filter((r) => allowedMap[r.address.toLowerCase()]);

  const amounts = useMemo(() => {
    const perTx = state ? Number(fmt(state.perTx)) : 100;
    const thr = state ? Number(fmt(state.threshold)) : 50;
    const small = Math.max(1, Math.min(20, Math.floor(thr / 2) || 1));
    const hold = thr < perTx ? Math.floor((thr + perTx) / 2) : 0;
    const over = Math.ceil(perTx * 5);
    return { small, hold, over };
  }, [state]);

  const demoName = allowedRecipients[0]?.name ?? recipients[0]?.name ?? "Freelancer";
  const scenarios: { text: string; hint: string; tone: Tone }[] = [
    { text: `Pay ${amounts.small} to ${demoName}`, hint: "Small payment to an allowed person", tone: "pass" },
    ...(amounts.hold > 0
      ? [{ text: `Pay ${amounts.hold} to ${demoName}`, hint: "Big enough to need your approval", tone: "hold" as Tone }]
      : []),
    { text: `Pay ${amounts.over} to ${demoName}`, hint: "Over the per-payment limit", tone: "fail" },
    { text: "Send 500 to 0x9999999999999999999999999999999999999999", hint: "Someone you never allowed", tone: "fail" },
  ];

  const usedPct =
    state && state.daily > 0n ? Math.min(100, Math.max(0, Number(((state.daily - state.remaining) * 100n) / state.daily))) : 0;

  const phase: "idle" | "sending" | "done" = sending ? "sending" : result ? "done" : "idle";
  const resultTone: Tone | null = result ? toneOf(result.outcome) : null;

  /* ----- actions ----- */

  async function send(text: string) {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setInput("");
    setLastRequest(t);
    setResult(null);
    setNotice("");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: t, contacts: recipientsRef.current }),
      });
      const json = (await res.json()) as AgentResult | { kind: "reply"; reply: string } | { kind: "error"; error: string };
      if (json.kind === "result") {
        setResult(json);
        void refresh();
      } else if (json.kind === "reply") {
        setNotice(json.reply);
      } else {
        setNotice(`Something went wrong: ${json.error}`);
      }
    } catch (e) {
      setNotice(`Something went wrong: ${errText(e)}`);
    } finally {
      setSending(false);
    }
  }

  function clearResult() {
    setResult(null);
    setNotice("");
    setLastRequest("");
    setTimeout(() => {
      const el = document.getElementById("req") as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
    }, 50);
  }

  async function connect() {
    setOwnerErr("");
    try {
      const w = await getWallet();
      setWallet(w.account.address);
      setToast({ text: `Connected ${short(w.account.address)}`, tone: "pass" });
    } catch (e) {
      setOwnerErr(errText(e));
    }
  }

  async function ownerTx(
    label: string,
    successText: string,
    run: (w: Awaited<ReturnType<typeof getWallet>>) => Promise<`0x${string}`[]>,
  ) {
    setBusy(label);
    setOwnerErr("");
    try {
      const w = await getWallet();
      setWallet(w.account.address);
      if (state && w.account.address.toLowerCase() !== state.owner.toLowerCase()) {
        throw new Error(`MetaMask is on ${short(w.account.address)}, which is not the vault owner. Switch to ${short(state.owner)} and try again.`);
      }
      const hashes = await run(w);
      for (const h of hashes) await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
      setToast({ text: successText, tone: "pass" });
    } catch (e) {
      const msg = errText(e);
      setOwnerErr(msg);
      setToast({ text: msg, tone: "fail" });
    } finally {
      setBusy("");
      setProgress("");
    }
  }

  const vault = VAULT as `0x${string}`;

  const allowAddress = (addr: string, successText: string) =>
    ownerTx(`allow-${addr}`, successText, async (w) => {
      if (!isAddress(addr)) throw new Error("Enter a full 0x address.");
      return [await w.writeContract({ address: vault, abi: vaultAbi, functionName: "setAllowed", args: [addr, true] })];
    });

  async function addRecipient() {
    const name = addName.trim();
    const addr = addAddr.trim();
    if (!name || name.length > 30) {
      setOwnerErr("Give the recipient a short name, up to 30 characters.");
      return;
    }
    if (!isAddress(addr)) {
      setOwnerErr("Enter the full 0x wallet address of the recipient.");
      return;
    }
    setOwnerErr("");
    saveRecipients([...recipients.filter((r) => r.address.toLowerCase() !== addr.toLowerCase()), { name, address: addr }]);
    setAddName("");
    setAddAddr("");
    await allowAddress(addr, `${name} can now be paid by the agent`);
  }

  const togglePause = () =>
    ownerTx("pause", state?.paused ? "Kill switch is off. The agent can act again." : "Agent frozen. Every request will be denied.", async (w) => [
      await w.writeContract({ address: vault, abi: vaultAbi, functionName: "setPaused", args: [!state?.paused] }),
    ]);

  const decide = (id: string, approve: boolean) =>
    ownerTx(`decide-${id}`, approve ? "Approved. The payment was sent." : "Rejected. Nothing was sent.", async (w) => [
      await w.writeContract({ address: vault, abi: vaultAbi, functionName: approve ? "approve" : "reject", args: [BigInt(id)] }),
    ]);

  const savePolicy = () =>
    ownerTx("policy", "New limits saved on-chain", async (w) => {
      const perTx = parseUnits(pTx || "0", TOKEN_DECIMALS);
      const daily = parseUnits(pDaily || "0", TOKEN_DECIMALS);
      const thresh = parseUnits(pThresh || "0", TOKEN_DECIMALS);
      return [await w.writeContract({ address: vault, abi: vaultAbi, functionName: "setPolicy", args: [perTx, daily, thresh, 0n] })];
    });

  const fundVault = () =>
    ownerTx("fund", `Vault funded with ${fundAmt} test tokens`, async (w) => {
      if (!TOKEN) throw new Error("NEXT_PUBLIC_TOKEN_ADDRESS is not set.");
      const amount = parseUnits(fundAmt || "0", TOKEN_DECIMALS);
      setProgress("Step 1 of 3: getting test tokens. Confirm in MetaMask.");
      const h1 = await w.writeContract({ address: TOKEN, abi: mockUsdcAbi, functionName: "faucet" });
      await publicClient.waitForTransactionReceipt({ hash: h1 });
      setProgress("Step 2 of 3: letting the vault receive them. Confirm in MetaMask.");
      const h2 = await w.writeContract({ address: TOKEN, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      setProgress("Step 3 of 3: depositing into the vault. Confirm in MetaMask.");
      const h3 = await w.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [amount] });
      return [h3];
    });

  function focusId(id: string, openDesk?: boolean) {
    if (openDesk) setDeskOpen(true);
    setTimeout(() => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
    }, 80);
  }

  /* ----- setup guide ----- */

  const funded = !!state && state.balance > 0n;
  const hasRecipient = allowedRecipients.length > 0;
  const asked = attempts.length > 0 || !!result;

  const steps = [
    {
      key: "wallet",
      title: "Connect the owner wallet",
      done: isOwner,
      hint: isOwner
        ? `Connected as ${short(wallet)}`
        : wallet && state
          ? `Switch MetaMask to the owner, ${short(state.owner)}`
          : "Use the wallet that deployed the vault.",
      cta: "Connect wallet",
      action: connect,
    },
    {
      key: "fund",
      title: "Fund the vault",
      done: funded,
      hint: funded && state ? `${fmt(state.balance)} test tokens inside` : "Mint test tokens and deposit them. MetaMask asks three times.",
      cta: `Fund with ${fundAmt || "0"}`,
      action: fundVault,
    },
    {
      key: "recipient",
      title: "Add a recipient",
      done: hasRecipient,
      hint: hasRecipient ? `Allowed: ${allowedRecipients.map((r) => r.name).join(", ")}` : "Name and wallet address of someone the agent may pay.",
      cta: "Add a recipient",
      action: () => focusId("add-name", true),
    },
    {
      key: "ask",
      title: "Ask the agent to pay",
      done: asked,
      hint: asked ? `${attempts.length} request${attempts.length === 1 ? "" : "s"} recorded on-chain` : "Pick an example on the board, or type your own.",
      cta: "Try a request",
      action: () => focusId("req"),
    },
  ];
  const currentIdx = steps.findIndex((s) => !s.done);
  const allDone = currentIdx === -1;
  const setupOpen = setupPref ?? !allDone;
  const setSetupOpen = (v: boolean) => setSetupPref(v);

  /* ----- render ----- */

  useEffect(() => {
    if (!deskOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDeskOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deskOpen]);

  const showTrace = sending || !!result;

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand">TrustPilot</div>
          <span className="pill"><span className="pill-dot" />Monad Testnet</span>
        </div>
        <div className="topbar-right">
          {wallet ? (
            <span className={`pill wallet ${isOwner ? "owner" : "guest"}`} title={wallet}>
              <span className="wallet-dot" />
              <span className="wallet-role">{isOwner ? "Owner connected" : state ? "Not the owner" : "Wallet connected"}</span>
            </span>
          ) : (
            <button className="btn btn-sm" onClick={connect}>Connect wallet</button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => setDeskOpen(true)}>
            Owner controls
          </button>
        </div>
      </header>

      {!VAULT && (
        <div className="banner">
          The vault address is not configured. Deploy the contracts, then set NEXT_PUBLIC_VAULT_ADDRESS in .env.local and restart the app.
        </div>
      )}

      <section className="intro">
        <h1 className="headline">Your agent asks. <span className="grad">The contract decides.</span></h1>
        <p className="lede">
          An AI agent can pay from a vault, but only inside the rules you set on-chain. Every request, cleared or denied, leaves a receipt anyone can verify.
        </p>
      </section>

      <section className="setup" aria-label="Setup">
        <button type="button" className="setup-toggle" onClick={() => setSetupOpen(!setupOpen)} aria-expanded={setupOpen}>
          <span className={`setup-state ${allDone ? "ok" : ""}`}>{allDone ? "✓ Setup complete" : "Quick setup"}</span>
          <span className="setup-hide">{setupOpen ? "Hide" : allDone ? "Show setup options" : "Show"}</span>
        </button>
        {setupOpen && (
          <>
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={s.key} className={`step ${s.done ? "done" : i === currentIdx ? "current" : "todo"}`}>
                  <span className="step-mark">{s.done ? "✓" : i + 1}</span>
                  <span className="step-title">{s.title}</span>
                </li>
              ))}
            </ol>
            {currentIdx >= 0 ? (
              <div className="setup-next">
                <span className="setup-next-text">
                  <b>Next:</b> {steps[currentIdx].hint}
                </span>
                <button className="btn btn-primary btn-sm" onClick={steps[currentIdx].action} disabled={!!busy}>
                  {busy && steps[currentIdx].key !== "wallet" ? "Working…" : steps[currentIdx].cta}
                </button>
              </div>
            ) : (
              <div className="setup-next">
                <span className="setup-next-text">Need to change something? You can set up more at any time.</span>
                <span className="row">
                  <button className="btn btn-sm" onClick={() => focusId("add-name", true)}>Add another recipient</button>
                  <button className="btn btn-sm" onClick={() => setDeskOpen(true)}>Fund or change limits</button>
                </span>
              </div>
            )}
          </>
        )}
        {progress && <p className="progress">{progress}</p>}
      </section>

      {/* ---------------- the console ---------------- */}
      <section className="board" aria-label="Agent console">
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <label htmlFor="req" className="ask-label">Ask the agent to pay someone</label>
          <div className="ask-row">
            <input
              id="req"
              className="input-dark input-lg"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`For example: "pay ${amounts.small} to ${demoName}"`}
              disabled={sending}
              autoComplete="off"
            />
            <button className="btn btn-primary btn-lg" type="submit" disabled={sending || !VAULT}>
              {sending ? "Checking…" : "Send request"}
            </button>
          </div>
        </form>

        <div className="scenarios">
          <span className="scenarios-label">Try:</span>
          {scenarios.map((s) => (
            <button key={s.text} type="button" className={`scenario ${s.tone}`} onClick={() => setInput(s.text)} disabled={sending} title={s.hint}>
              {s.text.length > 30 ? `${s.text.slice(0, 27)}…` : s.text}
            </button>
          ))}
        </div>

        <Pipeline phase={phase} tone={resultTone} />

        <div className="understood" aria-live="polite">
          {sending ? (
            <span>Reading: &ldquo;{lastRequest}&rdquo;</span>
          ) : result ? (
            <span>
              Understood as: pay <b>{result.amount}</b> to <b>{nameOf(result.to)}</b>
              <span className="by">{result.parsedBy === "llm" ? "read by an AI model" : "read by built-in rules"}</span>
            </span>
          ) : (
            <span className="muted">The agent turns your words into a payment, then the contract checks every rule on-chain.</span>
          )}
        </div>

        {showTrace && (
          <div className="trace-wrap">
            <div className="trace-bar">
              <span className="trace-title">What the contract checked</span>
              {!sending && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearResult}>
                  Ask another request
                </button>
              )}
            </div>
          <div className="trace">
            <Ladder key={result?.txHash ?? "idle"} result={result} />
            <div className={`verdict ${resultTone ?? "idle"}`} aria-live="polite">
              {sending ? (
                <div className="verdict-word">Checking with the contract…</div>
              ) : result ? (
                <>
                  <div className="verdict-word">
                    {result.outcome === "Executed" ? "Cleared" : result.outcome === "Pending" ? "Held for approval" : "Denied"}
                  </div>
                  <div className="verdict-line">
                    {result.outcome === "Executed" ? `${result.amount} sent to ${nameOf(result.to)}.` : result.explanation}
                  </div>
                  <div className="verdict-meta">
                    <TxLink hash={result.txHash} />
                  </div>
                </>
              ) : null}
            </div>
          </div>
          </div>
        )}

        {notice && (
          <div className="notice">
            {notice}
            {!showTrace && <button type="button" className="notice-x" onClick={() => setNotice("")} aria-label="Dismiss">Dismiss</button>}
          </div>
        )}
      </section>

      {pendingList.length > 0 && (
        <section className="approve-card" aria-label="Waiting for approval">
          <div className="approve-title">
            <span className="dot amber" /> Waiting for your approval
          </div>
          {pendingList.map((a) => (
            <div key={a.id} className="pending-row">
              <div>
                <div className="pending-amt">{a.latest.amount} to {nameOf(a.latest.to)}</div>
                {a.intent && <div className="muted small">&ldquo;{a.intent}&rdquo;</div>}
              </div>
              <div className="row">
                <button className="btn btn-ok btn-sm" disabled={!!busy} onClick={() => decide(a.id, true)}>Approve</button>
                <button className="btn btn-bad btn-sm" disabled={!!busy} onClick={() => decide(a.id, false)}>Reject</button>
              </div>
            </div>
          ))}
          {!isOwner && <p className="muted small">Approving needs the owner wallet. Connect it with the button at the top.</p>}
          {ownerErr && <div className="err">{ownerErr}</div>}
        </section>
      )}

      {/* ---------------- stats ---------------- */}
      <section className="stats" aria-label="Summary">
        <button type="button" className={`stat pass ${filter === "pass" ? "on" : ""}`} onClick={() => setFilter(filter === "pass" ? "all" : "pass")}>
          <span className="stat-n">{counts.pass}</span>
          <span className="stat-k">Cleared</span>
        </button>
        <button type="button" className={`stat fail ${filter === "fail" ? "on" : ""}`} onClick={() => setFilter(filter === "fail" ? "all" : "fail")}>
          <span className="stat-n">{counts.fail}</span>
          <span className="stat-k">Denied</span>
        </button>
        <button type="button" className={`stat hold ${filter === "hold" ? "on" : ""}`} onClick={() => setFilter(filter === "hold" ? "all" : "hold")}>
          <span className="stat-n">{counts.hold}</span>
          <span className="stat-k">Held</span>
        </button>
        <div className="stat gauge-stat">
          <div className="gauge" style={{ "--p": usedPct } as CSSProperties} role="img" aria-label={`${usedPct}% of the daily cap used`}>
            <span className="gauge-n">{usedPct}%</span>
          </div>
          <div>
            <span className="stat-k">Daily cap used</span>
            <div className="gauge-v">{state ? `${fmt(state.daily - state.remaining)} / ${fmt(state.daily)}` : "…"}</div>
          </div>
        </div>
        <div className="stat">
          <span className="stat-n small-n">{state ? fmt(state.balance) : "…"}</span>
          <span className="stat-k">Vault balance</span>
        </div>
      </section>

      {/* ---------------- receipts + rules ---------------- */}
      <div className="lower">
        <section aria-label="Receipts" className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Receipts on Monad</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>Refresh</button>
          </div>
          <div className="filters" role="group" aria-label="Filter receipts">
            {(["all", "pass", "fail", "hold"] as const).map((f) => (
              <button key={f} type="button" className={`filter ${f} ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "pass" ? "Cleared" : f === "fail" ? "Denied" : "Held"}
              </button>
            ))}
          </div>
          {receiptsErr && <div className="err">{receiptsErr}</div>}
          {!receiptsLoaded ? (
            <div className="empty">Reading receipts from Monad…</div>
          ) : visibleAttempts.length === 0 && !receiptsErr ? (
            <div className="empty">
              {attempts.length === 0
                ? "No requests yet. Ask the agent to pay someone and the contract's decision shows up here."
                : "No receipts match this filter."}
            </div>
          ) : (
            <ul className="strips">
              {visibleAttempts.slice(0, 50).map((a) => {
                const r = a.latest;
                const word =
                  r.outcome === "Executed"
                    ? a.wasHeld ? "Cleared after approval" : "Cleared"
                    : r.outcome === "Pending"
                      ? "Held"
                      : r.outcome === "Rejected"
                        ? "Rejected by you"
                        : "Denied";
                return (
                  <li key={a.id} className={`strip ${toneOf(r.outcome)}`}>
                    <div className="strip-top">
                      <span className="strip-word">{word}</span>
                      <span className="strip-amt">{r.amount}</span>
                      <span className="strip-to">to {nameOf(r.to)}</span>
                      <span className="strip-meta"><TxLink hash={r.txHash} /></span>
                    </div>
                    <p className="strip-why">{r.explanation}</p>
                    {a.intent && <p className="strip-intent">&ldquo;{a.intent}&rdquo;</p>}
                  </li>
                );
              })}
            </ul>
          )}
          
        </section>

        <section aria-label="Rules" className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Rules in force</h2>
          </div>
          {state ? (
            <ul className="rule-list">
              <li>
                <span className="dot violet" />
                <div>
                  Pays only people you allow
                  <div className="chips">
                    {allowedRecipients.length > 0 ? (
                      allowedRecipients.map((r) => <span key={r.address} className="chip">{r.name}</span>)
                    ) : (
                      <span className="muted">nobody yet</span>
                    )}
                  </div>
                </div>
              </li>
              <li>
                <span className="dot cyan" />
                <div>Up to <b>{fmt(state.perTx)}</b> per payment</div>
              </li>
              <li>
                <span className="dot cyan" />
                <div className="grow">
                  Up to <b>{fmt(state.daily)}</b> per day
                  <div className="bar"><div className="bar-fill" style={{ width: `${usedPct}%` }} /></div>
                </div>
              </li>
              <li>
                <span className="dot amber" />
                <div>Above <b>{fmt(state.threshold)}</b> waits for your approval</div>
              </li>
              <li>
                <span className={`dot ${state.paused ? "coral" : "green"}`} />
                <div>Kill switch <b className={state.paused ? "t-fail" : "t-pass"}>{state.paused ? "ON, agent frozen" : "off"}</b></div>
              </li>
            </ul>
          ) : (
            <p className="muted">{stateErr || "Loading the rules from the contract…"}</p>
          )}
        </section>
      </div>

      <footer className="onchain">
        <div className="onchain-title">Built on Monad</div>
        <p className="onchain-text">
          Rules, funds and receipts live in one contract. The agent holds a separate key that can only ask. Low fees make it cheap to record every attempt, including refused ones.
        </p>
        <div className="addr-grid">
          {VAULT && <AddressLine label="Policy vault" address={VAULT} />}
          {TOKEN && <AddressLine label="Test token" address={TOKEN} />}
          {state && <AddressLine label="Agent (can only ask)" address={state.agent} />}
          {state && <AddressLine label="Owner" address={state.owner} />}
        </div>
      </footer>

      {/* ---------------- owner drawer ---------------- */}
      {deskOpen && (
        <>
          <div className="scrim" onClick={() => setDeskOpen(false)} />
          <aside className="drawer" role="dialog" aria-label="Owner controls">
            <div className="drawer-head">
              <div>
                <h2 className="panel-title">Owner controls</h2>
                <p className="muted small">Only the owner wallet can do these. Each action opens MetaMask.</p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setDeskOpen(false)} aria-label="Close">Close</button>
            </div>

            {!isOwner && (
              <div className="desk-warn">
                {wallet && state
                  ? `MetaMask is on ${short(wallet)}. Switch to the owner ${short(state.owner)}.`
                  : "Connect the owner wallet first."}
                {!wallet && <button className="btn btn-primary btn-sm" onClick={connect}>Connect wallet</button>}
              </div>
            )}

            <div className="desk-block">
              <div className="desk-h">Recipients</div>
              {recipients.length === 0 && <p className="muted small">No one yet. Add a name and wallet address, and the agent can pay them.</p>}
              {recipients.map((r) => {
                const ok = allowedMap[r.address.toLowerCase()];
                return (
                  <div key={r.address} className="contact-row">
                    <div>
                      <div className="contact-name">{r.name}</div>
                      <div className="mono muted">{short(r.address)}</div>
                    </div>
                    {ok ? (
                      <span className="state-ok">Allowed</span>
                    ) : (
                      <div className="row">
                        <span className="muted small">Not allowed yet</span>
                        <button className="btn btn-sm" disabled={!!busy} onClick={() => allowAddress(r.address, `${r.name} can now be paid by the agent`)}>Allow</button>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="add-grid">
                <input id="add-name" className="input-dark" type="text" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Name, e.g. Freelancer" maxLength={30} />
                <input className="input-dark" type="text" value={addAddr} onChange={(e) => setAddAddr(e.target.value)} placeholder="Wallet address, 0x…" />
                <button className="btn btn-primary" disabled={!!busy} onClick={addRecipient}>Add and allow</button>
              </div>
            </div>

            <div className="desk-block">
              <div className="desk-h">Fund the vault</div>
              <p className="muted small">Mints free test tokens, then deposits them. MetaMask asks three times.</p>
              <div className="row">
                <input className="input-dark grow" type="number" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} aria-label="Amount to deposit" />
                <button className="btn btn-primary" disabled={!!busy} onClick={fundVault}>{busy === "fund" ? "Working…" : "Fund"}</button>
              </div>
              {progress && <p className="progress">{progress}</p>}
            </div>

            <div className="desk-block">
              <details className="limits-form">
                <summary>Change the limits</summary>
                <p className="muted small">Amounts are in test tokens. The approval threshold cannot be above the per-payment limit.</p>
                <div className="limit-grid">
                  <input className="input-dark" type="number" value={pTx} onChange={(e) => setPTx(e.target.value)} placeholder="Per payment" />
                  <input className="input-dark" type="number" value={pDaily} onChange={(e) => setPDaily(e.target.value)} placeholder="Daily cap" />
                  <input className="input-dark" type="number" value={pThresh} onChange={(e) => setPThresh(e.target.value)} placeholder="Approval above" />
                  <button className="btn btn-sm" disabled={!!busy} onClick={savePolicy}>Save limits</button>
                </div>
              </details>
            </div>

            <div className="desk-block">
              <div className="desk-h">Kill switch</div>
              <p className="muted small">Freezes the agent at once. Every request is denied until you turn it off.</p>
              <button className={`btn ${state?.paused ? "btn-ok" : "btn-bad"}`} disabled={!!busy || !state} onClick={togglePause}>
                {state?.paused ? "Turn the kill switch off" : "Freeze the agent"}
              </button>
            </div>

            {ownerErr && <div className="err">{ownerErr}</div>}
          </aside>
        </>
      )}

      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </main>
  );
}
