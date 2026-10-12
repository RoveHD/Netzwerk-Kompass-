import { setMeasurement } from './ui-presentation.js';
import { DOWNLOAD_SIZES, UPLOAD_SIZES, DEFAULT_DOWNLOAD_BYTES, DEFAULT_UPLOAD_BYTES, normalizeSpeedTestOptions } from './speedtest-options.js';

const text = (selector, value) => {
  const element = document.querySelector(selector);
  if (element) { if (element.matches('.speed-metric > strong')) setMeasurement(element, value, selector.includes('ping-') ? 'ms' : ''); else element.textContent = value; }
};

const formatSpeed = value => Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 }).format(value) : '–';
const formatPing = value => Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 }).format(value) : '–';

export function selectedSpeedOptions() {
  return normalizeSpeedTestOptions({ downloadBytes: Number(document.querySelector('#speed-download-size').value), uploadBytes: Number(document.querySelector('#speed-upload-size').value) });
}

export function initSpeedOptions() {
  for (const [id, sizes, initial] of [['speed-download-size', DOWNLOAD_SIZES, DEFAULT_DOWNLOAD_BYTES], ['speed-upload-size', UPLOAD_SIZES, DEFAULT_UPLOAD_BYTES]]) {
    const select = document.getElementById(id);
    select.replaceChildren(...sizes.map(bytes => { const option = document.createElement('option'); option.value = String(bytes); option.textContent = `${bytes / 1_000_000} MB`; return option; }));
    select.value = String(initial);
    select.addEventListener('change', renderSpeedSelection);
  }
  renderSpeedSelection();
}

function renderSpeedSelection() {
  const { downloadBytes, uploadBytes } = selectedSpeedOptions();
  text('#speed-data-note', `Auswahl: ${downloadBytes / 1_000_000} MB Download + ${uploadBytes / 1_000_000} MB Upload = ${(downloadBytes + uploadBytes) / 1_000_000} MB Testdaten, zuzüglich Protokollverkehr.`);
}

export function renderSpeed(state) {
  const test = state?.speedTest || {};
  text('#speed-measured-size', test.at && test.downloadBytes && test.uploadBytes ? `Datenmenge dieses Tests: ${test.downloadBytes / 1_000_000} MB Download · ${test.uploadBytes / 1_000_000} MB Upload${test.error ? ' (möglicherweise unvollständig)' : ''}` : '');
  const button = document.querySelector('#speed-btn');
  if (button) button.textContent = test.running ? 'Test läuft …' : test.at ? 'Erneut messen' : 'Speedtest starten';

  text('#speed-download-value', formatSpeed(test.downloadMbps));
  text('#speed-upload-value', formatSpeed(test.uploadMbps));
  text('#speed-ping-before', formatPing(test.pingBeforeMs));
  text('#speed-ping-download', formatPing(test.pingDuringDownloadMs));
  text('#speed-ping-upload', formatPing(test.pingDuringUploadMs));
  text('#speed-ping-after', formatPing(test.pingAfterMs));
  text('#speed-ping-download-label', `Ø bei Download · ${test.pingDuringDownloadCount || 0} Antworten`);
  text('#speed-ping-upload-label', `Ø bei Upload · ${test.pingDuringUploadCount || 0} Antworten`);

  const phases = {
    'ping-before': 'Internet-Ping vor der Testlast wird gemessen …',
    download: 'Download wird gemessen …',
    upload: 'Upload wird gemessen …',
    'ping-after': 'Internet-Ping nach der Testlast wird gemessen …',
    done: 'Speedtest abgeschlossen. Internet-Pingwerte zeigen den Zustand vor, während und nach der Testlast.',
    error: `Speedtest fehlgeschlagen: ${test.error || 'Messung unvollständig'}`,
  };
  text('#speed-status', phases[test.phase] || (test.at ? 'Letzte Messung' : 'Es wird nichts gestartet, bis du den Test ausdrücklich auswählst.'));
  const progress = Number.isFinite(test.progress) ? Math.max(0, Math.min(100, test.progress)) : 0;
  const track = document.querySelector('.speed-progress-track');
  const bar = document.querySelector('#speed-progress-bar');
  if (track) {
    track.classList.toggle('is-indeterminate', test.running && test.phase === 'upload' && progress === 0);
    if (track.classList.contains('is-indeterminate')) track.removeAttribute('aria-valuenow');
    else track.setAttribute('aria-valuenow', String(Math.round(progress)));
    track.hidden = !test.running;
  }
  if (bar) bar.style.width = track?.classList.contains('is-indeterminate') ? '' : `${progress}%`;
  const phaseLabel = test.running && test.phase === 'download' && test.totalBytes
    ? `Download · ${formatSpeed(test.transferredBytes / 1_000_000)} / ${formatSpeed(test.totalBytes / 1_000_000)} MB`
    : test.running && test.phase === 'upload' && test.totalBytes
      ? progress === 0 ? 'Upload wird übertragen …' : `Upload · ${formatSpeed(test.transferredBytes / 1_000_000)} / ${formatSpeed(test.totalBytes / 1_000_000)} MB`
      : test.running && test.phase === 'ping-before' ? 'Ping vorher'
        : test.running && test.phase === 'ping-after' ? 'Ping nachher'
          : '';
  text('#speed-progress-label', phaseLabel);
  text('#speed-ping-target', test.pingTarget
    ? `Ping-Ziel: ${test.pingTarget}`
    : 'Ping-Messung vor, während und nach der Last.');
  const pingHelp = document.querySelector('#speed-ping-target');
  if (pingHelp) pingHelp.dataset.help = 'Tatsächliche ICMP-Pings zum Internetziel; unter Last stammen Werte aus den regulären Überwachungsrunden. Ohne gültige Antwort bleibt der Wert unbekannt.';
}
