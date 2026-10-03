// Marker tracking deliberately sits between two independently-owned systems:
//
//   - AR Studio owns the camera/video lifecycle.
//   - MindAR owns image detection/tracking.
//
// These tests pin that boundary without loading TensorFlow: a tiny data: module
// stands in for MindAR's browser runtime and returns a controlled Controller.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	MarkerTracker,
	DEFAULT_RUNTIME_URL,
} from '../src/studio/marker-tracker.js';

const factories = new Map();
let nextRuntimeId = 0;

function runtimeUrl(factory) {
	const key = `marker-runtime-${++nextRuntimeId}`;
	factories.set(key, factory);

	globalThis.__sixty8MarkerTrackerFactories = factories;

	const source = `
		export class Controller {
			constructor(options) {
				return globalThis.__sixty8MarkerTrackerFactories.get(${JSON.stringify(key)})(options);
			}
		}
	`;

	return `data:text/javascript,${encodeURIComponent(source)}`;
}

function video({
	width = 1280,
	height = 720,
} = {}) {
	const listeners = new Map();

	return {
		videoWidth: width,
		videoHeight: height,
		width: 0,
		height: 0,

		addEventListener(type, fn) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(fn);
		},

		removeEventListener(type, fn) {
			listeners.get(type)?.delete(fn);
		},

		emit(type) {
			for (const fn of [...(listeners.get(type) || [])]) fn();
		},

		listenerCount(type) {
			return listeners.get(type)?.size || 0;
		},
	};
}

function controllerHarness({
	dimensions = [[640, 480]],
	addImageTargets = null,
	dummyRun = null,
} = {}) {
	const calls = {
		constructed: 0,
		addImageTargets: [],
		dummyRun: 0,
		processVideo: 0,
		stopProcessVideo: 0,
		dispose: 0,
	};

	let options = null;

	const controller = {
		async addImageTargets(url) {
			calls.addImageTargets.push(url);

			if (addImageTargets) {
				return addImageTargets(url);
			}

			return { dimensions };
		},

		async dummyRun(input) {
			calls.dummyRun++;

			if (dummyRun) {
				return dummyRun(input);
			}
		},

		processVideo() {
			calls.processVideo++;
		},

		stopProcessVideo() {
			calls.stopProcessVideo++;
		},

		dispose() {
			calls.dispose++;
		},

		emit(event) {
			options?.onUpdate?.(event);
		},
	};

	const factory = (opts) => {
		calls.constructed++;
		options = opts;
		return controller;
	};

	return {
		calls,
		controller,
		factory,
		options: () => options,
	};
}

test('default MindAR runtime is the separately-served browser module', () => {
	assert.equal(
		DEFAULT_RUNTIME_URL,
		'/vendor/mindar/mindar-image.prod.js',
	);
});

test('start rejects incomplete tracker configuration', async () => {
	const v = video();

	await assert.rejects(
		new MarkerTracker({
			mindUrl: '/target.mind',
			runtimeUrl: runtimeUrl(() => ({})),
		}).start(),
		/requires a video element/,
	);

	await assert.rejects(
		new MarkerTracker({
			video: v,
			runtimeUrl: runtimeUrl(() => ({})),
		}).start(),
		/requires a compiled MindAR target URL/,
	);

	const tracker = new MarkerTracker({
		video: v,
		mindUrl: '/target.mind',
		runtimeUrl: runtimeUrl(() => ({})),
	});

	tracker.dispose();

	await assert.rejects(
		tracker.start(),
		/has been disposed/,
	);
});

