// The studio's DOM.
//
// Built in code rather than shipped as an HTML file so the whole surface is one
// import: `createArStudio(document.body)` and you have a working AR studio, with
// no markup to copy, no stylesheet to link, and no ids to keep in sync.
//
// Every control is a real button with a real accessible name, the tab strip
// implements the full ARIA tablist contract (arrow keys, roving tabindex), and
// every dialog is a real `role="dialog"` that takes and returns focus. The
// stylesheet is injected once per document and scoped under `.ars-root`.

import { studioStyles } from './styles.js';

const STYLE_ID = 'ar-studio-styles';

/** Inject the stylesheet once per document. */
export function ensureStyles(doc = document) {
	if (doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = studioStyles();
	doc.head.appendChild(style);
}

function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === null || v === undefined || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k === 'hidden') node.hidden = Boolean(v);
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? '' : String(v));
	}
	for (const child of [].concat(children)) {
		if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}

export { el };

/**
 * Build the studio's DOM inside `host` and return every node the controller
 * drives. The host keeps whatever children it already had: the studio appends
 * its own root: so it can be mounted inside an existing layout.
 *
 * @param {HTMLElement} host
 * @param {object} cfg  Resolved config (branding, generate, rooms).
 * @returns {Record<string, HTMLElement>}
 */
