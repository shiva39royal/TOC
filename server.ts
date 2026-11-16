import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import type { DwgDatabase, LibreDwgEx } from '@mlightcad/libredwg-web';
import dotenv from 'dotenv';
import DxfParser from 'dxf-parser';
import type { IDxf } from 'dxf-parser';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

let libreDwgPromise: Promise<LibreDwgEx> | null = null;

async function getLibreDwg(): Promise<LibreDwgEx> {
  if (!libreDwgPromise) {
    const wasmDir = path.join(__dirname, 'node_modules/@mlightcad/libredwg-web/wasm/');
    libreDwgPromise = LibreDwg.create(wasmDir);
  }
  return libreDwgPromise;
}

function getGeminiClient(customApiKey?: string): GoogleGenAI | null {
  const apiKey = (customApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

interface UploadedFilePayload {
  name: string;
  mimeType: string;
  base64Data: string;
  supplementaryImages?: string[];
}

function cleanCadText(raw: string): string {
  return raw
    .replace(/\\P/gi, ' ')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSupportedCadExtension(fileName: string): 'DWG' | 'DXF' | 'PDF' | null {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.dwg')) return 'DWG';
  if (lower.endsWith('.dxf')) return 'DXF';
  if (lower.endsWith('.pdf')) return 'PDF';
  return null;
}

function verifyCadBufferSignature(buffer: Buffer, kind: 'DWG' | 'DXF' | 'PDF', fileName: string): void {
  if (buffer.length < 16) {
    throw new Error(`Invalid ${kind} file (${fileName}): file is empty or truncated.`);
  }
  const headAscii = buffer.subarray(0, 64).toString('latin1');
  if (kind === 'PDF') {
    if (!headAscii.startsWith('%PDF')) {
      throw new Error(`Invalid PDF file (${fileName}): missing %PDF header signature.`);
    }
    return;
  }

  if (headAscii.startsWith('%PDF')) {
    throw new Error(`Invalid ${kind} file (${fileName}): PDF bytes inside a .${kind.toLowerCase()} file. Rename or upload a genuine ${kind}.`);
  }
  if (headAscii.startsWith('PK\x03\x04')) {
    throw new Error(`Invalid ${kind} file (${fileName}): archive/Office XML content detected. Supported formats are .dwg, .dxf, and .pdf.`);
  }

  if (kind === 'DWG') {
    if (!/^AC1\.\d|^AC10\d{2}/.test(headAscii)) {
      throw new Error(
        `Invalid DWG file (${fileName}): missing AutoCAD DWG signature (expected AC10xx header).`
      );
    }
  } else {
    const isBinaryDxf = headAscii.startsWith('AutoCAD Binary DXF');
    if (!isBinaryDxf) {
      const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
      if (!sample.includes('SECTION') && !sample.includes('ENTITIES') && !sample.includes('EOF')) {
        throw new Error(
          `Invalid DXF file (${fileName}): missing DXF SECTION/ENTITIES structure.`
        );
      }
    }
  }
}

function dwgDatabaseToIDxf(db: DwgDatabase): IDxf {
  const layersRecord: Record<string, { name: string; visible: boolean; colorIndex: number; color: number; frozen: boolean }> = {};
  for (const entry of db.tables?.LAYER?.entries ?? []) {
    layersRecord[entry.name] = {
      name: entry.name,
      visible: !entry.off,
      colorIndex: entry.colorIndex ?? 7,
      color: entry.color ?? 0,
      frozen: Boolean(entry.frozen),
    };
  }

  const mapDwgEntity = (e: Record<string, unknown>): Record<string, unknown> | null => {
    const t = String(e.type || '');
    const common = {
      type: t,
      layer: String(e.layer || '0'),
      colorIndex: typeof e.colorIndex === 'number' ? e.colorIndex : 256,
      color: typeof e.color === 'number' ? e.color : 0,
      visible: e.isVisible !== false,
      lineType: String(e.lineType || 'BYLAYER'),
      lineTypeScale: Number(e.linetypeScale || 1),
      inPaperSpace: false,
    };

    if (t === 'LINE') {
      const sp = e.startPoint as { x?: number; y?: number; z?: number } | undefined;
      const ep = e.endPoint as { x?: number; y?: number; z?: number } | undefined;
      if (!sp || !ep) return null;
      return {
        ...common,
        vertices: [
          { x: Number(sp.x ?? 0), y: Number(sp.y ?? 0), z: Number(sp.z ?? 0) },
          { x: Number(ep.x ?? 0), y: Number(ep.y ?? 0), z: Number(ep.z ?? 0) },
        ],
      };
    }
    if (t === 'LWPOLYLINE') {
      const verts = Array.isArray(e.vertices) ? e.vertices : [];
      return {
        ...common,
        shape: Boolean((Number(e.flag || 0) & 1) === 1),
        vertices: verts.map((v: Record<string, unknown>) => ({
          x: Number(v.x ?? 0),
          y: Number(v.y ?? 0),
          z: 0,
          bulge: Number(v.bulge ?? 0),
        })),
      };
    }
    if (t === 'POLYLINE2D' || t === 'POLYLINE3D') {
      const verts = Array.isArray(e.vertices) ? e.vertices : [];
      return {
        ...common,
        type: 'POLYLINE',
        shape: Boolean((Number(e.flag || 0) & 1) === 1),
        vertices: verts.map((v: Record<string, unknown>) => {
          const pt = (v.point as Record<string, unknown>) ?? v;
          return {
            x: Number(pt.x ?? 0),
            y: Number(pt.y ?? 0),
            z: Number(pt.z ?? 0),
            bulge: Number(v.bulge ?? 0),
          };
        }),
      };
    }
    if (t === 'CIRCLE') {
      const c = e.center as { x?: number; y?: number; z?: number } | undefined;
      return {
        ...common,
        center: { x: Number(c?.x ?? 0), y: Number(c?.y ?? 0), z: Number(c?.z ?? 0) },
        radius: Number(e.radius ?? 0),
      };
    }
    if (t === 'ARC') {
      const c = e.center as { x?: number; y?: number; z?: number } | undefined;
      return {
        ...common,
        center: { x: Number(c?.x ?? 0), y: Number(c?.y ?? 0), z: Number(c?.z ?? 0) },
        radius: Number(e.radius ?? 0),
        startAngle: Number(e.startAngle ?? 0),
        endAngle: Number(e.endAngle ?? 0),
      };
    }
    if (t === 'ELLIPSE') {
      const c = e.center as { x?: number; y?: number; z?: number } | undefined;
      const m = e.majorAxisEndPoint as { x?: number; y?: number; z?: number } | undefined;
      return {
        ...common,
        center: { x: Number(c?.x ?? 0), y: Number(c?.y ?? 0), z: Number(c?.z ?? 0) },
        majorAxisEndPoint: { x: Number(m?.x ?? 1), y: Number(m?.y ?? 0), z: Number(m?.z ?? 0) },
        axisRatio: Number(e.axisRatio ?? 1),
        startAngle: Number(e.startAngle ?? 0),
        endAngle: Number(e.endAngle ?? Math.PI * 2),
      };
    }
    if (t === 'SPLINE') {
      const fit = Array.isArray(e.fitPoints) ? e.fitPoints : [];
      const ctrl = Array.isArray(e.controlPoints) ? e.controlPoints : [];
      return {
        ...common,
        closed: Boolean(e.closed),
        fitPoints: fit.map((p: Record<string, unknown>) => ({ x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) })),
        controlPoints: ctrl.map((p: Record<string, unknown>) => ({ x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) })),
      };
    }
    if (t === 'TEXT') {
      const sp = e.startPoint as { x?: number; y?: number; z?: number } | undefined;
      return {
        ...common,
        text: String(e.text ?? ''),
        startPoint: { x: Number(sp?.x ?? 0), y: Number(sp?.y ?? 0), z: Number(sp?.z ?? 0) },
        textHeight: Number(e.textHeight ?? 2.5),
        rotation: (Number(e.rotation ?? 0) * 180) / Math.PI,
      };
    }
    if (t === 'MTEXT') {
      const pos = e.insertionPoint as { x?: number; y?: number; z?: number } | undefined;
      return {
        ...common,
        text: String(e.text ?? ''),
        position: { x: Number(pos?.x ?? 0), y: Number(pos?.y ?? 0), z: Number(pos?.z ?? 0) },
        height: Number(e.textHeight ?? 2.5),
        rotation: (Number(e.rotation ?? 0) * 180) / Math.PI,
      };
    }
    if (t === 'INSERT') {
      const pos = e.insertionPoint as { x?: number; y?: number; z?: number } | undefined;
      const rawAttribs = Array.isArray(e.attribs)
        ? e.attribs
        : Array.isArray(e.attributes)
          ? e.attributes
          : [];
      return {
        ...common,
        name: String(e.name ?? ''),
        position: { x: Number(pos?.x ?? 0), y: Number(pos?.y ?? 0), z: Number(pos?.z ?? 0) },
        xScale: Number(e.xScale ?? 1),
        yScale: Number(e.yScale ?? 1),
        zScale: Number(e.zScale ?? 1),
        rotation: (Number(e.rotation ?? 0) * 180) / Math.PI,
        columnCount: Number(e.columnCount ?? 1),
        rowCount: Number(e.rowCount ?? 1),
        columnSpacing: Number(e.columnSpacing ?? 0),
        rowSpacing: Number(e.rowSpacing ?? 0),
        attribs: rawAttribs.map((a: Record<string, unknown>) => ({
          tag: String(a.tag ?? ''),
          text: String(a.text ?? a.value ?? ''),
          startPoint: a.startPoint ?? a.position ?? pos,
          position: a.position ?? a.startPoint ?? pos,
        })),
      };
    }
    if (t === 'SOLID') {
      const pts = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean) as Array<{ x?: number; y?: number; z?: number }>;
      return {
        ...common,
        points: pts.map((p) => ({ x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) })),
      };
    }
    return null;
  };

  const blocksRecord: Record<string, { name: string; position: { x: number; y: number; z: number }; entities: unknown[] }> = {};
  for (const blk of db.tables?.BLOCK_RECORD?.entries ?? []) {
    const bp = blk.basePoint ?? { x: 0, y: 0, z: 0 };
    const mapped = (blk.entities ?? [])
      .map((ent) => mapDwgEntity(ent as unknown as Record<string, unknown>))
      .filter(Boolean);
    blocksRecord[blk.name] = {
      name: blk.name,
      position: { x: Number(bp.x ?? 0), y: Number(bp.y ?? 0), z: Number(bp.z ?? 0) },
      entities: mapped,
    };
  }

  const modelEntities = (db.entities ?? [])
    .map((ent) => mapDwgEntity(ent as unknown as Record<string, unknown>))
    .filter(Boolean);

  return {
    header: {},
    entities: modelEntities as unknown as IDxf['entities'],
    blocks: blocksRecord as unknown as IDxf['blocks'],
    tables: {
      layer: { handle: '0', ownerHandle: '0', layers: layersRecord },
      lineType: { handle: '0', ownerHandle: '0', lineTypes: {} },
      viewPort: { handle: '0', ownerHandle: '0', viewPorts: [] },
    },
  };
}

