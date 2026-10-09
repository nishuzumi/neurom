<script setup lang="ts">
// ScriptEditor.vue — the editor of a view script (ADR 0013): plain JavaScript on CodeMirror. It has none of the IR
// machinery of the code module (no types, roles, locks or hovers), because the script is not a code module. Text goes
// through the buffer of the body (`input` per change, `flush` on blur). A buffer change from elsewhere (undo, a
// template) replaces the document and does not enter the own history of the editor.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { bufferBinding, editorTheme } from './code-editor';
import type { Buffered } from './common';
import './bodies-a.css';

const props = defineProps<{ buffer: Buffered; label: string }>();
const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const binding = bufferBinding(props.buffer, props.label, () => view);
const theme = editorTheme();

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.buffer.text.value,
      extensions: [...binding, theme, keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab])],
    }),
  });
});
onBeforeUnmount(() => { view?.destroy(); view = null; });
</script>

<template>
  <div ref="host" class="code-edit nowheel"></div>
</template>
