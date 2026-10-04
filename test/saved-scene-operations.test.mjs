import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArStudio } from '../src/studio/studio.js';
import { SavedSceneError } from '../src/studio/saved-scenes.js';

const document = {
  v: 1,
  items: [{ src: '/model.glb', title: 'Model', x: 1, y: 0.2, z: -2, rotX: 0.1, yaw: 0.2, rotZ: -0.3, scale: 1.2, visible: false, group: 'g-group123', action: { id: 'a-action123', type: 'link', label: 'Open', url: 'https://example.com/item' } }],
};
const metadata = { id: 'A'.repeat(22), name: 'Scene', scene_type: 'free', revision: 4, created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:01Z' };
const resource = { ...metadata, scene: structuredClone(document) };

function harness({ client = null, experience = undefined, current = document } = {}) {
  const studio = Object.create(ArStudio.prototype);
  let live = structuredClone(current);
  studio.config = { urlExperience: experience };
  studio._savedScenes = client;
  studio.currentSavedSceneId = null;
  studio.currentSavedSceneName = '';
  studio.currentSavedSceneRevision = null;
  studio.savedSceneBaseline = JSON.stringify(live);
  studio.dirty = false;
  studio.savedSceneBusy = false;
  studio.getSceneDocument = () => structuredClone(live);
  studio.setSceneDocument = async (next) => { live = structuredClone(next); return structuredClone(live); };
  studio.live = () => live;
  return studio;
}
function client(overrides = {}) {
  return {
    list: async () => [], get: async () => structuredClone(resource),
    create: async () => structuredClone(resource), update: async () => structuredClone(resource),
    rename: async () => structuredClone(resource), duplicate: async () => ({ ...structuredClone(resource), id: 'B'.repeat(22), name: 'Copy' }),
    delete: async () => null, ...overrides,
  };
}
function adopt(studio, id = metadata.id, revision = metadata.revision) {
  studio.adoptSavedSceneIdentity({ id, name: metadata.name, revision });
}

function attachSavedSceneUi(studio) {
  const button = () => ({ disabled: false });
  studio.ui = {
    savedSceneTrigger: { hidden: false },
    savedSceneName: { textContent: '' },
    savedSceneState: { textContent: '', dataset: {} },
    savedSceneNew: button(), savedSceneOpen: button(), savedSceneSave: button(), savedSceneSaveAs: button(),
    savedSceneRename: button(), savedSceneDuplicate: button(), savedSceneDelete: button(),
  };
  return studio.ui;
}

for (const experience of ['space', 'marker']) {
  test(`Saved Scene operations are unavailable in ${experience} experience`, async () => {
    const studio = harness({ client: client(), experience });
    await assert.rejects(() => studio.listSavedScenes(), (error) => error.code === 'unavailable');
  });
}

test('disabled transport fails clearly and busy state always resets', async () => {
  const studio = harness();
  await assert.rejects(() => studio.listSavedScenes(), (error) => error instanceof SavedSceneError && error.code === 'unavailable');
  const failing = harness({ client: client({ list: async () => { throw new SavedSceneError('nope', { code: 'network_error' }); } }) });
  await assert.rejects(() => failing.listSavedScenes());
  assert.equal(failing.savedSceneBusy, false);
});

test('list returns metadata without changing editor state', async () => {
  const before = structuredClone(document);
  const studio = harness({ client: client({ list: async () => [metadata] }) });
  adopt(studio); studio.dirty = true; const baseline = studio.savedSceneBaseline;
  assert.deepEqual(await studio.listSavedScenes(), [metadata]);
  assert.deepEqual(studio.live(), before); assert.equal(studio.savedSceneBaseline, baseline); assert.equal(studio.dirty, true);
});

test('first Save creates and adopts identity, revision, and canonical document', async () => {
  let args;
  const studio = harness({ client: client({ create: async (input) => { args = input; return resource; } }) });
  const result = await studio.saveSavedScene({ name: 'Scene' });
  assert.equal(args.name, 'Scene'); assert.deepEqual(args.scene, document); assert.equal(result.id, metadata.id);
  assert.deepEqual(studio.getSavedSceneState(), { id: metadata.id, name: 'Scene', revision: 4, dirty: false, busy: false });
});

test('existing Save updates current id/revision and trusts server revision', async () => {
  let args; const returned = { ...resource, revision: 9 };
  const studio = harness({ client: client({ update: async (...input) => { args = input; return returned; } }) });
  adopt(studio); studio.dirty = true;
  await studio.saveSavedScene();
  assert.equal(args[0], metadata.id); assert.equal(args[1].revision, 4); assert.equal(studio.currentSavedSceneRevision, 9); assert.equal(studio.dirty, false);
});

test('Save As creates a new identity and leaves source untouched', async () => {
  let args; const studio = harness({ client: client({ create: async (input) => { args = input; return { ...resource, id: 'B'.repeat(22), name: 'Copy', revision: 1 }; } }) });
  adopt(studio); studio.dirty = true; await studio.saveSavedSceneAs({ name: 'Copy' });
  assert.equal(args.name, 'Copy'); assert.equal(studio.currentSavedSceneId, 'B'.repeat(22)); assert.equal(studio.currentSavedSceneRevision, 1); assert.equal(studio.dirty, false);
});

test('Open restores document before adopting identity and remains atomic on asset failure', async () => {
  const studio = harness({ client: client({ get: async () => ({ ...resource, id: 'B'.repeat(22), name: 'Opened' }) }) });
  adopt(studio); studio.dirty = true; const oldState = studio.getSavedSceneState();
  const opened = await studio.openSavedScene('B'.repeat(22));
  assert.equal(opened.name, 'Opened'); assert.equal(studio.currentSavedSceneId, 'B'.repeat(22)); assert.equal(studio.dirty, false);

  const failing = harness({ client: client({ get: async () => ({ ...resource, id: 'B'.repeat(22) }) }) });
  adopt(failing); failing.dirty = true; const before = failing.live(); const state = failing.getSavedSceneState();
  failing.setSceneDocument = async () => { throw new Error('asset preload failed'); };
  await assert.rejects(() => failing.openSavedScene('B'.repeat(22)));
  assert.deepEqual(failing.live(), before); assert.deepEqual(failing.getSavedSceneState(), state);
  assert.equal(oldState.id, metadata.id);
});

test('Rename updates metadata while preserving baseline and dirty state', async () => {
  const studio = harness({ client: client({ rename: async (id, input) => ({ ...resource, name: input.name, revision: 8 }) }) });
  adopt(studio); const baseline = studio.savedSceneBaseline; await studio.renameSavedScene('Renamed');
  assert.equal(studio.currentSavedSceneName, 'Renamed'); assert.equal(studio.currentSavedSceneRevision, 8); assert.equal(studio.savedSceneBaseline, baseline); assert.equal(studio.dirty, false);
  studio.dirty = true; await studio.renameSavedScene('Again'); assert.equal(studio.dirty, true); assert.equal(studio.savedSceneBaseline, baseline);
});

test('Duplicate defaults to non-adopting behavior', async () => {
  let args; const studio = harness({ client: client({ duplicate: async (...input) => { args = input; return { ...resource, id: 'B'.repeat(22) }; } }) });
  adopt(studio); studio.dirty = true; const before = studio.getSavedSceneState();
  const result = await studio.duplicateSavedScene({ name: 'Copy' });
  assert.equal(args[0], metadata.id); assert.equal(args[1].name, 'Copy'); assert.equal(result.id, 'B'.repeat(22)); assert.deepEqual(studio.getSavedSceneState(), before);
});

test('current delete detaches identity but retains content and marks draft dirty', async () => {
  const studio = harness({ client: client({ delete: async (id, input) => { assert.equal(id, metadata.id); assert.equal(input.revision, 4); } }) });
  adopt(studio); await studio.deleteSavedScene();
  assert.deepEqual(studio.live(), document); assert.equal(studio.currentSavedSceneId, null); assert.equal(studio.currentSavedSceneRevision, null); assert.equal(studio.dirty, true);
});

test('non-current delete and conflicts do not mutate current state', async () => {
  let deleted; const studio = harness({ client: client({ delete: async (...input) => { deleted = input; } }) });
  adopt(studio); studio.dirty = true; const before = studio.getSavedSceneState(); await studio.deleteSavedScene('B'.repeat(22), { revision: 2 });
  assert.equal(deleted[0], 'B'.repeat(22)); assert.deepEqual(studio.getSavedSceneState(), before);
  const conflict = new SavedSceneError('changed', { code: 'conflict', currentRevision: 5 });
  const conflicted = harness({ client: client({ update: async () => { throw conflict; } }) }); adopt(conflicted); conflicted.dirty = true;
  const state = conflicted.getSavedSceneState(); await assert.rejects(() => conflicted.saveSavedScene(), (error) => error.currentRevision === 5); assert.deepEqual(conflicted.getSavedSceneState(), state);
});

test('overlapping mutations are rejected and busy resets after abort/failure', async () => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const studio = harness({ client: client({ list: async () => pending }) });
  const first = studio.listSavedScenes(); await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(() => studio.listSavedScenes(), (error) => error.code === 'busy'); release([]); await first; assert.equal(studio.savedSceneBusy, false);
});

