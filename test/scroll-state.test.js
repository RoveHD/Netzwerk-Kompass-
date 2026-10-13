import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollRegionKey } from '../public/scroll-state.js';

test('separately keyed PC and WAN interval lists do not share restored scroll positions', () => {
  const root = { dataset: { scrollScope: 'history' } };
  const pc = { dataset: { scrollKey: 'lag-traffic:phase-a:pc:intervals' }, id: '', className: 'lag-traffic-intervals', closest: () => ({ dataset: { disclosureKey: 'lag-traffic:phase-a' } }) };
  const wan = { ...pc, dataset: { scrollKey: 'lag-traffic:phase-a:wan:intervals' } };

  assert.notEqual(scrollRegionKey(root, pc, 0), scrollRegionKey(root, wan, 1));
  assert.equal(scrollRegionKey(root, pc, 0), 'history:lag-traffic:phase-a:pc:intervals');
  assert.equal(scrollRegionKey(root, wan, 1), 'history:lag-traffic:phase-a:wan:intervals');
});

test('scroll keys retain disclosure and index fallback for existing regions', () => {
  const root = { dataset: {} };
  const existing = { dataset: {}, id: '', className: 'lag-traffic-intervals', closest: () => ({ dataset: { disclosureKey: 'lag-traffic:phase-a' } }) };
  assert.equal(scrollRegionKey(root, existing, 4), 'default:lag-traffic:phase-a:lag-traffic-intervals');
  const ungrouped = { dataset: {}, id: 'stable-region', className: '', closest: () => null };
  assert.equal(scrollRegionKey(root, ungrouped, 4), 'default:stable-region');
});
