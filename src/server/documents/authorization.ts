/** Central document policy: instance administrators or current household members. */
export function canAccessHouseholdDocuments(
  isInstanceAdministrator: boolean,
  membershipUserId: string | null | undefined,
): boolean {
  return isInstanceAdministrator || Boolean(membershipUserId);
}
