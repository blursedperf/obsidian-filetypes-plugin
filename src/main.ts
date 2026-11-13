import {
	App,
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Menu,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	SettingDefinitionList,
	SettingDefinitionPage,
	SettingGroup,
	TFile,
	TFolder,
} from "obsidian";
import {
	CaptureInsertPosition,
	ChoiceType,
	extractInitialTitleFromSelection,
	extractNamedPrompts,
	FiletypeChoice,
	FormatContext,
	formatFiletypeString,
	insertCapturedText,
	mergeSelectionIntoNoteContent,
	requiresPrimaryInput,
	resolveTargetFilePath,
	sanitizeVaultPath,
} from "./formatter";
import {
	FiletypeChoicePickerModal,
	FiletypeConvertPickerModal,
	FiletypeInputModal,
	FiletypeTemplatePickerModal,
	TemplatePickerItem,
} from "./modals";

export interface FiletypesSettings {
	templatesFolder: string;
	defaultDestinationFolder: string;
	defaultTemplateOutputPath: string;
	templateFolderMap: Record<string, string>;
	choices: FiletypeChoice[];
	replaceSelectionWithLink: boolean;
	openCreatedNoteFromSelection: boolean;
}

export const DEFAULT_SETTINGS: FiletypesSettings = {
	templatesFolder: "Templates",
	defaultDestinationFolder: "",
	defaultTemplateOutputPath: "{{DATE}} - {{VALUE}}.md",
	templateFolderMap: {},
	choices: [
		{
			id: "default-template-note",
			name: "Meeting note",
			type: "template",
			registerCommand: true,
			folderPath: "Meetings",
			targetPath: "{{DATE}} - {{VALUE}}.md",
			captureFormat: "",
			insertPosition: "append",
			targetHeading: "",
			createTargetIfMissing: true,
			templatePath: "Templates/Meeting.md",
			openNewNote: true,
		},
		{
			id: "default-quick-capture",
			name: "Capture task to inbox",
			type: "capture",
			registerCommand: true,
			folderPath: "",
			targetPath: "Inbox.md",
			captureFormat: "- [ ] {{VALUE}} ({{DATE}} {{TIME}})",
			insertPosition: "heading",
			targetHeading: "## Tasks",
			createTargetIfMissing: true,
			templatePath: "",
			openNewNote: false,
		},
	],
	replaceSelectionWithLink: true,
	openCreatedNoteFromSelection: true,
};

