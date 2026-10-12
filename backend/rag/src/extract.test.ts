import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractText } from "./extract.js";

function slideXml(paragraphs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      ${paragraphs.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join("\n")}
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

test("extracts pptx text by slide order with readable title lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "upquiz-extract-"));
  try {
    const filePath = path.join(dir, "lesson.pptx");
    const zip = new JSZip();
    zip.file("ppt/slides/slide10.xml", slideXml(["Later Topic", "This should appear after slide two."]));
    zip.file("ppt/slides/slide2.xml", slideXml(["Second Topic", "Atoms &amp; molecules are related."]));
    zip.file("ppt/slides/slide1.xml", slideXml(["Main Lesson Title", "Matter has mass and occupies space."]));
    await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));

    const text = await extractText(filePath);

    assert.match(text, /^Slide 1\nMain Lesson Title\nMatter has mass and occupies space\./);
    assert.ok(text.indexOf("Slide 2") < text.indexOf("Slide 10"));
    assert.match(text, /Atoms & molecules are related\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
