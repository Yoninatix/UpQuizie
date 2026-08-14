import { readFile } from "node:fs/promises";
import path from "node:path";
import pdf from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import JSZip from "jszip";

// Strip XML/HTML tags while preserving block-ish boundaries for heading detection.
function stripTags(xml: string): string {
  return xml
    .replace(/<\/(?:h[1-6]|p|div|section|article|li|tr|br|a:p|w:p|a:r|a:t|w:r|w:t)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z]+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fromZipXml(buf: Buffer, match: (name: string) => boolean): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts: string[] = [];
  const names = Object.keys(zip.files).filter(match).sort();
  for (const name of names) {
    const xml = await zip.files[name].async("string");
    parts.push(stripTags(xml));
  }
  return parts.join("\n");
}

// Extract readable text from a learning material based on its extension.
// Thesis-supported formats: PDF, DOCX, PPTX, XLSX, ODT, HTML, RTF, TXT, MD, CSV
// (plus OCR fallback for image-only files via Tesseract).
export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await readFile(filePath);

  switch (ext) {
    case ".pdf": {
      const data = await pdf(buf);
      const text = (data.text || "").trim();
      if (text.length > 20) return text;
      // Image-only / scanned PDF -> OCR fallback
      return await ocr(buf);
    }
    case ".docx": {
      const res = await mammoth.extractRawText({ buffer: buf });
      return res.value;
    }
    case ".pptx":
      return fromZipXml(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    case ".xlsx":
      return fromZipXml(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    case ".odt":
      return fromZipXml(buf, (n) => n === "content.xml");
    case ".html":
    case ".htm":
      return stripTags(buf.toString("utf-8"));
    case ".rtf":
      return buf
        .toString("utf-8")
        .replace(/\\[a-z]+-?\d* ?/g, " ")
        .replace(/[{}]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    case ".png":
    case ".jpg":
    case ".jpeg":
      return ocr(filePath);
    case ".txt":
    case ".md":
    case ".csv":
    default:
      return buf.toString("utf-8");
  }
}

// OCR using Tesseract.js. Imported lazily so the worker only spins up when needed.
async function ocr(input: Buffer | string): Promise<string> {
  try {
    const tesseract = await import("tesseract.js");
    const recognize = tesseract.recognize ?? tesseract.default?.recognize;
    if (typeof recognize !== "function") {
      throw new Error("Tesseract OCR is unavailable");
    }
    const { data } = await recognize(input, "eng");
    const text = (data.text || "").trim();
    if (!text) {
      throw new Error("OCR found no readable English text");
    }
    return text;
  } catch (e) {
    console.warn("OCR failed:", e);
    throw e;
  }
}
