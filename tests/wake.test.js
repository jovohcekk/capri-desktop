'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const wake = import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'wake.js')).href);

test('her name alone is a call, with nothing asked yet', async () => {
  const { heardName } = await wake;
  assert.equal(heardName('Capri.'), '');
  assert.equal(heardName('капри!'), '');
  assert.equal(heardName('Kapri'), '');
});

test('what comes after her name is the ask', async () => {
  const { heardName } = await wake;
  assert.equal(heardName('Capri, open YouTube.'), 'open YouTube.');
  assert.equal(heardName('эй, капри, открой телеграм'), 'открой телеграм');
  assert.equal(heardName('Kapri qo‘shiq qo‘y'), 'qo‘shiq qo‘y');
});

test('not her name: she stays asleep', async () => {
  const { heardName } = await wake;
  assert.equal(heardName('open youtube'), null);
  assert.equal(heardName('capricious'), null);
  assert.equal(heardName(''), null);
});
