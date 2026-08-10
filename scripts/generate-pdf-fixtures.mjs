import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const outputPath = resolve("tests/support/fixtures/chromium-synthetic.pdf");
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      @page { size: A4; margin: 24mm; }
      body { color: #17202a; font: 14pt Arial, sans-serif; }
      h1 { color: #174a7c; font-size: 24pt; margin: 0 0 12pt; }
      p { margin: 0 0 14pt; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #8a98a8; padding: 8pt; text-align: left; }
      th { background: #e8f0f7; }
    </style>
  </head>
  <body>
    <h1>Orbit Chromium PDF fixture</h1>
    <p>Generated standards-valid producer fixture for document structure tests.</p>
    <table>
      <thead><tr><th>Field</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Fixture</td><td>issue-198</td></tr>
        <tr><td>Status</td><td>synthetic</td></tr>
      </tbody>
    </table>
  </body>
</html>`;

mkdirSync(dirname(outputPath), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({
    format: "A4",
    path: outputPath,
    printBackground: true,
    preferCSSPageSize: true,
  });
  if (pdf.length < 1) throw new Error("Chromium produced an empty PDF fixture");
  console.log(`Generated ${outputPath} with Chromium ${browser.version()}`);
} finally {
  await browser.close();
}
