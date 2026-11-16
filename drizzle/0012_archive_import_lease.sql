ALTER TABLE "portable_archives" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "portable_archive_imports" ADD COLUMN "lease_renewed_at" timestamp with time zone;