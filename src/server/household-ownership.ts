import { AppError } from "@/lib/app-error";

export interface HouseholdRole {
  userId: string;
  role: "owner" | "member";
}

export interface OwnershipTransferPlan {
  previousOwnerUserId: string;
  nextOwnerUserId: string;
  changed: boolean;
}

/** Validates a transfer against the membership state read under the DB lock. */
export function planOwnershipTransfer(
  members: HouseholdRole[],
  actorUserId: string,
  nextOwnerUserId: string,
  actorIsAdministrator: boolean,
): OwnershipTransferPlan {
  const currentOwner = members.find((member) => member.role === "owner");
  const nextOwner = members.find((member) => member.userId === nextOwnerUserId);

  if (!currentOwner) {
    throw new AppError("owner_missing", "This household has no current owner", 409);
  }
  if (!actorIsAdministrator && currentOwner.userId !== actorUserId) {
    throw new AppError("owner_required", "Only the current household owner can transfer ownership", 403);
  }
  if (!nextOwner) {
    throw new AppError("member_not_found", "Ownership can only be transferred to an existing household member", 409);
  }

  return {
    previousOwnerUserId: currentOwner.userId,
    nextOwnerUserId,
    changed: currentOwner.userId !== nextOwnerUserId,
  };
}
