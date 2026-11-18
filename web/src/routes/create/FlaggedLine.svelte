<script>
  /*
   * #1795 (note 63499): the scanner's line under a flagged paper in the review
   * form, copied from ReviewCard's `.rv-dup.flag`. A component of its own with
   * no <style> so the block keeps the bare class `pc-flag` (a scoped style in
   * EntryForm would add Svelte's hash class to it); EntryForm styles it with
   * :global rules.
   */
  /** @type {{ id: string, name: string, many: boolean }} */
  let { id, name, many } = $props();
</script>

<div class="pc-flag" {id}><span class="pc-bead" aria-hidden="true"></span>
  <p><b>The scanner flagged a virus or malware inside attachment: "{name}"</b></p>
  <p>{many ? "Add without them" : "Add without it"} adds the mail and its other attachments. {many ? "The flagged files are never added." : "The flagged file is never added."}</p>
</div>
