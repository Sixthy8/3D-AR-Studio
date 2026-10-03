// AR Studio: a live, multi-model AR scene through the device camera.
//
// Every other web-AR drop-in places exactly one model and hands off to a native
// viewer. This one keeps the whole scene in your page: place any number of
// models, arrange them by hand, generate new ones from a prompt without leaving
// the camera, share the arrangement as a link or a QR code, and build in the
// same room as someone else in real time.
//
// Rendering ladder, best first: every device gets the richest path it can:
//
//   1. WebXR immersive-ar (Android Chrome, headsets): a hit-test reticle that
//      stays armed for the whole session, one XRAnchor per placed model,
//      real-world lighting estimation, and depth occlusion so a model hides
//      behind your couch instead of painting over it.
//   2. Camera passthrough (iOS Safari, and anywhere else with a camera):
//      transparent WebGL over the live feed, gyro world-lock, and room-light
//      matching sampled from the actual video frames.
//   3. Preview (desktop, no camera): the same scene on a grid floor with
//      drag-look and a QR hand-off to a phone.
//
// The scene persists to localStorage and round-trips through the URL, so an
// arrangement composed on a laptop reopens exactly on a phone.
//
// Ported and generalized from the three.ws AR Studio (Apache-2.0).

import {
	AnimationMixer, Box3, CanvasTexture, Color, DirectionalLight, Fog, GridHelper, Group,
	HemisphereLight, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry,
	Raycaster, RingGeometry, Scene, TextureLoader, Vector2, Vector3,
	WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { resolveConfig } from '../config.js';
import { createLogger } from '../log.js';
import { renderQRToSVG } from '../qr.js';
import { createForgeClient } from '../forge/client.js';
import { resolveSources } from '../sources/index.js';
import { rememberRecent } from '../sources/recents.js';
import { buildArLaunchUrl } from '../ar-launch.js';

import { applyCinematicDefaults, detectQualityTier, loadEnvironment } from './render.js';
import { buildUI, el } from './ui.js';
import {
	getExperienceJourneyId,
	getExperienceSceneKey,
	getExperienceSessionId,
	trackExperienceEvent,
} from './analytics.js';
import { EstimatedLighting } from './estimated-lighting.js';
import { MultiPlaceSession } from './multi-place.js';
import { MarkerTracker } from './marker-tracker.js';
import { createLoadQueue } from './load-queue.js';
import { sharedGLTFLoader } from './loaders.js';
import { mountIdle } from './idle.js';
import { captureComposite, shareOrDownload, shareUrlOrCopy } from './capture.js';
import {
	arCapability, isQuickLookReady, placeInYourSpace, prepareNativeAr, releaseQuickLook,
} from './native-ar.js';
import { deriveVerticalFovDeg, DEFAULT_DIAG_FOV_DEG } from './camera-fov.js';
import { clampPitch, isFiniteReading, resolveLockYaw, screenPitchDeg } from './sensor-fusion.js';
import {
	createPinchState, pinchEnd, pinchMove, pinchStart, touchDist,
	PINCH_SCALE_MAX, PINCH_SCALE_MIN,
} from './pinch.js';
import {
	deserializeScene, deserializeSceneDocument, fitTransform, MAX_PLACEMENTS,
	normalizeGlbUrl, normalizeSceneAction, normalizeSceneTarget, normalizeSceneType, roomLightFromPixels,
	sceneDocumentFromHashParam, sceneFromHashParam, serializeScene,
	SPAWN_DISTANCE_M, spawnPointInFront,
	studioSceneUrl, studioShareUrl, touchAngle, twistDelta,
} from './scene-math.js';
import {
	generateRoomCode, localToShared, normalizeRoomCode, roomKeyForCode, roomShareUrl, sharedToLocal,
} from './coords.js';
import { StudioNet } from './net.js';
import { SavedSceneError, createSavedSceneClient } from './saved-scenes.js';

const log = createLogger('ar-studio');

const EYE_HEIGHT_M = 1.55;
const PITCH_MIN = -1.25;
const PITCH_MAX = 1.35;
const HEMI_BASE = 1.0;
const SUN_BASE = 1.15;
const LIST_SLICE = 60;

/** One live studio. Prefer `createArStudio()` over constructing this directly. */
export class ArStudio {
	/**
	 * @param {HTMLElement} host  Where the studio mounts.
	 * @param {object} [options]  See src/config.js for every field.
	 */
	constructor(host, options = {}) {
		if (!host) throw new Error('ar-studio: a host element is required');
		this.host = host;
		this.config = resolveConfig(options);
		this._savedScenes = createSavedSceneClient({ endpoint: this.config.savedScenesEndpoint });
		this.clientId = readClientId(this.config.persistKey);
		this.sources = resolveSources(this.config.assets, this.config);
		this._listeners = new Map();
		this._destroyed = false;

		this.ui = buildUI(host, this.config);
		if (this.config.fullscreen ?? (host === document.body)) this.ui.root.classList.add('is-fullscreen');

		if (this.config.urlExperience) {
			this.ui.root.classList.add(
				'is-experience',
				`is-experience-${this.config.urlExperience}`,
			);
		}

		this._initScene();
		this._initState();
		this._wireUI();
		this._boot();
	}

	// ── Events ────────────────────────────────────────────────────────────────

	/**
	 * Subscribe to a studio event. Returns an unsubscribe function.
	 * Events: `add` `remove` `select` `clear` `generate` `generate-error`
	 * `camera` `xr` `room` `share`.
	 */
	on(event, fn) {
		if (!this._listeners.has(event)) this._listeners.set(event, new Set());
		this._listeners.get(event).add(fn);
		return () => this.off(event, fn);
	}

	off(event, fn) {
		this._listeners.get(event)?.delete(fn);
	}

	_emit(event, detail = {}) {
		for (const fn of this._listeners.get(event) || []) {
			try { fn(detail); } catch (err) { log.warn(`${event} listener error`, err); }
		}
		try { this.config.onEvent?.(event, detail); } catch (err) { log.warn('onEvent error', err); }
		try {
			this.ui.root.dispatchEvent(new CustomEvent(`ar-studio:${event}`, { detail, bubbles: true }));
		} catch { /* no CustomEvent in this host */ }
	}

	// ── Scene ─────────────────────────────────────────────────────────────────

	_initScene() {
		this.renderer = new WebGLRenderer({
			canvas: this.ui.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
		});
		this.renderer.setClearColor(0x000000, 0);
		this.qualityTier = detectQualityTier();
		applyCinematicDefaults(this.renderer, { tier: this.qualityTier });

		this.scene = new Scene();
		this.camera = new PerspectiveCamera(58, 1, 0.02, 200);
		this.camera.position.set(0, EYE_HEIGHT_M, 0);
		this.cameraYaw = 0;
		// Tilted down enough that the floor, and anything standing on it, is in
		// frame before the viewer touches anything.
		this.cameraPitch = -0.24;

		const preset = this.qualityTier === 'mobile' ? null : (this.config.lighting?.preset ?? 'studio');
		loadEnvironment(this.renderer, this.scene, preset, { urls: this.config.lighting?.urls })
			.catch((err) => log.warn('environment map failed', err));

		this.hemi = new HemisphereLight(0xffffff, 0x444455, HEMI_BASE);
		this.sun = new DirectionalLight(0xffffff, SUN_BASE);
		this.sun.position.set(2.5, 6, 3);
		this.scene.add(this.hemi, this.sun);

		// Preview-mode floor: a calm grid that hides the moment the camera feed
		// becomes the ground truth. The invisible ray plane is the drag target in
		// both modes. Distance fog fades the far lines out instead of letting them
		// collapse into a moire band along the horizon, which is what a flat grid
		// viewed at a shallow angle does otherwise. It starts well beyond any
		// placement, so it never touches a model.
		this.grid = new GridHelper(24, 48, 0x3a3f52, 0x23273a);
		this.grid.position.y = 0.001;
		this.grid.material.transparent = true;
		this.grid.material.opacity = 0.75;
		this._fog = new Fog(0x06070a, 5, 17);
		this.scene.fog = this._fog;
		this.scene.add(this.grid);
		this.rayPlane = new Mesh(new PlaneGeometry(80, 80), new MeshBasicMaterial({ visible: false, side: 2 }));
		this.rayPlane.rotation.x = -Math.PI / 2;
		this.scene.add(this.rayPlane);

		this.selRing = new Mesh(
			new RingGeometry(0.3, 0.34, 48).rotateX(-Math.PI / 2),
			new MeshBasicMaterial({ color: 0x8b7cf8, transparent: true, opacity: 0.85, depthTest: false }),
		);
		if (this.config.branding?.accent) {
			try { this.selRing.material.color.set(this.config.branding.accent); } catch { /* keep default */ }
		}
		this.selRing.renderOrder = 998;
		this.selRing.visible = false;
		this.scene.add(this.selRing);

		// Desktop/editor transform gizmo. The helper itself is ordinary scene
		// content, while TransformControls owns pointer interaction on the canvas.
		this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
		this.transformHelper = this.transformControls.getHelper();
		this.transformHelper.visible = false;
		this.scene.add(this.transformHelper);

		this.transformControls.setSpace('world');
		this.transformControls.setMode('translate');
		this.transformControls.size = 0.85;

		this.shadowTex = makeShadowTexture();
		this.reducedMotion = prefersReducedMotion();
		this._applyCameraLook();
	}

	_initState() {
		/** @type {Array<object>} */
		this.placements = [];

		// Scene-document metadata. `free` scenes remain exactly compatible with
		// the historical placement-only format; marker scenes add optional target
		// metadata around those same placements.
		this.sceneType = 'free';
		this.sceneTarget = null;

		// Saved Scene identity is editor state only. It is deliberately separate
		// from the local recovery document and from published experience URLs.
		this.currentSavedSceneId = null;
		this.currentSavedSceneName = '';
		this.currentSavedSceneRevision = null;
		this.savedSceneBaseline = JSON.stringify({ v: 1, items: [] });
		this.dirty = false;
		this.savedSceneBusy = false;

		// Editor-only target preview. This is deliberately not a placement, so it
		// cannot be selected, grouped, duplicated, deleted, or exported to USDZ.
		this.targetPreview = {
			mesh: null,
			texture: null,
		};

		this._targetTextureToken = 0;

		// `selected` remains the single-object transform target.
		// `_selection` is editor-only and may contain zero, one, or many placement IDs.
		this.selected = null;
		this._selection = new Set();

		// Phase 1 grouping is editor-runtime only. Models remain independent scene
		// placements; this helper pivot drives their transforms without re-parenting
		// them or changing the persisted scene format.
		this._runtimeGroup = null;
		this.arActive = false;
		this.mediaStream = null;
		this.markerTracker = null;

		// Runtime-only MindAR proof objects. Authored placement transforms remain
		// untouched; this layer exists only while live marker tracking is active.
		this.markerPoseRoot = null;
		this.markerContentRoot = null;
		this.markerPostMatrix = null;
		this._markerCameraRestore = null;

		this.arTransitioning = false;
		this.xrSession = null;
		this.estimatedLight = null;
		/** 'webxr' | 'quicklook' | 'sceneviewer' | 'none', resolved at boot. */
		this.arMode = 'none';
		/** True while the device's own AR viewer has the stage we stood down for. */
		this._cameraYielded = false;
		this._cameraWasOn = false;
		this._onArReturn = null;
		this._nativeArBusy = false;
		/** The hand-off the AR sheet's button will fire, once it is prepared. */
		this._arHandoff = null;
		this._arTarget = null;
		/** Prepared Quick Look hand-off for the whole composed scene. */
		this._arSceneHandoff = null;
		this._arSceneKey = '';
		/** Bumped on every sheet open and target change so a slow, stale
		 *  conversion can never enable the button for the wrong model. */
		this._arToken = 0;
		this._arWarmTimer = null;
		/** Set when a conversion failed and the sheet's button is a retry. */
		this._arRetry = null;
		/** USDZ cache keys this studio created, so destroy() frees only its own. */
		this._arKeys = new Set();
		this.arTrackW = 0;
		this.arTrackH = 0;

		this._statusTimer = null;
		this._armed = null;
		this._templates = new Map();
		this._templatesReady = new Map();
		this._trayCache = new Map();
		this._trayTab = this.sources[0]?.id || 'link';
		this._loadQueue = createLoadQueue({ run: (src) => sharedGLTFLoader().loadAsync(src), maxActive: 3 });
		this._maxPlacements = Math.min(Number(this.config.maxPlacements) || MAX_PLACEMENTS, MAX_PLACEMENTS);

		this.net = null;
		this.roomCode = '';
		this._netModels = new Map();
		this._presence = { count: 1, names: [] };
		this._roomSynced = false;
		this._roomHeartbeat = null;

		this.forge = this.config.generate?.enabled === false ? null : createForgeClient({
			endpoint: this.config.generate.endpoint,
			kind: this.config.generate.kind,
			tier: this.config.generate.tier,
			timeoutMs: this.config.generate.timeoutMs,
			pollMs: this.config.generate.pollMs,
			headers: this.config.generate.headers,
		});
		this._forgeSeq = 0;
		this._forgeBusy = false;

		this.gyroBase = null;
		this._devAlpha = 0;
		this._devBeta = 90;
		this._devGamma = 0;
		this._absoluteOrientation = false;
		this._raycaster = new Raycaster();
		this._ndc = new Vector2();
		this._pointer = null;
		this._userLooked = false;

		this._transformMode = 'translate';
		this._gizmoDragging = false;
		this._gizmoStartScale = 1;

		// Editor-only transform snapping. These values affect manipulation only;
		// the scene always stores the exact transform that results.
		this._snapEnabled = false;
		this._translationSnap = 0.10;
		this._rotationSnapDeg = 15;
		this._scaleSnap = 0.10;
		this._pinch = createPinchState();
		this._pinchEndedAt = -Infinity;
		this._twist = null;
		this._rafId = null;
		this._prevT = 0;
		this._lightTimer = null;
		this._roomTint = new Color();
		this._lightProbe = makeLightProbe();
		this._recentKey = `${this.config.persistKey}:recent`;
		this.config.recentKey = this._recentKey;
	}

	// ── Wiring ────────────────────────────────────────────────────────────────

	_wireUI() {
		const u = this.ui;
		const bind = (node, type, fn, opts) => {
			if (!node) return;
			node.addEventListener(type, fn, opts);
		};

		bind(u.savedSceneNew, 'click', () => this._newSavedSceneFromUi());
		bind(u.savedSceneOpen, 'click', () => this._openSavedScenesPanel());
		bind(u.savedSceneSave, 'click', () => this._saveSavedSceneFromUi());
		bind(u.savedSceneSaveAs, 'click', () => this._saveSavedSceneAsFromUi());
		bind(u.savedSceneRename, 'click', () => this._renameSavedSceneFromUi());
		bind(u.savedSceneDuplicate, 'click', () => this._duplicateSavedSceneFromUi());
		bind(u.savedSceneDelete, 'click', () => this._deleteSavedSceneFromUi());
		bind(u.savedScenePanelClose, 'click', () => this._closeSavedScenePanel());
		bind(u.savedScenePanel, 'click', (e) => {
			if (e.target === u.savedScenePanel) this._closeSavedScenePanel();
			const button = e.target.closest?.('[data-saved-scene-open]');
			if (button) this._openSavedSceneFromUi(button.dataset.savedSceneOpen);
		});
		bind(u.savedSceneNameCancel, 'click', () => this._resolveSavedSceneDialog(null));
		bind(u.savedSceneNameSubmit, 'click', () => this._submitSavedSceneNameDialog());
		bind(u.savedSceneNameInput, 'keydown', (e) => { if (e.key === 'Enter') this._submitSavedSceneNameDialog(); });
		bind(u.savedSceneDecisionSave, 'click', () => this._resolveSavedSceneDialog('save'));
		bind(u.savedSceneDecisionDiscard, 'click', () => this._resolveSavedSceneDialog('discard'));
		bind(u.savedSceneDecisionCancel, 'click', () => this._resolveSavedSceneDialog('cancel'));
		bind(u.savedSceneConfirmCancel, 'click', () => this._resolveSavedSceneDialog(false));
		bind(u.savedSceneConfirmSubmit, 'click', () => this._resolveSavedSceneDialog(true));
		this._syncSavedSceneUi();

		bind(u.cameraBtn, 'click', () => {
			if (this.arTransitioning || this.xrSession) return;
			if (this.arActive) {
				this._stopCamera();
				this._setStatus('Camera off: preview mode.');
			} else {
				this._startCamera();
			}
		});
		if (!navigator.mediaDevices?.getUserMedia && u.cameraBtn) {
			u.cameraBtn.disabled = true;
			u.cameraBtn.setAttribute('aria-disabled', 'true');
			u.cameraBtn.title = 'This browser cannot open a camera';
		}

		bind(u.xrBtn, 'click', () => this._enterAR());
		bind(u.addBtn, 'click', () => (u.tray.hidden ? this._openTray() : this._closeTray()));
		bind(u.trayClose, 'click', () => this._closeTray());
		bind(u.tray, 'click', (e) => { if (e.target === u.tray) this._closeTray(); });
		bind(u.emptyAdd, 'click', () => this._openTray());
		bind(u.emptyCamera, 'click', () => this._startCamera());
		bind(u.emptyForge, 'click', () => u.forgeInput?.focus());

		bind(u.forgeForm, 'submit', (e) => {
			e.preventDefault();
			this._startForge(u.forgeInput?.value);
		});

		bind(u.clearBtn, 'click', () => this._clearWithUndo());
		bind(u.photoBtn, 'click', () => this._capturePhoto());
		bind(u.runtimePhotoBtn, 'click', () => this._capturePhoto());
		bind(u.runtimePrimary, 'click', () => this._onRuntimePrimary());
		bind(u.runtimeMobileBtn, 'click', () => {
			const mode = this.config.urlExperience;
			if (mode === 'space' || mode === 'marker') {
				this._openQr(this._experienceUrl(mode));
			}
		});
		bind(u.qrBtn, 'click', () => this._openQr());
		bind(u.qrClose, 'click', () => this._closeQr());
		bind(u.qrModal, 'click', (e) => { if (e.target === u.qrModal) this._closeQr(); });

		bind(u.exportBtn, 'click', () => this._openExport());
		bind(u.exportClose, 'click', () => this._closeExport());
		bind(u.exportModal, 'click', (e) => {
			if (e.target === u.exportModal) this._closeExport();
		});

		bind(u.arClose, 'click', () => this._closeArSheet());
		bind(u.arModal, 'click', (e) => { if (e.target === u.arModal) this._closeArSheet(); });
		bind(u.arGo, 'click', () => this._onArGo());
		bind(u.arScene, 'click', () => this._onArSceneGo());
		bind(u.arXr, 'click', () => { this._closeArSheet(); this._toggleXR(); });
		bind(u.arQr, 'click', () => { this._closeArSheet(); this._openQr(); });
		bind(u.arPicker, 'click', (e) => {
			const chip = e.target.closest('[data-ar-id]');
			if (!chip) return;
			const next = this.placements.find((pl) => pl.id === chip.dataset.arId);
			if (next) this._showArTarget(next);
		});

		bind(u.selbar, 'click', (e) => this._onSelbarClick(e));

		bind(u.sceneBtn, 'click', () => this._toggleSceneTree());
		bind(u.sceneClose, 'click', () => this._closeSceneTree());
		bind(u.sceneList, 'click', (e) => this._onSceneTreeClick(e));

		bind(u.sceneTypeSelect, 'change', () => {
			this._setSceneType(u.sceneTypeSelect.value);
		});

		bind(u.sceneTargetWidth, 'change', () => {
			this._updateSceneTargetFromUI();
		});

		bind(u.sceneTargetHeight, 'change', () => {
			this._updateSceneTargetFromUI();
		});

		bind(u.sceneTargetVisible, 'change', () => {
			this._updateSceneTargetFromUI();
		});

		bind(u.sceneTargetChoose, 'click', () => {
			u.sceneTargetFile?.click();
		});

		bind(u.sceneTargetFile, 'change', () => {
			const file = u.sceneTargetFile?.files?.[0];
			if (file) this._uploadTargetImage(file);
		});

		bind(u.sceneTargetRemove, 'click', () => {
			this._removeTargetImage();
		});

		bind(u.sceneFocusTarget, 'click', () => {
			this._focusTargetView();
		});

		bind(u.sceneResetView, 'click', () => {
			this._resetEditorView();
		});

		bind(u.roomBtn, 'click', () => this._openRoomModal());
		bind(u.roomClose, 'click', () => this._closeRoomModal());
		bind(u.roomModal, 'click', (e) => { if (e.target === u.roomModal) this._closeRoomModal(); });
		bind(u.roomCreate, 'click', () => this._createRoomFromUI());
		bind(u.roomJoinForm, 'submit', (e) => {
			e.preventDefault();
			this._joinRoomFromUI();
		});
		bind(u.roomCopy, 'click', () => this._copyRoomInvite());
		bind(u.roomLeave, 'click', () => {
			this._leaveRoom();
			this._renderRoomModal();
		});

		// Transform inspector + gizmo.
		bind(u.transformModes, 'click', (e) => {
			const btn = e.target.closest('[data-transform-mode]');
			if (!btn) return;
			this._setTransformMode(btn.dataset.transformMode);
		});

		bind(u.transformFields, 'change', (e) => this._onTransformFieldChange(e));

		bind(u.transformSnapToggle, 'change', () => {
			this._snapEnabled = Boolean(u.transformSnapToggle.checked);
			this._applyTransformSnapSettings();
		});

		bind(u.transformSnapFields, 'change', (e) => {
			this._onTransformSnapFieldChange(e);
		});

		bind(u.transformGround, 'click', () => this._snapSelectedToGround());
		bind(u.transformReset, 'click', () => this._resetSelectedTransform());

		bind(u.transformGroupActions, 'click', (e) => {
			const btn = e.target.closest('[data-group-action]');
			if (!btn) return;

			if (btn.dataset.groupAction === 'visibility') {
				this._toggleActiveGroupVisibility();
			} else if (btn.dataset.groupAction === 'ungroup') {
				this._ungroupRuntimeSelection();
			}
		});

		this._applyTransformSnapSettings();

		this.transformControls.addEventListener('mouseDown', () => {
			this._gizmoDragging = true;
			this._pointer = null;
			if (this.selected) this._gizmoStartScale = this._logicalScale(this.selected);
		});

		this.transformControls.addEventListener('objectChange', () => {
			this._onGizmoObjectChange();
		});

		this.transformControls.addEventListener('mouseUp', () => {
			this._gizmoDragging = false;

			if (
				this._runtimeGroup
				&& this.transformControls?.object === this._runtimeGroup.pivot
			) {
				this._finalizeRuntimeGroupTransform();
				return;
			}

			const p = this.selected;
			if (!p) return;

			p._lastNetSend = 0;
			this._netBroadcastTransform(p);
			this._saveScene();
			this._warmQuickLook();
			this._syncTransformInspector();
		});

		// Canvas gestures
		const c = u.canvas;
		bind(c, 'pointerdown', (e) => this._onPointerDown(e));
		bind(c, 'pointermove', (e) => this._onPointerMove(e));
		bind(c, 'pointerup', (e) => this._onPointerUp(e));
		bind(c, 'pointercancel', () => { this._pointer = null; });

		// Desktop editor navigation. Wheel/trackpad changes camera position only;
		// scene/model scale remains physically correct.
		bind(c, 'wheel', (e) => this._onEditorWheel(e), { passive: false });

		bind(c, 'touchstart', (e) => this._onTouchStart(e), { passive: true });
		bind(c, 'touchmove', (e) => this._onTouchMove(e), { passive: true });
		bind(c, 'touchend', () => this._onTouchEnd(), { passive: true });

		this._onKeyDown = this._onKeyDown.bind(this);
		document.addEventListener('keydown', this._onKeyDown);

		this._onOrientationAbsolute = (e) => { this._absoluteOrientation = true; this._onDeviceOrientation(e); };
		this._onOrientation = (e) => { if (!this._absoluteOrientation) this._onDeviceOrientation(e); };
		window.addEventListener('deviceorientationabsolute', this._onOrientationAbsolute, true);
		window.addEventListener('deviceorientation', this._onOrientation, true);

		this._onResize = () => this._resize();
		window.addEventListener('resize', this._onResize);
		this._onPageHide = () => {
			this._stopCamera();
			this.xrSession?.end();
			this.net?.destroy();
		};
		window.addEventListener('pagehide', this._onPageHide);
		this._onBeforeUnload = (e) => {
			if (this.config.urlExperience || !this.dirty) return;
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', this._onBeforeUnload);

		// The host element can resize without the window doing so (a flex layout,
		// a drawer opening), and a stale drawing buffer looks like a broken canvas.
		if (typeof ResizeObserver !== 'undefined') {
			this._ro = new ResizeObserver(() => this._resize());
			this._ro.observe(u.root);
		}

		this._wireTrayTabs();
	}

	_boot() {
		this._resize();
		this._updateCount();
		this._updateRoomButton();
		this._startLoop();

		// One AR button, labelled for what this device will actually do. An iPhone
		// has no WebXR, but it has ARKit through Quick Look, and offering it the
		// camera-passthrough approximation instead would be strictly worse: the
		// native viewer gets real plane detection, real scale and real occlusion.
		arCapability().then((cap) => {
			this.arMode = cap;
			const btn = this.ui.xrBtn;
			if (!btn || cap === 'none') return;
			btn.hidden = false;
			const label = btn.querySelector('.ars-ar-label');
			if (cap === 'webxr') {
				if (label) label.textContent = 'Immersive AR';
				btn.setAttribute('aria-label', 'Enter immersive augmented reality and place models on real surfaces');
			} else {
				if (label) label.textContent = 'Place in your space';
				btn.setAttribute('aria-label', 'Open this in your device AR viewer and place it in your real space');
			}
		});
		// Desktop leads with the QR hand-off; a phone is already the target device.
		const coarse = window.matchMedia?.('(pointer: coarse)').matches;
		if (!coarse && this.ui.qrBtn) this.ui.qrBtn.hidden = false;

		const bootRoom = normalizeRoomCode(this.config.urlRoom || '');
		this._restoreScene({ skipLocal: !!bootRoom }).then(async () => {
			if (bootRoom) this._joinRoom(bootRoom);
			if (this.config.urlPrompt && this.config.urlPrompt.length >= 3 && this.ui.forgeInput) {
				this.ui.forgeInput.value = this.config.urlPrompt;
				this._startForge(this.config.urlPrompt);
			}

			await this._activateExperienceMode();

			if (
				this.config.urlExperience === 'space' ||
				this.config.urlExperience === 'marker'
			) {
				trackExperienceEvent(this.config, 'open');
			}
		});
	}

	async _activateExperienceMode() {
		const mode = this.config.urlExperience;

		if (mode !== 'space' && mode !== 'marker') return;

		// Published experiences are never editable Saved Scene documents.
		this.clearSavedSceneIdentity({ dirty: false });

		// Published experiences are viewers, not editors. Remove editor-only
		// selection state and helpers without touching authored scene transforms.
		this._dropRuntimeGroup();
		this._selection.clear();
		this.selected = null;
		this.selRing.visible = false;
		this._detachTransformGizmo();

		if (this.targetPreview?.mesh) {
			this.targetPreview.mesh.visible = false;
		}

		// Keep exported previews clean: the editor grid/fog are authoring aids.
		this.grid.visible = false;
		this.scene.fog = null;

		this._syncRuntimeControls();

		if (mode === 'space') {
			this._setStatus('Ready to place in your space.');
			return;
		}

		const markerReady =
			(this.sceneType === 'marker-horizontal' ||
			this.sceneType === 'marker-vertical') &&
			Boolean(this.sceneTarget?.mind);

		if (!markerReady) {
			this._setStatus(
				'This Marker AR link does not contain a compiled marker target.',
				{ warn: true, sticky: true },
			);
			if (this.ui.runtimePrimary) this.ui.runtimePrimary.disabled = true;
			return;
		}

		// Published Marker AR waits for an explicit user gesture before requesting
		// camera permission. This keeps the landing experience calm and makes the
		// browser permission prompt a direct consequence of tapping Start Marker AR.
		this._setStatus('Tap Start Marker AR to begin.');
		this._syncRuntimeControls();
	}

	_syncRuntimeControls() {
		const mode = this.config.urlExperience;
		const btn = this.ui.runtimePrimary;
		const label = btn?.querySelector('.ars-runtime-primary-label');

		if (this.ui.runtimeMobileBtn) {
			const coarse = window.matchMedia?.('(pointer: coarse)').matches;
			this.ui.runtimeMobileBtn.hidden =
				(mode !== 'space' && mode !== 'marker') ||
				Boolean(coarse);
		}

		if (!btn || !label) return;

		if (mode === 'marker') {
			btn.disabled = false;
			label.textContent = this.arActive
				? 'Stop camera'
				: 'Start Marker AR';
			btn.setAttribute(
				'aria-label',
				this.arActive
					? 'Stop the marker camera'
					: 'Start marker augmented reality',
			);
		} else if (mode === 'space') {
			btn.disabled = this.placements.length === 0;
			label.textContent = 'Place in your space';
			btn.setAttribute('aria-label', 'Place this scene in your space');
		}
	}

	_onRuntimePrimary() {
		if (this.config.urlExperience === 'space') {
			this._enterAR();
			return;
		}

		if (this.config.urlExperience === 'marker') {
			if (this.arActive) {
				this._stopCamera();
				this._setStatus('Camera stopped.');
			} else {
				this._startCamera();
			}
		}
	}

	// ── Status + counters ─────────────────────────────────────────────────────

	_setStatus(message, { warn = false, sticky = false, actionLabel = '', onAction = null } = {}) {
		const node = this.ui.status;
		if (!node) return;
		clearTimeout(this._statusTimer);
		node.textContent = '';
		if (!message) {
			node.hidden = true;
			return;
		}
		node.hidden = false;
		node.classList.toggle('is-warn', warn);
		node.appendChild(el('span', { text: message }));
		if (actionLabel && onAction) {
			node.appendChild(el('button', {
				type: 'button', class: 'ars-status-action', text: actionLabel,
				onclick: () => { this._setStatus(null); onAction(); },
			}));
		}
		if (!sticky) this._statusTimer = setTimeout(() => { node.hidden = true; }, 5200);
	}

	_updateCount() {
		const n = this.placements.length;
		const {
			count,
			clearBtn,
			empty,
			photoBtn,
			runtimePhotoBtn,
		} = this.ui;
		if (count) {
			if (this.net && this.net.status === 'online' && this._presence.count > 1) {
				count.textContent = `${this._presence.count} here · ${n} ${n === 1 ? 'model' : 'models'}`;
				count.hidden = false;
			} else {
				count.textContent = n === 1 ? '1 model' : `${n} models`;
				count.hidden = n === 0;
			}
		}
		if (clearBtn) clearBtn.hidden = n === 0;
		if (empty) empty.hidden = n > 0;
		if (photoBtn) photoBtn.disabled = n === 0;
		if (runtimePhotoBtn) runtimePhotoBtn.disabled = n === 0;
		this._syncRuntimeControls();
		// Scene setup exists independently of placements. An empty marker scene is
		// still a valid document, so the Scene panel must always remain reachable.
		if (this.ui.sceneBtn) this.ui.sceneBtn.hidden = false;
		this._renderSceneTree();
	}

	// ── Scene document / marker target ───────────────────────────────────────

	_sceneMetadata() {
		return {
			type: this.sceneType,
			target: this.sceneTarget
				? { ...this.sceneTarget }
				: null,
		};
	}

	_defaultSceneTarget(type) {
		const orientation = type === 'marker-vertical'
			? 'vertical'
			: 'horizontal';

		// Useful print defaults:
		// horizontal = US business card, vertical = 18 × 24 inch poster.
		const width = orientation === 'vertical' ? 0.4572 : 0.0889;
		const height = orientation === 'vertical' ? 0.6096 : 0.0508;

		return {
			id: `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			width,
			height,
			orientation,
			visible: true,
		};
	}

	_setSceneType(raw, { persist = true } = {}) {
		const next = normalizeSceneType(raw);

		if (next === 'free') {
			this.sceneType = 'free';
			this.sceneTarget = null;
		} else {
			const previous = this.sceneTarget;
			const nextOrientation = next === 'marker-vertical'
				? 'vertical'
				: 'horizontal';

			this.sceneType = next;

			// Preserve dimensions while staying in the same marker orientation.
			// Switching horizontal <-> vertical starts with the appropriate physical
			// print preset instead of carrying a business card into poster mode.
			const sameOrientation =
				previous?.orientation === nextOrientation;

			this.sceneTarget = normalizeSceneTarget({
				...(sameOrientation
					? previous
					: this._defaultSceneTarget(next)),
				orientation: nextOrientation,
			}, next) || this._defaultSceneTarget(next);
		}

		this._syncTargetPreview();
		this._syncSceneSetupUI();
		this._updateCount();

		if (persist) this._saveScene();

		this._emit('scene-type', {
			type: this.sceneType,
			target: this.sceneTarget ? { ...this.sceneTarget } : null,
		});
	}

	_updateSceneTargetFromUI() {
		if (this.sceneType === 'free' || !this.sceneTarget) return;

		const widthMm = Number(this.ui.sceneTargetWidth?.value);
		const heightMm = Number(this.ui.sceneTargetHeight?.value);

		const candidate = {
			...this.sceneTarget,
			width: Number.isFinite(widthMm)
				? widthMm / 1000
				: this.sceneTarget.width,
			height: Number.isFinite(heightMm)
				? heightMm / 1000
				: this.sceneTarget.height,
			visible: Boolean(this.ui.sceneTargetVisible?.checked),
		};

		const normalized = normalizeSceneTarget(candidate, this.sceneType);

		if (!normalized) {
			this._syncSceneSetupUI();
			this._setStatus(
				'Target dimensions must be greater than zero.',
				{ warn: true },
			);
			return;
		}

		this.sceneTarget = normalized;
		this._syncTargetPreview();
		this._syncSceneSetupUI();
		this._saveScene();

		this._emit('target', {
			type: this.sceneType,
			target: { ...this.sceneTarget },
		});
	}

	async _uploadTargetImage(file) {
		if (this.sceneType === 'free' || !this.sceneTarget || !file) return;

		const type = String(file.type || '').toLowerCase();

		if (type !== 'image/png' && type !== 'image/jpeg') {
			this._setStatus('Choose a PNG or JPEG target image.', { warn: true });
			return;
		}

		if (file.size > 10 * 1024 * 1024) {
			this._setStatus('Target image must be 10 MB or smaller.', { warn: true });
			return;
		}

		this._setStatus('Uploading target image…', { sticky: true });

		try {
			const response = await fetch('/api/targets', {
				method: 'POST',
				headers: {
					'content-type': type,
					'x-file-name': String(file.name || '').slice(0, 180),
				},
				body: file,
			});

			const result = await response.json().catch(() => ({}));

			if (!response.ok || !result.image || !result.mind) {
				throw new Error(result.error || `upload failed (${response.status})`);
			}

			this.sceneTarget = normalizeSceneTarget({
				...this.sceneTarget,
				image: result.image,
				mind: result.mind,
			}, this.sceneType);

			this._syncTargetPreview();
			this._syncSceneSetupUI();
			this._saveScene();

			this._emit('target-image', {
				target: { ...this.sceneTarget },
				image: result.image,
				mind: result.mind,
			});

			this._setStatus('Target image added.');
		} catch (err) {
			this._setStatus(
				`Target image upload failed: ${err?.message || err}`,
				{ warn: true },
			);
		} finally {
			if (this.ui.sceneTargetFile) {
				this.ui.sceneTargetFile.value = '';
			}
		}
	}

	_removeTargetImage() {
		if (this.sceneType === 'free' || !this.sceneTarget) return;

		const {
			image,
			mind,
			...rest
		} = this.sceneTarget;

		this.sceneTarget = normalizeSceneTarget(
			rest,
			this.sceneType,
		) || this._defaultSceneTarget(this.sceneType);

		this._syncTargetPreview();
		this._syncSceneSetupUI();
		this._saveScene();

		this._emit('target-image', {
			target: { ...this.sceneTarget },
			image: '',
			mind: '',
		});

		this._setStatus('Target image removed.');
	}

	_syncSceneSetupUI() {
		const u = this.ui;

		if (u.sceneTypeSelect) {
			u.sceneTypeSelect.value = this.sceneType;
		}

		const markerMode = this.sceneType !== 'free' && !!this.sceneTarget;

		if (u.sceneTargetSettings) {
			u.sceneTargetSettings.hidden = !markerMode;
		}

		if (!markerMode) return;

		if (u.sceneTargetWidth && document.activeElement !== u.sceneTargetWidth) {
			u.sceneTargetWidth.value = String(
				Math.round(this.sceneTarget.width * 100000) / 100,
			);
		}

		if (u.sceneTargetHeight && document.activeElement !== u.sceneTargetHeight) {
			u.sceneTargetHeight.value = String(
				Math.round(this.sceneTarget.height * 100000) / 100,
			);
		}

		if (u.sceneTargetVisible) {
			u.sceneTargetVisible.checked = this.sceneTarget.visible !== false;
		}

		const imageUrl = String(this.sceneTarget.image || '');

		if (u.sceneTargetImageName) {
			u.sceneTargetImageName.textContent = imageUrl
				? decodeURIComponent(imageUrl.split('/').pop() || 'Target image')
				: 'No target image selected';
		}

		if (u.sceneTargetChoose) {
			u.sceneTargetChoose.textContent = imageUrl ? 'Replace Image' : 'Choose Image';
		}

		if (u.sceneTargetRemove) {
			u.sceneTargetRemove.hidden = !imageUrl;
		}

		if (u.sceneTargetOrientation) {
			u.sceneTargetOrientation.textContent =
				this.sceneType === 'marker-vertical'
					? 'Vertical target · build in front'
					: 'Horizontal target · build above';
		}
	}

	_disposeTargetPreview() {
		this._targetTextureToken++;
		const mesh = this.targetPreview?.mesh;

		if (mesh) {
			this.scene.remove(mesh);
			mesh.geometry?.dispose?.();
			mesh.material?.dispose?.();
		}

		this.targetPreview?.texture?.dispose?.();

		if (this.targetPreview) {
			this.targetPreview.mesh = null;
			this.targetPreview.texture = null;
		}
	}

	_syncTargetPreview() {
		this._disposeTargetPreview();

		if (
			this.sceneType === 'free'
			|| !this.sceneTarget
			|| this.sceneTarget.visible === false
		) {
			return;
		}

		const width = this.sceneTarget.width;
		const height = this.sceneTarget.height;

		const texture = makeTargetPreviewTexture({
			orientation: this.sceneTarget.orientation,
		});

		const material = new MeshBasicMaterial({
			map: texture || null,
			color: texture ? 0xffffff : 0x6f65c8,
			transparent: true,
			opacity: 0.78,
			depthWrite: false,
			side: 2,
		});

		const mesh = new Mesh(
			new PlaneGeometry(width, height),
			material,
		);

		mesh.name = 'AR Studio target preview';
		mesh.userData.editorOnly = true;
		mesh.userData.lockedTarget = true;
		mesh.renderOrder = 2;

		// The logical marker origin remains the scene anchor, but the editor
		// preview is displayed in the normal forward authoring workspace rather
		// than directly underneath/on top of the camera at world z=0.
		const editorZ = -SPAWN_DISTANCE_M;

		if (this.sceneType === 'marker-horizontal') {
			mesh.rotation.x = -Math.PI / 2;
			mesh.position.set(0, 0.004, editorZ);
		} else {
			// Stand the print piece on the floor. PlaneGeometry is centre-origin,
			// so half-height lifts its bottom edge exactly onto Y=0.
			mesh.position.set(0, height / 2, editorZ - 0.015);
		}

		this.targetPreview.texture = texture;
		this.targetPreview.mesh = mesh;
		this.scene.add(mesh);

		const imageUrl = String(this.sceneTarget.image || '');

		if (imageUrl) {
			const token = ++this._targetTextureToken;
			const loader = new TextureLoader();

			loader.load(
				imageUrl,
				(realTexture) => {
					if (
						token !== this._targetTextureToken
						|| this.targetPreview?.mesh !== mesh
					) {
						realTexture.dispose();
						return;
					}

					const previous = this.targetPreview.texture;

					mesh.material.map = realTexture;
					mesh.material.color.set(0xffffff);
					mesh.material.opacity = 0.92;
					mesh.material.needsUpdate = true;

					this.targetPreview.texture = realTexture;

					if (previous && previous !== realTexture) {
						previous.dispose();
					}
				},
				undefined,
				() => {
					if (token === this._targetTextureToken) {
						this._setStatus(
							'Target image could not be loaded; using the marker placeholder.',
							{ warn: true },
						);
					}
				},
			);
		}
	}

	// ── Placements ────────────────────────────────────────────────────────────

	// A placement's LOGICAL scale: the size the user chose, independent of the
	// spawn-in animation. While a model eases in, group.scale is a fraction of the
	// target, and persisting that would clamp it to the minimum on the next load.
	_logicalScale(p) {
		if (p.spawnT < 1) return p.group.userData._targetScale ?? 1;
		return p.group.scale.x;
	}

	_saveScene() {
		let localDocumentJson;

		try {
			localDocumentJson = serializeScene(
				this.placements.filter((p) => this._isMine(p)).map((p) => ({
					src: p.src,
					title: p.title,
					x: p.group.position.x,
					y: p.group.position.y,
					z: p.group.position.z,
					rotX: p.rotX,
					yaw: p.yaw,
					rotZ: p.rotZ,
					scale: this._logicalScale(p),
					visible: p.visible !== false,
					group: p.groupId || undefined,
					action: p.action || undefined,
				})),
				this._sceneMetadata(),
			);
		} catch {
			// An invalid live placement cannot produce a recovery document. The live
			// scene remains unaffected, matching the historical persistence behavior.
			return;
		}

		if (this.config.persist !== false) {
			try {
				localStorage.setItem(this.config.persistKey, localDocumentJson);
			} catch {
				// Storage full or blocked: the live scene is unaffected.
			}
		}

		this.recomputeDirtyState();
		this._syncSavedSceneUi?.();
	}

	_selectedPlacements() {
		return this.placements.filter((p) => this._selection.has(p.id));
	}

	_select(p) {
		this._dropRuntimeGroup();
		this._selection.clear();

		if (!p) {
			this._syncSelectionState();
			return;
		}

		if (p.groupId && this._activatePersistentGroup(p.groupId)) return;

		this._selection.add(p.id);
		this._syncSelectionState();
	}

	_toggleSelection(p) {
		if (!p) return;

		this._dropRuntimeGroup();

		const members = p.groupId
			? this._groupMembers(p.groupId)
			: [p];

		const allSelected = members.every((item) => this._selection.has(item.id));

		for (const item of members) {
			if (allSelected) this._selection.delete(item.id);
			else this._selection.add(item.id);
		}

		this._syncSelectionState();
	}

	_syncSelectionState() {
		// Drop stale IDs left behind by deletion or scene replacement.
		const liveIds = new Set(this.placements.map((p) => p.id));
		for (const id of [...this._selection]) {
			if (!liveIds.has(id)) this._selection.delete(id);
		}

		const selectedItems = this._selectedPlacements();
		const single = selectedItems.length === 1 ? selectedItems[0] : null;

		this.selected = single;

		const { selbar, selName } = this.ui;
		if (!selbar) return;

		if (!selectedItems.length) {
			selbar.hidden = true;
			this.selRing.visible = false;
			this._detachTransformGizmo();
			this._syncTransformInspector();
			this._renderSceneTree();
			this._emit('select', { placement: null, placements: [] });
			return;
		}

		selbar.hidden = false;

		const multi = selectedItems.length > 1;
		const grouped = multi && this._runtimeGroupMatchesSelection();

		if (selName) {
			selName.textContent = grouped
				? `Group · ${selectedItems.length} models`
				: multi
					? `${selectedItems.length} models selected`
					: single.title || 'Model';
		}

		const rotateBtn = selbar.querySelector('[data-act="rotate"]');
		if (rotateBtn) rotateBtn.hidden = multi;

		const groupBtn = selbar.querySelector('[data-act="group"]');
		if (groupBtn) {
			groupBtn.hidden = !multi;
			groupBtn.textContent = grouped ? 'Ungroup' : 'Group';
			groupBtn.setAttribute(
				'aria-label',
				grouped ? 'Ungroup selected models' : 'Group selected models',
			);
		}

		const visibilityBtn = selbar.querySelector('[data-act="visibility"]');
		if (visibilityBtn) {
			const allHidden = selectedItems.every((p) => p.visible === false);
			visibilityBtn.textContent = allHidden ? 'Show' : 'Hide';
			visibilityBtn.setAttribute(
				'aria-label',
				allHidden ? 'Show selected models' : 'Hide selected models',
			);
		}

		if (multi) {
			this.selRing.visible = false;

			if (grouped) this._attachRuntimeGroupGizmo();
			else this._detachTransformGizmo();

			this._syncTransformInspector();
		} else {
			this.selRing.visible = single.visible !== false && !this.xrSession;

			if (single.visible !== false) {
				this._positionSelRing();
				this._warmQuickLook();
				this._attachTransformGizmo(single);
			} else {
				this._detachTransformGizmo();
			}

			this._syncTransformInspector();
		}

		this._renderSceneTree();

		this._emit('select', {
			placement: single ? publicPlacement(single, this) : null,
			placements: selectedItems.map((p) => publicPlacement(p, this)),
		});
	}

	_positionSelRing() {
		const p = this.selected;
		if (!p) return;
		this.selRing.position.set(p.group.position.x, p.group.position.y + 0.006, p.group.position.z);
		const r = Math.max(0.24, p.baseRadius * p.group.scale.x * 1.15);
		this.selRing.scale.setScalar(r / 0.34);
	}

	// One load per GLB source no matter how many copies are placed.
	_loadTemplate(src) {
		let tpl = this._templates.get(src);
		if (!tpl) {
			tpl = this._loadQueue.request(src).then((gltf) => {
				let skinned = false;
				gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
				const box = new Box3().setFromObject(gltf.scene);
				const fit = fitTransform({
					min: { x: box.min.x, y: box.min.y, z: box.min.z },
					max: { x: box.max.x, y: box.max.y, z: box.max.z },
				}, { skinned });
				const radius = Math.max((box.max.x - box.min.x) * fit.scale, (box.max.z - box.min.z) * fit.scale) / 2;
				const height = (box.max.y - box.min.y) * fit.scale;
				return {
					gltf, skinned, fit,
					radius: Number.isFinite(radius) ? radius : 0.3,
					height: Number.isFinite(height) ? height : 0.75,
				};
			});
			this._templates.set(src, tpl);
			tpl.then((t) => this._templatesReady.set(src, t))
				.catch(() => this._templates.delete(src)); // a failed load stays retryable
		}
		return tpl;
	}

	// Cloned per placement so ten copies of one crate are ten independent models.
	// SkeletonUtils handles skinned characters; a plain .clone() breaks bone binding.
	_instantiate(tpl, src) {
		const inner = cloneSkinnedScene(tpl.gltf.scene);
		inner.scale.setScalar(tpl.fit.scale);
		inner.position.y = tpl.fit.yOffset;
		const group = new Group();
		group.add(inner);
		let mixer = null;
		if (tpl.gltf.animations?.length) {
			mixer = new AnimationMixer(inner);
			mixer.clipAction(tpl.gltf.animations[0]).play();
		}
		// A humanoid with no baked clip gets the universal idle retargeted onto its
		// own rig: never a bind-pose statue. Best-effort and async: props and
		// undriveable rigs resolve null and stay static.
		let idlePromise = null;
		if (!mixer && tpl.skinned && this.config.animations?.enabled !== false) {
			idlePromise = mountIdle(inner, {
				manifestUrl: this.config.animations?.manifestUrl,
				clip: this.config.animations?.clip,
				sourceUrl: src,
			}).catch(() => null);
		}
		return { group, mixer, idlePromise };
	}

	_makeShadow(radius) {
		if (!this.shadowTex) return null;
		const d = Math.max(0.4, radius * 2.4);
		const mesh = new Mesh(
			new PlaneGeometry(d, d).rotateX(-Math.PI / 2),
			new MeshBasicMaterial({ map: this.shadowTex, transparent: true, opacity: 0.85, depthWrite: false }),
		);
		mesh.renderOrder = 1;
		return mesh;
	}

	// Spread same-spot spawns into a small ring so "add, add, add" reads as a
	// line-up instead of a z-fighting pile.
	_nudgeSpawn(pt) {
		let { x, z } = pt;
		for (let attempt = 0; attempt < 8; attempt++) {
			const clash = this.placements.some((p) => Math.hypot(p.group.position.x - x, p.group.position.z - z) < 0.45);
			if (!clash) break;
			const a = attempt * 2.399963; // golden angle
			x = pt.x + Math.cos(a) * 0.55 * (1 + attempt * 0.18);
			z = pt.z + Math.sin(a) * 0.55 * (1 + attempt * 0.18);
		}
		return { x, z };
	}

	async _addModel({ src, title = '', poster = '' } = {}, {
		x = null, y = 0, z = null,
		rotX = 0, yaw = null, rotZ = 0,
		scale = null, visible = true, announce = true, persist = true,
		groupId = null,
		action = null,
		remote = false, netId = null, ownerId = null,
	} = {}) {
		const url = normalizeGlbUrl(src);
		if (!url) {
			this._setStatus('That link is not a loadable https GLB.', { warn: true });
			return null;
		}
		if (this.placements.length >= this._maxPlacements) {
			this._setStatus(`Scene is full (${this._maxPlacements} models). Remove one to add more.`, { warn: true });
			return null;
		}
		if (announce) this._setStatus(`Loading ${title || 'model'}…`, { sticky: true });

		let tpl;
		try {
			tpl = await this._loadTemplate(url);
		} catch (err) {
			log.warn('model load failed', url, err);
			this._setStatus(`Couldn't load ${title || 'that model'}: the file may be gone or blocked by CORS.`, {
				warn: true, actionLabel: 'Retry', onAction: () => this._addModel({ src: url, title }),
			});
			return null;
		}

		const { group, mixer, idlePromise } = this._instantiate(tpl, url);
		let px = x;
		let pz = z;
		if (px === null || pz === null) {
			// Tall models land further back so they do not fill the frame the moment
			// they appear.
			const dist = Math.max(SPAWN_DISTANCE_M, (tpl.height || 0) * 1.15);
			const fwd = this.camera.getWorldDirection(new Vector3());
			const spot = this._nudgeSpawn(spawnPointInFront(this.camera.position, fwd, dist));
			px = spot.x;
			pz = spot.z;
		}
		group.position.set(px, Number.isFinite(Number(y)) ? Number(y) : 0, pz);

		const rotXV = Number.isFinite(Number(rotX)) ? Number(rotX) : 0;
		const yawV = yaw ?? Math.atan2(
			this.camera.position.x - px,
			this.camera.position.z - pz,
		);
		const rotZV = Number.isFinite(Number(rotZ)) ? Number(rotZ) : 0;

		group.rotation.set(rotXV, yawV, rotZV);
		if (scale) group.scale.setScalar(Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, scale)));
		group.visible = visible !== false;

		if (this.markerContentRoot) {
			this.markerContentRoot.add(group);
		} else {
			this.scene.add(group);
		}

		const shadow = this._makeShadow(tpl.radius);
		if (shadow) {
			shadow.position.set(px, 0.004, pz);
			shadow.scale.setScalar(group.scale.x);
			shadow.visible =
				visible !== false &&
				!this.xrSession &&
				!this.markerContentRoot;
			this.scene.add(shadow);
		}

		const placement = {
			id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			src: url,
			title: String(title || '').slice(0, 160),
			poster,
			group,
			shadow,
			mixer,
			idle: null,
			rotX: rotXV,
			yaw: yawV,
			rotZ: rotZV,
			baseRadius: tpl.radius,
			height: tpl.height || 0,
			visible: visible !== false,
			groupId: typeof groupId === 'string' && /^g-[A-Za-z0-9_-]{4,64}$/.test(groupId)
				? groupId
				: null,
			action: normalizeSceneAction(action),
			spawnT: this.reducedMotion ? 1 : 0,
			netId: netId || null,
			ownerId: remote ? ownerId : null,
			remote,
			_lastNetSend: 0,
		};
		idlePromise?.then((mgr) => {
			if (!mgr) return;
			// Removed before the clip arrived: release the manager rather than leak it.
			if (this.placements.includes(placement)) placement.idle = mgr;
			else mgr.detach();
		});
		group.userData._targetScale = group.scale.x;
		if (!this.reducedMotion) group.scale.setScalar(0.001);

		this.placements.push(placement);
		if (placement.netId) this._netModels.set(placement.netId, placement);
		if (!remote) this._armed = { src: url, title: placement.title };
		this._updateCount();
		if (!remote) this._select(placement);
		if (persist) this._saveScene();

		// Broadcast a locally-added model to the shared room exactly once.
		if (!remote && this.net && this.net.status === 'online') {
			const wireId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
			placement.netId = wireId;
			placement.ownerId = this.clientId;
			this._netModels.set(wireId, placement);
			this.net.spawn(this._placementWire(placement, wireId));
		}

		if (announce) {
			this._setStatus(remote
				? `${title || 'A model'} was added by someone in the room.`
				: 'Placed. Drag to move, pinch to resize, twist to rotate.');
		}
		if (!remote) this._framePreview();
		this._emit('add', { placement: publicPlacement(placement, this), remote });
		return placement;
	}

	_removePlacement(p, { persist = true, broadcast = true } = {}) {
		if (this._runtimeGroup?.memberIds.has(p.id)) {
			this._dropRuntimeGroup();
		}

		const i = this.placements.indexOf(p);
		if (i === -1) return;
		this.placements.splice(i, 1);
		if (p.netId) {
			this._netModels.delete(p.netId);
			if (broadcast && this.net?.status === 'online' && this._isMine(p)) this.net.remove(p.netId);
		}
		p.idle?.detach();
		p.idle = null;
		this.xrSession?.release(p.group);
		p.group.removeFromParent();
		if (p.shadow) {
			p.shadow.removeFromParent();
			p.shadow.geometry?.dispose();
			p.shadow.material?.dispose();
		}
		// Geometry and materials belong to the shared template: other copies still
		// use them, so only the per-placement shadow above is disposed.
		const wasPrimary = this.selected === p;
		const wasSelected = this._selection.delete(p.id);

		if (wasPrimary && !this._selection.size) {
			this._select(this.placements[this.placements.length - 1] ?? null);
		} else if (wasSelected) {
			this._syncSelectionState();
		}
		releaseQuickLook(this._arCacheKey(p));
		this._arKeys.delete(this._arCacheKey(p));
		// The sheet may be listing a model that no longer exists.
		if (this.ui.arModal && !this.ui.arModal.hidden) {
			this._showArTarget(this._arTarget === p ? this._arDefaultTarget() : this._arTarget);
		}
		this._normalizePersistentGroups();
		this._updateCount();
		if (persist) this._saveScene();
		this._emit('remove', { src: p.src, title: p.title });
	}

	_clearWithUndo() {
		if (!this.placements.length) return;
		const items = this.getScene();
		for (const p of [...this.placements]) this._removePlacement(p, { persist: false });
		this._saveScene();
		this._emit('clear', { items });
		this._setStatus('Scene cleared.', {
			actionLabel: 'Undo',
			onAction: async () => {
				for (const it of items) {
					await this._addModel({ src: it.src, title: it.title }, {
						x: it.x, y: it.y ?? 0, z: it.z,
						rotX: it.rotX ?? 0,
						yaw: it.yaw,
						rotZ: it.rotZ ?? 0,
						scale: it.scale,
						visible: it.visible !== false,
						groupId: it.group || null,
						announce: false,
					});
				}
			},
		});
	}

	_groupDisplayLabels() {
		const labels = new Map();
		let index = 1;

		for (const p of this.placements) {
			if (!p.groupId || labels.has(p.groupId)) continue;
			labels.set(p.groupId, `Group ${index++}`);
		}

		return labels;
	}

	_groupDisplayLabel(groupId) {
		return this._groupDisplayLabels().get(groupId) || 'Group';
	}

	_groupMembers(groupId) {
		if (!groupId) return [];
		return this.placements.filter((p) => p.groupId === groupId);
	}

	_newGroupId() {
		const token = crypto?.randomUUID?.()
			? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
			: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

		return `g-${token}`;
	}

	_normalizePersistentGroups() {
		const counts = new Map();

		for (const p of this.placements) {
			if (!p.groupId) continue;
			counts.set(p.groupId, (counts.get(p.groupId) || 0) + 1);
		}

		for (const p of this.placements) {
			if (p.groupId && (counts.get(p.groupId) || 0) < 2) {
				p.groupId = null;
			}
		}
	}

	_activatePersistentGroup(groupId, { announce = false } = {}) {
		const items = this._groupMembers(groupId)
			.filter((p) => this._isMine(p));

		if (items.length < 2) return false;

		this._dropRuntimeGroup();

		this._selection.clear();
		for (const p of items) this._selection.add(p.id);

		const center = items.reduce(
			(acc, p) => {
				acc.x += p.group.position.x;
				acc.y += p.group.position.y;
				acc.z += p.group.position.z;
				return acc;
			},
			{ x: 0, y: 0, z: 0 },
		);

		center.x /= items.length;
		center.y /= items.length;
		center.z /= items.length;

		const pivot = new Group();
		pivot.name = `RuntimeSelectionGroup_${groupId}`;
		pivot.position.set(center.x, center.y, center.z);
		pivot.rotation.set(0, 0, 0);
		pivot.scale.setScalar(1);

		const snapshots = new Map();

		for (const p of items) {
			snapshots.set(p.id, {
				offset: p.group.position.clone().sub(pivot.position),
				quaternion: p.group.quaternion.clone(),
				scale: this._logicalScale(p),
			});
		}

		this.scene.add(pivot);

		this._runtimeGroup = {
			groupId,
			memberIds: new Set(items.map((p) => p.id)),
			pivot,
			snapshots,
		};

		this.selected = null;
		this.selRing.visible = false;
		this._syncSelectionState();

		if (announce) {
			this._setStatus(`Group · ${items.length} models`);
		}

		return true;
	}

	// ── Runtime grouping ──────────────────────────────────────────────────────

	_runtimeGroupMatchesSelection() {
		const g = this._runtimeGroup;
		if (!g) return false;
		if (g.memberIds.size !== this._selection.size) return false;

		for (const id of g.memberIds) {
			if (!this._selection.has(id)) return false;
		}

		return true;
	}

	_dropRuntimeGroup() {
		const g = this._runtimeGroup;
		if (!g) return;

		if (this.transformControls?.object === g.pivot) {
			this._detachTransformGizmo();
		}

		this.scene.remove(g.pivot);
		this._runtimeGroup = null;
	}

	_createRuntimeGroup() {
		const items = this._selectedPlacements();

		if (items.length < 2) {
			this._setStatus('Select at least two models to group.', { warn: true });
			return;
		}

		if (items.some((p) => !this._isMine(p))) {
			this._setStatus(
				'Only models you control can be grouped.',
				{ warn: true },
			);
			return;
		}

		this._dropRuntimeGroup();

		const center = items.reduce(
			(acc, p) => {
				acc.x += p.group.position.x;
				acc.y += p.group.position.y;
				acc.z += p.group.position.z;
				return acc;
			},
			{ x: 0, y: 0, z: 0 },
		);

		center.x /= items.length;
		center.y /= items.length;
		center.z /= items.length;

		const pivot = new Group();
		pivot.name = 'RuntimeSelectionGroup';
		pivot.position.set(center.x, center.y, center.z);
		pivot.rotation.set(0, 0, 0);
		pivot.scale.setScalar(1);

		const snapshots = new Map();

		for (const p of items) {
			snapshots.set(p.id, {
				offset: p.group.position.clone().sub(pivot.position),
				quaternion: p.group.quaternion.clone(),
				scale: this._logicalScale(p),
			});
		}

		this.scene.add(pivot);

		const groupId = this._newGroupId();

		for (const p of items) p.groupId = groupId;

		this._runtimeGroup = {
			groupId,
			memberIds: new Set(items.map((p) => p.id)),
			pivot,
			snapshots,
		};

		this.selected = null;
		this.selRing.visible = false;
		this._syncSelectionState();

		this._saveScene();

		this._setStatus(
			`Grouped ${items.length} models. Move, rotate or scale them together.`,
		);
		this._emit('group', {
			count: items.length,
			placements: items.map((p) => publicPlacement(p, this)),
		});
	}

	_ungroupRuntimeSelection() {
		const g = this._runtimeGroup;
		if (!g) return;

		const count = g.memberIds.size;

		for (const id of g.memberIds) {
			const p = this.placements.find((item) => item.id === id);
			if (p) p.groupId = null;
		}

		this._dropRuntimeGroup();
		this._saveScene();
		this._syncSelectionState();

		this._setStatus(`Ungrouped ${count} models.`);
		this._emit('ungroup', { count });
	}

	_attachRuntimeGroupGizmo() {
		const g = this._runtimeGroup;

		if (
			!this.transformControls
			|| !g
			|| !this._runtimeGroupMatchesSelection()
			|| this.xrSession
		) {
			this._detachTransformGizmo();
			return;
		}

		this.transformControls.attach(g.pivot);
		this.transformHelper.visible = true;
		this._applyTransformModeAxes();
		this._applyTransformSnapSettings();
	}

	_applyRuntimeGroupTransform() {
		const g = this._runtimeGroup;
		if (!g || !this._runtimeGroupMatchesSelection()) return;

		const pivot = g.pivot;

		let factor = pivot.scale.x;

		if (this._transformMode === 'scale') {
			const axis = String(this.transformControls?.axis || '');

			if (axis.includes('Y')) factor = pivot.scale.y;
			else if (axis.includes('Z')) factor = pivot.scale.z;

			if (!Number.isFinite(factor)) factor = 1;

			// Choose a factor that keeps every real placement inside the normal
			// placement scale limits while preserving relative sizes.
			let minFactor = 0;
			let maxFactor = Infinity;

			for (const snap of g.snapshots.values()) {
				minFactor = Math.max(minFactor, PINCH_SCALE_MIN / snap.scale);
				maxFactor = Math.min(maxFactor, PINCH_SCALE_MAX / snap.scale);
			}

			factor = Math.min(maxFactor, Math.max(minFactor, factor));
			pivot.scale.setScalar(factor);
		} else {
			factor = pivot.scale.x;
		}

		for (const id of g.memberIds) {
			const p = this.placements.find((item) => item.id === id);
			const snap = g.snapshots.get(id);

			if (!p || !snap || !this._isMine(p)) continue;

			// Rotate the member's original 3D offset around the pivot. Scaling the
			// offset first preserves the existing uniform group-scale behaviour.
			const offset = snap.offset
				.clone()
				.multiplyScalar(factor)
				.applyQuaternion(pivot.quaternion);

			p.group.position.copy(pivot.position).add(offset);

			// Preserve the member's complete original orientation, then apply the
			// pivot's full pitch/yaw/roll ahead of it.
			p.group.quaternion
				.copy(pivot.quaternion)
				.multiply(snap.quaternion)
				.normalize();

			// Bake the resulting Three.js orientation back into the scene's existing
			// backward-compatible Euler fields.
			p.rotX = p.group.rotation.x;
			p.yaw = p.group.rotation.y;
			p.rotZ = p.group.rotation.z;

			const childScale = snap.scale * factor;
			p.group.scale.setScalar(childScale);
			p.group.userData._targetScale = childScale;
			p.spawnT = 1;

			if (p.shadow) {
				p.shadow.position.set(
					p.group.position.x,
					0.004,
					p.group.position.z,
				);
				p.shadow.scale.setScalar(childScale);
			}

			this._netBroadcastTransform(p);
		}

		this._warmQuickLook();
	}

	_finalizeRuntimeGroupTransform() {
		const g = this._runtimeGroup;
		if (!g) return;

		for (const id of g.memberIds) {
			const p = this.placements.find((item) => item.id === id);
			if (!p || !this._isMine(p)) continue;

			p._lastNetSend = 0;
			this._netBroadcastTransform(p);
		}

		this._saveScene();
		this._warmQuickLook();
		this._renderSceneTree();

		this._emit('group-transform', {
			placements: this._selectedPlacements().map(
				(p) => publicPlacement(p, this),
			),
		});
	}

	// ── Transform tools ───────────────────────────────────────────────────────

	_attachTransformGizmo(p) {
		if (!this.transformControls || !p || p.visible === false || this.xrSession || !this._isMine(p)) {
			this._detachTransformGizmo();
			return;
		}

		this.transformControls.attach(p.group);
		this.transformHelper.visible = true;
		this._applyTransformModeAxes();
	}

	_detachTransformGizmo() {
		this.transformControls?.detach();
		if (this.transformHelper) this.transformHelper.visible = false;
		this._gizmoDragging = false;
	}

	_applyTransformSnapSettings() {
		const c = this.transformControls;
		if (!c) return;

		if (!this._snapEnabled) {
			c.translationSnap = null;
			c.rotationSnap = null;
			c.scaleSnap = null;
		} else {
			c.translationSnap = this._translationSnap;
			c.rotationSnap = this._rotationSnapDeg * Math.PI / 180;
			c.scaleSnap = this._scaleSnap;
		}

		if (this.ui.transformSnapToggle) {
			this.ui.transformSnapToggle.checked = this._snapEnabled;
		}

		const wrap = this.ui.transformSnapSettings;
		if (wrap) wrap.classList.toggle('is-disabled', !this._snapEnabled);

		const set = (name, value) => {
			const input = this.ui.transformSnapFields?.querySelector(
				`[data-transform-snap="${name}"]`,
			);
			if (input && document.activeElement !== input) input.value = value;
		};

		set('translate', this._translationSnap.toFixed(2));
		set('rotate', String(this._rotationSnapDeg));
		set('scale', this._scaleSnap.toFixed(2));
	}

	_onTransformSnapFieldChange(e) {
		const input = e.target.closest('[data-transform-snap]');
		if (!input) return;

		const value = Number(input.value);
		if (!Number.isFinite(value) || value <= 0) {
			this._applyTransformSnapSettings();
			return;
		}

		switch (input.dataset.transformSnap) {
			case 'translate':
				this._translationSnap = Math.min(10, Math.max(0.001, value));
				break;

			case 'rotate':
				this._rotationSnapDeg = Math.min(180, Math.max(0.1, value));
				break;

			case 'scale':
				this._scaleSnap = Math.min(1, Math.max(0.001, value));
				break;

			default:
				return;
		}

		this._applyTransformSnapSettings();
		this._emit('transform-snap', {
			enabled: this._snapEnabled,
			translation: this._translationSnap,
			rotationDeg: this._rotationSnapDeg,
			scale: this._scaleSnap,
		});
	}

	_setTransformMode(mode) {
		if (!['translate', 'rotate', 'scale'].includes(mode)) return;

		this._transformMode = mode;
		this.transformControls?.setMode(mode);
		this._applyTransformModeAxes();
		this._applyTransformSnapSettings();

		for (const btn of this.ui.transformModes?.querySelectorAll('[data-transform-mode]') || []) {
			btn.classList.toggle('is-active', btn.dataset.transformMode === mode);
			btn.setAttribute('aria-pressed', String(btn.dataset.transformMode === mode));
		}

		this._emit('transform-mode', { mode });
	}

	_applyTransformModeAxes() {
		const c = this.transformControls;
		if (!c) return;

		if (this._transformMode === 'translate') {
			// Precision editor: X/Y/Z. Ordinary canvas dragging remains floor-based.
			c.showX = true;
			c.showY = true;
			c.showZ = true;
			c.setSpace('world');
			return;
		}

		if (this._transformMode === 'rotate') {
			// Full pitch / yaw / roll for marker and free-scene authoring.
			c.showX = true;
			c.showY = true;
			c.showZ = true;
			c.setSpace('local');
			return;
		}

		// TransformControls exposes the centre XYZ scale handle as well as the
		// axis handles. We normalise every change back to a uniform scalar below,
		// so even an axis drag cannot distort the model.
		c.showX = true;
		c.showY = true;
		c.showZ = true;
		c.setSpace('local');
	}

	_onGizmoObjectChange() {
		if (
			this._runtimeGroup
			&& this.transformControls?.object === this._runtimeGroup.pivot
		) {
			this._applyRuntimeGroupTransform();
			return;
		}

		const p = this.selected;
		if (!p || !this._isMine(p)) return;

		if (this._transformMode === 'rotate') {
			p.rotX = p.group.rotation.x;
			p.yaw = p.group.rotation.y;
			p.rotZ = p.group.rotation.z;
		}

		if (this._transformMode === 'scale') {
			const axis = String(this.transformControls.axis || '');
			let raw = p.group.scale.x;

			if (axis.includes('Y')) raw = p.group.scale.y;
			else if (axis.includes('Z')) raw = p.group.scale.z;

			if (!Number.isFinite(raw)) raw = this._gizmoStartScale || 1;

			const scalar = Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, raw));
			p.group.scale.setScalar(scalar);
			p.group.userData._targetScale = scalar;
		}

		if (p.shadow) {
			p.shadow.position.set(p.group.position.x, 0.004, p.group.position.z);
			p.shadow.scale.setScalar(this._logicalScale(p));
		}

		this._positionSelRing();
		this._netBroadcastTransform(p);
		this._syncTransformInspector();
	}

	_toggleActiveGroupVisibility() {
		const group = this._runtimeGroupMatchesSelection()
			? this._runtimeGroup
			: null;

		if (!group) return;

		const items = this._selectedPlacements()
			.filter((p) => this._isMine(p));

		if (!items.length) return;

		// If every member is hidden, Show Group.
		// Any visible/mixed state resolves to Hide Group.
		const shouldShow = items.every((p) => p.visible === false);

		for (const p of items) {
			p.visible = shouldShow;
			p.group.visible = shouldShow;

			if (p.shadow) {
				p.shadow.visible = shouldShow && !this.xrSession;
			}

			this._emit('visibility', {
				placement: publicPlacement(p, this),
				visible: p.visible,
			});
		}

		if (shouldShow) {
			this._attachRuntimeGroupGizmo();
			this._setStatus(`Showed ${items.length} grouped models.`);
		} else {
			// Keep the group selected so the inspector remains available to restore it.
			this._detachTransformGizmo();
			this._setStatus(`Hid ${items.length} grouped models.`);
		}

		this._saveScene();
		this._syncTransformInspector();
		this._renderSceneTree();
	}

	_syncTransformInspector() {
		const {
			transformInspector: panel,
			transformTitle,
			transformFields,
			transformGround,
			transformReset,
			transformSnapSettings,
			transformModes,
			transformGroupActions,
			groupVisibility,
		} = this.ui;

		if (!panel) return;

		const p = this.selected;
		const group = this._runtimeGroupMatchesSelection()
			? this._runtimeGroup
			: null;

		const groupItems = group
			? this._selectedPlacements()
			: [];

		const groupUsable = !!group
			&& groupItems.length > 1
			&& groupItems.every((item) => this._isMine(item));

		const groupAllHidden = groupUsable
			&& groupItems.every((item) => item.visible === false);

		const groupAllVisible = groupUsable
			&& groupItems.every((item) => item.visible !== false);

		const singleUsable = !!p
			&& p.visible !== false
			&& this._isMine(p);

		panel.hidden = !(groupUsable || singleUsable);

		if (panel.hidden) return;

		if (groupUsable) {
			const label = group.groupId
				? this._groupDisplayLabel(group.groupId)
				: 'Group';

			if (transformTitle) {
				transformTitle.textContent =
					`${label} · ${groupItems.length} models`;
			}

			// Groups expose shared transform controls plus group-level actions.
			// Per-child numeric fields remain single-model editing tools.
			if (transformFields) transformFields.hidden = true;
			if (transformGround) transformGround.hidden = true;
			if (transformReset) transformReset.hidden = true;
			if (transformGroupActions) transformGroupActions.hidden = false;

			// A fully hidden group cannot meaningfully display a transform gizmo.
			// Keep only its recovery/actions row visible.
			if (transformModes) transformModes.hidden = groupAllHidden;
			if (transformSnapSettings) transformSnapSettings.hidden = groupAllHidden;

			if (groupVisibility) {
				groupVisibility.textContent = groupAllHidden
					? 'Show Group'
					: groupAllVisible
						? 'Hide Group'
						: 'Show All';

				groupVisibility.setAttribute(
					'aria-label',
					groupAllHidden
						? 'Show every model in this group'
						: groupAllVisible
							? 'Hide every model in this group'
							: 'Show every model in this group',
				);
			}

			if (!groupAllHidden) {
				for (
					const btn of
					this.ui.transformModes?.querySelectorAll('[data-transform-mode]') || []
				) {
					const active = btn.dataset.transformMode === this._transformMode;
					btn.classList.toggle('is-active', active);
					btn.setAttribute('aria-pressed', String(active));
				}

				this._applyTransformSnapSettings();
			}

			return;
		}

		if (transformTitle) transformTitle.textContent = 'Transform';
		if (transformFields) transformFields.hidden = false;
		if (transformGround) transformGround.hidden = false;
		if (transformReset) transformReset.hidden = false;
		if (transformModes) transformModes.hidden = false;
		if (transformSnapSettings) transformSnapSettings.hidden = false;
		if (transformGroupActions) transformGroupActions.hidden = true;

		const set = (name, value) => {
			const input = this.ui.transformFields?.querySelector(
				`[data-transform-field="${name}"]`,
			);
			if (input && document.activeElement !== input) input.value = value;
		};

		set('x', p.group.position.x.toFixed(3));
		set('y', p.group.position.y.toFixed(3));
		set('z', p.group.position.z.toFixed(3));
		set('rotX', (p.rotX * 180 / Math.PI).toFixed(1));
		set('yaw', (p.yaw * 180 / Math.PI).toFixed(1));
		set('rotZ', (p.rotZ * 180 / Math.PI).toFixed(1));
		set('scale', this._logicalScale(p).toFixed(3));

		if (transformGround) {
			transformGround.disabled = Math.abs(p.group.position.y) < 0.001;
		}

		for (
			const btn of
			this.ui.transformModes?.querySelectorAll('[data-transform-mode]') || []
		) {
			const active = btn.dataset.transformMode === this._transformMode;
			btn.classList.toggle('is-active', active);
			btn.setAttribute('aria-pressed', String(active));
		}
	}

	_onTransformFieldChange(e) {
		const input = e.target.closest('[data-transform-field]');
		const p = this.selected;
		if (!input || !p || p.visible === false || !this._isMine(p)) return;

		const value = Number(input.value);
		if (!Number.isFinite(value)) {
			this._syncTransformInspector();
			return;
		}

		switch (input.dataset.transformField) {
			case 'x':
				p.group.position.x = Math.min(50, Math.max(-50, value));
				break;

			case 'y':
				p.group.position.y = Math.min(20, Math.max(-20, value));
				break;

			case 'z':
				p.group.position.z = Math.min(50, Math.max(-50, value));
				break;

			case 'rotX':
				p.rotX = value * Math.PI / 180;
				p.group.rotation.x = p.rotX;
				break;

			case 'yaw':
				p.yaw = value * Math.PI / 180;
				p.group.rotation.y = p.yaw;
				break;

			case 'rotZ':
				p.rotZ = value * Math.PI / 180;
				p.group.rotation.z = p.rotZ;
				break;

			case 'scale': {
				const scalar = Math.min(PINCH_SCALE_MAX, Math.max(PINCH_SCALE_MIN, value));
				p.group.scale.setScalar(scalar);
				p.group.userData._targetScale = scalar;
				break;
			}

			default:
				return;
		}

		if (p.shadow) {
			p.shadow.position.set(p.group.position.x, 0.004, p.group.position.z);
			p.shadow.scale.setScalar(this._logicalScale(p));
		}

		this._positionSelRing();
		p._lastNetSend = 0;
		this._netBroadcastTransform(p);
		this._saveScene();
		this._warmQuickLook();
		this._syncTransformInspector();
		this._emit('transform', { placement: publicPlacement(p, this) });
	}

	_snapSelectedToGround() {
		const p = this.selected;
		if (!p || p.visible === false || !this._isMine(p)) return;

		p.group.position.y = 0;

		if (p.shadow) {
			p.shadow.position.set(p.group.position.x, 0.004, p.group.position.z);
			p.shadow.scale.setScalar(this._logicalScale(p));
		}

		this._positionSelRing();
		p._lastNetSend = 0;
		this._netBroadcastTransform(p);
		this._saveScene();
		this._warmQuickLook();
		this._syncTransformInspector();

		this._setStatus('Snapped to ground.');
		this._emit('transform', { placement: publicPlacement(p, this) });
	}

	_resetSelectedTransform() {
		const p = this.selected;
		if (!p || p.visible === false || !this._isMine(p)) return;

		p.group.position.set(0, 0, -SPAWN_DISTANCE_M);
		p.rotX = 0;
		p.yaw = 0;
		p.rotZ = 0;
		p.group.rotation.set(0, 0, 0);
		p.group.scale.setScalar(1);
		p.group.userData._targetScale = 1;

		if (p.shadow) {
			p.shadow.position.set(0, 0.004, -SPAWN_DISTANCE_M);
			p.shadow.scale.setScalar(1);
		}

		this._positionSelRing();
		p._lastNetSend = 0;
		this._netBroadcastTransform(p);
		this._saveScene();
		this._warmQuickLook();
		this._syncTransformInspector();
		this._emit('transform', { placement: publicPlacement(p, this) });
	}

	// ── Scene tree ────────────────────────────────────────────────────────────

	_toggleSceneTree() {
		const { scenePanel, sceneBtn } = this.ui;
		if (!scenePanel) return;

		const opening = scenePanel.hidden;
		scenePanel.hidden = !opening;
		sceneBtn?.setAttribute('aria-expanded', String(opening));

		if (opening) {
			this._renderSceneTree();
			this._emit('scene-tree', { open: true });
		} else {
			this._emit('scene-tree', { open: false });
		}
	}

	_closeSceneTree() {
		const { scenePanel, sceneBtn } = this.ui;
		if (!scenePanel || scenePanel.hidden) return;
		scenePanel.hidden = true;
		sceneBtn?.setAttribute('aria-expanded', 'false');
		this._emit('scene-tree', { open: false });
	}

	_newSceneActionId() {
		const uuid = globalThis.crypto?.randomUUID?.();

		if (uuid) return `a-${uuid}`;

		return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
	}

	_duplicateSceneAction(action) {
		const current = normalizeSceneAction(action);
		if (!current) return null;

		return {
			...current,
			id: this._newSceneActionId(),
		};
	}

	_editPlacementLinkAction(p) {
		if (!this._isMine(p)) {
			this._setStatus('That model belongs to someone else in the room.', { warn: true });
			return;
		}

		const current = normalizeSceneAction(p.action);

		const enteredUrl = window.prompt(
			'Link URL (HTTPS). Leave blank to remove the link.',
			current?.url || 'https://',
		);

		if (enteredUrl === null) return;

		const url = enteredUrl.trim();

		if (!url) {
			if (!p.action) return;

			p.action = null;
			this._saveScene();
			this._renderSceneTree();
			this._emit('action', {
				placement: publicPlacement(p, this),
				action: null,
			});
			this._setStatus('Link removed.');
			return;
		}

		const enteredLabel = window.prompt(
			'Link label (optional, up to 80 characters).',
			current?.label || '',
		);

		if (enteredLabel === null) return;

		const candidate = {
			id: current?.id || this._newSceneActionId(),
			type: 'link',
			label: enteredLabel.trim(),
			url,
		};

		const normalized = normalizeSceneAction(candidate);

		if (!normalized) {
			this._setStatus(
				'Link not saved. Use a complete HTTPS URL with no embedded username or password.',
				{ warn: true },
			);
			return;
		}

		p.action = normalized;
		this._saveScene();
		this._renderSceneTree();
		this._emit('action', {
			placement: publicPlacement(p, this),
			action: { ...normalized },
		});
		this._setStatus('Link saved.');
	}

	_renderSceneTree() {
		const list = this.ui.sceneList;
		if (!list) return;

		list.textContent = '';

		if (!this.placements.length) {
			list.appendChild(el('p', {
				class: 'ars-scene-empty',
				text: 'No models in this scene.',
			}));
			return;
		}

		const groupLabels = this._groupDisplayLabels();

		for (const p of this.placements) {
			const mine = this._isMine(p);
			const selected = this._selection.has(p.id);
			const visible = p.visible !== false;
			const groupLabel = p.groupId
				? groupLabels.get(p.groupId)
				: null;

			const selectChildren = [
				el('span', {
					class: 'ars-scene-model-name',
					text: p.title || 'Model',
				}),
			];

			if (groupLabel) {
				selectChildren.push(el('span', {
					class: 'ars-scene-group-badge',
					text: groupLabel,
					'aria-label': `${groupLabel} member`,
				}));
			}

			const select = el('button', {
				type: 'button',
				class: 'ars-scene-select',
				'data-act': 'select',
				'aria-pressed': selected ? 'true' : 'false',
			}, selectChildren);

			const actions = el('div', {
				class: 'ars-scene-actions',
				'aria-label': `Actions for ${p.title || 'model'}`,
			}, [
				el('button', {
					type: 'button',
					class: 'ars-scene-action',
					'data-act': 'rename',
					text: 'Rename',
					disabled: !mine,
				}),
				el('button', {
					type: 'button',
					class: 'ars-scene-action',
					'data-act': 'duplicate',
					text: 'Duplicate',
				}),
				el('button', {
					type: 'button',
					class: `ars-scene-action${p.action ? ' is-active' : ''}`,
					'data-act': 'link',
					text: p.action ? 'Link ✓' : 'Link',
					'aria-pressed': p.action ? 'true' : 'false',
					title: p.action?.url || 'Add a link action',
					disabled: !mine,
				}),
				el('button', {
					type: 'button',
					class: 'ars-scene-action',
					'data-act': 'visibility',
					text: visible ? 'Hide' : 'Show',
					disabled: !mine,
				}),
				el('button', {
					type: 'button',
					class: 'ars-scene-action ars-scene-danger',
					'data-act': 'remove',
					text: 'Delete',
					disabled: !mine,
				}),
			]);

			const row = el('div', {
				class:
					`ars-scene-row${selected ? ' is-selected' : ''}` +
					`${visible ? '' : ' is-hidden'}` +
					`${groupLabel ? ' is-group-member' : ''}`,
				role: 'listitem',
				'data-placement-id': p.id,
			}, [
				select,
				actions,
			]);

			list.appendChild(row);
		}
	}

	_onSceneTreeClick(e) {
		const btn = e.target.closest('[data-act]');
		const row = e.target.closest('[data-placement-id]');
		if (!btn || !row) return;

		const p = this.placements.find((item) => item.id === row.dataset.placementId);
		if (!p) {
			this._renderSceneTree();
			return;
		}

		const act = btn.dataset.act;

		if (act === 'select') {
			if (e.shiftKey || e.ctrlKey || e.metaKey) this._toggleSelection(p);
			else this._select(p);
			return;
		}

		if (act === 'rename') {
			if (!this._isMine(p)) {
				this._setStatus('That model belongs to someone else in the room.', { warn: true });
				return;
			}

			const next = window.prompt('Rename model', p.title || 'Model');
			if (next === null) return;

			const title = next.trim().slice(0, 120);
			if (!title || title === p.title) return;

			p.title = title;
			if (this.selected === p && this.ui.selName) this.ui.selName.textContent = title;
			this._saveScene();
			this._renderSceneTree();
			this._emit('rename', { placement: publicPlacement(p, this) });
			return;
		}

		if (act === 'link') {
			this._editPlacementLinkAction(p);
			return;
		}

		if (act === 'duplicate') {
			this._addModel(
				{ src: p.src, title: p.title },
				{
					x: p.group.position.x + 0.35,
					y: p.group.position.y,
					z: p.group.position.z + 0.35,
					rotX: p.rotX,
					yaw: p.yaw,
					rotZ: p.rotZ,
					scale: this._logicalScale(p),
					visible: p.visible !== false,
					action: this._duplicateSceneAction(p.action),
				},
			);
			return;
		}

		if (act === 'visibility') {
			if (!this._isMine(p)) {
				this._setStatus('That model belongs to someone else in the room.', { warn: true });
				return;
			}

			p.visible = p.visible === false;
			p.group.visible = p.visible;
			if (p.shadow) p.shadow.visible = p.visible && !this.xrSession;

			if (!p.visible && this._selection.has(p.id)) {
				this._selection.delete(p.id);
				this._syncSelectionState();
			} else {
				this._renderSceneTree();
			}

			this._saveScene();
			this._emit('visibility', {
				placement: publicPlacement(p, this),
				visible: p.visible,
			});
			return;
		}

		if (act === 'remove') {
			if (!this._isMine(p)) {
				this._setStatus('That model belongs to someone else in the room.', { warn: true });
				return;
			}

			const snapshot = {
				src: p.src,
				title: p.title,
				x: p.group.position.x,
				y: p.group.position.y,
				z: p.group.position.z,
				rotX: p.rotX,
				yaw: p.yaw,
				rotZ: p.rotZ,
				scale: this._logicalScale(p),
				visible: p.visible !== false,
				action: p.action ? { ...p.action } : null,
			};

			this._removePlacement(p);
			this._setStatus('Removed.', {
				actionLabel: 'Undo',
				onAction: () => this._addModel(
					{ src: snapshot.src, title: snapshot.title },
					snapshot,
				),
			});
		}
	}

	async _onSelbarClick(e) {
		const btn = e.target.closest('[data-act]');
		if (!btn) return;

		const act = btn.dataset.act;
		const items = this._selectedPlacements();
		if (!items.length) return;

		const owned = items.filter((p) => this._isMine(p));

		if (act === 'group') {
			if (this._runtimeGroupMatchesSelection()) {
				this._ungroupRuntimeSelection();
			} else {
				this._createRuntimeGroup();
			}
			return;
		}

		// Bulk operations bake the current group transform into the real placements,
		// then dismiss the runtime helper before changing scene membership/visibility.
		if (this._runtimeGroupMatchesSelection()) {
			this._dropRuntimeGroup();
		}

		if (act === 'rotate') {
			const p = this.selected;
			if (!p) return;

			if (!this._isMine(p)) {
				this._setStatus('That model belongs to someone else in the room.', { warn: true });
				return;
			}

			p.yaw += Math.PI / 4;
			p.group.rotation.y = p.yaw;
			p._lastNetSend = 0;
			this._netBroadcastTransform(p);
			this._saveScene();
			this._syncTransformInspector();
			return;
		}

		if (act === 'visibility') {
			if (!owned.length) {
				this._setStatus('Those models belong to someone else in the room.', { warn: true });
				return;
			}

			const shouldShow = owned.every((p) => p.visible === false);

			for (const p of owned) {
				p.visible = shouldShow;
				p.group.visible = shouldShow;
				if (p.shadow) p.shadow.visible = shouldShow && !this.xrSession;

				this._emit('visibility', {
					placement: publicPlacement(p, this),
					visible: p.visible,
				});
			}

			// Hidden objects drop out of the active selection.
			if (!shouldShow) {
				for (const p of owned) this._selection.delete(p.id);
			}

			this._saveScene();
			this._syncSelectionState();
			return;
		}

		if (act === 'duplicate') {
			const originals = [...items];
			const copies = [];

			for (let i = 0; i < originals.length; i++) {
				const p = originals[i];
				const copy = await this._addModel(
					{ src: p.src, title: p.title },
					{
						x: p.group.position.x + 0.35,
						y: p.group.position.y,
						z: p.group.position.z + 0.35,
						rotX: p.rotX,
						yaw: p.yaw,
						rotZ: p.rotZ,
						scale: this._logicalScale(p),
						visible: p.visible !== false,
						action: this._duplicateSceneAction(p.action),
					},
				);

				if (copy) copies.push(copy);
			}

			if (copies.length) {
				this._selection.clear();
				for (const p of copies) this._selection.add(p.id);
				this._syncSelectionState();
			}

			return;
		}

		if (act === 'remove') {
			if (!owned.length) {
				this._setStatus('Those models belong to someone else in the room.', { warn: true });
				return;
			}

			const snapshots = owned.map((p) => ({
				src: p.src,
				title: p.title,
				x: p.group.position.x,
				y: p.group.position.y,
				z: p.group.position.z,
				rotX: p.rotX,
				yaw: p.yaw,
				rotZ: p.rotZ,
				scale: this._logicalScale(p),
				visible: p.visible !== false,
				action: p.action ? { ...p.action } : null,
			}));

			// Clear selection first so per-placement removal doesn't auto-select
			// some unrelated remaining model during a bulk delete.
			this._selection.clear();
			this.selected = null;
			this._detachTransformGizmo();
			this.selRing.visible = false;

			for (const p of owned) {
				this._removePlacement(p, { persist: false });
			}

			this._saveScene();
			this._syncSelectionState();

			this._setStatus(
				owned.length === 1 ? 'Removed.' : `Removed ${owned.length} models.`,
				{
					actionLabel: 'Undo',
					onAction: async () => {
						const restored = [];

						for (const snapshot of snapshots) {
							const p = await this._addModel(
								{ src: snapshot.src, title: snapshot.title },
								snapshot,
							);

							if (p) restored.push(p);
						}

						if (restored.length) {
							this._selection.clear();
							for (const p of restored) this._selection.add(p.id);
							this._syncSelectionState();
						}
					},
				},
			);

			return;
		}
	}

	// ── Restore + deep links ──────────────────────────────────────────────────

	async _restoreScene({ skipLocal = false } = {}) {
		// A #s= hash is a complete scene document. Invalid hashes retain the old
		// behavior and fall back to the local working document.
		const hashParams = new URLSearchParams(
			String(location.hash || '').replace(/^#/, ''),
		);

		const rawShared = skipLocal ? '' : String(hashParams.get('s') || '');
		let documentData = null;
		let sharedUsed = false;

		if (rawShared) {
			const candidate = sceneDocumentFromHashParam(rawShared);

			if (
				candidate.items.length
				|| candidate.type !== 'free'
				|| candidate.target
			) {
				documentData = candidate;
				sharedUsed = true;
			}
		}

		if (!documentData && !skipLocal && this.config.persist !== false) {
			try {
				documentData = deserializeSceneDocument(
					localStorage.getItem(this.config.persistKey),
				);
			} catch {
				documentData = null;
			}
		}

		if (!documentData) {
			documentData = {
				type: 'free',
				target: null,
				items: [],
			};
		}

		this.sceneType = normalizeSceneType(documentData.type);
		this.sceneTarget = normalizeSceneTarget(
			documentData.target,
			this.sceneType,
		);

		if (this.sceneType !== 'free' && !this.sceneTarget) {
			this.sceneTarget = this._defaultSceneTarget(this.sceneType);
		}

		this._syncTargetPreview();
		this._syncSceneSetupUI();

		const items = documentData.items;

		for (const it of items) {
			await this._addModel({ src: it.src, title: it.title }, {
				x: it.x,
				y: it.y ?? 0,
				z: it.z,
				rotX: it.rotX ?? 0,
				yaw: it.yaw,
				rotZ: it.rotZ ?? 0,
				scale: it.scale,
				visible: it.visible !== false,
				groupId: it.group || null,
				action: it.action || null,
				announce: false,
				persist: false,
			});
		}

		// Deep-linked models land in front of the camera, skipping any already
		// restored at an arranged spot.
		const have = new Set(this.placements.map((p) => p.src));

		for (const it of this.config.urlModels || []) {
			if (have.has(it.src)) continue;
			await this._addModel(it, { announce: false });
		}

		if (this.placements.length) {
			this._select(this.placements[this.placements.length - 1]);
		}

		if (sharedUsed) {
			this._setStatus(
				'Shared scene loaded, exactly as arranged. Clear to start fresh.',
			);
		} else if (this.placements.length) {
			this._setStatus(
				this.config.urlModels?.length
					? 'Models loaded: turn on the camera to see them in your space.'
					: 'Your scene is back.',
			);
		}

		this._updateCount();
		this._saveScene();
		// Recovery content is an unsaved working draft, never a restored Saved
		// Scene identity. Its current document is the initial comparison baseline.
		this.markCurrentDocumentAsBaseline();
	}

	// ── Camera passthrough ────────────────────────────────────────────────────

	_applyCameraFov() {
		const track = this.mediaStream?.getVideoTracks?.()[0];
		if (track) {
			const s = track.getSettings?.() ?? {};
			if (Number.isFinite(s.width) && s.width > 0) this.arTrackW = s.width;
			if (Number.isFinite(s.height) && s.height > 0) this.arTrackH = s.height;
		}
		if (!this.arActive || !(this.arTrackW > 0) || !(this.arTrackH > 0)) return;
		const { width, height } = this._viewportSize();
		this.camera.fov = deriveVerticalFovDeg({
			trackWidth: this.arTrackW,
			trackHeight: this.arTrackH,
			viewWidth: width,
			viewHeight: height,
			diagFovDeg: DEFAULT_DIAG_FOV_DEG,
		});
		this.camera.updateProjectionMatrix();
	}

	// Passthrough has no lighting-estimation API, so the room is read from the
	// video itself: mean brightness drives intensity, mean colour drives a gentle
	// white balance. A model in a dim bedroom stops glowing like a studio shot.
	_sampleCameraLight() {
		const probe = this._lightProbe;
		const video = this.ui.video;
		if (!this.arActive || !probe?.ctx || !video?.videoWidth) return;
		let data;
		try {
			probe.ctx.drawImage(video, 0, 0, 16, 16);
			data = probe.ctx.getImageData(0, 0, 16, 16).data;
		} catch {
			return; // frame not readable yet
		}
		const { intensity, tint } = roomLightFromPixels(data);
		this.hemi.intensity += (intensity * HEMI_BASE - this.hemi.intensity) * 0.4;
		this.sun.intensity += (intensity * SUN_BASE - this.sun.intensity) * 0.4;
		this._roomTint.setRGB(tint.r, tint.g, tint.b);
		this.hemi.color.lerp(this._roomTint, 0.4);
		this.sun.color.lerp(this._roomTint, 0.4);
	}

	_startLightMatching() {
		if (this._lightTimer || !this._lightProbe) return;
		this._lightTimer = setInterval(() => this._sampleCameraLight(), 2000);
		this._sampleCameraLight();
	}

	_stopLightMatching() {
		clearInterval(this._lightTimer);
		this._lightTimer = null;
		this.hemi.intensity = HEMI_BASE;
		this.sun.intensity = SUN_BASE;
		this.hemi.color.setHex(0xffffff);
		this.sun.color.setHex(0xffffff);
	}

	_createMarkerPoseProof(tracker) {
		this._disposeMarkerPoseProof();

		const dims = tracker?.targetDimensions;

		if (
			!Array.isArray(dims) ||
			dims.length < 2 ||
			!(dims[0] > 0) ||
			!(dims[1] > 0)
		) {
			throw new Error('MindAR target dimensions are unavailable');
		}

		const physicalWidth = Number(this.sceneTarget?.width);

		if (!(physicalWidth > 0)) {
			throw new Error('marker target physical width is unavailable');
		}

		const [markerWidth, markerHeight] = dims;

		// MindAR's official Three adapter converts its pixel-coordinate pose into
		// a centre-origin frame where one child-space unit equals one target width.
		this.markerPostMatrix = new Matrix4()
			.makeScale(markerWidth, markerWidth, markerWidth);

		this.markerPostMatrix.setPosition(
			markerWidth / 2,
			markerHeight / 2,
			0,
		);

		const root = new Group();
		root.name = 'MindAR marker pose';
		root.matrixAutoUpdate = false;
		root.visible = false;

		const content = new Group();
		content.name = 'AR Studio marker authored content';

		// Authored coordinates are stored in metres in the editor workspace.
		// Convert those metres to MindAR's target-width-normalized coordinates
		// without modifying any placement's own transform.
		const invWidth = 1 / physicalWidth;

		if (this.sceneType === 'marker-horizontal') {
			// Editor target:
			//   X = target horizontal
			//   Z = target vertical
			//   Y = height above the print
			//
			// MindAR target:
			//   X/Y = target plane
			//   Z   = target normal
			//
			// Inverting the editor preview's -90° X rotation maps:
			//   editor X  -> marker X
			//   editor -Z -> marker Y
			//   editor Y  -> marker Z
			content.position.set(
				0,
				-SPAWN_DISTANCE_M * invWidth,
				0,
			);
			content.rotation.x = Math.PI / 2;
			content.scale.setScalar(invWidth);
		} else {
			// Vertical target preview is already in the same X/Y orientation as
			// MindAR. Its editor centre is half the physical target height above the
			// floor and slightly behind the standard authoring plane.
			const physicalHeight = Number(this.sceneTarget?.height);
			const editorZ = -SPAWN_DISTANCE_M - 0.015;

			content.position.set(
				0,
				-(physicalHeight / 2) * invWidth,
				-editorZ * invWidth,
			);
			content.scale.setScalar(invWidth);
		}

		root.add(content);

		this.markerPoseRoot = root;
		this.markerContentRoot = content;
		this.scene.add(root);

		// Preserve the editor camera so leaving marker mode is lossless.
		this._markerCameraRestore = {
			position: this.camera.position.clone(),
			yaw: this.cameraYaw,
			pitch: this.cameraPitch,
		};

		this.camera.position.set(0, 0, 0);
		this.camera.rotation.set(0, 0, 0);

		// Parent the real placement groups beneath the runtime conversion layer.
		// Object3D.add() changes only the parent; every placement's local authored
		// position/rotation/scale remains exactly as stored and serialized.
		for (const p of this.placements) {
			content.add(p.group);
			p.group.visible = p.visible !== false;

			// Shadows are editor-floor constructs. Until marker-specific contact
			// shadows exist, hide them rather than pretending the editor floor is the
			// tracked target plane.
			if (p.shadow) p.shadow.visible = false;
		}

		if (this.targetPreview?.mesh) {
			this.targetPreview.mesh.visible = false;
		}

		this.selRing.visible = false;
		this._detachTransformGizmo();

		this._applyMarkerProjection(tracker);
	}

	_disposeMarkerPoseProof() {
		const root = this.markerPoseRoot;
		const content = this.markerContentRoot;

		// Restore the original scene ownership first. Adding an object to `scene`
		// automatically detaches it from the marker content root, while preserving
		// the placement's local authored transform values.
		if (content) {
			for (const p of this.placements) {
				if (p.group.parent === content) {
					this.scene.add(p.group);
				}
			}
		}

		if (root) {
			this.scene.remove(root);
		}

		this.markerPoseRoot = null;
		this.markerContentRoot = null;
		this.markerPostMatrix = null;

		if (this._markerCameraRestore) {
			this.camera.position.copy(this._markerCameraRestore.position);
			this.cameraYaw = this._markerCameraRestore.yaw;
			this.cameraPitch = this._markerCameraRestore.pitch;
			this._markerCameraRestore = null;
		}

		for (const p of this.placements) {
			p.group.visible = p.visible !== false;

			if (p.shadow) {
				p.shadow.visible =
					p.visible !== false &&
					!this.xrSession;
			}
		}

		if (this.targetPreview?.mesh) {
			this.targetPreview.mesh.visible =
				this.sceneTarget?.visible !== false;
		}

		this._syncSelectionState();
	}

	_applyMarkerProjection(tracker = this.markerTracker) {
		const proj = tracker?.projectionMatrix;

		if (
			!tracker?.running ||
			!Array.isArray(proj) ||
			proj.length !== 16
		) {
			return false;
		}

		const { width, height } = this._viewportSize();

		const inputWidth = Number(tracker.video?.videoWidth);
		const inputHeight = Number(tracker.video?.videoHeight);

		if (
			!(inputWidth > 0) ||
			!(inputHeight > 0) ||
			!(width > 0) ||
			!(height > 0)
		) {
			return false;
		}

		// Same projection adaptation used by MindAR's official Three.js wrapper.
		// Our video width/height attributes are synchronized to the intrinsic
		// dimensions, so its inputAdjust term is exactly 1.
		const inputRatio = inputWidth / inputHeight;
		const containerRatio = width / height;

		let videoDisplayHeight;

		if (inputRatio > containerRatio) {
			videoDisplayHeight = height;
		} else {
			videoDisplayHeight =
				width / inputWidth * inputHeight;
		}

		const fovAdjust = height / videoDisplayHeight;
		const fov =
			2 * Math.atan((1 / proj[5]) * fovAdjust) *
			180 / Math.PI;

		const near = proj[14] / (proj[10] - 1);
		const far = proj[14] / (proj[10] + 1);

		if (
			!Number.isFinite(fov) ||
			!Number.isFinite(near) ||
			!Number.isFinite(far) ||
			!(fov > 0) ||
			!(near > 0) ||
			!(far > near)
		) {
			return false;
		}

		this.camera.position.set(0, 0, 0);
		this.camera.rotation.set(0, 0, 0);
		this.camera.fov = fov;
		this.camera.near = near;
		this.camera.far = far;
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

		return true;
	}

	_applyMarkerPose(matrix) {
		if (
			!this.markerPoseRoot ||
			!this.markerPostMatrix ||
			!Array.isArray(matrix) ||
			matrix.length !== 16
		) return;

		this.markerPoseRoot.matrix
			.fromArray(matrix)
			.multiply(this.markerPostMatrix);

		this.markerPoseRoot.visible = true;
	}

	_hideMarkerPose() {
		if (this.markerPoseRoot) {
			this.markerPoseRoot.visible = false;
		}
	}

	async _startMarkerTracking() {
		this._stopMarkerTracking();

		const markerScene =
			this.sceneType === 'marker-horizontal' ||
			this.sceneType === 'marker-vertical';

		if (
			!markerScene ||
			!this.sceneTarget?.mind ||
			!this.ui.video
		) {
			return false;
		}

		let tracker = null;

		const horizontalMarker =
			this.sceneType === 'marker-horizontal';

		tracker = new MarkerTracker({
			video: this.ui.video,
			mindUrl: this.sceneTarget.mind,

			// A horizontal print is commonly viewed at a shallower angle than a
			// vertical marker, which makes its visual pose noisier. Give that mode a
			// slightly stronger filter and a little more loss tolerance without
			// changing the already-good vertical marker behaviour.
			poseSmoothingAlpha: horizontalMarker ? 0.30 : 0.40,
			lostGraceMs: horizontalMarker ? 160 : 120,

			onPose: (matrix) => {
				if (
					this.markerTracker !== tracker ||
					!this.arActive
				) return;

				this._applyMarkerPose(matrix);
			},
			onFound: () => {
				if (
					this.markerTracker !== tracker ||
					!this.arActive
				) return;

				this._setStatus('Marker found.');
			},
			onLost: () => {
				if (
					this.markerTracker !== tracker ||
					!this.arActive
				) return;

				this._hideMarkerPose();
				this._setStatus('Looking for marker…');
			},
			onDiagnostic: (state) => {
				if (
					this.markerTracker !== tracker ||
					!this.arActive ||
					tracker.visible
				) return;

				if (state.isTracking) {
					this._setStatus(
						`Marker candidate detected — warming up (${state.trackCount}).`,
					);
				} else {
					this._setStatus(
						`Marker tracker active — scanning (${state.frames} frames).`,
					);
				}
			},
		});

		this.markerTracker = tracker;

		try {
			await tracker.start();
		} catch (err) {
			if (this.markerTracker === tracker) {
				this.markerTracker = null;
			}
			tracker.dispose();
			throw err;
		}

		// Camera shutdown may have happened while the MindAR module, target,
		// or TensorFlow warmup was still loading.
		if (
			this.markerTracker !== tracker ||
			!this.arActive
		) {
			tracker.dispose();
			return false;
		}

		try {
			this._createMarkerPoseProof(tracker);
		} catch (err) {
			if (this.markerTracker === tracker) {
				this.markerTracker = null;
			}
			tracker.dispose();
			this._disposeMarkerPoseProof();
			throw err;
		}

		return true;
	}

	_stopMarkerTracking() {
		const tracker = this.markerTracker;
		this.markerTracker = null;

		this._disposeMarkerPoseProof();

		if (!tracker) return;

		try {
			tracker.dispose();
		} catch (err) {
			log.warn('marker tracking teardown failed', err);
		}
	}

	async _startCamera() {
		if (this.arTransitioning || this.arActive || this.xrSession) return;
		if (!navigator.mediaDevices?.getUserMedia) {
			this._setStatus('This browser cannot open the camera: the 3D preview still works.', { warn: true });
			return;
		}
		this.arTransitioning = true;
		try {
			this._setStatus('Starting camera…', { sticky: true });
			try {
				this.mediaStream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: { ideal: 'environment' } },
					audio: false,
				});
			} catch (err) {
				if (err?.name === 'NotAllowedError') {
					this._setStatus('Camera permission is blocked. Allow it in your browser settings, then try again.', {
						warn: true, sticky: true, actionLabel: 'Try again', onAction: () => this._startCamera(),
					});
				} else {
					this._setStatus(`The camera did not start (${err?.message ?? err}).`, {
						warn: true, actionLabel: 'Try again', onAction: () => this._startCamera(),
					});
				}
				return;
			}
			const { video, root, cameraBtn } = this.ui;
			if (video) video.srcObject = this.mediaStream;
			this.arActive = true;
			root.classList.add('is-ar');
			cameraBtn?.classList.add('is-active');
			cameraBtn?.setAttribute('aria-pressed', 'true');
			this.grid.visible = false;
			this.scene.fog = null;
			this._userLooked = true;
			video?.play?.().catch(() => { /* autoplay policy: the srcObject still renders */ });
			this._applyCameraFov();
			this._startLightMatching();
			await this._startGyro();

			let markerTracking = false;
			let markerTrackingError = null;

			try {
				markerTracking = await this._startMarkerTracking();
			} catch (err) {
				markerTrackingError = err;
				log.warn('marker tracking failed to start', err);
			}

			if (markerTrackingError) {
				this._setStatus(
					`Camera on, but marker tracking could not start (${markerTrackingError?.message ?? markerTrackingError}).`,
					{ warn: true, sticky: true },
				);
			} else if (markerTracking) {
				this._setStatus('Marker tracking ready. Point the camera at the target.');

				if (this.config.urlExperience === 'marker') {
					trackExperienceEvent(this.config, 'start');
				}
			} else if (this.arMode === 'quicklook' || this.arMode === 'sceneviewer') {
				// Be honest about what this view is. Passthrough is a phone's
				// gyroscope over a camera feed: it turns with you, but it has no
				// plane detection or positional tracking.
				this._setStatus('Camera on. This preview turns with your phone; to lock a model to your real floor, place it in AR.', {
					actionLabel: 'Place in AR', onAction: () => this._openArSheet(),
				});
			} else {
				this._setStatus('Camera on: your models are in the room. Look around.');
			}
			this._emit('camera', { active: true });
			this._syncRuntimeControls();
		} finally {
			this.arTransitioning = false;
		}
	}

	_stopCamera() {
		this._stopMarkerTracking();

		if (this.mediaStream) {
			this.mediaStream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
			this.mediaStream = null;
		}
		const { video, root, cameraBtn } = this.ui;
		if (video) video.srcObject = null;
		const was = this.arActive;
		this.arActive = false;
		this._stopLightMatching();
		root?.classList.remove('is-ar');
		cameraBtn?.classList.remove('is-active');
		cameraBtn?.setAttribute('aria-pressed', 'false');
		this.grid.visible =
			!this.xrSession &&
			!this.config.urlExperience;
		if (!this.xrSession) {
			this.scene.fog = this.config.urlExperience
				? null
				: this._fog;
		}
		this.camera.fov = 58;
		this.camera.updateProjectionMatrix();
		this.gyroBase = null;
		this._userLooked = false;
		this.arTrackW = 0;
		this.arTrackH = 0;
		if (was) this._emit('camera', { active: false });
		this._syncRuntimeControls();
		this._framePreview();
	}

	/**
	 * Hand the rear camera to the device's own AR viewer, and take it back after.
	 *
	 * The camera is a single-client resource on a phone. Leave the page's
	 * `getUserMedia` stream running and Quick Look starts ARKit against a camera
	 * another process is already holding: the model appears, and then world
	 * tracking and plane detection never converge, so it drifts with the phone
	 * instead of settling on the floor. It looks exactly like a broken anchor and
	 * it is not one. The immersive WebXR path has always released the camera for
	 * the same reason; the native hand-off has to as well.
	 *
	 * Synchronous on purpose: it runs in the same tick as the tap that opens the
	 * viewer, and an `await` in front of it costs the user gesture Safari needs.
	 */
	_yieldCameraToNativeAr() {
		if (this._cameraYielded) return;
		this._cameraYielded = true;
		this._cameraWasOn = this.arActive;
		this._stopCamera();
		// Nothing on this page is visible under the AR viewer, and a WebGL loop
		// still running at 60fps behind it is competing with ARKit for the same
		// GPU and the same thermal budget on a device that is about to do plane
		// detection. Stop drawing until the person comes back.
		this._stopLoop();
		// Quick Look presents over the page rather than navigating away, so the
		// return is a visibility change, not a load. `focus` is the backstop for
		// the iOS versions that never mark the page hidden underneath it.
		this._onArReturn = () => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			this._reclaimCameraAfterNativeAr();
		};
		document.addEventListener('visibilitychange', this._onArReturn);
		window.addEventListener('focus', this._onArReturn);
	}

	/** Restart the passthrough the person had running before AR took the camera. */
	_reclaimCameraAfterNativeAr() {
		if (!this._cameraYielded) return;
		this._cameraYielded = false;
		if (this._onArReturn) {
			document.removeEventListener('visibilitychange', this._onArReturn);
			window.removeEventListener('focus', this._onArReturn);
			this._onArReturn = null;
		}
		if (this._destroyed || this.xrSession) return;
		this._startLoop();
		if (this.arActive || !this._cameraWasOn) return;
		this._cameraWasOn = false;
		// Permission is already granted for this page, so this normally resolves
		// without a prompt. When a browser insists on a fresh gesture, _startCamera
		// puts a "Try again" action in the status line rather than failing silently.
		this._startCamera().catch((err) => log.warn('camera did not come back after AR', err));
	}

	_screenAngle() {
		try {
			const a = screen.orientation?.angle;
			if (Number.isFinite(a)) return a;
		} catch { /* older browsers */ }
		return Number(window.orientation) || 0;
	}

	_onDeviceOrientation(e) {
		if (isFiniteReading(e.alpha, e.beta)) {
			this._devAlpha = e.alpha;
			this._devBeta = e.beta;
			if (Number.isFinite(e.gamma)) this._devGamma = e.gamma;
		}
		if (!this.arActive || !this.gyroBase) return;
		const b = screenPitchDeg(this._devBeta, this._devGamma, this._screenAngle());
		const nextYaw = resolveLockYaw({
			useAbsolute: false,
			prevYaw: this.cameraYaw,
			alpha: this._devAlpha,
			baseAlpha: this.gyroBase.alpha,
			baseYaw: this.gyroBase.yaw,
			compassHeading: null,
		});
		const nextPitch = clampPitch(this.gyroBase.pitch - (b - this.gyroBase.beta) * (Math.PI / 180), PITCH_MIN, PITCH_MAX);
		if (Number.isFinite(nextYaw)) this.cameraYaw = nextYaw;
		if (Number.isFinite(nextPitch)) this.cameraPitch = nextPitch;
	}

	async _startGyro() {
		// iOS 13+ gates DeviceOrientationEvent behind a user-gesture permission; the
		// camera tap we are inside satisfies it.
		try {
			if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
				const state = await DeviceOrientationEvent.requestPermission();
				if (state !== 'granted') {
					this._setStatus('Motion access is off: drag to look around instead.', { warn: true });
					return;
				}
			}
		} catch {
			return; // declined prompt: drag-look still works
		}
		this.gyroBase = {
			alpha: this._devAlpha,
			beta: screenPitchDeg(this._devBeta, this._devGamma, this._screenAngle()),
			yaw: this.cameraYaw,
			pitch: this.cameraPitch,
		};
	}
	// ── Editor camera navigation ──────────────────────────────────────────────

	_lookAtEditorPoint(point) {
		if (!point) return;

		const dx = point.x - this.camera.position.x;
		const dy = point.y - this.camera.position.y;
		const dz = point.z - this.camera.position.z;
		const horizontal = Math.hypot(dx, dz);

		if (!(horizontal > 1e-6) && Math.abs(dy) < 1e-6) return;

		this.cameraYaw = Math.atan2(dx, -dz);
		this.cameraPitch = clampPitch(
			Math.atan2(dy, Math.max(horizontal, 1e-6)),
			PITCH_MIN,
			PITCH_MAX,
		);

		this._applyCameraLook();
	}

	_focusTargetView() {
		if (
			this.arActive
			|| this.xrSession
			|| this.sceneType === 'free'
			|| !this.sceneTarget
		) return;

		const mesh = this.targetPreview?.mesh;

		// The preview may be hidden, but its logical editor location remains the
		// same, so Focus Target must still work.
		const centre = mesh
			? mesh.position.clone()
			: new Vector3(
				0,
				this.sceneType === 'marker-vertical'
					? this.sceneTarget.height / 2
					: 0.004,
				-SPAWN_DISTANCE_M,
			);

		const width = this.sceneTarget.width;
		const height = this.sceneTarget.height;

		const verticalFov = this.camera.fov * (Math.PI / 180);
		const horizontalFov = 2 * Math.atan(
			Math.tan(verticalFov / 2) * Math.max(this.camera.aspect, 0.1),
		);

		if (this.sceneType === 'marker-vertical') {
			const distanceForHeight =
				height / (2 * Math.tan(verticalFov / 2));

			const distanceForWidth =
				width / (2 * Math.tan(horizontalFov / 2));

			const distance = Math.max(
				0.18,
				Math.max(distanceForHeight, distanceForWidth) * 1.35,
			);

			this.camera.position.set(
				centre.x,
				centre.y,
				centre.z + distance,
			);
		} else {
			// Look down at a flat target from a comfortable three-quarter angle.
			// The physical target remains true scale; only the editor camera moves.
			const maxDimension = Math.max(width, height);

			const distance = Math.max(
				0.20,
				(maxDimension / (2 * Math.tan(verticalFov / 2))) * 1.9,
			);

			this.camera.position.set(
				centre.x,
				centre.y + distance * 0.82,
				centre.z + distance * 0.58,
			);
		}

		this._userLooked = true;
		this._lookAtEditorPoint(centre);
		this._setStatus('Target framed.');
	}

	_resetEditorView() {
		if (this.arActive || this.xrSession) return;

		this.camera.position.set(0, EYE_HEIGHT_M, 0);
		this.cameraYaw = 0;
		this.cameraPitch = -0.24;
		this._userLooked = false;

		this._applyCameraLook();
		this._setStatus('Editor view reset.');
	}

	_onEditorWheel(e) {
		if (
			this.arActive
			|| this.xrSession
			|| this._gizmoDragging
			|| this.transformControls?.axis
		) return;

		e.preventDefault();

		const forward = this.camera.getWorldDirection(new Vector3());

		if (forward.lengthSq() < 1e-8) return;
		forward.normalize();

		// deltaY < 0 = toward scene, deltaY > 0 = away.
		// Clamp individual events so aggressive trackpad gestures stay controllable.
		const amount = Math.max(
			-0.75,
			Math.min(0.75, -Number(e.deltaY || 0) * 0.0015),
		);

		const next = this.camera.position.clone().addScaledVector(
			forward,
			amount,
		);

		// Keep the editor camera in a sane workspace. These are navigation limits,
		// not scene limits and are never persisted.
		next.x = Math.max(-30, Math.min(30, next.x));
		next.y = Math.max(0.03, Math.min(12, next.y));
		next.z = Math.max(-30, Math.min(30, next.z));

		this.camera.position.copy(next);
		this._userLooked = true;
	}

	// ── Pointer + touch gestures (XR has its own) ─────────────────────────────

	_viewportSize() {
		const r = this.ui.root.getBoundingClientRect();
		return {
			width: Math.max(1, Math.round(r.width || window.innerWidth)),
			height: Math.max(1, Math.round(r.height || window.innerHeight)),
			left: r.left,
			top: r.top,
		};
	}

	_setNdc(clientX, clientY) {
		const v = this._viewportSize();
		this._ndc.set(((clientX - v.left) / v.width) * 2 - 1, -((clientY - v.top) / v.height) * 2 + 1);
	}

	_placementAt(clientX, clientY) {
		if (!this.placements.length) return null;
		this._setNdc(clientX, clientY);

		// Marker tracking drives markerPoseRoot.matrix manually with
		// matrixAutoUpdate disabled. Rendering normally propagates that matrix to
		// its descendants, but a pointer event may land between a tracker pose
		// update and the next render frame. Synchronize world matrices here so the
		// raycaster always sees exactly the transform currently being displayed.
		this.camera.updateMatrixWorld(true);
		this.scene.updateMatrixWorld(true);

		this._raycaster.setFromCamera(this._ndc, this.camera);
		const hits = this._raycaster.intersectObjects(
			this.placements.filter((p) => p.visible !== false).map((p) => p.group),
			true,
		);
		if (!hits.length) return null;
		let obj = hits[0].object;
		while (obj) {
			const found = this.placements.find((p) => p.group === obj);
			if (found) return found;
			obj = obj.parent;
		}
		return null;
	}

	_floorPointAt(clientX, clientY) {
		this._setNdc(clientX, clientY);
		this._raycaster.setFromCamera(this._ndc, this.camera);
		const hits = this._raycaster.intersectObject(this.rayPlane);
		return hits.length ? hits[0].point : null;
	}

	_onPointerDown(e) {
		if (this.xrSession || this._gizmoDragging || this.transformControls?.axis) return;
		if (this._pinch.active || performance.now() - this._pinchEndedAt < 350) return;
		this._pointer = {
			x: e.clientX,
			y: e.clientY,
			placement: this._placementAt(e.clientX, e.clientY),

			// Capture modifier state at pointer-down so a click remains deterministic
			// even if a key is released before pointer-up.
			multiSelect: Boolean(e.shiftKey || e.ctrlKey || e.metaKey),

			lookYaw: this.cameraYaw,
			lookPitch: this.cameraPitch,
			moved: false,
		};
	}

	_onPointerMove(e) {
		const down = this._pointer;
		if (!down || this.xrSession || this._pinch.active || this._gizmoDragging) return;
		const dx = e.clientX - down.x;
		const dy = e.clientY - down.y;
		if (Math.hypot(dx, dy) > 6) down.moved = true;
		if (!down.moved) return;

		if (
			down.placement
			&& this._runtimeGroup?.memberIds.has(down.placement.id)
		) {
			// A grouped selection moves through its shared gizmo. Individual floor
			// dragging would desynchronise the helper pivot from its children.
			return;
		}

		if (down.placement && this._isMine(down.placement)) {
			// Drag a model along the floor.
			const pt = this._floorPointAt(e.clientX, e.clientY);
			if (!pt) return;
			const p = down.placement;
			p.group.position.x = pt.x;
			p.group.position.z = pt.z;
			p.shadow?.position.set(pt.x, 0.004, pt.z);
			if (this.selected === p) {
				this._positionSelRing();
				this._syncTransformInspector();
			}
			this._netBroadcastTransform(p);
		} else if (!down.placement && !(this.arActive && this.gyroBase)) {
			// Drag-look, but only when the gyro is not already steering the view.
			this._userLooked = true;
			this.cameraYaw = down.lookYaw + dx * 0.0042;
			this.cameraPitch = clampPitch(down.lookPitch + dy * 0.0032, PITCH_MIN, PITCH_MAX);
		}
	}

	_openPublishedPlacementAction(placement) {
		const mode = this.config.urlExperience;

		if (mode !== 'space' && mode !== 'marker') {
			return false;
		}

		const action = normalizeSceneAction(placement?.action);

		if (!action) return false;

		const sceneKey = getExperienceSceneKey();

		if (!sceneKey) {
			this._setStatus(
				'This link is unavailable from a portable preview. Open the published scene URL and try again.',
				{ warn: true },
			);
			return true;
		}

		const redirectUrl = new URL(
			`/r/${encodeURIComponent(sceneKey)}/${encodeURIComponent(action.id)}`,
			location.origin,
		);

		// Ensure the server-side redirect can correlate this action with the
		// browser session without exposing the session identifier in the URL.
		getExperienceSessionId();

		redirectUrl.searchParams.set('experience', mode);

		const journey = getExperienceJourneyId(this.config);

		if (journey) {
			redirectUrl.searchParams.set('journey', journey);
		}

		location.assign(redirectUrl.href);
		return true;
	}

	_onPointerUp(e) {
		const down = this._pointer;
		if (!down || this.xrSession || this._gizmoDragging) return;
		const wasTap = !down.moved
			&& Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 8
			&& !this._pinch.active
			&& performance.now() - this._pinchEndedAt >= 350;
		if (wasTap) {
			const published =
				this.config.urlExperience === 'space' ||
				this.config.urlExperience === 'marker';

			if (published) {
				if (down.placement) {
					this._openPublishedPlacementAction(down.placement);
				}

				// Published experiences are viewers, not editors. A tap either
				// executes an authored action or does nothing; it never selects.
				this._pointer = null;
				return;
			}

			if (down.placement && down.multiSelect) {
				this._toggleSelection(down.placement);
			} else {
				this._select(down.placement); // null deselects
			}
		} else if (down.placement && down.moved && this._isMine(down.placement)) {
			down.placement._lastNetSend = 0; // force the settle broadcast through
			this._netBroadcastTransform(down.placement);
			this._saveScene();
			this._setStatus(null);
		}
		this._pointer = null;
	}

	/** Two fingers: pinch resizes, twist rotates: on the selected (or last) model. */
	_gestureTarget() {
		// Multi-select and groups have their own transform workflow. Falling back
		// to the last placement here would let a two-finger gesture silently edit
		// an unrelated model while several models appear selected.
		if (this._selection?.size > 1 || this._runtimeGroupMatchesSelection()) {
			return null;
		}

		const t = this.selected ?? this.placements[this.placements.length - 1] ?? null;
		return t && this._isMine(t) ? t : null;
	}

	_onTouchStart(e) {
		if (this.xrSession || e.touches.length !== 2) return;
		const target = this._gestureTarget();
		if (!target) return;
		this._pointer = null; // the pair owns the gesture: no drag, no tap
		pinchStart(this._pinch, touchDist(e.touches), target.group.scale.x);
		this._twist = { startAngle: touchAngle(e.touches), baseYaw: target.yaw, placement: target };
	}

	_onTouchMove(e) {
		if (this.xrSession || e.touches.length !== 2) return;
		const target = this._twist?.placement;
		if (!target) return;
		const s = pinchMove(this._pinch, touchDist(e.touches));
		if (s != null) {
			target.group.scale.setScalar(s);
			target.group.userData._targetScale = s;
			target.shadow?.scale.setScalar(s);
			if (this.selected === target) this._positionSelRing();
		}
		target.yaw = this._twist.baseYaw + twistDelta(this._twist.startAngle, touchAngle(e.touches));
		target.group.rotation.y = target.yaw;
		this._syncTransformInspector();
		this._netBroadcastTransform(target);
	}

	_onTouchEnd() {
		this._warmQuickLook();
		const s = pinchEnd(this._pinch);
		const target = this._twist?.placement;
		if (s != null) {
			this._pinchEndedAt = performance.now();
			this._saveScene();
		}
		if (target) {
			target._lastNetSend = 0;
			this._netBroadcastTransform(target);
		}
		this._twist = null;
	}

	// ── Keyboard ──────────────────────────────────────────────────────────────
	// Arrows nudge the selected model camera-relative (Shift for fine), R rotates,
	// D duplicates, Delete removes, Escape closes whatever is open. The mouse
	// never has to leave the scene.

	_onKeyDown(e) {
		if (this._destroyed) return;
		if (!this.ui.root.isConnected) return;
		if (e.target.closest?.('input, textarea, select')) {
			if (e.key === 'Escape') e.target.blur();
			return;
		}
		if (e.key === 'Escape') {
			if (this._savedSceneDialog) this._resolveSavedSceneDialog(null);
			else if (!this.ui.savedScenePanel.hidden) this._closeSavedScenePanel();
			else if (!this.ui.tray.hidden) this._closeTray();
			else if (!this.ui.roomModal.hidden) this._closeRoomModal();
			else if (!this.ui.arModal.hidden) this._closeArSheet();
			else if (!this.ui.qrModal.hidden) this._closeQr();
			else this._select(null);
			return;
		}
		if (!this.ui.tray.hidden || !this.ui.qrModal.hidden || !this.ui.arModal.hidden
			|| !this.ui.roomModal.hidden || this.xrSession) return;
		const p = this.selected;
		if (!p) return;
		const editable = this._isMine(p);

		if (e.key.startsWith('Arrow')) {
			if (!editable) return;
			e.preventDefault();
			const step = e.shiftKey ? 0.02 : 0.1;
			const fwd = this.camera.getWorldDirection(new Vector3());
			fwd.y = 0;
			if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
			fwd.normalize();
			const right = new Vector3(-fwd.z, 0, fwd.x);
			const move = e.key === 'ArrowUp' ? fwd
				: e.key === 'ArrowDown' ? fwd.negate()
					: e.key === 'ArrowLeft' ? right.negate()
						: right;
			p.group.position.addScaledVector(move, step);
			p.shadow?.position.set(p.group.position.x, 0.004, p.group.position.z);
			this._positionSelRing();
			this._netBroadcastTransform(p);
			this._saveScene();
		} else if (e.key === 'r' || e.key === 'R') {
			if (!editable) return;
			p.yaw += Math.PI / 4;
			p.group.rotation.y = p.yaw;
			p._lastNetSend = 0;
			this._netBroadcastTransform(p);
			this._saveScene();
		} else if (e.key === 'd' || e.key === 'D') {
			e.preventDefault();
			this._addModel(
				{ src: p.src, title: p.title },
				{
					rotX: p.rotX,
					yaw: p.yaw,
					rotZ: p.rotZ,
					scale: this._logicalScale(p),
					action: this._duplicateSceneAction(p.action),
				},
			);
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			if (!editable) return;
			e.preventDefault();
			this._removePlacement(p);
			this._setStatus('Removed.', {
				actionLabel: 'Undo',
				onAction: () => this._addModel({ src: p.src, title: p.title }, {
					x: p.group.position.x,
					y: p.group.position.y,
					z: p.group.position.z,
					rotX: p.rotX,
					yaw: p.yaw,
					rotZ: p.rotZ,
					scale: this._logicalScale(p),
					action: p.action ? { ...p.action } : null,
				}),
			});
		}
	}

	// ── Model tray ────────────────────────────────────────────────────────────

	_wireTrayTabs() {
		const strip = this.ui.trayTabs;
		if (!strip) return;
		for (const [i, source] of this.sources.entries()) {
			const btn = el('button', {
				type: 'button',
				class: 'ars-tab',
				role: 'tab',
				id: `ars-tab-${i}-${source.id}`,
				'aria-selected': String(i === 0),
				tabindex: i === 0 ? '0' : '-1',
				'data-tab': source.id,
				text: source.label || source.id,
			});
			btn.addEventListener('click', () => this._setTrayTab(source.id));
			strip.appendChild(btn);
		}
		// A role="tablist" owes the keyboard the arrow-key contract.
		strip.addEventListener('keydown', (e) => {
			const tabs = [...strip.querySelectorAll('.ars-tab')];
			const i = tabs.indexOf(document.activeElement);
			if (i === -1) return;
			const last = tabs.length - 1;
			const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
				: e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
					: e.key === 'Home' ? 0
						: e.key === 'End' ? last
							: -1;
			if (next === -1) return;
			e.preventDefault();
			this._setTrayTab(tabs[next].dataset.tab);
			tabs[next].focus();
		});
	}


	_syncSavedSceneUi() {
		const u = this.ui;
		if (!u?.savedSceneBar) return;
		const state = this.getSavedSceneState();
		const hasIdentity = state.id != null;
		u.savedSceneName.textContent = state.name || 'Untitled Scene';
		u.savedSceneState.textContent = state.busy ? 'Working…' : (state.dirty ? 'Unsaved Changes' : (hasIdentity ? 'Saved' : 'Unsaved'));
		u.savedSceneState.dataset.dirty = String(state.dirty);
		for (const button of [u.savedSceneNew, u.savedSceneOpen, u.savedSceneSave, u.savedSceneSaveAs, u.savedSceneRename, u.savedSceneDuplicate, u.savedSceneDelete]) {
			if (button) button.disabled = state.busy || (button === u.savedSceneRename || button === u.savedSceneDuplicate || button === u.savedSceneDelete ? !hasIdentity : false);
		}
	}

	_savedSceneUiOperation(operation) {
		this._syncSavedSceneUi();
		return Promise.resolve().then(operation).finally(() => this._syncSavedSceneUi());
	}

	_savedSceneErrorMessage(error) {
		const messages = {
			network_error: 'Could not reach the Saved Scenes service.',
			unavailable: 'Saved Scenes are unavailable.',
			not_found: 'This Saved Scene no longer exists.',
			too_large: 'This scene is too large to save.',
			invalid_scene: 'This scene could not be saved.',
			invalid_name: 'Enter a name between 1 and 120 characters.',
			busy: 'A Saved Scene operation is already in progress.',
			server_error: 'Saved Scenes are temporarily unavailable.',
			conflict: 'This Saved Scene was changed elsewhere.',
		};
		return messages[error?.code] || (error?.code === 'aborted' ? '' : 'Saved Scene operation failed.');
	}

	_showSavedSceneMessage(message, { warn = true } = {}) {
		if (!message) return;
		this._setStatus(message, { warn });
	}

	_showSavedSceneNameDialog(title, initial = '') {
		const u = this.ui;
		u.savedSceneNameModal.querySelector('h2').textContent = title;
		u.savedSceneNameInput.value = initial;
		u.savedSceneNameError.hidden = true;
		u.savedSceneNameModal.hidden = false;
		this._lastFocus = document.activeElement;
		u.savedSceneNameInput.focus();
		return new Promise((resolve) => { this._savedSceneDialog = { resolve, type: 'name' }; });
	}

	_submitSavedSceneNameDialog() {
		const value = uTrim(this.ui.savedSceneNameInput.value);
		if (!value || [...value].length > 120) {
			this.ui.savedSceneNameError.textContent = 'Enter a name between 1 and 120 characters.';
			this.ui.savedSceneNameError.hidden = false;
			return;
		}
		this._resolveSavedSceneDialog(value);
	}

	_showSavedSceneChoice(message, labels = {}) {
		this.ui.savedSceneDecisionSave.textContent = labels.save || 'Save';
		this.ui.savedSceneDecisionDiscard.textContent = labels.discard || 'Discard';
		this.ui.savedSceneDecisionCancel.textContent = labels.cancel || 'Cancel';
		this.ui.savedSceneDecisionMessage.textContent = message;
		this.ui.savedSceneDecisionModal.hidden = false;
		this._lastFocus = document.activeElement;
		this.ui.savedSceneDecisionSave.focus();
		return new Promise((resolve) => { this._savedSceneDialog = { resolve, type: 'choice' }; });
	}

	_showSavedSceneConfirm(message, confirmLabel = 'Confirm') {
		this.ui.savedSceneConfirmMessage.textContent = message;
		this.ui.savedSceneConfirmSubmit.textContent = confirmLabel;
		this.ui.savedSceneConfirmModal.hidden = false;
		this._lastFocus = document.activeElement;
		this.ui.savedSceneConfirmSubmit.focus();
		return new Promise((resolve) => { this._savedSceneDialog = { resolve, type: 'confirm' }; });
	}

	_resolveSavedSceneDialog(value) {
		const dialog = this._savedSceneDialog;
		if (!dialog) return;
		this.ui.savedSceneNameModal.hidden = true;
		this.ui.savedSceneDecisionModal.hidden = true;
		this.ui.savedSceneConfirmModal.hidden = true;
		this._savedSceneDialog = null;
		this._restoreFocus(this._lastFocus);
		dialog.resolve(value);
	}

	_closeSavedScenePanel() {
		if (!this.ui.savedScenePanel || this.ui.savedScenePanel.hidden) return;
		this.ui.savedScenePanel.hidden = true;
		this._restoreFocus(this._lastFocus);
	}

	async _confirmSavedSceneNavigation() {
		if (!this.dirty) return true;
		const choice = await this._showSavedSceneChoice('You have unsaved changes.');
		if (choice === 'discard') return true;
		if (choice !== 'save') return false;
		try {
			if (this.currentSavedSceneId) await this.saveSavedScene();
			else {
				const name = await this._showSavedSceneNameDialog('Save Scene');
				if (!name) return false;
				await this.saveSavedScene({ name });
			}
			return true;
		} catch (error) {
			this._handleSavedSceneUiError(error);
			return false;
		}
	}

	async _newSavedSceneFromUi() {
		if (!(await this._confirmSavedSceneNavigation())) return;
		try {
			await this.setSceneDocument({ v: 1, items: [] });
			this.clearSavedSceneIdentity({ dirty: false });
			this._syncSavedSceneUi();
		} catch (error) { this._handleSavedSceneUiError(error); }
	}

	async _saveSavedSceneFromUi() {
		try {
			if (this.currentSavedSceneId) await this._savedSceneUiOperation(() => this.saveSavedScene());
			else {
				const name = await this._showSavedSceneNameDialog('Save Scene');
				if (name) await this._savedSceneUiOperation(() => this.saveSavedScene({ name }));
			}
		} catch (error) { this._handleSavedSceneUiError(error); }
	}

	async _saveSavedSceneAsFromUi() {
		const name = await this._showSavedSceneNameDialog('Save Scene As');
		if (!name) return;
		try { await this._savedSceneUiOperation(() => this.saveSavedSceneAs({ name })); }
		catch (error) { this._handleSavedSceneUiError(error); }
	}

	async _openSavedScenesPanel() {
		const canOpen = await this._confirmSavedSceneNavigation();
		if (!canOpen) return;
		const u = this.ui;
		u.savedScenePanel.hidden = false;
		u.savedScenePanelStatus.textContent = 'Loading saved scenes…';
		u.savedScenePanelList.textContent = '';
		this._lastFocus = document.activeElement;
		try {
			const scenes = await this._savedSceneUiOperation(() => this.listSavedScenes());
			u.savedScenePanelStatus.textContent = scenes.length ? '' : 'No saved scenes yet.';
			for (const scene of scenes) {
				const row = el('div', { class: 'ars-saved-scene-row', role: 'listitem' }, [
					el('div', { class: 'ars-saved-scene-row-copy' }, [
						el('strong', { text: scene.name }),
						el('small', { text: `${sceneTypeLabel(scene.scene_type)} · ${formatSavedSceneDate(scene.updated_at)}` }),
					]),
					el('button', { type: 'button', class: 'ars-btn ars-btn-primary', text: 'Open', 'data-saved-scene-open': scene.id }),
				]);
				u.savedScenePanelList.appendChild(row);
			}
		} catch (error) {
			u.savedScenePanelStatus.textContent = this._savedSceneErrorMessage(error) || 'Could not load saved scenes.';
		}
	}

	async _openSavedSceneFromUi(id) {
		this._closeSavedScenePanel();
		try { await this._savedSceneUiOperation(() => this.openSavedScene(id)); }
		catch (error) { await this._handleSavedSceneUiError(error); }
	}

	async _renameSavedSceneFromUi() {
		if (!this.currentSavedSceneId) return;
		const name = await this._showSavedSceneNameDialog('Rename Saved Scene', this.currentSavedSceneName);
		if (!name) return;
		try { await this._savedSceneUiOperation(() => this.renameSavedScene(name)); }
		catch (error) { await this._handleSavedSceneUiError(error); }
	}

	async _duplicateSavedSceneFromUi() {
		if (!this.currentSavedSceneId) return;
		const name = await this._showSavedSceneNameDialog('Duplicate Saved Scene');
		if (!name) return;
		try {
			const copy = await this._savedSceneUiOperation(() => this.duplicateSavedScene({ name, adopt: false }));
			const choice = await this._showSavedSceneChoice('Copy created. Open the copy now?', { save: 'Open Copy', discard: 'Stay Here' });
			if (choice === 'save') await this._openSavedSceneFromUi(copy.id);
		} catch (error) { await this._handleSavedSceneUiError(error); }
	}

	async _deleteSavedSceneFromUi() {
		if (!this.currentSavedSceneId) return;
		const name = this.currentSavedSceneName || 'this Saved Scene';
		const confirmed = await this._showSavedSceneConfirm(`Delete '${name}'? This deletes the editable Saved Scene. Published versions are not affected.`, 'Delete');
		if (!confirmed) return;
		try { await this._savedSceneUiOperation(() => this.deleteSavedScene()); }
		catch (error) { await this._handleSavedSceneUiError(error); }
	}

	async _handleSavedSceneUiError(error) {
		if (error?.code === 'conflict') {
			const choice = await this._showSavedSceneChoice('This Saved Scene was changed elsewhere. Save As or reload it?', { save: 'Save As', discard: 'Reload' });
			if (choice === 'save') return this._saveSavedSceneAsFromUi();
			if (choice === 'discard' && this.currentSavedSceneId) {
				const confirmed = await this._showSavedSceneConfirm('Reloading will discard your local changes. Continue?', 'Reload');
				if (confirmed) {
					try { await this._savedSceneUiOperation(() => this.openSavedScene(this.currentSavedSceneId)); }
					catch (reloadError) { this._showSavedSceneMessage(this._savedSceneErrorMessage(reloadError)); }
				}
			}
			return;
		}
		const message = this._savedSceneErrorMessage(error);
		if (message) this._showSavedSceneMessage(message);
	}

	_openTray(tab = this._trayTab) {
		const { tray, addBtn, trayClose } = this.ui;
		if (!tray) return;
		this._lastFocus = document.activeElement;
		tray.hidden = false;
		addBtn?.setAttribute('aria-expanded', 'true');
		this._setTrayTab(tab);
		trayClose?.focus?.();
	}

	_closeTray() {
		const { tray, addBtn } = this.ui;
		if (!tray || tray.hidden) return;
		const hadFocus = tray.contains(document.activeElement);
		tray.hidden = true;
		addBtn?.setAttribute('aria-expanded', 'false');
		if (hadFocus) this._restoreFocus(addBtn);
	}

	// Closing a dialog must hand the keyboard back to whatever opened it; dropping
	// focus on <body> strands a keyboard user at the top of the document.
	_restoreFocus(fallback) {
		const target = this._lastFocus && document.contains(this._lastFocus) && !this._lastFocus.hidden
			? this._lastFocus
			: fallback;
		target?.focus?.();
		this._lastFocus = null;
	}

	_setTrayTab(tab) {
		this._trayTab = tab;
		const tabs = [...(this.ui.trayTabs?.querySelectorAll('.ars-tab') || [])];
		for (const b of tabs) {
			const on = b.dataset.tab === tab;
			b.classList.toggle('is-active', on);
			b.setAttribute('aria-selected', String(on));
			b.tabIndex = on ? 0 : -1;
			if (on) {
				this.ui.trayBody?.setAttribute('aria-labelledby', b.id);
				b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
			}
		}
		this._renderTray();
	}

	async _renderTray() {
		const body = this.ui.trayBody;
		if (!body) return;
		const tab = this._trayTab;
		const source = this.sources.find((s) => s.id === tab);
		if (!source) return;
		if (source.kind === 'link' || source.id === 'link') {
			this._renderLinkTab(body);
			return;
		}

		body.textContent = '';
		body.appendChild(el('div', { class: 'ars-tray-loading' }, [
			el('span', { class: 'ars-spinner', 'aria-hidden': 'true' }), 'Loading models…',
		]));

		let items;
		try {
			// `live` sources (recents) change as you work, so they are never cached.
			if (!source.live && this._trayCache.has(tab)) items = this._trayCache.get(tab);
			else {
				items = await source.list();
				if (!source.live) this._trayCache.set(tab, items);
			}
		} catch (err) {
			log.warn('source failed', tab, err);
			if (this._trayTab !== tab) return;
			body.textContent = '';
			body.appendChild(el('div', { class: 'ars-tray-empty' }, [
				el('p', { text: `Couldn't load ${source.label || 'these models'} right now.` }),
				el('button', {
					type: 'button', class: 'ars-btn', text: 'Retry',
					onclick: () => { this._trayCache.delete(tab); this._renderTray(); },
				}),
			]));
			return;
		}
		if (this._trayTab !== tab) return;

		if (!items.length) {
			body.textContent = '';
			body.appendChild(el('div', { class: 'ars-tray-empty' }, [
				el('p', { text: source.emptyCopy || 'Nothing here yet.' }),
				this.forge
					? el('button', {
						type: 'button', class: 'ars-btn ars-btn-primary', text: 'Generate a model',
						onclick: () => { this._closeTray(); this.ui.forgeInput?.focus(); },
					})
					: null,
			]));
			return;
		}
		this._renderList(body, source, items);
	}

	_renderList(body, source, items) {
		body.textContent = '';
		const searchable = source.searchable ?? items.length > 24;
		let shown = LIST_SLICE;
		let search = null;

		if (searchable) {
			search = el('input', {
				class: 'ars-search', type: 'search', autocomplete: 'off',
				placeholder: `Search ${items.length} models…`,
				'aria-label': `Search ${source.label || 'models'}`,
			});
			body.appendChild(search);
		}
		if (source.hint) body.appendChild(el('p', { class: 'ars-hint', text: source.hint }));

		const list = el('ul', { class: 'ars-item-list' });
		const more = el('div', { class: 'ars-more' });
		body.appendChild(list);
		body.appendChild(more);

		const paint = () => {
			const q = (search?.value || '').trim().toLowerCase();
			const matches = q ? items.filter((o) => (o.keywords || o.title || '').toLowerCase().includes(q)) : items;
			list.textContent = '';
			for (const item of matches.slice(0, shown)) list.appendChild(this._trayItem(item));
			more.textContent = '';
			if (matches.length > shown) {
				const left = matches.length - shown;
				more.appendChild(el('button', {
					type: 'button', class: 'ars-btn',
					text: `Show ${Math.min(LIST_SLICE, left)} more (${left} left)`,
					onclick: () => { shown += LIST_SLICE; paint(); },
				}));
			} else if (!matches.length) {
				more.appendChild(el('p', { class: 'ars-hint', text: 'Nothing matches that search.' }));
			}
		};
		search?.addEventListener('input', () => { shown = LIST_SLICE; paint(); });
		paint();
	}

	_trayItem(item) {
		const label = item.title || 'Model';
		const thumb = el('span', { class: 'ars-item-thumb' });
		if (item.poster) {
			const img = el('img', { src: item.poster, alt: '', loading: 'lazy', decoding: 'async' });
			// A thumbnail that 404s would otherwise leave a broken-image glyph in the
			// grid, which makes the whole tray look broken.
			img.addEventListener('error', () => {
				thumb.textContent = '';
				thumb.appendChild(el('span', { class: 'ars-item-cube', 'aria-hidden': 'true', text: '◆' }));
			}, { once: true });
			thumb.appendChild(img);
		} else {
			thumb.appendChild(el('span', { class: 'ars-item-cube', 'aria-hidden': 'true', text: '◆' }));
		}
		const btn = el('button', {
			type: 'button', class: 'ars-item-add',
			title: item.title || '',
			'aria-label': `Add ${label} to your space`,
			onclick: () => {
				this._closeTray();
				this._addModel({ src: item.src, title: label, poster: item.poster });
			},
		}, [
			thumb,
			el('span', { class: 'ars-item-title', text: label }),
			el('span', { class: 'ars-item-cta', text: 'Add' }),
		]);
		return el('li', { class: 'ars-item' }, [btn]);
	}

	_renderLinkTab(body) {
		body.textContent = '';
		const input = el('input', {
			class: 'ars-search', type: 'url', inputmode: 'url', required: true,
			placeholder: 'https://example.com/model.glb', 'aria-label': 'GLB model URL',
		});
		const form = el('form', {}, [
			el('label', { class: 'ars-hint', for: '', text: 'Paste a link to any .glb model' }),
			el('div', { class: 'ars-link-row' }, [input, el('button', { type: 'submit', class: 'ars-btn ars-btn-primary', text: 'Add' })]),
			el('p', { class: 'ars-hint', text: 'Any https .glb works, as long as the host allows cross-origin requests.' }),
		]);
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			const url = normalizeGlbUrl(input.value);
			if (!url) {
				this._setStatus('That link is not a loadable https GLB.', { warn: true });
				input.focus();
				return;
			}
			this._closeTray();
			this._addModel({ src: url, title: filenameLabel(url) });
		});
		body.appendChild(form);
	}

	// ── Generation ────────────────────────────────────────────────────────────

	_forgeChip(state, label = '', elapsedS = null) {
		const chip = this.ui.chip;
		if (!chip) return;
		chip.dataset.state = state;
		chip.hidden = state === 'idle';
		const text = chip.querySelector('.ars-chip-label');
		const time = chip.querySelector('.ars-chip-elapsed');
		if (text) text.textContent = label;
		if (time) time.textContent = elapsedS == null ? '' : `${Math.round(elapsedS)}s`;
	}

	async _startForge(rawPrompt) {
		const prompt = String(rawPrompt || '').trim();
		if (!this.forge || prompt.length < 3 || this._forgeBusy) return null;
		this._forgeBusy = true;
		const seq = ++this._forgeSeq;
		if (this.ui.forgeGo) this.ui.forgeGo.disabled = true;
		const started = Date.now();
		this._forgeChip('working', 'Sending your prompt…', 0);
		const ticker = setInterval(() => {
			if (this.ui.chip?.dataset.state === 'working') {
				const label = this.ui.chip.querySelector('.ars-chip-label')?.textContent || '';
				this._forgeChip('working', label, (Date.now() - started) / 1000);
			}
		}, 1000);

		try {
			const model = await this.forge.generate(prompt, {
				onProgress: (s) => {
					if (seq !== this._forgeSeq) return;
					this._forgeChip('working', s.message, s.elapsedMs / 1000);
				},
			});
			if (seq !== this._forgeSeq) return null;
			rememberRecent({ src: model.src, title: model.prompt, poster: model.poster }, this._recentKey);
			this._trayCache.delete('recent');
			this._forgeChip('idle');
			if (this.ui.forgeInput) this.ui.forgeInput.value = '';
			await this._addModel({ src: model.src, title: model.title, poster: model.poster }, { announce: false });
			this._setStatus('Generated and placed. Pinch to resize, drag to move.');
			this._emit('generate', { model });
			return model;
		} catch (err) {
			if (seq === this._forgeSeq) {
				this._forgeChip('error', err?.message || 'Generation failed.');
				setTimeout(() => {
					if (this.ui.chip?.dataset.state === 'error') this._forgeChip('idle');
				}, 6500);
			}
			this._emit('generate-error', { error: err, prompt });
			return null;
		} finally {
			clearInterval(ticker);
			if (seq === this._forgeSeq) {
				this._forgeBusy = false;
				if (this.ui.forgeGo) this.ui.forgeGo.disabled = false;
			}
		}
	}

	// ── Entering AR ───────────────────────────────────────────────────────────

	/**
	 * Take this device into AR by its best available path. WebXR keeps the whole
	 * scene in the page; everything else hands one model to the platform's own AR
	 * viewer, which is the only way to get real ARKit / ARCore placement there.
	 */
	_enterAR() {
		// Immersive AR keeps the whole arrangement in the page, so a device that
		// has it goes straight in: an extra sheet in front of a one-tap experience
		// is friction, not polish. Everywhere else the hand-off is not instant and
		// not obvious, and the sheet is what makes it both.
		if (this.arMode === 'webxr') return this._toggleXR();
		this._openArSheet();
		return Promise.resolve();
	}

	// ── The AR hand-off sheet ─────────────────────────────────────────────────

	/**
	 * Cache identity for one placement's USDZ. The scale is in the key because it
	 * is baked into the export: someone who pinches a chair to half size and taps
	 * AR must get the half-size chair, not the cached full-size one.
	 */
	_arCacheKey(p) {
		return [
			p.src,
			p.group.scale.x.toFixed(3),
			Number(p.rotX || 0).toFixed(5),
			Number(p.yaw || 0).toFixed(5),
			Number(p.rotZ || 0).toFixed(5),
		].join('|');
	}

	/**
	 * The USDZ bytes for one placement.
	 *
	 * Exported from the copy already standing in the scene, so there is no second
	 * download and Quick Look receives the pose and the size on screen. A model
	 * the exporter chokes on falls back to a clean conversion of the original
	 * file rather than failing the tap.
	 */
	async _targetUsdz(p) {
		const { objectToUsdzBlob, glbUrlToUsdzBlob } = await import('./usdz.js');
		try {
			return await objectToUsdzBlob(p.group);
		} catch (err) {
			log.warn('live-scene USDZ export failed, refetching the source', err);
			return glbUrlToUsdzBlob(p.src);
		}
	}


	/**
	 * Stable cache identity for the exact composed scene.
	 *
	 * serializeScene() already captures every transform that changes the exported
	 * bytes, so moving, rotating, resizing, adding or removing a placement gets a
	 * different Quick Look cache entry automatically.
	 */
	_sceneArCacheKey() {
		return `scene|${serializeScene(this.getScene())}`;
	}

	/**
	 * Export every current placement as one USDZ while preserving the arrangement.
	 *
	 * Only placement roots are cloned: studio shadows, the selection ring, grid,
	 * lights and other preview helpers never enter the exported hierarchy.
	 */
	async _sceneUsdz() {
		const { sceneToUsdzBlob } = await import('./usdz.js');
		const group = new Group();
		group.name = 'ARScene';

		const visiblePlacements = this.placements.filter((p) => p.visible !== false);

		for (const [index, p] of visiblePlacements.entries()) {
			const instance = new Group();
			instance.name = `Placement_${index + 1}_${p.id}`;

			const copy = cloneSkinnedScene(p.group);

			// Give every exported instance a unique USD-facing identity even when
			// multiple placements came from the exact same source model.
			copy.name = `${p.title || 'Model'}_${index + 1}_${p.id}`;

			// Spawn animation temporarily shrinks group.scale; Quick Look should receive
			// the size the person actually selected, not the animation's intermediate size.
			copy.scale.setScalar(this._logicalScale(p));

			instance.add(copy);
			group.add(instance);
		}

		group.updateMatrixWorld(true);
		return sceneToUsdzBlob(group);
	}

	/**
	 * Prepare the composed scene before the user's tap. Safari requires Quick Look
	 * to be opened synchronously from the click that launches it.
	 */
	_prepareArScene() {
		const u = this.ui;
		if (!u.arScene) return;

		this._arSceneHandoff = null;
		this._arSceneKey = '';

		const count = this.placements.filter((p) => p.visible !== false).length;
		const available = this.arMode === 'quicklook' && count > 1;

		u.arScene.hidden = !available;
		if (!available) return;

		const key = this._sceneArCacheKey();
		this._arSceneKey = key;
		this._arKeys.add(key);

		const label = u.arScene.querySelector('.ars-ar-scene-label');
		u.arScene.disabled = true;
		u.arScene.setAttribute('aria-busy', 'true');
		if (label) label.textContent = `Preparing entire scene (${count} models)…`;

		prepareNativeAr({
			title: 'Entire scene',
			key,
			build: () => this._sceneUsdz(),
		}, {
			fallbackUrl: this.config.shareBaseUrl,
		}).then((handoff) => {
			if (this._destroyed || this._arSceneKey !== key) return;
			this._arSceneHandoff = handoff;
			u.arScene.disabled = false;
			u.arScene.removeAttribute('aria-busy');
			if (label) label.textContent = `Place entire scene (${count} models)`;
		}).catch((err) => {
			if (this._destroyed || this._arSceneKey !== key) return;
			log.warn('whole-scene AR preparation failed', err);
			u.arScene.disabled = true;
			u.arScene.removeAttribute('aria-busy');
			if (label) label.textContent = 'Entire scene unavailable';
		});
	}

	/**
	 * Fire the already-prepared whole-scene Quick Look hand-off synchronously.
	 */
	_onArSceneGo() {
		const handoff = this._arSceneHandoff;
		if (!handoff) return;

		this._yieldCameraToNativeAr();

		try {
			handoff.open();
		} catch (err) {
			log.warn('whole-scene native AR failed to open', err);
			this._setArStatus(`Could not open the scene in AR (${err?.message || err}).`, {
				state: 'error',
			});
			return;
		}

		if (this.config.urlExperience === 'space') {
			trackExperienceEvent(this.config, 'start');
		}

		this._emit('native-ar-scene', {
			count: this.placements.length,
			viewer: handoff.viewer,
		});
		this._closeArSheet();
		this._setStatus('Point at the floor, then drag to place the scene.');
	}

	/**
	 * A picture of the model the sheet is about to send, rendered from the model
	 * itself.
	 *
	 * A catalogue poster would be easier, but half the ways a model reaches this
	 * studio (a pasted URL, a generation still warming its thumbnail) have no
	 * poster at all, and a 200px empty box with a placeholder glyph in it is the
	 * kind of detail that makes a product feel unfinished. This renders the real
	 * thing, at the size and in the pose it is standing in the scene, off-screen
	 * into a render target so the live canvas never flickers.
	 *
	 * Best-effort by design: a context loss or a stubbed WebGL implementation
	 * returns null and the sheet falls back to its glyph.
	 *
	 * @param {object} p     The placement to portray
	 * @param {number} [size] Square edge, in device pixels
	 * @returns {string|null} a data: URL
	 */
	_renderArPreview(p, size = 384) {
		// An immersive session owns the renderer and its frame buffer; borrowing it
		// for a thumbnail mid-session is not worth a dropped XR frame.
		if (this.xrSession) return null;
		let target = null;
		try {
			const model = cloneSkinnedScene(p.group);
			model.position.set(0, 0, 0);
			model.rotation.set(0, 0, 0);
			model.updateMatrixWorld(true);

			const box = new Box3().setFromObject(model);
			if (box.isEmpty()) return null;
			const center = box.getCenter(new Vector3());
			const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.01);

			const scene = new Scene();
			scene.add(model);
			// Lit brighter than the room is: this is a product shot of the model,
			// not a preview of the scene's lighting, and dark props read as a
			// silhouette at anything subtler.
			scene.add(new HemisphereLight(0xffffff, 0x3a3a48, 3.4));
			const key = new DirectionalLight(0xffffff, 3.6);
			key.position.set(1.4, 2.2, 1.8);
			const fill = new DirectionalLight(0xdfe4ff, 1.5);
			fill.position.set(-1.6, 0.9, -1.2);
			scene.add(key, fill);

			const fov = 32;
			const cam = new PerspectiveCamera(fov, 1, radius / 100, radius * 100);
			// Three-quarter view from slightly above: the angle a product shot uses,
			// and the one that reads as a solid object rather than a flat card.
			const dist = (radius / Math.sin((fov * Math.PI) / 360)) * 1.06;
			cam.position.set(center.x + dist * 0.62, center.y + dist * 0.42, center.z + dist * 0.66);
			cam.lookAt(center);

			target = new WebGLRenderTarget(size, size, { depthBuffer: true });
			const prevTarget = this.renderer.getRenderTarget();
			this.renderer.setRenderTarget(target);
			this.renderer.clear();
			this.renderer.render(scene, cam);
			const pixels = new Uint8Array(size * size * 4);
			this.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
			this.renderer.setRenderTarget(prevTarget);

			const canvas = document.createElement('canvas');
			canvas.width = size;
			canvas.height = size;
			const ctx = canvas.getContext('2d');
			const image = ctx.createImageData(size, size);
			// WebGL reads bottom-up; a canvas is top-down.
			const stride = size * 4;
			for (let row = 0; row < size; row++) {
				image.data.set(pixels.subarray((size - 1 - row) * stride, (size - row) * stride), row * stride);
			}
			ctx.putImageData(image, 0, 0);
			return canvas.toDataURL('image/png');
		} catch (err) {
			log.warn('AR preview render failed', err);
			return null;
		} finally {
			target?.dispose();
		}
	}

	/** Which model the AR button would send right now. */
	_arDefaultTarget() {
		return this.selected || this.placements[this.placements.length - 1] || null;
	}

	/**
	 * Convert the likely AR target ahead of the tap, so the tap is instant.
	 *
	 * This is the whole reason Quick Look works here rather than appearing to do
	 * nothing: Safari opens `rel="ar"` only while the page holds user activation,
	 * and a conversion started inside the tap handler outlives it. Warming is
	 * debounced because a pinch changes the cache key on every frame.
	 */
	_warmQuickLook() {
		if (this._destroyed || this.arMode !== 'quicklook') return;
		clearTimeout(this._arWarmTimer);
		this._arWarmTimer = setTimeout(() => {
			if (this._destroyed) return;
			const target = this._arDefaultTarget();
			if (!target) return;
			const key = this._arCacheKey(target);
			if (isQuickLookReady(key)) return;
			this._arKeys.add(key);
			prepareNativeAr(
				{ src: target.src, title: target.title, key, build: () => this._targetUsdz(target) },
			).catch((err) => {
				// A warm-up failure is not the user's problem yet: the sheet retries
				// the same conversion in front of them, with a real error and a
				// retry button, if they ever ask for it.
				log.warn('AR warm-up failed', err);
			});
		}, 900);
	}

	/**
	 * Open the sheet that hands one model to the device's AR viewer.
	 * @param {object} [placement] Defaults to the selected model, then the last one.
	 */
	_openArSheet(placement) {
		const u = this.ui;
		if (!u.arModal) return;
		this._lastFocus = document.activeElement;
		u.arModal.hidden = false;
		this._showArTarget(placement || this._arDefaultTarget());
		// aria-modal is a promise that focus is inside the dialog.
		(u.arGo.hidden || u.arGo.disabled ? u.arClose : u.arGo)?.focus?.();
		this._emit('ar-sheet', { open: true });
	}

	_closeArSheet() {
		const { arModal, xrBtn } = this.ui;
		if (!arModal || arModal.hidden) return;
		const hadFocus = arModal.contains(document.activeElement);
		arModal.hidden = true;
		this._arToken++; // abandon any conversion still in flight for this sheet
		this._arSceneHandoff = null;
		this._arSceneKey = '';
		if (hadFocus) this._restoreFocus(xrBtn);
		this._emit('ar-sheet', { open: false });
	}

	_setArStatus(message, { state = '' } = {}) {
		const node = this.ui.arStatus;
		if (!node) return;
		node.textContent = '';
		node.classList.toggle('is-error', state === 'error');
		node.classList.toggle('is-ready', state === 'ready');
		if (!message) return;
		if (state === 'busy') node.appendChild(el('span', { class: 'ars-spinner', 'aria-hidden': 'true' }));
		node.appendChild(el('span', { text: message }));
	}

	/** Render the sheet for one target and start preparing it. */
	_showArTarget(target) {
		const u = this.ui;
		if (!u.arModal || u.arModal.hidden) return;
		this._arToken++;
		this._arHandoff = null;
		this._arTarget = target || null;

		const goLabel = u.arGo.querySelector('.ars-ar-go-label');
		this._arRetry = null;
		u.arXr.hidden = this.arMode !== 'webxr';
		u.arQr.hidden = true;
		u.arPicker.hidden = true;
		u.arPicker.textContent = '';
		this._arSceneHandoff = null;
		this._arSceneKey = '';
		if (u.arScene) {
			u.arScene.hidden = true;
			u.arScene.disabled = true;
			u.arScene.removeAttribute('aria-busy');
		}

		if (!target) {
			u.arThumb.textContent = '🪄';
			u.arName.textContent = 'Nothing to place yet';
			u.arHint.textContent = 'Add a model to the scene and it can stand on your real floor at its real size.';
			this._setArStatus(null);
			u.arGo.hidden = false;
			u.arGo.disabled = false;
			u.arGo.removeAttribute('aria-busy');
			if (goLabel) goLabel.textContent = 'Browse models';
			// The hexagon means "place this"; there is nothing to place yet.
			u.arGo.querySelector('.ars-ar-go-icon').hidden = true;
			return;
		}

		u.arThumb.textContent = '◆';
		const preview = this._renderArPreview(target) || target.poster;
		if (preview) {
			const img = el('img', { src: preview, alt: '' });
			// A poster that 404s would leave a broken-image glyph in the sheet.
			img.addEventListener('error', () => { u.arThumb.textContent = '◆'; }, { once: true });
			u.arThumb.textContent = '';
			u.arThumb.appendChild(img);
		}
		u.arName.textContent = target.title || 'Model';

		if (this.placements.length > 1) {
			u.arPicker.hidden = false;
			for (const p of this.placements) {
				u.arPicker.appendChild(el('button', {
					type: 'button', class: 'ars-ar-chip', 'data-ar-id': p.id,
					'aria-pressed': p === target ? 'true' : 'false',
					text: p.title || 'Model',
				}));
			}
		}

		if (this.arMode === 'none') {
			u.arHint.textContent = 'AR needs a phone. Open this scene on your iPhone or Android and the model stands on your real floor.';
			this._setArStatus(null);
			u.arGo.hidden = true;
			u.arQr.hidden = false;
			return;
		}

		u.arHint.textContent = 'Point your device at a flat surface, then drag to place it. It arrives at real size.';
		u.arGo.hidden = false;
		u.arGo.querySelector('.ars-ar-go-icon').hidden = false;
		if (goLabel) goLabel.textContent = 'Place in your space';
		this._prepareArTarget(target);
		this._prepareArScene();
	}

	/**
	 * Get the hand-off ready before the person taps for it.
	 *
	 * Scene Viewer needs nothing prepared, so it enables straight away. Quick
	 * Look needs a USDZ, which is why the button says so while it converts
	 * instead of sitting there looking broken for two seconds.
	 */
	async _prepareArTarget(target) {
		const u = this.ui;
		const token = this._arToken;
		const key = this._arCacheKey(target);
		const warm = this.arMode !== 'quicklook' || isQuickLookReady(key);

		if (!warm) {
			u.arGo.disabled = true;
			u.arGo.setAttribute('aria-busy', 'true');
			this._setArStatus('Preparing it for AR…', { state: 'busy' });
		}
		this._arKeys.add(key);
		try {
			const handoff = await prepareNativeAr({
				src: target.src, title: target.title, key, build: () => this._targetUsdz(target),
			}, { fallbackUrl: this.config.shareBaseUrl });
			if (token !== this._arToken || this._destroyed) return;
			this._arHandoff = handoff;
			u.arGo.disabled = false;
			u.arGo.removeAttribute('aria-busy');
			this._setArStatus(warm ? null : 'Ready.', { state: 'ready' });
			// Put the thumb back on the button that is now armed, but never steal
			// focus from a control the person moved to while they waited.
			const idle = document.activeElement === document.body || document.activeElement === u.arModal;
			if (!warm && idle) u.arGo.focus?.();
		} catch (err) {
			if (token !== this._arToken || this._destroyed) return;
			log.warn('AR preparation failed', err);
			u.arGo.disabled = true;
			u.arGo.removeAttribute('aria-busy');
			this._setArStatus(`Could not prepare this model for AR (${err?.message || err}).`, { state: 'error' });
			// The primary button stays the primary action: it just becomes the
			// retry, rather than leaving a dead button and a second one to hunt for.
			this._arRetry = target;
			u.arGo.disabled = false;
			u.arGo.querySelector('.ars-ar-go-label').textContent = 'Try again';
			u.arGo.querySelector('.ars-ar-go-icon').hidden = true;
			this._emit('native-ar-error', { error: err, src: target.src });
		}
	}

	/**
	 * The tap that opens AR.
	 *
	 * Everything expensive already happened, so this is deliberately synchronous
	 * from the click through to the anchor activation: put an `await` in front of
	 * `open()` and iOS drops the user gesture and silently refuses to open Quick
	 * Look.
	 */
	_onArGo() {
		if (!this._arTarget) {
			this._closeArSheet();
			this._openTray();
			return;
		}
		if (this._arRetry) {
			this._showArTarget(this._arRetry);
			return;
		}
		const handoff = this._arHandoff;
		if (!handoff) return;
		const { src, title } = this._arTarget;
		this._yieldCameraToNativeAr();
		try {
			handoff.open();
		} catch (err) {
			log.warn('native AR failed to open', err);
			this._setArStatus(`Could not open AR (${err?.message || err}).`, { state: 'error' });
			this._emit('native-ar-error', { error: err, src });
			return;
		}

		if (this.config.urlExperience === 'space') {
			trackExperienceEvent(this.config, 'start');
		}

		this._emit('native-ar', { src, title, viewer: handoff.viewer });
		this._closeArSheet();
		this._setStatus('Point at the floor, then drag to place it.');
	}

	/**
	 * Open one model in the device's native AR viewer. On iOS the GLB is
	 * converted to USDZ on the device first, which is why this reports progress:
	 * a couple of silent seconds after a tap reads as a dead button.
	 *
	 * @param {object} [placement] Defaults to the selected model, then the last one.
	 */
	async _placeNative(placement) {
		const target = placement || this.selected || this.placements[this.placements.length - 1];
		if (!target) {
			this._setStatus('Add a model first, then place it in your space.', { warn: true });
			return null;
		}
		if (this._nativeArBusy) return null;
		this._nativeArBusy = true;
		const btn = this.ui.xrBtn;
		btn?.setAttribute('aria-busy', 'true');

		this._arKeys.add(this._arCacheKey(target));
		const STAGES = {
			download: 'Fetching the model…',
			parse: 'Reading the model…',
			convert: 'Preparing it for AR…',
			open: 'Opening AR…',
		};
		this._setStatus(STAGES.download, { sticky: true });
		if (this.arMode === 'quicklook' || this.arMode === 'sceneviewer') this._yieldCameraToNativeAr();
		try {
			const opened = await placeInYourSpace(
				{
					src: target.src,
					title: target.title,
					key: this._arCacheKey(target),
					build: () => this._targetUsdz(target),
				},
				{
					onProgress: (stage) => this._setStatus(STAGES[stage] || 'Preparing AR…', { sticky: true }),
					fallbackUrl: this.config.shareBaseUrl,
				},
			);
			if (opened === 'none') {
				this._setStatus('This device has no AR viewer. Open this scene on a phone instead.', {
					warn: true, actionLabel: 'Show QR', onAction: () => this._openQr(),
				});
			} else {
				this._setStatus('Point at the floor, then drag to place it.');
			}
			this._emit('native-ar', { src: target.src, title: target.title, viewer: opened });
			return opened;
		} catch (err) {
			log.warn('native AR failed', err);
			this._setStatus(`Could not open AR for this model (${err?.message || err}).`, {
				warn: true, actionLabel: 'Try again', onAction: () => this._placeNative(target),
			});
			this._emit('native-ar-error', { error: err, src: target.src });
			return null;
		} finally {
			this._nativeArBusy = false;
			btn?.removeAttribute('aria-busy');
		}
	}

	// ── WebXR immersive session ───────────────────────────────────────────────

	async _toggleXR() {
		if (this.xrSession) {
			this.xrSession.end();
			return;
		}
		if (this.arTransitioning) return;
		this.arTransitioning = true;
		try {
			if (this.arActive) this._stopCamera(); // the immersive session owns the rear camera
			const session = new MultiPlaceSession({
				renderer: this.renderer,
				scene: this.scene,
				camera: this.camera,
				domOverlayRoot: this.ui.hud,
				getArmedContent: () => this._armedContent(),
				onPlaced: (group) => {
					const p = this.placements.find((x) => x.group === group);
					if (p) {
						p.yaw = 0;
						this._select(null); // the ring is a fallback-mode affordance
					}
					this._saveScene();
					this._setStatus(`Placed ${this.xrSession?.placedCount ?? ''}: tap another spot to add one more.`);
				},
				getScaleTarget: () => this.placements[this.placements.length - 1]?.group ?? null,
				onScale: (s, { final }) => { if (final) this._saveScene(); },
				onHit: (has) => this.ui.root.classList.toggle('xr-has-floor', has),
				onTracking: (ok) => {
					if (!ok) this._setStatus('Tracking lost: move to a brighter spot with more texture.', { warn: true, sticky: true });
					else this._setStatus(null);
				},
				onFrame: (dt) => {
					for (const p of this.placements) {
						p.mixer?.update(dt);
						p.idle?.update(dt);
					}
				},
				onEnd: () => this._onXREnd(),
			});
			this._stopLoop();
			await session.start();
			this.xrSession = session;

			if (this.config.urlExperience === 'space') {
				trackExperienceEvent(this.config, 'start');
			}

			// Real-world lighting and reflections: created after start() so the
			// addon's sessionstart listener requests the light probe.
			this.estimatedLight = new EstimatedLighting({
				renderer: this.renderer,
				scene: this.scene,
				baseLights: [this.hemi, this.sun],
				onChange: (on) => {
					if (on) this._setStatus('Lit by your room: reflections and shadows match the real light.');
				},
			});
			this.estimatedLight.start();
			this.ui.root.classList.add('is-xr');
			this._detachTransformGizmo();
			this.grid.visible = false;
			this.scene.fog = null;
			this.selRing.visible = false;
			for (const p of this.placements) if (p.shadow) p.shadow.visible = false;
			this.ui.xrBtn?.classList.add('is-active');
			this.ui.xrBtn?.setAttribute('aria-pressed', 'true');
			this._setStatus('Point at the floor, then tap to place. Every tap adds another model.');
			this._emit('xr', { active: true });
		} catch (err) {
			log.warn('XR session failed', err);
			this.estimatedLight?.dispose();
			this.estimatedLight = null;
			this._startLoop();
			this._setStatus('Could not start immersive AR on this device. Camera mode still works.', { warn: true });
		} finally {
			this.arTransitioning = false;
		}
	}

	/** What the next reticle tap places. An XR select cannot await, so only an
	 *  already-resolved template is placeable. */
	_armedContent() {
		const src = this._armed?.src ?? this.placements[this.placements.length - 1]?.src;
		if (!src) {
			this._setStatus('Pick a model first: Add or generate one, then tap the floor.', { warn: true });
			return null;
		}
		const tpl = this._templatesReady.get(src);
		if (!tpl) {
			this._loadTemplate(src);
			this._setStatus('Model is still loading: one moment, then tap again.', { sticky: true });
			return null;
		}
		const { group, mixer, idlePromise } = this._instantiate(tpl, src);
		const placement = {
			id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			src,
			title: this._armed?.title || '',
			poster: '',
			group,
			shadow: null,
			mixer,
			idle: null,
			yaw: 0,
			baseRadius: tpl.radius,
			height: tpl.height || 0,
			spawnT: 1,
			netId: null,
			ownerId: null,
			remote: false,
			_lastNetSend: 0,
		};
		idlePromise?.then((mgr) => {
			if (!mgr) return;
			if (this.placements.includes(placement)) placement.idle = mgr;
			else mgr.detach();
		});
		this.placements.push(placement);
		this._updateCount();
		this._emit('add', { placement: publicPlacement(placement, this), remote: false });
		return group;
	}

	_onXREnd() {
		this.xrSession = null;
		this.estimatedLight?.dispose();
		this.estimatedLight = null;
		this.ui.root.classList.remove('is-xr', 'xr-has-floor');
		this.ui.xrBtn?.classList.remove('is-active');
		this.ui.xrBtn?.setAttribute('aria-pressed', 'false');
		// Ground anything the session placed mid-air back onto the floor plane so
		// the fallback layout stays coherent, then resume our own loop.
		for (const p of this.placements) {
			p.group.position.y = 0;
			if (p.shadow) {
				p.shadow.visible = p.visible !== false;
				p.shadow.position.set(p.group.position.x, 0.004, p.group.position.z);
			}
		}
		this.grid.visible = !this.arActive;
		if (!this.arActive) this.scene.fog = this._fog;
		if (this._runtimeGroupMatchesSelection()) {
			this._attachRuntimeGroupGizmo();
		} else if (this.selected?.visible !== false) {
			this._attachTransformGizmo(this.selected);
		}
		this._syncTransformInspector();
		this._saveScene();
		this._startLoop();
		this._setStatus('Back to the studio view.');
		this._emit('xr', { active: false });
	}

	// ── Photo + export + QR ──────────────────────────────────────────────────

	_experienceUrl(mode) {
		const normalized =
			mode === 'marker'
				? 'marker'
				: 'space';

		const url = new URL(this.shareUrl(), location.href);
		url.searchParams.set('experience', normalized);
		return url.href;
	}

	_openExport() {
		const {
			exportModal,
			exportSpaceLink,
			exportMarkerLink,
			exportMarkerNote,
		} = this.ui;

		if (!exportModal) return;

		this._lastFocus = document.activeElement;

		if (exportSpaceLink) {
			exportSpaceLink.href = this._experienceUrl('space');
		}

		const markerReady =
			(this.sceneType === 'marker-horizontal' ||
			this.sceneType === 'marker-vertical') &&
			Boolean(this.sceneTarget?.mind);

		if (exportMarkerLink) {
			exportMarkerLink.href = markerReady
				? this._experienceUrl('marker')
				: '#';
			exportMarkerLink.setAttribute(
				'aria-disabled',
				markerReady ? 'false' : 'true',
			);
			exportMarkerLink.classList.toggle('is-disabled', !markerReady);
			exportMarkerLink.tabIndex = markerReady ? 0 : -1;
		}

		if (exportMarkerNote) {
			exportMarkerNote.hidden = markerReady;
		}

		exportModal.hidden = false;
		this.ui.exportClose?.focus?.();

		this._emit('export-open', {
			spaceUrl: this._experienceUrl('space'),
			markerUrl: markerReady ? this._experienceUrl('marker') : '',
		});
	}

	_closeExport() {
		const { exportModal, exportBtn } = this.ui;
		if (!exportModal || exportModal.hidden) return;

		const hadFocus = exportModal.contains(document.activeElement);
		exportModal.hidden = true;

		if (hadFocus) this._restoreFocus(exportBtn);
	}

	async _capturePhoto() {
		this.renderer.render(this.scene, this.camera); // fresh pixels under preserveDrawingBuffer
		const blob = await captureComposite({ canvas: this.ui.canvas, video: this.ui.video, isAR: this.arActive });
		if (!blob) {
			this._setStatus('Could not capture the frame.', { warn: true });
			return;
		}
		try {
			const how = await shareOrDownload(blob, {
				filename: 'ar-studio.png',
				title: this.config.branding?.title || 'AR Studio',
			});

			trackExperienceEvent(this.config, 'capture');

			this._setStatus(how === 'shared' ? 'Shared.' : 'Saved to your downloads.');
		} catch (err) {
			if (err?.name !== 'AbortError') this._setStatus('Could not share that photo.', { warn: true });
		}
	}

	/**
	 * Store the current composed scene and return the server's compact share URL.
	 * Any failure returns an empty string so sharing can fall back to #s=.
	 */
	async _shortSceneUrl() {
		const endpoint = String(this.config.sceneShareEndpoint || '').trim();
		if (!endpoint || !this.placements.length) return '';

		const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;

		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					scene: JSON.parse(serializeScene(
						this.getScene(),
						this._sceneMetadata(),
					)),
				}),
				...(controller ? { signal: controller.signal } : {}),
			});

			if (!res.ok) throw new Error(`scene share returned ${res.status}`);

			const payload = await res.json();
			const url = String(payload?.url || '').trim();

			// The wrapper may return either an absolute HTTPS URL or a same-origin path.
			if (url.startsWith('/') && !url.startsWith('//')) {
				return new URL(url, location.origin).href;
			}

			if (/^https:\/\//i.test(url)) return url;

			throw new Error('scene share returned an invalid URL');
		} catch (err) {
			log.warn('short scene link unavailable; using portable scene URL', err);
			return '';
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async _openQr(urlOverride = '') {
		const { qrModal, qrBox, qrLink } = this.ui;
		if (!qrModal) return;

		this._lastFocus = document.activeElement;

		// Runtime experiences pass their exact typed launch URL so the QR preserves
		// experience=space / experience=marker. The editor keeps its existing
		// portable-scene behavior.
		const overrideUrl = String(urlOverride || '').trim();
		let portableUrl = overrideUrl || this.shareUrl();

		const runtimeJourney = overrideUrl
			? getExperienceJourneyId(this.config)
			: '';

		if (runtimeJourney) {
			try {
				const journeyUrl = new URL(portableUrl, location.href);
				journeyUrl.searchParams.set('journey', runtimeJourney);
				portableUrl = journeyUrl.href;
			} catch {
				// Keep the original portable URL if it cannot be parsed.
			}
		}

		qrModal.hidden = false;

		if (qrBox) {
			qrBox.textContent = this.config.sceneShareEndpoint
				? 'Preparing scene link…'
				: '';
		}

		if (qrLink) {
			qrLink.href = portableUrl;
			qrLink.textContent = portableUrl.length > 72
				? `${portableUrl.slice(0, 69)}…`
				: portableUrl;
		}

		// aria-modal is a promise that focus is inside the dialog.
		this.ui.qrClose?.focus?.();

		// Use the existing scene shortener for published experiences too. A typed
		// runtime only needs its experience mode added back onto the compact scene
		// URL; the stored scene itself remains the same.
		let shortUrl = await this._shortSceneUrl();

		if (shortUrl && overrideUrl) {
			try {
				const mode = this.config.urlExperience;
				if (mode === 'space' || mode === 'marker') {
					const typedShortUrl = new URL(shortUrl, location.href);
					typedShortUrl.searchParams.set('experience', mode);

					if (runtimeJourney) {
						typedShortUrl.searchParams.set('journey', runtimeJourney);
					}

					shortUrl = typedShortUrl.href;
				}
			} catch {
				shortUrl = '';
			}
		}

		const url = shortUrl || portableUrl;

		// The person may have closed the sheet while the API request was running.
		if (qrModal.hidden) return;

		if (qrBox) {
			try {
				qrBox.innerHTML = renderQRToSVG(url, {
					scale: 6,
					margin: 2,
					dark: '#0b0b0b',
					light: '#ffffff',
				});
			} catch {
				if (overrideUrl) {
					// A published runtime must never silently fall back to an editor URL.
					qrBox.textContent = url;
				} else {
					// Preserve the editor's historical models-only QR fallback.
					try {
						qrBox.innerHTML = renderQRToSVG(
							studioShareUrl(this.config.shareBaseUrl, this.getScene()),
							{ scale: 6, margin: 2, dark: '#0b0b0b', light: '#ffffff' },
						);
					} catch {
						qrBox.textContent = url;
					}
				}
			}
		}

		if (qrLink) {
			qrLink.href = url;
			qrLink.textContent = url.length > 72 ? `${url.slice(0, 69)}…` : url;
		}

		this._emit('share', {
			url,
			short: Boolean(shortUrl),
		});
	}

	_closeQr() {
		const { qrModal, qrBtn } = this.ui;
		if (!qrModal || qrModal.hidden) return;
		const hadFocus = qrModal.contains(document.activeElement);
		qrModal.hidden = true;
		if (hadFocus) this._restoreFocus(qrBtn);
	}

	// ── Shared rooms ──────────────────────────────────────────────────────────

	// A model I control: single-player models (no ownerId) and my own room models.
	// Other people's room models stay visible and live but are not mine to edit
	// the server owner-gates too, so this is the local half of the same rule.
	_isMine(p) {
		return !p.ownerId || p.ownerId === this.clientId;
	}

	_placementShared(p) {
		return localToShared({
			x: p.group.position.x,
			y: p.group.position.y,
			z: p.group.position.z,
			...(p.rotX ? { rotX: p.rotX } : {}),
			yaw: p.yaw,
			...(p.rotZ ? { rotZ: p.rotZ } : {}),
			scale: this._logicalScale(p),
			height: p.height || 0,
		});
	}

	_placementWire(p, wireId) {
		return { id: wireId, src: p.src, title: p.title, ...this._placementShared(p) };
	}

	// Throttled to ~12 Hz so a drag does not flood the socket.
	_netBroadcastTransform(p) {
		if (!this.net || this.net.status !== 'online' || !p.netId || !this._isMine(p)) return;
		const now = Date.now();
		if (now - (p._lastNetSend || 0) < 80) return;
		p._lastNetSend = now;
		const s = this._placementShared(p);
		this.net.update(p.netId, { relEast: s.relEast, relNorth: s.relNorth, yawDeg: s.yawDeg, scale: s.scale });
	}

	_applySharedTransform(p, m) {
		const l = sharedToLocal(m);
		p.group.position.set(l.x, 0, l.z);
		p.yaw = l.yaw;
		p.group.rotation.y = l.yaw;
		p.group.scale.setScalar(l.scale);
		p.group.userData._targetScale = l.scale;
		p.spawnT = 1; // an update is not a spawn: no scale-in pop
		if (p.shadow) {
			p.shadow.position.set(l.x, 0.004, l.z);
			p.shadow.scale.setScalar(l.scale);
		}
		if (this.selected === p) this._positionSelRing();
	}

	// Reconcile the room's full model list against local placements: add what
	// appeared, drop remote ones that left, refresh other people's transforms. My
	// own live models are authored locally and never overwritten by their echo.
	_reconcileRemoteModels(models) {
		const serverIds = new Set(models.map((m) => m.id));
		for (const p of [...this.placements]) {
			if (p.remote && p.netId && !serverIds.has(p.netId)) {
				this._removePlacement(p, { persist: false, broadcast: false });
			}
		}
		let fresh = 0;
		for (const m of models) {
			const existing = this._netModels.get(m.id);
			if (existing) {
				if (!this._isMine(existing)) this._applySharedTransform(existing, m);
				continue;
			}
			const local = sharedToLocal(m);
			const mine = !!m.mine || m.ownerId === this.clientId;
			if (!mine) fresh++;
			this._addModel({ src: m.src, title: m.title }, {
				x: local.x, z: local.z, yaw: local.yaw, scale: local.scale,
				remote: true, netId: m.id, ownerId: mine ? this.clientId : m.ownerId,
				announce: false, persist: false,
			});
		}
		this._updateCount();
		// After the join burst settles, a new model from someone else is live
		// activity worth surfacing: but never during the initial sync.
		if (this._roomSynced && fresh > 0) {
			this._setStatus(fresh === 1 ? 'Someone added a model to the room.' : `${fresh} models were added to the room.`);
		}
		this._roomSynced = true;
	}

	_applyRemoteModelChange(m) {
		const p = this._netModels.get(m.id);
		if (!p) return;
		if (m.removed) {
			if (p.remote) this._removePlacement(p, { persist: false, broadcast: false });
			return;
		}
		if (!this._isMine(p)) this._applySharedTransform(p, m);
	}

	_wireNet(net) {
		net.on('status', ({ status }) => {
			if (status === 'online') {
				this._setStatus(`Shared room ${this.roomCode} is live: edits sync to everyone here.`);
				this.ui.root.classList.add('is-room');
			} else if (status === 'connecting') {
				this._setStatus(`Joining room ${this.roomCode}…`, { sticky: true });
			} else if (status === 'unavailable' || status === 'failed') {
				this._setStatus('Shared rooms are offline right now: you can still build solo.', { warn: true });
				this._leaveRoom({ silent: true });
			} else if (status === 'offline') {
				this._setStatus('Reconnecting to the room…', { sticky: true });
			}
			this._updateRoomButton();
			this._emit('room', { status, code: this.roomCode });
		});
		net.on('models', (models) => this._reconcileRemoteModels(models));
		net.on('model', (m) => this._applyRemoteModelChange(m));
		net.on('presence', (p) => {
			const prev = this._presence.count;
			this._presence = p;
			this._updateCount();
			if (!this.ui.roomModal.hidden) this._renderRoomModal();
			if (prev > 0 && p.count > prev) {
				this._setStatus(p.count === 2 ? "Someone joined: you're building together now." : 'Someone else joined the room.');
			} else if (prev > 1 && p.count < prev && p.count >= 1) {
				this._setStatus(p.count === 1 ? "You're on your own in the room now." : 'Someone left the room.');
			}
		});
		net.on('reject', (msg) => {
			const why = msg?.reason === 'room_full' ? 'the room is full'
				: msg?.reason === 'owner_full' ? 'you have the maximum models in this room'
					: 'the room declined it';
			this._setStatus(`Couldn't share that model: ${why}.`, { warn: true });
		});
	}

	// Push every model I already have into a freshly created room, so a solo scene
	// becomes the shared starting point instead of vanishing.
	_seedRoom() {
		if (!this.net || this.net.status !== 'online') return;
		for (const p of this.placements) {
			if (p.netId) continue;
			const wireId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
			p.netId = wireId;
			p.ownerId = this.clientId;
			p.remote = false;
			this._netModels.set(wireId, p);
			this.net.spawn(this._placementWire(p, wireId));
		}
	}

	// seed=true is right for CREATE (I am the first one there). JOIN never seeds:
	// entering a room means entering ITS scene, so my solo models stay local and
	// cannot duplicate the server's authoritative copies on a rejoin.
	async _joinRoom(code, { seed = false } = {}) {
		const norm = normalizeRoomCode(code);
		if (!norm) {
			this._setStatus('That room code looks off: check the 6 characters and try again.', { warn: true });
			return;
		}
		this._leaveRoom({ silent: true });
		this._roomSynced = false;
		this.roomCode = norm;
		const net = new StudioNet({
			roomKey: roomKeyForCode(norm),
			clientId: this.clientId,
			name: '',
			url: this.config.rooms?.server || '',
		});
		this.net = net;
		this._wireNet(net);
		await net.connect();
		// A failed connect fires status 'failed' synchronously and the handler nulls
		// `this.net`, so re-check identity rather than dereferencing a dead field.
		if (this.net === net && net.status === 'online') {
			if (seed) this._seedRoom();
			this._roomHeartbeat = setInterval(() => this.net?.heartbeat(), 15000);
			try {
				const url = new URL(location.href);
				url.searchParams.set('room', norm);
				history.replaceState(null, '', url);
			} catch { /* history is unavailable in some embeds */ }
		}
		this._updateRoomButton();
	}

	_createRoom() {
		return this._joinRoom(generateRoomCode(), { seed: true });
	}

	_leaveRoom({ silent = false } = {}) {
		if (this._roomHeartbeat) {
			clearInterval(this._roomHeartbeat);
			this._roomHeartbeat = null;
		}
		if (this.net) {
			try { this.net.destroy(); } catch { /* already destroyed */ }
			this.net = null;
		}
		// Remote models leave with the room; my own stay as a local scene.
		for (const p of [...this.placements]) {
			if (p.remote && !this._isMine(p)) this._removePlacement(p, { persist: false, broadcast: false });
			else { p.netId = null; p.remote = false; }
		}
		this._netModels.clear();
		this.roomCode = '';
		this._presence = { count: 1, names: [] };
		this.ui.root.classList.remove('is-room');
		try {
			const url = new URL(location.href);
			url.searchParams.delete('room');
			history.replaceState(null, '', url);
		} catch { /* history unavailable */ }
		this._updateCount();
		this._updateRoomButton();
		if (!silent) this._setStatus('Left the shared room. Your models are still here.');
	}

	_updateRoomButton() {
		const btn = this.ui.roomBtn;
		if (!btn) return;
		const live = !!this.net && (this.net.status === 'online' || this.net.status === 'connecting');
		btn.classList.toggle('is-active', live);
		// Two labels rather than one rewritten string, so a host that translated the
		// idle label does not lose it the first time the room state changes.
		const idle = btn.querySelector('.ars-room-label');
		const code = btn.querySelector('.ars-room-code-label');
		if (idle) idle.hidden = live;
		if (code) {
			code.hidden = !live;
			code.textContent = live ? (this.roomCode || 'Room') : '';
		}
		if (!this.ui.roomModal.hidden) this._renderRoomModal();
	}

	_renderRoomModal() {
		const online = !!this.net && this.net.status === 'online';
		const { roomIdle, roomLive, roomCode, roomPresence, roomQr } = this.ui;
		if (roomIdle) roomIdle.hidden = online;
		if (roomLive) roomLive.hidden = !online;
		if (!online) return;
		if (roomCode) roomCode.textContent = this.roomCode;
		if (roomPresence) {
			roomPresence.textContent = this._presence.count > 1
				? `${this._presence.count} people are building here.`
				: 'You are the only one here yet: share the code to invite someone.';
		}
		if (roomQr) {
			const url = roomShareUrl(this.config.shareBaseUrl, this.roomCode);
			try {
				roomQr.innerHTML = renderQRToSVG(url, { scale: 5, margin: 2, dark: '#0b0b0b', light: '#ffffff' });
			} catch {
				roomQr.textContent = url;
			}
		}
	}

	_openRoomModal() {
		const m = this.ui.roomModal;
		if (!m) return;
		this._lastFocus = document.activeElement;
		m.hidden = false;
		this._renderRoomModal();
		(this.net?.status === 'online' ? this.ui.roomCopy : this.ui.roomCreate)?.focus?.();
	}

	_closeRoomModal() {
		const m = this.ui.roomModal;
		if (!m || m.hidden) return;
		const hadFocus = m.contains(document.activeElement);
		m.hidden = true;
		if (hadFocus) this._restoreFocus(this.ui.roomBtn);
	}

	async _createRoomFromUI() {
		await this._createRoom();
		this._renderRoomModal();
		// One-tap invite: put the join link on the clipboard immediately, still
		// inside this click's user activation, so hosting is create → paste.
		if (this.net?.status === 'online' && navigator.clipboard?.writeText) {
			try {
				await navigator.clipboard.writeText(roomShareUrl(this.config.shareBaseUrl, this.roomCode));
				this._setStatus(`Room ${this.roomCode} is live: invite link copied. Paste it to a friend.`);
			} catch { /* clipboard blocked: the Copy button is still there */ }
		}
	}

	async _joinRoomFromUI() {
		const input = this.ui.roomJoinInput;
		const code = normalizeRoomCode(input?.value);
		if (!code) {
			this._setStatus('That room code looks off: check the 6 characters.', { warn: true });
			input?.focus?.();
			return;
		}
		await this._joinRoom(code);
		this._renderRoomModal();
	}

	async _copyRoomInvite() {
		const url = roomShareUrl(this.config.shareBaseUrl, this.roomCode);
		const btn = this.ui.roomCopy;
		try {
			const how = await shareUrlOrCopy(url, {
				title: 'Build with me in AR',
				text: `Join my AR Studio room: ${this.roomCode}`,
			});
			if (btn) {
				const old = btn.textContent;
				btn.textContent = how === 'shared' ? 'Shared ✓' : 'Link copied ✓';
				setTimeout(() => { btn.textContent = old; }, 1600);
			}
		} catch (err) {
			if (err?.name !== 'AbortError') window.prompt('Copy this invite link:', url);
		}
	}

	// ── Render loop ───────────────────────────────────────────────────────────

	// Desktop preview has no gyro and no real room to look at, so a model dropped
	// on the floor lands below the eyeline and reads as "nothing happened". Tilt
	// the view down to actually frame what is in the scene: but only until the
	// viewer takes the camera themselves, after which their aim is the truth.
	_framePreview() {
		if (this.arActive || this.xrSession || this._userLooked || !this.placements.length) return;
		let sx = 0;
		let sz = 0;
		let sh = 0;
		for (const p of this.placements) {
			sx += p.group.position.x;
			sz += p.group.position.z;
			sh += (p.height || 0.4) * (p.group.userData._targetScale ?? 1);
		}
		const n = this.placements.length;
		const cx = sx / n;
		const cz = sz / n;
		const centre = (sh / n) * 0.5;
		const dist = Math.hypot(cx - this.camera.position.x, cz - this.camera.position.z);
		if (!(dist > 0.05)) return;
		this.cameraYaw = Math.atan2(cx - this.camera.position.x, -(cz - this.camera.position.z));
		this.cameraPitch = clampPitch(-Math.atan2(this.camera.position.y - centre, dist), PITCH_MIN, PITCH_MAX);
	}

	_applyCameraLook() {
		this.camera.rotation.set(0, 0, 0);
		this.camera.rotateY(this.cameraYaw);
		this.camera.rotateX(this.cameraPitch);
	}

	_tick(t) {
		this._rafId = requestAnimationFrame((next) => this._tick(next));
		const dt = this._prevT ? Math.min(0.1, (t - this._prevT) / 1000) : 0.016;
		this._prevT = t;

		for (const p of this.placements) {
			p.mixer?.update(dt);
			p.idle?.update(dt);
			if (p.spawnT < 1) {
				p.spawnT = Math.min(1, p.spawnT + dt * 3.2);
				const e = 1 - (1 - p.spawnT) ** 3; // ease-out cubic
				const target = p.group.userData._targetScale ?? 1;
				p.group.scale.setScalar(Math.max(0.001, target * e));
				p.shadow?.scale.setScalar(Math.max(0.001, target * e));
			}
		}
		if (this.selected && !this.markerTracker?.running) {
			this._positionSelRing();
		}

		if (this.markerTracker?.running) {
			this.camera.position.set(0, 0, 0);
			this.camera.rotation.set(0, 0, 0);
		} else {
			this._applyCameraLook();
		}

		this.renderer.render(this.scene, this.camera);
	}

	_startLoop() {
		if (this._rafId === null) {
			this._prevT = 0;
			this._rafId = requestAnimationFrame((t) => this._tick(t));
		}
	}

	_stopLoop() {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
	}

	_resize() {
		const { width, height } = this._viewportSize();
		this.renderer.setSize(width, height, false);

		if (this.markerTracker?.running) {
			this._applyMarkerProjection(this.markerTracker);
			return;
		}

		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this._applyCameraFov();
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/** Install the identity returned by a future Saved Scene persistence call. */
	adoptSavedSceneIdentity({ id = null, name = '', revision = null } = {}) {
		this.currentSavedSceneId = id == null ? null : String(id);
		this.currentSavedSceneName = name == null ? '' : String(name);
		this.currentSavedSceneRevision = revision == null ? null : revision;
		this.markCurrentDocumentAsBaseline();
		return this.getSavedSceneState();
	}

	/** Update identity metadata without changing the document baseline or dirty state. */
	updateSavedSceneIdentity({ name, revision } = {}) {
		if (name !== undefined) this.currentSavedSceneName = name == null ? '' : String(name);
		if (revision !== undefined) this.currentSavedSceneRevision = revision == null ? null : revision;
		return this.getSavedSceneState();
	}

	/** Detach the editor from a Saved Scene while retaining the authored document. */
	clearSavedSceneIdentity({ preserveName = false, dirty = true } = {}) {
		this.currentSavedSceneId = null;
		this.currentSavedSceneRevision = null;
		if (!preserveName) this.currentSavedSceneName = '';

		if (dirty) {
			// There is no persisted Saved Scene baseline after deletion/detach.
			this.savedSceneBaseline = '';
			this.recomputeDirtyState();
		} else {
			this.markCurrentDocumentAsBaseline();
		}

		return this.getSavedSceneState();
	}

	/** Make the current canonical document the clean comparison baseline. */
	markCurrentDocumentAsBaseline() {
		this.savedSceneBaseline = this._currentDocumentJson();
		this.dirty = false;
		return this.savedSceneBaseline;
	}

	/** Recompute dirty state from canonical document JSON, never from UI events. */
	recomputeDirtyState(documentJson = this._currentDocumentJson()) {
		this.dirty = documentJson !== this.savedSceneBaseline;
		return this.dirty;
	}

	_currentDocumentJson() {
		return JSON.stringify(this.getSceneDocument());
	}

	/** Read-only Saved Scene state for future host/UI integration. */
	getSavedSceneState() {
		return {
			id: this.currentSavedSceneId,
			name: this.currentSavedSceneName,
			revision: this.currentSavedSceneRevision,
			dirty: this.dirty,
			busy: this.savedSceneBusy,
		};
	}

	/** Run one serialized Saved Scene operation against the optional transport. */
	async _runSavedSceneOperation(operation, { signal } = {}) {
		this._ensureSavedScenesAvailable();
		if (this.savedSceneBusy) {
			throw new SavedSceneError('Another Saved Scene operation is already in progress.', {
				code: 'busy',
			});
		}
		this.savedSceneBusy = true;
		try {
			return await operation(signal);
		} finally {
			this.savedSceneBusy = false;
		}
	}

	_ensureSavedScenesAvailable() {
		if (this.config?.urlExperience === 'space' || this.config?.urlExperience === 'marker') {
			throw new SavedSceneError('Saved Scenes are unavailable in published experiences.', {
				code: 'unavailable',
			});
		}
		if (!this._savedScenes) {
			throw new SavedSceneError('Saved Scene transport is unavailable.', {
				code: 'unavailable',
			});
		}
	}

	_assertSavedSceneIdentity() {
		if (this.currentSavedSceneId == null || !Number.isSafeInteger(this.currentSavedSceneRevision)
			|| this.currentSavedSceneRevision < 1) {
			throw new SavedSceneError('A Saved Scene identity and revision are required.', {
				code: 'unavailable',
			});
		}
	}

	_assertServerDocumentMatchesCurrent(resource, currentDocument = this.getSceneDocument()) {
		if (JSON.stringify(resource.scene) !== JSON.stringify(currentDocument)) {
			throw new SavedSceneError('Saved Scene server document differs from the editor document.', {
				code: 'protocol_error',
			});
		}
	}

	/** List Saved Scene metadata without changing the current editor state. */
	listSavedScenes(options = {}) {
		return this._runSavedSceneOperation(
			(signal) => this._savedScenes.list({ ...options, signal }),
			options,
		);
	}

	/** Save the current document, creating it when no Saved Scene is open. */
	saveSavedScene({ name, signal } = {}) {
		return this._runSavedSceneOperation(async () => {
			const document = this.getSceneDocument();
			let resource;
			if (this.currentSavedSceneId == null) {
				if (name === undefined) {
					throw new SavedSceneError('A Saved Scene name is required for first Save.', {
						code: 'invalid_name',
					});
				}
				resource = await this._savedScenes.create({ name, scene: document }, { signal });
			} else {
				this._assertSavedSceneIdentity();
				resource = await this._savedScenes.update(this.currentSavedSceneId, {
					scene: document,
					revision: this.currentSavedSceneRevision,
				}, { signal });
			}
			this._assertServerDocumentMatchesCurrent(resource, document);
			this.adoptSavedSceneIdentity({
				id: resource.id,
				name: resource.name,
				revision: resource.revision,
			});
			return resource;
		}, { signal });
	}

	/** Always create and adopt a new Saved Scene identity. */
	saveSavedSceneAs({ name, signal } = {}) {
		return this._runSavedSceneOperation(async () => {
			const document = this.getSceneDocument();
			if (name === undefined) {
				throw new SavedSceneError('A Saved Scene name is required for Save As.', {
					code: 'invalid_name',
				});
			}
			const resource = await this._savedScenes.create({ name, scene: document }, { signal });
			this._assertServerDocumentMatchesCurrent(resource, document);
			this.adoptSavedSceneIdentity({ id: resource.id, name: resource.name, revision: resource.revision });
			return resource;
		}, { signal });
	}

	/** Open a Saved Scene atomically, adopting identity only after restoration succeeds. */
	openSavedScene(id, { signal } = {}) {
		return this._runSavedSceneOperation(async () => {
			const previousDocument = this.getSceneDocument();
			const previousState = {
				id: this.currentSavedSceneId,
				name: this.currentSavedSceneName,
				revision: this.currentSavedSceneRevision,
				baseline: this.savedSceneBaseline,
				dirty: this.dirty,
			};
			const resource = await this._savedScenes.get(id, { signal });
			try {
				const restored = await this.setSceneDocument(resource.scene);
				if (JSON.stringify(restored) !== JSON.stringify(resource.scene)) {
					throw new SavedSceneError('Saved Scene restore was not canonical.', { code: 'protocol_error' });
				}
				this.adoptSavedSceneIdentity({ id: resource.id, name: resource.name, revision: resource.revision });
				return resource;
			} catch (error) {
				try { await this.setSceneDocument(previousDocument); } catch { /* preserve original failure */ }
				this.currentSavedSceneId = previousState.id;
				this.currentSavedSceneName = previousState.name;
				this.currentSavedSceneRevision = previousState.revision;
				this.savedSceneBaseline = previousState.baseline;
				this.dirty = previousState.dirty;
				throw error;
			}
		}, { signal });
	}

	/** Rename the current Saved Scene without changing its document baseline. */
	renameSavedScene(name, { signal } = {}) {
		return this._runSavedSceneOperation(async () => {
			this._assertSavedSceneIdentity();
			const dirty = this.dirty;
			const baseline = this.savedSceneBaseline;
			const resource = await this._savedScenes.rename(this.currentSavedSceneId, {
				name,
				revision: this.currentSavedSceneRevision,
			}, { signal });
			this.updateSavedSceneIdentity({ name: resource.name, revision: resource.revision });
			this.savedSceneBaseline = baseline;
			this.dirty = dirty;
			return resource;
		}, { signal });
	}

	/** Duplicate the current Saved Scene without changing editor identity. */
	duplicateSavedScene({ name, adopt = false, signal } = {}) {
		return this._runSavedSceneOperation(async () => {
			this._assertSavedSceneIdentity();
			const resource = await this._savedScenes.duplicate(this.currentSavedSceneId, { name }, { signal });
			if (adopt) {
				this._assertServerDocumentMatchesCurrent(resource);
				this.adoptSavedSceneIdentity({ id: resource.id, name: resource.name, revision: resource.revision });
			}
			return resource;
		}, { signal });
	}

	/** Delete a current or explicitly identified Saved Scene. */
	deleteSavedScene(id = this.currentSavedSceneId, { revision, signal } = {}) {
		return this._runSavedSceneOperation(async () => {
			const isCurrent = id != null && id === this.currentSavedSceneId;
			const targetRevision = revision ?? (isCurrent ? this.currentSavedSceneRevision : null);
			if (id == null || !Number.isSafeInteger(targetRevision) || targetRevision < 1) {
				throw new SavedSceneError('A Saved Scene ID and revision are required.', { code: 'invalid_revision' });
			}
			await this._savedScenes.delete(id, { revision: targetRevision }, { signal });
			if (isCurrent) this.clearSavedSceneIdentity({ preserveName: true, dirty: true });
			return true;
		}, { signal });
	}

	/**
	 * Add a model to the scene.
	 * @param {{src: string, title?: string, poster?: string}} model
	 * @param {object} [opts] `x` `z` `yaw` `scale` `announce` `persist`
	 * @returns {Promise<object|null>} the placement, or null when it could not load
	 */
	addModel(model, opts) {
		return this._addModel(model, opts);
	}

	/** Remove every model. Returns what was removed, so a host can offer its own undo. */
	clear() {
		const items = this.getScene();
		for (const p of [...this.placements]) this._removePlacement(p, { persist: false });
		this._saveScene();
		this._emit('clear', { items });
		return items;
	}

	/** The current arrangement as plain data, including every persisted transform axis. */
	getScene() {
		return this.placements.map((p) => ({
			src: p.src,
			title: p.title,
			x: p.group.position.x,
			y: p.group.position.y,
			z: p.group.position.z,
			rotX: p.rotX,
			yaw: p.yaw,
			rotZ: p.rotZ,
			scale: this._logicalScale(p),
			visible: p.visible !== false,
			...(p.groupId ? { group: p.groupId } : {}),
			...(p.action ? { action: { ...p.action } } : {}),
		}));
	}

	/** Replace the scene with an arrangement in the shape `getScene()` returns. */
	async setScene(items) {
		const document = JSON.parse(serializeScene(
			Array.isArray(items) ? items : [],
			this._sceneMetadata(),
		));

		await this.setSceneDocument(document);
	}

	/** Canonical v1 scene document, including optional marker metadata. */
	getSceneDocument() {
		return JSON.parse(serializeScene(
			this.getScene(),
			this._sceneMetadata(),
		));
	}

	/**
	 * Replace the complete authored v1 document.
	 *
	 * Every unique model is loaded before the current live scene is touched. If a
	 * later installation step unexpectedly fails, the previous canonical document
	 * is restored before the rejection reaches the caller.
	 */
	async setSceneDocument(document) {
		let parsed;

		try {
			parsed = typeof document === 'string'
				? JSON.parse(document)
				: JSON.parse(JSON.stringify(document));
		} catch (err) {
			throw new TypeError('ar-studio: invalid scene document JSON', { cause: err });
		}

		if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) {
			throw new TypeError('ar-studio: expected a v1 scene document');
		}

		const normalized = deserializeSceneDocument(JSON.stringify(parsed));
		const sources = [...new Set(normalized.items.map((item) => item.src))];

		try {
			await Promise.all(sources.map((src) => this._loadTemplate(src)));
		} catch (err) {
			log.warn('scene document preload failed', err);
			this._setStatus(
				"Couldn't restore that scene: one or more models could not be loaded.",
				{ warn: true },
			);
			throw new Error('ar-studio: scene document assets could not be loaded', { cause: err });
		}

		const previous = this.getSceneDocument();

		try {
			await this._installSceneDocument(normalized);
		} catch (err) {
			log.warn('scene document installation failed; restoring previous scene', err);

			try {
				const rollback = deserializeSceneDocument(JSON.stringify(previous));
				await this._installSceneDocument(rollback);
			} catch (rollbackError) {
				log.error('scene document rollback failed', rollbackError);
			}

			throw err;
		}

		return this.getSceneDocument();
	}

	async _installSceneDocument(documentData) {
		this.clear();

		this.sceneType = normalizeSceneType(documentData.type);
		this.sceneTarget = normalizeSceneTarget(
			documentData.target,
			this.sceneType,
		);

		if (this.sceneType !== 'free' && !this.sceneTarget) {
			this.sceneTarget = this._defaultSceneTarget(this.sceneType);
		}

		this._syncTargetPreview();
		this._syncSceneSetupUI();

		for (const it of documentData.items) {
			const placement = await this._addModel(
				{ src: it.src, title: it.title },
				{
					x: it.x,
					y: it.y ?? 0,
					z: it.z,
					rotX: it.rotX ?? 0,
					yaw: it.yaw,
					rotZ: it.rotZ ?? 0,
					scale: it.scale,
					visible: it.visible !== false,
					groupId: it.group || null,
					action: it.action || null,
					announce: false,
					persist: false,
				},
			);

			if (!placement) {
				throw new Error(`ar-studio: could not restore model ${it.src}`);
			}
		}

		this._saveScene();
	}

	/** A link that reopens this exact arrangement, models and transforms included. */
	shareUrl() {
		return studioSceneUrl(
			this.config.shareBaseUrl,
			this.getScene(),
			1500,
			this._sceneMetadata(),
		);
	}

	/** Generate a model from a prompt and drop it into the scene. */
	generate(prompt) {
		return this._startForge(prompt);
	}

	/** Hand one model to the device's own AR viewer (Quick Look / Scene Viewer). */
	viewInYourSpace(src, title = '') {
		const url = normalizeGlbUrl(src);
		if (!url) return '';
		const launch = buildArLaunchUrl(this.config.origin, url, title, { endpoint: this.config.arLaunchUrl });
		window.open(launch, '_blank', 'noopener');
		return launch;
	}

	/** Turn the camera passthrough on. Call it from a user gesture (iOS requires one). */
	startCamera() { return this._startCamera(); }

	/** Turn the camera passthrough off. */
	stopCamera() { this._stopCamera(); }

	/** Enter or leave the immersive WebXR session. */
	toggleImmersive() { return this._toggleXR(); }

	/**
	 * Take this device into AR by its best path: the immersive session where
	 * WebXR exists, otherwise the platform's own AR viewer.
	 */
	enterAR() { return this._enterAR(); }

	/**
	 * Open one model in the device's native AR viewer (Quick Look on iOS, Scene
	 * Viewer on Android). Defaults to the selected model.
	 * @param {object} [placement]
	 */
	placeInYourSpace(placement) { return this._placeNative(placement); }

	/**
	 * Open the AR hand-off sheet: the screen that prepares one model and then
	 * opens the device's own AR viewer from a single tap.
	 * @param {object} [placement] Defaults to the selected model, then the last one.
	 */
	openArSheet(placement) { this._openArSheet(placement); }

	/** Close the AR hand-off sheet. */
	closeArSheet() { this._closeArSheet(); }

	/** Open a shared room (a new one when `code` is omitted). Returns the code. */
	async openRoom(code) {
		if (code) await this._joinRoom(code);
		else await this._createRoom();
		return this.roomCode;
	}

	/** Leave the shared room, keeping your own models. */
	leaveRoom() { this._leaveRoom(); }

	/** Tear the studio down: camera, socket, listeners, GPU context, DOM. */
	destroy() {
		if (this._destroyed) return;
		this._destroyed = true;
		this._stopLoop();
		this._stopCamera();
		this.xrSession?.end();
		this.net?.destroy();
		if (this._roomHeartbeat) clearInterval(this._roomHeartbeat);
		clearTimeout(this._statusTimer);
		clearTimeout(this._arWarmTimer);
		// Only this studio's own conversions: a second studio on the page may be
		// sharing the cache and still needs its entries.
		for (const key of this._arKeys) releaseQuickLook(key);
		this._arKeys.clear();
		clearInterval(this._lightTimer);
		document.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('deviceorientationabsolute', this._onOrientationAbsolute, true);
		window.removeEventListener('deviceorientation', this._onOrientation, true);
		window.removeEventListener('resize', this._onResize);
		window.removeEventListener('pagehide', this._onPageHide);
		window.removeEventListener('beforeunload', this._onBeforeUnload);
		if (this._onArReturn) {
			document.removeEventListener('visibilitychange', this._onArReturn);
			window.removeEventListener('focus', this._onArReturn);
			this._onArReturn = null;
		}
		this._ro?.disconnect();

		this._dropRuntimeGroup();
		this._detachTransformGizmo();
		if (this.transformHelper) this.scene.remove(this.transformHelper);
		this.transformControls?.dispose?.();
		this.transformControls = null;
		this.transformHelper = null;

		for (const p of [...this.placements]) this._removePlacement(p, { persist: false, broadcast: false });
		this._disposeTargetPreview();
		this.shadowTex?.dispose();
		this.selRing.geometry.dispose();
		this.selRing.material.dispose();
		this.renderer.dispose();
		this.ui.root.remove();
		this._listeners.clear();
	}
}

