const DEFAULT_RUNTIME_URL = '/vendor/mindar/mindar-image.prod.js';

const DEFAULT_POSE_SMOOTHING_ALPHA = 0.40;
const DEFAULT_LOST_GRACE_MS = 120;

function clamp01(value) {
	return Math.max(0, Math.min(1, Number(value)));
}

function finiteMatrix16(matrix) {
	return (
		Array.isArray(matrix) &&
		matrix.length === 16 &&
		matrix.every((value) => Number.isFinite(Number(value)))
	);
}

function matrixPose(matrix) {
	if (!finiteMatrix16(matrix)) return null;

	const sx = Math.hypot(matrix[0], matrix[1], matrix[2]);
	const sy = Math.hypot(matrix[4], matrix[5], matrix[6]);
	const sz = Math.hypot(matrix[8], matrix[9], matrix[10]);

	if (!(sx > 1e-8) || !(sy > 1e-8) || !(sz > 1e-8)) return null;

	const m11 = matrix[0] / sx;
	const m12 = matrix[4] / sy;
	const m13 = matrix[8] / sz;
	const m21 = matrix[1] / sx;
	const m22 = matrix[5] / sy;
	const m23 = matrix[9] / sz;
	const m31 = matrix[2] / sx;
	const m32 = matrix[6] / sy;
	const m33 = matrix[10] / sz;

	let x;
	let y;
	let z;
	let w;

	const trace = m11 + m22 + m33;

	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		w = 0.25 / s;
		x = (m32 - m23) * s;
		y = (m13 - m31) * s;
		z = (m21 - m12) * s;
	} else if (m11 > m22 && m11 > m33) {
		const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
		w = (m32 - m23) / s;
		x = 0.25 * s;
		y = (m12 + m21) / s;
		z = (m13 + m31) / s;
	} else if (m22 > m33) {
		const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
		w = (m13 - m31) / s;
		x = (m12 + m21) / s;
		y = 0.25 * s;
		z = (m23 + m32) / s;
	} else {
		const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
		w = (m21 - m12) / s;
		x = (m13 + m31) / s;
		y = (m23 + m32) / s;
		z = 0.25 * s;
	}

	const qLen = Math.hypot(x, y, z, w);

	if (!(qLen > 1e-8)) return null;

	return {
		position: [
			Number(matrix[12]),
			Number(matrix[13]),
			Number(matrix[14]),
		],
		scale: [sx, sy, sz],
		quaternion: [
			x / qLen,
			y / qLen,
			z / qLen,
			w / qLen,
		],
	};
}

function slerpQuaternion(a, b, alpha) {
	let [bx, by, bz, bw] = b;
	const [ax, ay, az, aw] = a;

	let cosHalfTheta =
		ax * bx +
		ay * by +
		az * bz +
		aw * bw;

	// q and -q represent the same orientation. Choose the shorter path.
	if (cosHalfTheta < 0) {
		cosHalfTheta = -cosHalfTheta;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}

	if (cosHalfTheta >= 0.9995) {
		const x = ax + alpha * (bx - ax);
		const y = ay + alpha * (by - ay);
		const z = az + alpha * (bz - az);
		const w = aw + alpha * (bw - aw);
		const len = Math.hypot(x, y, z, w) || 1;

		return [x / len, y / len, z / len, w / len];
	}

	const halfTheta = Math.acos(
		Math.max(-1, Math.min(1, cosHalfTheta)),
	);

	const sinHalfTheta = Math.sin(halfTheta);

	if (Math.abs(sinHalfTheta) < 1e-6) {
		return [ax, ay, az, aw];
	}

	const ratioA =
		Math.sin((1 - alpha) * halfTheta) /
		sinHalfTheta;

	const ratioB =
		Math.sin(alpha * halfTheta) /
		sinHalfTheta;

	return [
		ax * ratioA + bx * ratioB,
		ay * ratioA + by * ratioB,
		az * ratioA + bz * ratioB,
		aw * ratioA + bw * ratioB,
	];
}

function composePose({ position, scale, quaternion }) {
	const [x, y, z, w] = quaternion;
	const [sx, sy, sz] = scale;

	const x2 = x + x;
	const y2 = y + y;
	const z2 = z + z;

	const xx = x * x2;
	const xy = x * y2;
	const xz = x * z2;
	const yy = y * y2;
	const yz = y * z2;
	const zz = z * z2;
	const wx = w * x2;
	const wy = w * y2;
	const wz = w * z2;

	return [
		(1 - (yy + zz)) * sx,
		(xy + wz) * sx,
		(xz - wy) * sx,
		0,

		(xy - wz) * sy,
		(1 - (xx + zz)) * sy,
		(yz + wx) * sy,
		0,

		(xz + wy) * sz,
		(yz - wx) * sz,
		(1 - (xx + yy)) * sz,
		0,

		position[0],
		position[1],
		position[2],
		1,
	];
}

