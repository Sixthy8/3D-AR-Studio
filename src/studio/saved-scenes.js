import {
	deserializeSceneDocument,
	normalizeSceneType,
	serializeScene,
} from './scene-math.js';

const MAX_NAME_LENGTH = 120;
const SCENE_TYPES = new Set(['free', 'marker-horizontal', 'marker-vertical']);

const STATUS_CODES = Object.freeze({
	400: 'bad_request',
	404: 'not_found',
	409: 'conflict',
	413: 'too_large',
	415: 'unsupported_media_type',
	422: 'invalid_scene',
	503: 'unavailable',
});

export class SavedSceneError extends Error {
	constructor(message, { code = 'unknown', status = null, currentRevision = null } = {}) {
		super(message);
		this.name = 'SavedSceneError';
		this.code = code;
		this.status = status;
		this.currentRevision = currentRevision;
	}
}

/**
 * Build the optional Saved Scene transport. An empty endpoint disables it.
 * The returned object owns no editor or database state.
 */
export function createSavedSceneClient({ endpoint = '', fetchImpl } = {}) {
	const root = normalizeEndpoint(endpoint);
	if (!root) return null;

	const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
	if (!doFetch) throw new SavedSceneError('Saved Scene transport is unavailable.', { code: 'unavailable' });

	async function request(path, { method = 'GET', body, expected, signal, headers = {} } = {}) {
		let response;
		try {
			response = await doFetch(joinPath(root, path), {
				method,
				signal,
				credentials: 'same-origin',
				headers: {
					accept: 'application/json',
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			if (error?.name === 'AbortError') {
				throw new SavedSceneError('Saved Scene request was aborted.', { code: 'aborted' });
			}
			throw new SavedSceneError('Saved Scene request could not reach the server.', { code: 'network_error' });
		}

		if (!response.ok) throw await httpError(response);
		if (response.status !== expected) {
			throw new SavedSceneError('Saved Scene server returned an unexpected response.', {
				code: 'protocol_error',
				status: response.status,
			});
		}

		if (expected === 204) return null;
		let payload;
		try {
			payload = await response.json();
		} catch {
			throw new SavedSceneError('Saved Scene server returned malformed JSON.', {
				code: 'protocol_error',
				status: response.status,
			});
		}
		return payload;
	}

	return Object.freeze({
		endpoint: root,
		async list({ limit, offset, signal } = {}) {
			const query = new URLSearchParams();
			if (limit !== undefined) query.set('limit', String(validatePageValue(limit, 'limit')));
			if (offset !== undefined) query.set('offset', String(validatePageValue(offset, 'offset', 0)));
			const suffix = query.toString() ? `?${query}` : '';
			return request(suffix ? `?${query}` : '', { signal, expected: 200 })
				.then((payload) => validateListResponse(payload));
		},
		async get(id, { signal } = {}) {
			return request(`/${encodeId(id)}`, { signal, expected: 200 })
				.then((payload) => validateResourceResponse(payload, { full: true }));
		},
		async create({ name, scene }, { signal } = {}) {
			return request('/', {
				method: 'POST',
				body: { name: validateName(name), scene: validateSceneDocument(scene) },
				signal,
				expected: 201,
			}).then((payload) => validateResourceResponse(payload, { full: true }));
		},
		async update(id, { scene, revision }, { signal } = {}) {
			return request(`/${encodeId(id)}`, {
				method: 'PUT',
				body: { scene: validateSceneDocument(scene), revision: validateRevision(revision) },
				signal,
				expected: 200,
			}).then((payload) => validateResourceResponse(payload, { full: true }));
		},
		async rename(id, { name, revision }, { signal } = {}) {
			return request(`/${encodeId(id)}`, {
				method: 'PATCH',
				body: { name: validateName(name), revision: validateRevision(revision) },
				signal,
				expected: 200,
			}).then((payload) => validateResourceResponse(payload, { full: false }));
		},
		async duplicate(id, { name }, { signal } = {}) {
			return request(`/${encodeId(id)}/duplicate`, {
				method: 'POST',
				body: { name: validateName(name) },
				signal,
				expected: 201,
			}).then((payload) => validateResourceResponse(payload, { full: true }));
		},
		async delete(id, { revision } = {}, { signal } = {}) {
			return request(`/${encodeId(id)}`, {
				method: 'DELETE',
				signal,
				expected: 204,
				headers: { 'if-match': `"${validateRevision(revision)}"` },
			});
		},
	});
}

function normalizeEndpoint(raw) {
	const value = String(raw ?? '').trim();
	if (!value) return '';
	if (value.startsWith('//') || value.includes('?') || value.includes('#')) {
		throw new SavedSceneError('Saved Scene endpoint is invalid.', { code: 'invalid_endpoint' });
	}
	if (value.startsWith('/')) return value.replace(/\/+$/, '') || '/';
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:') throw new Error('protocol');
		return url.href.replace(/\/+$/, '');
	} catch {
		throw new SavedSceneError('Saved Scene endpoint is invalid.', { code: 'invalid_endpoint' });
	}
}

function joinPath(root, suffix) {
	if (!suffix) return root;
	if (suffix.startsWith('?')) return `${root}${suffix}`;
	return `${root}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function encodeId(raw) {
	const id = String(raw ?? '').trim();
	if (!id || [...id].some((char) => /[\u0000-\u001f\u007f]/.test(char))) {
		throw new SavedSceneError('Saved Scene ID is invalid.', { code: 'invalid_id' });
	}
	return encodeURIComponent(id);
}

function validateName(raw) {
	const name = String(raw ?? '').trim();
	if (!name) throw new SavedSceneError('Saved Scene name is required.', { code: 'invalid_name' });
	if ([...name].length > MAX_NAME_LENGTH) {
		throw new SavedSceneError('Saved Scene name is too long.', { code: 'invalid_name' });
	}
	return name;
}

function validateRevision(raw) {
	if (!Number.isSafeInteger(raw) || raw <= 0) {
		throw new SavedSceneError('Saved Scene revision is invalid.', { code: 'invalid_revision' });
	}
	return raw;
}

function validatePageValue(raw, field, minimum = 1) {
	if (!Number.isSafeInteger(raw) || raw < minimum) {
		throw new SavedSceneError(`Saved Scene ${field} is invalid.`, { code: 'invalid_query' });
	}
	return raw;
}

function validateSceneDocument(scene) {
	if (!scene || typeof scene !== 'object' || Array.isArray(scene) || scene.v !== 1 || !Array.isArray(scene.items)) {
		throw new SavedSceneError('Saved Scene document is invalid.', { code: 'invalid_scene', status: 422 });
	}
	if (scene.type !== undefined && !SCENE_TYPES.has(scene.type)) {
		throw new SavedSceneError('Saved Scene document type is invalid.', { code: 'invalid_scene', status: 422 });
	}
	for (const item of scene.items) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new SavedSceneError('Saved Scene document is invalid.', { code: 'invalid_scene', status: 422 });
		}
		for (const key of ['x', 'y', 'z', 'rotX', 'yaw', 'rotZ', 'scale']) {
			if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]))) {
				throw new SavedSceneError('Saved Scene document is invalid.', { code: 'invalid_scene', status: 422 });
			}
		}
	}

	const normalized = deserializeSceneDocument(JSON.stringify(scene));
	if (normalized.items.length !== scene.items.length) {
		throw new SavedSceneError('Saved Scene document is invalid.', { code: 'invalid_scene', status: 422 });
	}
	const canonical = JSON.parse(serializeScene(normalized.items, {
		type: normalized.type,
		target: normalized.target,
	}));
	return canonical;
}

function validateListResponse(payload) {
	if (!payload || typeof payload !== 'object' || !Array.isArray(payload.saved_scenes)) {
		throw protocolError();
	}
	return payload.saved_scenes.map((record) => validateResource(record, { full: false }));
}

function validateResourceResponse(payload, options) {
	if (!payload || typeof payload !== 'object' || !payload.saved_scene) throw protocolError();
	return validateResource(payload.saved_scene, options);
}

function validateResource(record, { full }) {
	if (!record || typeof record !== 'object' || Array.isArray(record)) throw protocolError();
	const id = String(record.id ?? '').trim();
	const name = String(record.name ?? '').trim();
	const sceneType = record.scene_type;
	if (!id || !name || [...name].length > MAX_NAME_LENGTH || !SCENE_TYPES.has(sceneType)) throw protocolError();
	let revision;
	try { revision = validateRevision(record.revision); } catch { throw protocolError(); }
	if (typeof record.created_at !== 'string' || !record.created_at || typeof record.updated_at !== 'string' || !record.updated_at) {
		throw protocolError();
	}
	const result = {
		id,
		name,
		scene_type: sceneType,
		revision,
		created_at: record.created_at,
		updated_at: record.updated_at,
	};
	if (full) {
		if (!Object.prototype.hasOwnProperty.call(record, 'scene')) throw protocolError();
		let scene;
		try {
			scene = validateSceneDocument(record.scene);
		} catch {
			throw protocolError();
		}
		const actualType = normalizeSceneType(scene.type);
		if (actualType !== sceneType) throw protocolError();
		result.scene = scene;
	}
	return result;
}

function protocolError() {
	return new SavedSceneError('Saved Scene server returned an invalid resource.', {
		code: 'protocol_error',
	});
}

async function httpError(response) {
	let body = null;
	try { body = await response.json(); } catch { /* Never trust non-JSON error bodies. */ }
	const code = STATUS_CODES[response.status] || (response.status >= 500 ? 'server_error' : 'http_error');
	const currentRevision = Number.isSafeInteger(body?.current_revision) && body.current_revision > 0
		? body.current_revision
		: null;
	return new SavedSceneError(`Saved Scene request failed (${response.status}).`, {
		code,
		status: response.status,
		currentRevision,
	});
}
