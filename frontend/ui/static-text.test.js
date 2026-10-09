import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n.js';
import { liveText } from './static-text.js';

test('a script-owned note follows the language after it is written', () => {
  const element = { textContent: '' };
  const note = liveText(element);
  try {
    note.show('已自动保存 {time}', { time: '12:00:00' });
    assert.equal(element.textContent, '已自动保存 12:00:00');
    setLocale('en');
    assert.equal(element.textContent, 'Auto-saved 12:00:00');
    note.show('Python 工作区未连接');
    assert.equal(element.textContent, 'Python workspace not connected');
    setLocale('zh');
    assert.equal(element.textContent, 'Python 工作区未连接', 'the latest message, not the first one');
  } finally { setLocale('zh'); }
});
