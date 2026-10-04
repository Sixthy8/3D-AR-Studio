import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ArStudio } from '../src/studio/studio.js';

function button() { return { disabled: false, focus() {} }; }
function harness(state) {
  const studio = Object.create(ArStudio.prototype);
  studio.ui = {
    savedSceneTrigger: { hidden: false, setAttribute() {}, focus() {} }, savedSceneMenu: { hidden: true, contains() { return false; } }, savedSceneName: { textContent: '' }, savedSceneState: { textContent: '', dataset: {} },
    savedSceneNew: button(), savedSceneOpen: button(), savedSceneSave: button(), savedSceneSaveAs: button(),
    savedSceneRename: button(), savedSceneDuplicate: button(), savedSceneDelete: button(),
  };
  studio.getSavedSceneState = () => ({ ...state });
  return studio;
}

test('Saved Scene UI source provides an editor-only header menu and accessible dialogs', async () => {
  const source = await readFile(new URL('../src/studio/ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /savedSceneBar/);
  assert.match(source, /savedSceneTrigger/);
  assert.match(source, /aria-haspopup.*menu/);
  assert.match(source, /savedSceneNew/);
  assert.match(source, /savedScenePanel/);
  assert.match(source, /role: 'dialog'/);
  assert.match(source, /savedSceneMenu/);
  assert.match(source, /savedScenePanelList/);
});

test('header menu is editor-only, anchored, and exposes the existing actions', async () => {
  const source = await readFile(new URL('../src/studio/ui.js', import.meta.url), 'utf8');
  assert.match(source, /savedSceneEnabled = !experienceMode/);
  assert.match(source, /savedSceneControl/);
  assert.match(source, /role: 'menu'/);
  for (const action of ['New', 'Open', 'Save', 'Save As', 'Rename', 'Duplicate', 'Delete']) {
    assert.match(source, new RegExp("text: '" + action.replace(' ', '\\s+') + "'"));
  }
  assert.match(source, /savedSceneTrigger\.append|savedSceneControl\.append/);
});

test('popover interaction has one scoped outside listener and Escape close path', async () => {
  const source = await readFile(new URL('../src/studio/studio.js', import.meta.url), 'utf8');
  assert.match(source, /savedSceneTrigger.*_toggleSavedSceneMenu/);
  assert.match(source, /savedSceneMenu.*hidden.*_closeSavedSceneMenu/);
  assert.match(source, /u\.root, 'pointerdown'/);
  assert.match(source, /!u\.savedSceneTrigger\.contains\(e\.target\).*!u\.savedSceneMenu\.contains\(e\.target\)/);
  assert.match(source, /aria-expanded.*true/);
  assert.match(source, /savedSceneNew\.focus/);
  assert.match(source, /savedSceneTrigger\.focus/);
});

test('status indicator reflects untitled, saved, dirty, and busy states', () => {
  const studio = harness({ id: null, name: '', dirty: false, busy: false });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneName.textContent, 'Untitled');
  assert.equal(studio.ui.savedSceneState.textContent, '');

  studio.getSavedSceneState = () => ({ id: 'A', name: 'Lobby', dirty: false, busy: false });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneState.textContent, '');
  assert.equal(studio.ui.savedSceneRename.disabled, false);
  assert.equal(studio.ui.savedSceneDuplicate.disabled, false);
  assert.equal(studio.ui.savedSceneDelete.disabled, false);

  studio.getSavedSceneState = () => ({ id: 'A', name: 'Lobby', dirty: true, busy: false });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneState.textContent, '• Unsaved');
  assert.equal(studio.ui.savedSceneState.dataset.dirty, 'true');

  studio.getSavedSceneState = () => ({ id: 'A', name: 'Lobby', dirty: true, busy: true });
  studio._syncSavedSceneUi();
  assert.equal(studio.ui.savedSceneState.textContent, '• Working…');
  assert.equal(studio.ui.savedSceneSave.disabled, true);
  assert.equal(studio.ui.savedSceneDelete.disabled, true);
  assert.equal(studio.ui.savedSceneSave.disabled, true);
});

test('error messages never expose raw transport details', () => {
  const studio = Object.create(ArStudio.prototype);
  assert.equal(studio._savedSceneErrorMessage({ code: 'network_error', message: 'SQL password' }), 'Could not reach the Saved Scenes service.');
  assert.equal(studio._savedSceneErrorMessage({ code: 'unavailable', message: '/secret/path' }), 'Saved Scenes are unavailable.');
  assert.equal(studio._savedSceneErrorMessage({ code: 'not_found' }), 'This Saved Scene no longer exists.');
  assert.equal(studio._savedSceneErrorMessage({ code: 'aborted' }), '');
});
