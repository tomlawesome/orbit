export const ADMINISTRATOR_LOCK_KEY = "orbit:administrators";
export const ACCOUNT_LIFECYCLE_LOCK_KEY = "orbit:account-lifecycle";

export function householdOwnerLockKey(householdId: string): string {
  return `orbit:household-owner:${householdId}`;
}
