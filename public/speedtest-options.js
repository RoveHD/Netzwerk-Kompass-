export const DOWNLOAD_SIZES = Object.freeze([5, 10, 25, 45, 100, 250].map(mb => mb * 1_000_000));
export const UPLOAD_SIZES = Object.freeze([1, 2, 5, 8, 20, 50].map(mb => mb * 1_000_000));
export const DEFAULT_DOWNLOAD_BYTES = 45_000_000;
export const DEFAULT_UPLOAD_BYTES = 8_000_000;

export function normalizeSpeedTestOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Ungültige Speedtest-Auswahl.');
  const downloadBytes = options.downloadBytes === undefined ? DEFAULT_DOWNLOAD_BYTES : options.downloadBytes;
  const uploadBytes = options.uploadBytes === undefined ? DEFAULT_UPLOAD_BYTES : options.uploadBytes;
  if (!DOWNLOAD_SIZES.includes(downloadBytes)) throw new Error('Bitte eine angebotene Download-Datenmenge auswählen.');
  if (!UPLOAD_SIZES.includes(uploadBytes)) throw new Error('Bitte eine angebotene Upload-Datenmenge auswählen.');
  return { downloadBytes, uploadBytes };
}
