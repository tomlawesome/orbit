import { PortableArchiveSealer, type EncryptedPortableArchive } from "@/server/portable-archive";

/** The archive file as Orbit's export writes it (#1506): `PortableArchiveSealer`'s bytes, authTag after ciphertext. */
export async function sealedArchiveFile(plaintext: Buffer, passphrase: string, pieceBytes = 65_536): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sealer = new PortableArchiveSealer(passphrase, async (chunk) => { chunks.push(Buffer.from(chunk)); });
  for (let offset = 0; offset < plaintext.length; offset += pieceBytes) await sealer.push(plaintext.subarray(offset, offset + pieceBytes));
  await sealer.finish();
  return Buffer.concat(chunks);
}

/** The same archive as the parsed object (fields in the file's order). */
export async function sealedArchive(plaintext: Buffer, passphrase: string): Promise<EncryptedPortableArchive> {
  return JSON.parse((await sealedArchiveFile(plaintext, passphrase)).toString("utf8")) as EncryptedPortableArchive;
}
