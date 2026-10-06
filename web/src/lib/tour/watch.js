import { goto } from "$app/navigation";
import { resolve } from "$app/paths";
import { page } from "$app/state";
import { clearTourSeen } from "$lib/data/workspace.js";
import { relaunchTour } from "./relaunch.js";

/**
 * "Watch the tour" (#1189, owner decision 2026-10-02): the one handler behind
 * the control in both account menus and on both settings pages (#753 built
 * the first, on desk settings). Clears `tourSeenAt`, then goes to /home, or,
 * when already there, starts the film in place; see relaunch.js.
 */
export function watchTour() {
  return relaunchTour({
    clearTourSeen,
    navigateHome: () => goto(resolve("/home")),
    onHome: () => page.url.pathname === resolve("/home"),
  });
}