export function buildUI(host, cfg) {
	ensureStyles(host.ownerDocument || document);

	const t = cfg.branding || {};
	const canGenerate = cfg.generate?.enabled !== false;
	const canRoom = cfg.rooms?.enabled !== false;

	const video = el('video', { class: 'ars-video', playsinline: true, muted: true, 'aria-hidden': 'true' });
	const canvas = el('canvas', { class: 'ars-canvas' });

	// ── Published experience chrome ──────────────────────────────────────────
	const experienceMode =
		cfg.urlExperience === 'space' || cfg.urlExperience === 'marker'
			? cfg.urlExperience
			: '';

	const runtimeBrand = el('div', {
		class: 'ars-runtime-brand',
		hidden: !experienceMode,
	}, [
		t.logo
			? el('img', {
				class: 'ars-runtime-logo',
				src: t.logo,
				alt: t.title || 'Sixty8',
			})
			: el('span', { text: t.title || 'Sixty8' }),
	]);

	const runtimePrimary = el('button', {
		type: 'button',
		class: 'ars-runtime-primary',
		hidden: !experienceMode,
		'aria-label': experienceMode === 'marker'
			? 'Start marker augmented reality'
			: 'Place this scene in your space',
	}, [
		el('span', {
			class: 'ars-runtime-primary-icon',
			'aria-hidden': 'true',
			text: experienceMode === 'marker' ? '⌗' : '⬡',
		}),
		el('span', {
			class: 'ars-runtime-primary-label',
			text: experienceMode === 'marker'
				? 'Start Marker AR'
				: 'Place in your space',
		}),
	]);

	const runtimeMobileBtn = el('button', {
		type: 'button',
		class: 'ars-runtime-mobile',
		hidden: !experienceMode,
		'aria-label': 'Open this AR experience on your phone',
	}, [
		el('span', { 'aria-hidden': 'true', text: '📱' }),
		el('span', { text: 'Open on mobile' }),
	]);

	const runtimePhotoBtn = el('button', {
		type: 'button',
		class: 'ars-runtime-photo',
		hidden: !experienceMode,
		disabled: true,
		'aria-label': 'Take a screenshot',
	}, [
		el('span', { 'aria-hidden': 'true', text: '●' }),
	]);

	const runtimeControls = el('div', {
		class: 'ars-runtime-controls',
		hidden: !experienceMode,
	}, [
		runtimePrimary,
		runtimeMobileBtn,
		runtimePhotoBtn,
	]);

	const runtimeChrome = el('div', {
		class: 'ars-runtime-chrome',
		hidden: !experienceMode,
	}, [
		runtimeBrand,
		runtimeControls,
	]);

	// ── Top bar ──────────────────────────────────────────────────────────────
	const back = t.backHref
		? el('a', { class: 'ars-back', href: t.backHref }, [el('span', { 'aria-hidden': 'true', text: '←' }), t.backLabel || 'Back'])
		: null;
	const title = el('span', { class: 'ars-title', text: t.title || 'AR Studio' });
	const count = el('span', { class: 'ars-count', hidden: true, role: 'status', 'aria-live': 'polite' });
	const sceneBtn = el('button', {
		type: 'button',
		class: 'ars-icon-btn ars-scene-btn',
		hidden: true,
		'aria-expanded': 'false',
		'aria-label': 'Open scene model tree',
	}, [
		el('span', { 'aria-hidden': 'true', text: '▤' }),
		'Scene',
	]);

	const exportBtn = el('button', {
		type: 'button',
		class: 'ars-icon-btn ars-export-btn',
		'aria-label': 'Export this scene as an AR experience',
	}, [
		el('span', { 'aria-hidden': 'true', text: '↗' }),
		'Export',
	]);
	const roomBtn = canRoom
		? el('button', { type: 'button', class: 'ars-icon-btn', 'aria-label': 'Open a shared room so other people can build in this scene with you' }, [
			el('span', { 'aria-hidden': 'true', text: '👥' }),
			el('span', { class: 'ars-room-label', text: 'Share live' }),
			el('span', { class: 'ars-room-code-label', hidden: true }),
		])
		: null;
	const qrBtn = el('button', { type: 'button', class: 'ars-icon-btn', hidden: true, 'aria-label': 'Show a QR code that opens this scene on your phone' }, [
		el('span', { 'aria-hidden': 'true', text: '📱' }), 'Open on phone',
	]);
	// One AR button that always does the best thing this device can do: an
	// immersive WebXR session where that exists, otherwise the device's own AR
	// viewer (Quick Look / Scene Viewer). The label is set at boot, once the
	// capability is known, so it never promises the wrong experience.
	const xrBtn = el('button', { type: 'button', class: 'ars-icon-btn', hidden: true, 'aria-pressed': 'false', 'aria-label': 'View this in augmented reality' }, [
		el('span', { 'aria-hidden': 'true', text: '✦' }),
		el('span', { class: 'ars-ar-label', text: 'AR' }),
	]);
	const cameraBtn = el('button', { type: 'button', class: 'ars-icon-btn', 'aria-pressed': 'false', 'aria-label': 'Turn the camera on to see your models in the room' }, [
		el('span', { 'aria-hidden': 'true', text: '📷' }), 'Camera',
	]);

	const savedSceneEnabled = !experienceMode;
	const savedSceneName = el('span', { class: 'ars-saved-scene-name', text: 'Untitled' });
	const savedSceneState = el('span', { class: 'ars-saved-scene-state', role: 'status', 'aria-live': 'polite' });
	const savedSceneTrigger = el('button', { type: 'button', class: 'ars-icon-btn ars-saved-scene-trigger', hidden: !savedSceneEnabled, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Saved Scene menu' }, [savedSceneName, savedSceneState, el('span', { 'aria-hidden': 'true', text: '▾' })]);
	const savedSceneControl = el('div', { class: 'ars-saved-scene-control' });

	const top = el('div', { class: 'ars-top' }, [
		back, title, count, sceneBtn, savedSceneControl, exportBtn,
		el('span', { class: 'ars-spacer' }),
		roomBtn, qrBtn, xrBtn, cameraBtn,
	]);

	// ── Saved Scene menu actions (editor only) ────────────────────────────────
	const savedSceneNew = el('button', { type: 'button', class: 'ars-btn ars-saved-scene-btn', text: 'New', disabled: !savedSceneEnabled });
	const savedSceneOpen = el('button', { type: 'button', class: 'ars-btn ars-saved-scene-btn', text: 'Open', disabled: !savedSceneEnabled });
	const savedSceneSave = el('button', { type: 'button', class: 'ars-btn ars-btn-primary ars-saved-scene-btn', text: 'Save', disabled: !savedSceneEnabled });
	const savedSceneSaveAs = el('button', { type: 'button', class: 'ars-btn ars-saved-scene-btn', text: 'Save As', disabled: !savedSceneEnabled });
	const savedSceneRename = el('button', { type: 'button', class: 'ars-btn ars-saved-scene-btn', text: 'Rename', disabled: !savedSceneEnabled });
	const savedSceneDuplicate = el('button', { type: 'button', class: 'ars-btn ars-saved-scene-btn', text: 'Duplicate', disabled: !savedSceneEnabled });
	const savedSceneDelete = el('button', { type: 'button', class: 'ars-btn ars-saved-scene-btn ars-btn-danger', text: 'Delete', disabled: !savedSceneEnabled });
	const savedSceneMenu = el('div', { class: 'ars-saved-scene-menu', hidden: true, role: 'menu', 'aria-label': 'Saved Scene actions' }, [savedSceneNew, savedSceneOpen, savedSceneSave, savedSceneSaveAs, savedSceneRename, savedSceneDuplicate, savedSceneDelete]);
	savedSceneControl.append(savedSceneTrigger, savedSceneMenu);
	for (const action of savedSceneMenu.children) action.setAttribute('role', 'menuitem');

	const savedScenePanelClose = el('button', { type: 'button', class: 'ars-btn', text: 'Close' });
	const savedScenePanelStatus = el('p', { class: 'ars-saved-scene-panel-status', role: 'status', 'aria-live': 'polite' });
	const savedScenePanelList = el('div', { class: 'ars-saved-scene-list', role: 'list', tabindex: '0' });
	const savedScenePanel = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ars-saved-scenes-title' }, [
		el('div', { class: 'ars-dialog ars-saved-scene-dialog' }, [
			el('h2', { id: 'ars-saved-scenes-title', text: 'Open Saved Scene' }),
			savedScenePanelStatus, savedScenePanelList, savedScenePanelClose,
		]),
	]);

	const savedSceneNameInput = el('input', { class: 'ars-search', type: 'text', maxlength: '120', autocomplete: 'off', 'aria-label': 'Saved Scene name' });
	const savedSceneNameError = el('p', { class: 'ars-saved-scene-error', role: 'alert', hidden: true });
	const savedSceneNameCancel = el('button', { type: 'button', class: 'ars-btn', text: 'Cancel' });
	const savedSceneNameSubmit = el('button', { type: 'button', class: 'ars-btn ars-btn-primary', text: 'Continue' });
	const savedSceneNameModal = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ars-saved-name-title' }, [
		el('div', { class: 'ars-dialog' }, [
			el('h2', { id: 'ars-saved-name-title', text: 'Name Saved Scene' }),
			savedSceneNameInput, savedSceneNameError,
			el('div', { class: 'ars-dialog-row' }, [savedSceneNameCancel, savedSceneNameSubmit]),
		]),
	]);

	const savedSceneDecisionMessage = el('p', {});
	const savedSceneDecisionSave = el('button', { type: 'button', class: 'ars-btn ars-btn-primary', text: 'Save' });
	const savedSceneDecisionDiscard = el('button', { type: 'button', class: 'ars-btn', text: 'Discard' });
	const savedSceneDecisionCancel = el('button', { type: 'button', class: 'ars-btn', text: 'Cancel' });
	const savedSceneDecisionModal = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ars-saved-decision-title' }, [
		el('div', { class: 'ars-dialog' }, [
			el('h2', { id: 'ars-saved-decision-title', text: 'Unsaved changes' }), savedSceneDecisionMessage,
			el('div', { class: 'ars-dialog-row' }, [savedSceneDecisionSave, savedSceneDecisionDiscard, savedSceneDecisionCancel]),
		]),
	]);

	const savedSceneConfirmMessage = el('p', {});
	const savedSceneConfirmCancel = el('button', { type: 'button', class: 'ars-btn', text: 'Cancel' });
	const savedSceneConfirmSubmit = el('button', { type: 'button', class: 'ars-btn ars-btn-primary', text: 'Confirm' });
	const savedSceneConfirmModal = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ars-saved-confirm-title' }, [
		el('div', { class: 'ars-dialog' }, [
			el('h2', { id: 'ars-saved-confirm-title', text: 'Confirm action' }), savedSceneConfirmMessage,
			el('div', { class: 'ars-dialog-row' }, [savedSceneConfirmCancel, savedSceneConfirmSubmit]),
		]),
	]);

	// ── Progress chip ────────────────────────────────────────────────────────
	const chip = el('div', { class: 'ars-chip', hidden: true, 'data-state': 'idle', role: 'status', 'aria-live': 'polite' }, [
		el('span', { class: 'ars-spinner', 'aria-hidden': 'true' }),
		el('span', { class: 'ars-chip-label' }),
		el('span', { class: 'ars-chip-elapsed' }),
	]);

	// ── Empty state ──────────────────────────────────────────────────────────
	const emptyCamera = el('button', { type: 'button', class: 'ars-btn ars-btn-primary' }, [
		el('span', { 'aria-hidden': 'true', text: '📷' }), 'Turn on the camera',
	]);
	const emptyAdd = el('button', { type: 'button', class: 'ars-btn', text: 'Browse models' });
	const emptyForge = canGenerate ? el('button', { type: 'button', class: 'ars-btn', text: 'Generate one' }) : null;
	const empty = el('div', { class: 'ars-empty' }, [
		el('div', { class: 'ars-empty-card' }, [
			el('div', { class: 'ars-empty-art', 'aria-hidden': 'true', text: '🪄' }),
			el('h2', { text: 'Put anything in your room' }),
			el('p', {
				text: canGenerate
					? 'Add a model, or describe one and watch it appear. Turn on the camera and it stands on your actual floor.'
					: 'Add a model from the library, then turn on the camera and it stands on your actual floor.',
			}),
			el('div', { class: 'ars-empty-row' }, [emptyCamera, emptyAdd, emptyForge]),
		]),
	]);

	// ── Status + selection ───────────────────────────────────────────────────
	const status = el('div', { class: 'ars-status', hidden: true, role: 'status', 'aria-live': 'polite' });
	const selName = el('span', { class: 'ars-sel-name' });
	const selbar = el('div', { class: 'ars-selbar', hidden: true, role: 'toolbar', 'aria-label': 'Selected model or models' }, [
		selName,
		el('button', {
			type: 'button',
			class: 'ars-icon-btn',
			'data-act': 'rotate',
			'aria-label': 'Rotate the selected model',
		}, [
			el('span', { 'aria-hidden': 'true', text: '⟳' }),
		]),
		el('button', {
			type: 'button',
			class: 'ars-icon-btn ars-sel-group',
			'data-act': 'group',
			'aria-label': 'Group selected models',
			hidden: true,
			text: 'Group',
		}),
		el('button', {
			type: 'button',
			class: 'ars-icon-btn ars-sel-visibility',
			'data-act': 'visibility',
			'aria-label': 'Hide selected models',
			text: 'Hide',
		}),
		el('button', {
			type: 'button',
			class: 'ars-icon-btn',
			'data-act': 'duplicate',
			'aria-label': 'Duplicate selected models',
		}, [
			el('span', { 'aria-hidden': 'true', text: '⧉' }),
		]),
		el('button', {
			type: 'button',
			class: 'ars-icon-btn',
			'data-act': 'remove',
			'aria-label': 'Remove selected models',
		}, [
			el('span', { 'aria-hidden': 'true', text: '✕' }),
		]),
	]);

	// ── Scene tree ────────────────────────────────────────────────────────────
	const transformModes = el('div', {
		class: 'ars-transform-modes',
		role: 'group',
		'aria-label': 'Transform mode',
	}, [
		el('button', {
			type: 'button',
			class: 'ars-transform-mode is-active',
			'data-transform-mode': 'translate',
			'aria-pressed': 'true',
			text: 'Move',
		}),
		el('button', {
			type: 'button',
			class: 'ars-transform-mode',
			'data-transform-mode': 'rotate',
			'aria-pressed': 'false',
			text: 'Rotate',
		}),
		el('button', {
			type: 'button',
			class: 'ars-transform-mode',
			'data-transform-mode': 'scale',
			'aria-pressed': 'false',
			text: 'Scale',
		}),
	]);

	const transformSnapToggle = el('input', {
		type: 'checkbox',
		class: 'ars-transform-snap-checkbox',
		'aria-label': 'Enable transform snapping',
	});

	const transformSnapSwitch = el('label', {
		class: 'ars-transform-snap-switch',
	}, [
		transformSnapToggle,
		el('span', { class: 'ars-transform-snap-indicator', 'aria-hidden': 'true' }),
		el('span', { text: 'Snap' }),
	]);

	const snapField = (label, name, value, step) => el('label', {
		class: 'ars-transform-snap-field',
	}, [
		el('span', { text: label }),
		el('input', {
			type: 'number',
			value,
			step,
			min: step,
			inputmode: 'decimal',
			'data-transform-snap': name,
		}),
	]);

	const transformSnapFields = el('div', {
		class: 'ars-transform-snap-fields',
	}, [
		snapField('Move (m)', 'translate', '0.10', '0.01'),
		snapField('Rotate (°)', 'rotate', '15', '1'),
		snapField('Scale', 'scale', '0.10', '0.01'),
	]);

	const transformSnapSettings = el('div', {
		class: 'ars-transform-snap-settings is-disabled',
	}, [
		transformSnapSwitch,
		transformSnapFields,
	]);

	const transformField = (label, name, step = '0.01') => el('label', {
		class: 'ars-transform-field',
	}, [
		el('span', { text: label }),
		el('input', {
			type: 'number',
			step,
			'data-transform-field': name,
			inputmode: 'decimal',
		}),
	]);

	const transformFields = el('div', { class: 'ars-transform-fields' }, [
		transformField('X', 'x'),
		transformField('Y', 'y'),
		transformField('Z', 'z'),
		transformField('Rot X°', 'rotX', '1'),
		transformField('Yaw°', 'yaw', '1'),
		transformField('Rot Z°', 'rotZ', '1'),
		transformField('Scale', 'scale', '0.05'),
	]);

	const transformGround = el('button', {
		type: 'button',
		class: 'ars-transform-reset',
		text: 'Snap to ground',
	});

	const transformReset = el('button', {
		type: 'button',
		class: 'ars-transform-reset',
		text: 'Reset transform',
	});

	const groupVisibility = el('button', {
		type: 'button',
		class: 'ars-transform-group-action',
		'data-group-action': 'visibility',
		text: 'Hide Group',
	});

	const groupUngroup = el('button', {
		type: 'button',
		class: 'ars-transform-group-action',
		'data-group-action': 'ungroup',
		text: 'Ungroup',
	});

	const transformGroupActions = el('div', {
		class: 'ars-transform-group-actions',
		hidden: true,
	}, [
		groupVisibility,
		groupUngroup,
	]);

	const transformTitle = el('div', {
		class: 'ars-transform-title',
		text: 'Transform',
	});

	const transformInspector = el('section', {
		class: 'ars-transform-inspector',
		hidden: true,
		'aria-label': 'Transform selected model or group',
	}, [
		transformTitle,
		transformModes,
		transformSnapSettings,
		transformFields,
		transformGround,
		transformReset,
		transformGroupActions,
	]);

	const sceneTypeSelect = el('select', {
		class: 'ars-scene-type-select',
		'aria-label': 'Scene type',
	}, [
		el('option', { value: 'free', text: 'Free scene' }),
		el('option', { value: 'marker-horizontal', text: 'Horizontal target' }),
		el('option', { value: 'marker-vertical', text: 'Vertical target' }),
	]);

	const sceneTargetWidth = el('input', {
		type: 'number',
		class: 'ars-scene-target-input',
		min: '10',
		max: '20000',
		step: '0.1',
		inputmode: 'decimal',
		'aria-label': 'Target width in millimeters',
	});

	const sceneTargetHeight = el('input', {
		type: 'number',
		class: 'ars-scene-target-input',
		min: '10',
		max: '20000',
		step: '0.1',
		inputmode: 'decimal',
		'aria-label': 'Target height in millimeters',
	});

	const sceneTargetVisible = el('input', {
		type: 'checkbox',
		checked: true,
		'aria-label': 'Show target preview',
	});

	const sceneTargetFile = el('input', {
		type: 'file',
		accept: 'image/png,image/jpeg',
		class: 'ars-scene-target-file',
		'aria-label': 'Choose target image',
	});

	const sceneTargetChoose = el('button', {
		type: 'button',
		class: 'ars-scene-target-image-btn',
		text: 'Choose Image',
	});

	const sceneTargetRemove = el('button', {
		type: 'button',
		class: 'ars-scene-target-image-btn',
		text: 'Remove',
		hidden: true,
	});

	const sceneTargetImageName = el('div', {
		class: 'ars-scene-target-image-name',
		text: 'No target image selected',
	});

	const sceneTargetImageActions = el('div', {
		class: 'ars-scene-target-image-actions',
	}, [
		sceneTargetChoose,
		sceneTargetRemove,
	]);

	const sceneTargetImage = el('div', {
		class: 'ars-scene-target-image',
	}, [
		el('div', {
			class: 'ars-scene-target-image-label',
			text: 'Target image',
		}),
		sceneTargetFile,
		sceneTargetImageActions,
		sceneTargetImageName,
	]);

	const sceneTargetOrientation = el('div', {
		class: 'ars-scene-target-orientation',
		text: 'Horizontal target · build above',
	});

	const sceneFocusTarget = el('button', {
		type: 'button',
		class: 'ars-scene-view-action',
		text: 'Focus Target',
	});

	const sceneResetView = el('button', {
		type: 'button',
		class: 'ars-scene-view-action',
		text: 'Reset View',
	});

	const sceneViewActions = el('div', {
		class: 'ars-scene-view-actions',
	}, [
		sceneFocusTarget,
		sceneResetView,
	]);

	const sceneTargetSettings = el('div', {
		class: 'ars-scene-target-settings',
		hidden: true,
	}, [
		sceneTargetOrientation,
		sceneTargetImage,
		el('div', { class: 'ars-scene-target-dimensions' }, [
			el('label', {}, [
				el('span', { text: 'Width (mm)' }),
				sceneTargetWidth,
			]),
			el('label', {}, [
				el('span', { text: 'Height (mm)' }),
				sceneTargetHeight,
			]),
		]),
		el('label', { class: 'ars-scene-target-visible' }, [
			sceneTargetVisible,
			el('span', { text: 'Show target preview' }),
		]),
		sceneViewActions,
	]);

	const sceneSetup = el('section', {
		class: 'ars-scene-setup',
		'aria-label': 'Scene setup',
	}, [
		el('label', { class: 'ars-scene-type-field' }, [
			el('span', { text: 'Scene type' }),
			sceneTypeSelect,
		]),
		sceneTargetSettings,
	]);

	const sceneControls = el('div', {
		class: 'ars-scene-controls',
	}, [
		sceneSetup,
		transformInspector,
	]);

	const sceneList = el('div', {
		class: 'ars-scene-list',
		role: 'list',
		'aria-label': 'Models in this scene',
	});
	const sceneClose = el('button', {
		type: 'button',
		class: 'ars-icon-btn',
		'aria-label': 'Close scene tree',
	}, [
		el('span', { 'aria-hidden': 'true', text: '✕' }),
	]);
	const scenePanel = el('aside', {
		class: 'ars-scene-panel',
		hidden: true,
		'aria-label': 'Scene model tree',
	}, [
		el('div', { class: 'ars-scene-head' }, [
			el('div', {}, [
				el('h2', { text: 'Scene' }),
				el('p', { class: 'ars-scene-subtitle', text: 'Models in this composition' }),
			]),
			el('span', { class: 'ars-spacer' }),
			sceneClose,
		]),
		sceneControls,
		sceneList,
	]);

	// ── Dock ─────────────────────────────────────────────────────────────────
	const addBtn = el('button', { type: 'button', class: 'ars-icon-btn', 'aria-expanded': 'false', 'aria-label': 'Add a model to the scene' }, [
		el('span', { 'aria-hidden': 'true', text: '＋' }), 'Add',
	]);
	const forgeInput = el('input', {
		class: 'ars-forge-input', type: 'text', name: 'prompt', autocomplete: 'off',
		placeholder: 'Describe something to generate…', 'aria-label': 'Describe a 3D model to generate',
		maxlength: '300',
	});
	const forgeGo = el('button', { type: 'submit', class: 'ars-forge-go', 'aria-label': 'Generate this model' }, ['Make']);
	const forgeForm = canGenerate ? el('form', { class: 'ars-forge-form' }, [forgeInput, forgeGo]) : el('span', { class: 'ars-spacer' });
	const photoBtn = el('button', { type: 'button', class: 'ars-icon-btn', disabled: true, 'aria-label': 'Take a photo of the scene' }, [el('span', { 'aria-hidden': 'true', text: '⬤' })]);
	const clearBtn = el('button', { type: 'button', class: 'ars-icon-btn', hidden: true, 'aria-label': 'Remove every model from the scene' }, ['Clear']);
	const dock = el('div', { class: 'ars-dock' }, [addBtn, forgeForm, photoBtn, clearBtn]);

	// ── Tray ─────────────────────────────────────────────────────────────────
	const trayTabs = el('div', { class: 'ars-tabs', role: 'tablist', 'aria-label': 'Model sources' });
	const trayBody = el('div', { class: 'ars-tray-body', role: 'tabpanel', tabindex: '-1' });
	const trayClose = el('button', { type: 'button', class: 'ars-icon-btn', 'aria-label': 'Close the model browser' }, [el('span', { 'aria-hidden': 'true', text: '✕' })]);
	const tray = el('div', { class: 'ars-tray', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add a model' }, [
		el('div', { class: 'ars-tray-panel' }, [
			el('div', { class: 'ars-tray-head' }, [el('h2', { text: 'Add a model' }), el('span', { class: 'ars-spacer' }), trayClose]),
			trayTabs,
			trayBody,
		]),
	]);

	// ── QR dialog ────────────────────────────────────────────────────────────
	const qrBox = el('div', { class: 'ars-qr-box' });
	const qrLink = el('a', { class: 'ars-link-out', target: '_blank', rel: 'noopener' });
	const qrClose = el('button', { type: 'button', class: 'ars-btn', text: 'Done' });
	const qrModal = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Open this scene on your phone' }, [
		el('div', { class: 'ars-dialog' }, [
			el('h2', { text: 'Open this scene on your phone' }),
			el('p', { text: 'Scan it and the same models, in the same arrangement, open on the phone: ready to place in your room.' }),
			qrBox, qrLink, qrClose,
		]),
	]);

	// ── Export / publish dialog ──────────────────────────────────────────────
	const exportSpaceLink = el('a', {
		class: 'ars-export-card',
		target: '_blank',
		rel: 'noopener',
	}, [
		el('span', { class: 'ars-export-icon', 'aria-hidden': 'true', text: '⬡' }),
		el('span', { class: 'ars-export-copy' }, [
			el('strong', { text: 'Place in Your Space' }),
			el('small', {
				text: 'Publish a clean experience focused on placing the scene in the viewer’s real environment.',
			}),
		]),
	]);

	const exportMarkerLink = el('a', {
		class: 'ars-export-card',
		target: '_blank',
		rel: 'noopener',
	}, [
		el('span', { class: 'ars-export-icon', 'aria-hidden': 'true', text: '⌗' }),
		el('span', { class: 'ars-export-copy' }, [
			el('strong', { text: 'Marker AR' }),
			el('small', {
				text: 'Publish a camera-first experience that tracks the scene from its image marker.',
			}),
		]),
	]);

	const exportMarkerNote = el('p', {
		class: 'ars-export-note',
		hidden: true,
		text: 'Marker AR requires a marker scene with a compiled target image.',
	});

	const exportClose = el('button', {
		type: 'button',
		class: 'ars-btn',
		text: 'Done',
	});

	const exportModal = el('div', {
		class: 'ars-modal',
		hidden: true,
		role: 'dialog',
		'aria-modal': 'true',
		'aria-label': 'Export AR experience',
	}, [
		el('div', { class: 'ars-dialog ars-export-sheet' }, [
			el('h2', { text: 'Export experience' }),
			el('p', {
				text: 'Publish the same authored scene as a purpose-built AR experience.',
			}),
			el('div', { class: 'ars-export-options' }, [
				exportSpaceLink,
				exportMarkerLink,
			]),
			exportMarkerNote,
			exportClose,
		]),
	]);

	// ── AR hand-off sheet ────────────────────────────────────────────────────
	// The one screen between "I want this in my room" and the device's own AR
	// viewer. It exists because that hand-off is not instant on iOS: the GLB has
	// to become a USDZ first, and Safari will only open Quick Look while the page
	// still holds a user gesture. So the sheet prepares in the background, says
	// so, and then puts a real button under the person's thumb: one tap, straight
	// into ARKit, no dead wait.
	const arThumb = el('span', { class: 'ars-ar-thumb', 'aria-hidden': 'true' });
	const arName = el('span', { class: 'ars-ar-name' });
	const arPicker = el('div', { class: 'ars-ar-picker', hidden: true, role: 'group', 'aria-label': 'Choose which model to place' });
	const arHint = el('p', { class: 'ars-ar-hint' });
	const arStatus = el('p', { class: 'ars-ar-status', role: 'status', 'aria-live': 'polite' });
	const arGo = el('button', { type: 'button', class: 'ars-btn ars-btn-primary ars-ar-go' }, [
		el('span', { class: 'ars-ar-go-icon', 'aria-hidden': 'true', text: '⬡' }),
		el('span', { class: 'ars-ar-go-label', text: 'Place in your space' }),
	]);
	const arScene = el('button', { type: 'button', class: 'ars-btn ars-ar-scene', hidden: true }, [
		el('span', { class: 'ars-ar-scene-icon', 'aria-hidden': 'true', text: '◈' }),
		el('span', { class: 'ars-ar-scene-label', text: 'Place entire scene' }),
	]);
	const arXr = el('button', { type: 'button', class: 'ars-btn ars-ar-xr', hidden: true }, [
		el('span', { 'aria-hidden': 'true', text: '✦' }), 'Immersive AR: place the whole scene',
	]);
	const arQr = el('button', { type: 'button', class: 'ars-btn ars-ar-qr', hidden: true }, [
		el('span', { 'aria-hidden': 'true', text: '📱' }), 'Open on your phone',
	]);
	const arClose = el('button', { type: 'button', class: 'ars-btn ars-ar-done', text: 'Done' });
	const arModal = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Place a model in your space' }, [
		el('div', { class: 'ars-dialog ars-ar-sheet' }, [
			el('h2', { class: 'ars-ar-heading', text: 'Place in your space' }),
			el('div', { class: 'ars-ar-target' }, [arThumb, arName]),
			arPicker,
			arHint,
			arStatus,
			arGo, arScene, arXr, arQr, arClose,
		]),
	]);

	// ── Room dialog ──────────────────────────────────────────────────────────
	const roomCreate = el('button', { type: 'button', class: 'ars-btn ars-btn-primary', text: 'Start a shared room' });
	const roomJoinInput = el('input', { class: 'ars-search', type: 'text', placeholder: 'Room code', 'aria-label': 'Room code', maxlength: '20', autocomplete: 'off', spellcheck: 'false' });
	const roomJoinForm = el('form', { class: 'ars-link-row' }, [roomJoinInput, el('button', { type: 'submit', class: 'ars-btn', text: 'Join' })]);
	const roomIdle = el('div', {}, [
		el('p', { text: 'Open a room and anyone who joins sees the same scene. Every move, resize and rotate syncs live.' }),
		el('div', { class: 'ars-dialog-row' }, [roomCreate]),
		el('div', { class: 'ars-divider' }),
		el('p', { text: 'Got a code from someone?' }),
		roomJoinForm,
	]);
	const roomCode = el('div', { class: 'ars-code' });
	const roomPresence = el('p', {});
	const roomQr = el('div', { class: 'ars-qr-box' });
	const roomCopy = el('button', { type: 'button', class: 'ars-btn ars-btn-primary', text: 'Copy invite link' });
	const roomLeave = el('button', { type: 'button', class: 'ars-btn', text: 'Leave room' });
	const roomLive = el('div', { hidden: true }, [
		roomCode, roomPresence, roomQr,
		el('div', { class: 'ars-dialog-row' }, [roomCopy, roomLeave]),
	]);
	const roomClose = el('button', { type: 'button', class: 'ars-btn', text: 'Close' });
	const roomModal = el('div', { class: 'ars-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Shared room' }, [
		el('div', { class: 'ars-dialog' }, [
			el('h2', { text: 'Build together' }),
			roomIdle, roomLive, roomClose,
		]),
	]);

	const hud = el('div', { class: 'ars-hud' }, [
		runtimeChrome,
		top, empty, status, chip, selbar, scenePanel, dock, tray,
		qrModal, exportModal, arModal, roomModal, savedScenePanel, savedSceneNameModal, savedSceneDecisionModal, savedSceneConfirmModal,
	]);
	const root = el('div', { class: 'ars-root' }, [video, canvas, hud]);
	if (t.accent) root.style.setProperty('--ars-accent', t.accent);
	host.appendChild(root);
	// The studio fills its host absolutely, so the host has to be a positioned box
	// with a real height. A statically-positioned or zero-height container would
	// otherwise render a canvas nobody can see or click, which reads as "the
	// library is broken" rather than "my div has no height".
	const style = host.ownerDocument.defaultView?.getComputedStyle(host);
	if (style && style.position === 'static') host.style.position = 'relative';
	if (host !== host.ownerDocument.body && host.clientHeight < 80 && !host.style.height) {
		host.style.minHeight = host.style.minHeight || '70vh';
	}

	return {
		root, video, canvas, hud, top, title, count, status, chip, savedSceneTrigger, savedSceneMenu, savedSceneName, savedSceneState,
		savedSceneNew, savedSceneOpen, savedSceneSave, savedSceneSaveAs, savedSceneRename, savedSceneDuplicate, savedSceneDelete,
		savedScenePanel, savedScenePanelStatus, savedScenePanelList, savedScenePanelClose,
		savedSceneNameModal, savedSceneNameInput, savedSceneNameError, savedSceneNameCancel, savedSceneNameSubmit,
		savedSceneDecisionModal, savedSceneDecisionMessage, savedSceneDecisionSave, savedSceneDecisionDiscard, savedSceneDecisionCancel,
		savedSceneConfirmModal, savedSceneConfirmMessage, savedSceneConfirmCancel, savedSceneConfirmSubmit,
		runtimeChrome, runtimeBrand, runtimePrimary, runtimeMobileBtn, runtimePhotoBtn,
		cameraBtn, xrBtn, qrBtn, roomBtn, sceneBtn, exportBtn, addBtn, photoBtn, clearBtn,
		forgeForm: canGenerate ? forgeForm : null, forgeInput: canGenerate ? forgeInput : null, forgeGo: canGenerate ? forgeGo : null,
		empty, emptyCamera, emptyAdd, emptyForge,
		selbar, selName,
		scenePanel, sceneList, sceneClose, sceneControls,
		sceneSetup, sceneTypeSelect, sceneTargetSettings,
		sceneTargetWidth, sceneTargetHeight, sceneTargetVisible,
		sceneTargetFile, sceneTargetChoose, sceneTargetRemove,
		sceneTargetImageName, sceneTargetOrientation,
		sceneFocusTarget, sceneResetView,
		transformInspector, transformTitle, transformModes, transformFields,
		transformSnapToggle, transformSnapSettings, transformSnapFields,
		transformGround, transformReset,
		transformGroupActions, groupVisibility, groupUngroup,
		tray, trayTabs, trayBody, trayClose,
		qrModal, qrBox, qrLink, qrClose,
		exportModal, exportSpaceLink, exportMarkerLink, exportMarkerNote, exportClose,
		arModal, arThumb, arName, arPicker, arHint, arStatus, arGo, arScene, arXr, arQr, arClose,
		roomModal, roomIdle, roomLive, roomCreate, roomJoinForm, roomJoinInput,
		roomCode, roomPresence, roomQr, roomCopy, roomLeave, roomClose,
	};
}

/** Escape a string for interpolation into innerHTML. */
export function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}