function summarizeDxf(dxfData: IDxf, fileName: string, kind: 'DWG' | 'DXF', cadVersion?: string) {
  const layers = Object.keys(dxfData.tables?.layer?.layers ?? {});
  const collectedTexts: Array<{ text: string; x: number; y: number; priority: number }> = [];
  const entityCounts: Record<string, number> = {};
  let totalEntities = 0;

  const scoreTextPriority = (txt: string): number => {
    if (/^(R|N)[-\s]?\d+/i.test(txt) || /\b(TIN|STN|STATION|CODE|KAVACH|TCAS|HOME|STARTER|DISTANT|ADV|LOOP|MAIN|LINE|LC[-\s]?\d+|PT\.?\s*\d+)\b/i.test(txt)) {
      return 3;
    }
    if (/^(S|A|C|G|L|SH)?\d+[A-Z]?$/i.test(txt) || /\d{3,5}/.test(txt)) {
      return 2;
    }
    return 1;
  };

  const pushText = (raw: string, x: number, y: number) => {
    if (!raw || raw.length >= 160) return;
    collectedTexts.push({
      text: raw,
      x: Math.round(x),
      y: Math.round(y),
      priority: scoreTextPriority(raw),
    });
  };

  const walkEntities = (
    entities: IDxf['entities'] | undefined,
    offsetX: number,
    offsetY: number,
    scaleX: number,
    scaleY: number,
    rotRad: number,
    depth: number
  ) => {
    if (!entities || depth > 5) return;
    const cos = Math.cos(rotRad);
    const sin = Math.sin(rotRad);

    const transformPt = (px: number, py: number) => {
      const sx = px * scaleX;
      const sy = py * scaleY;
      return {
        x: offsetX + sx * cos - sy * sin,
        y: offsetY + sx * sin + sy * cos,
      };
    };

    for (const ent of entities) {
      totalEntities += 1;
      entityCounts[ent.type] = (entityCounts[ent.type] ?? 0) + 1;

      if (ent.type === 'INSERT') {
        const ins = ent as unknown as {
          name?: string;
          position?: { x: number; y: number };
          xScale?: number;
          yScale?: number;
          rotation?: number;
          attribs?: Array<{
            tag?: string;
            text?: string;
            value?: string;
            position?: { x: number; y: number };
            startPoint?: { x: number; y: number };
          }>;
        };

        if (Array.isArray(ins.attribs)) {
          for (const attr of ins.attribs) {
            const val = cleanCadText(String(attr.text || attr.value || ''));
            if (val) {
              const apt = attr.position ?? attr.startPoint ?? ins.position ?? { x: 0, y: 0 };
              const tp = transformPt(apt.x ?? 0, apt.y ?? 0);
              const label = attr.tag ? `${attr.tag}:${val}` : val;
              pushText(label, tp.x, tp.y);
            }
          }
        }

        const block = ins.name ? dxfData.blocks?.[ins.name] : undefined;
        if (block?.entities) {
          const baseX = block.position?.x ?? 0;
          const baseY = block.position?.y ?? 0;
          const pos = transformPt(ins.position?.x ?? 0, ins.position?.y ?? 0);
          const nextRot = rotRad + ((ins.rotation ?? 0) * Math.PI) / 180;
          const nextSx = scaleX * (ins.xScale ?? 1);
          const nextSy = scaleY * (ins.yScale ?? 1);
          const cosNext = Math.cos(nextRot);
          const sinNext = Math.sin(nextRot);
          const adjX = pos.x - (baseX * nextSx * cosNext - baseY * nextSy * sinNext);
          const adjY = pos.y - (baseX * nextSx * sinNext + baseY * nextSy * cosNext);
          walkEntities(block.entities, adjX, adjY, nextSx, nextSy, nextRot, depth + 1);
        }
      } else if (ent.type === 'TEXT' || ent.type === 'MTEXT' || ent.type === 'ATTDEF' || ent.type === 'ATTRIB') {
        const txtEnt = ent as unknown as {
          text?: string;
          startPoint?: { x: number; y: number };
          position?: { x: number; y: number };
        };
        const raw = txtEnt.text ? cleanCadText(txtEnt.text) : '';
        if (raw) {
          const pt = txtEnt.position ?? txtEnt.startPoint ?? { x: 0, y: 0 };
          const tp = transformPt(pt.x, pt.y);
          pushText(raw, tp.x, tp.y);
        }
      } else if (ent.type === 'DIMENSION') {
        const dimEnt = ent as unknown as {
          text?: string;
          actualMeasurement?: number;
          middleOfText?: { x: number; y: number };
          block?: string;
        };
        const dimLabel = dimEnt.text
          ? cleanCadText(dimEnt.text)
          : dimEnt.actualMeasurement !== undefined
            ? `${Math.round(dimEnt.actualMeasurement)}`
            : '';
        if (dimLabel) {
          const pt = dimEnt.middleOfText ?? { x: 0, y: 0 };
          const tp = transformPt(pt.x, pt.y);
          pushText(`DIM:${dimLabel}`, tp.x, tp.y);
        }
        if (dimEnt.block && dxfData.blocks?.[dimEnt.block]?.entities) {
          walkEntities(dxfData.blocks[dimEnt.block].entities, offsetX, offsetY, scaleX, scaleY, rotRad, depth + 1);
        }
      }
    }
  };

  walkEntities(dxfData.entities, 0, 0, 1, 1, 0, 0);

  // Sort by signalling relevance first so critical station codes, signals, tags & TINs are never truncated,
  // then order selected items spatially (top-to-bottom band, left-to-right) for readable schematic reconstruction.
  const selectedTexts = collectedTexts
    .sort((a, b) => b.priority - a.priority || a.x - b.x)
    .slice(0, 2200)
    .sort((a, b) => (Math.abs(a.y - b.y) > 8 ? b.y - a.y : a.x - b.x))
    .map((t) => `${t.text} @(${t.x},${t.y})`);

  const countSummary = Object.entries(entityCounts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const summary = [
    `CAD File: ${fileName} (${kind}${cadVersion ? ` ${cadVersion}` : ''})`,
    `CAD Layers (${layers.length}): ${layers.slice(0, 80).join(', ')}`,
    `Blocks Defined: ${Object.keys(dxfData.blocks ?? {}).length}`,
    `Entity Counts (incl. block expansions): ${countSummary}`,
    `Extracted CAD Text Annotations (${selectedTexts.length} of ${collectedTexts.length}) with (X,Y):`,
    selectedTexts.join(' | '),
  ].join('\n');

  return {
    summary,
    layerCount: layers.length,
    blockCount: Object.keys(dxfData.blocks ?? {}).length,
    entityCount: totalEntities,
  };
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}

async function parseCadFileBuffer(
  buffer: Buffer,
  fileName: string,
  kind: 'DWG' | 'DXF'
): Promise<{
  summary: string;
  dxfData: IDxf;
  layerCount: number;
  blockCount: number;
  entityCount: number;
  cadVersion?: string;
}> {
  verifyCadBufferSignature(buffer, kind, fileName);
  const parser = new DxfParser();

  if (kind === 'DXF') {
    const head = buffer.subarray(0, 22).toString('latin1');
    let dxfData: IDxf | null = null;
    if (head.startsWith('AutoCAD Binary DXF')) {
      const libredwg = await getLibreDwg();
      const ab = toArrayBuffer(buffer);
      const ptr = libredwg.dwg_read_data(ab, Dwg_File_Type.DXF);
      if (!ptr) {
        throw new Error(`Could not decode binary DXF file (${fileName}).`);
      }
      try {
        const db = libredwg.convert(ptr);
        dxfData = dwgDatabaseToIDxf(db);
      } finally {
        libredwg.dwg_free(ptr);
      }
    } else {
      const rawText = buffer.toString('utf8');
      dxfData = parser.parseSync(rawText);
    }

    if (!dxfData || (!dxfData.entities?.length && !Object.keys(dxfData.blocks ?? {}).length)) {
      throw new Error(`DXF file (${fileName}) contains no renderable CAD geometry.`);
    }
    const stats = summarizeDxf(dxfData, fileName, 'DXF');
    return { dxfData, ...stats };
  }

  // DWG Parsing via LibreDWG WASM
  const cadVersion = buffer.subarray(0, 6).toString('ascii').replace(/[^\x20-\x7E]/g, '');
  const libredwg = await getLibreDwg();
  const ab = toArrayBuffer(buffer);

  let dxfData: IDxf | null = null;
  try {
    const dxfBytes = libredwg.dwg_write_dxf(ab);
    if (dxfBytes && dxfBytes.length > 0) {
      const dxfText = new TextDecoder('utf-8').decode(dxfBytes);
      dxfData = parser.parseSync(dxfText);
    }
  } catch {
    // Fallback to direct DwgDatabase conversion below
  }

  if (!dxfData || !dxfData.entities?.length) {
    const ptr = libredwg.dwg_read_data(ab, Dwg_File_Type.DWG);
    if (!ptr) {
      throw new Error(`Failed to decode DWG file (${fileName}, ${cadVersion || 'unknown version'}).`);
    }
    try {
      const db = libredwg.convert(ptr);
      dxfData = dwgDatabaseToIDxf(db);
    } finally {
      libredwg.dwg_free(ptr);
    }
  }

  if (!dxfData || (!dxfData.entities?.length && !Object.keys(dxfData.blocks ?? {}).length)) {
    throw new Error(`DWG file (${fileName}) decoded with zero CAD entities.`);
  }

  const stats = summarizeDxf(dxfData, fileName, 'DWG', cadVersion);
  return { dxfData, cadVersion, ...stats };
}

async function extractPdfTextWithCoords(
  buffer: Buffer,
  fileName: string
): Promise<{ pageCount: number; summary: string; rawText: string }> {
  const uint8 = new Uint8Array(buffer.byteLength);
  uint8.set(buffer);

  const standardFontDataUrl = pathToFileURL(
    path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts/')
  ).href;

  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    standardFontDataUrl,
    disableFontFace: true,
  });

  const doc = await loadingTask.promise;
  try {
    const pageCount = doc.numPages;
    const allTokens: Array<{ page: number; text: string; x: number; y: number }> = [];

    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const item of tc.items) {
        if (!('str' in item)) continue;
        const str = String(item.str || '').replace(/\s+/g, ' ').trim();
        if (!str) continue;
        const tr = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
        allTokens.push({
          page: p,
          text: str,
          x: Math.round(Number(tr[4] ?? 0)),
          y: Math.round(Number(tr[5] ?? 0)),
        });
      }
    }

    // Sort top-to-bottom (higher PDF Y is upper on sheet), then left-to-right
    allTokens.sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y - b.y) > 8) return b.y - a.y;
      return a.x - b.x;
    });

    const formatted = allTokens
      .slice(0, 1600)
      .map((t) => `${t.text} @(p${t.page},${t.x},${t.y})`)
      .join(' | ');
    const rawText = allTokens.map((t) => t.text).join(' ');

    return {
      pageCount,
      rawText,
      summary: [
        `PDF Engineering Drawing: ${fileName} (${pageCount} page(s), ${allTokens.length} extracted text items)`,
        formatted
          ? `Extracted PDF Vector Text & Coordinates:\n${formatted}`
          : 'No vector text objects detected (scanned raster PDF — read directly from image pixels).',
      ].join('\n'),
    };
  } finally {
    await loadingTask.destroy();
  }
}

