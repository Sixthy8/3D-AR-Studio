const DEFAULT_RUNTIME_URL = '/vendor/mindar/mindar-image.prod.js';

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
		onPose = null,
		onFound = null,
		onLost = null,
		onDiagnostic = null,
	} = {}) {
		this.video = video ?? null;
		this.mindUrl = String(mindUrl || '').trim();
		this.runtimeUrl = String(runtimeUrl || DEFAULT_RUNTIME_URL).trim();

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

			controller.processVideo(this.video);
		} catch (err) {
			controller.dispose?.();
			throw err;
		}
	}

	stop() {
		++this._startToken;

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
			if (this.visible) {
				this.visible = false;
				this.onLost?.();
			}
			return;
		}

		if (!Array.isArray(matrix) || matrix.length !== 16) return;

		if (!this.visible) {
			this.visible = true;
			this.onFound?.();
		}

		this.onPose?.([...matrix]);
	}
}

export { DEFAULT_RUNTIME_URL };