function smoothPose(previousMatrix, nextMatrix, alpha) {
	if (!previousMatrix || alpha >= 1) return [...nextMatrix];
	if (alpha <= 0) return [...previousMatrix];

	const previous = matrixPose(previousMatrix);
	const next = matrixPose(nextMatrix);

	// Fail open to the real MindAR pose. Smoothing must never make tracking fail.
	if (!previous || !next) return [...nextMatrix];

	return composePose({
		position: previous.position.map(
			(value, index) =>
				value +
				(next.position[index] - value) * alpha,
		),
		scale: previous.scale.map(
			(value, index) =>
				value +
				(next.scale[index] - value) * alpha,
		),
		quaternion: slerpQuaternion(
			previous.quaternion,
			next.quaternion,
			alpha,
		),
	});
}

function waitForVideoMetadata(video) {
	if (
		video &&
		Number.isFinite(video.videoWidth) &&
		video.videoWidth > 0 &&
		Number.isFinite(video.videoHeight) &&
		video.videoHeight > 0
	) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		if (!video) {
			reject(new Error('marker tracker requires a video element'));
			return;
		}

		const onLoaded = () => {
			cleanup();
			resolve();
		};

		const onError = () => {
			cleanup();
			reject(new Error('camera video metadata could not be loaded'));
		};

		const cleanup = () => {
			video.removeEventListener('loadedmetadata', onLoaded);
			video.removeEventListener('error', onError);
		};

		video.addEventListener('loadedmetadata', onLoaded, { once: true });
		video.addEventListener('error', onError, { once: true });
	});
}

export class MarkerTracker {
	constructor({
		video,
		mindUrl,
		runtimeUrl = DEFAULT_RUNTIME_URL,
		poseSmoothingAlpha = DEFAULT_POSE_SMOOTHING_ALPHA,
		lostGraceMs = DEFAULT_LOST_GRACE_MS,
		onPose = null,
		onFound = null,
		onLost = null,
		onDiagnostic = null,
	} = {}) {
		this.video = video ?? null;
		this.mindUrl = String(mindUrl || '').trim();
		this.runtimeUrl = String(runtimeUrl || DEFAULT_RUNTIME_URL).trim();

		this.poseSmoothingAlpha = clamp01(
			Number.isFinite(Number(poseSmoothingAlpha))
				? Number(poseSmoothingAlpha)
				: DEFAULT_POSE_SMOOTHING_ALPHA,
		);

		this.lostGraceMs = Math.max(
			0,
			Number.isFinite(Number(lostGraceMs))
				? Number(lostGraceMs)
				: DEFAULT_LOST_GRACE_MS,
		);

		this.onPose = typeof onPose === 'function' ? onPose : null;
		this.onFound = typeof onFound === 'function' ? onFound : null;
		this.onLost = typeof onLost === 'function' ? onLost : null;
		this.onDiagnostic =
			typeof onDiagnostic === 'function' ? onDiagnostic : null;

		this.controller = null;
		this.running = false;
		this.visible = false;
		this.targetDimensions = null;
		this.projectionMatrix = null;
		this._disposed = false;
		this._startToken = 0;
		this._processedFrames = 0;
		this._lastPose = null;
		this._lostTimer = null;
	}

