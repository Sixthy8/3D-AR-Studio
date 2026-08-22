// What decides whether AR Quick Look stands a model on someone's floor.
//
// Three rules, and every one of them is invisible on a laptop because the
// symptom only exists inside ARKit: a model that opens fine, tracks fine, and
// hangs in mid-air or swims around the room instead of resting on the ground.
//
//   1. The root's own transform is NOT exported. `USDZExporter` walks
//      `scene.children` and writes each node's LOCAL matrix, so a scale set on
//      the object handed to it is silently dropped. Everything this package
//      needs to place a model therefore has to live on a child.
//   2. The content has to be moved onto the floor. Quick Look anchors the
//      scene ORIGIN to the plane it detects and never looks at the geometry, so
//      a GLB authored around a distant origin arrives floating. No anchoring
//      flag fixes that; only moving the model does.
//   3. USDZ is metres. A model authored in centimetres arrives a hundred times
//      too big, too large for any plane ARKit found indoors, and reads as a
//      broken anchor rather than a wrong size.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

import {
	fitToRoomScale, groundOnFloor, sceneToUsdzBlob, usdzExportRoot,
} from '../src/studio/usdz.js';

/** A box of the given size, sitting with its own centre at `at`. */
function boxAt(size, at = [0, 0, 0]) {
	const mesh = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial());
	mesh.position.set(...at);
	return mesh;
}

function boundsOf(object) {
	object.updateMatrixWorld(true);
	return new Box3().setFromObject(object);
}

async function usda(scene, options) {
	const blob = await sceneToUsdzBlob(scene, options);
	const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
	return new TextDecoder().decode(files['model.usda']);
}

/** The four rows of a named Xform's transform in a model.usda. */
function transformOf(text, name) {
	const node = text.slice(text.indexOf(`def Xform "${name}"`));
	const row = /matrix4d xformOp:transform = \( \(([^)]*)\), \(([^)]*)\), \(([^)]*)\), \(([^)]*)\) \)/.exec(node);
	assert.ok(row, `${name} has no transform`);
	const num = (i) => row[i].split(',').map((n) => Number(n.trim()));
	const [sx] = num(1);
	const [x, y, z] = num(4);
	return { scaleX: sx, x, y, z };
}

test('usdzExportRoot keeps the source transform, which the exporter drops off a root', async () => {
	// A studio placement carries its size on the group the caller hands over.
	const placement = new Group();
	placement.scale.setScalar(2);
	placement.add(boxAt([1, 1, 1], [0, 0.5, 0]));

	const { root, stage } = usdzExportRoot(placement);
	assert.equal(stage.children[0], placement, 'the source hangs under the stage');
	assert.equal(root.children[0], stage, 'and the stage under an identity root');
	// The scale is now on a CHILD of the exported root, so it survives.
	assert.ok(Math.abs(boundsOf(root).max.y - 2) < 1e-6, 'a 2x placement measures 2m tall');
});

test('a model authored away from the origin is stood on the floor and centred', () => {
	// Geometry 10m up and 4m sideways: the shape a Quick Look user sees hanging
	// at eye level across the room, never touching anything.
	const { root, stage } = usdzExportRoot(boxAt([1, 2, 1], [4, 10, -3]));
	assert.equal(groundOnFloor(stage, root), true);

	const box = boundsOf(root);
	assert.ok(Math.abs(box.min.y) < 1e-6, `feet on y=0, got ${box.min.y}`);
	const centre = box.getCenter(new Vector3());
	assert.ok(Math.abs(centre.x) < 1e-6 && Math.abs(centre.z) < 1e-6, 'footprint over the origin');
	assert.ok(Math.abs(box.max.y - 2) < 1e-6, 'and it is still 2m tall');
});

test('grounding an empty scene reports it instead of writing NaN transforms', () => {
	const { root, stage } = usdzExportRoot(new Group());
	assert.equal(groundOnFloor(stage, root), false);
	assert.deepEqual(stage.position.toArray(), [0, 0, 0]);
});

test('a centimetre-authored model is brought back to room scale', () => {
	// 75cm prop exported in centimetres: 75 units, i.e. 75 metres in USDZ.
	const { root, stage } = usdzExportRoot(boxAt([30, 75, 30]));
	const applied = fitToRoomScale(stage, root);
	assert.ok(applied < 1, 'it was shrunk');
	assert.ok(Math.abs(boundsOf(root).max.y - boundsOf(root).min.y - 0.75) < 1e-6, '75cm tall');
});

test('a model already at real-world size is left exactly as authored', () => {
	const { root, stage } = usdzExportRoot(boxAt([0.5, 0.9, 0.5]));
	assert.equal(fitToRoomScale(stage, root), 1);
	assert.deepEqual(stage.scale.toArray(), [1, 1, 1]);
});

test('the exported USDZ carries horizontal plane anchoring', async () => {
	const text = await usda(boxAt([1, 1, 1], [0, 0.5, 0]));
	assert.match(text, /token preliminary:anchoring:type = "plane"/);
	assert.match(text, /token preliminary:planeAnchoring:alignment = "horizontal"/);
	assert.match(text, /metersPerUnit = 1/);
	assert.match(text, /upAxis = "Y"/);
});

test('the exported USDZ writes the floor offset a phone actually reads', async () => {
	const text = await usda(boxAt([1, 2, 1], [0, 10, 0]));
	const t = transformOf(text, 'Model');
	// The stage cancels the 9m gap between the box's underside and the origin.
	assert.ok(Math.abs(t.y + 9) < 1e-3, `expected the stage to drop the model 9m, got ${t.y}`);
});

test('fit only runs when it is asked for, so a pinched size is never undone', async () => {
	const pinched = new Group();
	pinched.scale.setScalar(3); // someone dragged a 0.75m prop up to 2.25m
	pinched.add(boxAt([0.75, 0.75, 0.75], [0, 0.375, 0]));

	const kept = await usda(pinched);
	assert.ok(Math.abs(transformOf(kept, 'Model').y) < 1e-6, 'already on the floor, no drop');
	// Somewhere under the root that 3x has to be written, or Quick Look shows the
	// original size and the pinch gesture silently did nothing. It rides on the
	// pinched group itself, which is now a child and therefore exported.
	assert.match(kept, /matrix4d xformOp:transform = \( \(3, 0, 0, 0\)/, 'the 3x pinch reaches the file');
	// And with fit on, the same model would have been dragged back to 0.75m.
	const refitted = await usda(
		(() => { const g = new Group(); g.scale.setScalar(3); g.add(boxAt([0.75, 0.75, 0.75], [0, 0.375, 0])); return g; })(),
		{ fit: true },
	);
	assert.ok(transformOf(refitted, 'Model').scaleX < 0.4, 'fit would have pulled the 2.25m prop back to 0.75m');
});
