// Synthetic offline examples only; no real campaign configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rawCardSignature, searchReadiness, retainDomAfterSearchTimeout } from './browser.mjs';

const view = (ids, query = 'alice synthetic_topic', text = '') => ({ url: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`, text, cards: ids.map(id => ({ id })) });
test('requires current action response/DOM overlap and rejects stale changed cards', () => {
  assert.equal(searchReadiness(view(['old1', 'old2']), 'alice synthetic_topic', new Set(['alice1'])), 'pending');
  assert.equal(searchReadiness(view(['alice1']), 'alice synthetic_topic', new Set(['alice1'])), 'current_action_response_cards');
  assert.equal(searchReadiness(view(['alice1'], 'bob synthetic_topic'), 'alice synthetic_topic', new Set(['alice1'])), 'pending');
});
test('only query-specific explicit empty text ends the ready wait', () => {
  assert.equal(searchReadiness(view([], 'alice synthetic_topic', '找不到“alice synthetic_topic”的结果'), 'alice synthetic_topic'), 'explicit_query_empty');
  assert.equal(searchReadiness(view([], 'alice synthetic_topic', '找不到“bob synthetic_topic”的结果'), 'alice synthetic_topic'), 'pending');
  assert.equal(searchReadiness(view([], 'alice synthetic_topic', 'No results'), 'alice synthetic_topic'), 'pending');
});
test('unpaired DOM remains pending until bounded timeout then can be retained with a gap', () => {
  const current = view(['new1']);
  assert.equal(searchReadiness(current, 'alice synthetic_topic'), 'pending');
  assert.equal(retainDomAfterSearchTimeout(current, 'alice synthetic_topic', 'old1'), true);
  assert.equal(retainDomAfterSearchTimeout(current, 'alice synthetic_topic', 'new1'), false);
  assert.equal(retainDomAfterSearchTimeout(view([]), 'alice synthetic_topic', 'old1'), false);
  assert.equal(retainDomAfterSearchTimeout(view(['new1'], 'bob synthetic_topic'), 'alice synthetic_topic', 'old1'), false);
});
test('scroll compares the same unfiltered signature rather than authorOnly versus whole DOM', () => {
  const before = view(['own1', 'other2']), after = view(['other2', 'own1']);
  const filtered = { ...before, cards: before.cards.filter(c => c.id === 'own1') };
  assert.notEqual(rawCardSignature(filtered), rawCardSignature(after), 'the old mixed scopes would falsely report a change');
  assert.equal(rawCardSignature(before), rawCardSignature(after), 'consistent unfiltered signatures wait for a real change');
  assert.notEqual(rawCardSignature(before), rawCardSignature(view(['own1', 'other2', 'own3'])));
});
