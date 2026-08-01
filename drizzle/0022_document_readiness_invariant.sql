DO $$
DECLARE
  unsafe_document_count bigint;
BEGIN
  SELECT count(*) INTO unsafe_document_count
  FROM "documents"
  WHERE "lifecycle" IN ('available', 'pending_deletion')
    AND "scan_status" NOT IN ('clean', 'skipped');
  IF unsafe_document_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('document_openable_scan_status_valid: %s row(s) violate the document readiness invariant and must be resolved before this migration can proceed', unsafe_document_count);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "document_openable_scan_status_valid" CHECK ("lifecycle" NOT IN ('available', 'pending_deletion') OR "scan_status" IN ('clean', 'skipped'));
