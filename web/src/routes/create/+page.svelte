<script>
  import { onMount } from "svelte";
  import "./create.css";
  import { mountCreate } from "./create.behaviour.js";

  /**
   * New entry — the full form (CON-9: "create = genesis"). Reached from the
   * north-star drawer's "open the full form" link (CON-12), which offers type
   * chips and a drop target for the quick path; this screen is the considered
   * one.
   *
   * The form's own idea is progressive disclosure: it opens as a name, five
   * type chips and a drop target, and only unfolds the rest once you have
   * started. Nothing is assumed and nothing is asked twice.
   *
   * Built from design/family/create.html and owned here from that point on.
   */
  onMount(mountCreate);
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — new entry</title>
</svelte:head>

<div class="sky"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<g fill="var(--star-far, #e9edf8)"><circle cx="173.1" cy="785.9" r="0.56" opacity="0.26"/>
      <circle cx="691.4" cy="78.2" r="0.46" opacity="0.26"/>
      <circle cx="867.1" cy="486.0" r="0.61" opacity="0.24"/>
      <circle cx="771.7" cy="62.0" r="0.76" opacity="0.16"/>
      <circle cx="1354.7" cy="549.0" r="0.86" opacity="0.12"/>
      <circle cx="1131.3" cy="610.5" r="0.91" opacity="0.28"/>
      <circle cx="882.3" cy="592.1" r="0.86" opacity="0.15"/>
      <circle cx="871.9" cy="786.8" r="0.76" opacity="0.21"/>
      <circle cx="1369.3" cy="975.3" r="0.56" opacity="0.11"/>
      <circle cx="981.5" cy="148.5" r="0.98" opacity="0.19"/>
      <circle cx="854.6" cy="817.4" r="0.92" opacity="0.13"/>
      <circle cx="725.4" cy="180.4" r="0.68" opacity="0.13"/>
      <circle cx="1403.2" cy="355.7" r="0.63" opacity="0.28"/>
      <circle cx="1317.4" cy="336.0" r="0.7" opacity="0.23"/>
      <circle cx="300.5" cy="136.2" r="0.91" opacity="0.13"/>
      <circle cx="1132.5" cy="738.0" r="0.75" opacity="0.17"/>
      <circle cx="1372.3" cy="786.5" r="0.44" opacity="0.28"/>
      <circle cx="1018.6" cy="289.3" r="0.5" opacity="0.12"/>
      <circle cx="1298.2" cy="847.9" r="0.61" opacity="0.14"/>
      <circle cx="117.2" cy="414.0" r="0.58" opacity="0.11"/>
      <circle cx="476.3" cy="821.2" r="0.44" opacity="0.18"/>
      <circle cx="822.8" cy="161.8" r="0.42" opacity="0.11"/>
      <circle cx="230.1" cy="974.4" r="0.92" opacity="0.24"/>
      <circle cx="1439.3" cy="325.4" r="0.55" opacity="0.27"/>
      <circle cx="970.1" cy="923.4" r="0.62" opacity="0.18"/>
      <circle cx="1148.6" cy="882.4" r="0.5" opacity="0.15"/>
      <circle cx="21.9" cy="559.6" r="0.95" opacity="0.21"/>
      <circle cx="237.8" cy="691.2" r="0.79" opacity="0.12"/>
      <circle cx="1462.8" cy="659.9" r="0.69" opacity="0.17"/>
      <circle cx="256.8" cy="467.8" r="0.62" opacity="0.15"/>
      <circle cx="1034.2" cy="661.8" r="0.97" opacity="0.29"/>
      <circle cx="745.5" cy="716.2" r="0.63" opacity="0.19"/>
      <circle cx="907.2" cy="981.3" r="0.43" opacity="0.19"/>
      <circle cx="538.3" cy="804.8" r="0.97" opacity="0.19"/>
      <circle cx="127.6" cy="594.4" r="0.75" opacity="0.24"/>
      <circle cx="1242.6" cy="463.3" r="0.73" opacity="0.25"/>
      <circle cx="43.8" cy="240.0" r="0.81" opacity="0.3"/>
      <circle cx="1509.2" cy="281.8" r="0.98" opacity="0.16"/>
      <circle cx="724.4" cy="158.8" r="0.76" opacity="0.18"/>
      <circle cx="1096.1" cy="957.1" r="0.48" opacity="0.23"/>
      <circle cx="962.6" cy="274.2" r="0.42" opacity="0.29"/>
      <circle cx="1112.2" cy="625.2" r="0.46" opacity="0.28"/>
      <circle cx="638.5" cy="465.2" r="0.73" opacity="0.19"/>
      <circle cx="1525.7" cy="467.4" r="0.81" opacity="0.25"/>
      <circle cx="1492.6" cy="170.4" r="0.6" opacity="0.29"/>
      <circle cx="969.8" cy="372.6" r="0.93" opacity="0.12"/>
      <circle cx="405.2" cy="69.1" r="0.8" opacity="0.2"/>
      <circle cx="487.1" cy="439.5" r="0.55" opacity="0.24"/>
      <circle cx="1215.5" cy="381.6" r="0.92" opacity="0.11"/>
      <circle cx="905.1" cy="153.5" r="0.47" opacity="0.21"/>
      <circle cx="139.2" cy="74.2" r="0.48" opacity="0.18"/>
      <circle cx="1328.5" cy="289.0" r="0.47" opacity="0.25"/>
      <circle cx="1307.4" cy="996.1" r="0.43" opacity="0.13"/>
      <circle cx="693.7" cy="991.4" r="0.72" opacity="0.28"/>
      <circle cx="358.8" cy="470.7" r="0.81" opacity="0.15"/>
      <circle cx="835.8" cy="825.0" r="0.89" opacity="0.24"/>
      <circle cx="1326.2" cy="996.0" r="0.76" opacity="0.15"/>
      <circle cx="355.2" cy="56.5" r="0.95" opacity="0.21"/>
      <circle cx="964.5" cy="872.7" r="0.81" opacity="0.18"/>
      <circle cx="937.1" cy="82.2" r="0.55" opacity="0.17"/>
      <circle cx="1271.4" cy="661.4" r="0.76" opacity="0.18"/>
      <circle cx="562.8" cy="384.6" r="0.43" opacity="0.17"/>
      <circle cx="1454.9" cy="815.1" r="0.55" opacity="0.2"/>
      <circle cx="1191.4" cy="200.2" r="0.61" opacity="0.22"/>
      <circle cx="300.5" cy="909.5" r="0.41" opacity="0.28"/>
      <circle cx="1070.7" cy="397.4" r="0.57" opacity="0.27"/>
      <circle cx="1138.5" cy="210.5" r="0.59" opacity="0.12"/>
      <circle cx="1005.9" cy="423.7" r="0.59" opacity="0.24"/>
      <circle cx="406.6" cy="141.8" r="0.88" opacity="0.28"/>
      <circle cx="1291.6" cy="558.6" r="0.83" opacity="0.27"/>
      <circle cx="62.1" cy="299.3" r="0.61" opacity="0.25"/>
      <circle cx="537.6" cy="763.9" r="0.55" opacity="0.29"/>
      <circle cx="696.5" cy="590.5" r="0.78" opacity="0.26"/>
      <circle cx="901.7" cy="211.6" r="0.66" opacity="0.21"/>
      <circle cx="116.0" cy="829.0" r="0.58" opacity="0.28"/>
      <circle cx="595.1" cy="951.0" r="0.83" opacity="0.18"/>
      <circle cx="1122.1" cy="0.3" r="0.45" opacity="0.22"/>
      <circle cx="492.2" cy="406.9" r="0.82" opacity="0.19"/>
      <circle cx="979.7" cy="741.9" r="0.9" opacity="0.12"/>
      <circle cx="1325.8" cy="743.2" r="0.54" opacity="0.12"/>
      <circle cx="309.1" cy="89.4" r="0.74" opacity="0.3"/>
      <circle cx="777.5" cy="276.0" r="0.5" opacity="0.29"/>
      <circle cx="874.4" cy="238.3" r="0.95" opacity="0.18"/>
      <circle cx="1575.5" cy="511.0" r="0.55" opacity="0.14"/>
      <circle cx="26.4" cy="814.2" r="0.6" opacity="0.25"/>
      <circle cx="1346.5" cy="402.3" r="0.71" opacity="0.24"/>
      <circle cx="1028.1" cy="363.0" r="0.52" opacity="0.16"/>
      <circle cx="33.4" cy="635.3" r="0.78" opacity="0.25"/>
      <circle cx="703.3" cy="731.6" r="0.74" opacity="0.27"/>
      <circle cx="880.6" cy="672.9" r="0.76" opacity="0.14"/></g></svg></div>
