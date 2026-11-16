import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Edit3,
  FileSpreadsheet,
  GitBranch,
  Printer,
  RefreshCw,
  Search,
} from 'lucide-react';
import { recomputeRouteFromTags } from '../engine/validator';
import type { StationProject, TocFormatMode, TocRouteRow } from '../types/signalling';
import { exportCanonicalJson, exportTocToCsv, exportTocToExcel } from '../utils/exportToc';

interface TocTableViewProps {
  project: StationProject;
  highlightedRouteSlNo: number | null;
  onChangeFormat: (mode: TocFormatMode) => void;
  onUpdateRoute: (slNo: number, patch: Partial<TocRouteRow>) => void;
  onHighlightOnSchematic: (slNo: number) => void;
}

type TableSection = 'selection' | 'psr_gradient' | 'tsl' | 'block_sos';

export const TocTableView: React.FC<TocTableViewProps> = ({
  project,
  highlightedRouteSlNo,
  onChangeFormat,
  onUpdateRoute,
  onHighlightOnSchematic,
}) => {
  const [section, setSection] = useState<TableSection>('selection');
  const [dirFilter, setDirFilter] = useState<'ALL' | 'DOWN' | 'UP'>('ALL');
  const [search, setSearch] = useState('');
  const [editingSlNo, setEditingSlNo] = useState<number | null>(null);

  const isCtf = project.tocFormatPreference === 'CHITGIDDA_SELECTION';

  const normalRoutes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return project.routes.filter((r) => {
      if (section === 'selection' && r.isTsl) return false;
      if (section === 'tsl' && !r.isTsl) return false;
      if (dirFilter !== 'ALL' && r.direction !== dirFilter) return false;
      if (!q) return true;
      return (
        r.entrySignal.toLowerCase().includes(q) ||
        r.exitSignal.toLowerCase().includes(q) ||
        r.leadingToLine.toLowerCase().includes(q) ||
        r.entryFootTag.toLowerCase().includes(q) ||
        r.tinsRequiresFree.join(',').toLowerCase().includes(q)
      );
    });
  }, [project.routes, section, dirFilter, search]);

  const tslCount = useMemo(() => project.routes.filter((r) => r.isTsl).length, [project.routes]);

  return (
    <div className="space-y-4">
      {/* TOC Header & Export Controls */}
      <div className="no-print bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => onChangeFormat('CHITGIDDA_SELECTION')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                isCtf ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              CTF Selection Format
            </button>
            <button
              type="button"
              onClick={() => onChangeFormat('JANKAMPET_TOC')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                !isCtf ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              JKM TCAS TOC Format
            </button>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => setSection('selection')}
              className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer whitespace-nowrap ${
                section === 'selection' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Main TOC ({project.routes.filter((r) => !r.isTsl).length})
            </button>
            <button
              type="button"
              onClick={() => setSection('psr_gradient')}
              className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer whitespace-nowrap ${
                section === 'psr_gradient' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Turnout / PSR / Gradient
            </button>
            {tslCount > 0 && (
              <button
                type="button"
                onClick={() => setSection('tsl')}
                className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer whitespace-nowrap ${
                  section === 'tsl' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                TSL Working ({tslCount})
              </button>
            )}
            <button
              type="button"
              onClick={() => setSection('block_sos')}
              className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer whitespace-nowrap ${
                section === 'block_sos' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Block &amp; SOS ({project.blockSections.length})
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportTocToExcel(project)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md cursor-pointer whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Export Excel</span>
          </button>
          <button
            type="button"
            onClick={() => exportTocToCsv(project)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>CSV</span>
          </button>
          <button
            type="button"
            onClick={() => exportCanonicalJson(project)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer whitespace-nowrap"
          >
            <span>JSON</span>
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer whitespace-nowrap"
          >
            <Printer className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Print PDF</span>
          </button>
        </div>
      </div>

      {/* Print / Engineering Header Block matching Indian Railways / Medha sheet */}
      <div className="print-full bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-1 text-xs">
            <div>
              <span className="text-slate-500">Station: </span>
              <span className="font-semibold text-slate-900">
                {project.metadata.stationName} ({project.metadata.stationCode})
              </span>
            </div>
            <div>
              <span className="text-slate-500">Station ID: </span>
              <span className="font-mono font-semibold text-slate-900">{project.metadata.stationId}</span>
            </div>
            <div>
              <span className="text-slate-500">Ref Layout: </span>
              <span className="font-mono text-slate-800">{project.metadata.refLayout}</span>
            </div>
          </div>

          <div className="no-print flex items-center gap-3">
            <div className="flex items-center gap-1 p-0.5 bg-white border border-slate-200 rounded text-xs">
              {(['ALL', 'DOWN', 'UP'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDirFilter(d)}
                  className={`px-2 py-1 rounded font-medium cursor-pointer ${
                    dirFilter === d ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search signal, TIN, tag..."
                className="pl-7 pr-3 py-1 text-xs border border-slate-300 rounded bg-white w-48 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>
        </div>

        {/* Section 1 & 3: Main Selection Table or TSL Table */}
        {(section === 'selection' || section === 'tsl') && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-700 font-semibold">
                  <th className="py-2.5 px-3 border-r border-slate-200">Sl</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Entry Sig</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Exit Sig</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Line</th>
                  {isCtf && <th className="py-2.5 px-3 border-r border-slate-200">TSRMS ID</th>}
                  <th className="py-2.5 px-3 border-r border-slate-200">Signal Type</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Entry / Exit Aspects</th>
                  {isCtf && <th className="py-2.5 px-3 border-r border-slate-200">Locking / Cmd</th>}
                  <th className="py-2.5 px-3 border-r border-slate-200">Pts Normal</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Pts Reverse</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Track Ckt Up</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">TINs Free</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Foot Tag</th>
                  {isCtf ? (
                    <th className="py-2.5 px-3 border-r border-slate-200 min-w-[230px]">
                      Linking Sequence (Dist, En-Route Tag)
                    </th>
                  ) : (
                    <>
                      <th className="py-2.5 px-3 border-r border-slate-200 min-w-[140px]">En-Route Tags</th>
                      <th className="py-2.5 px-3 border-r border-slate-200">Conflict Turnout</th>
                      <th className="py-2.5 px-3 border-r border-slate-200">Conflict Route</th>
                    </>
                  )}
                  <th className="py-2.5 px-3 border-r border-slate-200 text-right">Dist (m)</th>
                  <th className="py-2.5 px-3 border-r border-slate-200 text-right">
                    {isCtf ? 'MA (Sec)' : 'MA (m)'}
                  </th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Speed SR / OS</th>
                  <th className="py-2.5 px-3 no-print text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {normalRoutes.map((r) => {
                  const isHighlighted = highlightedRouteSlNo === r.slNo;
                  const isEditing = editingSlNo === r.slNo;

                  return (
                    <tr
                      key={r.slNo}
                      className={`align-top transition-colors ${
                        isHighlighted
                          ? 'bg-blue-50/80'
                          : r.engineerStatus === 'NEEDS_REVIEW'
                            ? 'bg-amber-50/40 hover:bg-amber-50/70'
                            : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono tabular-nums font-semibold text-slate-900">
                        {r.slNo}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {r.entrySignal}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {r.exitSignal}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 text-slate-800 whitespace-nowrap">
                        {r.leadingToLine}
                      </td>
                      {isCtf && (
                        <td className="py-2.5 px-3 border-r border-slate-200 font-mono tabular-nums text-slate-700">
                          {r.tsrmsRouteId || '--'}
                        </td>
                      )}
                      <td className="py-2.5 px-3 border-r border-slate-200 text-slate-700 max-w-[140px]">
                        {r.signalType}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 text-slate-700 max-w-[160px]">
                        <div className="font-medium text-slate-900">{r.entryAspectSummary}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{r.exitAspectsSummary}</div>
                      </td>
                      {isCtf && (
                        <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-slate-800">
                          {r.tslRouteCommand || r.requiredRouteLocking || '--'}
                        </td>
                      )}
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-emerald-800">
                        {isEditing ? (
                          <input
                            type="text"
                            defaultValue={r.pointsNormal.join(', ')}
                            onBlur={(e) =>
                              onUpdateRoute(r.slNo, {
                                pointsNormal: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                            className="w-20 px-1.5 py-0.5 border border-blue-500 rounded bg-white"
                          />
                        ) : (
                          r.pointsNormal.join(', ') || '--'
                        )}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-amber-800">
                        {isEditing ? (
                          <input
                            type="text"
                            defaultValue={r.pointsReverse.join(', ')}
                            onBlur={(e) =>
                              onUpdateRoute(r.slNo, {
                                pointsReverse: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                            className="w-20 px-1.5 py-0.5 border border-blue-500 rounded bg-white"
                          />
                        ) : (
                          r.pointsReverse.join(', ') || '--'
                        )}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 text-slate-700">
                        {r.trackCktUp || '--'}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-slate-900">
                        {isEditing ? (
                          <input
                            type="text"
                            defaultValue={r.tinsRequiresFree.join(', ')}
                            onBlur={(e) =>
                              onUpdateRoute(r.slNo, {
                                tinsRequiresFree: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                            className="w-28 px-1.5 py-0.5 border border-blue-500 rounded bg-white"
                          />
                        ) : (
                          r.tinsRequiresFree.join(', ') || '--'
                        )}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono font-semibold text-amber-900 whitespace-nowrap">
                        {r.entryFootTag}
                      </td>
                      {isCtf ? (
                        <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-[11px] text-slate-800 leading-relaxed">
                          {r.linkingSequence.length > 0
                            ? r.linkingSequence.map((s) => `(${s.distanceM}, ${s.tagId})`).join(', ')
                            : r.enRouteTags.join(', ') || '--'}
                        </td>
                      ) : (
                        <>
                          <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-[11px] text-slate-800">
                            {r.enRouteTags.join(', ') || '--'}
                          </td>
                          <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-[11px] text-slate-600">
                            {r.conflictingTurnoutTags.join(', ') || '--'}
                          </td>
                          <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-[11px] text-slate-600">
                            {r.conflictingRouteTags.join(', ') || '--'}
                          </td>
                        </>
                      )}
                      <td className="py-2.5 px-3 border-r border-slate-200 text-right font-mono tabular-nums font-medium text-slate-900">
                        {isEditing ? (
                          <input
                            type="number"
                            defaultValue={r.distanceBetweenSignalsM}
                            onBlur={(e) =>
                              onUpdateRoute(r.slNo, {
                                distanceBetweenSignalsM: Number(e.target.value) || 0,
                              })
                            }
                            className="w-20 text-right px-1.5 py-0.5 border border-blue-500 rounded bg-white"
                          />
                        ) : (
                          r.distanceBetweenSignalsM
                        )}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 text-right font-mono tabular-nums text-slate-900">
                        {isCtf ? r.movementAuthoritySections : r.movementAuthorityMeters}
                      </td>
                      <td className="py-2.5 px-3 border-r border-slate-200 font-mono tabular-nums text-slate-800 whitespace-nowrap">
                        {r.authorizedSpeedSr} / {r.authorizedSpeedOs}
                      </td>
                      <td className="py-2.5 px-3 no-print text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onHighlightOnSchematic(r.slNo)}
                            title="Highlight route on schematic"
                            className="p-1 text-slate-500 hover:text-blue-700 rounded hover:bg-blue-50 cursor-pointer"
                          >
                            <GitBranch className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const recomputed = recomputeRouteFromTags(r, project.tags, project.signals);
                              onUpdateRoute(r.slNo, recomputed);
                            }}
                            title="Recompute linking sequence from RFID tags"
                            className="p-1 text-slate-500 hover:text-blue-700 rounded hover:bg-blue-50 cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingSlNo(isEditing ? null : r.slNo)}
                            title={isEditing ? 'Done editing' : 'Edit row'}
                            className={`p-1 rounded cursor-pointer ${
                              isEditing ? 'text-blue-700 bg-blue-50' : 'text-slate-500 hover:text-slate-900'
                            }`}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateRoute(r.slNo, {
                                engineerStatus:
                                  r.engineerStatus === 'VERIFIED' ? 'NEEDS_REVIEW' : 'VERIFIED',
                              })
                            }
                            title="Toggle route verification status"
                            className={`p-1 rounded cursor-pointer ${
                              r.engineerStatus === 'VERIFIED'
                                ? 'text-emerald-700 hover:bg-emerald-50'
                                : 'text-amber-700 hover:bg-amber-50'
                            }`}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Section 2: Turnout Speed, Permanent Speed Restriction & Gradient */}
        {section === 'psr_gradient' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-700 font-semibold">
                  <th className="py-2.5 px-3 border-r border-slate-200">Entry Sig</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Exit Sig</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Line</th>
                  <th className="py-2.5 px-3 border-r border-slate-200 text-right">Turnout Speed (kmph)</th>
                  <th className="py-2.5 px-3 border-r border-slate-200 text-right">Start Dist (m)</th>
                  <th className="py-2.5 px-3 border-r border-slate-200 text-right">Restriction Len (m)</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Permanent Speed Restriction (Speed, Type, Length)</th>
                  <th className="py-2.5 px-3 border-r border-slate-200">Avg Gradient</th>
                  <th className="py-2.5 px-3 text-right">Route Len (m)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {project.routes.map((r) => (
                  <tr key={r.slNo} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 border-r border-slate-200 font-mono font-semibold text-slate-900">
                      {r.entrySignal}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 font-mono font-semibold text-slate-900">
                      {r.exitSignal}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 text-slate-700">
                      {r.leadingToLine}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 text-right font-mono tabular-nums">
                      {r.turnoutSpeedKmph ?? '--'}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 text-right font-mono tabular-nums">
                      {r.turnoutCommenceM ?? '--'}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 text-right font-mono tabular-nums">
                      {r.turnoutRestrictionDistM ?? '--'}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-[11px] text-slate-800">
                      {r.psrSegments.length > 0
                        ? r.psrSegments.map((s) => `(${s.speedKmph}, ${s.staticSpeedType}, ${s.lengthM})`).join(' · ')
                        : '--'}
                    </td>
                    <td className="py-2.5 px-3 border-r border-slate-200 font-mono text-slate-800">
                      {r.averageGradient || '--'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                      {r.distanceBetweenSignalsM}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Section 4: Block Section Details & SOS TIN Table */}
        {section === 'block_sos' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-700 font-semibold">
                  <th className="py-2.5 px-4 border-r border-slate-200">Last Stop Signal</th>
                  <th className="py-2.5 px-4 border-r border-slate-200">Block Section TIN</th>
                  <th className="py-2.5 px-4 border-r border-slate-200">Adjacent Line TINs</th>
                  <th className="py-2.5 px-4 border-r border-slate-200">Next Station ID</th>
                  <th className="py-2.5 px-4 border-r border-slate-200">Border RFID</th>
                  <th className="py-2.5 px-4 border-r border-slate-200 text-right">Abs Reset Start (m)</th>
                  <th className="py-2.5 px-4 border-r border-slate-200">Abs Correction (m)</th>
                  <th className="py-2.5 px-4">SOS Block Section RFID Tags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {project.blockSections.map((b, i) => (
                  <tr key={`${b.lastStopSignal}-${i}`} className="hover:bg-slate-50 align-top">
                    <td className="py-3 px-4 border-r border-slate-200 font-mono font-semibold text-slate-900">
                      {b.lastStopSignal}
                    </td>
                    <td className="py-3 px-4 border-r border-slate-200 font-mono font-semibold text-blue-800">
                      {b.blockSectionTin}
                    </td>
                    <td className="py-3 px-4 border-r border-slate-200 font-mono text-slate-700">
                      {b.adjacentLineTins}
                    </td>
                    <td className="py-3 px-4 border-r border-slate-200 font-mono text-slate-900">
                      {b.nextStationId}
                    </td>
                    <td className="py-3 px-4 border-r border-slate-200 font-mono text-slate-700">
                      {b.nextStationBorderRfid}
                    </td>
                    <td className="py-3 px-4 border-r border-slate-200 text-right font-mono tabular-nums text-slate-800">
                      {b.startDistAbsResetM}
                    </td>
                    <td className="py-3 px-4 border-r border-slate-200 font-mono text-slate-800">
                      {b.absLocationCorrectionM}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-700 leading-relaxed max-w-md">
                      {b.sosRfidTags && b.sosRfidTags.length > 0 ? b.sosRfidTags.join(', ') : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Print Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-600">
          <div>
            Prepared by: <span className="font-medium text-slate-900">{project.metadata.preparedBy}</span>
            <span className="mx-2 text-slate-300">·</span>
            Checked by: <span className="font-medium text-slate-900">{project.metadata.checkedBy}</span>
          </div>
          <div>
            {project.metadata.engineerSignedOff ? (
              <span className="font-semibold text-emerald-800">
                Engineer Sign-Off: {project.metadata.signOffEngineerName} ({project.metadata.signOffTimestamp})
              </span>
            ) : (
              <span className="font-medium text-amber-800">
                Draft Output — Subject to Qualified Signalling Engineer Verification
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
