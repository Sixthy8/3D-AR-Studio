import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArStudio } from '../src/studio/studio.js';
import {
	deserializeSceneDocument,
	normalizeSceneTarget,
	normalizeSceneType,
} from '../src/studio/scene-math.js';

function livePlacement(item) {
	return {
		src: item.src,
		title: item.title || '',
		group: {
			position: {
				x: item.x,
				y: item.y ?? 0,
				z: item.z,
			},
			scale: { x: item.scale ?? 1 },
		},
		rotX: item.rotX ?? 0,
		yaw: item.yaw ?? 0,
		rotZ: item.rotZ ?? 0,
		scale: item.scale ?? 1,
		visible: item.visible !== false,
		groupId: item.group || null,
		action: item.action ? { ...item.action } : null,
		spawnT: 1,
	};
}

function studioHarness(document, { loadTemplate } = {}) {
	const normalized = deserializeSceneDocument(JSON.stringify(document));
	const studio = Object.create(ArStudio.prototype);

	studio.sceneType = normalizeSceneType(normalized.type);
	studio.sceneTarget = normalizeSceneTarget(normalized.target, studio.sceneType);
	studio.placements = normalized.items.map(livePlacement);
	studio._loadTemplate = loadTemplate || (async (src) => ({ src }));
	studio._syncTargetPreview = () => {};
	studio._syncSceneSetupUI = () => {};
	studio._saveScene = () => {};
	studio._setStatus = () => {};
	studio._defaultSceneTarget = (type) => ({
		id: 'target-default',
		width: 1,
		height: 1,
		orientation: type === 'marker-vertical' ? 'vertical' : 'horizontal',
		visible: true,
	});
	studio.clearCount = 0;
	studio.clear = function clear() {
		const items = this.getScene();
		this.placements = [];
		this.clearCount++;
		return items;
	};
	studio._addModel = async function addModel(model, options) {
		const placement = livePlacement({
			src: model.src,
			title: model.title,
			x: options.x,
			y: options.y,
			z: options.z,
			rotX: options.rotX,
			yaw: options.yaw,
			rotZ: options.rotZ,
			scale: options.scale,
			visible: options.visible,
			group: options.groupId,
			action: options.action,
		});

		this.placements.push(placement);
		return placement;
	};

	return studio;
}

const action = {
	id: 'a-document123',
	type: 'link',
	label: 'Product details',
	url: 'https://example.com/product',
};

test('getScene and getSceneDocument preserve every supported free-scene field canonically', () => {
	const studio = studioHarness({
		v: 1,
		items: [
			{
				src: 'https://example.com/hidden.glb',
				title: 'Hidden',
				x: 1.25,
				y: 0.5,
				z: -2.75,
				rotX: 0.2,
				yaw: 1.1,
				rotZ: -0.3,
				scale: 1.4,
				visible: false,
				group: 'g-document123',
				action,
			},
			{
				src: 'https://example.com/defaults.glb',
				title: 'Defaults',
				x: 0,
				y: 0,
				z: -1,
				rotX: 0,
				yaw: 0,
				rotZ: 0,
				scale: 1,
				visible: true,
			},
		],
	});

	const live = studio.getScene();

	assert.equal(live[0].rotX, 0.2);
	assert.equal(live[0].rotZ, -0.3);
	assert.deepEqual(live[0].action, action);

	const document = studio.getSceneDocument();

	assert.deepEqual(Object.keys(document), ['v', 'items']);
	assert.deepEqual(document.items[0], {
		src: 'https://example.com/hidden.glb',
		title: 'Hidden',
		x: 1.25,
		y: 0.5,
		z: -2.75,
		rotX: 0.2,
		yaw: 1.1,
		rotZ: -0.3,
		scale: 1.4,
		visible: false,
		group: 'g-document123',
		action,
	});
	assert.deepEqual(document.items[1], {
		src: 'https://example.com/defaults.glb',
		title: 'Defaults',
		x: 0,
		z: -1,
		yaw: 0,
		scale: 1,
	});
});

test('three-axis rotation survives live document snapshot and full restore', async () => {
	const source = studioHarness({
		v: 1,
		items: [{
			src: 'https://example.com/rotated.glb',
			title: 'Rotated',
			x: 0.4,
			y: 0.2,
			z: -1.8,
			rotX: 0.35,
			yaw: 1.2,
			rotZ: -0.42,
			scale: 1.4,
			group: 'g-rotate123',
			action,
		}],
	});
	const snapshot = source.getSceneDocument();
	const target = studioHarness({ v: 1, items: [] });

	const restored = await target.setSceneDocument(snapshot);

	assert.deepEqual(restored, snapshot);
	assert.deepEqual(target.getSceneDocument(), snapshot);
	assert.equal(restored.items[0].rotX, 0.35);
	assert.equal(restored.items[0].yaw, 1.2);
	assert.equal(restored.items[0].rotZ, -0.42);
	assert.equal(restored.items[0].group, 'g-rotate123');
	assert.deepEqual(restored.items[0].action, action);
});

