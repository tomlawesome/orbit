export interface MissingDocumentSnapshot {
  documentId: string;
  householdId: string;
  itemId: string | null;
}

export interface MissingDocumentReconciliationTransaction {
  readCurrentLifecycle(documentId: string): Promise<string | undefined>;
  rejectAvailableDocument(snapshot: MissingDocumentSnapshot): Promise<boolean>;
}

export interface MissingDocumentReconciliationDriver {
  withDocumentLock<T>(
    documentId: string,
    work: (transaction: MissingDocumentReconciliationTransaction) => Promise<T>,
  ): Promise<T>;
}

export async function reconcileMissingDocument(
  snapshot: MissingDocumentSnapshot,
  driver: MissingDocumentReconciliationDriver,
): Promise<"rejected" | "preserved"> {
  return driver.withDocumentLock(snapshot.documentId, async (transaction) => {
    const lifecycle = await transaction.readCurrentLifecycle(snapshot.documentId);
    if (lifecycle !== "available") return "preserved";
    return await transaction.rejectAvailableDocument(snapshot) ? "rejected" : "preserved";
  });
}
