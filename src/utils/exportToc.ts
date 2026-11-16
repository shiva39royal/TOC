import * as XLSX from 'xlsx';
import type { StationProject } from '../types/signalling';

export function exportTocToExcel(project: StationProject) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Station Selection Table (TOC)
  const tocRows = project.routes.map((r) => ({
    'Sl.No': r.slNo,
    'Route Mode': r.isTsl ? 'TSL Working' : 'Normal',
    'Entry Signal': r.entrySignal,
    'Exit Signal': r.exitSignal,
    'Line / Leading To': r.leadingToLine,
    'Direction': r.direction,
    'TSRMS Route ID': r.tsrmsRouteId,
    'Signal Type': r.signalType,
    'Aspect of Entry Signal': r.entryAspectSummary,
    'Requires Aspects of Exit Signal': r.exitAspectsSummary,
    'Required Route Locking / Cmd': r.tslRouteCommand || r.requiredRouteLocking,
    'Points Normal': r.pointsNormal.join(', ') || '--',
    'Points Reverse': r.pointsReverse.join(', ') || '--',
    'Requires Track Ckt Up': r.trackCktUp || '--',
    'TINs Requires Free': r.tinsRequiresFree.join(', ') || '--',
    'Entry Signal Foot Tag': r.entryFootTag,
    'Linking Sequence (Dist, Tag)':
      r.linkingSequence.length > 0
        ? r.linkingSequence.map((s) => `(${s.distanceM}, ${s.tagId})`).join(', ')
        : r.enRouteTags.join(', '),
    'Conflicting Turnout Tags': r.conflictingTurnoutTags.join(', ') || '--',
    'Conflicting Route Tags': r.conflictingRouteTags.join(', ') || '--',
    'Turnout Speed (kmph)': r.turnoutSpeedKmph ?? '--',
    'Distance to Commence (m)': r.turnoutCommenceM ?? '--',
    'Speed Restriction Dist (m)': r.turnoutRestrictionDistM ?? '--',
    'Distance Between Signals (m)': r.distanceBetweenSignalsM,
    'MA (Sections)': r.movementAuthoritySections,
    'MA (Meters)': r.movementAuthorityMeters,
    'Authorized Speed SR': r.authorizedSpeedSr,
    'Authorized Speed OS': r.authorizedSpeedOs,
    'Average Gradient': r.averageGradient || '--',
    'Engineer Status': r.engineerStatus,
    'Source / Validation Notes': r.sourceNotes || '',
  }));
  const wsToc = XLSX.utils.json_to_sheet(tocRows);
  XLSX.utils.book_append_sheet(wb, wsToc, 'Station Selection Table');

  // Sheet 2: RFID Tag & TIN Inventory
  const tagRows = project.tags.map((t) => ({
    'Tag ID': t.tagId,
    'Chainage (m)': t.chainageM,
    'Track / Line': t.line,
    'TIN': t.tin,
    'Tag Function': t.tagType,
    'Linked Signal': t.linkedSignal || '--',
    'Extraction Confidence': t.confidence,
    'Engineer Verified': t.verified ? 'YES' : 'NO',
    'Notes': t.notes || '',
  }));
  const wsTags = XLSX.utils.json_to_sheet(tagRows);
  XLSX.utils.book_append_sheet(wb, wsTags, 'RFID Tag Inventory');

  // Sheet 3: Block Section & SOS Details
  const blockRows = project.blockSections.map((b) => ({
    'Last Stop Signal': b.lastStopSignal,
    'Block Section TIN': b.blockSectionTin,
    'Adjacent Line TINs': b.adjacentLineTins,
    'Next Station ID': b.nextStationId,
    'Next Station Border RFID': b.nextStationBorderRfid,
    'Start Dist Abs Location Reset (m)': b.startDistAbsResetM,
    'Absolute Location Correction (m)': b.absLocationCorrectionM,
    'Loco Direction After Adj': b.locoDirectionAfterAdj,
    'Last Signal MA (m)': b.lastSignalMaMeters ?? '--',
    'SOS Block Section Tags': b.sosRfidTags?.join(', ') || '--',
  }));
  const wsBlock = XLSX.utils.json_to_sheet(blockRows);
  XLSX.utils.book_append_sheet(wb, wsBlock, 'Block Section & SOS');

  // Sheet 4: Engineering Validation Audit
  const valRows = project.validationIssues.map((v) => ({
    'Severity': v.severity,
    'Category': v.category,
    'Rule Reference': v.ruleReference,
    'Issue Title': v.title,
    'Details': v.description,
    'Affected Entity / Route': v.affectedRouteSlNo ? `Route #${v.affectedRouteSlNo}` : v.affectedEntityId || '--',
    'Resolved': v.resolved ? 'RESOLVED' : 'OPEN',
    'Engineer Resolution Note': v.resolvedNote || '',
  }));
  const wsVal = XLSX.utils.json_to_sheet(valRows);
  XLSX.utils.book_append_sheet(wb, wsVal, 'Validation Audit');

  const safeCode = project.metadata.stationCode.replace(/[^A-Za-z0-9_-]/g, '') || 'STATION';
  XLSX.writeFile(wb, `${safeCode}_KAVACH_TOC_v${project.metadata.version || '1.0'}.xlsx`);
}

export function exportTocToCsv(project: StationProject) {
  const headers = [
    'Sl.No',
    'Mode',
    'Entry Signal',
    'Exit Signal',
    'Line',
    'TSRMS Route ID',
    'Signal Type',
    'Points Normal',
    'Points Reverse',
    'Track Ckt Up',
    'TINs Requires Free',
    'Entry Foot Tag',
    'Linking Sequence',
    'Distance (m)',
    'MA (Sections)',
    'MA (m)',
    'SR Speed',
    'OS Speed',
    'Engineer Status',
  ];

  const escapeCsv = (val: string | number | null | undefined) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.join(','),
    ...project.routes.map((r) =>
      [
        r.slNo,
        r.isTsl ? 'TSL' : 'Normal',
        r.entrySignal,
        r.exitSignal,
        r.leadingToLine,
        r.tsrmsRouteId,
        r.signalType,
        r.pointsNormal.join('; '),
        r.pointsReverse.join('; '),
        r.trackCktUp,
        r.tinsRequiresFree.join('; '),
        r.entryFootTag,
        r.linkingSequence.length > 0
          ? r.linkingSequence.map((s) => `(${s.distanceM},${s.tagId})`).join(' ')
          : r.enRouteTags.join('; '),
        r.distanceBetweenSignalsM,
        r.movementAuthoritySections,
        r.movementAuthorityMeters,
        r.authorizedSpeedSr,
        r.authorizedSpeedOs,
        r.engineerStatus,
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.metadata.stationCode || 'STATION'}_KAVACH_TOC.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportCanonicalJson(project: StationProject) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.metadata.stationCode || 'STATION'}_Canonical_Model.json`;
  a.click();
  URL.revokeObjectURL(url);
}
