import test from 'node:test';
import assert from 'node:assert/strict';
import { runSpeedTest } from '../lib/speedtest.js';

const streamedBytes = bytes => ({
  async *[Symbol.asyncIterator]() {
    for (let remaining = bytes; remaining > 0;) {
      const length = Math.min(1_000_000, remaining);
      remaining -= length;
      yield { length };
    }
  },
});

test('selected download and upload limits are transferred exactly across bounded download passes', async () => {
  const cases = [[5, 1], [10, 2], [25, 5], [45, 8], [100, 20], [250, 50]];
  for (const [downloadMb, uploadMb] of cases) {
    const downloadRequests = [];
    let uploadedBytes = 0;
    const updates = [];
    const fetchImpl = async (url, options) => {
      if (options.method === 'POST') {
        uploadedBytes = options.body.length;
        return { ok: true, body: { cancel: async () => {} } };
      }
      const bytes = Number(new URL(url).searchParams.get('bytes'));
      downloadRequests.push(bytes);
      return { ok: true, body: streamedBytes(bytes) };
    };
    const requested = { downloadBytes: downloadMb * 1_000_000, uploadBytes: uploadMb * 1_000_000 };
    const result = await runSpeedTest(update => updates.push(update), { ...requested, fetchImpl });
    assert.equal(downloadRequests.reduce((sum, bytes) => sum + bytes, 0), requested.downloadBytes);
    assert.equal(downloadRequests.length, 2);
    assert.ok(downloadRequests[0] > 0 && downloadRequests[0] <= 5_000_000);
    assert.equal(uploadedBytes, requested.uploadBytes);
    assert.deepEqual({ downloadBytes: result.downloadBytes, uploadBytes: result.uploadBytes }, requested);
    assert.ok(updates.some(update => update.phase === 'download' && update.totalBytes === requested.downloadBytes && update.transferredBytes === requested.downloadBytes));
    assert.ok(updates.some(update => update.phase === 'upload' && update.progress === 100 && update.transferredBytes === requested.uploadBytes));
  }
});

test('defaults remain 45 MB down and 8 MB up', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') return { ok: true, body: { cancel: async () => {} } };
    const bytes = Number(new URL(url).searchParams.get('bytes')); requests.push(bytes);
    return { ok: true, body: streamedBytes(bytes) };
  };
  const result = await runSpeedTest(() => {}, { fetchImpl });
  assert.equal(requests.reduce((sum, bytes) => sum + bytes, 0), 45_000_000);
  assert.equal(result.downloadBytes, 45_000_000);
  assert.equal(result.uploadBytes, 8_000_000);
});

test('invalid limits are rejected before any fetch starts', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; throw new Error('fetch must not run'); };
  for (const options of [
    { downloadBytes: 6_000_000 },
    { downloadBytes: '45_000_000' },
    { uploadBytes: 3_000_000 },
    { uploadBytes: 50_000_001 },
  ]) await assert.rejects(runSpeedTest(() => {}, { ...options, fetchImpl }));
  assert.equal(fetches, 0);
});

test('incomplete responses, excess response bytes, and HTTP failures are rejected', async () => {
  await assert.rejects(runSpeedTest(() => {}, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(runSpeedTest(() => {}, { downloadBytes: 5_000_000, fetchImpl: async () => ({ ok: true, body: streamedBytes(1) }) }), /vollständig/);
  await assert.rejects(runSpeedTest(() => {}, { downloadBytes: 5_000_000, fetchImpl: async () => ({ ok: true, body: streamedBytes(3_000_000) }) }), /Unerwartete/);
});
