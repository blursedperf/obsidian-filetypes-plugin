import {
	App,
	FuzzyMatch,
	FuzzySuggestModal,
	Modal,
	Setting,
	TFile,
} from "obsidian";
import { FiletypeChoice } from "./formatter";

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
		const badge = item.type === "capture" ? "[Capture]" : "[Template]";
		return `${item.name} ${badge}`;
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

		requestAnimationFrame(() => {
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
