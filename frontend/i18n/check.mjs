// i18n/check.mjs — every Chinese UI string must have an English entry, and every entry must be used.
//
// Rules (Chinese = CJK ideographs, CJK punctuation or full-width forms such as `；` / `（`):
//   * .js / .ts / .vue <script>: a Chinese string literal is a message key. It is t('…') or a label constant that goes
//     through t() where it is shown. A Chinese template literal is an error: write t('…{name}…', { name }) instead.
//   * .vue <template>: Chinese static text or a static attribute is an error. Use {{ t('…') }} / :title="t('…')".
//     Literals inside bindings and interpolations follow the script rules.
//   * index.html: every Chinese text node and attribute is a key (the page entry translates it in place).
//   * templates/*.yaml: a builtin template's `name`, `description` and `preset.label` are keys (shown through t()).
//   * en.json: keys and values keep the same {placeholders} and HTML tags. Values contain no Chinese.
// A line containing `i18n-ignore` is skipped (Chinese that is data, not UI text).
//
//   node frontend/i18n/check.mjs [--dict path.json]... [file ...]    (defaults: en.json, all frontend sources)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as babelParse, parseExpression } from '@babel/parser';
import { parse as parseSfc } from 'vue/compiler-sfc';
import YAML from 'yaml';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;          // ideographs, CJK punctuation, full-width forms
const IDEOGRAPH = /[\u3400-\u9fff\uf900-\ufaff]/;
const SKIP_DIRS = new Set(['dist', 'node_modules', 'abi', 'i18n']);

/** All frontend files the checker understands, excluding tests, bundles and generated data. */
function sourceFiles(root = FRONTEND) {
  return readdirSync(root, { recursive: true }).map(String)
    .filter(p => !p.split(/[\\/]/).some(part => SKIP_DIRS.has(part)))
    .filter(p => /\.(js|mjs|ts|vue)$/.test(p) && !/\.test\.[jt]s$/.test(p) || p === 'index.html' || /^templates[\\/][^\\/]+\.yaml$/.test(p))
    .map(p => join(root, p)).sort();
}

const ignored = (source, line) => source.split('\n')[line - 1]?.includes('i18n-ignore');

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

/** Collect keys / errors from a parsed JS/TS AST. `lineOffset` maps SFC block lines back to the file. */
function scanAst(ast, source, where, out, lineOffset = 0) {
  walk(ast, node => {
    const line = (node.loc?.start.line ?? 1) + lineOffset;
    if (node.type === 'StringLiteral' && CJK.test(node.value)) {
      if (!ignored(source, line)) out.keys.push({ key: node.value, where: `${where}:${line}` });
    } else if (node.type === 'TemplateLiteral' && node.quasis.some(q => CJK.test(q.value.cooked ?? q.value.raw))) {
      if (!ignored(source, line)) out.errors.push(`${where}:${line}: Chinese template literal — use t('…{name}…', { name })`);
    }
  });
}

const PLUGINS = ['typescript', 'importAttributes', 'topLevelAwait'];
function scanScript(code, source, where, out, lineOffset = 0) {
  scanAst(babelParse(code, { sourceType: 'module', plugins: PLUGINS, errorRecovery: false }), source, where, out, lineOffset);
}
function scanExpression(code, source, where, line, out) {
  if (!CJK.test(code)) return;
  let ast;
  try { ast = parseExpression(code, { plugins: PLUGINS }); }
  catch { ast = babelParse(code, { sourceType: 'module', plugins: PLUGINS, allowReturnOutsideFunction: true }); }   // v-on statements
  scanAst(ast, source, where, out, line - 1);
}

// @vue/compiler-core NodeTypes
const ELEMENT = 1, TEXT = 2, INTERPOLATION = 5, ATTRIBUTE = 6, DIRECTIVE = 7;
function scanTemplate(node, source, where, out) {
  const line = node.loc?.start.line ?? 1;
  if (node.type === TEXT && CJK.test(node.content) && !ignored(source, line)) out.errors.push(`${where}:${line}: Chinese template text "${node.content.trim()}" — use {{ t('…') }}`);
  if (node.type === INTERPOLATION) scanExpression(node.content.content, source, where, node.content.loc.start.line, out);
  if (node.type === ELEMENT) for (const prop of node.props) {
    if (prop.type === ATTRIBUTE && prop.value && CJK.test(prop.value.content) && !ignored(source, prop.loc.start.line)) out.errors.push(`${where}:${prop.loc.start.line}: Chinese attribute ${prop.name}="${prop.value.content}" — bind it: :${prop.name}="t('…')"`);
    if (prop.type === DIRECTIVE && prop.exp) scanExpression(prop.exp.content, source, where, prop.exp.loc.start.line, out);
  }
  for (const child of node.children ?? []) scanTemplate(child, source, where, out);
}

