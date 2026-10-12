import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import pdf from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import JSZip from "jszip";

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&quot;/g, `"`)
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Strip XML/HTML tags while preserving block-ish boundaries for heading detection.
function stripTags(xml: string): string {
  return cleanText(decodeXmlEntities(xml)
    .replace(/<\/(?:h[1-6]|p|div|section|article|li|tr|br|a:p|w:p|a:r|a:t|w:r|w:t)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
  );
}

function naturalXmlSort(a: string, b: string): number {
  const numberA = Number(a.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
  const numberB = Number(b.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
  return numberA === numberB ? a.localeCompare(b) : numberA - numberB;
}

function paragraphsFromDrawingXml(xml: string): string[] {
  const paragraphs = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [];
  return paragraphs
    .map((paragraph) => {
      const runs = Array.from(paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g), (match) =>
        decodeXmlEntities(match[1])
      );
      return cleanText(runs.join(""));
    })
    .filter((paragraph) => paragraph.length > 0);
}

async function fromZipXml(buf: Buffer, match: (name: string) => boolean): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts: string[] = [];
  const names = Object.keys(zip.files).filter(match).sort(naturalXmlSort);
  for (const name of names) {
    const xml = await zip.files[name].async("string");
    parts.push(stripTags(xml));
  }
  return cleanText(parts.join("\n"));
}

async function fromPptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(naturalXmlSort);
  const slides: string[] = [];
  for (const name of slideNames) {
    const slideNo = name.match(/slide(\d+)\.xml$/)?.[1] || String(slides.length + 1);
    const xml = await zip.files[name].async("string");
    const paragraphs = paragraphsFromDrawingXml(xml);
    if (paragraphs.length) {
      slides.push(cleanText([`Slide ${slideNo}`, ...paragraphs].join("\n")));
    }
  }
  return cleanText(slides.join("\n\n"));
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(command, ["--version"], { stdio: "ignore" });
    probe.once("error", () => resolve(false));
    probe.once("exit", (code) => resolve(code === 0));
  });
}

async function findLibreOffice(): Promise<string | null> {
  for (const command of ["soffice", "libreoffice"]) {
    if (await commandExists(command)) return command;
  }
  return null;
}

async function convertOfficeToText(filePath: string): Promise<string> {
  const command = await findLibreOffice();
  if (!command) {
    throw new Error("Legacy Office extraction requires LibreOffice in the RAG container");
  }

  const outDir = await mkdtemp(path.join(os.tmpdir(), "upquiz-office-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [
        "--headless",
        "--convert-to",
        "txt:Text",
        "--outdir",
        outDir,
        filePath,
      ]);

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `LibreOffice conversion failed with exit code ${code}`));
      });
    });

    const convertedPath = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}.txt`);
    const text = cleanText(await readFile(convertedPath, "utf-8"));
    if (!text) throw new Error("LibreOffice converted the file but found no readable text");
    return text;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

// Extract readable text from a learning material based on its extension.
// Thesis-supported formats: PDF, DOC, DOCX, PPT, PPTX, XLSX, ODT, HTML, RTF, TXT, MD, CSV
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
    case ".doc":
    case ".ppt":
      return convertOfficeToText(filePath);
    case ".docx": {
      const markdown = await (mammoth as typeof mammoth & {
        convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{ value: string }>;
      }).convertToMarkdown?.({ buffer: buf });
      if (markdown?.value?.trim()) return cleanText(markdown.value);
      const res = await mammoth.extractRawText({ buffer: buf });
      return cleanText(res.value);
    }
    case ".pptx":
      return fromPptx(buf);
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
      return cleanText(buf.toString("utf-8"));
    default:
      throw new Error(`Unsupported file type: ${ext || "unknown"}`);
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
