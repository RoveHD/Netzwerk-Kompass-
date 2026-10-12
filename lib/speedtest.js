import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeSpeedTestOptions } from '../public/speedtest-options.js';

const transferTimeout = bytes => Math.min(360_000, Math.max(25_000, Math.ceil(bytes * 8 / 8_000_000 * 1000) + 15_000));

export async function runSpeedTest(update, options = {}) {
  const { downloadBytes, uploadBytes } = normalizeSpeedTestOptions(options);
  const { fetchImpl = fetch, signal } = options;
  const download = async (bytes, pass) => {
    const start = performance.now();
    const response = await fetchImpl(`https://speed.cloudflare.com/__down?bytes=${bytes}`, { signal: AbortSignal.any([AbortSignal.timeout(transferTimeout(bytes)), ...(signal ? [signal] : [])]), cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error(`Download: HTTP ${response.status}`);
    let count = 0;
    for await (const chunk of response.body) {
      count += chunk.length;
      if (count > bytes) throw new Error('Unerwartete Download-Antwort.');
      update({ phase: 'download', progress: Math.min(99, Math.round((downloadedBytes + count) / downloadBytes * 100)), transferredBytes: downloadedBytes + count, totalBytes: downloadBytes, downloadPass: pass });
    }
    if (count !== bytes) throw new Error('Download wurde nicht vollständig übertragen.');
    return { mbps: count * 8 / ((performance.now() - start) * 1000), elapsed: performance.now() - start };
  };
  let downloadedBytes = 0;
  update({ phase: 'download', progress: 0, downloadMbps: null, uploadMbps: null, downloadBytes, uploadBytes });
  const warmupBytes = Math.min(5_000_000, Math.floor(downloadBytes * 0.2));
  const first = await download(warmupBytes, 1);
  downloadedBytes += warmupBytes;
  const second = await download(downloadBytes - warmupBytes, 2);
  downloadedBytes += downloadBytes - warmupBytes;
  update({ phase: 'upload', progress: 0, downloadMbps: second.mbps, transferredBytes: 0, totalBytes: uploadBytes, downloadBytes, uploadBytes });
  const data = randomBytes(uploadBytes);
  const start = performance.now();
  const response = await fetchImpl('https://speed.cloudflare.com/__up', { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.any([AbortSignal.timeout(transferTimeout(uploadBytes)), ...(signal ? [signal] : [])]), redirect: 'error' });
  if (!response.ok) throw new Error(`Upload: HTTP ${response.status}`);
  await response.body?.cancel();
  const uploadMbps = data.length * 8 / ((performance.now() - start) * 1000);
  update({ phase: 'upload', progress: 100, transferredBytes: data.length, totalBytes: data.length });
  return { downloadMbps: second.mbps, uploadMbps, downloadBytes, uploadBytes };
}
