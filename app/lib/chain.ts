import { createPublicClient, defineChain, http } from "viem";

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

export const monadTestnet = defineChain({
  id: chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(rpcUrl),
});

export const VAULT = process.env.NEXT_PUBLIC_VAULT_ADDRESS as `0x${string}` | undefined;
export const TOKEN = process.env.NEXT_PUBLIC_TOKEN_ADDRESS as `0x${string}` | undefined;
export const TOKEN_DECIMALS = 6;

export function requireVault(): `0x${string}` {
  if (!VAULT || !/^0x[0-9a-fA-F]{40}$/.test(VAULT)) {
    throw new Error("NEXT_PUBLIC_VAULT_ADDRESS is not set. Deploy the contracts, then fill in .env.local.");
  }
  return VAULT;
}
