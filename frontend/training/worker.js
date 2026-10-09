// training/worker.js — the only place where a browser trains. It receives {type:'start', runId, bundle, tables, locale},
// streams bounded progress, and answers with exactly one complete or error event. To cancel, the client terminates
// this worker. The worker has its own copy of the i18n module (default zh). So the client sends the UI locale, and
// errors come back in the UI language.
import { trainBundle } from './train.js';
import { LOCALES, setLocale } from '../i18n.js';

self.onmessage = async ({ data }) => {
  if (data?.type !== 'start') return;
  const { runId, bundle, tables, locale } = data;
  if (LOCALES.includes(locale)) setLocale(locale);
  try {
    const result = await trainBundle(bundle, { onProgress: progress => self.postMessage({ type: 'progress', runId, progress }), tables });
    self.postMessage({ type: 'complete', runId, result });
  } catch (error) {
    self.postMessage({ type: 'error', runId, error: error?.message ?? String(error), name: error?.name ?? 'Error' });
  }
};
