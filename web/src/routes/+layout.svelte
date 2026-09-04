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

  import "@fontsource/space-grotesk/500.css";
  import "@fontsource/space-grotesk/600.css";
  import "@fontsource-variable/inter";
  import "@fontsource-variable/jetbrains-mono";

  /* The first-run walk (#752). Here rather than on /home because stops 6 and
     7 are on other screens: mounted in the layout it survives the navigation
     between them. It starts itself, once, on a first landing on /home, and
     renders nothing at all until then — see Tour.svelte. */
  import Tour from "$lib/tour/Tour.svelte";

  let { children } = $props();
</script>

{@render children()}
<Tour />
