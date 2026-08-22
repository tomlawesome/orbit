import { Dashboard } from "@/components/dashboard";

/**
 * The retiring engine's workspace, at an address of its own (#410, §15).
 *
 * "/" became the v19 sign-in at the cutover: the owner ratified the login
 * flight verbatim and ruled it ships as THE login screen for every user, so
 * the front door could not stay on this engine. This route is the same
 * dashboard "/" rendered, kept reachable so the acceptance suite that proves
 * documents, mail review, admin operations and the product tour still work
 * has a door to sign in to. It is linked from nowhere in the product and goes
 * when this engine goes.
 */
export default function WorkspacePage() {
  return <Dashboard />;
}
