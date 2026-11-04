// crypto.randomUUID exists only on secure origins (https, localhost); a LAN
// http page lacks it, while getRandomValues works everywhere (#1623).
// getRandomValues is bound once at load; randomUUID is looked up per call.
const fill = crypto.getRandomValues.bind(crypto);

export function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = fill(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
