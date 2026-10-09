// code-editor.ts — the pieces that a code-editing body uses (CodeModule: the code module's file, ScriptEditor: a view
// script). They are the base theme of the editor and its binding to a buffered text field (common.ts useBuffered), the
// hover frame / tooltip state and the token highlighter.
// CodeEditor.vue renders the code module's editor (CodeMirror) and the teleported hover of one `useCodeHover()`.
import { onBeforeUnmount, shallowRef, watch, type ShallowRef } from 'vue';
import { closeBrackets } from '@codemirror/autocomplete';
import { history } from '@codemirror/commands';
import { javascript, typescriptLanguage } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Annotation, EditorState, Transaction, type Extension } from '@codemirror/state';
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight';
import { EditorView } from '@codemirror/view';
import { hoverPlace, type Hover, type HoverContext, type HoverSpan } from './code-hover';
import type { Buffered } from './common';

/** Token classes, coloured by bodies-a.css: one highlighter for the editor and the hover's code line. */
const highlighter = tagHighlighter([
  { tag: tags.comment, class: 'tok-comment' },
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: tags.string, class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'tok-number' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'tok-function' },
  { tag: [tags.typeName, tags.className], class: 'tok-type' },
  { tag: tags.propertyName, class: 'tok-property' },
  { tag: tags.regexp, class: 'tok-regex' },
  { tag: tags.operator, class: 'tok-operator' },
  { tag: tags.punctuation, class: 'tok-punct' },
]);
const escapeHTML = (s: string) => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
/** `text` as highlighted HTML (the hover's code line, for example `(parameter) x: number`, parses well enough as TS) */
export function highlight(text: string): string {
  let html = '';
  highlightCode(text, typescriptLanguage.parser.parse(text), highlighter,
    (s, cls) => { html += cls ? `<span class="${cls}">${escapeHTML(s)}</span>` : escapeHTML(s); }, () => { html += '\n'; });
  return html;
}

/** The editors' dark theme on the studio's colours. `extra` adds rules (CodeEditor: its tooltips). */
export const editorTheme = (extra: Parameters<typeof EditorView.theme>[0] = {}) => EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.45' },
  '.cm-content': { padding: '4px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { background: 'color-mix(in srgb, var(--focus) 35%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--focus) 25%, transparent)', outline: 'none' },
  ...extra,
}, { dark: true });

/** { line (1-based), column (0-based) } in the edited text */
export interface Loc { line: number; column: number }
/** What the editor hovers: its spans (offsets into the edited text, sorted as parse* sorts them) and, per span, the
 *  context describing it (a file types each unit on its own). */
export interface HoverModel { spans: HoverSpan[]; ctxOf(span: HoverSpan): HoverContext }

/** What both editors share around `buffer`: the base JavaScript editing extensions (history, brackets, indent,
 *  wrapping, highlighting), the aria `label` of the content, typed changes → `buffer.input`, blur → `buffer.flush`.
 *  Also, for the mounted `view`, a buffer change from elsewhere (undo, a template) replaces the document and does not
 *  enter the history of the editor. Call in setup. */
export function bufferBinding(buffer: Buffered, label: string, view: () => EditorView | null): Extension[] {
  const external = Annotation.define<boolean>();   // a document replaced from the buffer, not typed
  watch(buffer.text, v => {
    const ed = view();
    if (!ed || v === ed.state.doc.toString()) return;
    ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: v }, annotations: [external.of(true), Transaction.addToHistory.of(false)], filter: false });
  });
  return [
    history(), closeBrackets(), bracketMatching(), indentOnInput(),
    EditorState.tabSize.of(2), indentUnit.of('  '), EditorView.lineWrapping,
    javascript(), syntaxHighlighting(highlighter),
    EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
    EditorView.updateListener.of(u => { if (u.docChanged && !u.transactions.some(tr => tr.annotation(external))) buffer.input(u.state.doc.toString()); }),
    EditorView.domEventHandlers({ blur: () => buffer.flush() }),
  ];
}

// ------------------------------------------------------------------ hovers (VS Code style, code-hover.ts)
const HOVER_MS = 300;
/** client box of a hovered token (one per line box it spans) */
export type Box = { left: number; top: number; width: number; height: number };
type Anchor = { left: number; top: number; bottom: number };
type Target = { marks: Box[]; anchor: Anchor; info: () => Hover };
/** The hover state of one body: the frame over the pointed name at once, its tooltip after a pause. */
interface CodeHover { marks: ShallowRef<Box[]>; hover: ShallowRef<{ info: Hover; style: Record<string, string> } | null>; on(key: string | null, build: () => Target | null): void; hide(): void }
export function useCodeHover(): CodeHover {
  const marks = shallowRef<Box[]>([]);
  const hover = shallowRef<{ info: Hover; style: Record<string, string> } | null>(null);
  let key: string | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  /** Point at the target `next`: its frame at once, its hover after a pause (at once while another hover shows). null
   *  clears both. `build` locates the target. `info` is computed only when the hover shows. */
  function on(next: string | null, build: () => Target | null) {
    if (next === key) return;
    key = next;
    if (timer) { clearTimeout(timer); timer = null; }
    const target = next === null ? null : build();
    marks.value = target?.marks ?? [];
    const show = () => { hover.value = target && { info: target.info(), style: hoverPlace(target.anchor) }; };
    if (!target || hover.value) show();
    else timer = setTimeout(show, HOVER_MS);
  }
  const hide = () => on(null, () => null);
  // the canvas pans / zooms under a fixed frame / hover: drop them
  const WHEEL = { capture: true, passive: true } as const;
  watch(() => marks.value.length > 0, up => { if (up) window.addEventListener('wheel', hide, WHEEL); else window.removeEventListener('wheel', hide, WHEEL); });
  onBeforeUnmount(() => { hide(); window.removeEventListener('wheel', hide, WHEEL); });
  return { marks, hover, on, hide };
}
