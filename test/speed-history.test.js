import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSpeedHistory } from '../public/speed-history.js';

test('screenshot examples yield average, min and max speed and per-test ping means', () => {
  const result = summarizeSpeedHistory([
    { type:'speedtest', downloadMbps:85.7, uploadMbps:18.2, pingBeforeMs:24, pingDuringDownloadMs:36.8, pingDuringDownloadCount:8, pingDuringUploadMs:38, pingAfterMs:18, pingTarget:'Cloudflare' },
    { type:'speedtest', downloadMbps:83.7, uploadMbps:17.9, pingBeforeMs:16, pingDuringDownloadMs:26.4, pingDuringDownloadCount:2, pingDuringUploadMs:26, pingAfterMs:16, pingTarget:'Cloudflare' },
  ]);
  assert.equal(result.total, 2); assert.equal(result.usable, 2); assert.equal(result.failed, 0);
  assert.deepEqual(result.metrics.downloadMbps, { count:2, mean:84.7, min:83.7, max:85.7 });
  assert.equal(result.metrics.uploadMbps.mean, 18.05);
  assert.equal(result.metrics.uploadMbps.min, 17.9); assert.equal(result.metrics.uploadMbps.max, 18.2);
  assert.equal(result.metrics.pingBeforeMs.mean, 20);
  assert.ok(Math.abs(result.metrics.pingDuringDownloadMs.mean - 31.6) < 1e-10);
  assert.equal(result.metrics.pingDuringUploadMs.mean, 32); assert.equal(result.metrics.pingAfterMs.mean, 17);
  assert.deepEqual(result.pingTargets, ['Cloudflare']);
});

test('errors, running tests and other record types cannot distort successful test averages', () => {
  const result = summarizeSpeedHistory([
    {type:'speedtest', downloadMbps:80, uploadMbps:20},
    {type:'speedtest', error:'Upload failed', downloadMbps:1000, pingBeforeMs:1},
    {type:'speedtest', running:true, downloadMbps:8000},
    {type:'stress', downloadMbps:9999, uploadMbps:8888},
    {type:'traffic', downloadMbps:9000}, null,
  ]);
  assert.equal(result.total, 2); assert.equal(result.failed, 1); assert.equal(result.usable, 1);
  assert.deepEqual(result.metrics.downloadMbps, {count:1,mean:80,min:80,max:80});
  assert.equal(result.metrics.pingBeforeMs.count, 0);
});

test('zero is a measurement, while missing, invalid and no-response ping values stay unknown', () => {
  const result = summarizeSpeedHistory([
    {type:'speedtest', downloadMbps:0, uploadMbps:null, pingBeforeMs:0, pingDuringDownloadMs:0, pingDuringDownloadCount:0},
    {type:'speedtest', downloadMbps:null, uploadMbps:10, pingDuringDownloadMs:20, pingDuringDownloadCount:1, pingTarget:'A'},
    {type:'speedtest', downloadMbps:-1, uploadMbps:Infinity, pingAfterMs:NaN},
    {type:'speedtest', downloadMbps:'', uploadMbps:false, pingAfterMs:'12'},
  ]);
  assert.deepEqual(result.metrics.downloadMbps, {count:1,mean:0,min:0,max:0});
  assert.deepEqual(result.metrics.uploadMbps, {count:1,mean:10,min:10,max:10});
  assert.equal(result.metrics.pingBeforeMs.mean, 0); assert.equal(result.metrics.pingDuringDownloadMs.mean, 20);
  assert.deepEqual(result.metrics.pingAfterMs, {count:0,mean:null,min:null,max:null});
  assert.deepEqual(result.pingTargets, ['Unbekanntes Pingziel','A']);
});

test('load test statistics exclude inactive directions and errors without mixing in speed tests', () => {
  const result = summarizeSpeedHistory([
    {type:'stress', mode:'download', downloadMbps:60, uploadMbps:0, reason:'stopped'},
    {type:'stress', mode:'upload', downloadMbps:0, uploadMbps:12, reason:'completed'},
    {type:'stress', mode:'both', downloadMbps:100, uploadMbps:20, reason:'completed'},
    {type:'stress', mode:'both', downloadMbps:900, uploadMbps:500, reason:'error'},
    {type:'speedtest', downloadMbps:9000, uploadMbps:1000},
  ], 'stress');
  assert.equal(result.total, 4); assert.equal(result.failed, 1); assert.equal(result.usable, 3);
  assert.deepEqual(result.metrics.downloadMbps, {count:2,mean:80,min:60,max:100});
  assert.deepEqual(result.metrics.uploadMbps, {count:2,mean:16,min:12,max:20});
});

test('empty and entirely failed sets have no invented zero averages', () => {
  for (const records of [[], null, [{type:'speedtest',error:'Timeout',downloadMbps:0}]]) {
    const result = summarizeSpeedHistory(records);
    assert.deepEqual(result.metrics.downloadMbps, {count:0,mean:null,min:null,max:null});
    assert.equal(result.usable, 0);
  }
});