test('start uses the existing video, loads the .mind target, warms up, and begins processing', async () => {
	const v = video({ width: 1920, height: 1080 });
	const harness = controllerHarness();

	const tracker = new MarkerTracker({
		video: v,
		mindUrl: '/targets/card.mind',
		runtimeUrl: runtimeUrl(harness.factory),
	});

	await tracker.start();

	assert.equal(harness.calls.constructed, 1);
	assert.deepEqual(
		harness.calls.addImageTargets,
		['/targets/card.mind'],
	);
	assert.equal(harness.calls.dummyRun, 1);
	assert.equal(harness.calls.processVideo, 1);

	assert.equal(harness.options().inputWidth, 1920);
	assert.equal(harness.options().inputHeight, 1080);
	assert.equal(v.width, 1920);
	assert.equal(v.height, 1080);
	assert.equal(harness.options().maxTrack, 1);
	assert.equal(typeof harness.options().onUpdate, 'function');

	assert.equal(tracker.controller, harness.controller);
	assert.equal(tracker.running, true);
	assert.equal(tracker.visible, false);

	tracker.dispose();
});

test('start waits until camera video metadata is available', async () => {
	const v = video({ width: 0, height: 0 });
	const harness = controllerHarness();

	const tracker = new MarkerTracker({
		video: v,
		mindUrl: '/targets/poster.mind',
		runtimeUrl: runtimeUrl(harness.factory),
	});

	let finished = false;

	const pending = tracker.start().then(() => {
		finished = true;
	});

	await Promise.resolve();

	assert.equal(finished, false);
	assert.equal(harness.calls.constructed, 0);
	assert.equal(v.listenerCount('loadedmetadata'), 1);

	v.videoWidth = 1280;
	v.videoHeight = 720;
	v.emit('loadedmetadata');

	await pending;

	assert.equal(finished, true);
	assert.equal(harness.calls.constructed, 1);
	assert.equal(v.width, 1280);
	assert.equal(v.height, 720);
	assert.equal(v.listenerCount('loadedmetadata'), 0);
	assert.equal(v.listenerCount('error'), 0);

	tracker.dispose();
});

test('video metadata errors reject startup cleanly', async () => {
	const v = video({ width: 0, height: 0 });
	const harness = controllerHarness();

	const tracker = new MarkerTracker({
		video: v,
		mindUrl: '/targets/card.mind',
		runtimeUrl: runtimeUrl(harness.factory),
	});

	const pending = tracker.start();

	await Promise.resolve();

	v.emit('error');

	await assert.rejects(
		pending,
		/camera video metadata could not be loaded/,
	);

	assert.equal(harness.calls.constructed, 0);
	assert.equal(tracker.running, false);
});

test('a compiled file with no image targets fails closed and disposes its controller', async () => {
	const harness = controllerHarness({
		dimensions: [],
	});

	const tracker = new MarkerTracker({
		video: video(),
		mindUrl: '/targets/empty.mind',
		runtimeUrl: runtimeUrl(harness.factory),
	});

	await assert.rejects(
		tracker.start(),
		/contains no image targets/,
	);

	assert.equal(harness.calls.constructed, 1);
	assert.equal(harness.calls.dummyRun, 0);
	assert.equal(harness.calls.processVideo, 0);
	assert.equal(harness.calls.dispose, 1);

	assert.equal(tracker.controller, null);
	assert.equal(tracker.running, false);
});

