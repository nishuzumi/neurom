// code-contract.ts — what the code editor draws for the roles of a module (ADR 0012).
// CodeModule / code-roles.ts build it.
//   · focus: a role tab shows only that role (its doc comment through its closing line). The lines before and after
//     are hidden (block replace, atomic). No user edit reaches hidden text: the editor refuses all of a transaction
//     that touches it. Undo / redo pass. When an undo or redo changes hidden text, `onHiddenEdit` fires (the tab
//     returns to 全文).
//   · locked header: if the parameter count of a role header is the protocol's, the header is locked except for its
//     parameter names (`export function step(` … `, ` … `) {`, `export const budget =`). The editor drops typing into,
//     pasting over or deleting over those parts from an edit. The names stay for the file to choose. The count and
//     types come from the protocol.
//   · on the header line: a lock icon (its title says why), a grey type after each parameter and after `)`, and a `?`
//     at the end that opens the help window of the role (`onHelp`). The `?` is red when the parameter count is not the
//     protocol's.
// Decorations map through edits. CodeModule replaces them (setContract) each time the buffer parses. So while the
// buffer does not parse, the last decorations stay on their text. The body dispatches its own writes (buffer sync, add /
// delete a role, rewrite a header) with `filter: false`, and these writes pass everything.
import { StateEffect, StateField, EditorState, type Extension, type Range, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { t } from '../../i18n.js';

/** one role's header, in the text the contract was built from */
export interface RoleHead {
  key: string;
  /** the locked parts of the header (none when its parameter count is not the protocol's) */
  locks: { from: number; to: number }[];
  /** grey types drawn after positions of the header (`: State`, `→ number`) */
  hints: { at: number; text: string }[];
  /** where the `?` goes (end of the header) and whether it reports a problem */
  help: { at: number; bad: boolean };
}
/** the editor state of one text: role headers, and the range a role tab shows (null: the whole file) */
export interface Contract { text: string; heads: RoleHead[]; focus: { from: number; to: number } | null }
interface ContractHooks { onHelp(key: string, anchor: HTMLElement): void; onHiddenEdit(): void }

export const setContract = StateEffect.define<{ heads: RoleHead[]; focus: { from: number; to: number } | null }>();
const hidden = Decoration.replace({ block: true });

class LockIcon extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lock';
    s.title = t('调用方规定函数名和参数个数：参数可以改名，只写下面的函数体');
    s.setAttribute('aria-label', s.title);
    return s;
  }
}
class Hint extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: Hint) { return o.text === this.text; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-type-hint'; s.textContent = this.text; return s; }
}
class HelpButton extends WidgetType {
  constructor(readonly key: string, readonly bad: boolean, readonly hooks: ContractHooks) { super(); }
  eq(o: HelpButton) { return o.key === this.key && o.bad === this.bad; }
  toDOM() {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `cm-help${this.bad ? ' bad' : ''}`; b.textContent = '?';
    b.title = this.bad ? t('函数头与规定不符：点开查看') : t('说明：谁调用、传入什么、返回什么、例子');
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.hooks.onHelp(this.key, b); });
    return b;
  }
  ignoreEvent() { return true; }
}

interface Model { deco: DecorationSet; hide: DecorationSet }
/** the hidden ranges as they protect text: before the focus up to its first line's start, after it from its last
 *  line's end (so neither joining lines at the edges nor deleting a line break reaches hidden text) */
function guards(state: EditorState, hide: DecorationSet): [number, number][] {
  const out: [number, number][] = [], len = state.doc.length;
  hide.between(0, len, (from, to) => { out.push(from === 0 ? [0, Math.min(len, to + 1)] : [Math.max(0, from - 1), len]); });
  return out;
}
function touches(tr: Transaction, ranges: [number, number][]): boolean {
  let hit = false;
  tr.changes.iterChangedRanges((from, to) => {
    for (const [a, b] of ranges) if (a === 0 ? from < b : to > a || (from === to && from > a)) hit = true;
  });
  return hit;
}

