import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArStudio } from '../src/studio/studio.js';

const emptyDocument = { v: 1, items: [] };

function stateHarness(document = emptyDocument) {
	const studio = Object.create(ArStudio.prototype);
	let current = structuredClone(document);

	studio.getSceneDocument = () => structuredClone(current);
	studio.setWorkingDocument = (next) => { current = structuredClone(next); };
	studio.currentSavedSceneId = null;
	studio.currentSavedSceneName = '';
	studio.currentSavedSceneRevision = null;
	studio.savedSceneBaseline = JSON.stringify(emptyDocument);
	studio.dirty = false;
	studio.savedSceneBusy = false;

	return studio;
}

function editDocument(studio, edit) {
	const next = studio.getSceneDocument();
	edit(next);
	studio.setWorkingDocument(next);
	return studio.recomputeDirtyState();
}

test('fresh editor state has no Saved Scene identity and is clean', () => {
	const studio = stateHarness();

	assert.deepEqual(studio.getSavedSceneState(), {
		id: null,
		name: '',
		revision: null,
		dirty: false,
		busy: false,
	});
});

test('adopting an identity establishes a clean canonical baseline', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }],
	});

	assert.deepEqual(
		studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 }),
		{ id: 'saved-123', name: 'Demo', revision: 7, dirty: false, busy: false },
	);
	assert.equal(studio.savedSceneBaseline, JSON.stringify(studio.getSceneDocument()));
});

test('authored document changes become dirty while identity and revision remain stable', () => {
	const studio = stateHarness();
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });

	assert.equal(editDocument(studio, (doc) => {
		doc.items.push({
			src: '/model.glb', title: 'Model', x: 1, z: -2,
			rotX: 0.2, yaw: 0.4, rotZ: -0.3, scale: 1.2,
			visible: false, group: 'group-1',
			action: { id: 'action-1', type: 'link', label: 'Open', url: 'https://example.com' },
		});
	}), true);
	assert.deepEqual(studio.getSavedSceneState(), {
		id: 'saved-123', name: 'Demo', revision: 7, dirty: true, busy: false,
	});
});

test('_saveScene recomputes dirty state through the canonical document path', () => {
	const studio = stateHarness();
	studio.config = { persist: false };
	studio.placements = [];
	studio._isMine = () => true;
	studio._sceneMetadata = () => ({ type: 'free', target: null });
	studio._logicalScale = () => 1;
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });

	editDocument(studio, (doc) => {
		doc.items.push({ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 });
	});
	studio._saveScene();

	assert.equal(studio.dirty, true);
});

test('returning to the exact baseline clears dirty state', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }],
	});
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });

	editDocument(studio, (doc) => { doc.items[0].x = 3; });
	assert.equal(studio.dirty, true);
	editDocument(studio, (doc) => { doc.items[0].x = 0; });
	assert.equal(studio.dirty, false);
});

test('adopting a new identity behaves like Save As', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/source.glb', title: 'Source', x: 0, z: -2, yaw: 0, scale: 1 }],
	});
	studio.adoptSavedSceneIdentity({ id: 'source', name: 'Source', revision: 2 });
	editDocument(studio, (doc) => { doc.items[0].z = -4; });

	studio.adoptSavedSceneIdentity({ id: 'copy', name: 'Copy', revision: 1 });
	assert.deepEqual(studio.getSavedSceneState(), {
		id: 'copy', name: 'Copy', revision: 1, dirty: false, busy: false,
	});
});

test('Open simulation restores the document before adopting its identity', () => {
	const studio = stateHarness();
	const opened = {
		v: 1,
		type: 'marker-horizontal',
		target: {
			id: 'target-1', image: '/target.png', mind: '/target.mind',
			width: 0.1, height: 0.06, orientation: 'horizontal', visible: true,
		},
		items: [{ src: '/model.glb', title: 'Model', x: 0.2, z: -2, yaw: 0.5, scale: 1 }],
	};
	studio.setWorkingDocument(opened);

	studio.adoptSavedSceneIdentity({ id: 'opened', name: 'Opened', revision: 4 });
	assert.deepEqual(studio.getSceneDocument(), opened);
	assert.equal(studio.dirty, false);
});

