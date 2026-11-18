export const ADMINISTRATOR_LOCK_KEY = "orbit:administrators";
export const ACCOUNT_LIFECYCLE_LOCK_KEY = "orbit:account-lifecycle";
export const INSTANCE_BOOTSTRAP_LOCK_KEY = "orbit:first-administrator";

export function householdOwnerLockKey(householdId: string): string {
  return `orbit:household-owner:${householdId}`;
}

/**
 * The per-user lock over a member's registered address and everything sent
 * to it: setup and recovery links (#1151 A1-R4), sign-in approvals and the
 * address change itself (#1869). The key keeps its original name so a
 * running instance and an upgraded one agree on it.
 */
export function userAddressLockKey(userId: string): string {
  return `orbit:setup-token:${userId}`;
}
