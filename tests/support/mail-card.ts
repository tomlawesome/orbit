/** What a reader of a mail sees: no style block, inline tags dropped, other tags as spaces, entities decoded, whitespace collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<\/?(?:span|a|b|i|em|strong|u|small|font)\b[^>]*>/giu, "").replace(/<[^>]*>/gu, " ")
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/\s+/gu, " ");
}
