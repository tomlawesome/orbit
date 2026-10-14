-- #1316 decision 26a. One column, nullable: the identity provider's ID token
-- for this session, sealed under the INSTANCE metadata key (ADR-0024; the same
-- key as users.email) so that sign-out can send it as id_token_hint. Null for a
-- password sign-in and for a token over the 16 KiB bound. Nothing here can
-- encrypt: the key-encryption key is not available to SQL, and no existing row
-- needs a value (a null simply means "no provider hand-off").
ALTER TABLE "sessions" ADD COLUMN "id_token_enc" text;