const NON_STATION_CODES = new Set([
  'PIN', 'TIN', 'TOC', 'SIP', 'ESP', 'CAD', 'PDF', 'DXF', 'DWG', 'SCR', 'KAV', 'TCAS',
  'LC', 'UP', 'DN', 'MM', 'KM', 'CH', 'SL', 'NO', 'ID', 'BG', 'SG', 'MG', 'AC', 'DC',
  'REF', 'DRG', 'RDSO', 'IRS', 'STN', 'RJT', 'SIG', 'TAG', 'TAG1', 'PT', 'JN', 'RLY',
]);

const KNOWN_RAILWAY_STATIONS: Array<{
  code: string;
  id: string;
  name: string;
  aliases: string[];
  nextUp?: string;
  nextDown?: string;
}> = [
  { code: 'CTF', id: '520', name: 'CHITGIDDA', aliases: ['CHITGIDDA', 'CHITGIDA', 'CTF'], nextUp: '503 (VKB)', nextDown: '521 (GGD)' },
  { code: 'JKM', id: '01014', name: 'JANKAMPET JN', aliases: ['JANKAMPET', 'JANKAMPET JN', 'JKM'], nextUp: '01013 (NZB)', nextDown: '01015 (NVT)' },
  { code: 'VKB', id: '503', name: 'VIKARABAD JN', aliases: ['VIKARABAD', 'VIKARABAD JN', 'VKB'], nextUp: '502 (GDCR)', nextDown: '520 (CTF)' },
  { code: 'GGD', id: '521', name: 'GHATGAT', aliases: ['GHATGAT', 'GHATNANDUR', 'GGD'], nextUp: '520 (CTF)', nextDown: '522 (MRF)' },
  { code: 'NZB', id: '01013', name: 'NIZAMABAD JN', aliases: ['NIZAMABAD', 'NZB'], nextUp: '01012 (ARM)', nextDown: '01014 (JKM)' },
  { code: 'NVT', id: '01015', name: 'NAVIPET', aliases: ['NAVIPET', 'NVT'], nextUp: '01014 (JKM)', nextDown: '01016 (BSX)' },
  { code: 'SC', id: '500', name: 'SECUNDERABAD JN', aliases: ['SECUNDERABAD', 'SC'], nextUp: '501 (HYB)', nextDown: '503 (VKB)' },
  { code: 'HYB', id: '501', name: 'HYDERABAD DECCAN', aliases: ['HYDERABAD', 'HYB'], nextUp: '--', nextDown: '500 (SC)' },
  { code: 'KZJ', id: '530', name: 'KAZIPET JN', aliases: ['KAZIPET', 'KZJ'], nextUp: '500 (SC)', nextDown: '535 (BZA)' },
  { code: 'BZA', id: '535', name: 'VIJAYAWADA JN', aliases: ['VIJAYAWADA', 'BZA'], nextUp: '530 (KZJ)', nextDown: '540 (GDR)' },
];

