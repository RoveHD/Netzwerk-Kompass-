const metricKeys = ['downloadMbps', 'uploadMbps', 'pingBeforeMs', 'pingDuringDownloadMs', 'pingDuringUploadMs', 'pingAfterMs'];
const isMeasurement = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const failed = record => Boolean(record.error) || record.reason === 'error';

function measurement(record, key) {
  if (record.type === 'stress') {
    if (key.startsWith('ping')) return null;
    if (key === 'downloadMbps' && record.mode === 'upload') return null;
    if (key === 'uploadMbps' && record.mode === 'download') return null;
  }
  const countKey = { pingDuringDownloadMs: 'pingDuringDownloadCount', pingDuringUploadMs: 'pingDuringUploadCount' }[key];
  if (countKey && record[countKey] != null && (!isMeasurement(record[countKey]) || record[countKey] === 0)) return null;
  return isMeasurement(record[key]) ? record[key] : null;
}

// Each finished test contributes one value, including its per-phase ping mean.
// A load test's whole-run average must not be mixed with a short speed test.
export function summarizeSpeedHistory(records, type = 'speedtest') {
  const tests = (Array.isArray(records) ? records : []).filter(record => record?.type === type && !record.running);
  const successful = tests.filter(record => !failed(record));
  const metrics = Object.fromEntries(metricKeys.map(key => {
    const values = successful.map(record => measurement(record, key)).filter(value => value !== null);
    const count = values.length;
    const mean = count ? values.reduce((average, value, index) => average + (value - average) / (index + 1), 0) : null;
    return [key, {
      count,
      // Remove binary arithmetic noise before decimal display rounding (18.05).
      mean: mean === null ? null : Number(mean.toPrecision(15)),
      min: count ? Math.min(...values) : null,
      max: count ? Math.max(...values) : null,
    }];
  }));
  const pingTargets = [...new Set(successful.filter(record => metricKeys.slice(2).some(key => measurement(record, key) !== null)).map(record => record.pingTarget || 'Unbekanntes Pingziel'))];
  return {
    total: tests.length,
    failed: tests.filter(failed).length,
    usable: successful.filter(record => measurement(record, 'downloadMbps') !== null || measurement(record, 'uploadMbps') !== null).length,
    metrics,
    pingTargets,
  };
}
