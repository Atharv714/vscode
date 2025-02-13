/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { IEditorMemento, IEditorCloseEvent, IEditorInput, IEditorOpenContext, EditorResourceAccessor, SideBySideEditor } from 'vs/workbench/common/editor';
import { EditorPane } from 'vs/workbench/browser/parts/editor/editorPane';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/textResourceConfigurationService';
import { IEditorGroupsService, IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtUri } from 'vs/base/common/resources';
import { MutableDisposable } from 'vs/base/common/lifecycle';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { IEditorOptions } from 'vs/platform/editor/common/editor';
import { CancellationToken } from 'vs/base/common/cancellation';

/**
 * Base class of editors that want to store and restore view state.
 */
export abstract class AbstractEditorWithViewState<T extends object> extends EditorPane {

	private viewState: IEditorMemento<T>;

	private readonly groupListener = this._register(new MutableDisposable());

	constructor(
		id: string,
		viewStateStorageKey: string,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService protected readonly textResourceConfigurationService: ITextResourceConfigurationService,
		@IThemeService themeService: IThemeService,
		@IEditorService protected readonly editorService: IEditorService,
		@IEditorGroupsService protected readonly editorGroupService: IEditorGroupsService
	) {
		super(id, telemetryService, themeService, storageService);

		this.viewState = this.getEditorMemento<T>(editorGroupService, textResourceConfigurationService, viewStateStorageKey, 100);
	}

	protected override setEditorVisible(visible: boolean, group: IEditorGroup | undefined): void {

		// Listen to close events to trigger `onWillCloseEditorInGroup`
		this.groupListener.value = group?.onWillCloseEditor(e => this.onWillCloseEditor(e));

		super.setEditorVisible(visible, group);
	}

	private onWillCloseEditor(e: IEditorCloseEvent): void {
		const editor = e.editor;
		if (editor === this.input) {
			// React to editors closing to preserve or clear view state. This needs to happen
			// in the `onWillCloseEditor` because at that time the editor has not yet
			// been disposed and we can safely persist the view state.
			this.updateEditorViewState(editor);
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {

		// Preserve current input view state before opening new
		this.updateEditorViewState(this.input);

		await super.setInput(input, options, context, token);
	}

	override clearInput(): void {

		// Preserve current input view state before clearing
		this.updateEditorViewState(this.input);

		super.clearInput();
	}

	protected override saveState(): void {

		// Preserve current input view state before shutting down
		this.updateEditorViewState(this.input);

		super.saveState();
	}

	private updateEditorViewState(input: IEditorInput | undefined): void {
		if (!input || !this.tracksEditorViewState(input)) {
			return; // ensure we have an input to handle view state for
		}

		const resource = this.toEditorViewStateResource(input);
		if (!resource) {
			return; // we need a resource
		}

		// Clear the editor view state if:
		// - the editor view state should not be tracked for disposed editors
		// - the user configured to not restore view state unless the editor is still opened in the group
		if (
			(input.isDisposed() && !this.tracksDisposedEditorViewState()) ||
			(!this.shouldRestoreEditorViewState(input) && (!this.group || !this.group.contains(input)))
		) {
			this.clearEditorViewState(resource, this.group);
		}

		// Otherwise we save the view state
		else if (!input.isDisposed()) {
			this.saveEditorViewState(resource);
		}
	}

	private shouldRestoreEditorViewState(input: IEditorInput, context?: IEditorOpenContext): boolean {

		// new editor: check with workbench.editor.restoreViewState setting
		if (context?.newInGroup) {
			return this.textResourceConfigurationService.getValue<boolean>(EditorResourceAccessor.getOriginalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY }), 'workbench.editor.restoreViewState') === false ? false : true /* restore by default */;
		}

		// existing editor: always restore viewstate
		return true;
	}

	override getViewState(): T | undefined {
		const input = this.input;
		if (!input || !this.tracksEditorViewState(input)) {
			return; // need valid input for view state
		}

		const resource = this.toEditorViewStateResource(input);
		if (!resource) {
			return; // need a resource for finding view state
		}

		return this.computeEditorViewState(resource);
	}

	private saveEditorViewState(resource: URI): void {
		if (!this.group) {
			return;
		}

		const editorViewState = this.computeEditorViewState(resource);
		if (!editorViewState) {
			return;
		}

		this.viewState.saveEditorState(this.group, resource, editorViewState);
	}

	protected loadEditorViewState(input: IEditorInput | undefined, context?: IEditorOpenContext): T | undefined {
		if (!input || !this.group) {
			return undefined; // we need valid input
		}

		if (!this.tracksEditorViewState(input)) {
			return undefined; // not tracking for input
		}

		if (!this.shouldRestoreEditorViewState(input, context)) {
			return undefined; // not enabled for input
		}

		const resource = this.toEditorViewStateResource(input);
		if (!resource) {
			return; // need a resource for finding view state
		}

		return this.viewState.loadEditorState(this.group, resource);
	}

	protected moveEditorViewState(source: URI, target: URI, comparer: IExtUri): void {
		return this.viewState.moveEditorState(source, target, comparer);
	}

	protected clearEditorViewState(resource: URI, group?: IEditorGroup): void {
		this.viewState.clearEditorState(resource, group);
	}

	//#region Subclasses should/could override based on needs

	/**
	 * The actual method to provide for gathering the view state
	 * object for the control.
	 *
	 * @param resource the expected `URI` for the view state. This
	 * should be used as a way to ensure the view state in the
	 * editor control is matching the resource expected.
	 */
	protected abstract computeEditorViewState(resource: URI): T | undefined;

	/**
	 * Whether view state should be associated with the given input.
	 * Subclasses need to ensure that the editor input is expected
	 * for the editor.
	 */
	protected abstract tracksEditorViewState(input: IEditorInput): boolean;

	/**
	 * Whether view state should be tracked even when the editor is
	 * disposed.
	 *
	 * Subclasses should override this if the input can be restored
	 * from the resource at a later point, e.g. if backed by files.
	 */
	protected tracksDisposedEditorViewState(): boolean {
		return false;
	}

	/**
	 * Asks to return the `URI` to associate with the view state.
	 */
	protected abstract toEditorViewStateResource(input: IEditorInput): URI | undefined;

	//#endregion
}