<div class="stage">
  <form class="glass card" id="card">
    <input id="f-name" class="name-title" value="New Entry" aria-label="name" autocomplete="off">
    <div class="sub">add something to your orbit</div>

    <div class="field">
      <label>type</label>
      <div class="types" id="types">
        <button type="button" data-type="service" aria-pressed="false">&#9679; service</button>
        <button type="button" data-type="renewal" aria-pressed="false">&#9673; renewal</button>
        <button type="button" data-type="inspection" aria-pressed="false">&#9681; inspection</button>
        <button type="button" data-type="suggestion" aria-pressed="false">&#9675; suggestion</button>
        <button type="button" data-type="document" aria-pressed="false">&#9670; document</button>
      </div>
    </div>

    <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="drop a document, or press enter to choose one">
      <div class="dz-main">drop a document — we'll read what we can</div>
      <div class="dz-hint mono">PDF, email or photo &middot; dates, amounts &amp; reference numbers extracted automatically</div>
    </div>

    <div class="disclose" id="disclose">
      <div class="disclose-inner"><div class="disclose-content">

        <div class="docnote mono" id="docnote">suggestions come from the document — nothing is saved until you accept</div>

        <div class="row2">
          <div class="field" id="field-provider">
            <label>provider</label>
            <input id="f-provider" placeholder="e.g. Aviva">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-provider">&#10003; accept</button></div>
          </div>
          <div class="field mono" id="field-ref">
            <label>reference / policy no.</label>
            <input id="f-ref" placeholder="e.g. POL-004471">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-ref">&#10003; accept</button></div>
          </div>
        </div>

        <div class="daterow">
          <div class="field f-date" id="field-date">
            <label>key date</label>
            <input id="f-date" type="date">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-date">&#10003; accept</button></div>
          </div>
          <div class="field f-recur">
            <label>recurrence</label>
            <select id="f-recur">
              <option value="once">one-off</option>
              <option value="monthly">monthly</option>
              <option value="yearly" selected>yearly</option>
            </select>
          </div>
        </div>

        <div class="row2">
          <div class="field">
            <label>cost</label>
            <div class="prefix-wrap"><span class="prefix">&pound;</span>
              <input id="f-cost" type="number" min="0" step="0.01" placeholder="0.00"></div>
          </div>
          <div class="field">
            <label>reminder</label>
            <select id="f-reminder">
              <option value="7">1 week before</option>
              <option value="14" selected>2 weeks before</option>
              <option value="30">1 month before</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label>assign to</label>
          <select id="f-assign">
            <option value="">household &middot; shared</option>
            <option>Tom</option>
            <option>Sarah</option>
            <option>Isla</option>
          </select>
        </div>

        <div class="field">
          <label>notes</label>
          <textarea id="f-notes" rows="2" placeholder="anything else worth keeping"></textarea>
        </div>

        <div class="save-row">
          <button type="submit" class="btn-primary">Add to orbit</button>
          <a href="/home" class="cancel-link">cancel</a>
        </div>

      </div></div>
    </div>
  </form>
</div>

<div class="vignette"></div>
