<script>
  /*
   * Only what every screen genuinely shares lives here. The design family's
   * stylesheet does NOT: home defines its own token packs and never linked
   * family.css, so importing it globally imposed rules home was never written
   * against. Each family screen imports it for itself.
   *
   * The mockups pull Space Grotesk from fonts.googleapis.com. Self-hosted
   * here instead: identical typeface, no third-party request from a
   * self-hosted product. Weights 500 and 600 are the two the designs use.
   */
  import "@fontsource/space-grotesk/500.css";
  import "@fontsource/space-grotesk/600.css";

  let { children } = $props();
</script>

{@render children()}
