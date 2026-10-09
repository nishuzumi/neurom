<script setup lang="ts">
// CodeEditor.vue — the restricted-JS editor of a code module (CodeModule's file), on CodeMirror, and its teleported
// hover (code-editor.ts useCodeHover).
// Text: the view edits the local buffer of the body (`buffer.input` per change, `flush` on blur). A buffer change from
// elsewhere (undo, a template) replaces the document and does not enter the history of the editor.
// Hovers: the innermost of the `model` spans under the character at the pointer. The editor asks `model` only while the
// pointer moves over the text. The body parses its buffer again then, not on every keystroke.
// Problems: `problems` (the located errors of the body, from the committed text) underline their ranges. The messages
// stay listed under the editor, so the underline has no tooltip of its own.
// Completion: `complete` at the caret, never inside a comment or a string.
// Contract (code-contract.ts): the focus of the role tab, and the locked headers with their types and `?` (emits
// `help`). The editor applies them while the document is the text they were built from. `hiddenEdit` when an undo
// changed text that the tab hides.
// `apply` makes the own edits of the body (add / delete a role, rewrite a header). These edits pass the locks and enter
// the history of the editor.
// Tooltips (completion) mount on <body>. The canvas scales the editor, so a fixed box inside it would scale and drift.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { autocompletion, closeBracketsKeymap, completionKeymap, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { linter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState, type Text } from '@codemirror/state';
import { EditorView, keymap, tooltips } from '@codemirror/view';
import { describe, spanAt } from './code-hover';
import { bufferBinding, editorTheme, highlight, useCodeHover, type Box, type HoverModel, type Loc } from './code-editor';
import type { Buffered } from './common';
import { contractExtension, setContract, type Contract } from './code-contract';
import './bodies-a.css';

/** a located problem. `end` when the error knows where its range stops */
interface Problem { loc: Loc; end?: Loc | null; message: string }
const props = defineProps<{
  buffer: Buffered; model: () => HoverModel | null; label: string;
  problems: readonly Problem[]; complete: (text: string, pos: number, explicit: boolean) => CompletionResult | null;
  contract: Contract | null;
}>();
const emit = defineEmits<{ help: [key: string, anchor: HTMLElement]; hiddenEdit: [] }>();
const hovers = useCodeHover();
const { marks, hover, hide } = hovers;
const hoverCode = computed(() => (hover.value ? highlight(hover.value.info.code) : ''));

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const binding = bufferBinding(props.buffer, props.label, () => view);

const offsetOf = (doc: Text, loc: Loc) => {
  const line = doc.line(Math.min(Math.max(1, loc.line), doc.lines));
  return Math.min(line.from + loc.column, line.to);
};
/** a problem's range: to its end, else over the word at its start (at least one character, within the line) */
function diagnostic(doc: Text, p: Problem): Diagnostic {
  const from = offsetOf(doc, p.loc), line = doc.lineAt(from);
  let to = p.end ? offsetOf(doc, p.end) : from + (/^[\p{L}\p{N}_$]+/u.exec(line.text.slice(from - line.from))?.[0].length ?? 0);
  if (to <= from) to = Math.min(from + 1, line.to);
  return { from, to, severity: 'error', message: p.message };
}
const showProblems = () => {
  if (!view) return;
  const doc = view.state.doc;
  view.dispatch(setDiagnostics(view.state, props.problems.map(p => diagnostic(doc, p))));
};

