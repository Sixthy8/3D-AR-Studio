const ENDPOINT = '/api/analytics/events';
const SESSION_KEY = 'sixty8-ar-studio:analytics-session';

let generatedJourneyId = '';

const SESSION_COOKIE = 's68_ar_session';

function mirrorSessionCookie(value) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(value || ''))) return;

	try {
		const secure = location.protocol === 'https:' ? '; Secure' : '';

		document.cookie =
			`${SESSION_COOKIE}=${value}; Path=/; SameSite=Lax${secure}`;
	} catch {
		// Session storage remains the primary client-side identity.
	}
}


function runtimeMode(config) {
	const mode = String(config?.urlExperience || '').trim().toLowerCase();
	return mode === 'space' || mode === 'marker'
		? mode
		: '';
}

function randomId() {
	if (globalThis.crypto?.randomUUID) {
		return crypto.randomUUID();
	}

	const bytes = new Uint8Array(16);
	globalThis.crypto?.getRandomValues?.(bytes);

	if (bytes.some(Boolean)) {
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;

		const hex = [...bytes]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');

		return [
			hex.slice(0, 8),
			hex.slice(8, 12),
			hex.slice(12, 16),
			hex.slice(16, 20),
			hex.slice(20),
		].join('-');
	}

	return '';
}

function sessionId() {
	try {
		const existing = sessionStorage.getItem(SESSION_KEY);

		if (existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) {
			mirrorSessionCookie(existing);
			return existing;
		}

		const next = randomId().replace(/-/g, '');

		if (!next) return '';

		sessionStorage.setItem(SESSION_KEY, next);
		mirrorSessionCookie(next);
		return next;
	} catch {
		return randomId().replace(/-/g, '');
	}
}

function sceneKey() {
	try {
		const params = new URLSearchParams(location.search);
		const queryScene = String(params.get('scene') || '').trim();

		if (/^[A-Za-z0-9_-]{6,32}$/.test(queryScene)) {
			return queryScene;
		}

		const match = /^\/s\/([A-Za-z0-9_-]{6,32})$/.exec(location.pathname);
		return match?.[1] || '';
	} catch {
		return '';
	}
}

function journeyId(config) {
	if (!runtimeMode(config)) return '';

	try {
		const params = new URLSearchParams(location.search);
		const queryJourney = String(params.get('journey') || '').trim();

		if (/^[A-Za-z0-9_-]{1,64}$/.test(queryJourney)) {
			return queryJourney;
		}
	} catch {
		// Fall through to a page-local journey id.
	}

	if (!generatedJourneyId) {
		generatedJourneyId = randomId().replace(/-/g, '');
	}

	return generatedJourneyId;
}

export function getExperienceJourneyId(config) {
	return journeyId(config);
}

export function getExperienceSessionId() {
	return sessionId();
}

export function getExperienceSceneKey() {
	return sceneKey();
}

function deviceClass() {
	const ua = String(navigator.userAgent || '');

	if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';

	if (
		/Android|iPhone|iPod|Mobile|IEMobile|Opera Mini/i.test(ua) ||
		window.matchMedia?.('(pointer: coarse)').matches
	) {
		return 'mobile';
	}

	return 'desktop';
}

function userAgentFamily() {
	const ua = String(navigator.userAgent || '');

	if (/Firefox\//i.test(ua)) return 'Firefox';
	if (/Edg\//i.test(ua)) return 'Edge';
	if (/Chrome\//i.test(ua)) return 'Chrome';
	if (/Safari\//i.test(ua)) return 'Safari';

	return 'Other';
}

/**
 * Best-effort published-runtime analytics.
 *
 * This must never block or break the AR experience.
 */
export function trackExperienceEvent(config, event) {
	const experience = runtimeMode(config);

	if (!experience) return;

	if (event !== 'open' && event !== 'start' && event !== 'capture') {
		return;
	}

	const eventUuid = randomId();
	const session = sessionId();

	if (!eventUuid || !session) return;

	const payload = {
		event_uuid: eventUuid,
		scene: sceneKey(),
		experience,
		event,
		session,
		journey: journeyId(config),
		device: deviceClass(),
		user_agent_family: userAgentFamily(),
	};

	try {
		void fetch(ENDPOINT, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify(payload),
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Analytics is observational only.
	}
}
