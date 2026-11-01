/**
 * The sign-in family's card boot (#1356, web-22): the chrome off from the
 * first frame (`showform`, the class ringcard.css keys the ring, the card
 * layer and the login chrome off) and the sky lit on the next one. For a
 * screen nobody arrives at to press Sign in, so there is no gate to hide
 * later: `/setup/[token]` and `/approve/[token]`.
 *
 * SignIn.svelte raises the same class only for what it holds up itself, and
 * the auth error page lights late without a card, so neither uses this.
 *
 * Call it from `onMount`; it returns the teardown.
 *
 * @returns {() => void}
 */
export function showForm() {
  document.body.classList.add("showform");
  const frame = requestAnimationFrame(() => document.body.classList.add("lit"));
  return () => {
    cancelAnimationFrame(frame);
    document.body.classList.remove("showform", "lit");
  };
}