function scanHtml(source, where, out) {
  const text = source.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' ')).replace(/<script[\s\S]*?<\/script>/g, m => m.replace(/[^\n]/g, ' '));
  const lineAt = index => text.slice(0, index).split('\n').length;
  for (const m of text.matchAll(/>([^<]+)</g)) {
    const key = m[1].trim();
    if (CJK.test(key) && !ignored(source, lineAt(m.index))) out.keys.push({ key, where: `${where}:${lineAt(m.index)}` });
  }
  for (const m of text.matchAll(/\s([\w-]+)="([^"]*)"/g)) {
    if (CJK.test(m[2]) && !ignored(source, lineAt(m.index))) out.keys.push({ key: m[2], where: `${where}:${lineAt(m.index)}` });
  }
}

function scanTemplateYaml(source, where, out) {
  const tpl = YAML.parse(source), lineOf = text => source.slice(0, Math.max(0, source.indexOf(text))).split('\n').length;
  for (const key of [tpl.name, tpl.description, tpl.preset?.label]) if (typeof key === 'string' && CJK.test(key)) out.keys.push({ key, where: `${where}:${lineOf(key)}` });
}

function scanFile(file, out = { keys: [], errors: [] }) {
  const source = readFileSync(file, 'utf8'), where = relative(FRONTEND, file).replaceAll('\\', '/');
  try {
    if (file.endsWith('.html')) scanHtml(source, where, out);
    else if (file.endsWith('.yaml')) scanTemplateYaml(source, where, out);
    else if (file.endsWith('.vue')) {
      const { descriptor, errors } = parseSfc(source, { filename: file });
      if (errors.length) throw errors[0];
      for (const block of [descriptor.script, descriptor.scriptSetup]) if (block) scanScript(block.content, source, where, out, block.loc.start.line - 1);
      if (descriptor.template) scanTemplate(descriptor.template.ast, source, where, out);
    } else scanScript(source, source, where, out);
  } catch (error) { out.errors.push(`${where}: cannot parse (${error.message})`); }
  return out;
}

const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const tags = s => [...s.matchAll(/<\/?([a-z][\w-]*)/gi)].map(m => m[0].toLowerCase()).sort().join(',');

/** Check `files` against the merged `dictionary`. The check reports `unused` entries only when it scanned every source. */
export function checkI18n({ files = sourceFiles(), dictionary, reportUnused = true } = {}) {
  const out = { keys: [], errors: [] };
  for (const file of files) scanFile(file, out);
  const errors = [...out.errors], used = new Set();
  for (const { key, where } of out.keys) {
    used.add(key);
    if (!Object.hasOwn(dictionary, key)) errors.push(`${where}: no English entry for ${JSON.stringify(key)}`);
  }
  for (const [key, value] of Object.entries(dictionary)) {
    if (typeof value !== 'string' || !value.trim()) { errors.push(`en: empty entry for ${JSON.stringify(key)}`); continue; }
    if (IDEOGRAPH.test(value)) errors.push(`en: Chinese left in ${JSON.stringify(value)}`);
    if (placeholders(key) !== placeholders(value)) errors.push(`en: placeholders differ: ${JSON.stringify(key)} → ${JSON.stringify(value)}`);
    if (tags(key) !== tags(value)) errors.push(`en: HTML tags differ: ${JSON.stringify(key)} → ${JSON.stringify(value)}`);
    if (reportUnused && !used.has(key)) errors.push(`en: unused entry ${JSON.stringify(key)}`);
  }
  return { errors, keys: used.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dict: { type: 'string', multiple: true } } });
  const dicts = values.dict?.length ? values.dict : [join(FRONTEND, 'i18n', 'en.json')];
  const dictionary = Object.assign({}, ...dicts.map(p => JSON.parse(readFileSync(p, 'utf8'))));
  const files = positionals.length ? positionals.map(p => resolve(p)) : sourceFiles();
  const { errors, keys } = checkI18n({ files, dictionary, reportUnused: true });
  for (const e of errors) console.error(e);
  console.log(`${files.length} files, ${keys} keys, ${errors.length} problems`);
  process.exitCode = errors.length ? 1 : 0;
}
