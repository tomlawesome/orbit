-- The item id a document's ciphertext was sealed under (its encryption
-- context). A staged upload has no item yet, so the id it was sealed under is
-- kept beside it and binding checks it. Existing rows stay null and are read
-- under item_id as before (#1316).
ALTER TABLE "documents" ADD COLUMN "sealed_item_id" uuid;