test('only target zero drives found, pose, and lost lifecycle callbacks', async () => {
	const harness = controllerHarness();

	const found = [];
	const poses = [];
	const lost = [];

	const tracker = new MarkerTracker({
		video: video(),
		mindUrl: '/targets/card.mind',
		runtimeUrl: runtimeUrl(harness.factory),
		onFound: () => found.push('found'),
		onPose: (matrix) => poses.push(matrix),
		onLost: () => lost.push('lost'),
	});

	await tracker.start();

	const first = Array.from({ length: 16 }, (_, i) => i + 1);
	const second = Array.from({ length: 16 }, (_, i) => 100 + i);

	// Wrong target index: ignored completely.
	harness.controller.emit({
		type: 'updateMatrix',
		targetIndex: 1,
		worldMatrix: first,
	});

	// Non-matrix event: ignored completely.
	harness.controller.emit({
		type: 'processDone',
	});

	assert.equal(found.length, 0);
	assert.equal(poses.length, 0);
	assert.equal(lost.length, 0);

	harness.controller.emit({
		type: 'updateMatrix',
		targetIndex: 0,
		worldMatrix: first,
	});

	assert.equal(found.length, 1);
	assert.deepEqual(poses, [first]);
	assert.equal(tracker.visible, true);

	harness.controller.emit({
		type: 'updateMatrix',
		targetIndex: 0,
		worldMatrix: second,
	});

	assert.equal(found.length, 1, 'continuous tracking must not emit duplicate found');
	assert.deepEqual(poses, [first, second]);

	// The adapter copies the pose so callers cannot mutate MindAR's array.
	assert.notEqual(poses[0], first);

	harness.controller.emit({
		type: 'updateMatrix',
		targetIndex: 0,
		worldMatrix: null,
	});

	assert.equal(lost.length, 1);
	assert.equal(tracker.visible, false);

	harness.controller.emit({
		type: 'updateMatrix',
		targetIndex: 0,
		worldMatrix: null,
	});

	assert.equal(lost.length, 1, 'continuous loss must not emit duplicate lost');

	tracker.dispose();
});

test('invalid pose matrices never make a target visible', async () => {
	const harness = controllerHarness();
	let found = 0;
	let posed = 0;

	const tracker = new MarkerTracker({
		video: video(),
		mindUrl: '/targets/card.mind',
		runtimeUrl: runtimeUrl(harness.factory),
		onFound: () => { found++; },
		onPose: () => { posed++; },
	});

	await tracker.start();

	for (const worldMatrix of [
		undefined,
		{},
		[],
		Array(15).fill(0),
		Array(17).fill(0),
	]) {
		harness.controller.emit({
			type: 'updateMatrix',
			targetIndex: 0,
			worldMatrix,
		});
	}

	assert.equal(found, 0);
	assert.equal(posed, 0);
	assert.equal(tracker.visible, false);

	tracker.dispose();
});

test('stop during target loading cancels startup before warmup or processing', async () => {
	let releaseTarget;

	const targetGate = new Promise((resolve) => {
		releaseTarget = resolve;
	});

	const harness = controllerHarness({
		addImageTargets: async () => {
			await targetGate;
			return { dimensions: [[640, 480]] };
		},
	});

	const tracker = new MarkerTracker({
		video: video(),
		mindUrl: '/targets/card.mind',
		runtimeUrl: runtimeUrl(harness.factory),
	});

	const pending = tracker.start();

	// Let the dynamic import and Controller construction complete.
	while (harness.calls.addImageTargets.length === 0) {
		await new Promise((resolve) => setImmediate(resolve));
	}

	tracker.stop();

	releaseTarget();

	await pending;

	assert.equal(harness.calls.dummyRun, 0);
	assert.equal(harness.calls.processVideo, 0);
	assert.equal(harness.calls.dispose, 1);
	assert.equal(tracker.controller, null);
	assert.equal(tracker.running, false);
});

test('stop and dispose are callback-safe and disposal itself is idempotent', async () => {
	const harness = controllerHarness();
	let lost = 0;

	const tracker = new MarkerTracker({
		video: video(),
		mindUrl: '/targets/card.mind',
		runtimeUrl: runtimeUrl(harness.factory),
		onLost: () => { lost++; },
	});

	await tracker.start();

	harness.controller.emit({
		type: 'updateMatrix',
		targetIndex: 0,
		worldMatrix: Array(16).fill(1),
	});

	assert.equal(tracker.visible, true);

	tracker.stop();
	tracker.stop();

	assert.equal(lost, 1);
	assert.equal(tracker.running, false);
	assert.equal(tracker.visible, false);

	tracker.dispose();
	tracker.dispose();

	assert.equal(harness.calls.dispose, 1);
	assert.equal(tracker.controller, null);

	await assert.rejects(
		tracker.start(),
		/has been disposed/,
	);
});
