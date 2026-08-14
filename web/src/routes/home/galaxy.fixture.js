/**
 * The households the chart draws, in the shape design/v19/home.html hardcoded.
 *
 * This is the seam. The mockup fixed these values; the product will load them
 * for the signed-in user. Keeping the exact mockup values here first means the
 * visual gate can prove the rendering path is faithful before real data is
 * introduced — with real data the screen legitimately differs from the design,
 * so that comparison has to happen while the inputs still match.
 *
 * Coordinates are absolute positions in a shared map (CON-13, the fixed
 * galaxy): a household's place never changes, so flights animate between two
 * truths and never snap. Product cap is five.
 */
export const GALAXY_FIXTURE = {
  lawson:  { name:"Lawson Home",     pos:[0,0],
             planets:[[22,-20,2.8,"--warm"],[-22,18,2.2,"--ok"],[14,26,2.2,"--ok"]] },
  seaside: { name:"Seaside Cottage", pos:[-620,-300],
             planets:[[22,-20,2.8,"--warm"],[-22,18,2.2,"--ok"],[14,26,2.2,"--ok"]] },
  mumdad:  { name:"Mum & Dad’s", pos:[450,520],
             planets:[[18,-18,2.2,"--ok"],[-20,16,2.4,"--ok"]] },
  narrow:  { name:"The Narrowboat",  pos:[-520,390],
             planets:[[-16,-20,2.4,"--ok"],[24,10,2,"--upcoming"]] },
  grans:   { name:"Gran’s Flat", pos:[720,-180],
             planets:[[20,14,2.6,"--warm"],[-18,-16,2,"--ok"]] },
};