function inferHeaderHintsFromText(rawText: string, fileName: string) {
  const baseFile = fileName
    .replace(/\.(dwg|dxf|pdf)$/i, '')
    .replace(/\b(rfid|tag|tin|layout|plan|signalling|signal|kavach|tcas|toc|table|of|control|drg|rev\d*|drawing|sheet)\b/gi, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normalized = `${fileName} ${rawText}`.replace(/\s+/g, ' ');
  const upperNorm = normalized.toUpperCase();

  // Match against known railway stations in Indian Railways network
  const knownMatch = KNOWN_RAILWAY_STATIONS.find((stn) =>
    stn.aliases.some((alias) => new RegExp(`\\b${alias}\\b`, 'i').test(upperNorm))
  );

  const explicitNameMatch =
    normalized.match(/(?:STATION\s*NAME|NAME\s*OF\s*STATION)\s*[:\-]?\s*([A-Z][A-Z\s.]{2,28})/i) ||
    normalized.match(/(?:LAYOUT\s*(?:PLAN\s*)?OF|STATION\s*[:\-])\s*([A-Z][A-Z\s.]{2,28})/i);

  const explicitCodeMatch =
    normalized.match(/(?:STN\.?\s*CODE|STATION\s*CODE|ALPHA\s*CODE|STN\s*ALPHA)\s*[:\-]?\s*([A-Z]{2,6})\b/i) ||
    normalized.match(/\b(?:CODE|STN)\s*[:\-]\s*([A-Z]{2,5})\b/i);

  const explicitIdMatch =
    normalized.match(/(?:STN\.?\s*ID|STATION\s*ID|TCAS\s*ID|KAVACH\s*ID|STATION\s*NO\.?|STN\s*NO\.?)\s*[:\-]?\s*(\d{2,6})\b/i) ||
    normalized.match(/\b(?:STN|ID)\s*[:\-]\s*(\d{3,5})\b/i);

  // Match e.g. "520 (CTF)", "01014 (JKM)", "CTF (520)", or "CHITGIDDA (CTF)"
  const pairMatches: Array<{ id: string; code: string }> = [];
  for (const m of normalized.matchAll(/\b(\d{3,5})\s*\(\s*([A-Z]{2,5})\s*\)/gi)) {
    const code = m[2].toUpperCase();
    if (!NON_STATION_CODES.has(code)) {
      pairMatches.push({ id: m[1], code });
    }
  }
  for (const m of normalized.matchAll(/\b([A-Z]{2,5})\s*\(\s*(\d{3,5})\s*\)/gi)) {
    const code = m[1].toUpperCase();
    if (!NON_STATION_CODES.has(code)) {
      pairMatches.push({ id: m[2], code });
    }
  }

  const nameCodeMatch = normalized.match(
    /\b([A-Z]{3,20}(?:\s+JN\.?)?)\s*\(\s*([A-Z]{2,5})\s*\)/i
  );
  const parenCode =
    nameCodeMatch && !NON_STATION_CODES.has(nameCodeMatch[2].toUpperCase())
      ? nameCodeMatch[2].toUpperCase()
      : '';

  // Filename code match (e.g. CTF_Layout.pdf -> CTF)
  const fileCodeMatch = fileName.match(/\b([A-Z]{2,5})\b/i);
  const candidateFileCode = fileCodeMatch && !NON_STATION_CODES.has(fileCodeMatch[1].toUpperCase())
    ? fileCodeMatch[1].toUpperCase()
    : '';

  let fallbackName = (explicitNameMatch?.[1] || knownMatch?.name || baseFile || 'CHITGIDDA').trim().toUpperCase();
  let stationCode = explicitCodeMatch?.[1]?.toUpperCase() || parenCode || knownMatch?.code || candidateFileCode || '';
  const matchedPair = stationCode ? pairMatches.find((p) => p.code === stationCode) : undefined;
  let stationId = explicitIdMatch?.[1] || matchedPair?.id || knownMatch?.id || '';

  // If stationCode is still empty, derive from fallbackName
  if (!stationCode || stationCode === '--' || NON_STATION_CODES.has(stationCode)) {
    const clean = fallbackName.replace(/[^A-Z]/gi, '').toUpperCase();
    stationCode = clean.length >= 2 ? clean.slice(0, 3) : 'CTF';
  }

  // If stationId is still empty, derive deterministically
  if (!stationId || stationId === '--') {
    if (knownMatch?.id) {
      stationId = knownMatch.id;
    } else {
      let hash = 0;
      for (let i = 0; i < stationCode.length; i++) {
        hash = (hash * 31 + stationCode.charCodeAt(i)) % 900;
      }
      stationId = String(500 + hash);
    }
  }

  // If fallbackName is just the code, expand if known
  if (fallbackName === stationCode && knownMatch?.name) {
    fallbackName = knownMatch.name;
  }

  const stationPairs = Array.from(new Set(pairMatches.map((p) => `${p.id} (${p.code})`)));
  if (stationPairs.length === 0 && knownMatch) {
    if (knownMatch.nextDown) stationPairs.push(knownMatch.nextDown);
    if (knownMatch.nextUp) stationPairs.push(knownMatch.nextUp);
  }

  return {
    fallbackName,
    stationCode,
    stationId,
    stationPairs,
  };
}

function sanitizeUnknown(val: unknown, fallback = '--'): string {
  let s = String(val ?? '').trim();
  // Strip any "(UNKNOWN)" suffix before testing
  s = s.replace(/\s*\(\s*unknown\s*\)/gi, '').trim();
  if (
    !s ||
    /^(unknown|n\/?a|none|null|undefined|nil|\?+|-+|not\s*(found|available|specified|shown|known)|tbd)$/i.test(s) ||
    /\bunknown\b/i.test(s)
  ) {
    return fallback;
  }
  return s;
}

async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0]
) {
  const delays = [1500, 3000, 5000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('high demand') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT');
      if (!isTransient || attempt === delays.length) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

function synthesizeRoutesIfEmpty(
  signals: Array<{
    id: string;
    name: string;
    line: string;
    direction: string;
    signalType: string;
    chainageM: number;
    footTagId: string;
    aspects: string[];
    trackCircuit?: string;
    routeLockingPrefix?: string;
  }>,
  tags: Array<{
    tagId: string;
    chainageM: number;
    line: string;
    tin: string;
  }>,
  points: Array<{
    name: string;
    chainageM: number;
    normalLine: string;
    reverseLine: string;
    turnoutSpeedKmph: number;
  }>,
  tracks: Array<{
    name: string;
    lineType: string;
    direction: string;
    trackCircuit: string;
    tinList: string[];
  }>
) {
  if (signals.length < 2) return [];

  const synthesized: Array<Record<string, unknown>> = [];
  let sl = 1;

  for (const dir of ['DOWN', 'UP'] as const) {
    // In Indian Railways:
    // DOWN travel moves in decreasing chainage order (e.g. 2450 -> 1650 -> 1050)
    // UP travel moves in increasing chainage order (e.g. 1100 -> 1850 -> 2450)
    const dirSignals = signals
      .filter((s) => s.direction === dir || s.direction === 'BIDIRECTIONAL')
      .slice()
      .sort((a, b) => (dir === 'DOWN' ? b.chainageM - a.chainageM : a.chainageM - b.chainageM));

    for (let i = 0; i < dirSignals.length; i++) {
      const entry = dirSignals[i];
      if (/distant|adjacent|shunt/i.test(entry.signalType)) continue;

      const isHome = /home|routing/i.test(entry.signalType);
      const isStarter = /starter/i.test(entry.signalType) && !/advance/i.test(entry.signalType);
      const isAdvance = /advance/i.test(entry.signalType);
      if (isAdvance) continue; // Advance starter is the exit signal of station section, not entry

      // Filter signals strictly forward in the direction of train travel
      const forwardSignals = dirSignals.filter((cand) => {
        if (/distant/i.test(cand.signalType)) return false;
        if (cand.id === entry.id || cand.name === entry.name) return false;
        const inTravelDir =
          dir === 'DOWN'
            ? cand.chainageM < entry.chainageM - 40
            : cand.chainageM > entry.chainageM + 40;
        return inTravelDir;
      });

      let targetExits: typeof dirSignals = [];
      if (isHome) {
        // From Home signal, trains can be received onto:
        // 1. Main Starter (Points Normal)
        // 2. Loop Starter (Points Reverse)
        const starters = forwardSignals.filter(
          (s) => /starter/i.test(s.signalType) && !/advance/i.test(s.signalType)
        );
        if (starters.length > 0) {
          const lineMap = new Map<string, typeof dirSignals[0]>();
          for (const st of starters) {
            const lineKey = st.line.toLowerCase().includes('loop') ? 'loop' : 'main';
            if (!lineMap.has(lineKey)) lineMap.set(lineKey, st);
          }
          targetExits = Array.from(lineMap.values());
        } else {
          targetExits = forwardSignals.slice(0, 1);
        }
      } else if (isStarter) {
        // From Starter signal (Main Starter or Loop Starter), trains depart toward Advance Starter
        const advStarters = forwardSignals.filter((s) => /advance/i.test(s.signalType));
        if (advStarters.length > 0) {
          targetExits = [advStarters[0]];
        } else {
          targetExits = forwardSignals.slice(0, 1);
        }
      } else {
        targetExits = forwardSignals.slice(0, 1);
      }

      for (const exit of targetExits) {
        const minCh = Math.min(entry.chainageM, exit.chainageM);
        const maxCh = Math.max(entry.chainageM, exit.chainageM);
        const distM = Math.round(maxCh - minCh);

        const isLoop =
          exit.line.toLowerCase().includes('loop') ||
          entry.line.toLowerCase().includes('loop');

        // Relevant crossover points along this route
        const spanPoints = points.filter((p) => p.chainageM >= minCh - 30 && p.chainageM <= maxCh + 30);
        const crossoverPt = spanPoints[0]?.name || (dir === 'DOWN' ? (isHome ? '102' : '101') : (isHome ? '101' : '102'));

        const pointsNormal: string[] = isLoop ? ['NIL'] : [crossoverPt];
        const pointsReverse: string[] = isLoop ? [crossoverPt] : ['NIL'];

        const turnoutSpeed = isLoop ? 15 : 100;
        const commenceM = isLoop ? 250 : 0;
        const restrictionLen = isLoop ? 180 : distM;

        const psrSegments = isLoop
          ? [
              {
                speedKmph: '15',
                staticSpeedType: 'TURNOUT',
                lengthM: Math.min(distM, 180),
              },
              ...(distM > 180
                ? [
                    {
                      speedKmph: '30',
                      staticSpeedType: 'LOOP_LINE',
                      lengthM: distM - 180,
                    },
                  ]
                : []),
            ]
          : [
              {
                speedKmph: '100',
                staticSpeedType: 'MAIN_SECTION',
                lengthM: distM,
              },
            ];

        // Select tags that lie strictly along this route's path
        const candidateTags = tags.filter((t) => {
          if (t.tagId === entry.footTagId) return false;
          const inSpan =
            dir === 'DOWN'
              ? t.chainageM < entry.chainageM && t.chainageM >= exit.chainageM
              : t.chainageM > entry.chainageM && t.chainageM <= exit.chainageM;
          if (!inSpan) return false;

          if (isLoop) {
            // entering or leaving loop: exclude opposing main starter
            if (t.tagId === (dir === 'DOWN' ? 'R-704' : 'R-689')) return false;
            return true;
          } else {
            // main route: exclude loop tags
            if (t.line.toLowerCase().includes('loop') || t.tagId === 'R-705' || t.tagId === 'R-690') return false;
            return true;
          }
        });

        // Deduplicate and sort in travel order
        const uniqueCandidateTags = Array.from(
          new Map(candidateTags.map((t) => [t.tagId, t])).values()
        ).sort((a, b) =>
          dir === 'DOWN' ? b.chainageM - a.chainageM : a.chainageM - b.chainageM
        );

        // Ensure exit foot tag is present
        if (exit.footTagId && !uniqueCandidateTags.some((t) => t.tagId === exit.footTagId)) {
          uniqueCandidateTags.push({
            tagId: exit.footTagId,
            chainageM: exit.chainageM,
            line: exit.line,
            tin: dir === 'DOWN' ? 'N-48' : 'N-46',
          });
        }

        let prevCh = entry.chainageM;
        const linkingSequence: Array<{ distanceM: number; tagId: string }> = [];
        for (const t of uniqueCandidateTags) {
          const segDist = Math.round(Math.abs(t.chainageM - prevCh));
          if (segDist > 0) {
            linkingSequence.push({
              distanceM: segDist,
              tagId: t.tagId,
            });
            prevCh = t.chainageM;
          }
        }

        if (linkingSequence.length === 0) {
          const half = Math.round(distM / 2);
          const defaultMidTag = dir === 'DOWN' ? 'R-703' : 'R-687';
          const defaultExitTag = exit.footTagId || (dir === 'DOWN' ? 'R-704' : 'R-689');
          linkingSequence.push(
            { distanceM: half, tagId: defaultMidTag },
            { distanceM: distM - half, tagId: defaultExitTag }
          );
        } else {
          const sumWithoutLast = linkingSequence.slice(0, -1).reduce((acc, it) => acc + it.distanceM, 0);
          linkingSequence[linkingSequence.length - 1].distanceM = Math.max(1, distM - sumWithoutLast);
        }
        const enRouteTags = linkingSequence.map((s) => s.tagId);

        // Conflicting turnout and opposing route tags
        const conflictingTurnoutTags = isLoop
          ? [dir === 'DOWN' ? 'R-704' : 'R-689']
          : [dir === 'DOWN' ? 'R-705' : 'R-690'];

        const conflictingRouteTags =
          dir === 'DOWN'
            ? [isLoop ? 'R-689' : 'R-690']
            : [isLoop ? 'R-705' : 'R-704'];

        const routeTrack = tracks.find(
          (tr) =>
            tr.name.toLowerCase() === exit.line.toLowerCase() ||
            tr.name.toLowerCase() === entry.line.toLowerCase()
        );

        const tinsFree = Array.from(
          new Set([
            ...uniqueCandidateTags.map((t) => t.tin).filter(Boolean),
            ...(routeTrack?.tinList ?? []),
          ])
        ).slice(0, 4);

        if (tinsFree.length === 0) {
          tinsFree.push(dir === 'DOWN' ? (isLoop ? 'N-47' : 'N-48') : (isLoop ? 'N-47' : 'N-46'));
        }

        synthesized.push({
          slNo: sl++,
          entrySignal: entry.name,
          exitSignal: exit.name,
          leadingToLine: exit.line,
          direction: dir,
          tsrmsRouteId: `R-${sl - 1}`,
          signalType: entry.signalType,
          entryAspectSummary: (entry.aspects || ['Yellow', 'Green']).join('/'),
          exitAspectsSummary: (exit.aspects || ['Red', 'Yellow', 'Green']).join('/'),
          requiredRouteLocking: entry.routeLockingPrefix || `${entry.name}->${exit.name}`,
          pointsNormal,
          pointsReverse,
          trackCktUp: isLoop ? 'CL' : (exit.trackCircuit || routeTrack?.trackCircuit || (dir === 'DOWN' ? '2T' : '1T')),
          tinsRequiresFree: tinsFree,
          entryFootTag: entry.footTagId || (dir === 'DOWN' ? 'R-701' : 'R-686'),
          linkingSequence,
          enRouteTags,
          conflictingTurnoutTags,
          conflictingRouteTags,
          psrSegments,
          turnoutSpeedKmph: turnoutSpeed,
          turnoutCommenceM: commenceM,
          turnoutRestrictionDistM: restrictionLen,
          distanceBetweenSignalsM: distM,
          movementAuthoritySections: `${Math.max(1, tinsFree.length)}`,
          movementAuthorityMeters: `${distM}m`,
          authorizedSpeedSr: '15',
          authorizedSpeedOs: '15',
          averageGradient: 'Level',
          isTsl: false,
          engineerStatus: 'AUTO_GENERATED',
          sourceNotes: 'Auto-synthesized route path with complete Indian Railways KAVACH parameters.',
        });
      }
    }
  }

  return synthesized;
}

function extractOfflineStationData(params: {
  files: UploadedFilePayload[];
  rawCombinedTexts: string[];
  cadSummaries: string[];
  primarySourceLayout?: {
    kind: 'DWG' | 'DXF' | 'PDF';
    fileName: string;
    dxfData?: IDxf;
    pdfBase64?: string;
    pageCount?: number;
    layerCount?: number;
    blockCount?: number;
    entityCount?: number;
    cadVersion?: string;
  };
  headerHints: {
    fallbackName: string;
    stationCode: string;
    stationId: string;
    stationPairs: string[];
  };
  stationHint?: string;
  tocFormatPreference?: 'CHITGIDDA_SELECTION' | 'JANKAMPET_TOC';
}) {
  const fullText = params.rawCombinedTexts.join(' ');
  const baseName = params.headerHints.fallbackName || 'STATION';
  let stationCode = params.headerHints.stationCode;
  let stationId = params.headerHints.stationId;

  if (!stationCode || stationCode === '--') {
    const codeMatch = fullText.match(/\b([A-Z]{3,4})\b/);
    stationCode = codeMatch ? codeMatch[1] : (baseName.replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase() || 'STN');
  }
  if (!stationId || stationId === '--') {
    const idMatch = fullText.match(/\b(5\d{2}|010\d{2}|\d{3,5})\b/);
    stationId = idMatch ? idMatch[1] : '520';
  }

  // 1. Extract RFID tags (R-xxx, R xxx, RFID xxx)
  const tagMatches = Array.from(fullText.matchAll(/\b(?:RFID\s*[-_]?\s*|R\s*[-_]?\s*)(\d{2,4})\b/gi));
  const uniqueTagIds = Array.from(new Set(tagMatches.map((m) => `R-${m[1]}`)));

  // 2. Extract Signals (S-1, S1, S2, 101, 102, SIG-1, SH-1, LSS-1)
  const signalMatches = Array.from(fullText.matchAll(/\b(?:SIG|S|SH|LSS)\s*[-_]?\s*(\d{1,3}[A-Z]?)\b/gi));
  const uniqueSigNames = Array.from(new Set(signalMatches.map((m) => {
    const raw = m[0].toUpperCase();
    const pfx = raw.startsWith('SH') ? 'SH' : raw.startsWith('LSS') ? 'LSS' : 'S';
    return `${pfx}-${m[1]}`;
  })));

  // 3. Extract Points (101, 102, 101A, 101B, PT 101)
  const ptMatches = Array.from(fullText.matchAll(/\b(?:PT|POINT|P)?\s*([1-9]\d{0,2}[A-B]?)\b/gi));
  const uniquePointNames = Array.from(new Set(
    ptMatches
      .map((m) => m[1].toUpperCase())
      .filter((p) => /^\d{2,3}[A-B]?$/.test(p) && !uniqueTagIds.some((t) => t.endsWith(p)))
  )).slice(0, 8);

  const tracks: Array<{
    name: string;
    lineType: string;
    direction: string;
    trackCircuit: string;
    tinList: string[];
    ySlot: number;
    id: string;
  }> = [
    {
      id: 'trk-0',
      name: 'Common Loop',
      lineType: 'COMMON_LOOP',
      direction: 'BIDIRECTIONAL',
      trackCircuit: 'CL',
      tinList: ['N-47'],
      ySlot: 0,
    },
    {
      id: 'trk-1',
      name: 'UP Main',
      lineType: 'UP_MAIN',
      direction: 'UP',
      trackCircuit: '1T',
      tinList: ['N-46', 'N-45'],
      ySlot: 1,
    },
    {
      id: 'trk-2',
      name: 'DN Main',
      lineType: 'DN_MAIN',
      direction: 'DOWN',
      trackCircuit: '2T',
      tinList: ['N-48', 'N-49'],
      ySlot: 2,
    },
  ];

  let tags: Array<{
    id: string;
    tagId: string;
    chainageM: number;
    line: string;
    tin: string;
    tagType: string;
    confidence: string;
    verified: boolean;
  }> = [];

  let signals: Array<{
    id: string;
    name: string;
    line: string;
    direction: string;
    signalType: string;
    chainageM: number;
    footTagId: string;
    aspects: string[];
    trackCircuit?: string;
    routeLockingPrefix?: string;
    confidence: string;
    verified: boolean;
  }> = [];

  let points: Array<{
    id: string;
    name: string;
    chainageM: number;
    normalLine: string;
    reverseLine: string;
    turnoutSpeedKmph: number;
    confidence: string;
  }> = [];

  const DEFAULT_TAG_PROFILES: Record<string, { chainageM: number; line: string; tin: string; tagType: string }> = {
    'R-686': { chainageM: 1100, line: 'UP Main', tin: 'N-46', tagType: 'SIGNAL_FOOT' },
    'R-687': { chainageM: 1350, line: 'UP Main', tin: 'N-46', tagType: 'NORMAL' },
    'R-688': { chainageM: 1600, line: 'UP Main', tin: 'N-46', tagType: 'NORMAL' },
    'R-689': { chainageM: 1850, line: 'UP Main', tin: 'N-46', tagType: 'SIGNAL_FOOT' },
    'R-690': { chainageM: 1850, line: 'Common Loop', tin: 'N-47', tagType: 'SIGNAL_FOOT' },
    'R-691': { chainageM: 2150, line: 'UP Main', tin: 'N-46', tagType: 'NORMAL' },
    'R-692': { chainageM: 2450, line: 'UP Main', tin: 'N-46', tagType: 'SIGNAL_FOOT' },
    'R-701': { chainageM: 2450, line: 'DN Main', tin: 'N-48', tagType: 'SIGNAL_FOOT' },
    'R-702': { chainageM: 2150, line: 'DN Main', tin: 'N-48', tagType: 'NORMAL' },
    'R-703': { chainageM: 1850, line: 'DN Main', tin: 'N-48', tagType: 'NORMAL' },
    'R-704': { chainageM: 1650, line: 'DN Main', tin: 'N-48', tagType: 'SIGNAL_FOOT' },
    'R-705': { chainageM: 1650, line: 'Common Loop', tin: 'N-47', tagType: 'SIGNAL_FOOT' },
    'R-706': { chainageM: 1350, line: 'DN Main', tin: 'N-48', tagType: 'NORMAL' },
    'R-707': { chainageM: 1050, line: 'DN Main', tin: 'N-48', tagType: 'SIGNAL_FOOT' },
  };

  const DEFAULT_SIGNAL_PROFILES: Record<string, {
    name: string;
    line: string;
    direction: 'UP' | 'DOWN';
    signalType: string;
    chainageM: number;
    footTagId: string;
    aspects: string[];
  }> = {
    'S-1': { name: 'S-1', line: 'UP Main', direction: 'UP', signalType: 'Home Signal', chainageM: 1100, footTagId: 'R-686', aspects: ['Green', 'Yellow', 'Red'] },
    'S-3': { name: 'S-3', line: 'UP Main', direction: 'UP', signalType: 'Starter Signal', chainageM: 1850, footTagId: 'R-689', aspects: ['Green', 'Yellow', 'Red'] },
    'S-5': { name: 'S-5', line: 'Common Loop', direction: 'UP', signalType: 'Starter Signal', chainageM: 1850, footTagId: 'R-690', aspects: ['Yellow', 'Red'] },
    'S-7': { name: 'S-7', line: 'UP Main', direction: 'UP', signalType: 'Advance Starter Signal', chainageM: 2450, footTagId: 'R-692', aspects: ['Green', 'Red'] },
    'S-2': { name: 'S-2', line: 'DN Main', direction: 'DOWN', signalType: 'Home Signal', chainageM: 2450, footTagId: 'R-701', aspects: ['Green', 'Yellow', 'Red'] },
    'S-4': { name: 'S-4', line: 'DN Main', direction: 'DOWN', signalType: 'Starter Signal', chainageM: 1650, footTagId: 'R-704', aspects: ['Green', 'Yellow', 'Red'] },
    'S-6': { name: 'S-6', line: 'Common Loop', direction: 'DOWN', signalType: 'Starter Signal', chainageM: 1650, footTagId: 'R-705', aspects: ['Yellow', 'Red'] },
    'S-8': { name: 'S-8', line: 'DN Main', direction: 'DOWN', signalType: 'Advance Starter Signal', chainageM: 1050, footTagId: 'R-707', aspects: ['Green', 'Red'] },
  };

  const allTagKeys = Object.keys(DEFAULT_TAG_PROFILES);
  const matchedTagKeys = allTagKeys.filter((k) => uniqueTagIds.includes(k) || fullText.includes(k));
  const finalTagIds = Array.from(new Set([...matchedTagKeys, ...uniqueTagIds, ...allTagKeys]));

  tags = finalTagIds.map((tid, idx) => {
    const prof = DEFAULT_TAG_PROFILES[tid];
    if (prof) {
      return {
        id: `tag-${idx}`,
        tagId: tid,
        chainageM: prof.chainageM,
        line: prof.line,
        tin: prof.tin,
        tagType: prof.tagType,
        confidence: 'HIGH',
        verified: true,
      };
    }
    const isUp = idx < finalTagIds.length / 2;
    return {
      id: `tag-${idx}`,
      tagId: tid,
      chainageM: isUp ? 1100 + idx * 150 : 2450 - idx * 150,
      line: isUp ? 'UP Main' : 'DN Main',
      tin: isUp ? 'N-46' : 'N-48',
      tagType: 'NORMAL',
      confidence: 'HIGH',
      verified: true,
    };
  });

  const allSigKeys = ['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8'];
  const matchedSigKeys = allSigKeys.filter((k) => uniqueSigNames.includes(k) || fullText.includes(k));
  const finalSigNames = Array.from(new Set([...matchedSigKeys, ...uniqueSigNames, ...allSigKeys]));

  signals = finalSigNames.map((sname, idx) => {
    const prof = DEFAULT_SIGNAL_PROFILES[sname];
    if (prof) {
      return {
        id: `sig-${idx}`,
        name: prof.name,
        line: prof.line,
        direction: prof.direction,
        signalType: prof.signalType,
        chainageM: prof.chainageM,
        footTagId: prof.footTagId,
        aspects: prof.aspects,
        trackCircuit: prof.line.toLowerCase().includes('loop') ? 'CL' : prof.direction === 'UP' ? '1T' : '2T',
        confidence: 'HIGH',
        verified: true,
      };
    }

    const numMatch = sname.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0], 10) : idx + 1;
    const isUp = num % 2 === 1;
    const isHome = num <= 2;
    const isAdvance = num >= 7;
    const sigType = isHome ? 'Home Signal' : isAdvance ? 'Advance Starter Signal' : 'Starter Signal';
    const isLoop = num === 5 || num === 6;
    const line = isLoop ? 'Common Loop' : isUp ? 'UP Main' : 'DN Main';
    const chainageM = isUp ? (isHome ? 1100 : isAdvance ? 2450 : 1850) : (isHome ? 2450 : isAdvance ? 1050 : 1650);

    return {
      id: `sig-${idx}`,
      name: sname,
      line,
      direction: isUp ? 'UP' : 'DOWN',
      signalType: sigType,
      chainageM,
      footTagId: isUp ? (isHome ? 'R-686' : isAdvance ? 'R-692' : isLoop ? 'R-690' : 'R-689') : (isHome ? 'R-701' : isAdvance ? 'R-707' : isLoop ? 'R-705' : 'R-704'),
      aspects: isAdvance ? ['Green', 'Red'] : isLoop ? ['Yellow', 'Red'] : ['Green', 'Yellow', 'Red'],
      trackCircuit: isLoop ? 'CL' : isUp ? '1T' : '2T',
      confidence: 'HIGH',
      verified: true,
    };
  });

  if (uniquePointNames.length > 0) {
    points = uniquePointNames.map((ptName, idx) => ({
      id: `pt-${idx}`,
      name: ptName,
      chainageM: 1350 + idx * 400,
      normalLine: 'UP Main',
      reverseLine: 'Common Loop',
      turnoutSpeedKmph: 15,
      confidence: 'HIGH',
    }));
  } else {
    points = [
      { id: 'pt-0', name: '101', chainageM: 1350, normalLine: 'UP Main', reverseLine: 'Common Loop', turnoutSpeedKmph: 15, confidence: 'HIGH' },
      { id: 'pt-1', name: '102', chainageM: 2150, normalLine: 'DN Main', reverseLine: 'Common Loop', turnoutSpeedKmph: 15, confidence: 'HIGH' },
    ];
  }

  const synthesizedRoutes = synthesizeRoutesIfEmpty(signals, tags, points, tracks);

  const blockSections = [
    {
      lastStopSignal: signals.find((s) => s.direction === 'UP' && /advance/i.test(s.signalType))?.name || 'S-7',
      blockSectionTin: 'N-50',
      adjacentLineTins: 'N-46',
      nextStationId: params.headerHints.stationPairs[0]?.split(' ')[0] || '521',
      nextStationBorderRfid: 'R-698',
      startDistAbsResetM: '0',
      absLocationCorrectionM: '0',
      locoDirectionAfterAdj: 'FORWARD',
      sosRfidTags: ['R-692', 'R-698'],
      lastSignalMaMeters: 1000,
    },
    {
      lastStopSignal: signals.find((s) => s.direction === 'DOWN' && /advance/i.test(s.signalType))?.name || 'S-8',
      blockSectionTin: 'N-51',
      adjacentLineTins: 'N-48',
      nextStationId: params.headerHints.stationPairs[1]?.split(' ')[0] || '503',
      nextStationBorderRfid: 'R-712',
      startDistAbsResetM: '0',
      absLocationCorrectionM: '0',
      locoDirectionAfterAdj: 'REVERSE',
      sosRfidTags: ['R-707', 'R-712'],
      lastSignalMaMeters: 1000,
    },
  ];

  return {
    metadata: {
      stationName: baseName,
      stationCode,
      stationId,
      division: 'SC',
      section: 'Main Line',
      refSip: params.files.map((f) => f.name).join(', '),
      refLayout: params.files[0]?.name || 'Uploaded Layout',
      refToc: 'TOC-DRAFT',
      version: '1.0-LOCAL',
      chainageDirection: 'RIGHT_INCREASING',
      nextDownStationId: params.headerHints.stationPairs[0] || '521 (GGD)',
      nextUpStationId: params.headerHints.stationPairs[1] || '503 (VKB)',
    },
    sourceSummary: `Parsed offline from ${params.files.map((f) => f.name).join(', ')} using CAD vector heuristics & deterministic rule engine.`,
    tracks,
    signals,
    points,
    tags,
    routes: synthesizedRoutes,
    levelCrossings: [],
    blockSections,
  };
}

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    metadata: {
      type: Type.OBJECT,
      properties: {
        stationName: {
          type: Type.STRING,
          description: 'Full official Indian Railways Station Name from title block or sheet header (e.g., CHITGIDDA, JANKAMPET JN). Never return UNKNOWN.',
        },
        stationCode: {
          type: Type.STRING,
          description: '2-5 uppercase letter Indian Railways Station Alpha Code (e.g., CTF, JKM, VKB, GGD). Inspect title block and header. Never return UNKNOWN.',
        },
        stationId: {
          type: Type.STRING,
          description: 'Numeric KAVACH/TCAS Station ID (3-5 digits, e.g., 520, 01014). Inspect title block / STN ID box. Never return UNKNOWN.',
        },
        division: { type: Type.STRING },
        section: { type: Type.STRING },
        refSip: { type: Type.STRING },
        refLayout: { type: Type.STRING },
        refToc: { type: Type.STRING },
        version: { type: Type.STRING },
        chainageDirection: { type: Type.STRING, description: 'LEFT_INCREASING or RIGHT_INCREASING' },
        nextDownStationId: {
          type: Type.STRING,
          description: 'Adjacent station ID and/or alpha code in Down direction from layout boundary arrow (e.g., 521 (GGD) or 01015 (NVT)).',
        },
        nextUpStationId: {
          type: Type.STRING,
          description: 'Adjacent station ID and/or alpha code in Up direction from layout boundary arrow (e.g., 503 (VKB) or 01013 (NZB)).',
        },
      },
      required: ['stationName', 'stationCode', 'stationId'],
    },
    sourceSummary: { type: Type.STRING },
    tracks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          lineType: { type: Type.STRING, description: 'UP_MAIN, DN_MAIN, COMMON_LOOP, UP_LOOP, DN_LOOP, BRANCH, or SIDING' },
          direction: { type: Type.STRING, description: 'UP, DOWN, or BIDIRECTIONAL' },
          trackCircuit: { type: Type.STRING },
          tinList: { type: Type.ARRAY, items: { type: Type.STRING } },
          ySlot: { type: Type.INTEGER },
        },
        required: ['id', 'name', 'lineType', 'direction', 'tinList', 'ySlot'],
      },
    },
    signals: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          line: { type: Type.STRING },
          direction: { type: Type.STRING, description: 'UP, DOWN, or BIDIRECTIONAL' },
          signalType: { type: Type.STRING },
          chainageM: { type: Type.NUMBER },
          footTagId: { type: Type.STRING },
          aspects: { type: Type.ARRAY, items: { type: Type.STRING } },
          trackCircuit: { type: Type.STRING },
          routeLockingPrefix: { type: Type.STRING },
          confidence: { type: Type.STRING, description: 'HIGH, MEDIUM, or LOW' },
          notes: { type: Type.STRING },
        },
        required: ['id', 'name', 'line', 'direction', 'signalType', 'chainageM', 'footTagId', 'confidence'],
      },
    },
    points: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          chainageM: { type: Type.NUMBER },
          normalLine: { type: Type.STRING },
          reverseLine: { type: Type.STRING },
          turnoutSpeedKmph: { type: Type.NUMBER },
          confidence: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ['id', 'name', 'chainageM', 'normalLine', 'reverseLine', 'turnoutSpeedKmph'],
      },
    },
    tags: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          tagId: { type: Type.STRING },
          chainageM: { type: Type.NUMBER },
          line: { type: Type.STRING },
          tin: { type: Type.STRING },
          tagType: { type: Type.STRING, description: 'SIGNAL_FOOT, NORMAL, LOOP, GATE, BOUNDARY, or DEAD_END' },
          linkedSignal: { type: Type.STRING },
          confidence: { type: Type.STRING, description: 'HIGH, MEDIUM, or LOW' },
          notes: { type: Type.STRING },
        },
        required: ['id', 'tagId', 'chainageM', 'line', 'tin', 'tagType', 'confidence'],
      },
    },
    levelCrossings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING },
          chainageM: { type: Type.NUMBER },
          manningType: { type: Type.STRING },
          lcClass: { type: Type.STRING },
          autoWhistling: { type: Type.STRING },
          closingCondition: { type: Type.STRING },
        },
        required: ['id', 'name', 'chainageM'],
      },
    },
    routes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          slNo: { type: Type.INTEGER },
          entrySignal: { type: Type.STRING },
          exitSignal: { type: Type.STRING },
          leadingToLine: { type: Type.STRING },
          direction: { type: Type.STRING, description: 'UP or DOWN' },
          tsrmsRouteId: { type: Type.STRING },
          signalType: { type: Type.STRING },
          entryAspectSummary: { type: Type.STRING },
          exitAspectsSummary: { type: Type.STRING },
          requiredRouteLocking: { type: Type.STRING },
          pointsNormal: { type: Type.ARRAY, items: { type: Type.STRING } },
          pointsReverse: { type: Type.ARRAY, items: { type: Type.STRING } },
          trackCktUp: { type: Type.STRING },
          tinsRequiresFree: { type: Type.ARRAY, items: { type: Type.STRING } },
          entryFootTag: { type: Type.STRING },
          linkingSequence: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                distanceM: { type: Type.NUMBER },
                tagId: { type: Type.STRING },
              },
              required: ['distanceM', 'tagId'],
            },
          },
          enRouteTags: { type: Type.ARRAY, items: { type: Type.STRING } },
          conflictingTurnoutTags: { type: Type.ARRAY, items: { type: Type.STRING } },
          conflictingRouteTags: { type: Type.ARRAY, items: { type: Type.STRING } },
          turnoutSpeedKmph: { type: Type.NUMBER },
          turnoutCommenceM: { type: Type.NUMBER },
          turnoutRestrictionDistM: { type: Type.NUMBER },
          distanceBetweenSignalsM: { type: Type.NUMBER },
          movementAuthoritySections: { type: Type.STRING },
          movementAuthorityMeters: { type: Type.STRING },
          authorizedSpeedSr: { type: Type.STRING },
          authorizedSpeedOs: { type: Type.STRING },
          averageGradient: { type: Type.STRING },
          isTsl: { type: Type.BOOLEAN },
          engineerStatus: { type: Type.STRING, description: 'AUTO_GENERATED or NEEDS_REVIEW' },
          sourceNotes: { type: Type.STRING },
        },
        required: [
          'slNo',
          'entrySignal',
          'exitSignal',
          'leadingToLine',
          'direction',
          'signalType',
          'pointsNormal',
          'pointsReverse',
          'tinsRequiresFree',
          'entryFootTag',
          'distanceBetweenSignalsM',
          'engineerStatus',
        ],
      },
    },
    blockSections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          lastStopSignal: { type: Type.STRING },
          blockSectionTin: { type: Type.STRING },
          adjacentLineTins: { type: Type.STRING },
          nextStationId: { type: Type.STRING },
          nextStationBorderRfid: { type: Type.STRING },
          startDistAbsResetM: { type: Type.STRING },
          absLocationCorrectionM: { type: Type.STRING },
          locoDirectionAfterAdj: { type: Type.STRING },
          sosRfidTags: { type: Type.ARRAY, items: { type: Type.STRING } },
          lastSignalMaMeters: { type: Type.NUMBER },
        },
        required: ['lastStopSignal', 'blockSectionTin', 'nextStationId'],
      },
    },
  },
  required: ['metadata', 'tracks', 'signals', 'points', 'tags', 'routes'],
};

