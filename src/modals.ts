import {
	App,
	FuzzyMatch,
	FuzzySuggestModal,
	Modal,
	prepareFuzzySearch,
	renderMatches,
	SearchResult,
	Setting,
	SuggestModal,
	TFile,
} from "obsidian";
import { FiletypeChoice, propertyValueToInput, sanitizeVaultPath } from "./formatter";

export interface TemplatePickerItem {
	id: string;
	label: string;
	subtext: string;
	choice?: FiletypeChoice;
	templateFile?: TFile;
}

/**
 * Fuzzy picker modal to select and run any configured filetype action.
 */
export class FiletypeChoicePickerModal extends FuzzySuggestModal<FiletypeChoice> {
	private choices: FiletypeChoice[];
	private onSelectChoice: (choice: FiletypeChoice) => void;

	constructor(
		app: App,
		choices: FiletypeChoice[],
		onSelectChoice: (choice: FiletypeChoice) => void
	) {
		super(app);
		this.choices = choices;
		this.onSelectChoice = onSelectChoice;
		this.setPlaceholder("Select a filetype action to run...");
	}

	getItems(): FiletypeChoice[] {
		return this.choices;
	}

	getItemText(item: FiletypeChoice): string {
		return `${item.name} ${item.type === "capture" ? "capture" : "template"}`;
	}

	/** Title over a muted line naming the kind of action and where it writes, like the template picker. */
	renderSuggestion(match: FuzzyMatch<FiletypeChoice>, el: HTMLElement): void {
		const item = match.item;
		el.addClass("filetypes-template-suggestion");
		el.createDiv({ cls: "filetypes-template-title", text: item.name });
		const where =
			item.type === "capture"
				? `Capture → ${item.targetPath?.trim() || "active note"}${item.targetHeading?.trim() ? ` › ${item.targetHeading.trim()}` : ""}`
				: `Template${item.templatePath?.trim() ? ` · ${item.templatePath.trim()}` : ""}${item.folderPath?.trim() ? ` → ${item.folderPath.trim()}/` : ""}`;
		el.createDiv({ cls: "filetypes-template-subtext", text: where });
	}

	onChooseItem(item: FiletypeChoice, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectChoice(item);
	}
}

/**
 * Fuzzy modal that lists all available templates
 * (both configured Template filetypes and markdown files in the Templates folder).
 */
export class FiletypeTemplatePickerModal extends FuzzySuggestModal<TemplatePickerItem> {
	private items: TemplatePickerItem[];
	private onSelectTemplate: (
		item: TemplatePickerItem,
		evt: MouseEvent | KeyboardEvent
	) => void;

	constructor(
		app: App,
		items: TemplatePickerItem[],
		onSelectTemplate: (
			item: TemplatePickerItem,
			evt: MouseEvent | KeyboardEvent
		) => void
	) {
		super(app);
		this.items = items;
		this.onSelectTemplate = onSelectTemplate;
		this.setPlaceholder("Select a template to create a note...");
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to create note from template" },
			{ command: "shift ↵", purpose: "to insert at cursor in active note" },
			{ command: "esc", purpose: "to dismiss" },
		]);
	}

	getItems(): TemplatePickerItem[] {
		return this.items;
	}

	getItemText(item: TemplatePickerItem): string {
		return `${item.label} (${item.subtext})`;
	}

	renderSuggestion(
		match: FuzzyMatch<TemplatePickerItem>,
		el: HTMLElement
	): void {
		const item = match.item;
		el.addClass("filetypes-template-suggestion");
		el.createDiv({
			cls: "filetypes-template-title",
			text: item.label,
		});
		el.createDiv({
			cls: "filetypes-template-subtext",
			text: item.subtext,
		});
	}

	onChooseItem(
		item: TemplatePickerItem,
		evt: MouseEvent | KeyboardEvent
	): void {
		this.onSelectTemplate(item, evt);
	}
}

/**
 * Fuzzy modal to select which filetype to convert the selected text to.
 */
export class FiletypeConvertPickerModal extends FuzzySuggestModal<TemplatePickerItem> {
	private items: TemplatePickerItem[];
	private onSelectTemplate: (item: TemplatePickerItem) => void;

