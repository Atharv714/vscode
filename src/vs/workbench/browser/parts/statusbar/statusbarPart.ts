/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/statusbarpart';
import { localize } from 'vs/nls';
import { dispose } from 'vs/base/common/lifecycle';
import { Part } from 'vs/workbench/browser/part';
import { EventType as TouchEventType, Gesture, GestureEvent } from 'vs/base/browser/touch';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { StatusbarAlignment, IStatusbarService, IStatusbarEntry, IStatusbarEntryAccessor } from 'vs/workbench/services/statusbar/browser/statusbar';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IAction, Separator, toAction } from 'vs/base/common/actions';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { STATUS_BAR_BACKGROUND, STATUS_BAR_FOREGROUND, STATUS_BAR_NO_FOLDER_BACKGROUND, STATUS_BAR_ITEM_HOVER_BACKGROUND, STATUS_BAR_ITEM_ACTIVE_BACKGROUND, STATUS_BAR_PROMINENT_ITEM_FOREGROUND, STATUS_BAR_PROMINENT_ITEM_BACKGROUND, STATUS_BAR_PROMINENT_ITEM_HOVER_BACKGROUND, STATUS_BAR_BORDER, STATUS_BAR_NO_FOLDER_FOREGROUND, STATUS_BAR_NO_FOLDER_BORDER } from 'vs/workbench/common/theme';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { contrastBorder, activeContrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { EventHelper, createStyleSheet, addDisposableListener, EventType } from 'vs/base/browser/dom';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { Parts, IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { coalesce } from 'vs/base/common/arrays';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { ToggleStatusbarVisibilityAction } from 'vs/workbench/browser/actions/layoutActions';
import { assertIsDefined } from 'vs/base/common/types';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ColorScheme } from 'vs/platform/theme/common/theme';
import { hash } from 'vs/base/common/hash';
import { IHoverService } from 'vs/workbench/services/hover/browser/hover';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IHoverDelegate, IHoverDelegateOptions } from 'vs/base/browser/ui/iconLabel/iconHoverDelegate';
import { CONTEXT_STATUS_BAR_FOCUSED, HideStatusbarEntryAction, ToggleStatusbarEntryVisibilityAction } from 'vs/workbench/browser/parts/statusbar/statusbarActions';
import { IStatusbarViewModelEntry, StatusbarViewModel } from 'vs/workbench/browser/parts/statusbar/statusbarModel';
import { StatusbarEntryItem } from 'vs/workbench/browser/parts/statusbar/statusbarItem';

interface IStatusbarEntryPriority {

	/**
	 * The main priority of the entry that
	 * defines the order of appearance.
	 *
	 * May not be unique across all entries.
	 */
	readonly primary: number;

	/**
	 * The secondary priority of the entry
	 * is used in case the main priority
	 * matches another one's priority.
	 *
	 * Should be unique across all entries.
	 */
	readonly secondary: number;
}

interface IPendingStatusbarEntry {
	readonly id: string;
	readonly alignment: StatusbarAlignment;
	readonly priority: IStatusbarEntryPriority;

	entry: IStatusbarEntry;
	accessor?: IStatusbarEntryAccessor;
}

export class StatusbarPart extends Part implements IStatusbarService {

	declare readonly _serviceBrand: undefined;

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 22;
	readonly maximumHeight: number = 22;

	//#endregion

	private styleElement: HTMLStyleElement | undefined;

	private pendingEntries: IPendingStatusbarEntry[] = [];

	private readonly viewModel = this._register(new StatusbarViewModel(this.storageService));

	readonly onDidChangeEntryVisibility = this.viewModel.onDidChangeEntryVisibility;

	private leftItemsContainer: HTMLElement | undefined;
	private rightItemsContainer: HTMLElement | undefined;

