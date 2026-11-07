<script>
  /*
   * The ring card's frame (#1356): the glass, its stroke and the orbit, said
   * once for the sign-in card and the setup page. `word` adds the phone-only
   * "orbit" mark the claim card keeps (door-phone.css). `stroke` names another
   * class for the stroke box where a page draws the line differently: the
   * approve page's `pocketstroke`, drawn on the phone alone (#1703).
   */
  let { word = false, stroke = "" } = $props();
</script>

<div class="bigring" aria-hidden="true">
  <div class="ringglass"></div>
  <!-- the ring's line, on its own unblurred box (#873): the glass
       closes on the compositor, this closes by width/height so the
       4.2px stroke never thins. See ringcard.css. -->
  {#if stroke}<div class={stroke}></div>{:else}<div class="ringstroke"></div>{/if}
  <div class="ringorbit"><b class="trail"></b><i></i></div>
  {#if word}<div class="ringword">orbit</div>{/if}
</div>