	constructor(
		app: App,
		items: TemplatePickerItem[],
		onSelectTemplate: (item: TemplatePickerItem) => void
	) {
		super(app);
		this.items = items;
		this.onSelectTemplate = onSelectTemplate;
		this.setPlaceholder("Select filetype to convert selected text to...");
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to convert selection to filetype note" },
			{ command: "esc", purpose: "to dismiss" },
		]);
	}

	getItems(): TemplatePickerItem[] {
		return this.items;
	}

	getItemText(item: TemplatePickerItem): string {
		return `${item.label} (${item.subtext})`;
	}

	renderSuggestion(
		match: FuzzyMatch<TemplatePickerItem>,
		el: HTMLElement
	): void {
		const item = match.item;
		el.addClass("filetypes-template-suggestion");
		el.createDiv({
			cls: "filetypes-template-title",
			text: item.label,
		});
		el.createDiv({
			cls: "filetypes-template-subtext",
			text: item.subtext,
		});
	}

	onChooseItem(item: TemplatePickerItem): void {
		this.onSelectTemplate(item);
	}
}

/**
 * Lightweight input prompt modal that resolves to the user's entered string,
 * or `null` if dismissed.
 */
export class FiletypeInputModal extends Modal {
	private promptLabel: string;
	private placeholder: string;
	private value = "";
	private submitted = false;
	private resolvePromise!: (val: string | null) => void;

	constructor(
		app: App,
		promptLabel: string,
		placeholder = "Enter value",
		initialValue = ""
	) {
		super(app);
		this.promptLabel = promptLabel;
		this.placeholder = placeholder;
		this.value = initialValue;
	}

	static prompt(
		app: App,
		promptLabel: string,
		placeholder?: string,
		initialValue = ""
	): Promise<string | null> {
		const modal = new FiletypeInputModal(
			app,
			promptLabel,
			placeholder,
			initialValue
		);
		return modal.openAndWait();
	}

	openAndWait(): Promise<string | null> {
		return new Promise<string | null>((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("filetypes-prompt-modal");

		new Setting(contentEl).setName(this.promptLabel).setHeading();

		const inputEl = contentEl.createEl("input", {
			type: "text",
			cls: "filetypes-prompt-input",
			placeholder: this.placeholder,
		});
		inputEl.value = this.value;

		inputEl.addEventListener("input", () => {
			this.value = inputEl.value;
		});

		inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key === "Enter" && !evt.isComposing) {
				evt.preventDefault();
				this.submitted = true;
				this.close();
			}
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("OK")
					.setCta()
					.onClick(() => {
						this.submitted = true;
						this.close();
					})
			);

		window.requestAnimationFrame(() => {
			if (inputEl.isConnected) {
				inputEl.focus();
				inputEl.select();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.resolvePromise) {
			const resolve = this.resolvePromise;
			this.resolvePromise = null as unknown as (val: string | null) => void;
			resolve(this.submitted ? this.value : null);
		}
	}
}

interface FolderOption {
	path: string;
	isDefault: boolean;
	isNew: boolean;
	match: SearchResult | null;
}

/**
 * Picks the folder a new note goes into. The configured folder is listed first and selected, so
 * Enter keeps it; typing a path that does not exist offers to create it.
 */
export class FiletypeFolderPickerModal extends SuggestModal<FolderOption> {
	private folders: string[];
	private defaultFolder: string;
	private chosen: string | null = null;
	private resolvePromise: ((folder: string | null) => void) | null = null;

	constructor(app: App, title: string, folders: string[], defaultFolder: string) {
		super(app);
		this.folders = folders;
		this.defaultFolder = defaultFolder;
		this.setPlaceholder(`${title}: choose a destination folder...`);
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to create the note in this folder" },
			{ command: "esc", purpose: "to cancel" },
		]);
	}

	static pick(app: App, title: string, folders: string[], defaultFolder: string): Promise<string | null> {
		const modal = new FiletypeFolderPickerModal(app, title, folders, defaultFolder);
		return new Promise((resolve) => {
			modal.resolvePromise = resolve;
			modal.open();
		});
	}