	private readonly hoverDelegate: IHoverDelegate = {
		showHover: (options: IHoverDelegateOptions) => this.hoverService.showHover(options),
		delay: this.configurationService.getValue<number>('workbench.hover.delay'),
		placement: 'element'
	};

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextMenuService private contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super(Parts.STATUSBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateStyles()));
	}

	addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, primaryPriority = 0): IStatusbarEntryAccessor {
		const priority: IStatusbarEntryPriority = {
			primary: primaryPriority,
			secondary: hash(id) // derive from identifier to accomplish uniqueness
		};

		// As long as we have not been created into a container yet, record all entries
		// that are pending so that they can get created at a later point
		if (!this.element) {
			return this.doAddPendingEntry(entry, id, alignment, priority);
		}

		// Otherwise add to view
		return this.doAddEntry(entry, id, alignment, priority);
	}

	private doAddPendingEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: IStatusbarEntryPriority): IStatusbarEntryAccessor {
		const pendingEntry: IPendingStatusbarEntry = { entry, id, alignment, priority };
		this.pendingEntries.push(pendingEntry);

		const accessor: IStatusbarEntryAccessor = {
			update: (entry: IStatusbarEntry) => {
				if (pendingEntry.accessor) {
					pendingEntry.accessor.update(entry);
				} else {
					pendingEntry.entry = entry;
				}
			},

			dispose: () => {
				if (pendingEntry.accessor) {
					pendingEntry.accessor.dispose();
				} else {
					this.pendingEntries = this.pendingEntries.filter(entry => entry !== pendingEntry);
				}
			}
		};

		return accessor;
	}

	private doAddEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: IStatusbarEntryPriority): IStatusbarEntryAccessor {

		// Create item
		const itemContainer = this.doCreateStatusItem(id, alignment, ...coalesce([entry.showBeak ? 'has-beak' : undefined]));
		const item = this.instantiationService.createInstance(StatusbarEntryItem, itemContainer, entry, this.hoverDelegate);

		// Append to parent
		this.appendOneStatusbarEntry(itemContainer, alignment, priority);

		// Add to view model
		const viewModelEntry: IStatusbarViewModelEntry = new class implements IStatusbarViewModelEntry {
			readonly id = id;
			readonly alignment = alignment;
			readonly priority = priority;
			readonly container = itemContainer;
			readonly labelContainer = item.labelContainer;

			get name() { return item.name; }
		};
		const viewModelEntryDispose = this.viewModel.add(viewModelEntry);

		return {
			update: entry => {
				item.update(entry);
			},
			dispose: () => {
				dispose(viewModelEntryDispose);
				itemContainer.remove();
				dispose(item);
			}
		};
	}

	isEntryVisible(id: string): boolean {
		return !this.viewModel.isHidden(id);
	}

	updateEntryVisibility(id: string, visible: boolean): void {
		if (visible) {
			this.viewModel.show(id);
		} else {
			this.viewModel.hide(id);
		}
	}

	focusNextEntry(): void {
		this.viewModel.focusNextEntry();
	}

	focusPreviousEntry(): void {
		this.viewModel.focusPreviousEntry();
	}

	isEntryFocused(): boolean {
		return this.viewModel.isEntryFocused();
	}

	focus(preserveEntryFocus = true): void {
		this.getContainer()?.focus();
		const lastFocusedEntry = this.viewModel.lastFocusedEntry;
		if (preserveEntryFocus && lastFocusedEntry) {
			// Need a timeout, for some reason without it the inner label container will not get focused
			setTimeout(() => lastFocusedEntry.labelContainer.focus(), 0);
		}
	}

	override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		// Track focus within container
		const scopedContextKeyService = this.contextKeyService.createScoped(this.element);
		CONTEXT_STATUS_BAR_FOCUSED.bindTo(scopedContextKeyService).set(true);

		// Left items container
		this.leftItemsContainer = document.createElement('div');
		this.leftItemsContainer.classList.add('left-items', 'items-container');
		this.element.appendChild(this.leftItemsContainer);
		this.element.tabIndex = 0;

		// Right items container
		this.rightItemsContainer = document.createElement('div');
		this.rightItemsContainer.classList.add('right-items', 'items-container');
		this.element.appendChild(this.rightItemsContainer);

		// Context menu support
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => this.showContextMenu(e)));
		this._register(Gesture.addTarget(parent));
		this._register(addDisposableListener(parent, TouchEventType.Contextmenu, e => this.showContextMenu(e)));

		// Initial status bar entries
		this.createInitialStatusbarEntries();

		return this.element;
	}

	private createInitialStatusbarEntries(): void {

		// Add items in order according to alignment
		this.appendAllStatusbarEntries();

		// Fill in pending entries if any
		while (this.pendingEntries.length) {
			const pending = this.pendingEntries.shift();
			if (pending) {
				pending.accessor = this.addEntry(pending.entry, pending.id, pending.alignment, pending.priority.primary);
			}
		}
	}

	private appendAllStatusbarEntries(): void {

		// Append in order of priority
		for (const entry of [
			...this.viewModel.getEntries(StatusbarAlignment.LEFT),
			...this.viewModel.getEntries(StatusbarAlignment.RIGHT).reverse() // reversing due to flex: row-reverse
		]) {
			const target = assertIsDefined(entry.alignment === StatusbarAlignment.LEFT ? this.leftItemsContainer : this.rightItemsContainer);

			target.appendChild(entry.container);
		}
	}

	private appendOneStatusbarEntry(itemContainer: HTMLElement, alignment: StatusbarAlignment, priority: IStatusbarEntryPriority): void {
		const entries = this.viewModel.getEntries(alignment);

		if (alignment === StatusbarAlignment.RIGHT) {
			entries.reverse(); // reversing due to flex: row-reverse
		}

		const target = assertIsDefined(alignment === StatusbarAlignment.LEFT ? this.leftItemsContainer : this.rightItemsContainer);

		// find an entry that has lower priority than the new one
		// and then insert the item before that one
		let appended = false;
		for (const entry of entries) {

			// pick a priority that ideally is not the same
			// by falling back to secondary priority
			let existingEntryPriority = entry.priority.primary;
			let newEntryPriority = priority.primary;
			if (existingEntryPriority === newEntryPriority) {
				existingEntryPriority = entry.priority.secondary;
				newEntryPriority = priority.secondary;
			}

			// insert according to priority
			if (
				alignment === StatusbarAlignment.LEFT && existingEntryPriority < newEntryPriority ||
				alignment === StatusbarAlignment.RIGHT && existingEntryPriority > newEntryPriority // reversing due to flex: row-reverse
			) {
				target.insertBefore(itemContainer, entry.container);
				appended = true;
				break;
			}
		}

		// Fallback to just appending otherwise
		if (!appended) {
			target.appendChild(itemContainer);
		}
	}

	private showContextMenu(e: MouseEvent | GestureEvent): void {
		EventHelper.stop(e, true);

		const event = new StandardMouseEvent(e);

		let actions: IAction[] | undefined = undefined;
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.posx, y: event.posy }),
			getActions: () => {
				actions = this.getContextMenuActions(event);

				return actions;
			},
			onHide: () => {
				if (actions) {
					dispose(actions);
				}
			}
		});
	}

	private getContextMenuActions(event: StandardMouseEvent): IAction[] {
		const actions: IAction[] = [];

		// Provide an action to hide the status bar at last
		actions.push(toAction({ id: ToggleStatusbarVisibilityAction.ID, label: localize('hideStatusBar', "Hide Status Bar"), run: () => this.instantiationService.invokeFunction(accessor => new ToggleStatusbarVisibilityAction().run(accessor)) }));
		actions.push(new Separator());

		// Show an entry per known status entry
		// Note: even though entries have an identifier, there can be multiple entries
		// having the same identifier (e.g. from extensions). So we make sure to only
		// show a single entry per identifier we handled.
		const handledEntries = new Set<string>();
		for (const entry of this.viewModel.entries) {
			if (!handledEntries.has(entry.id)) {
				actions.push(new ToggleStatusbarEntryVisibilityAction(entry.id, entry.name, this.viewModel));
				handledEntries.add(entry.id);
			}
		}

		// Figure out if mouse is over an entry
		let statusEntryUnderMouse: IStatusbarViewModelEntry | undefined = undefined;
		for (let element: HTMLElement | null = event.target; element; element = element.parentElement) {
			const entry = this.viewModel.findEntry(element);
			if (entry) {
				statusEntryUnderMouse = entry;
				break;
			}
		}

		if (statusEntryUnderMouse) {
			actions.push(new Separator());
			actions.push(new HideStatusbarEntryAction(statusEntryUnderMouse.id, statusEntryUnderMouse.name, this.viewModel));
		}

		return actions;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertIsDefined(this.getContainer());

		// Background colors
		const backgroundColor = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_BACKGROUND : STATUS_BAR_NO_FOLDER_BACKGROUND) || '';
		container.style.backgroundColor = backgroundColor;
		container.style.color = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_FOREGROUND : STATUS_BAR_NO_FOLDER_FOREGROUND) || '';

		// Border color
		const borderColor = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_BORDER : STATUS_BAR_NO_FOLDER_BORDER) || this.getColor(contrastBorder);
		if (borderColor) {
			container.classList.add('status-border-top');
			container.style.setProperty('--status-border-top-color', borderColor.toString());
		} else {
			container.classList.remove('status-border-top');
			container.style.removeProperty('--status-border-top-color');
		}

		// Notification Beak
		if (!this.styleElement) {
			this.styleElement = createStyleSheet(container);
		}

		this.styleElement.textContent = `.monaco-workbench .part.statusbar > .items-container > .statusbar-item.has-beak:before { border-bottom-color: ${backgroundColor}; }`;
	}

	private doCreateStatusItem(id: string, alignment: StatusbarAlignment, ...extraClasses: string[]): HTMLElement {
		const itemContainer = document.createElement('div');
		itemContainer.id = id;

		itemContainer.classList.add('statusbar-item');
		if (extraClasses) {
			itemContainer.classList.add(...extraClasses);
		}

		if (alignment === StatusbarAlignment.RIGHT) {
			itemContainer.classList.add('right');
		} else {
			itemContainer.classList.add('left');
		}

		return itemContainer;
	}

	override layout(width: number, height: number): void {
		super.layout(width, height);
		super.layoutContents(width, height);
	}

	toJSON(): object {
		return {
			type: Parts.STATUSBAR_PART
		};
	}
}

