import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../src/config.js';
import { SavedSceneError, createSavedSceneClient } from '../src/studio/saved-scenes.js';

const scene = { v: 1, items: [] };
const metadata = {
	id: 'scene-123',
	name: 'Lobby Display',
	scene_type: 'free',
	revision: 4,
	created_at: '2026-10-03T00:00:00.000Z',
	updated_at: '2026-10-03T00:00:01.000Z',
};

function response(status, body, { json = true } = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: json ? async () => body : async () => { throw new Error('not json'); },
	};
}

function fakeFetch(responses = [response(200, { saved_scene: { ...metadata, scene } })]) {
	const calls = [];
	let index = 0;
	const fetchImpl = async (url, options) => {
		calls.push({ url, options });
		return responses[Math.min(index++, responses.length - 1)];
	};
	return { calls, fetchImpl };
}

function assertError(promise, code, status) {
	return assert.rejects(promise, (error) => {
		assert.ok(error instanceof SavedSceneError);
		assert.equal(error.code, code);
		if (status !== undefined) assert.equal(error.status, status);
		return true;
	});
}

test('empty endpoint disables transport and default config remains disabled', () => {
	assert.equal(resolveConfig({}).savedScenesEndpoint, '');
	assert.equal(createSavedSceneClient(), null);
	assert.equal(createSavedSceneClient({ endpoint: '  ' }), null);
});

test('relative endpoint is normalized and collection list path/query is exact', async () => {
	const fake = fakeFetch([response(200, { saved_scenes: [metadata] })]);
	const client = createSavedSceneClient({ endpoint: '/api/saved-scenes///', fetchImpl: fake.fetchImpl });

	assert.equal(client.endpoint, '/api/saved-scenes');
	const result = await client.list({ limit: 20, offset: 5 });

	assert.deepEqual(result, [metadata]);
	assert.equal(fake.calls[0].url, '/api/saved-scenes?limit=20&offset=5');
	assert.equal(fake.calls[0].options.method, 'GET');
	assert.equal(fake.calls[0].options.headers.accept, 'application/json');
});

test('list accepts metadata without requiring scene documents', async () => {
	const fake = fakeFetch([response(200, { saved_scenes: [metadata] })]);
	const result = await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl }).list();
	assert.deepEqual(result[0], metadata);
});

test('list rejects malformed metadata resources', async () => {
	const fake = fakeFetch([response(200, { saved_scenes: [{ ...metadata, revision: 0 }] })]);
	await assertError(
		createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl }).list(),
		'protocol_error',
	);
});

test('get encodes opaque IDs and validates full resources', async () => {
	const fake = fakeFetch([response(200, { saved_scene: { ...metadata, scene } })]);
	const result = await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
		.get('scene/123');

	assert.deepEqual(result.scene, scene);
	assert.equal(fake.calls[0].url, '/api/saved-scenes/scene%2F123');
});

test('get rejects malformed scene documents and successful malformed JSON', async () => {
	const malformedScene = { ...metadata, scene: { v: 2, items: [] } };
	const malformed = fakeFetch([response(200, { saved_scene: malformedScene })]);
	await assertError(
		createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: malformed.fetchImpl }).get('scene-123'),
		'protocol_error',
	);

	const invalidJson = fakeFetch([response(200, null, { json: false })]);
	await assertError(
		createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: invalidJson.fetchImpl }).get('scene-123'),
		'protocol_error',
	);
});

test('create sends a canonical scene and validates a 201 resource', async () => {
	const fake = fakeFetch([response(201, { saved_scene: { ...metadata, scene } })]);
	const input = { v: 1, items: [] };
	const result = await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
		.create({ name: '  Lobby Display  ', scene: input });

	assert.equal(result.id, 'scene-123');
	assert.deepEqual(JSON.parse(fake.calls[0].options.body), { name: 'Lobby Display', scene });
	assert.equal(fake.calls[0].options.method, 'POST');
	assert.equal(fake.calls[0].options.options, undefined);
	assert.equal(fake.calls[0].options.headers['content-type'], 'application/json');
	assert.deepEqual(input, scene);
});

test('update sends scene plus revision to the same encoded ID', async () => {
	const fake = fakeFetch([response(200, { saved_scene: { ...metadata, scene } })]);
	await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
		.update('scene 123', { scene, revision: 4 });

	assert.equal(fake.calls[0].url, '/api/saved-scenes/scene%20123');
	assert.equal(fake.calls[0].options.method, 'PUT');
	assert.deepEqual(JSON.parse(fake.calls[0].options.body), { scene, revision: 4 });
});