test('direct programmatic Open synchronizes busy lifecycle and final fetched identity to the header', async () => {
  const sceneKey = 'B'.repeat(22);
  const fetched = { ...resource, id: sceneKey, name: 'Paint-2', revision: 12 };
  const studio = harness({ client: client({ get: async () => structuredClone(fetched) }) });
  const ui = attachSavedSceneUi(studio);
  const syncBusyStates = [];
  studio._syncSavedSceneUi = function syncSavedSceneUi() {
    syncBusyStates.push(this.savedSceneBusy);
    return ArStudio.prototype._syncSavedSceneUi.call(this);
  };

  await studio.openSavedScene(sceneKey, { preserveLocalRecovery: true });

  assert.deepEqual(studio.getSavedSceneState(), {
    id: sceneKey,
    name: fetched.name,
    revision: fetched.revision,
    dirty: false,
    busy: false,
  });
  assert.deepEqual(syncBusyStates, [true, false]);
  assert.equal(ui.savedSceneName.textContent, 'Paint-2');
  assert.equal(ui.savedSceneState.textContent, '');
  assert.equal(ui.savedSceneSave.disabled, false);
  assert.equal(ui.savedSceneRename.disabled, false);
});

test('operation failure and abort both clear busy and perform the final UI synchronization', async () => {
  for (const error of [
    new SavedSceneError('failed', { code: 'network_error' }),
    new SavedSceneError('aborted', { code: 'aborted' }),
  ]) {
    const studio = harness({ client: client({ get: async () => { throw error; } }) });
    const ui = attachSavedSceneUi(studio);
    const syncBusyStates = [];
    studio._syncSavedSceneUi = function syncSavedSceneUi() {
      syncBusyStates.push(this.savedSceneBusy);
      return ArStudio.prototype._syncSavedSceneUi.call(this);
    };

    await assert.rejects(() => studio.openSavedScene('B'.repeat(22), {
      preserveLocalRecovery: true,
    }), (caught) => caught === error);

    assert.equal(studio.getSavedSceneState().busy, false);
    assert.deepEqual(syncBusyStates, [true, false]);
    assert.equal(ui.savedSceneState.textContent, '');
    assert.equal(ui.savedSceneSave.disabled, false);
  }
});