registerThemingParticipant((theme, collector) => {
	if (theme.type !== ColorScheme.HIGH_CONTRAST) {
		const statusBarItemHoverBackground = theme.getColor(STATUS_BAR_ITEM_HOVER_BACKGROUND);
		if (statusBarItemHoverBackground) {
			collector.addRule(`.monaco-workbench .part.statusbar > .items-container > .statusbar-item a:hover:not(.disabled) { background-color: ${statusBarItemHoverBackground}; }`);
			collector.addRule(`.monaco-workbench .part.statusbar > .items-container > .statusbar-item a:focus:not(.disabled) { background-color: ${statusBarItemHoverBackground}; }`);
		}

		const statusBarItemActiveBackground = theme.getColor(STATUS_BAR_ITEM_ACTIVE_BACKGROUND);
		if (statusBarItemActiveBackground) {
			collector.addRule(`.monaco-workbench .part.statusbar > .items-container > .statusbar-item a:active:not(.disabled) { background-color: ${statusBarItemActiveBackground}; }`);
		}
	}

	const activeContrastBorderColor = theme.getColor(activeContrastBorder);
	if (activeContrastBorderColor) {
		collector.addRule(`
			.monaco-workbench .part.statusbar > .items-container > .statusbar-item a:focus:not(.disabled),
			.monaco-workbench .part.statusbar > .items-container > .statusbar-item a:active:not(.disabled) {
				outline: 1px solid ${activeContrastBorderColor} !important;
				outline-offset: -1px;
			}
		`);
		collector.addRule(`
			.monaco-workbench .part.statusbar > .items-container > .statusbar-item a:hover:not(.disabled) {
				outline: 1px dashed ${activeContrastBorderColor};
				outline-offset: -1px;
			}
		`);
	}

	const statusBarProminentItemForeground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_FOREGROUND);
	if (statusBarProminentItemForeground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .items-container > .statusbar-item .status-bar-info { color: ${statusBarProminentItemForeground}; }`);
	}

	const statusBarProminentItemBackground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_BACKGROUND);
	if (statusBarProminentItemBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .items-container > .statusbar-item .status-bar-info { background-color: ${statusBarProminentItemBackground}; }`);
	}

	const statusBarProminentItemHoverBackground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_HOVER_BACKGROUND);
	if (statusBarProminentItemHoverBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .items-container > .statusbar-item a.status-bar-info:hover:not(.disabled) { background-color: ${statusBarProminentItemHoverBackground}; }`);
	}
});

registerSingleton(IStatusbarService, StatusbarPart);