	async start() {
		if (this._disposed) {
			throw new Error('marker tracker has been disposed');
		}

		if (this.running) return;

		if (!this.video) {
			throw new Error('marker tracker requires a video element');
		}

		if (!this.mindUrl) {
			throw new Error('marker tracker requires a compiled MindAR target URL');
		}

		const token = ++this._startToken;

		await waitForVideoMetadata(this.video);

		if (this._disposed || token !== this._startToken) return;

		// MindAR's InputLoader draws HTMLVideoElement frames using the element's
		// `width` / `height` properties, not `videoWidth` / `videoHeight`.
		// Its official browser wrapper synchronizes these attributes immediately
		// after loadedmetadata; do the same when reusing AR Studio's video.
		this.video.width = this.video.videoWidth;
		this.video.height = this.video.videoHeight;

		const mod = await import(
			/* @vite-ignore */
			this.runtimeUrl
		);

		if (this._disposed || token !== this._startToken) return;

		const Controller = mod?.Controller;

		if (typeof Controller !== 'function') {
			throw new Error('MindAR runtime did not expose Controller');
		}

		const controller = new Controller({
			inputWidth: this.video.videoWidth,
			inputHeight: this.video.videoHeight,
			maxTrack: 1,
			onUpdate: (event) => this._handleUpdate(event),
		});

		try {
			const result = await controller.addImageTargets(this.mindUrl);

			if (
				!result ||
				!Array.isArray(result.dimensions) ||
				result.dimensions.length < 1
			) {
				throw new Error('compiled MindAR target contains no image targets');
			}

			const dimensions = result.dimensions[0];

			if (
				!Array.isArray(dimensions) ||
				dimensions.length < 2 ||
				!(Number(dimensions[0]) > 0) ||
				!(Number(dimensions[1]) > 0)
			) {
				throw new Error('compiled MindAR target has invalid dimensions');
			}

			this.targetDimensions = [
				Number(dimensions[0]),
				Number(dimensions[1]),
			];

			const projection = controller.getProjectionMatrix?.();

			if (
				Array.isArray(projection) &&
				projection.length === 16
			) {
				this.projectionMatrix = [...projection];
			} else {
				this.projectionMatrix = null;
			}

			if (this._disposed || token !== this._startToken) {
				controller.dispose?.();
				return;
			}

			await controller.dummyRun(this.video);

			if (this._disposed || token !== this._startToken) {
				controller.dispose?.();
				return;
			}

			this.controller = controller;
			this.running = true;
			this.visible = false;
			this._processedFrames = 0;
			this._lastPose = null;
			clearTimeout(this._lostTimer);
			this._lostTimer = null;

			controller.processVideo(this.video);
		} catch (err) {
			controller.dispose?.();
			throw err;
		}
	}

	stop() {
		++this._startToken;

		clearTimeout(this._lostTimer);
		this._lostTimer = null;
		this._lastPose = null;

		if (this.controller) {
			try {
				this.controller.stopProcessVideo?.();
			} catch {
				// MindAR teardown is best-effort.
			}
		}

		if (this.visible) {
			this.visible = false;
			this.onLost?.();
		}

		this.running = false;
	}

	dispose() {
		if (this._disposed) return;

		this.stop();

		if (this.controller) {
			try {
				this.controller.dispose?.();
			} catch {
				// MindAR teardown is best-effort.
			}
		}

		this.controller = null;
		this._disposed = true;
	}

	_handleUpdate(event) {
		if (!this.running || this._disposed) return;

		if (event?.type === 'processDone') {
			this._processedFrames++;

			if (
				this.onDiagnostic &&
				(
					this._processedFrames === 1 ||
					this._processedFrames % 30 === 0
				)
			) {
				const state = this.controller?.trackingStates?.[0];

				this.onDiagnostic({
					frames: this._processedFrames,
					isTracking: Boolean(state?.isTracking),
					showing: Boolean(state?.showing),
					trackCount: Number(state?.trackCount) || 0,
					trackMiss: Number(state?.trackMiss) || 0,
				});
			}

			return;
		}

		if (
			event?.type !== 'updateMatrix' ||
			event?.targetIndex !== 0
		) {
			return;
		}

		const matrix = event.worldMatrix;

		if (matrix === null) {
			if (!this.visible || this._lostTimer) return;

			const finishLoss = () => {
				this._lostTimer = null;

				if (
					!this.running ||
					this._disposed ||
					!this.visible
				) return;

				this.visible = false;
				this._lastPose = null;
				this.onLost?.();
			};

			if (this.lostGraceMs <= 0) {
				finishLoss();
			} else {
				this._lostTimer = setTimeout(
					finishLoss,
					this.lostGraceMs,
				);
			}

			return;
		}

		if (!finiteMatrix16(matrix)) return;

		clearTimeout(this._lostTimer);
		this._lostTimer = null;

		if (!this.visible) {
			this.visible = true;
			this._lastPose = null;
			this.onFound?.();
		}

		const filtered = smoothPose(
			this._lastPose,
			matrix,
			this.poseSmoothingAlpha,
		);

		this._lastPose = [...filtered];
		this.onPose?.([...filtered]);
	}
}

export {
	DEFAULT_RUNTIME_URL,
	DEFAULT_POSE_SMOOTHING_ALPHA,
	DEFAULT_LOST_GRACE_MS,
};
