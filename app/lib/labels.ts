// Mirrors the enums in PolicyVault.sol. Keep the order identical.
export const OUTCOMES = ["Executed", "Blocked", "Pending", "Rejected"] as const;

export const REASONS = [
  "None",
  "Paused",
  "PolicyExpired",
  "RecipientNotAllowed",
  "ExceedsPerTxLimit",
  "ExceedsDailyCap",
  "InsufficientBalance",
  "NeedsApproval",
  "ApprovedByOwner",
  "RejectedByOwner",
] as const;

export const REASON_TEXT: Record<(typeof REASONS)[number], string> = {
  None: "Allowed by every rule in the policy.",
  Paused: "Blocked: the owner's kill switch is on, so the agent cannot move any funds.",
  PolicyExpired: "Blocked: the policy has expired, so the agent has no authority right now.",
  RecipientNotAllowed: "Blocked: this recipient is not on the owner's allowlist.",
  ExceedsPerTxLimit: "Blocked: the amount is above the per-transaction limit.",
  ExceedsDailyCap: "Blocked: this would push today's total above the daily cap.",
  InsufficientBalance: "Blocked: the vault does not hold enough tokens.",
  NeedsApproval: "Held for approval: the amount is above the threshold, so the owner must sign off.",
  ApprovedByOwner: "The owner approved this pending payment and it was executed.",
  RejectedByOwner: "The owner rejected this pending payment. Nothing was sent.",
};

export function outcomeName(n: number | bigint): (typeof OUTCOMES)[number] {
  return OUTCOMES[Number(n)] ?? "Blocked";
}

export function reasonName(n: number | bigint): (typeof REASONS)[number] {
  return REASONS[Number(n)] ?? "None";
}
