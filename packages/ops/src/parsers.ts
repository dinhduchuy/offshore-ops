/**
 * File parsers → a uniform table: header + rows with source line numbers.
 * Supported: CSV (RFC 4180, "#" comment lines), XLSX (first sheet), JSON
 * (array of objects or {rows:[…]}). PDF/TXT are documents, not tables —
 * see extractDocumentText.
 */

export interface ParsedTable {
  header: string[];
  rows: Array<{ rowNo: number; cells: Record<string, string> }>;
  /** Comment lines ("# …") before the header — used for the SIMULATED marker */
  comments: string[];
}

export function parseCsv(text: string): ParsedTable {
  const records: Array<{ line: number; fields: string[] }> = [];
  const comments: string[] = [];
  let field = "";
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let atRecordStart = true;
  const src = text.replace(/^\uFEFF/, "");

  const endRecord = () => {
    fields.push(field);
    const isBlank = fields.length === 1 && fields[0].trim() === "";
    if (!isBlank) records.push({ line: recordLine, fields });
    fields = [];
    field = "";
    atRecordStart = true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (atRecordStart && !inQuotes && c === "#" && records.length === 0) {
      // comment line (only before the header)
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      comments.push(src.slice(i + 1, stop).replace(/\r$/, "").trim());
      i = stop;
      line++;
      recordLine = line;
      continue;
    }
    if (atRecordStart) {
      recordLine = line;
      atRecordStart = false;
    }
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      fields.push(field);
      field = "";
    } else if (c === "\n") {
      endRecord();
      line++;
    } else if (c === "\r") {
      // ignore (CRLF)
    } else field += c;
  }
  if (field !== "" || fields.length > 0) endRecord();

  if (records.length === 0) return { header: [], rows: [], comments };
  const header = records[0].fields.map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const cells: Record<string, string> = {};
    header.forEach((h, idx) => {
      cells[h] = (r.fields[idx] ?? "").trim();
    });
    return { rowNo: r.line, cells };
  });
  return { header, rows, comments };
}

export async function parseXlsx(buf: Buffer): Promise<ParsedTable> {
  const mod = (await import("read-excel-file/node")) as unknown as {
    default: (input: Buffer) => Promise<unknown[][]>;
  };
  const sheet = await mod.default(buf);
  const comments: string[] = [];
  let start = 0;
  // Leading single-cell rows starting with "#" are comments (SIMULATED marker)
  while (start < sheet.length && typeof sheet[start][0] === "string" && String(sheet[start][0]).startsWith("#")) {
    comments.push(String(sheet[start][0]).slice(1).trim());
    start++;
  }
  const header = (sheet[start] ?? []).map((h) => String(h ?? "").trim());
  const rows = sheet.slice(start + 1).map((r, i) => {
    const cells: Record<string, string> = {};
    header.forEach((h, idx) => {
      const v = r[idx];
      cells[h] = v instanceof Date ? v.toISOString() : v === null || v === undefined ? "" : String(v).trim();
    });
    return { rowNo: start + 2 + i, cells };
  });
  return { header, rows, comments };
}

export function parseJsonTable(text: string): ParsedTable {
  const data = JSON.parse(text) as unknown;
  const arr = Array.isArray(data) ? data : (data as { rows?: unknown[] })?.rows;
  if (!Array.isArray(arr)) throw new Error("JSON phải là mảng object hoặc {rows:[…]}");
  const comments: string[] = [];
  if (!Array.isArray(data) && (data as { simulated?: boolean }).simulated) comments.push("SIMULATED");
  const header = Array.from(new Set(arr.flatMap((r) => Object.keys((r ?? {}) as object))));
  const rows = arr.map((r, i) => {
    const cells: Record<string, string> = {};
    for (const h of header) {
      const v = (r as Record<string, unknown>)[h];
      cells[h] = v === null || v === undefined ? "" : String(v).trim();
    }
    return { rowNo: i + 1, cells };
  });
  return { header, rows, comments };
}

export async function extractDocumentText(filename: string, buf: Buffer): Promise<{ text: string; mime: string }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: String(text), mime: "application/pdf" };
  }
  return { text: buf.toString("utf-8"), mime: lower.endsWith(".md") ? "text/markdown" : "text/plain" };
}

export function isSimulated(comments: string[], filename: string): boolean {
  return (
    comments.some((c) => /SIMULATED|GIẢ LẬP|GIA LAP/i.test(c)) || /(^|[_\-/])SIM[_-]/i.test(filename)
  );
}
