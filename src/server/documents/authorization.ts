/** Central document policy: instance administrators or current household members. */
export function canAccessHouseholdDocuments(
  isInstanceAdministrator: boolean,
  membershipUserId: string | null | undefined,
): boolean {
  return isInstanceAdministrator || Boolean(membershipUserId);
}

/**
 * Queueing a document for deletion, or undoing that, is narrower than
 * ordinary household access: only the household owner or the member who
 * uploaded the document may do it (#1151 A3-S1, owner decision 2026-10-03,
 * option a). An ordinary member who merely shares the household must not be
 * able to purge or restore another member's upload.
 */
export function canManageDocumentDeletion(
  isInstanceAdministrator: boolean,
  membershipRole: "owner" | "member" | null | undefined,
  isUploader: boolean,
): boolean {
  return isInstanceAdministrator || membershipRole === "owner" || isUploader;
}
