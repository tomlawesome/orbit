export const ADMINISTRATOR_LOCK_KEY = "orbit:administrators";
export const ACCOUNT_LIFECYCLE_LOCK_KEY = "orbit:account-lifecycle";
export const INSTANCE_BOOTSTRAP_LOCK_KEY = "orbit:first-administrator";

export function householdOwnerLockKey(householdId: string): string {
  return `orbit:household-owner:${householdId}`;
}
