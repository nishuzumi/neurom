// core/local-save.js — the local save of the workbench (graph_app.js). localStorage has a quota of a few MB, and one
// artifact of a large network is several hundred KB. So the artifacts go into IndexedDB by their content id. The
// localStorage text names the artifacts that the store has (`artifactIds`), and it holds the others itself
// (`artifacts`), so a save never names an artifact that is not stored. An artifact never changes, so every tab shares
// the store, and nothing deletes from it. A `neurom-workbench` file holds all of its artifacts itself. A save without
// `artifactIds` (from before this store) opens as it is.
import { RestoreError, WORKSPACE_FORMAT } from './store.js';
import { t } from '../i18n.js';

/** In-memory artifact store, for node tests. The app does not use it: it keeps nothing across a reload. */
export function createMemoryArtifactStore() {
  const map = new Map();
  return {
    async put(artifact) { map.set(artifact.id, artifact); },
    async get(id) { return map.get(id) ?? null; },
  };
}

/** The IndexedDB store of the app (database `neurom-artifacts`, object store `artifacts`, key = artifact id), or null
 *  when the browser has no IndexedDB. Without a store, the local save holds all of its artifacts itself. */
export function createArtifactStore({ indexedDB = globalThis.indexedDB, name = 'neurom-artifacts' } = {}) {
  if (!indexedDB) return null;
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('artifacts')) req.result.createObjectStore('artifacts', { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const req = fn(db.transaction('artifacts', mode).objectStore('artifacts'));
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  };
  return {
    async put(artifact) { await tx('readwrite', s => s.put({ id: artifact.id, artifact })); },
    async get(id) { return (await tx('readonly', s => s.get(id)))?.artifact ?? null; },
  };
}

/** The localStorage text of `json` (Workspace.toJSON()): the artifacts in `stored` (ids that the store has) by their id,
 *  the others in the text. */
export function localText(json, stored) {
  const named = json.artifacts.filter(a => stored.has(a.id)).map(a => a.id);
  return JSON.stringify(named.length ? { ...json, artifacts: json.artifacts.filter(a => !stored.has(a.id)), artifactIds: named } : json);
}

/** The artifact ids that the local save `text` names ([] for a save that holds all of its artifacts, or for no save). */
export function savedIds(text) {
  try { const ids = JSON.parse(text ?? 'null')?.artifactIds; return Array.isArray(ids) ? ids : []; } catch { return []; }
}

/**
 * The `neurom-workbench` text of the local save `text`, with the named artifacts from `store` back in their place. Text
 * that is not JSON, or a save without `artifactIds`, comes back as it is (Workspace.parse words its errors). A named
 * artifact that the store does not have (or no store) throws a RestoreError.
 */
export async function openLocal(text, store) {
  let json; try { json = JSON.parse(text); } catch { return text; }
  if (!json || typeof json !== 'object' || !Array.isArray(json.artifactIds)) return text;
  const { artifactIds, ...rest } = json, artifacts = Array.isArray(rest.artifacts) ? [...rest.artifacts] : [];
  for (const [i, id] of artifactIds.entries()) {
    const artifact = store ? await store.get(id) : null;
    if (!artifact) throw new RestoreError({ format: json.format === WORKSPACE_FORMAT ? json.format : null, path: `artifactIds[${i}]`, message: t('本地存档用的产物 {id} 不在浏览器的产物库里', { id }) });
    artifacts.push(artifact);
  }
  return JSON.stringify({ ...rest, artifacts });
}
