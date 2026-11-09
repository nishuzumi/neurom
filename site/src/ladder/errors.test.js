// errors.test.js — the page has a message for every error code of the name service, in both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES } from '../../server/names.js';
import { NAME_ERROR_CODES, nameErrorMessage } from './errors.js';
import { setLocale } from '../i18n.js';

test('every error code of the name service has a message, and the page has no message for a code the service does not send', () => {
  assert.deepEqual([...NAME_ERROR_CODES].sort(), [...ERROR_CODES].sort());
});

test('each message is a sentence of its own in Chinese and in English, not the fallback with the code', t_ => {
  t_.after(() => setLocale('zh'));
  for (const lang of ['zh', 'en']) {
    setLocale(lang);
    for (const code of ERROR_CODES) {
      const text = nameErrorMessage(code, { min: 3, max: 24 });
      assert.ok(text && !text.includes(code), `${lang} ${code}: ${text}`);
      if (lang === 'en') assert.doesNotMatch(text, /[\u3400-\u9fff]/, `${code} has no English text: ${text}`);
    }
  }
  setLocale('en');
  assert.equal(nameErrorMessage('something_else'), 'The name service refused the request: something_else');
});