// ── Module-private helpers ───────────────────────────────────────────────────

function prefersReducedMotion() {
	try {
		return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

function makeTargetPreviewTexture({ orientation = 'horizontal' } = {}) {
	try {
		const width = 768;
		const height = 512;
		const cnv = document.createElement('canvas');

		cnv.width = width;
		cnv.height = height;

		const ctx = cnv.getContext('2d');
		if (!ctx) return null;

		ctx.fillStyle = '#171923';
		ctx.fillRect(0, 0, width, height);

		const cell = 64;
		for (let y = 0; y < height; y += cell) {
			for (let x = 0; x < width; x += cell) {
				if (((x / cell) + (y / cell)) % 2 === 0) {
					ctx.fillStyle = '#202536';
					ctx.fillRect(x, y, cell, cell);
				}
			}
		}

		ctx.strokeStyle = '#8b7cf8';
		ctx.lineWidth = 10;
		ctx.strokeRect(8, 8, width - 16, height - 16);

		ctx.strokeStyle = 'rgba(255,255,255,0.32)';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(width / 2, 32);
		ctx.lineTo(width / 2, height - 32);
		ctx.moveTo(32, height / 2);
		ctx.lineTo(width - 32, height / 2);
		ctx.stroke();

		ctx.fillStyle = '#ffffff';
		ctx.font = '700 52px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('TARGET', width / 2, height / 2 - 18);

		ctx.fillStyle = 'rgba(255,255,255,0.72)';
		ctx.font = '500 26px system-ui, sans-serif';
		ctx.fillText(
			orientation === 'vertical'
				? 'VERTICAL MARKER'
				: 'HORIZONTAL MARKER',
			width / 2,
			height / 2 + 42,
		);

		const texture = new CanvasTexture(cnv);
		texture.needsUpdate = true;
		return texture;
	} catch {
		return null;
	}
}

function makeShadowTexture() {
	try {
		const size = 128;
		const cnv = document.createElement('canvas');
		cnv.width = size;
		cnv.height = size;
		const ctx = cnv.getContext('2d');
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, 'rgba(0,0,0,0.40)');
		g.addColorStop(0.55, 'rgba(0,0,0,0.18)');
		g.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		return new CanvasTexture(cnv);
	} catch {
		return null;
	}
}

function makeLightProbe() {
	try {
		const cnv = document.createElement('canvas');
		cnv.width = 16;
		cnv.height = 16;
		return { cnv, ctx: cnv.getContext('2d', { willReadFrequently: true }) };
	} catch {
		return null;
	}
}

/** A stable per-browser id. It decides who owns which model in a shared room. */
function readClientId(scope) {
	const key = `${scope || 'ar-studio'}:client`;
	try {
		let id = localStorage.getItem(key);
		if (!id) {
			id = crypto?.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(key, id);
		}
		return id;
	} catch {
		return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

/** A readable label from a model URL: `alarm_clock_01.glb` → `Alarm clock 01`. */
function filenameLabel(url) {
	const base = String(url).split('?')[0].split('/').pop() || 'Model';
	const stem = base.replace(/\.(glb|gltf)$/i, '').replace(/[_-]+/g, ' ').trim();
	return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : 'Linked model';
}

/** The shape a placement takes when it leaves the studio in an event. */
function publicPlacement(p, studio) {
	return {
		id: p.id,
		src: p.src,
		title: p.title,
		x: p.group.position.x,
		y: p.group.position.y,
		z: p.group.position.z,
		...(p.rotX ? { rotX: p.rotX } : {}),
		yaw: p.yaw,
		...(p.rotZ ? { rotZ: p.rotZ } : {}),
		scale: studio._logicalScale(p),
		visible: p.visible !== false,
		...(p.groupId ? { group: p.groupId } : {}),
		mine: studio._isMine(p),
	};
}

function uTrim(value) { return String(value || '').trim(); }
function sceneTypeLabel(type) { return type === 'marker-horizontal' ? 'Marker Horizontal' : type === 'marker-vertical' ? 'Marker Vertical' : 'Free'; }
function formatSavedSceneDate(value) { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)); } catch { return ''; } }
