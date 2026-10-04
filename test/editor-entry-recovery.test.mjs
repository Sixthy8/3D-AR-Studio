import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArStudio } from '../src/studio/studio.js';
import { DEFAULTS } from '../src/config.js';

const document = { v: 1, items: [] };

function saveHarness({ suppressed }) {
  const studio = Object.create(ArStudio.prototype);
  studio.config = { persist: true, persistKey: 'recovery-test' };
  studio._localRecoveryWriteSuppressed = suppressed;
  studio.placements = [];
  studio._isMine = () => true;
  studio._sceneMetadata = () => ({ type: 'free', target: null });
  studio.savedSceneBaseline = JSON.stringify(document);
  studio._syncSavedSceneUi = () => {};
  return studio;
}

test('local recovery suppression is opt-in and readiness exposes the boot promise', async () => {
  assert.equal(DEFAULTS.skipLocalRecovery, false);
  const expected = Promise.resolve();
  const studio = Object.create(ArStudio.prototype);
  studio._bootPromise = expected;
  assert.equal(studio.whenReady(), expected);
  await studio.whenReady();
});

test('suppressed persistence recomputes state without replacing local recovery', () => {
  const original = globalThis.localStorage;
  let writes = 0;
  globalThis.localStorage = { setItem() { writes += 1; } };
  try {
    const suppressed = saveHarness({ suppressed: true });
    suppressed._saveScene();
    assert.equal(writes, 0);
    assert.equal(suppressed.dirty, false);

    const normal = saveHarness({ suppressed: false });
    normal._saveScene();
    assert.equal(writes, 1);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('recovery-preserving Saved Scene open suppresses document installation only and adopts clean identity', async () => {
  const sceneKey = 'S'.repeat(22);
  const studio = Object.create(ArStudio.prototype);
  studio.config = {};
  studio._localRecoveryWriteSuppressed = false;
  studio._savedScenes = {
    async get() {
      return { id: sceneKey, name: 'Paint-2', revision: 8, scene: document };
    },
  };
  studio.currentSavedSceneId = null;
  studio.currentSavedSceneName = '';
  studio.currentSavedSceneRevision = null;
  studio.savedSceneBaseline = '';
  studio.dirty = true;
  studio.savedSceneBusy = false;
  studio.getSceneDocument = () => structuredClone(document);
  let suppressedDuringInstall = false;
  studio.setSceneDocument = async (next) => {
    suppressedDuringInstall = studio._localRecoveryWriteSuppressed;
    return structuredClone(next);
  };

  await studio.openSavedScene(sceneKey, { preserveLocalRecovery: true });

  assert.equal(suppressedDuringInstall, true);
  assert.equal(studio._localRecoveryWriteSuppressed, false);
  assert.deepEqual(studio.getSavedSceneState(), {
    id: sceneKey,
    name: 'Paint-2',
    revision: 8,
    dirty: false,
    busy: false,
  });
  assert.equal(studio.savedSceneBaseline, JSON.stringify(document));
});
