<script>
  /*
   * Only what every screen genuinely shares lives here. The design family's
   * stylesheet does NOT: home defines its own token packs and never linked
   * family.css, so importing it globally imposed rules home was never written
   * against. Each family screen imports it for itself.
   *
   * All three of the design's typefaces are self-hosted: no request leaves the
   * machine, which a self-hosted product requires. All are OFL-1.1.
   *
   * Space Grotesk is --display. The mockups fetched it from
   * fonts.googleapis.com; identical typeface, served from the bundle instead.
   * Weights 500 and 600 are the two the designs use.
   *
   * Inter (--ui) and JetBrains Mono (--mono) are named first in the font
   * stacks but were never fetched by the mockups, so until now they fell back
   * to whatever face the viewer's machine happened to offer - a different
   * design on every device, and on a bare Linux host not a Latin face anyone
   * chose. Variable rather than static cuts: the design asks for weights 400,
   * 500, 520, 560 and 600, and 520 and 560 exist only on a variable axis.
   */
  /* The theme packs, for every screen rather than only home (#433). Imported
     before the faces so a pack's tokens are defined by the time anything
     reads them. */
  import "$lib/packs.css";
  import "$lib/atmosphere.css";
  import "../app.css";
  /* The pocket's type, spacing and motion tokens (#1120): custom properties
     only, so nothing moves until a screen reads them. */
  import "$lib/pocket/tokens.css";
  import "$lib/pocket/kit.css";

  import "@fontsource/space-grotesk/500.css";
  import "@fontsource/space-grotesk/600.css";
  import "@fontsource-variable/inter";
  import "@fontsource-variable/jetbrains-mono";

  /* The first-run walk (#752). Here rather than on /home because stops 6 and
     7 are on other screens: mounted in the layout it survives the navigation
     between them. It starts itself, once, on a first landing on /home, and
     renders nothing at all until then — see Tour.svelte. */
  import Tour from "$lib/tour/Tour.svelte";
  /* The what's-new card (#1618): beside the film, once for desk and pocket.
     It acts only on /home and waits while the film is showing. */
  import WhatsNew from "$lib/whats-new/WhatsNew.svelte";
  /* The wake (#1120): the pocket's one toast. Mounted once here so any screen
     can raise one through $lib/pocket/wake.js; empty until one does. */
  import Wake from "$lib/pocket/Wake.svelte";
  /* A slow arrival at a screen that says so (#1465): About, for now. */
  import NavigationBusy from "$lib/NavigationBusy.svelte";

  import { onMount } from "svelte";
  import { page, updated } from "$app/state";
  import { beforeNavigate, goto } from "$app/navigation";
  import { anyUnsaved, markLeaving, unsavedAsker } from "$lib/unsaved.js";
  import { reloadWhenUpdated } from "$lib/reload-when-updated.js";
  import { readSession, savePreferences } from "$lib/data/workspace.js";
  import { applyTheme } from "$lib/theme-swatches.js";
  import { applyTextSize } from "$lib/text-size.js";
  import { decideSync, markSynced, readCache } from "$lib/preferences-sync.js";
  import { picksMade } from "$lib/pick.js";

  let { children } = $props();

  /* The one guard for every navigation (#1879 W-S1): typed text asks the discard question first; a new app version found by kit's polling makes the next navigation load the whole page (#1738 A-F1). */
  beforeNavigate((navigation) => {
    reloadWhenUpdated(navigation, updated, (href) => { location.href = href; }, {
      isDirty: anyUnsaved,
      ask: () => confirm("Discard this entry? What you've typed will be lost."),
      holderAsk: unsavedAsker(),
      leaving: markLeaving,
    }, (href) => goto(href).catch(() => { /* a refused navigation leaves the page as it was */ }));
  });

  /* The server is the source of truth for theme and text size (#1180);
     localStorage is only the pre-paint cache of it (app.html). Once the
     session is read, both are applied and the cache refreshed. Read only for
     a signed-in reader: the session route answers 401 to anyone else, and
     the signed-out door keeps using the cache. A failed read changes nothing. */
  onMount(async () => {
    if (!page.data?.signedIn) return;
    try {
      const picksBefore = picksMade();
      const session = await readSession();
      /* A pick made while the read was in flight is newer than the server. */
      if (picksMade() !== picksBefore) return;
      const user = /** @type {{ themeId?: string, textSize?: string } | undefined} */ (session.user ?? undefined);
      if (!user) return;
      /* user.themeId and user.textSize cannot say "never chosen" (see
         preferences-sync.js): a default on the server beside a different cached
         choice, on a browser that has not synced, keeps the cache and sends it up. */
      const decision = decideSync(user, readCache());
      applyTheme(decision.theme);
      applyTextSize(decision.textSize);
      if (decision.push) await savePreferences(decision.push);
      markSynced();
    } catch { /* keep the cached look */ }
  });
</script>

{@render children()}
<Tour />
<WhatsNew />
<Wake />
<NavigationBusy />

<style>
  /* A theme change crossfades rather than snapping, on every screen (review
     round §1.4): the desk's own body transition, which several screens set
     for themselves, held here once for the ones that do not. */
  :global(body){transition:background .4s,color .4s}
  @media (prefers-reduced-motion:reduce){ :global(body){transition:none} }
</style>