test('programmatic Open followed by the built-in Save path updates the same scene and never creates', async () => {
  const sceneKey = 'B'.repeat(22);
  const fetched = { ...resource, id: sceneKey, name: 'Paint-2', revision: 12 };
  let creates = 0;
  const updates = [];
  const studio = harness({
    client: client({
      get: async () => structuredClone(fetched),
      create: async () => { creates += 1; return structuredClone(resource); },
      update: async (id, input) => {
        updates.push({ id, input: structuredClone(input) });
        return { ...structuredClone(fetched), revision: 13 };
      },
    }),
  });
  attachSavedSceneUi(studio);
  studio._handleSavedSceneUiError = (error) => { throw error; };

  await studio.openSavedScene(sceneKey, { preserveLocalRecovery: true });
  await studio._saveSavedSceneFromUi();

  assert.equal(creates, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, sceneKey);
  assert.equal(updates[0].input.revision, 12);
  assert.deepEqual(studio.getSavedSceneState(), {
    id: sceneKey,
    name: 'Paint-2',
    revision: 13,
    dirty: false,
    busy: false,
  });
});

test('built-in first Save retains Untitled/null new-scene semantics and creates exactly once', async () => {
  let creates = 0;
  let updates = 0;
  const created = { ...resource, id: 'N'.repeat(22), name: 'Fresh Scene', revision: 1 };
  const studio = harness({
    client: client({
      create: async (input) => {
        creates += 1;
        assert.equal(input.name, 'Fresh Scene');
        return structuredClone(created);
      },
      update: async () => { updates += 1; return structuredClone(created); },
    }),
  });
  const ui = attachSavedSceneUi(studio);
  studio._showSavedSceneNameDialog = async () => 'Fresh Scene';
  studio._handleSavedSceneUiError = (error) => { throw error; };
  studio._syncSavedSceneUi();

  assert.deepEqual(studio.getSavedSceneState(), {
    id: null, name: '', revision: null, dirty: false, busy: false,
  });
  assert.equal(ui.savedSceneName.textContent, 'Untitled');

  await studio._saveSavedSceneFromUi();

  assert.equal(creates, 1);
  assert.equal(updates, 0);
  assert.equal(studio.currentSavedSceneId, created.id);
  assert.equal(studio.savedSceneBusy, false);
  assert.equal(ui.savedSceneName.textContent, 'Fresh Scene');
  assert.equal(ui.savedSceneState.textContent, '');
});
