import React, { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Cpu, FileCode2, KeyRound, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { runEngineeringValidation } from '../engine/validator';
import type { StationProject, TocFormatMode } from '../types/signalling';
import { renderPdfHighResCrops } from '../utils/pdfImageExtractor';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectCreated: (project: StationProject) => void;
}

export interface QueuedCadFile {
  name: string;
  size: number;
  mimeType: string;
  base64Data: string;
}

export function validateCadFileExtension(fileName: string): string | null {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.dwg') || lower.endsWith('.dxf') || lower.endsWith('.pdf')) {
    return null;
  }
  const ext = lower.includes('.') ? `.${lower.split('.').pop()}` : 'unknown';
  return `Unsupported file format "${fileName}" (${ext}). Supported layout formats are .dwg, .dxf, and .pdf.`;
}

export const UploadModal: React.FC<UploadModalProps> = ({ isOpen, onClose, onProjectCreated }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [queuedFiles, setQueuedFiles] = useState<QueuedCadFile[]>([]);
  const [tocFormat, setTocFormat] = useState<TocFormatMode>('CHITGIDDA_SELECTION');
  const [stationHint, setStationHint] = useState('');
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem('signal_toc_gemini_api_key') || '';
    } catch {
      return '';
    }
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [stepLabel, setStepLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const readFileAsBase64 = (file: File): Promise<QueuedCadFile> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve({
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          base64Data: base64,
        });
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    const selected = Array.from(fileList);

    for (const f of selected) {
      const extErr = validateCadFileExtension(f.name);
      if (extErr) {
        setErrorMsg(extErr);
        return;
      }
    }

    try {
      const loaded = await Promise.all(selected.map(readFileAsBase64));
      setQueuedFiles(loaded);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to read uploaded CAD file.');
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void handleFilesSelected(e.dataTransfer.files);
  };

  const removeFile = (idx: number) => {
    setQueuedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAnalyze = async () => {
    if (queuedFiles.length === 0) {
      setErrorMsg('Please select a valid layout file (.dwg, .dxf, or .pdf).');
      return;
    }

    setIsAnalyzing(true);
    setErrorMsg(null);
    setStepLabel(
      apiKey.trim()
        ? '1/3 Decoding CAD layers and extracting station elements with Gemini AI...'
        : '1/3 Decoding CAD layers and extracting vector elements offline...'
    );

    try {
      const filesPayload = await Promise.all(
        queuedFiles.map(async (f) => {
          let supplementaryImages: string[] = [];
          if (f.name.toLowerCase().endsWith('.pdf')) {
            try {
              supplementaryImages = await renderPdfHighResCrops(f.base64Data);
            } catch {
              supplementaryImages = [];
            }
          }
          return {
            name: f.name,
            mimeType: f.mimeType,
            base64Data: f.base64Data,
            supplementaryImages,
          };
        })
      );

      const res = await fetch('/api/analyze-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: filesPayload,
          tocFormatPreference: tocFormat,
          stationHint: stationHint.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.error || 'CAD extraction request failed.');
      }

      setStepLabel('2/3 Running deterministic engineering validation (chainage, TIN, points)...');
      const rawProject = payload.project as StationProject;
      const issues = runEngineeringValidation(rawProject);
      const validatedProject: StationProject = {
        ...rawProject,
        validationIssues: issues,
      };

      setStepLabel('3/3 Rendering CAD Layout & compiling draft Table of Control...');
      onProjectCreated(validatedProject);
      setQueuedFiles([]);
      setStationHint('');
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unexpected CAD analysis error.');
    } finally {
      setIsAnalyzing(false);
      setStepLabel('');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h2 id="upload-modal-title" className="text-lg font-display font-semibold text-slate-900">
              Upload RFID Layout (.dwg / .dxf / .pdf)
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Accepts AutoCAD DWG, DXF, and vector engineering PDF layouts. Unsupported file types are rejected automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isAnalyzing}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 cursor-pointer"
            aria-label="Close upload dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-5 space-y-5">
          {/* Dropzone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border border-dashed border-slate-300 hover:border-blue-600 bg-slate-50 hover:bg-blue-50/30 rounded-lg p-6 text-center transition-colors cursor-pointer"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".dwg,.dxf,.pdf"
              className="hidden"
              onChange={(e) => void handleFilesSelected(e.target.files)}
            />
            <Upload className="w-7 h-7 text-blue-700 mx-auto mb-2" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-900">
              Click to browse or drop layout file (.dwg, .dxf, or .pdf)
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Supported formats: .DWG · .DXF · .PDF
            </p>
          </div>

          {/* Queued files list */}
          {queuedFiles.length > 0 && (
            <div className="border border-slate-200 rounded-md divide-y divide-slate-200">
              {queuedFiles.map((file, idx) => (
                <div key={`${file.name}-${idx}`} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileCode2 className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
                    <span className="font-medium text-slate-800 truncate">{file.name}</span>
                    <span className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFile(idx)}
                    disabled={isAnalyzing}
                    className="text-xs text-slate-500 hover:text-red-700 px-2 py-1 cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Optional Gemini API Key */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label htmlFor="gemini-api-key-input" className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                <span>Gemini API Key</span>
                <span className="text-slate-400 font-normal text-[11px]">(Optional)</span>
              </label>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-blue-600 hover:text-blue-800 hover:underline"
              >
                Get Free Key ↗
              </a>
            </div>
            <input
              id="gemini-api-key-input"
              type="password"
              value={apiKey}
              onChange={(e) => {
                const val = e.target.value;
                setApiKey(val);
                try {
                  localStorage.setItem('signal_toc_gemini_api_key', val.trim());
                } catch {}
              }}
              placeholder="AIzaSy... (Leave empty to process offline without API key)"
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 font-mono"
            />
            <div className="flex items-center gap-1.5 mt-2 text-[11px]">
              {apiKey.trim() ? (
                <div className="flex items-center gap-1.5 text-emerald-700 font-medium">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>AI Mode Active: Visual multimodal layout analysis with Google Gemini</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-slate-600">
                  <Cpu className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                  <span>Offline Mode: Fast CAD/PDF vector heuristic extraction (No API key needed)</span>
                </div>
              )}
            </div>
          </div>

          {/* Format & Station Hint */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Target Output TOC Format
              </label>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md">
                <button
                  type="button"
                  onClick={() => setTocFormat('CHITGIDDA_SELECTION')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                    tocFormat === 'CHITGIDDA_SELECTION'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Selection Table
                </button>
                <button
                  type="button"
                  onClick={() => setTocFormat('JANKAMPET_TOC')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                    tocFormat === 'JANKAMPET_TOC'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  TCAS TOC
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="station-hint-input" className="block text-xs font-medium text-slate-700 mb-1.5">
                Direction / Adjacent Station Context (Optional)
              </label>
              <input
                id="station-hint-input"
                type="text"
                value={stationHint}
                onChange={(e) => setStationHint(e.target.value)}
                placeholder="e.g., UP is left-increasing, SC Railway"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          {errorMsg && (
            <div className="flex items-start gap-2.5 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-700" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          {isAnalyzing && (
            <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-900">
              <Loader2 className="w-4 h-4 animate-spin text-blue-700 shrink-0" aria-hidden="true" />
              <span>{stepLabel}</span>
            </div>
          )}
        </div>

        <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
            <span>Validates CAD format before parsing &amp; TOC drafting</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isAnalyzing}
              className="px-4 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 cursor-pointer whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAnalyze()}
              disabled={isAnalyzing || queuedFiles.length === 0}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md transition-colors cursor-pointer whitespace-nowrap"
            >
              {isAnalyzing ? 'Processing CAD...' : 'Process CAD Layout'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