	getSuggestions(query: string): FolderOption[] {
		const trimmed = query.trim();
		const option = (path: string, match: SearchResult | null): FolderOption => ({
			path,
			isDefault: path === this.defaultFolder,
			isNew: false,
			match,
		});

		if (!trimmed) {
			const rest = this.folders.filter((f) => f !== this.defaultFolder);
			return [option(this.defaultFolder, null), ...rest.map((f) => option(f, null))];
		}

		const search = prepareFuzzySearch(trimmed);
		const results: FolderOption[] = [];
		for (const folder of this.folders) {
			const match = search(folder || "/");
			if (match) results.push(option(folder, match));
		}
		results.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));

		const typed = sanitizeVaultPath(trimmed);
		if (typed && !this.folders.some((f) => f.toLowerCase() === typed.toLowerCase())) {
			results.push({ path: typed, isDefault: false, isNew: true, match: null });
		}
		return results;
	}

	renderSuggestion(item: FolderOption, el: HTMLElement): void {
		el.addClass("filetypes-template-suggestion");
		const title = el.createDiv({ cls: "filetypes-template-title" });
		const label = item.path || "Vault root (/)";
		if (item.isNew) {
			title.setText(`Create folder: ${label}`);
		} else if (item.match && item.path) {
			renderMatches(title, label, item.match.matches);
		} else {
			title.setText(label);
		}
		if (item.isDefault) {
			el.createDiv({ cls: "filetypes-template-subtext", text: "Configured folder" });
		}
	}

	onChooseSuggestion(item: FolderOption): void {
		this.chosen = item.path;
	}

	onClose(): void {
		super.onClose();
		// Obsidian closes the modal before calling onChooseSuggestion, so settle on the next tick.
		window.setTimeout(() => {
			const resolve = this.resolvePromise;
			this.resolvePromise = null;
			resolve?.(this.chosen);
		}, 0);
	}
}

export interface PropertyField {
	name: string;
	/** Value from the rendered template, used to prefill the input and keep the property's type. */
	templateValue: unknown;
	isList: boolean;
}

/**
 * One form for all of a template's properties. Resolves to the raw text (or "true"/"false" for
 * checkboxes) entered for each property, or null when cancelled.
 */
export class FiletypePropertiesModal extends Modal {
	private title: string;
	private fields: PropertyField[];
	private values: Record<string, string> = {};
	private submitted = false;
	private resolvePromise: ((values: Record<string, string> | null) => void) | null = null;

	constructor(app: App, title: string, fields: PropertyField[]) {
		super(app);
		this.title = title;
		this.fields = fields;
		for (const field of fields) {
			this.values[field.name] = propertyValueToInput(field.templateValue);
		}
	}

	static ask(app: App, title: string, fields: PropertyField[]): Promise<Record<string, string> | null> {
		const modal = new FiletypePropertiesModal(app, title, fields);
		return new Promise((resolve) => {
			modal.resolvePromise = resolve;
			modal.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("filetypes-prompt-modal", "filetypes-properties-modal");
		this.setTitle(`${this.title}: properties`);

		const submit = () => {
			this.submitted = true;
			this.close();
		};

		let firstInput: HTMLInputElement | null = null;
		for (const field of this.fields) {
			const setting = new Setting(contentEl).setName(field.name);
			if (typeof field.templateValue === "boolean") {
				setting.addToggle((toggle) =>
					toggle.setValue(this.values[field.name] === "true").onChange((val) => {
						this.values[field.name] = String(val);
					})
				);
				continue;
			}
			if (field.isList) setting.setDesc("Separate values with commas.");
			setting.addText((text) => {
				text
					.setPlaceholder(field.isList ? "value, value" : "Empty")
					.setValue(this.values[field.name] ?? "")
					.onChange((val) => {
						this.values[field.name] = val;
					});
				text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
					if (evt.key === "Enter" && !evt.isComposing) {
						evt.preventDefault();
						submit();
					}
				});
				firstInput ??= text.inputEl;
			});
		}

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) => btn.setButtonText("Create note").setCta().onClick(submit));

		window.requestAnimationFrame(() => {
			const input = firstInput;
			if (input?.isConnected) {
				input.focus();
				input.select();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
		const resolve = this.resolvePromise;
		this.resolvePromise = null;
		resolve?.(this.submitted ? this.values : null);
	}
}
