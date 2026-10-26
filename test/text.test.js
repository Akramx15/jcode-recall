import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeText, tokenize, tokenizePath, looseKey, slugify, hasCjk } from '../src/text.js';

test('Arabic normalization strips diacritics and unifies letters', () => {
  assert.equal(normalizeText('أَحْمَد'), 'احمد');
  assert.equal(normalizeText('إسلام'), 'اسلام');
  assert.equal(normalizeText('آمن'), 'امن');
  assert.equal(normalizeText('مدرسة'), 'مدرسه');
  assert.equal(normalizeText('مصطفى'), 'مصطفي');
  assert.equal(normalizeText('مُؤَسَّسَة'), 'موسسه');
});

test('Arabic-Indic digits become ASCII digits', () => {
  assert.equal(normalizeText('١٢٣٤٥'), '12345');
  assert.equal(normalizeText('۱۴۰'), '140');
});

test('Latin is lowercased and diacritics survive as letters', () => {
  assert.equal(normalizeText('Café ÉTÉ'), 'café été');
});

test('tokenize handles mixed Arabic/Latin text and stop words', () => {
  const tokens = tokenize('نستخدم Redis في التخزين المؤقت');
  assert.ok(tokens.includes('redis'));
  assert.ok(tokens.includes('التخزين'));
  assert.ok(!tokens.includes('في'));
});

test('tokenize keeps CJK runs intact', () => {
  const tokens = tokenize('机器学习 model');
  assert.ok(tokens.includes('机器学习'));
  assert.ok(tokens.includes('model'));
  assert.ok(hasCjk('机器学习'));
  assert.ok(!hasCjk('learning'));
});

test('tokenizePath exposes path components for retrieval', () => {
  const tokens = tokenizePath('src/store/recall-store.js');
  assert.ok(tokens.includes('store'));
  assert.ok(tokens.includes('recall'));
  assert.ok(tokens.includes('js'));
});

test('looseKey compares Arabic variants as equal', () => {
  assert.equal(looseKey('أَحْمَد'), looseKey('احمد'));
  assert.equal(slugify('My Project!!'), 'my-project');
});