test('rename sends name and revision without a scene document', async () => {
	const fake = fakeFetch([response(200, { saved_scene: metadata })]);
	await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
		.rename('scene-123', { name: 'Renamed', revision: 4 });

	assert.equal(fake.calls[0].options.method, 'PATCH');
	assert.deepEqual(JSON.parse(fake.calls[0].options.body), { name: 'Renamed', revision: 4 });
});

test('duplicate posts only a name and expects a new full resource', async () => {
	const duplicate = { ...metadata, id: 'scene-copy', name: 'Copy' };
	const fake = fakeFetch([response(201, { saved_scene: { ...duplicate, scene } })]);
	const result = await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
		.duplicate('scene-123', { name: 'Copy' });

	assert.equal(result.id, 'scene-copy');
	assert.equal(fake.calls[0].url, '/api/saved-scenes/scene-123/duplicate');
	assert.deepEqual(JSON.parse(fake.calls[0].options.body), { name: 'Copy' });
});

test('delete uses If-Match and accepts an empty 204 response', async () => {
	const fake = fakeFetch([response(204, null)]);
	const result = await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
		.delete('scene-123', { revision: 4 });

	assert.equal(result, null);
	assert.equal(fake.calls[0].options.method, 'DELETE');
	assert.equal(fake.calls[0].options.headers['if-match'], '"4"');
});

test('name, ID, revision, and pagination validation reject before fetch', async () => {
	const fake = fakeFetch();
	const client = createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl });

	await assertError(client.create({ name: '   ', scene }), 'invalid_name');
	await assertError(client.create({ name: 'x'.repeat(121), scene }), 'invalid_name');
	await assertError(client.get(''), 'invalid_id');
	await assertError(client.update('scene-123', { scene, revision: 0 }), 'invalid_revision');
	await assertError(client.update('scene-123', { scene, revision: 1.5 }), 'invalid_revision');
	await assertError(client.update('scene-123', { scene, revision: Infinity }), 'invalid_revision');
	await assertError(client.list({ limit: -1 }), 'invalid_query');
	assert.equal(fake.calls.length, 0);
});

test('invalid scenes are rejected without mutating the caller document', async () => {
	const fake = fakeFetch();
	const client = createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl });
	const invalid = { v: 1, items: [{ src: 'javascript:bad', title: 'Bad', x: 0, z: 0, yaw: 0, scale: 1 }] };
	const before = structuredClone(invalid);

	await assertError(client.create({ name: 'Bad', scene: invalid }), 'invalid_scene', 422);
	assert.deepEqual(invalid, before);
	assert.equal(fake.calls.length, 0);
});

for (const [status, code] of [
	[400, 'bad_request'], [404, 'not_found'], [413, 'too_large'],
	[415, 'unsupported_media_type'], [422, 'invalid_scene'], [503, 'unavailable'],
	[500, 'server_error'],
]) {
	test(`HTTP ${status} maps to ${code}`, async () => {
		const fake = fakeFetch([response(status, { error: '<html>not trusted</html>' })]);
		await assertError(
			createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl }).list(),
			code,
			status,
		);
	});
}

test('409 preserves current_revision without trusting the server message', async () => {
	const fake = fakeFetch([response(409, { error: 'saved scene has changed', current_revision: 5 })]);
	let error;
	try {
		await createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl })
			.update('scene-123', { scene, revision: 4 });
	} catch (caught) {
		error = caught;
	}
	assert.ok(error instanceof SavedSceneError);
	assert.equal(error.code, 'conflict');
	assert.equal(error.currentRevision, 5);
	assert.equal(error.message.includes('saved scene has changed'), false);
});

test('network and abort failures map to safe structured errors', async () => {
	const network = createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: async () => { throw new Error('secret'); } });
	await assertError(network.list(), 'network_error');

	const abort = createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: async () => {
		const error = new Error('aborted');
		error.name = 'AbortError';
		throw error;
	} });
	await assertError(abort.list(), 'aborted');
});

test('AbortSignal is passed through and client never changes editor state', async () => {
	const fake = fakeFetch([response(200, { saved_scene: { ...metadata, scene } })]);
	const signal = new AbortController().signal;
	const client = createSavedSceneClient({ endpoint: '/api/saved-scenes', fetchImpl: fake.fetchImpl });
	await client.get('scene-123', { signal });

	assert.equal(fake.calls[0].options.signal, signal);
	assert.equal('dirty' in client, false);
});