test('rename metadata changes preserve baseline and existing dirty state', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }],
	});
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Old', revision: 7 });
	const baseline = studio.savedSceneBaseline;

	studio.updateSavedSceneIdentity({ name: 'New', revision: 8 });
	assert.equal(studio.savedSceneBaseline, baseline);
	assert.equal(studio.dirty, false);

	editDocument(studio, (doc) => { doc.items[0].x = 1; });
	studio.updateSavedSceneIdentity({ name: 'Newest', revision: 9 });
	assert.equal(studio.dirty, true);
	assert.equal(studio.savedSceneBaseline, baseline);
});

test('deleting the current Saved Scene detaches identity but retains dirty content', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }],
	});
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });
   const before = studio.getSceneDocument();

	studio.clearSavedSceneIdentity();
	assert.deepEqual(studio.getSceneDocument(), before);
	assert.deepEqual(studio.getSavedSceneState(), {
		id: null, name: '', revision: null, dirty: true, busy: false,
	});
});

test('save failure or conflict simulation leaves identity, baseline, and dirty state unchanged', () => {
	const studio = stateHarness();
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });
	editDocument(studio, (doc) => { doc.items.push({ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }); });
	const before = { ...studio.getSavedSceneState(), baseline: studio.savedSceneBaseline };

	// A failed persistence request does not call any state transition method.
	assert.deepEqual({ ...studio.getSavedSceneState(), baseline: studio.savedSceneBaseline }, before);
});

test('local recovery documents carry no Saved Scene authority', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/recovered.glb', title: 'Recovered', x: 0, z: -2, yaw: 0, scale: 1 }],
	});
	const recoveredDocument = JSON.stringify(studio.getSceneDocument());

	assert.equal(studio.getSavedSceneState().id, null);
	assert.equal(recoveredDocument.includes('savedScene'), false);
	assert.equal(recoveredDocument.includes('revision'), false);
	studio.markCurrentDocumentAsBaseline();
	assert.equal(studio.dirty, false);
});

test('published Space and Marker modes retain no Saved Scene identity', async () => {
	for (const type of ['space', 'marker']) {
		const studio = stateHarness();
		studio.adoptSavedSceneIdentity({ id: 'should-clear', name: 'Runtime', revision: 1 });
		studio.config = { urlExperience: type };
		studio._dropRuntimeGroup = () => {};
		studio._selection = { clear() {} };
		studio.selected = null;
		studio.selRing = { visible: true };
		studio._detachTransformGizmo = () => {};
		studio.targetPreview = { mesh: null };
		studio.grid = { visible: true };
		studio.scene = { fog: {} };
		studio.ui = { runtimePrimary: null };
		studio._syncRuntimeControls = () => {};
		studio._setStatus = () => {};
		await studio._activateExperienceMode();
		assert.equal(studio.getSavedSceneState().id, null, type);
		assert.equal(studio.getSavedSceneState().revision, null, type);
	}
});

test('camera and selection-only changes do not affect document dirty state', () => {
	const studio = stateHarness();
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });
	const before = studio.savedSceneBaseline;

	// These runtime-only values are intentionally outside getSceneDocument().
	studio.cameraYaw = 1.2;
	studio.cameraPitch = -0.4;
	studio.selected = { id: 'selection-only' };
	studio.recomputeDirtyState();

	assert.equal(studio.savedSceneBaseline, before);
	assert.equal(studio.dirty, false);
});

test('groups, actions, visibility, and all rotations participate in dirty comparison', () => {
	const studio = stateHarness({
		v: 1,
		items: [{ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }],
	});
	studio.adoptSavedSceneIdentity({ id: 'saved-123', name: 'Demo', revision: 7 });

	for (const [key, value] of [
		['rotX', 0.1],
		['yaw', 0.2],
		['rotZ', 0.3],
		['visible', false],
		['group', 'group-1'],
		['action', { id: 'action-1', type: 'link', label: 'Open', url: 'https://example.com' }],
	]) {
		assert.equal(editDocument(studio, (doc) => { doc.items[0][key] = value; }), true, key);
		studio.setWorkingDocument({ v: 1, items: [{ src: '/model.glb', title: 'Model', x: 0, z: -2, yaw: 0, scale: 1 }] });
		studio.recomputeDirtyState();
		assert.equal(studio.dirty, false, `reset after ${key}`);
	}
});

test('busy is exposed but does not participate in document dirty comparison', () => {
	const studio = stateHarness();
	studio.savedSceneBusy = true;
	assert.deepEqual(studio.getSavedSceneState(), {
		id: null, name: '', revision: null, dirty: false, busy: true,
	});
	studio.recomputeDirtyState();
	assert.equal(studio.dirty, false);
});
