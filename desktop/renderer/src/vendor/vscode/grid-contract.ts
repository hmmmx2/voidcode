/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Transcribed from microsoft/vscode @ d8b160690c1848cf3d12330939c4cd27287dae93.
 *
 *   ISerializedLeafNode / ISerializedBranchNode / ISerializedNode / ISerializedGrid
 *     — src/vs/base/browser/ui/grid/grid.ts:752-774, verbatim including formatting.
 *   IViewConstraints
 *     — src/vs/base/browser/ui/grid/gridview.ts:41-136 (`IView`), reduced to the members that
 *       mean anything without a DOM. `element` and `layout()` are gone because React owns the
 *       markup here; the doc comments on what remains are upstream's.
 *
 * TWO DELIBERATE DEVIATIONS, both forced and both here rather than hidden in a wrapper:
 *
 *   1. Upstream `Orientation` is `const enum Orientation { VERTICAL, HORIZONTAL }` in
 *      sash.ts. Both tsconfigs here set `isolatedModules`, under which a cross-file `const enum`
 *      is transpiled to a runtime object by esbuild and stops being the compile-time constant it
 *      is upstream. It is written below as the numeric literal union it compiles to, which keeps
 *      the persisted format byte-identical while letting this file erase completely at build
 *      time. Nothing in this directory emits a single byte of JavaScript.
 *   2. `IView.priority` referenced `LayoutPriority`, and `snap` is kept but the sash plumbing
 *      it drives is not. The enum is inlined as a union for the same reason as (1).
 *
 * See PROVENANCE.md. Upstream formatting — tabs, single quotes — is kept on purpose.
 */

/**
 * Upstream: `const enum Orientation { VERTICAL, HORIZONTAL }` (sash.ts:24-27).
 * VERTICAL is 0 and HORIZONTAL is 1, which is what lands in the persisted document.
 */
export type SerializedOrientation = 0 | 1;

/** Upstream: `const enum LayoutPriority { Normal, Low, High }` (splitview.ts:28-32). */
export type SerializedLayoutPriority = 0 | 1 | 2;

export interface IViewConstraints {

	/**
	 * A minimum width for this view.
	 *
	 * @remarks If none, set it to `0`.
	 */
	readonly minimumWidth: number;

	/**
	 * A minimum width for this view.
	 *
	 * @remarks If none, set it to `Number.POSITIVE_INFINITY`.
	 */
	readonly maximumWidth: number;

	/**
	 * A minimum height for this view.
	 *
	 * @remarks If none, set it to `0`.
	 */
	readonly minimumHeight: number;

	/**
	 * A minimum height for this view.
	 *
	 * @remarks If none, set it to `Number.POSITIVE_INFINITY`.
	 */
	readonly maximumHeight: number;

	/**
	 * The priority of the view when the {@link GridView} layout algorithm
	 * runs. Views with higher priority will be resized first.
	 *
	 * @remarks Only used when `proportionalLayout` is false.
	 */
	readonly priority?: SerializedLayoutPriority;

	/**
	 * Whether the view will snap whenever the user reaches its minimum size or
	 * attempts to grow it beyond the minimum size.
	 */
	readonly snap?: boolean;
}

export interface ISerializedLeafNode {
	type: 'leaf';
	data: unknown;
	size: number;
	visible?: boolean;
	maximized?: boolean;
}

export interface ISerializedBranchNode {
	type: 'branch';
	data: ISerializedNode[];
	size: number;
	visible?: boolean;
}

export type ISerializedNode = ISerializedLeafNode | ISerializedBranchNode;

export interface ISerializedGrid {
	root: ISerializedNode;
	orientation: SerializedOrientation;
	width: number;
	height: number;
}