function build(state: EditorState, heads: readonly RoleHead[], focus: { from: number; to: number } | null, hooks: ContractHooks): Model {
  const len = state.doc.length, out: Range<Decoration>[] = [], hide: Range<Decoration>[] = [];
  for (const h of heads) {
    if (h.help.at > len) continue;
    const locks = h.locks.filter(l => l.to <= len && l.from < l.to);
    for (const l of locks) out.push(Decoration.mark({ class: 'cm-locked', locked: h.key, inclusiveStart: false, inclusiveEnd: false }).range(l.from, l.to));
    if (locks.length) out.push(Decoration.widget({ widget: new LockIcon(), side: -1 }).range(locks[0].from));
    for (const x of h.hints) if (x.at <= len) out.push(Decoration.widget({ widget: new Hint(x.text), side: 1 }).range(x.at));
    out.push(Decoration.widget({ widget: new HelpButton(h.key, h.help.bad, hooks), side: 2 }).range(h.help.at));
  }
  if (focus && focus.to <= len) {
    const first = state.doc.lineAt(focus.from), last = state.doc.lineAt(focus.to);
    if (first.number > 1) hide.push(hidden.range(0, state.doc.line(first.number - 1).to));
    if (last.number < state.doc.lines) hide.push(hidden.range(state.doc.line(last.number + 1).from, len));
  }
  return { deco: Decoration.set(out, true), hide: Decoration.set(hide) };
}

/** The contract extension of one editor. */
export function contractExtension(hooks: ContractHooks): Extension {
  const field = StateField.define<Model>({
    create: () => ({ deco: Decoration.none, hide: Decoration.none }),
    update(m, tr) {
      for (const e of tr.effects) if (e.is(setContract)) return build(tr.state, e.value.heads, e.value.focus, hooks);
      return tr.docChanged ? { deco: m.deco.map(tr.changes), hide: m.hide.map(tr.changes) } : m;
    },
    provide: f => [EditorView.decorations.from(f, m => m.deco), EditorView.decorations.from(f, m => m.hide), EditorView.atomicRanges.of(v => v.state.field(f).hide)],
  });
  const filter = EditorState.changeFilter.of(tr => {
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return true;
    const m = tr.startState.field(field);
    if (touches(tr, guards(tr.startState, m.hide))) return false;
    // the filter drops locked parts from the edit, unless one change covers all the locked parts of a header.
    // (Selecting the whole file or role and pasting over it replaces the header. It does not edit it.) Between two
    // locked parts of one header (a parameter name), the user can type only a name. A comma or parenthesis there would
    // change the count.
    const heads = new Map<unknown, { from: number; to: number; ranges: number[] }>(), gaps: [number, number][] = [];
    m.deco.between(0, tr.startState.doc.length, (from, to, d) => {
      if (!d.spec.locked) return;
      const h = heads.get(d.spec.locked);
      if (h) { gaps.push([h.to, from]); h.to = to; h.ranges.push(from, to); } else heads.set(d.spec.locked, { from, to, ranges: [from, to] });
    });
    let bad = false;
    const whole = new Set<unknown>();
    tr.changes.iterChanges((from, to, _f, _t, inserted) => {
      if (gaps.some(([a, b]) => from >= a && to <= b) && !/^[\p{L}\p{N}_$]*$/u.test(inserted.toString())) bad = true;
      for (const [key, h] of heads) if (from <= h.from && to >= h.to) whole.add(key);
    });
    if (bad) return false;
    const ranges = [...heads].flatMap(([key, h]) => (whole.has(key) ? [] : h.ranges));
    return ranges.length ? ranges : true;
  });
  const undoWatch = EditorView.updateListener.of(u => {
    for (const tr of u.transactions) if ((tr.isUserEvent('undo') || tr.isUserEvent('redo')) && touches(tr, guards(tr.startState, tr.startState.field(field).hide))) { hooks.onHiddenEdit(); return; }
  });
  return [field, filter, undoWatch];
}
