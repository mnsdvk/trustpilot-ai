// Generates a fresh TESTNET-ONLY key for the agent wallet.
// Run with: npm run agent-key   (after npm install)
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

console.log("");
console.log("Agent wallet address (give this to the PolicyVault constructor):");
console.log("  " + account.address);
console.log("");
console.log("Agent private key (put in .env.local as AGENT_PRIVATE_KEY, never share it):");
console.log("  " + key);
console.log("");
console.log("This wallet needs a little testnet MON for gas. Send some from MetaMask.");
console.log("");
