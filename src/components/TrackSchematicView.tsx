import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Cpu,
  FileCode2,
  KeyRound,
  Loader2,
  Sparkles,
  Upload,
} from 'lucide-react';
import { runEngineeringValidation } from '../engine/validator';
import type { StationProject } from '../types/signalling';
import { renderPdfHighResCrops } from '../utils/pdfImageExtractor';
import { CadDrawingViewer } from './CadDrawingViewer';
import { validateCadFileExtension } from './UploadModal';

interface TrackSchematicViewProps {
  project: StationProject | null;
  selectedRouteSlNo: number | null;
  onSelectRoute: (slNo: number | null) => void;
  onJumpToValidation: (slNo?: number) => void;
  onProjectCreated: (project: StationProject) => void;
}

export const TrackSchematicView: React.FC<TrackSchematicViewProps> = ({
  project,
  selectedRouteSlNo,
  onSelectRoute,
  onJumpToValidation,
  onProjectCreated,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem('signal_toc_gemini_api_key') || '';
    } catch {
      return '';
    }
  });
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStep, setProcessStep] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const selectedRoute = useMemo(
    () => project?.routes.find((r) => r.slNo === selectedRouteSlNo) ?? null,
    [project, selectedRouteSlNo]
  );

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',')[1] : result);
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const handleFileUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploadError(null);

    const file = fileList[0];
    const extErr = validateCadFileExtension(file.name);
    if (extErr) {
      setUploadError(extErr);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsProcessing(true);
    setProcessStep(
      apiKey.trim()
        ? `1/3 Decoding ${file.name} & analyzing with Gemini AI...`
        : `1/3 Decoding ${file.name} & extracting CAD vector elements offline...`
    );

    try {
      const base64Data = await readFileAsBase64(file);
      let supplementaryImages: string[] = [];
      if (file.name.toLowerCase().endsWith('.pdf')) {
        setProcessStep('1/3 Rendering high-resolution schematic zones from PDF...');
        try {
          supplementaryImages = await renderPdfHighResCrops(base64Data);
        } catch {
          supplementaryImages = [];
        }
      }

      setProcessStep('2/3 Extracting station metadata, tracks, signals, points & RFID tags...');
      const res = await fetch('/api/analyze-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            {
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              base64Data,
              supplementaryImages,
            },
          ],
          tocFormatPreference: 'CHITGIDDA_SELECTION',
          apiKey: apiKey.trim() || undefined,
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.error || 'Layout file processing failed.');
      }

      setProcessStep('3/3 Running deterministic validation & rendering layout...');
      const rawProject = payload.project as StationProject;
      const issues = runEngineeringValidation(rawProject);
      const validatedProject: StationProject = {
        ...rawProject,
        validationIssues: issues,
      };

      onProjectCreated(validatedProject);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to process layout.');
    } finally {
      setIsProcessing(false);
      setProcessStep('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (!project) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-8 md:p-12">
        <div className="max-w-xl mx-auto space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-xl font-display font-bold text-slate-900">
              Upload the Layout
            </h2>
            <p className="text-sm text-slate-600">
              Upload your station signalling layout (<span className="font-mono font-semibold text-slate-800">.dwg</span>, <span className="font-mono font-semibold text-slate-800">.dxf</span>, or <span className="font-mono font-semibold text-slate-800">.pdf</span>) to render the drawing, extract station metadata, and compile a validated TOC.
            </p>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOver(true);
            }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingOver(false);
              void handleFileUpload(e.dataTransfer.files);
            }}
            onClick={() => !isProcessing && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
              isProcessing
                ? 'border-blue-300 bg-blue-50/40 cursor-wait'
                : isDraggingOver
                  ? 'border-blue-600 bg-blue-50/50 cursor-pointer'
                  : 'border-slate-300 hover:border-blue-600 bg-slate-50 hover:bg-blue-50/20 cursor-pointer'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".dwg,.dxf,.pdf"
              disabled={isProcessing}
              className="hidden"
              onChange={(e) => void handleFileUpload(e.target.files)}
            />

            {isProcessing ? (
              <div className="space-y-3">
                <Loader2 className="w-8 h-8 animate-spin text-blue-700 mx-auto" aria-hidden="true" />
                <p className="text-sm font-semibold text-blue-900">{processStep}</p>
                <p className="text-xs text-slate-500">
                  Decoding track geometry, signals, points, and RFID tag annotations...
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-lg bg-white border border-slate-200 flex items-center justify-center mx-auto shadow-xs">
                  <Upload className="w-6 h-6 text-blue-700" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Click to Upload or Drop Layout File
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Accepted formats: <span className="font-mono font-medium text-slate-700">.dwg</span> · <span className="font-mono font-medium text-slate-700">.dxf</span> · <span className="font-mono font-medium text-slate-700">.pdf</span>
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Optional Gemini API Key */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-left">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label htmlFor="schematic-api-key-input" className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
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
              id="schematic-api-key-input"
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
                  <span>AI Mode: Visual multimodal layout analysis with Google Gemini</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-slate-600">
                  <Cpu className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                  <span>Offline Mode: Fast CAD/PDF vector heuristic extraction (Zero API key needed)</span>
                </div>
              )}
            </div>
          </div>

          {uploadError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-800"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-700" aria-hidden="true" />
              <div>
                <div className="font-semibold">Processing Notice</div>
                <div className="mt-0.5 leading-relaxed">{uploadError}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* CAD Header Controls */}
      <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900">
            <FileCode2 className="w-4 h-4 text-blue-700" aria-hidden="true" />
            <span>CAD Layout Viewer</span>
          </div>

          <span className="text-slate-300" aria-hidden="true">|</span>

          <div className="flex items-center gap-2">
            <label htmlFor="schematic-route-select" className="text-xs font-semibold text-slate-700 whitespace-nowrap">
              Inspect Route:
            </label>
            <select
              id="schematic-route-select"
              value={selectedRouteSlNo ?? ''}
              onChange={(e) => {
                const val = e.target.value ? Number(e.target.value) : null;
                onSelectRoute(val);
              }}
              className="text-xs border border-slate-300 rounded-md px-2.5 py-1.5 bg-white text-slate-900 focus:outline-none focus:border-blue-600 max-w-xs"
            >
              <option value="">Station CAD Overview (No Route Selected)</option>
              {project.routes.map((r) => (
                <option key={r.slNo} value={r.slNo}>
                  #{r.slNo} · {r.entrySignal} → {r.exitSignal} ({r.leadingToLine})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-xs font-mono tabular-nums text-slate-500">
          {project.tracks.length} Tracks · {project.points.length} Points · {project.signals.length} Signals · {project.tags.length} RFID Tags
        </div>
      </div>

      {/* Main Split: CAD Viewport + Right Station Metadata Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div className="lg:col-span-9 flex flex-col">
          <CadDrawingViewer
            sourceLayout={project.sourceLayout}
            stationTitle={`${project.metadata.stationName} (${project.metadata.stationCode})`}
          />
        </div>

        {/* Right Station Metadata & Route Inspector */}
        <aside className="lg:col-span-3 bg-white border border-slate-200 rounded-lg p-4 flex flex-col justify-between">
          {!selectedRoute ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-display font-semibold text-slate-900">
                  CAD Metadata &amp; Station Info
                </h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Extracted directly from the uploaded {project.sourceLayout?.kind || 'CAD'} layout. Use the Background switch (White / Dark), Layers, or Search toolbar to inspect tags and signals.
                </p>
              </div>

              <div className="pt-3 border-t border-slate-200 space-y-2.5 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Station Name</span>
                  <span className="font-semibold text-slate-900 text-right">{project.metadata.stationName}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Station Code</span>
                  <span className="font-mono font-medium text-slate-900">{project.metadata.stationCode}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Station ID</span>
                  <span className="font-mono tabular-nums font-medium text-slate-900">{project.metadata.stationId}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Chainage Direction</span>
                  <span className="font-mono text-slate-900">
                    {project.metadata.chainageDirection === 'LEFT_INCREASING' ? '← Inc. Left' : 'Inc. Right →'}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Left Adjacent</span>
                  <span className="font-mono text-slate-900">{project.metadata.nextUpStationId}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Right Adjacent</span>
                  <span className="font-mono text-slate-900">{project.metadata.nextDownStationId}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 shrink-0">Level Crossings</span>
                  <span className="font-mono tabular-nums text-slate-900">{project.levelCrossings.length}</span>
                </div>
              </div>

              {project.sourceLayout && (
                <div className="pt-3 border-t border-slate-200 space-y-2 text-xs">
                  <div className="font-semibold text-slate-800">Layout File Telemetry</div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">File</span>
                    <span className="font-mono text-slate-900 truncate max-w-[160px]" title={project.sourceLayout.fileName}>
                      {project.sourceLayout.fileName}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Format</span>
                    <span className="font-mono text-slate-900">
                      {project.sourceLayout.kind}
                      {project.sourceLayout.cadVersion ? ` (${project.sourceLayout.cadVersion})` : ''}
                    </span>
                  </div>
                  {project.sourceLayout.kind === 'PDF' ? (
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Pages</span>
                      <span className="font-mono tabular-nums text-slate-900">
                        {project.sourceLayout.pageCount ?? 1}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-500">Layers / Blocks</span>
                        <span className="font-mono tabular-nums text-slate-900">
                          {project.sourceLayout.layerCount ?? 0} / {project.sourceLayout.blockCount ?? 0}
                        </span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-500">Entities Decoded</span>
                        <span className="font-mono tabular-nums text-slate-900">
                          {project.sourceLayout.entityCount ?? 0}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {project.sourceSummary && (
                <p className="pt-3 border-t border-slate-200 text-xs text-slate-600 leading-relaxed">
                  {project.sourceSummary}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                <span className="font-display font-semibold text-sm text-slate-900">
                  Route #{selectedRoute.slNo}
                </span>
                <button
                  type="button"
                  onClick={() => onSelectRoute(null)}
                  className="text-blue-700 hover:underline cursor-pointer"
                >
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2 font-mono font-semibold text-sm text-slate-900">
                <span>{selectedRoute.entrySignal}</span>
                {selectedRoute.direction === 'DOWN' ? (
                  <ArrowRight className="w-3.5 h-3.5 text-blue-700" />
                ) : (
                  <ArrowLeft className="w-3.5 h-3.5 text-blue-700" />
                )}
                <span>{selectedRoute.exitSignal}</span>
              </div>
              <div className="space-y-1.5 pt-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Line</span>
                  <span className="font-medium text-slate-900">{selectedRoute.leadingToLine}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Signal Distance</span>
                  <span className="font-mono tabular-nums text-slate-900">{selectedRoute.distanceBetweenSignalsM} m</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Entry Foot Tag</span>
                  <span className="font-mono text-amber-800 font-medium">{selectedRoute.entryFootTag}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Points Normal</span>
                  <span className="font-mono text-emerald-800">{selectedRoute.pointsNormal.join(', ') || '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Points Reverse</span>
                  <span className="font-mono text-amber-800">{selectedRoute.pointsReverse.join(', ') || '--'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">TINs Free</span>
                  <span className="font-mono text-slate-900">{selectedRoute.tinsRequiresFree.join(', ') || '--'}</span>
                </div>
              </div>
              <div className="pt-2 border-t border-slate-200">
                <span className="text-slate-500 block mb-1">RFID Linking / En-Route Sequence</span>
                <p className="font-mono text-[11px] text-slate-800 leading-relaxed break-words">
                  {selectedRoute.linkingSequence.length > 0
                    ? selectedRoute.linkingSequence.map((s) => `(${s.distanceM}, ${s.tagId})`).join(' · ')
                    : selectedRoute.enRouteTags.join(', ') || '--'}
                </p>
              </div>
              {selectedRoute.sourceNotes && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded text-amber-900 leading-relaxed">
                  {selectedRoute.sourceNotes}
                </div>
              )}
              <button
                type="button"
                onClick={() => onJumpToValidation(selectedRoute.slNo)}
                className="w-full py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-medium rounded-md transition-colors cursor-pointer"
              >
                Inspect Validation Checks
              </button>
            </div>
          )}

          <div className="pt-4 mt-4 border-t border-slate-200 text-[11px] text-slate-500">
            Rendered natively from uploaded {project.sourceLayout?.kind || 'CAD'} vector geometry.
          </div>
        </aside>
      </div>
    </div>
  );
};