export default class FiletypesPlugin extends Plugin {
	settings: FiletypesSettings = DEFAULT_SETTINGS;
	private registeredChoiceCommandIds = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "select-from-all-templates",
			name: "Select from all templates",
			callback: () => {
				this.openAllTemplatesModal();
			},
		});

		this.addCommand({
			id: "convert-selection-to-filetype",
			name: "Convert selection to filetype note",
			editorCallback: (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const mdView =
					view instanceof MarkdownView
						? view
						: this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!mdView) {
					new Notice("No active markdown editor.");
					return;
				}
				this.openConvertSelectionModal(editor, mdView);
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				const selection = editor.getSelection();
				if (selection && selection.trim() && view instanceof MarkdownView) {
					menu.addItem((item) => {
						item
							.setTitle("Convert selection to filetype note")
							.setIcon("file-plus")
							.onClick(() => {
								this.openConvertSelectionModal(editor, view);
							});
					});
				}
			})
		);

		this.addCommand({
			id: "run-all-actions",
			name: "Run action",
			callback: () => {
				new FiletypeChoicePickerModal(
					this.app,
					this.settings.choices,
					(choice) => {
						void this.executeChoice(choice);
					}
				).open();
			},
		});

		this.registerChoiceCommands();
		this.addSettingTab(new FiletypesSettingTab(this.app, this));
	}

	onunload(): void {
		for (const cmdId of this.registeredChoiceCommandIds) {
			this.removeCommand(cmdId);
		}
		this.registeredChoiceCommandIds.clear();
	}

	/**
	 * Returns a sorted list of all folder paths in the vault (with "" representing the vault root).
	 */
	getVaultFolderPaths(): string[] {
		const folders: string[] = [""];
		for (const abstractFile of this.app.vault.getAllLoadedFiles()) {
			if (abstractFile instanceof TFolder && abstractFile.path !== "/") {
				folders.push(abstractFile.path);
			}
		}
		folders.sort((a, b) => a.localeCompare(b));
		return folders;
	}

	/**
	 * Returns all markdown files inside `settings.templatesFolder`.
	 */
	getVaultTemplateFiles(): TFile[] {
		const safeFolder = sanitizeVaultPath(this.settings.templatesFolder);
		if (!safeFolder) return [];

		const lowerPrefix = `${normalizePath(safeFolder).toLowerCase()}/`;
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.toLowerCase().startsWith(lowerPrefix));
	}

	/**
	 * Collects all configured Template Filetypes plus all markdown files inside
	 * `settings.templatesFolder` and opens the unified Template Picker modal.
	 */
	openAllTemplatesModal(): void {
		const items = this.collectAllTemplateItems();
		if (items.length === 0) {
			new Notice(
				`No templates found. Add a template action or place markdown files in "${this.settings.templatesFolder}/".`
			);
			return;
		}

		new FiletypeTemplatePickerModal(
			this.app,
			items,
			(item, evt) => {
				const insertIntoActive = evt.shiftKey;
				void this.handleSelectedTemplateItem(item, insertIntoActive);
			}
		).open();
	}

	/**
	 * Opens the modal to convert the selected editor text into a note of the chosen filetype.
	 */
	openConvertSelectionModal(editor: Editor, view: MarkdownView): void {
		const rawSelection = editor.getSelection();
		if (!rawSelection || !rawSelection.trim()) {
			new Notice(
				"Please select text in the editor to convert to a filetype note."
			);
			return;
		}

		const items = this.collectAllTemplateItems();
		if (items.length === 0) {
			new Notice(
				`No filetypes or templates found. Add a template action or place markdown files in "${this.settings.templatesFolder}/".`
			);
			return;
		}

		new FiletypeConvertPickerModal(this.app, items, (item) => {
			void this.convertSelectionToFiletype(editor, view, rawSelection, item);
		}).open();
	}

	private async convertSelectionToFiletype(
		editor: Editor,
		view: MarkdownView,
		selection: string,
		item: TemplatePickerItem
	): Promise<void> {
		const choice: FiletypeChoice = item.choice ?? {
			id: `vault-tpl-${item.templateFile!.path}`,
			name: item.templateFile!.basename,
			type: "template",
			registerCommand: false,
			folderPath:
				this.settings.templateFolderMap[item.templateFile!.path] ??
				this.settings.defaultDestinationFolder,
			targetPath:
				this.settings.defaultTemplateOutputPath.trim() ||
				"{{DATE}} - {{VALUE}}.md",
			captureFormat: "",
			insertPosition: "append",
			targetHeading: "",
			createTargetIfMissing: true,
			templatePath: item.templateFile!.path,
			openNewNote: true,
		};

		const result = await this.runTemplateChoice(choice, selection, {
			suppressOpen: true,
		});

		if (!result) {
			return;
		}

		if (this.settings.replaceSelectionWithLink) {
			const activeFilePath = view.file ? view.file.path : "";
			const alias =
				result.title &&
				!result.title.includes("\n") &&
				result.title !== result.file.basename
					? result.title
					: undefined;
			const link = this.app.fileManager.generateMarkdownLink(
				result.file,
				activeFilePath,
				"",
				alias
			);
			editor.replaceSelection(link);
		}

		if (choice.openNewNote && this.settings.openCreatedNoteFromSelection) {
			await this.app.workspace.getLeaf(true).openFile(result.file);
		}
	}

	collectAllTemplateItems(): TemplatePickerItem[] {
		const items: TemplatePickerItem[] = [];
		const seenTemplatePaths = new Set<string>();

		// 1. Add all configured Template choices
		for (const choice of this.settings.choices) {
			if (choice.type !== "template") continue;

			const safeTpl = sanitizeVaultPath(choice.templatePath);
			const normalizedTpl = safeTpl
				? normalizePath(
						safeTpl.endsWith(".md") ? safeTpl : `${safeTpl}.md`
					)
				: "";

			if (normalizedTpl) {
				seenTemplatePaths.add(normalizedTpl.toLowerCase());
			}

			const fullTarget = resolveTargetFilePath(
				choice.folderPath,
				choice.targetPath
			);

			items.push({
				id: `choice:${choice.id}`,
				label: choice.name,
				subtext: normalizedTpl
					? `${normalizedTpl} → ${fullTarget}`
					: `→ ${fullTarget}`,
				choice,
			});
		}

		// 2. Discover any markdown files in the configured Templates folder
		for (const file of this.getVaultTemplateFiles()) {
			const lowerPath = file.path.toLowerCase();
			if (seenTemplatePaths.has(lowerPath)) continue;

			const assignedFolder =
				this.settings.templateFolderMap[file.path] ??
				this.settings.defaultDestinationFolder;
			const targetPreview = resolveTargetFilePath(
				assignedFolder,
				this.settings.defaultTemplateOutputPath || "{{DATE}} - {{VALUE}}.md"
			);

			items.push({
				id: `file:${file.path}`,
				label: file.basename,
				subtext: `${file.path} → ${targetPreview}`,
				templateFile: file,
			});
		}

		return items;
	}

	private async handleSelectedTemplateItem(
		item: TemplatePickerItem,
		insertIntoActiveEditor: boolean
	): Promise<void> {
		if (insertIntoActiveEditor) {
			await this.insertTemplateAtCursor(item);
			return;
		}

		if (item.choice) {
			await this.runTemplateChoice(item.choice);
			return;
		}

		if (item.templateFile) {
			const specificFolder =
				this.settings.templateFolderMap[item.templateFile.path] ??
				this.settings.defaultDestinationFolder;

			const adHocChoice: FiletypeChoice = {
				id: `vault-tpl-${item.templateFile.path}`,
				name: item.templateFile.basename,
				type: "template",
				registerCommand: false,
				folderPath: specificFolder,
				targetPath:
					this.settings.defaultTemplateOutputPath.trim() ||
					"{{DATE}} - {{VALUE}}.md",
				captureFormat: "",
				insertPosition: "append",
				targetHeading: "",
				createTargetIfMissing: true,
				templatePath: item.templateFile.path,
				openNewNote: true,
			};
			await this.runTemplateChoice(adHocChoice);
		}
	}

	private async insertTemplateAtCursor(item: TemplatePickerItem): Promise<void> {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			new Notice("No active markdown editor to insert template into.");
			return;
		}

		const tplPath = sanitizeVaultPath(
			item.templateFile?.path ?? item.choice?.templatePath ?? ""
		);
		let rawTemplate = "";
		if (tplPath) {
			const normalized = normalizePath(
				tplPath.endsWith(".md") ? tplPath : `${tplPath}.md`
			);
			const file = this.app.vault.getFileByPath(normalized);
			if (file) {
				rawTemplate = await this.app.vault.cachedRead(file);
			}
		}

		if (!rawTemplate) {
			rawTemplate = "# {{TITLE}}\n\n";
		}

		const ctx = await this.collectFormatContext(
			item.label,
			undefined,
			rawTemplate
		);
		if (!ctx) return;

		if (!ctx.title && activeView.file) {
			ctx.title = activeView.file.basename;
		}

		const rendered = formatFiletypeString(rawTemplate, ctx, false);
		activeView.editor.replaceSelection(rendered);
		new Notice(`Inserted template "${item.label}".`);
	}

	registerChoiceCommands(): void {
		for (const cmdId of this.registeredChoiceCommandIds) {
			this.removeCommand(cmdId);
		}
		this.registeredChoiceCommandIds.clear();

		for (const choice of this.settings.choices) {
			if (!choice.registerCommand) continue;
			const cmdId = `choice-${choice.id}`;
			this.addCommand({
				id: cmdId,
				name: `Run: ${choice.name}`,
				callback: () => {
					void this.executeChoice(choice);
				},
			});
			this.registeredChoiceCommandIds.add(cmdId);
		}
	}

	async executeChoice(choice: FiletypeChoice): Promise<void> {
		try {
			if (choice.type === "capture") {
				await this.runCaptureChoice(choice);
			} else {
				await this.runTemplateChoice(choice);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Error: ${message}`);
		}
	}

	private async collectFormatContext(
		choiceName: string,
		initialValue?: string,
		...templates: string[]
	): Promise<FormatContext | null> {
		const ctx: FormatContext = {
			now: new Date(),
			namedValues: {},
		};

		if (requiresPrimaryInput(...templates)) {
			const input = await FiletypeInputModal.prompt(
				this.app,
				choiceName,
				"Enter value",
				initialValue ?? ""
			);
			if (input === null) return null;
			ctx.value = input;
			ctx.title = input;
		} else if (initialValue) {
			ctx.value = initialValue;
			ctx.title = initialValue;
		}

		const namedPrompts = extractNamedPrompts(...templates);
		for (const label of namedPrompts) {
			const val = await FiletypeInputModal.prompt(
				this.app,
				`${choiceName}: ${label}`,
				`Enter ${label}`
			);
			if (val === null) return null;
			ctx.namedValues![label] = val;
		}

		return ctx;
	}

	private async runCaptureChoice(choice: FiletypeChoice): Promise<void> {
		const combinedTargetPattern = resolveTargetFilePath(
			choice.folderPath,
			choice.targetPath
		);

		const ctx = await this.collectFormatContext(
			choice.name,
			undefined,
			combinedTargetPattern,
			choice.captureFormat,
			choice.targetHeading
		);
		if (!ctx) return;

		const formattedText = formatFiletypeString(choice.captureFormat, ctx, false);
		const formattedHeading = formatFiletypeString(choice.targetHeading, ctx, false);

		let targetFile: TFile | null;
		const safeTargetPath = formatFiletypeString(combinedTargetPattern, ctx, true);

		if (!safeTargetPath) {
			targetFile = this.app.workspace.getActiveFile();
			if (!targetFile) {
				new Notice("No active file to capture into.");
				return;
			}
		} else {
			const normalizedTarget = normalizePath(
				safeTargetPath.endsWith(".md") ? safeTargetPath : `${safeTargetPath}.md`
			);
			const existing = this.app.vault.getFileByPath(normalizedTarget);

			if (existing) {
				targetFile = existing;
			} else if (choice.createTargetIfMissing) {
				await this.ensureParentFolders(normalizedTarget);
				targetFile = await this.app.vault.create(normalizedTarget, "");
			} else {
				new Notice(`Target file "${normalizedTarget}" does not exist.`);
				return;
			}
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView && activeView.file?.path === targetFile.path) {
			const currentContent = activeView.editor.getValue();
			const updated = insertCapturedText(
				currentContent,
				formattedText,
				choice.insertPosition,
				formattedHeading
			);
			activeView.editor.setValue(updated);
		} else {
			await this.app.vault.process(targetFile, (currentContent) =>
				insertCapturedText(
					currentContent,
					formattedText,
					choice.insertPosition,
					formattedHeading
				)
			);
		}

		if (choice.openNewNote) {
			await this.app.workspace.getLeaf(false).openFile(targetFile);
		}

		new Notice(`Captured to ${targetFile.path}.`);
	}

	async runTemplateChoice(
		choice: FiletypeChoice,
		initialSelection?: string,
		options: {
			suppressOpen?: boolean;
		} = {}
	): Promise<{ file: TFile; title: string } | null> {
		let rawTemplateContent: string;
		const safeTemplatePath = sanitizeVaultPath(choice.templatePath);

		if (safeTemplatePath) {
			const normalizedTplPath = normalizePath(
				safeTemplatePath.endsWith(".md")
					? safeTemplatePath
					: `${safeTemplatePath}.md`
			);
			const tplFile = this.app.vault.getFileByPath(normalizedTplPath);
			if (tplFile) {
				rawTemplateContent = await this.app.vault.cachedRead(tplFile);
			} else {
				new Notice(
					`Template "${normalizedTplPath}" not found; creating note with default heading.`
				);
				rawTemplateContent = "# {{TITLE}}\n\n";
			}
		} else {
			rawTemplateContent = "# {{TITLE}}\n\n";
		}

		const combinedTargetPattern = resolveTargetFilePath(
			choice.folderPath,
			choice.targetPath
		);

		const initialTitle = initialSelection
			? extractInitialTitleFromSelection(initialSelection)
			: undefined;

		const ctx = await this.collectFormatContext(
			choice.name,
			initialTitle,
			combinedTargetPattern,
			rawTemplateContent
		);
		if (!ctx) return null;

		if (initialSelection) {
			ctx.selection = initialSelection;
		}

		const safeRenderedPath = formatFiletypeString(combinedTargetPattern, ctx, true);
		if (!safeRenderedPath) {
			new Notice("Target file path cannot be empty.");
			return null;
		}

		const normalizedNewPath = normalizePath(
			safeRenderedPath.endsWith(".md")
				? safeRenderedPath
				: `${safeRenderedPath}.md`
		);

		const baseName =
			normalizedNewPath.split("/").pop()?.replace(/\.md$/i, "").trim() ?? "";
		if (!baseName) {
			new Notice("Invalid or empty note filename.");
			return null;
		}
		if (!ctx.title) {
			ctx.title = baseName;
		}

		let renderedContent = formatFiletypeString(rawTemplateContent, ctx, false);
		if (initialSelection) {
			renderedContent = mergeSelectionIntoNoteContent(
				rawTemplateContent,
				renderedContent,
				initialSelection,
				ctx.title
			);
		}

		let noteFile = this.app.vault.getFileByPath(normalizedNewPath);
		if (!noteFile) {
			await this.ensureParentFolders(normalizedNewPath);
			noteFile = await this.app.vault.create(normalizedNewPath, renderedContent);
			new Notice(`Created ${normalizedNewPath}.`);
		} else {
			new Notice(`Note ${normalizedNewPath} already exists.`);
		}

		if (!options.suppressOpen && choice.openNewNote && noteFile) {
			await this.app.workspace.getLeaf(false).openFile(noteFile);
		}

		return noteFile ? { file: noteFile, title: ctx.title ?? baseName } : null;
	}

	private async ensureParentFolders(filePath: string): Promise<void> {
		const safePath = sanitizeVaultPath(filePath);
		const parts = safePath.split("/");
		parts.pop();
		if (parts.length === 0) return;

		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existingFolder = this.app.vault.getFolderByPath(current);
			if (!existingFolder) {
				const existingFile = this.app.vault.getFileByPath(current);
				if (existingFile) {
					throw new Error(
						`Cannot create folder "${current}" because a file with that name already exists.`
					);
				}
				await this.app.vault.createFolder(current);
			}
		}
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<FiletypesSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		if (!this.settings.choices || !Array.isArray(this.settings.choices)) {
			this.settings.choices = structuredClone(DEFAULT_SETTINGS.choices);
		}
		if (
			!this.settings.templateFolderMap ||
			typeof this.settings.templateFolderMap !== "object"
		) {
			this.settings.templateFolderMap = {};
		}
		if (this.settings.replaceSelectionWithLink === undefined) {
			this.settings.replaceSelectionWithLink = true;
		}
		if (this.settings.openCreatedNoteFromSelection === undefined) {
			this.settings.openCreatedNoteFromSelection = true;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** Workflow pages carry an explicit `id` (supported at runtime, not yet in the typings) so names can repeat. */
type ChoicePageDefinition = SettingDefinitionPage & { id: string };

const DEFAULT_OUTPUT_PATH = "{{DATE}} - {{VALUE}}.md";

export class FiletypesSettingTab extends PluginSettingTab {
	private plugin: FiletypesPlugin;

	constructor(app: App, plugin: FiletypesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Rebuilds the tab after a structural change, on both the declarative (1.13+) and legacy paths. */
	private refresh(): void {
		if (requireApiVersion("1.13.0")) {
			this.update();
		} else {
			this.renderLegacy();
		}
	}

	private async saveChoices(): Promise<void> {
		await this.plugin.saveSettings();
		this.plugin.registerChoiceCommands();
	}

	// ── Settings definitions (Obsidian 1.13+, also drives the legacy fallback) ──

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const vaultFolders = this.plugin.getVaultFolderPaths();
		const templates = this.plugin.getVaultTemplateFiles();

		const items: SettingDefinitionItem[] = [
			{
				type: "group",
				heading: "Templates",
				items: [
					{
						name: "Templates folder",
						desc: "Folder where your markdown templates are stored.",
						render: (setting) =>
							this.addFolderDropdown(setting, settings.templatesFolder, vaultFolders, async (folder) => {
								settings.templatesFolder = folder;
								await this.plugin.saveSettings();
								this.refresh();
							}),
					},
					{
						name: "Default destination folder",
						desc: "Default folder where notes created from templates will be placed.",
						render: (setting) =>
							this.addFolderDropdown(setting, settings.defaultDestinationFolder, vaultFolders, async (folder) => {
								settings.defaultDestinationFolder = folder;
								await this.plugin.saveSettings();
							}),
					},
					{
						name: "Default note filename",
						desc: "Default filename pattern for notes created from templates.",
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder(DEFAULT_OUTPUT_PATH)
									.setValue(settings.defaultTemplateOutputPath)
									.onChange(async (val) => {
										settings.defaultTemplateOutputPath = val.trim() || DEFAULT_OUTPUT_PATH;
										await this.plugin.saveSettings();
									})
							);
						},
					},
				],
			},
		];

		if (templates.length > 0) {
			items.push({
				type: "group",
				heading: "Template folders",
				items: templates.map((tpl) => ({
					name: tpl.basename,
					desc: `Destination folder for notes created with ${tpl.path}.`,
					aliases: [tpl.path],
					render: (setting: Setting) =>
						this.addFolderDropdown(
							setting,
							settings.templateFolderMap[tpl.path] ?? settings.defaultDestinationFolder,
							vaultFolders,
							async (folder) => {
								if (folder) {
									settings.templateFolderMap[tpl.path] = folder;
								} else {
									delete settings.templateFolderMap[tpl.path];
								}
								await this.plugin.saveSettings();
							}
						),
				})),
			});
		}

		items.push(
			{
				type: "group",
				heading: "Convert selection",
				items: [
					{
						name: "Replace selection with link",
						desc: "When converting selected text, replace the selection with a link to the new note.",
						render: (setting) =>
							this.addToggle(setting, settings.replaceSelectionWithLink, async (val) => {
								settings.replaceSelectionWithLink = val;
								await this.plugin.saveSettings();
							}),
					},
					{
						name: "Open converted note in new tab",
						desc: "When converting selected text, open the newly created note in a new tab.",
						render: (setting) =>
							this.addToggle(setting, settings.openCreatedNoteFromSelection, async (val) => {
								settings.openCreatedNoteFromSelection = val;
								await this.plugin.saveSettings();
							}),
					},
				],
			},
			{
				type: "list",
				heading: "Workflows",
				emptyState: "No workflows yet. Add a template or capture to get started.",
				addItem: {
					name: "Add workflow",
					action: (el) => this.showAddWorkflowMenu(el, templates),
				},
				onDelete: (index) => {
					settings.choices.splice(index, 1);
					void this.saveChoices().then(() => this.refresh());
				},
				onReorder: (from, to) => {
					const [moved] = settings.choices.splice(from, 1);
					if (!moved) return;
					settings.choices.splice(to, 0, moved);
					void this.saveChoices().then(() => this.refresh());
				},
				items: settings.choices.map((choice) =>
					this.workflowPage(choice, vaultFolders, templates)
				),
			}
		);

		return items;
	}

	private workflowPage(
		choice: FiletypeChoice,
		vaultFolders: string[],
		templates: TFile[]
	): ChoicePageDefinition {
		const isTemplate = () => choice.type === "template";
		const isCapture = () => choice.type === "capture";
		const save = () => this.plugin.saveSettings();

		const items: SettingDefinition[] = [
			{
				name: "Action name",
				desc: "Display name for this workflow action.",
				searchable: false,
				render: (setting) => {
					setting.addText((text) => {
						text
							.setPlaceholder("e.g. Meeting note")
							.setValue(choice.name)
							.onChange(async (val) => {
								choice.name = val.trim() || "Untitled";
								await this.saveChoices();
							});
						// Refresh the list entry's title once the edit is committed, not on every keystroke.
						text.inputEl.addEventListener("change", () => {
							if (requireApiVersion("1.13.0")) this.update();
						});
					});
				},
			},
			{
				name: "Run action",
				desc: "Run this workflow now.",
				searchable: false,
				render: (setting) => {
					setting.addButton((btn) =>
						btn.setButtonText("Run").onClick(() => {
							void this.plugin.executeChoice(choice);
						})
					);
				},
			},
			{
				name: "Action type",
				desc: "Choose whether this action creates a note from a template or captures text.",
				searchable: false,
				render: (setting) => {
					setting.addDropdown((drop) =>
						drop
							.addOption("template", "Template")
							.addOption("capture", "Capture")
							.setValue(choice.type)
							.onChange(async (val) => {
								choice.type = val as ChoiceType;
								await save();
								this.refresh();
							})
					);
				},
			},
			{
				name: "Show in command palette",
				desc: "Register this action as a command in the command palette.",
				searchable: false,
				render: (setting) =>
					this.addToggle(setting, choice.registerCommand, async (val) => {
						choice.registerCommand = val;
						await this.saveChoices();
					}),
			},
			{
				name: "Destination folder",
				desc: "Folder where notes will be created or captured into.",
				searchable: false,
				render: (setting) =>
					this.addFolderDropdown(setting, choice.folderPath ?? "", vaultFolders, async (folder) => {
						choice.folderPath = folder;
						await save();
					}),
			},
			// ── Template-only ──
			{
				name: "Template file",
				desc: "Markdown template to instantiate.",
				searchable: false,
				visible: isTemplate,
				render: (setting) =>
					this.addTemplateDropdown(setting, choice.templatePath, templates, async (path) => {
						choice.templatePath = path;
						await save();
					}),
			},
			{
				name: "Note filename",
				desc: "Filename pattern for the new note (e.g. {{DATE}} - {{VALUE}}.md).",
				searchable: false,
				visible: isTemplate,
				render: (setting) =>
					this.addTextInput(setting, DEFAULT_OUTPUT_PATH, choice.targetPath, async (val) => {
						choice.targetPath = val;
						await save();
					}),
			},
			{
				name: "Open note after creation",
				desc: "Open the new note in an editor tab after creation.",
				searchable: false,
				visible: isTemplate,
				render: (setting) =>
					this.addToggle(setting, choice.openNewNote, async (val) => {
						choice.openNewNote = val;
						await save();
					}),
			},
			// ── Capture-only ──
			{
				name: "Target note",
				desc: "Target note to capture into (leave empty to capture into the active note).",
				searchable: false,
				visible: isCapture,
				render: (setting) =>
					this.addTextInput(setting, "Active note", choice.targetPath, async (val) => {
						choice.targetPath = val;
						await save();
					}),
			},
			{
				name: "Insert position",
				desc: "Where to insert captured text in the target note.",
				searchable: false,
				visible: isCapture,
				render: (setting) => {
					setting.addDropdown((drop) =>
						drop
							.addOption("append", "Append")
							.addOption("prepend", "Prepend")
							.addOption("heading", "Under heading")
							.setValue(choice.insertPosition)
							.onChange(async (val) => {
								choice.insertPosition = val as CaptureInsertPosition;
								await save();
								this.refresh();
							})
					);
				},
			},
			{
				name: "Target heading",
				desc: "Heading under which captured text will be inserted.",
				searchable: false,
				visible: () => isCapture() && choice.insertPosition === "heading",
				render: (setting) =>
					this.addTextInput(setting, "## Heading", choice.targetHeading, async (val) => {
						choice.targetHeading = val;
						await save();
					}),
			},
			{
				name: "Capture format",
				desc: "Format template for the captured text (e.g. - [ ] {{VALUE}}).",
				searchable: false,
				visible: isCapture,
				render: (setting) =>
					this.addTextInput(setting, "- [ ] {{VALUE}}", choice.captureFormat, async (val) => {
						choice.captureFormat = val;
						await save();
					}),
			},
			{
				name: "Open note after capture",
				desc: "Open the target note in an editor tab after capture.",
				searchable: false,
				visible: isCapture,
				render: (setting) =>
					this.addToggle(setting, choice.openNewNote, async (val) => {
						choice.openNewNote = val;
						await save();
					}),
			},
		];

		return {
			type: "page",
			id: choice.id,
			name: choice.name,
			desc: choice.type === "template" ? "Template" : "Capture",
			items,
		};
	}

	private showAddWorkflowMenu(anchor: HTMLElement, templates: TFile[]): void {
		const settings = this.plugin.settings;
		const add = async (choice: FiletypeChoice) => {
			settings.choices.push(choice);
			await this.saveChoices();
			this.refresh();
		};

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Template")
				.setIcon("file-plus")
				.onClick(() =>
					void add({
						id: `choice-${Date.now()}`,
						name: "New template",
						type: "template",
						registerCommand: true,
						folderPath: settings.defaultDestinationFolder,
						targetPath: DEFAULT_OUTPUT_PATH,
						captureFormat: "",
						insertPosition: "append",
						targetHeading: "",
						createTargetIfMissing: true,
						templatePath: templates[0]?.path ?? "Templates/Note.md",
						openNewNote: true,
					})
				)
		);
		menu.addItem((item) =>
			item
				.setTitle("Capture")
				.setIcon("inbox")
				.onClick(() =>
					void add({
						id: `choice-${Date.now()}`,
						name: "New capture",
						type: "capture",
						registerCommand: true,
						folderPath: settings.defaultDestinationFolder,
						targetPath: "Inbox.md",
						captureFormat: "- [ ] {{VALUE}} ({{DATE}})",
						insertPosition: "append",
						targetHeading: "",
						createTargetIfMissing: true,
						templatePath: "",
						openNewNote: false,
					})
				)
		);
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom }, anchor.doc);
	}

	// ── Control helpers ──────────────────────────────────────────────────────

	private addToggle(setting: Setting, value: boolean, onChange: (val: boolean) => Promise<void>): void {
		setting.addToggle((toggle) => toggle.setValue(value).onChange(onChange));
	}

	private addTextInput(
		setting: Setting,
		placeholder: string,
		value: string,
		onChange: (val: string) => Promise<void>
	): void {
		setting.addText((text) => text.setPlaceholder(placeholder).setValue(value).onChange(onChange));
	}

	private addFolderDropdown(
		setting: Setting,
		currentFolder: string,
		vaultFolders: string[],
		onChange: (newFolder: string) => Promise<void>
	): void {
		setting.addDropdown((drop) => {
			drop.addOption("", "Vault root (/)");
			for (const folder of vaultFolders) {
				if (!folder) continue;
				drop.addOption(folder, folder);
			}
			if (currentFolder && !vaultFolders.includes(currentFolder)) {
				drop.addOption(currentFolder, currentFolder);
			}
			drop.setValue(currentFolder);
			drop.onChange(async (val) => {
				await onChange(sanitizeVaultPath(val));
			});
		});
	}

	private addTemplateDropdown(
		setting: Setting,
		currentPath: string,
		templates: TFile[],
		onChange: (newPath: string) => Promise<void>
	): void {
		const templatePaths = templates.map((f) => f.path);
		setting.addDropdown((drop) => {
			drop.addOption("", "Select template");
			for (const path of templatePaths) {
				drop.addOption(path, path);
			}
			if (currentPath && !templatePaths.includes(currentPath)) {
				drop.addOption(currentPath, currentPath);
			}
			drop.setValue(currentPath);
			drop.onChange(async (val) => {
				await onChange(sanitizeVaultPath(val));
			});
		});
	}

	// ── Legacy fallback (Obsidian < 1.13) ────────────────────────────────────
	// Obsidian 1.13+ renders getSettingDefinitions() itself and never calls this.
	// Older versions call display(), so render the same definitions imperatively.

	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("filetypes-settings-container");
		this.renderLegacyItems(containerEl, this.getSettingDefinitions());
	}

	private renderLegacyItems(containerEl: HTMLElement, items: SettingDefinitionItem[]): void {
		for (const item of items) {
			if (!("type" in item)) {
				this.renderLegacyDefinition(containerEl, item);
				continue;
			}
			if (item.type === "page") continue; // Pages only appear inside the workflow list.

			const heading = new Setting(containerEl).setName(item.heading ?? "").setHeading();
			if (item.type !== "list") {
				this.renderLegacyItems(containerEl, item.items ?? []);
				continue;
			}

			const list = item as SettingDefinitionList;
			const addItem = list.addItem;
			if (addItem) {
				heading.addButton((btn) =>
					btn
						.setButtonText(addItem.name)
						.setCta()
						.onClick(() => addItem.action(btn.buttonEl))
				);
			}
			const entries = list.items ?? [];
			if (entries.length === 0 && typeof list.emptyState === "string") {
				containerEl.createDiv({ cls: "filetypes-empty-state", text: list.emptyState });
			}
			entries.forEach((entry, index) => {
				if (!("type" in entry) || entry.type !== "page") return;
				const card = containerEl.createDiv({ cls: "setting-items filetypes-choice-card" });
				const header = new Setting(card).setName(entry.name).setHeading();
				if (typeof entry.desc === "string") header.setDesc(entry.desc);
				if (list.onDelete) {
					const onDelete = list.onDelete;
					header.addExtraButton((btn) =>
						btn
							.setIcon("trash")
							.setTooltip("Delete")
							.onClick(() => onDelete(index))
					);
				}
				this.renderLegacyItems(card, entry.items ?? []);
			});
		}
	}

	private renderLegacyDefinition(containerEl: HTMLElement, def: SettingDefinition): void {
		const visible = typeof def.visible === "function" ? def.visible() : def.visible ?? true;
		if (!visible) return;
		const setting = new Setting(containerEl).setName(def.name);
		if (def.desc) setting.setDesc(def.desc);
		if (def.render) def.render(setting, undefined as unknown as SettingGroup);
	}
}
