ALTER TABLE "documents" ALTER COLUMN "content_sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_sha256_sealed" text;