test('horizontal marker document restores complete normalized target metadata and placements', async () => {
	const target = studioHarness({ v: 1, items: [] });
	const restored = await target.setSceneDocument({
		v: 1,
		type: 'marker-horizontal',
		target: {
			id: 'target-card',
			image: '/target-store/card.png',
			mind: '/target-store/card.mind',
			width: 0.0889,
			height: 0.0508,
			orientation: 'vertical',
			visible: false,
		},
		items: [{
			src: 'https://example.com/card-model.glb',
			title: 'Card model',
			x: 0.01,
			y: 0.02,
			z: -1.6,
			yaw: 0.5,
			scale: 0.8,
		}],
	});

	assert.equal(restored.type, 'marker-horizontal');
	assert.deepEqual(restored.target, {
		id: 'target-card',
		image: '/target-store/card.png',
		mind: '/target-store/card.mind',
		width: 0.0889,
		height: 0.0508,
		orientation: 'horizontal',
		visible: false,
	});
	assert.equal(restored.items.length, 1);
	assert.equal(restored.items[0].y, 0.02);
});

test('vertical marker document restores complete normalized target metadata and placements', async () => {
	const target = studioHarness({ v: 1, items: [] });
	const restored = await target.setSceneDocument({
		v: 1,
		type: 'marker-vertical',
		target: {
			id: 'target-poster',
			image: 'https://example.com/poster.jpg',
			mind: 'https://example.com/poster.mind',
			width: 0.4572,
			height: 0.6096,
			orientation: 'horizontal',
			visible: true,
		},
		items: [{
			src: 'https://example.com/poster-model.glb',
			title: 'Poster model',
			x: -0.2,
			z: -1.4,
			rotX: 0.1,
			yaw: -0.4,
			rotZ: 0.3,
			scale: 1.1,
			visible: false,
		}],
	});

	assert.equal(restored.type, 'marker-vertical');
	assert.deepEqual(restored.target, {
		id: 'target-poster',
		image: 'https://example.com/poster.jpg',
		mind: 'https://example.com/poster.mind',
		width: 0.4572,
		height: 0.6096,
		orientation: 'vertical',
	});
	assert.equal(restored.items[0].visible, false);
	assert.equal(restored.items[0].rotX, 0.1);
	assert.equal(restored.items[0].rotZ, 0.3);
});

test('legacy yaw-only v1 documents restore with historical zero-field omission', async () => {
	const target = studioHarness({ v: 1, items: [] });
	const restored = await target.setSceneDocument({
		v: 1,
		items: [{
			src: 'https://example.com/legacy.glb',
			title: 'Legacy',
			x: 0,
			z: -2,
			yaw: 0.75,
			scale: 1,
		}],
	});

	assert.equal(restored.items[0].yaw, 0.75);
	assert.equal('y' in restored.items[0], false);
	assert.equal('rotX' in restored.items[0], false);
	assert.equal('rotZ' in restored.items[0], false);
	assert.equal('visible' in restored.items[0], false);
});

test('full document restore drops unsupported and invalid optional fields canonically', async () => {
	const target = studioHarness({ v: 1, items: [] });
	const restored = await target.setSceneDocument({
		v: 1,
		unexpected: 'drop me',
		items: [{
			src: 'https://example.com/model.glb',
			title: 'Model',
			x: 1,
			z: -2,
			yaw: 0,
			scale: 1,
			unsupported: true,
			group: 'not-a-group',
			action: {
				id: 'bad',
				type: 'link',
				url: 'http://example.com',
			},
		}],
	});

	assert.deepEqual(restored, {
		v: 1,
		items: [{
			src: 'https://example.com/model.glb',
			title: 'Model',
			x: 1,
			z: -2,
			yaw: 0,
			scale: 1,
		}],
	});
});

test('asset preload failure leaves the current live scene unchanged', async () => {
	const original = {
		v: 1,
		items: [{
			src: 'https://example.com/original.glb',
			title: 'Original',
			x: 0,
			z: -1,
			yaw: 0,
			scale: 1,
		}],
	};
	const target = studioHarness(original, {
		loadTemplate: async () => {
			throw new Error('asset unavailable');
		},
	});
	const before = target.getSceneDocument();

	await assert.rejects(
		target.setSceneDocument({
			v: 1,
			items: [{
				src: 'https://example.com/missing.glb',
				title: 'Missing',
				x: 0,
				z: -2,
				yaw: 0,
				scale: 1,
			}],
		}),
		/scene document assets could not be loaded/,
	);

	assert.equal(target.clearCount, 0);
	assert.deepEqual(target.getSceneDocument(), before);
});
