// The studio's stylesheet, as a string.
//
// Everything is scoped under `.ars-root`, so dropping the studio into an
// existing page cannot leak a single rule into it, and the host can restyle any
// part by targeting the same classes with equal specificity. Colours come from
// custom properties on the root, so a one-line `accent` config recolours the
// whole surface.

export function studioStyles() {
	return `
.ars-root {
	--ars-accent: #8b7cf8;
	--ars-accent-ink: #dcd6ff;
	--ars-ink: #ecedf2;
	--ars-ink-dim: #9aa0af;
	--ars-ink-faint: #6b7080;
	--ars-line: rgba(255, 255, 255, 0.1);
	--ars-panel: rgba(12, 13, 17, 0.78);
	--ars-warn: #fca5a5;
	--ars-radius: 14px;
	--ars-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	position: absolute;
	inset: 0;
	display: block;
	overflow: hidden;
	background: radial-gradient(120% 120% at 50% 0%, #101321 0%, #07080c 55%, #000 100%);
	color: var(--ars-ink);
	font-family: var(--ars-font);
	touch-action: none;
	-webkit-user-select: none;
	user-select: none;
	color-scheme: dark;
}
.ars-root *, .ars-root *::before, .ars-root *::after { box-sizing: border-box; }
/* A display rule must never beat the hidden attribute: an invisible panel that
   still swallows taps is a dead page. */
.ars-root [hidden] { display: none !important; }
.ars-root.is-fullscreen {
	position: fixed;
	z-index: 2147483000;
	height: 100dvh;
}

/* Layers: camera video → WebGL canvas → HUD */
.ars-video {
	position: absolute; inset: 0; width: 100%; height: 100%;
	object-fit: cover; display: none; background: #000;
}
.ars-root.is-ar .ars-video { display: block; }
.ars-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ars-hud {
	position: absolute; inset: 0; z-index: 10;
	display: flex; flex-direction: column; justify-content: space-between;
	pointer-events: none;
}
.ars-hud > * { pointer-events: none; }
.ars-hud a, .ars-hud button, .ars-hud input, .ars-hud form,
.ars-hud .ars-top, .ars-hud .ars-dock, .ars-hud .ars-selbar,
.ars-hud .ars-scene-panel, .ars-hud .ars-tray, .ars-hud .ars-modal { pointer-events: auto; }

/* ── Published experience chrome ── */
.ars-runtime-chrome {
	position: absolute;
	inset: 0;
	z-index: 13;
	pointer-events: none;
}

.ars-runtime-brand {
	position: absolute;
	top: calc(env(safe-area-inset-top, 0px) + 18px);
	left: 18px;
	z-index: 2;
	pointer-events: none;
}

.ars-runtime-logo {
	display: block;
	width: min(132px, 30vw);
	height: auto;
	max-height: 54px;
	object-fit: contain;
	object-position: left center;
	opacity: 0.82;
	filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.28));
}

.ars-runtime-controls {
	position: absolute;
	left: 0;
	right: 0;
	bottom: calc(env(safe-area-inset-bottom, 0px) + 18px);
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 0 18px;
	pointer-events: none;
}

.ars-runtime-primary,
.ars-runtime-mobile,
.ars-runtime-photo {
	appearance: none;
	cursor: pointer;
	font: inherit;
	font-weight: 700;
	color: #fff;
	background: rgba(10, 12, 18, 0.76);
	border: 1px solid rgba(255, 255, 255, 0.22);
	box-shadow: 0 8px 30px rgba(0, 0, 0, 0.28);
	backdrop-filter: blur(14px);
	pointer-events: auto;
}

.ars-runtime-primary {
	min-height: 48px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 9px;
	border-radius: 999px;
	padding: 12px 20px;
	font-size: 14px;
}

.ars-runtime-mobile {
	min-height: 48px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	border-radius: 999px;
	padding: 12px 17px;
	font-size: 13px;
}

.ars-runtime-photo {
	width: 48px;
	height: 48px;
	display: grid;
	place-items: center;
	border-radius: 50%;
	font-size: 14px;
}

.ars-runtime-primary:hover,
.ars-runtime-mobile:hover,
.ars-runtime-photo:hover {
	background: rgba(22, 25, 34, 0.88);
	border-color: rgba(255, 255, 255, 0.36);
}

.ars-runtime-primary:active,
.ars-runtime-mobile:active,
.ars-runtime-photo:active {
	transform: translateY(1px);
}

.ars-runtime-primary[disabled],
.ars-runtime-mobile[disabled],
.ars-runtime-photo[disabled] {
	opacity: 0.42;
	cursor: not-allowed;
}

.ars-runtime-primary-icon {
	color: var(--ars-accent-ink);
}

.ars-root.is-experience .ars-top,
.ars-root.is-experience .ars-empty,
.ars-root.is-experience .ars-chip,
.ars-root.is-experience .ars-selbar,
.ars-root.is-experience .ars-scene-panel,
.ars-root.is-experience .ars-dock,
.ars-root.is-experience .ars-tray {
	display: none !important;
}

.ars-root.is-experience .ars-status {
	bottom: calc(env(safe-area-inset-bottom, 0px) + 82px);
	max-width: min(88vw, 520px);
}

@media (max-width: 520px) {
	.ars-runtime-brand {
		top: calc(env(safe-area-inset-top, 0px) + 14px);
		left: 14px;
	}

	.ars-runtime-logo {
		width: min(108px, 32vw);
	}

	.ars-runtime-controls {
		bottom: calc(env(safe-area-inset-bottom, 0px) + 14px);
		gap: 10px;
		padding: 0 14px;
	}

	.ars-runtime-primary {
		min-height: 46px;
		padding: 11px 17px;
		font-size: 13.5px;
	}

	.ars-runtime-mobile {
		min-height: 46px;
		padding: 11px 15px;
		font-size: 13px;
	}

	.ars-runtime-photo {
		width: 46px;
		height: 46px;
	}
}

/* ── Top bar ── */
.ars-top {
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	padding: calc(env(safe-area-inset-top, 0px) + 10px) 14px 10px;
}
.ars-back, .ars-title {
	display: inline-flex; align-items: center; gap: 7px;
	color: var(--ars-ink); text-decoration: none; font-size: 13.5px; font-weight: 650;
	background: var(--ars-panel); border: 1px solid var(--ars-line);
	border-radius: 999px; padding: 8px 14px; backdrop-filter: blur(10px);
	transition: background 0.15s, border-color 0.15s;
}
.ars-back:hover { background: rgba(30, 32, 40, 0.85); border-color: rgba(255, 255, 255, 0.22); }
.ars-root :focus-visible { outline: 2px solid var(--ars-accent); outline-offset: 2px; }
.ars-count {
	font-size: 12.5px; font-weight: 650; color: var(--ars-accent-ink);
	background: color-mix(in srgb, var(--ars-accent) 16%, transparent);
	border: 1px solid color-mix(in srgb, var(--ars-accent) 40%, transparent);
	border-radius: 999px; padding: 7px 12px; backdrop-filter: blur(10px);
}
.ars-spacer { flex: 1 1 auto; }
.ars-icon-btn {
	appearance: none; cursor: pointer; font: inherit; color: var(--ars-ink);
	display: inline-flex; align-items: center; justify-content: center; gap: 7px;
	background: var(--ars-panel); border: 1px solid var(--ars-line);
	border-radius: 999px; padding: 8px 13px; font-size: 13px; font-weight: 650;
	backdrop-filter: blur(10px);
	transition: background 0.15s, border-color 0.15s, transform 0.06s;
}
.ars-icon-btn:hover { background: rgba(30, 32, 40, 0.85); border-color: rgba(255, 255, 255, 0.22); }
.ars-icon-btn:active { transform: translateY(1px); }
.ars-icon-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.ars-icon-btn.is-active {
	background: color-mix(in srgb, var(--ars-accent) 20%, transparent);
	border-color: color-mix(in srgb, var(--ars-accent) 55%, transparent);
	color: var(--ars-accent-ink);
}

/* ── Generation progress chip ── */
.ars-chip {
	position: absolute; top: calc(env(safe-area-inset-top, 0px) + 58px); left: 50%;
	transform: translateX(-50%); z-index: 11;
	display: inline-flex; align-items: center; gap: 9px; max-width: min(88vw, 480px);
	background: var(--ars-panel); border: 1px solid var(--ars-line); border-radius: 999px;
	padding: 9px 15px; font-size: 13px; backdrop-filter: blur(10px);
	animation: ars-rise 0.25s ease;
}
.ars-chip[data-state="error"] { border-color: rgba(252, 165, 165, 0.5); color: var(--ars-warn); }
.ars-chip[data-state="error"] .ars-spinner { display: none; }
.ars-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ars-chip-elapsed { color: var(--ars-ink-faint); font-variant-numeric: tabular-nums; font-size: 12px; }
.ars-spinner {
	width: 14px; height: 14px; flex: 0 0 auto; border-radius: 50%;
	border: 2px solid rgba(255, 255, 255, 0.18); border-top-color: var(--ars-accent);
	animation: ars-spin 0.9s linear infinite;
}
@keyframes ars-spin { to { transform: rotate(360deg); } }
@keyframes ars-rise { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* ── Empty state ── */
.ars-empty {
	position: absolute; inset: 0; z-index: 9; display: grid; place-items: center;
	padding: 24px; pointer-events: none;
}
.ars-empty-card {
	pointer-events: auto; text-align: center; max-width: 340px;
	background: var(--ars-panel); border: 1px solid var(--ars-line);
	border-radius: 20px; padding: 26px 22px; backdrop-filter: blur(12px);
	display: flex; flex-direction: column; gap: 10px; align-items: center;
}
.ars-empty-art { font-size: 40px; line-height: 1; }
.ars-empty-card h2 { margin: 0; font-size: 18px; letter-spacing: -0.01em; font-weight: 700; }
.ars-empty-card p { margin: 0 0 6px; color: var(--ars-ink-dim); font-size: 13.5px; line-height: 1.55; }
.ars-empty-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.ars-root.is-ar .ars-empty-card { background: rgba(12, 13, 17, 0.6); }

/* ── Buttons ── */
.ars-btn {
	appearance: none; cursor: pointer; font: inherit; font-size: 13.5px; font-weight: 650;
	color: var(--ars-ink); background: rgba(255, 255, 255, 0.07);
	border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 11px; padding: 10px 15px;
	display: inline-flex; align-items: center; gap: 7px;
	transition: background 0.15s, border-color 0.15s, transform 0.06s;
}
.ars-btn:hover { background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.28); }
.ars-btn:active { transform: translateY(1px); }
.ars-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.ars-btn-primary { background: var(--ars-accent); border-color: var(--ars-accent); color: #0d0b1e; }
.ars-btn-primary:hover { filter: brightness(1.08); }

/* ── Status line ── */
.ars-status {
	position: absolute; left: 50%; transform: translateX(-50%);
	bottom: calc(env(safe-area-inset-bottom, 0px) + 186px); z-index: 12;
	display: inline-flex; align-items: center; gap: 10px; max-width: 92%;
	background: var(--ars-panel); border: 1px solid var(--ars-line); border-radius: 999px;
	padding: 8px 14px; font-size: 12.5px; color: var(--ars-ink-dim);
	backdrop-filter: blur(10px); animation: ars-rise 0.2s ease; text-align: center;
}
.ars-status.is-warn { color: var(--ars-warn); border-color: rgba(252, 165, 165, 0.42); }
.ars-status-action {
	appearance: none; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 700;
	color: var(--ars-accent-ink); background: none; border: 0; padding: 0; text-decoration: underline;
}

/* ── Selection toolbar ── */
.ars-selbar {
	position: absolute; left: 50%; transform: translateX(-50%);
	bottom: calc(env(safe-area-inset-bottom, 0px) + 132px); z-index: 11;
	display: flex; align-items: center; gap: 6px; max-width: 94%;
	background: var(--ars-panel); border: 1px solid var(--ars-line); border-radius: 999px;
	padding: 6px 8px 6px 14px; backdrop-filter: blur(12px);
	animation: ars-pop 0.18s ease;
}
@keyframes ars-pop { from { opacity: 0; transform: translate(-50%, 5px); } to { opacity: 1; transform: translate(-50%, 0); } }
.ars-sel-name {
	font-size: 12.5px; font-weight: 650; color: var(--ars-accent-ink);
	max-width: 26vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ars-selbar .ars-icon-btn {
	border-radius: 999px;
	padding: 7px 11px;
	font-size: 12.5px;
	background: rgba(255, 255, 255, 0.06);
}
.ars-selbar .ars-sel-visibility {
	min-width: 48px;
}
.ars-selbar .ars-sel-group {
	min-width: 58px;
	color: var(--ars-accent-ink);
}
/* The AR control lives in the top bar and already acts on the selected model, so
   the selection toolbar stays icon-sized edit actions. Duplicating it here
   collapsed to an unlabelled dot on a narrow phone. */
.ars-top .ars-icon-btn[aria-busy="true"] { opacity: 0.7; cursor: progress; }

/* ── Scene tree ── */
.ars-scene-panel {
	position: absolute;
	top: calc(env(safe-area-inset-top, 0px) + 66px);
	right: 14px;
	bottom: calc(env(safe-area-inset-bottom, 0px) + 86px);
	z-index: 14;
	width: min(340px, calc(100vw - 28px));
	background: rgba(11, 12, 16, 0.96);
	border: 1px solid var(--ars-line);
	border-radius: 18px;
	box-shadow: 0 18px 60px rgba(0, 0, 0, 0.34);
	backdrop-filter: blur(16px);
	overflow: hidden;
	display: flex;
	flex-direction: column;
	animation: ars-scene-in 0.18s ease;
}
@keyframes ars-scene-in {
	from { opacity: 0; transform: translateX(8px); }
	to { opacity: 1; transform: none; }
}
.ars-scene-head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 14px;
	border-bottom: 1px solid var(--ars-line);
}
.ars-scene-head h2 {
	margin: 0;
	font-size: 15px;
	font-weight: 750;
}
.ars-scene-subtitle {
	margin: 2px 0 0;
	font-size: 11.5px;
	color: var(--ars-ink-faint);
}
.ars-scene-controls {
	flex: 0 1 auto;
	max-height: 54%;
	overflow-y: auto;
	overflow-x: hidden;
	-webkit-overflow-scrolling: touch;
	overscroll-behavior: contain;
	border-bottom: 1px solid var(--ars-line);
}

.ars-scene-controls::-webkit-scrollbar {
	width: 7px;
}

.ars-scene-controls::-webkit-scrollbar-thumb {
	background: rgba(255, 255, 255, 0.15);
	border-radius: 999px;
}

.ars-scene-setup {
	padding: 12px 14px;
	border-bottom: 1px solid var(--ars-line);
	background: rgba(255, 255, 255, 0.018);
}

.ars-scene-type-field {
	display: grid;
	gap: 6px;
	font-size: 10px;
	font-weight: 750;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: var(--ars-ink-faint);
}

.ars-scene-type-select,
.ars-scene-target-input {
	width: 100%;
	box-sizing: border-box;
	border: 1px solid var(--ars-line);
	border-radius: 9px;
	background: rgba(0, 0, 0, 0.24);
	color: var(--ars-ink);
	font: inherit;
	font-size: 12px;
	font-weight: 650;
	padding: 8px 9px;
	outline: none;
}

.ars-scene-type-select:focus,
.ars-scene-target-input:focus {
	border-color: var(--ars-accent);
}

.ars-scene-target-settings {
	margin-top: 10px;
	padding-top: 10px;
	border-top: 1px solid var(--ars-line);
}

.ars-scene-target-image {
	margin: 9px 0 11px;
	padding: 9px;
	border: 1px solid var(--ars-line);
	border-radius: 9px;
	background: rgba(0, 0, 0, 0.14);
}

.ars-scene-target-file {
	display: none;
}

.ars-scene-target-image-label {
	margin-bottom: 7px;
	font-size: 9.5px;
	font-weight: 750;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: var(--ars-ink-faint);
}

.ars-scene-target-image-actions {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 7px;
}

.ars-scene-target-image-btn {
	appearance: none;
	border: 1px solid var(--ars-line);
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.055);
	color: var(--ars-ink-dim);
	font: inherit;
	font-size: 10.5px;
	font-weight: 700;
	padding: 7px 9px;
	cursor: pointer;
}

.ars-scene-target-image-btn:hover {
	background: rgba(255, 255, 255, 0.11);
	color: var(--ars-ink);
}

.ars-scene-target-image-name {
	margin-top: 7px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 10px;
	color: var(--ars-ink-faint);
}

.ars-scene-target-orientation {
	margin-bottom: 9px;
	font-size: 11px;
	font-weight: 700;
	color: var(--ars-accent-ink);
}

.ars-scene-target-dimensions {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 7px;
}

.ars-scene-target-dimensions label {
	display: grid;
	gap: 4px;
	font-size: 9.5px;
	font-weight: 650;
	color: var(--ars-ink-faint);
}

.ars-scene-target-visible {
	display: flex;
	align-items: center;
	gap: 7px;
	margin-top: 10px;
	font-size: 11px;
	font-weight: 650;
	color: var(--ars-ink-dim);
	cursor: pointer;
}

.ars-scene-target-visible input {
	accent-color: var(--ars-accent);
}

.ars-scene-view-actions {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 7px;
	margin-top: 10px;
}

.ars-scene-view-action {
	appearance: none;
	border: 1px solid var(--ars-line);
	border-radius: 9px;
	background: rgba(255, 255, 255, 0.055);
	color: var(--ars-ink-dim);
	font: inherit;
	font-size: 11px;
	font-weight: 700;
	padding: 8px 9px;
	cursor: pointer;
}

.ars-scene-view-action:hover {
	background: rgba(255, 255, 255, 0.11);
	border-color: rgba(255, 255, 255, 0.24);
	color: var(--ars-ink);
}

.ars-transform-inspector {
	padding: 12px 14px;
	background: rgba(255, 255, 255, 0.025);
}
.ars-transform-inspector:has(.ars-transform-title:not(:empty)) {
	position: relative;
}

.ars-transform-title {
	font-size: 11px;
	font-weight: 750;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--ars-ink-faint);
	margin-bottom: 9px;
}
.ars-transform-modes {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 5px;
	margin-bottom: 10px;
}
.ars-transform-mode,
.ars-transform-reset {
	appearance: none;
	border: 1px solid var(--ars-line);
	border-radius: 9px;
	background: rgba(255, 255, 255, 0.045);
	color: var(--ars-ink-dim);
	font: inherit;
	font-size: 11px;
	font-weight: 700;
	padding: 7px 8px;
	cursor: pointer;
}
.ars-transform-mode.is-active {
	border-color: color-mix(in srgb, var(--ars-accent) 65%, transparent);
	background: color-mix(in srgb, var(--ars-accent) 18%, transparent);
	color: var(--ars-ink);
}
.ars-transform-snap-settings {
	margin-bottom: 10px;
	padding: 9px;
	border: 1px solid var(--ars-line);
	border-radius: 10px;
	background: rgba(255, 255, 255, 0.025);
}
.ars-transform-snap-switch {
	display: flex;
	align-items: center;
	gap: 7px;
	font-size: 11px;
	font-weight: 700;
	color: var(--ars-ink-dim);
	cursor: pointer;
}
.ars-transform-snap-checkbox {
	position: absolute;
	opacity: 0;
	pointer-events: none;
}
.ars-transform-snap-indicator {
	position: relative;
	width: 28px;
	height: 16px;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.10);
	border: 1px solid var(--ars-line);
	transition: background 0.15s, border-color 0.15s;
}
.ars-transform-snap-indicator::after {
	content: "";
	position: absolute;
	top: 2px;
	left: 2px;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: var(--ars-ink-dim);
	transition: transform 0.15s, background 0.15s;
}
.ars-transform-snap-checkbox:checked + .ars-transform-snap-indicator {
	background: color-mix(in srgb, var(--ars-accent) 25%, transparent);
	border-color: color-mix(in srgb, var(--ars-accent) 60%, transparent);
}
.ars-transform-snap-checkbox:checked + .ars-transform-snap-indicator::after {
	transform: translateX(12px);
	background: var(--ars-accent);
}
.ars-transform-snap-fields {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 6px;
	margin-top: 8px;
}
.ars-transform-snap-field {
	display: grid;
	gap: 4px;
	font-size: 9.5px;
	font-weight: 650;
	color: var(--ars-ink-faint);
}
.ars-transform-snap-field input {
	width: 100%;
	box-sizing: border-box;
	border: 1px solid var(--ars-line);
	border-radius: 7px;
	background: rgba(0, 0, 0, 0.22);
	color: var(--ars-ink);
	font: inherit;
	font-size: 11px;
	padding: 6px;
	outline: none;
}
.ars-transform-snap-field input:focus {
	border-color: var(--ars-accent);
}
.ars-transform-snap-settings.is-disabled .ars-transform-snap-fields {
	opacity: 0.42;
}

.ars-transform-fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 7px;
}
.ars-transform-field {
	display: grid;
	gap: 4px;
	font-size: 10px;
	font-weight: 650;
	color: var(--ars-ink-faint);
}
.ars-transform-field input {
	width: 100%;
	box-sizing: border-box;
	border: 1px solid var(--ars-line);
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.22);
	color: var(--ars-ink);
	font: inherit;
	font-size: 12px;
	padding: 7px 8px;
	outline: none;
}
.ars-transform-field input:focus {
	border-color: var(--ars-accent);
}
.ars-transform-reset {
	width: 100%;
	margin-top: 8px;
}
.ars-transform-reset:disabled {
	opacity: 0.45;
	cursor: default;
}

.ars-transform-group-actions {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 7px;
	margin-top: 10px;
	padding-top: 10px;
	border-top: 1px solid var(--ars-line);
}

.ars-transform-group-action {
	appearance: none;
	border: 1px solid var(--ars-line);
	border-radius: 9px;
	background: rgba(255, 255, 255, 0.045);
	color: var(--ars-ink-dim);
	font: inherit;
	font-size: 11px;
	font-weight: 700;
	padding: 8px;
	cursor: pointer;
}

.ars-transform-group-action:hover {
	background: rgba(255, 255, 255, 0.10);
	border-color: rgba(255, 255, 255, 0.24);
	color: var(--ars-ink);
}

.ars-transform-group-action[data-group-action="visibility"] {
	color: var(--ars-accent-ink);
}

.ars-scene-list {
	flex: 1 1 46%;
	min-height: 130px;
	overflow-y: auto;
	padding: 10px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	-webkit-overflow-scrolling: touch;
}
.ars-scene-row {
	border: 1px solid var(--ars-line);
	border-radius: 13px;
	background: rgba(255, 255, 255, 0.04);
	overflow: hidden;
	transition: border-color 0.15s, background 0.15s;
}
.ars-scene-row.is-selected {
	border-color: color-mix(in srgb, var(--ars-accent) 60%, transparent);
	background: color-mix(in srgb, var(--ars-accent) 13%, transparent);
	box-shadow: inset 3px 0 0 color-mix(in srgb, var(--ars-accent) 80%, transparent);
}
.ars-scene-row.is-hidden {
	opacity: 0.56;
}
.ars-scene-row.is-hidden .ars-scene-select {
	text-decoration: line-through;
	text-decoration-thickness: 1px;
}
.ars-scene-select {
	appearance: none;
	width: 100%;
	border: 0;
	background: transparent;
	color: var(--ars-ink);
	font: inherit;
	font-size: 13px;
	font-weight: 700;
	text-align: left;
	padding: 11px 12px 9px;
	cursor: pointer;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.ars-scene-select[aria-pressed="true"] {
	color: var(--ars-accent-ink);
}

.ars-scene-row.is-group-member {
	border-left-color: color-mix(in srgb, var(--ars-accent) 42%, var(--ars-line));
}

.ars-scene-select {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ars-scene-model-name {
	min-width: 0;
	flex: 1 1 auto;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ars-scene-group-badge {
	flex: 0 0 auto;
	font-size: 9px;
	font-weight: 800;
	line-height: 1;
	letter-spacing: 0.03em;
	text-transform: uppercase;
	color: var(--ars-accent-ink);
	background: color-mix(in srgb, var(--ars-accent) 16%, transparent);
	border: 1px solid color-mix(in srgb, var(--ars-accent) 38%, transparent);
	border-radius: 999px;
	padding: 4px 6px;
}
.ars-scene-actions {
	display: flex;
	gap: 4px;
	padding: 0 8px 8px;
	flex-wrap: wrap;
}
.ars-scene-action {
	appearance: none;
	border: 0;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.06);
	color: var(--ars-ink-dim);
	font: inherit;
	font-size: 10.5px;
	font-weight: 650;
	padding: 6px 8px;
	cursor: pointer;
}
.ars-scene-action:hover {
	background: rgba(255, 255, 255, 0.11);
	color: var(--ars-ink);
}
.ars-scene-action.is-active {
	color: var(--ars-accent-ink);
	background: color-mix(in srgb, var(--ars-accent) 18%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ars-accent) 38%, transparent);
}
.ars-scene-action.is-active:hover {
	background: color-mix(in srgb, var(--ars-accent) 26%, transparent);
}
.ars-scene-action[disabled] {
	opacity: 0.35;
	cursor: not-allowed;
}
.ars-scene-danger:hover {
	color: var(--ars-warn);
}
.ars-scene-empty {
	margin: auto;
	padding: 24px 12px;
	font-size: 12.5px;
	color: var(--ars-ink-faint);
	text-align: center;
}

@media (max-width: 640px) {
	.ars-scene-controls {
		max-height: 48%;
	}

	.ars-scene-list {
		min-height: 150px;
	}

	.ars-scene-panel {
		left: 10px;
		right: 10px;
		width: auto;
		top: calc(env(safe-area-inset-top, 0px) + 64px);
		bottom: calc(env(safe-area-inset-bottom, 0px) + 82px);
	}
}

/* ── Bottom dock ── */
.ars-dock {
	display: flex; align-items: center; gap: 9px; flex-wrap: nowrap;
	padding: 12px 14px calc(env(safe-area-inset-bottom, 0px) + 14px);
	background: linear-gradient(to top, rgba(4, 5, 8, 0.72), rgba(4, 5, 8, 0));
}
.ars-forge-form { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; min-width: 0; }
.ars-forge-input {
	flex: 1 1 auto; min-width: 0; font: inherit; font-size: 14px; color: var(--ars-ink);
	background: var(--ars-panel); border: 1px solid var(--ars-line);
	border-radius: 999px; padding: 11px 16px; backdrop-filter: blur(10px);
	transition: border-color 0.15s;
}
.ars-forge-input::placeholder { color: var(--ars-ink-faint); }
.ars-forge-input:focus { border-color: color-mix(in srgb, var(--ars-accent) 55%, transparent); }
.ars-forge-go {
	appearance: none; cursor: pointer; font: inherit; font-size: 14px; font-weight: 700;
	color: #0d0b1e; background: var(--ars-accent); border: 0; border-radius: 999px;
	padding: 11px 17px; flex: 0 0 auto;
}
.ars-forge-go[disabled] { opacity: 0.55; cursor: not-allowed; }

/* ── Saved Scenes ── */
.ars-saved-scene-bar {
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	padding: 7px 12px; background: rgba(11, 12, 16, 0.78);
	border-bottom: 1px solid var(--ars-line); color: var(--ars-ink);
}
.ars-saved-scene-current { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-right: auto; }
.ars-saved-scene-name { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ars-saved-scene-state { color: var(--ars-ink-faint); font-size: 11px; white-space: nowrap; }
.ars-saved-scene-state[data-dirty="true"] { color: var(--ars-warn); }
.ars-saved-scene-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ars-saved-scene-btn { padding: 7px 10px; font-size: 12px; }
.ars-saved-scene-btn.ars-btn-danger { color: #fecaca; }
.ars-saved-scene-dialog { width: min(560px, 100%); text-align: left; align-items: stretch; }
.ars-saved-scene-panel-status { min-height: 20px; }
.ars-saved-scene-list { display: flex; flex-direction: column; gap: 8px; width: 100%; max-height: 52vh; overflow-y: auto; padding: 2px; }
.ars-saved-scene-row { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--ars-line); border-radius: 12px; background: rgba(255,255,255,.04); }
.ars-saved-scene-row-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; flex: 1; }
.ars-saved-scene-row-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ars-saved-scene-row-copy small { color: var(--ars-ink-faint); font-size: 11px; }
.ars-saved-scene-error { color: var(--ars-warn) !important; }

/* ── Tray + modals ── */
.ars-tray, .ars-modal {
	position: absolute; inset: 0; z-index: 20; display: flex;
	background: rgba(4, 5, 8, 0.62); backdrop-filter: blur(4px);
	animation: ars-fade 0.16s ease;
}
@keyframes ars-fade { from { opacity: 0; } to { opacity: 1; } }
.ars-tray { align-items: flex-end; }
.ars-modal { align-items: center; justify-content: center; padding: 22px; }
.ars-tray-panel {
	width: 100%; max-height: 78%; display: flex; flex-direction: column;
	background: rgba(11, 12, 16, 0.97); border-top: 1px solid var(--ars-line);
	border-radius: 20px 20px 0 0; animation: ars-slide 0.22s ease;
}
@keyframes ars-slide { from { transform: translateY(14px); opacity: 0; } to { transform: none; opacity: 1; } }
.ars-tray-head {
	display: flex; align-items: center; gap: 10px;
	padding: 14px 16px 10px; border-bottom: 1px solid var(--ars-line);
}
.ars-tray-head h2 { margin: 0; font-size: 15px; font-weight: 700; }
.ars-tabs {
	display: flex; gap: 6px; padding: 10px 16px 0; overflow-x: auto;
	scrollbar-width: none; position: relative;
}
.ars-tabs::-webkit-scrollbar { display: none; }
.ars-tab {
	appearance: none; cursor: pointer; font: inherit; font-size: 13px; font-weight: 650;
	white-space: nowrap; color: var(--ars-ink-dim); background: rgba(255, 255, 255, 0.05);
	border: 1px solid transparent; border-radius: 999px; padding: 8px 14px;
	transition: background 0.15s, color 0.15s;
}
.ars-tab:hover { color: var(--ars-ink); background: rgba(255, 255, 255, 0.1); }
.ars-tab.is-active {
	color: var(--ars-accent-ink);
	background: color-mix(in srgb, var(--ars-accent) 18%, transparent);
	border-color: color-mix(in srgb, var(--ars-accent) 45%, transparent);
}
.ars-tray-body { flex: 1 1 auto; overflow-y: auto; padding: 14px 16px calc(env(safe-area-inset-bottom, 0px) + 18px); -webkit-overflow-scrolling: touch; }
.ars-tray-loading, .ars-tray-empty {
	display: flex; flex-direction: column; align-items: center; gap: 12px;
	padding: 34px 16px; color: var(--ars-ink-dim); font-size: 13.5px; text-align: center;
}
.ars-tray-loading { flex-direction: row; justify-content: center; }
.ars-item-list {
	list-style: none; margin: 0; padding: 0;
	display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
}
.ars-item-add {
	appearance: none; cursor: pointer; font: inherit; width: 100%; text-align: left;
	display: flex; flex-direction: column; gap: 7px; color: var(--ars-ink);
	background: rgba(255, 255, 255, 0.05); border: 1px solid var(--ars-line);
	border-radius: var(--ars-radius); padding: 9px;
	transition: background 0.15s, border-color 0.15s, transform 0.08s;
}
.ars-item-add:hover { background: rgba(255, 255, 255, 0.1); border-color: color-mix(in srgb, var(--ars-accent) 45%, transparent); transform: translateY(-1px); }
.ars-item-add:active { transform: translateY(0); }
.ars-item-thumb {
	display: grid; place-items: center; aspect-ratio: 1 / 1; overflow: hidden;
	border-radius: 10px; background: rgba(255, 255, 255, 0.04);
}
.ars-item-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ars-item-cube { font-size: 22px; color: var(--ars-ink-faint); }
.ars-item-title {
	font-size: 12.5px; font-weight: 600; line-height: 1.3;
	display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ars-item-cta { font-size: 11.5px; font-weight: 700; color: var(--ars-accent-ink); }
.ars-search {
	width: 100%; font: inherit; font-size: 14px; color: var(--ars-ink);
	background: rgba(255, 255, 255, 0.05); border: 1px solid var(--ars-line);
	border-radius: 11px; padding: 10px 14px; margin-bottom: 8px;
}
.ars-hint { margin: 0 0 12px; color: var(--ars-ink-faint); font-size: 12px; line-height: 1.5; }
.ars-hint a, .ars-tray-empty a { color: var(--ars-accent-ink); }
.ars-link-row { display: flex; gap: 8px; align-items: center; }
.ars-link-row input { flex: 1 1 auto; min-width: 0; }
.ars-more { display: grid; place-items: center; padding: 14px 0 4px; }

.ars-dialog {
	width: min(420px, 100%); max-height: 88%; overflow-y: auto;
	background: rgba(11, 12, 16, 0.98); border: 1px solid var(--ars-line);
	border-radius: 20px; padding: 20px; text-align: center;
	display: flex; flex-direction: column; gap: 12px; align-items: center;
	animation: ars-slide 0.2s ease;
}
.ars-dialog h2 { margin: 0; font-size: 16px; font-weight: 700; }
.ars-dialog p { margin: 0; color: var(--ars-ink-dim); font-size: 13px; line-height: 1.55; }
.ars-qr-box { background: #fff; border-radius: 14px; padding: 12px; line-height: 0; }
.ars-qr-box svg { width: min(240px, 60vw); height: auto; }
.ars-code {
	font-size: 26px; font-weight: 800; letter-spacing: 0.16em;
	color: var(--ars-accent-ink); font-variant-numeric: tabular-nums;
}
.ars-link-out { font-size: 12px; color: var(--ars-ink-faint); word-break: break-all; }

/* ── Export / publish sheet ── */
.ars-export-sheet {
	width: min(520px, 100%);
	gap: 14px;
}
.ars-export-options {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 10px;
	width: 100%;
}
.ars-export-card {
	min-width: 0;
	display: flex;
	align-items: flex-start;
	gap: 11px;
	padding: 14px;
	text-align: left;
	text-decoration: none;
	color: var(--ars-ink);
	background: rgba(255, 255, 255, 0.055);
	border: 1px solid var(--ars-line);
	border-radius: 14px;
	transition: background 0.15s, border-color 0.15s, transform 0.08s;
}
.ars-export-card:hover {
	background: rgba(255, 255, 255, 0.1);
	border-color: color-mix(in srgb, var(--ars-accent) 48%, transparent);
	transform: translateY(-1px);
}
.ars-export-card:active { transform: none; }
.ars-export-icon {
	flex: 0 0 auto;
	width: 34px;
	height: 34px;
	display: grid;
	place-items: center;
	border-radius: 10px;
	background: color-mix(in srgb, var(--ars-accent) 17%, transparent);
	color: var(--ars-accent-ink);
	font-size: 17px;
}
.ars-export-copy {
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 5px;
}
.ars-export-copy strong {
	font-size: 13.5px;
	line-height: 1.25;
}
.ars-export-copy small {
	font-size: 11.5px;
	line-height: 1.45;
	color: var(--ars-ink-dim);
}
.ars-export-card.is-disabled {
	opacity: 0.42;
	cursor: not-allowed;
	pointer-events: none;
}
.ars-export-note {
	font-size: 11.5px !important;
	color: var(--ars-warn) !important;
}
.ars-export-sheet > .ars-btn {
	min-width: 92px;
}

@media (max-width: 520px) {
	.ars-export-options {
		grid-template-columns: 1fr;
	}
}

/* ── AR hand-off sheet ── */
.ars-ar-sheet { gap: 14px; }
.ars-ar-sheet .ars-btn { width: 100%; }
.ars-ar-heading { letter-spacing: -0.01em; }
.ars-ar-target { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; }
.ars-ar-thumb {
	width: min(210px, 52vw); aspect-ratio: 1; border-radius: 18px;
	background: radial-gradient(120% 120% at 50% 0%, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.02));
	border: 1px solid var(--ars-line);
	display: grid; place-items: center; overflow: hidden;
	font-size: 42px; color: var(--ars-ink-faint);
}
.ars-ar-thumb img { width: 100%; height: 100%; object-fit: contain; }
.ars-ar-name { font-size: 15px; font-weight: 700; text-align: center; overflow-wrap: anywhere; }
.ars-ar-picker { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; width: 100%; }
.ars-ar-chip {
	appearance: none; cursor: pointer; font: inherit; font-size: 12px; font-weight: 650;
	color: var(--ars-ink-dim); background: rgba(255, 255, 255, 0.06);
	border: 1px solid var(--ars-line); border-radius: 999px; padding: 6px 11px;
	max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ars-ar-chip:hover { background: rgba(255, 255, 255, 0.12); color: var(--ars-ink); }
.ars-ar-chip:active { transform: translateY(1px); }
.ars-ar-chip[aria-pressed="true"] {
	background: color-mix(in srgb, var(--ars-accent) 20%, transparent);
	border-color: color-mix(in srgb, var(--ars-accent) 55%, transparent);
	color: var(--ars-accent-ink);
}
.ars-ar-hint { color: var(--ars-ink-faint) !important; font-size: 12.5px !important; }
.ars-ar-status { min-height: 17px; display: flex; align-items: center; justify-content: center; gap: 7px; }
.ars-ar-status.is-error { color: #ffb4b4 !important; }
.ars-ar-status.is-ready { color: var(--ars-accent-ink) !important; }
.ars-ar-status .ars-spinner { width: 12px; height: 12px; border-width: 2px; }
.ars-ar-go[aria-busy="true"],
.ars-ar-scene[aria-busy="true"] { cursor: progress; }
.ars-ar-go { font-size: 15px; padding: 13px 18px; }
.ars-ar-go-icon { font-size: 15px; }
.ars-ar-scene { font-size: 14px; padding: 12px 18px; }
.ars-ar-scene-icon { margin-right: 5px; }
.ars-dialog-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.ars-divider { width: 100%; height: 1px; background: var(--ars-line); margin: 2px 0; }

/* WebXR: the dom-overlay shows the HUD over the passthrough camera; the empty
   card and grid would only be in the way once the room itself is the backdrop. */
.ars-root.is-xr .ars-empty, .ars-root.is-xr .ars-back { display: none; }

@media (prefers-reduced-motion: reduce) {
	.ars-root *, .ars-root *::before, .ars-root *::after {
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
		transition-duration: 0.01ms !important;
	}
}
@media (max-width: 420px) {
	.ars-title { display: none; }
	.ars-item-list { grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); }
	/* A phone this narrow cannot fit the prompt beside four controls without
	   squeezing it down to two visible characters. Give it its own row. */
	.ars-dock { flex-wrap: wrap; row-gap: 10px; }
	.ars-forge-form { order: -1; flex: 1 0 100%; }
	.ars-dock .ars-icon-btn { flex: 0 0 auto; }
	.ars-status { bottom: calc(env(safe-area-inset-bottom, 0px) + 152px); }
	.ars-selbar { bottom: calc(env(safe-area-inset-bottom, 0px) + 100px); }
}
@media (max-width: 560px) {
  .ars-saved-scene-bar { align-items: stretch; }
  .ars-saved-scene-current { width: 100%; }
  .ars-saved-scene-actions { width: 100%; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 2px; }
  .ars-saved-scene-btn { flex: 0 0 auto; min-height: 38px; }
}

`;
}