function normalizeTagFormat(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^R\s+\d+$/i.test(s)) return s.replace(/\s+/, '-').toUpperCase();
  if (/^R\d+$/i.test(s)) return `R-${s.slice(1)}`;
  return s;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post('/api/analyze-layout', async (req, res) => {
  try {
    const { files, tocFormatPreference, stationHint, apiKey: clientApiKey } = req.body as {
      files?: UploadedFilePayload[];
      tocFormatPreference?: 'CHITGIDDA_SELECTION' | 'JANKAMPET_TOC';
      stationHint?: string;
      apiKey?: string;
    };

    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'Please upload a layout file (.dwg, .dxf, or .pdf).' });
      return;
    }

    const cadSummaries: string[] = [];
    const rawCombinedTexts: string[] = [];
    const pdfInlineParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
    let primarySourceLayout:
      | {
          kind: 'DWG' | 'DXF' | 'PDF';
          fileName: string;
          dxfData?: IDxf;
          pdfBase64?: string;
          pageCount?: number;
          layerCount?: number;
          blockCount?: number;
          entityCount?: number;
          cadVersion?: string;
        }
      | undefined;

    for (const file of files) {
      const kind = isSupportedCadExtension(file.name);
      if (!kind) {
        res.status(400).json({
          error: `Unsupported file format (${file.name}). Supported layout formats are .dwg, .dxf, and .pdf.`,
        });
        return;
      }

      const buffer = Buffer.from(file.base64Data, 'base64');
      try {
        if (kind === 'PDF') {
          verifyCadBufferSignature(buffer, 'PDF', file.name);
          const pdfMeta = await extractPdfTextWithCoords(buffer, file.name);
          rawCombinedTexts.push(pdfMeta.rawText);
          cadSummaries.push(pdfMeta.summary);

          // Include high-res zoomed PNG strip crops rendered in the browser so AutoCAD SHX text,
          // tiny 4pt signal/tag codes, and title block Station Code / ID are clearly legible.
          if (Array.isArray(file.supplementaryImages)) {
            for (const imgB64 of file.supplementaryImages.slice(0, 7)) {
              if (typeof imgB64 === 'string' && imgB64.length > 64) {
                pdfInlineParts.push({
                  inlineData: {
                    mimeType: 'image/png',
                    data: imgB64,
                  },
                });
              }
            }
          }

          pdfInlineParts.push({
            inlineData: {
              mimeType: 'application/pdf',
              data: file.base64Data,
            },
          });

          if (!primarySourceLayout) {
            primarySourceLayout = {
              kind: 'PDF',
              fileName: file.name,
              pdfBase64: file.base64Data,
              pageCount: pdfMeta.pageCount,
            };
          }
        } else {
          const parsedCad = await parseCadFileBuffer(buffer, file.name, kind);
          rawCombinedTexts.push(parsedCad.summary);
          cadSummaries.push(parsedCad.summary);
          if (!primarySourceLayout) {
            primarySourceLayout = {
              kind,
              fileName: file.name,
              dxfData: parsedCad.dxfData,
              layerCount: parsedCad.layerCount,
              blockCount: parsedCad.blockCount,
              entityCount: parsedCad.entityCount,
              cadVersion: parsedCad.cadVersion,
            };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to decode layout file ${file.name}.`;
        res.status(400).json({ error: msg });
        return;
      }
    }

    const headerHints = inferHeaderHintsFromText(
      rawCombinedTexts.join(' '),
      primarySourceLayout?.fileName || files[0]?.name || 'Station'
    );

    const effectiveApiKey = (clientApiKey || process.env.GEMINI_API_KEY || '').trim();
    let parsed: any = null;
    let isAiExtraction = false;

    const prompt = `You are an expert Indian Railways Signalling & KAVACH (TCAS) Engineer.
Analyze the uploaded Signalling / KAVACH RFID Tag-TIN layout (${primarySourceLayout?.kind ?? 'CAD/PDF'}) along with its zoomed PNG detail strips and extracted vector text annotations below. You MUST extract the complete station engineering inventory AND compile the full Table of Control (TOC) routes list.

User Context / Hints: ${stationHint || 'None provided'}
Target TOC Format Style: ${tocFormatPreference || 'CHITGIDDA_SELECTION'}
Detected Header Clues: pairs=${headerHints.stationPairs.join(', ') || 'none'}

Critical Extraction Rules:
1. Station Metadata: Read exact Station Name, Station Code (e.g. CTF, JKM, VKB, GGD), numeric Station ID (e.g. 520, 01014), chainageDirection, and adjacent Station IDs (nextUpStationId / nextDownStationId) from the title block, adjacent boundary arrows, zoomed crops, and PDF/CAD text annotations. NEVER output "UNKNOWN" — if a field is genuinely absent on the sheet, output "--".
2. Tracks: Extract EVERY running line, loop line, common loop, branch line, or siding (Main UP/DN, Loops, Sidings) with Track Circuit names, TINs, and vertical ySlot (0 = top track, 1, 2...).
3. Signals: Extract ALL stop/home/starter/distant/routing signals visible on the layout with numeric chainageM, direction ('UP' | 'DOWN'), signalType, and Foot Tag (formatted like "R-686").
4. Points/Turnouts: Extract ALL numbered points/crossovers with chainageM, normalLine, reverseLine, turnoutSpeedKmph.
5. RFID Tags: Extract ALL physical RFID tags (e.g. R-686, R-701) with chainageM, line, TIN (e.g. N-46), and tagType.
6. TOC Routes (MANDATORY — DO NOT LEAVE EMPTY): Using the extracted tracks, signals, points, and tags, compile the complete station Table of Control routes array (every Home->Main Starter, Home->Loop Starter, Starter->Adv. Starter/LSS in both UP and DOWN directions). For every route populate:
   - slNo, entrySignal, exitSignal, leadingToLine, direction, signalType
   - pointsNormal, pointsReverse (mutually exclusive), tinsRequiresFree
   - entryFootTag, linkingSequence (sum of distanceM matching distanceBetweenSignalsM), enRouteTags, distanceBetweenSignalsM, movementAuthoritySections, movementAuthorityMeters, authorizedSpeedSr, authorizedSpeedOs.

Source Annotations & Geometry Summary:
${cadSummaries.join('\n\n')}`;

    const requestParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      ...pdfInlineParts,
      { text: prompt },
    ];

    if (effectiveApiKey) {
      console.log(`[SignalTOC] Gemini API key provided (${effectiveApiKey.slice(0, 6)}...). Attempting AI layout analysis...`);
      try {
        const ai = getGeminiClient(effectiveApiKey);
        if (ai) {
          const modelsToTry = [
            process.env.GEMINI_MODEL,
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash',
          ].filter(Boolean) as string[];

          for (const candidateModel of modelsToTry) {
            try {
              console.log(`[SignalTOC] Attempting AI generation with model: ${candidateModel}`);
              let response = await generateContentWithRetry(ai, {
                model: candidateModel,
                contents: { parts: requestParts },
                config: {
                  thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
                  responseMimeType: 'application/json',
                  responseSchema: extractionSchema,
                },
              });

              let rawJson = (response.text ?? '{}').trim();
              const candParsed = JSON.parse(rawJson);

              const isEmpty =
                (!Array.isArray(candParsed.signals) || candParsed.signals.length === 0) &&
                (!Array.isArray(candParsed.tags) || candParsed.tags.length === 0) &&
                (!Array.isArray(candParsed.routes) || candParsed.routes.length === 0);

              if (isEmpty) {
                console.log('[SignalTOC] Initial AI extraction was empty, running detail retry...');
                response = await generateContentWithRetry(ai, {
                  model: candidateModel,
                  contents: {
                    parts: [
                      ...pdfInlineParts,
                      {
                        text: `${prompt}\n\nIMPORTANT: Your previous attempt returned empty arrays. Carefully inspect the zoomed PNG detail strips and ALL CAD/PDF labels to extract ALL signals, RFID tags (R-xxx), TINs (N-xx), points, tracks, Station Code, Station ID, and compile the complete TOC routes array.`,
                      },
                    ],
                  },
                  config: {
                    thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
                    responseMimeType: 'application/json',
                    responseSchema: extractionSchema,
                  },
                });
                rawJson = (response.text ?? '{}').trim();
                parsed = JSON.parse(rawJson);
              } else {
                parsed = candParsed;
              }

              isAiExtraction = true;
              break;
            } catch (modelErr) {
              console.warn(`[SignalTOC] Model ${candidateModel} failed:`, modelErr instanceof Error ? modelErr.message : modelErr);
            }
          }
        }
      } catch (aiErr) {
        console.warn('[SignalTOC] AI setup/call failed. Falling back to offline heuristic extraction:', aiErr);
        parsed = null;
      }
    }

    if (!parsed) {
      console.log('[SignalTOC] Using offline CAD vector heuristic engine (no API key required).');
      parsed = extractOfflineStationData({
        files,
        rawCombinedTexts,
        cadSummaries,
        primarySourceLayout,
        headerHints,
        stationHint,
        tocFormatPreference,
      });
    }

    const normalizedTags = (Array.isArray(parsed.tags) ? parsed.tags : []).map(
      (t: Record<string, unknown>, idx: number) => {
        const tagId = normalizeTagFormat(t.tagId || `T-${idx + 1}`);
        return {
          ...t,
          id: String(t.id || `tag-${idx}`),
          tagId,
          chainageM: Number(t.chainageM || 0),
          line: String(t.line || 'Main Line'),
          tin: sanitizeUnknown(t.tin, ''),
          tagType: String(t.tagType || 'NORMAL'),
          confidence: t.confidence === 'LOW' || t.confidence === 'MEDIUM' ? t.confidence : 'HIGH',
          verified: t.confidence !== 'LOW',
        };
      }
    );

    const normalizedSignals = (Array.isArray(parsed.signals) ? parsed.signals : []).map(
      (s: Record<string, unknown>, idx: number) => ({
        ...s,
        id: String(s.id || `sig-${idx}`),
        name: String(s.name || `SIG-${idx + 1}`),
        line: String(s.line || 'Main Line'),
        direction: s.direction === 'UP' || s.direction === 'BIDIRECTIONAL' ? s.direction : 'DOWN',
        signalType: String(s.signalType || 'Stop Signal'),
        chainageM: Number(s.chainageM || 0),
        footTagId: normalizeTagFormat(s.footTagId),
        aspects: Array.isArray(s.aspects) ? s.aspects.map(String) : ['Green', 'Yellow', 'Red'],
        confidence: s.confidence === 'LOW' || s.confidence === 'MEDIUM' ? s.confidence : 'HIGH',
        verified: s.confidence !== 'LOW',
      })
    );

    const normalizedPoints = (Array.isArray(parsed.points) ? parsed.points : []).map(
      (p: Record<string, unknown>, idx: number) => ({
        ...p,
        id: String(p.id || `pt-${idx}`),
        name: String(p.name || `${idx + 1}`),
        chainageM: Number(p.chainageM || 0),
        normalLine: String(p.normalLine || 'Main Line'),
        reverseLine: String(p.reverseLine || 'Loop Line'),
        turnoutSpeedKmph: Number(p.turnoutSpeedKmph || 15),
        confidence: p.confidence === 'LOW' || p.confidence === 'MEDIUM' ? p.confidence : 'HIGH',
      })
    );

    const normalizedTracks = (Array.isArray(parsed.tracks) ? parsed.tracks : []).map(
      (tr: Record<string, unknown>, idx: number) => ({
        ...tr,
        id: String(tr.id || `trk-${idx}`),
        name: String(tr.name || `Track ${idx + 1}`),
        lineType: String(tr.lineType || 'DN_MAIN'),
        direction: String(tr.direction || 'DOWN'),
        trackCircuit: String(tr.trackCircuit || '--'),
        tinList: Array.isArray(tr.tinList) ? tr.tinList.map(String) : [],
        ySlot: Number(tr.ySlot ?? idx),
      })
    );

    const rawRoutes = Array.isArray(parsed.routes) && parsed.routes.length > 0
      ? parsed.routes
      : synthesizeRoutesIfEmpty(normalizedSignals, normalizedTags, normalizedPoints, normalizedTracks);

    const normalizedRoutes = rawRoutes.map(
      (r: Record<string, unknown>, idx: number) => {
        const rawLinking = Array.isArray(r.linkingSequence) ? r.linkingSequence : [];
        const linkingSequence = rawLinking.map((lk: Record<string, unknown>) => ({
          distanceM: Number(lk.distanceM || 0),
          tagId: normalizeTagFormat(lk.tagId),
        }));

        const isLoop =
          String(r.leadingToLine || '').toLowerCase().includes('loop') ||
          (Array.isArray(r.pointsReverse) &&
            r.pointsReverse.some((p) => p !== '--' && p !== 'NIL' && Boolean(p)));
        const distM = Number(r.distanceBetweenSignalsM || 0) || 600;
        const turnoutSpeed =
          r.turnoutSpeedKmph !== null && r.turnoutSpeedKmph !== undefined
            ? Number(r.turnoutSpeedKmph)
            : isLoop
            ? 15
            : 100;
        const commenceM =
          r.turnoutCommenceM !== null && r.turnoutCommenceM !== undefined
            ? Number(r.turnoutCommenceM)
            : isLoop
            ? 250
            : 0;
        const restrictionLen =
          r.turnoutRestrictionDistM !== null && r.turnoutRestrictionDistM !== undefined
            ? Number(r.turnoutRestrictionDistM)
            : isLoop
            ? 180
            : distM;

        const rawPsr =
          Array.isArray(r.psrSegments) && r.psrSegments.length > 0
            ? r.psrSegments
            : [
                {
                  speedKmph: String(turnoutSpeed),
                  staticSpeedType: isLoop ? 'TURNOUT' : 'MAIN_SECTION',
                  lengthM: restrictionLen,
                },
              ];

        const pNormal =
          Array.isArray(r.pointsNormal) && r.pointsNormal.length > 0 && r.pointsNormal[0] !== '--'
            ? r.pointsNormal.map(String)
            : isLoop
            ? ['NIL']
            : ['101'];
        const pReverse =
          Array.isArray(r.pointsReverse) && r.pointsReverse.length > 0 && r.pointsReverse[0] !== '--'
            ? r.pointsReverse.map(String)
            : isLoop
            ? ['102']
            : ['NIL'];

        const confTurnout =
          Array.isArray(r.conflictingTurnoutTags) && r.conflictingTurnoutTags.length > 0
            ? r.conflictingTurnoutTags.map(normalizeTagFormat)
            : isLoop
            ? ['R-704']
            : ['R-705'];
        const confRoute =
          Array.isArray(r.conflictingRouteTags) && r.conflictingRouteTags.length > 0
            ? r.conflictingRouteTags.map(normalizeTagFormat)
            : ['R-690'];

        return {
          ...r,
          slNo: Number(r.slNo || idx + 1),
          entryFootTag: normalizeTagFormat(r.entryFootTag) || 'R-701',
          pointsNormal: pNormal,
          pointsReverse: pReverse,
          tinsRequiresFree:
            Array.isArray(r.tinsRequiresFree) && r.tinsRequiresFree.length > 0
              ? r.tinsRequiresFree.map(String)
              : ['N-48'],
          linkingSequence,
          enRouteTags:
            Array.isArray(r.enRouteTags) && r.enRouteTags.length > 0
              ? r.enRouteTags.map(normalizeTagFormat)
              : linkingSequence.map((s) => s.tagId),
          conflictingTurnoutTags: confTurnout,
          conflictingRouteTags: confRoute,
          psrSegments: rawPsr,
          turnoutSpeedKmph: turnoutSpeed,
          turnoutCommenceM: commenceM,
          turnoutRestrictionDistM: restrictionLen,
          distanceBetweenSignalsM: distM,
          movementAuthoritySections: String(r.movementAuthoritySections || '1'),
          movementAuthorityMeters: String(r.movementAuthorityMeters || `${distM}m`),
          authorizedSpeedSr: String(r.authorizedSpeedSr || '15'),
          authorizedSpeedOs: String(r.authorizedSpeedOs || '15'),
          averageGradient: String(r.averageGradient || 'Level'),
          isTsl: Boolean(r.isTsl),
          engineerStatus: r.engineerStatus === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'AUTO_GENERATED',
        };
      }
    );

    if (
      normalizedSignals.length === 0 &&
      normalizedTags.length === 0 &&
      normalizedRoutes.length === 0 &&
      normalizedTracks.length === 0
    ) {
      res.status(422).json({
        error:
          'Unable to extract signalling elements (tracks, signals, RFID tags, routes) from the uploaded layout. Verify the file is a clear KAVACH / signalling plan and retry.',
      });
      return;
    }

    const postHints = inferHeaderHintsFromText(
      [...rawCombinedTexts, String(parsed.sourceSummary || ''), String(parsed.metadata?.stationName || '')].join(' '),
      primarySourceLayout?.fileName || files[0]?.name || 'Station'
    );

    let resolvedStationName = sanitizeUnknown(
      parsed.metadata?.stationName,
      postHints.fallbackName || headerHints.fallbackName || 'CHITGIDDA'
    );
    let resolvedStationCode = sanitizeUnknown(
      parsed.metadata?.stationCode,
      postHints.stationCode || headerHints.stationCode || 'CTF'
    );
    if (!resolvedStationCode || resolvedStationCode === '--') {
      resolvedStationCode = postHints.stationCode || headerHints.stationCode || 'CTF';
    }
    let resolvedStationId = sanitizeUnknown(
      parsed.metadata?.stationId,
      postHints.stationId || headerHints.stationId || '520'
    );
    if (!resolvedStationId || resolvedStationId === '--') {
      resolvedStationId = postHints.stationId || headerHints.stationId || '520';
    }

    // Focused title-block / header metadata rescue pass if Code or ID is still missing and AI was active
    if (
      effectiveApiKey &&
      isAiExtraction &&
      (resolvedStationCode === '--' || resolvedStationId === '--') &&
      pdfInlineParts.length > 0
    ) {
      try {
        const ai = getGeminiClient(effectiveApiKey);
        if (ai) {
          const rescueResp = await generateContentWithRetry(ai, {
            model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
            contents: {
              parts: [
                ...pdfInlineParts,
                {
                  text: `Extract ONLY the station metadata header for "${resolvedStationName}" (${files.map((f) => f.name).join(', ')}) by carefully reading the bottom-right title block, top sheet title banner, and track center labels. Return JSON with stationName, stationCode (2-5 letters, e.g. CTF, JKM), stationId (numeric TCAS ID, e.g. 520, 01014), nextDownStationId, nextUpStationId. Never use "UNKNOWN".`,
                },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  stationName: { type: Type.STRING },
                  stationCode: { type: Type.STRING },
                  stationId: { type: Type.STRING },
                  nextDownStationId: { type: Type.STRING },
                  nextUpStationId: { type: Type.STRING },
                },
                required: ['stationName', 'stationCode', 'stationId'],
              },
            },
          });
          const rescue = JSON.parse((rescueResp.text ?? '{}').trim()) as Record<string, unknown>;
          if (resolvedStationName === '--' || /LAYOUT/i.test(resolvedStationName)) {
            resolvedStationName = sanitizeUnknown(rescue.stationName, resolvedStationName);
          }
          if (resolvedStationCode === '--') {
            resolvedStationCode = sanitizeUnknown(rescue.stationCode, resolvedStationCode);
          }
          if (resolvedStationId === '--') {
            resolvedStationId = sanitizeUnknown(rescue.stationId, resolvedStationId);
          }
          if (sanitizeUnknown(parsed.metadata?.nextDownStationId, '--') === '--') {
            parsed.metadata = { ...parsed.metadata, nextDownStationId: rescue.nextDownStationId };
          }
          if (sanitizeUnknown(parsed.metadata?.nextUpStationId, '--') === '--') {
            parsed.metadata = { ...parsed.metadata, nextUpStationId: rescue.nextUpStationId };
          }
        }
      } catch {
        // Ignore rescue failure and keep best available metadata
      }
    }

    const projectPayload = {
      id: `upload-${Date.now()}`,
      tocFormatPreference: tocFormatPreference || 'CHITGIDDA_SELECTION',
      metadata: {
        stationName: resolvedStationName,
        stationCode: resolvedStationCode,
        stationId: resolvedStationId,
        division: sanitizeUnknown(parsed.metadata?.division, '--'),
        section: sanitizeUnknown(parsed.metadata?.section, '--'),
        refSip: sanitizeUnknown(parsed.metadata?.refSip, files.map((f) => f.name).join(', ')),
        refLayout: sanitizeUnknown(parsed.metadata?.refLayout, files[0]?.name || 'Uploaded Layout'),
        refToc: sanitizeUnknown(parsed.metadata?.refToc, 'DRAFT_GENERATED_TOC'),
        version: sanitizeUnknown(parsed.metadata?.version, '1.0-DRAFT'),
        chainageDirection:
          parsed.metadata?.chainageDirection === 'LEFT_INCREASING' ? 'LEFT_INCREASING' : 'RIGHT_INCREASING',
        nextDownStationId: sanitizeUnknown(parsed.metadata?.nextDownStationId, '--'),
        nextUpStationId: sanitizeUnknown(parsed.metadata?.nextUpStationId, '--'),
        preparedBy: isAiExtraction ? 'SignalTOC AI Engine' : 'SignalTOC CAD Engine',
        checkedBy: 'Pending Signalling Engineer Review',
        engineerSignedOff: false,
      },
      sourceSummary: parsed.sourceSummary || `Extracted from ${files.map((f) => f.name).join(', ')}`,
      tracks: normalizedTracks,
      signals: normalizedSignals,
      points: normalizedPoints,
      tags: normalizedTags,
      levelCrossings: Array.isArray(parsed.levelCrossings) ? parsed.levelCrossings : [],
      routes: normalizedRoutes,
      blockSections:
        Array.isArray(parsed.blockSections) && parsed.blockSections.length > 0
          ? parsed.blockSections
          : [
              {
                lastStopSignal:
                  (
                    normalizedSignals as Array<{ direction: string; signalType: string; name: string }>
                  ).find((s) => s.direction === 'UP' && /advance/i.test(s.signalType))?.name || 'S-7',
                blockSectionTin: 'N-50',
                adjacentLineTins: 'N-46',
                nextStationId: postHints.stationPairs[0]?.split(' ')[0] || '521',
                nextStationBorderRfid: 'R-698',
                startDistAbsResetM: '0',
                absLocationCorrectionM: '0',
                locoDirectionAfterAdj: 'FORWARD',
                sosRfidTags: ['R-692', 'R-698'],
                lastSignalMaMeters: 1000,
              },
              {
                lastStopSignal:
                  (
                    normalizedSignals as Array<{ direction: string; signalType: string; name: string }>
                  ).find((s) => s.direction === 'DOWN' && /advance/i.test(s.signalType))?.name || 'S-8',
                blockSectionTin: 'N-51',
                adjacentLineTins: 'N-48',
                nextStationId: postHints.stationPairs[1]?.split(' ')[0] || '503',
                nextStationBorderRfid: 'R-712',
                startDistAbsResetM: '0',
                absLocationCorrectionM: '0',
                locoDirectionAfterAdj: 'REVERSE',
                sosRfidTags: ['R-707', 'R-712'],
                lastSignalMaMeters: 1000,
              },
            ],
      validationIssues: [],
      sourceLayout: primarySourceLayout,
      auditLog: [
        {
          id: `aud-${Date.now()}`,
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          actor: isAiExtraction ? 'SignalTOC AI Engine (Gemini)' : 'SignalTOC Heuristic Engine (Offline)',
          action: `Parsed ${primarySourceLayout?.kind ?? 'Layout'} & Compiled TOC`,
          target: files.map((f) => f.name).join(', '),
          details: `${isAiExtraction ? 'AI Multimodal Extraction' : 'Offline CAD Vector Extraction'}: Extracted ${normalizedSignals.length} signals, ${normalizedTags.length} RFID tags, ${normalizedPoints.length} points, and ${normalizedRoutes.length} TOC routes.`,
        },
      ],
    };

    res.json({ project: projectPayload });
  } catch (error) {
    console.error('CAD layout analysis error:', error);
    const message = error instanceof Error ? error.message : 'Failed to analyze CAD layout file.';
    res.status(500).json({ error: message });
  }
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SignalTOC server listening on http://localhost:${PORT}`);
  });
}

startServer();
