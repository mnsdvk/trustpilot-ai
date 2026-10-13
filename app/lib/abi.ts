import { parseAbi } from "viem";

// Hand-written to match contracts/PolicyVault.sol, so no compile artifacts are needed.
export const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function owner() view returns (address)",
  "function agent() view returns (address)",
  "function paused() view returns (bool)",
  "function policy() view returns (uint256 perTxLimit, uint256 dailyCap, uint256 approvalThreshold, uint64 expiry)",
  "function allowed(address) view returns (bool)",
  "function pending(uint256) view returns (address to, uint256 amount, bool open)",
  "function attempts() view returns (uint256)",
  "function remainingToday() view returns (uint256)",
  "function vaultBalance() view returns (uint256)",
  "function preview(address to, uint256 amount) view returns (uint8)",
  "function setPolicy(uint256 perTxLimit, uint256 dailyCap, uint256 approvalThreshold, uint64 expiry)",
  "function setAllowed(address account, bool isAllowed)",
  "function setAgent(address newAgent)",
  "function setPaused(bool isPaused)",
  "function deposit(uint256 amount)",
  "function withdraw(address to, uint256 amount)",
  "function requestPayment(address to, uint256 amount, string intent) returns (uint256 id, uint8 outcome)",
  "function approve(uint256 id)",
  "function reject(uint256 id)",
  "event Receipt(uint256 indexed id, address indexed agent, address indexed to, uint256 amount, uint8 outcome, uint8 reason, string intent)",
  "error NotOwner()",
  "error NotAgent()",
  "error Reentrant()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error BadPolicy()",
  "error NotPending()",
  "error TransferFailed()",
  "error PolicyViolation(uint8 reason)",
]);

// MockUSDC.sol extras (the standard ERC-20 parts come from viem's erc20Abi).
export const mockUsdcAbi = parseAbi(["function faucet()"]);