const theme = editorTheme({
  '.cm-tooltip': { background: 'var(--panel)', border: '1px solid var(--line-strong)', borderRadius: '6px', color: 'var(--ink)', boxShadow: '0 6px 20px #0007' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '14lh' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '1px 8px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'color-mix(in srgb, var(--focus) 35%, transparent)', color: 'var(--ink)' },
  '.cm-completionDetail': { marginLeft: '1.5em', fontStyle: 'normal', color: 'var(--muted)' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--focus)' },
  '.cm-completionInfo': { padding: '5px 9px', maxWidth: '360px', fontSize: '12px', lineHeight: '1.45' },
});

/** the character under the client point, or null when the point is not over one */
function charAt(v: EditorView, x: number, y: number): number | null {
  const pos = v.posAtCoords({ x, y });
  if (pos === null) return null;
  for (const p of [pos, pos - 1]) {
    if (p < 0 || p >= v.state.doc.length || v.state.doc.sliceString(p, p + 1) === '\n') continue;
    const a = v.coordsAtPos(p, 1), b = v.coordsAtPos(p + 1, -1);
    if (a && b && b.top === a.top && x >= a.left && x < b.left && y >= a.top && y < a.bottom) return p;
  }
  return null;
}
/** client boxes of the text [start, end) (one per line box) */
function boxesOf(v: EditorView, start: number, end: number): DOMRect[] {
  const a = v.domAtPos(start, 1), b = v.domAtPos(end, -1), range = document.createRange();
  range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
  return [...range.getClientRects()].filter(r => r.width > 0);
}
function onMove(e: MouseEvent) {
  const v = view, model = e.buttons || !v || v.composing ? null : props.model();
  const offset = v && model ? charAt(v, e.clientX, e.clientY) : null;
  const span = model && offset !== null ? spanAt(model.spans, offset) : null;
  if (!v || !model || !span) return hide();
  hovers.on(`body:${span.start}:${span.end}`, () => {
    const boxes = boxesOf(v, span.start, span.end);
    return boxes.length ? { marks: boxes, anchor: boxes[0], info: () => describe(span, model.ctxOf(span)) } : null;
  });
}
/** the frame reaches 2px past the token on each side, so its border never touches the glyphs */
const markStyle = (b: Box) => ({ left: `${b.left - 2}px`, top: `${b.top}px`, width: `${b.width + 4}px`, height: `${b.height}px` });

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.buffer.text.value,
      extensions: [
        ...binding,
        contractExtension({ onHelp: (key, anchor) => emit('help', key, anchor), onHiddenEdit: () => emit('hiddenEdit') }),
        theme,
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        tooltips({ parent: document.body }),
        linter(null, { tooltipFilter: () => [] }),
        autocompletion({
          icons: false,
          override: [ctx => {
            const inside = syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name;
            if (/Comment|String|Template/.test(inside)) return null;
            return props.complete(ctx.state.doc.toString(), ctx.pos, ctx.explicit);
          }],
        }),
        EditorView.updateListener.of(u => { if (u.docChanged) hide(); }),
        EditorView.domEventHandlers({ mousemove: onMove, mouseleave: () => hide(), mousedown: () => hide(), keydown: () => hide() }),
      ],
    }),
  });
  view.scrollDOM.addEventListener('scroll', hide, { passive: true });
  showProblems(); showContract();
});
onBeforeUnmount(() => { view?.destroy(); view = null; });
watch(() => props.problems, showProblems);
/** the contract of the current document (a contract of another text waits for the one of this text). A caret outside
 *  the shown role moves to the start of its body. */
function showContract() {
  const c = props.contract;
  if (!view || !c || c.text !== view.state.doc.toString()) return;
  view.dispatch({ effects: setContract.of({ heads: c.heads, focus: c.focus }) });
  const f = c.focus, head = view.state.selection.main.head;
  if (f && (head < f.from || head > f.to)) {
    const lock = c.heads.find(h => h.locks.length && h.locks[0].from >= f.from && h.locks[h.locks.length - 1].to <= f.to)?.locks.at(-1);
    view.dispatch({ selection: { anchor: Math.min(f.to, lock ? lock.to : f.from) } });
  }
}
watch(() => props.contract, showContract);
/** after the editor was hidden (another module's tab was shown): measure it again */
function refresh() { view?.requestMeasure(); }

/** the body's own edit of the text: replaces [from, to) with `insert` (locks do not apply), caret after it */
function apply(from: number, to: number, insert: string) {
  if (!view) return;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, filter: false, userEvent: 'input', scrollIntoView: true });
  view.focus();
}

/** place the caret at a location of the edited text */
function locate(loc: Loc) {
  if (!view) return;
  const pos = offsetOf(view.state.doc, loc);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}
defineExpose({ locate, apply, refresh });
</script>

<template>
  <div ref="host" class="code-edit bfill nowheel"></div>
  <Teleport to="body">
    <div v-for="(b, i) in marks" :key="i" class="code-hover-mark" :style="markStyle(b)"></div>
    <div v-if="hover" class="code-hover" role="tooltip" :style="hover.style">
      <pre class="code-hover-code"><code v-html="hoverCode"></code></pre>
      <div v-if="hover.info.doc" class="code-hover-doc">{{ hover.info.doc }}</div>
      <div v-for="(m, i) in hover.info.meta" :key="i" class="code-hover-meta">{{ m }}</div>
    </div>
  </Teleport>
</template>
