// training/client.js — UI-thread handle on a training worker. The bundled single-file pages inject the IIFE of the
// worker as globalThis.__NEUROM_WORKER_SOURCE__ (frontend/build.mjs). Unbundled module pages load ./worker.js directly.
import { trainingProblem } from './train.js';
import { t, locale } from '../i18n.js';

const WORKER_SOURCE_GLOBAL = '__NEUROM_WORKER_SOURCE__';

function createTrainingWorker() {
  const source = globalThis[WORKER_SOURCE_GLOBAL];
  if (typeof source === 'string' && source.length) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return { worker: new Worker(url), release: () => URL.revokeObjectURL(url) }; }
    catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  return { worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), release: () => {} };
}

/**
 * Start training `bundle` (a `neurom-bundle` trainer snapshot) off the UI thread. `tables` maps dataset id →
 * `{ column: number[] }`. Returns {promise, cancel, runId}. The promise resolves {model, evaluation, provenance}.
 * cancel terminates the worker and rejects with AbortError. Worker failures reject with name 'TrainingError'.
 */
export function startBrowserTraining(bundle, { onProgress = () => {}, tables = {} } = {}) {
  const problem = trainingProblem(bundle);
  if (problem) throw new Error(problem);
  const runId = crypto.randomUUID();
  const { worker, release } = createTrainingWorker();
  let finish = null;                                                          // (resolveOrReject, value) → settles once, tears the worker down
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    finish = (fn, value) => { if (!finish) return; finish = null; worker.terminate(); release(); fn(value); };
    cancel = () => finish?.(reject, new DOMException(t('训练已取消'), 'AbortError'));
    worker.onmessage = ({ data }) => {
      if (!data || data.runId !== runId || !finish) return;
      if (data.type === 'progress') {
        try { onProgress(data.progress); } catch (error) { finish?.(reject, error); }
      }
      else if (data.type === 'complete') finish(resolve, data.result);
      else if (data.type === 'error') { const error = new Error(data.error); error.name = 'TrainingError'; finish(reject, error); }
    };
    worker.onerror = event => { event.preventDefault?.(); finish?.(reject, new Error(t('训练线程崩溃：{error}', { error: event.message ?? t('未知错误') }))); };
    try { worker.postMessage({ type: 'start', runId, bundle, tables, locale: locale() }); }
    catch (error) { finish(reject, error); }
  });
  return { promise, cancel: () => cancel(), runId };
}
