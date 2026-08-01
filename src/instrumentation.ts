/** Keep the Edge instrumentation graph free of Node-only modules. */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNode } = await import("./instrumentation-node");
  await registerNode();
}
