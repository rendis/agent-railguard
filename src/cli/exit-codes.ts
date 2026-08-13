import type { CommandVerdict } from "../interaction/public-output.js";

export function exitCodeForVerdict(verdict: CommandVerdict | string): number {
  switch (verdict) {
    case "READY":
    case "PLAN_READY":
    case "SUCCEEDED":
    case "NO_CHANGES":
    case "ALREADY_INITIALIZED":
      return 0;
    case "INVALID_INPUT":
      return 2;
    case "INVALID_SCOPE":
      return 3;
    case "READINESS_BLOCKED":
      return 4;
    case "BLOCKED":
    case "REJECTED":
      return 5;
    case "CHANGES_AVAILABLE":
      return 6;
    case "ROLLED_BACK":
    case "RECOVERY_REQUIRED":
    case "FAILED":
      return 7;
    case "VERIFICATION_FAILED":
      return 8;
    case "CANCELLED":
      return 130;
    case "INTERNAL_ERROR":
    default:
      return 70;
  }
}
