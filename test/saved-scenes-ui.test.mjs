import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArStudio } from '../src/studio/studio.js';

function button() { return { disabled: false }; }
function harness(state) {
  const studio = Object.create(ArStudio.prototype);
  studio.ui = {
    savedSceneBar: {}, savedSceneName: { textContent: '' }, savedSceneState: { textContent: '', dataset: {} },
    savedSceneNew: button(), savedSceneOpen: button(), savedSceneSave: button(), savedSceneSaveAs: button(),
    savedSceneRename: button(), savedSceneDuplicate: button(), savedSceneDelete: button(),
  };
  studio.getSavedSceneState = () => ({ ...state });
  return studio;
}

test('Saved Scene UI source provides editor-only controls and accessible dialogs', async () => {
  const source = await readFile(new URL('../src/studio/ui.js', import.meta.url), 'utf8');
  assert.match(source, /savedSceneBar/);
  assert.match(source, /savedSceneNew/);
  assert.match(source, /savedScenePanel/);
  assert.match(source, /role: 'dialog'/);
  assert.match(source, /hidden: !savedSceneEnabled/);
  assert.match(source, /savedScenePanelList/);
});

test('status indicator reflects untitled, saved, dirty, and busy states', () => {
  const studio = harness({ id: null, name: '', dirty: false, busy: false });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneName.textContent, 'Untitled Scene');
  assert.equal(studio.ui.savedSceneState.textContent, 'Unsaved');

  studio.getSavedSceneState = () => ({ id: 'A', name: 'Lobby', dirty: false, busy: false });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneState.textContent, 'Saved');
  assert.equal(studio.ui.savedSceneRename.disabled, false);

  studio.getSavedSceneState = () => ({ id: 'A', name: 'Lobby', dirty: true, busy: false });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneState.textContent, 'Unsaved Changes');
  assert.equal(studio.ui.savedSceneState.dataset.dirty, 'true');

  studio.getSavedSceneState = () => ({ id: 'A', name: 'Lobby', dirty: true, busy: true });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneState.textContent, 'Working…');
  assert.equal(studio.ui.savedSceneSave.disabled, true);
  assert.equal(studio.ui.savedSceneDelete.disabled, true);
});

test('error messages never expose raw transport details', () => {
  const studio = Object.create(ArStudio.prototype);
  assert.equal(studio._savedSceneErrorMessage({ code: 'network_error', message: 'SQL password' }), 'Could not reach the Saved Scenes service.');
  assert.equal(studio._savedSceneErrorMessage({ code: 'unavailable', message: '/secret/path' }), 'Saved Scenes are unavailable.');
  assert.equal(studio._savedSceneErrorMessage({ code: 'not_found' }), 'This Saved Scene no longer exists.');
  assert.equal(studio._savedSceneErrorMessage({ code: 'aborted' }), '');
});
