import {
	App,
	MarkdownView,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
} from "obsidian";
import {
	CaptureInsertPosition,
	ChoiceType,
	extractNamedPrompts,
	FiletypeChoice,
	FormatContext,
	formatFiletypeString,
	insertCapturedText,
	requiresPrimaryInput,
	resolveTargetFilePath,
	sanitizeVaultPath,
} from "./formatter";
import {
	FiletypeChoicePickerModal,
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

		const ctx = await this.collectFormatContext(item.label, rawTemplate);
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
				"Enter value"
			);
			if (input === null) return null;
			ctx.value = input;
			ctx.title = input;
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
			combinedTargetPattern,
			choice.captureFormat,
			choice.targetHeading
		);
		if (!ctx) return;

		const formattedText = formatFiletypeString(choice.captureFormat, ctx, false);
		const formattedHeading = formatFiletypeString(choice.targetHeading, ctx, false);

		let targetFile: TFile | null = null;
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

	private async runTemplateChoice(choice: FiletypeChoice): Promise<void> {
		let rawTemplateContent = "";
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

		const ctx = await this.collectFormatContext(
			choice.name,
			combinedTargetPattern,
			rawTemplateContent
		);
		if (!ctx) return;

		const safeRenderedPath = formatFiletypeString(combinedTargetPattern, ctx, true);
		if (!safeRenderedPath) {
			new Notice("Target file path cannot be empty.");
			return;
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
			return;
		}
		if (!ctx.title) {
			ctx.title = baseName;
		}

		const renderedContent = formatFiletypeString(rawTemplateContent, ctx, false);

		let noteFile = this.app.vault.getFileByPath(normalizedNewPath);
		if (!noteFile) {
			await this.ensureParentFolders(normalizedNewPath);
			noteFile = await this.app.vault.create(normalizedNewPath, renderedContent);
			new Notice(`Created ${normalizedNewPath}.`);
		} else {
			new Notice(`Note ${normalizedNewPath} already exists.`);
		}

		if (choice.openNewNote && noteFile) {
			await this.app.workspace.getLeaf(false).openFile(noteFile);
		}
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
			this.settings.choices = JSON.parse(
				JSON.stringify(DEFAULT_SETTINGS.choices)
			);
		}
		if (
			!this.settings.templateFolderMap ||
			typeof this.settings.templateFolderMap !== "object"
		) {
			this.settings.templateFolderMap = {};
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

export class FiletypesSettingTab extends PluginSettingTab {
	private plugin: FiletypesPlugin;

	constructor(app: App, plugin: FiletypesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private addFolderPickerSetting(
		containerEl: HTMLElement,
		label: string,
		description: string,
		currentFolder: string,
		vaultFolders: string[],
		onChange: (newFolder: string) => Promise<void>
	): void {
		let textInputRef: { setValue: (v: string) => void } | null = null;

		new Setting(containerEl)
			.setName(label)
			.setDesc(description)
			.addDropdown((drop) => {
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
					const clean = sanitizeVaultPath(val);
					textInputRef?.setValue(clean);
					await onChange(clean);
				});
			})
			.addText((text) => {
				textInputRef = text;
				text
					.setPlaceholder("Folder path")
					.setValue(currentFolder)
					.onChange(async (val) => {
						await onChange(sanitizeVaultPath(val));
					});
			});
	}

	private addTemplateFilePickerSetting(
		containerEl: HTMLElement,
		label: string,
		description: string,
		currentPath: string,
		discoveredTemplates: TFile[],
		onChange: (newPath: string) => Promise<void>
	): void {
		let textInputRef: { setValue: (v: string) => void } | null = null;
		const templatePaths = discoveredTemplates.map((f) => f.path);

		new Setting(containerEl)
			.setName(label)
			.setDesc(description)
			.addDropdown((drop) => {
				drop.addOption("", "Select template");
				for (const tpl of discoveredTemplates) {
					drop.addOption(tpl.path, tpl.basename);
				}
				if (currentPath && !templatePaths.includes(currentPath)) {
					drop.addOption(currentPath, currentPath);
				}
				drop.setValue(currentPath);
				drop.onChange(async (val) => {
					const clean = sanitizeVaultPath(val);
					textInputRef?.setValue(clean);
					await onChange(clean);
				});
			})
			.addText((text) => {
				textInputRef = text;
				text
					.setPlaceholder("Templates/Note.md")
					.setValue(currentPath)
					.onChange(async (val) => {
						await onChange(sanitizeVaultPath(val));
					});
			});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("filetypes-settings-container");

		const vaultFolders = this.plugin.getVaultFolderPaths();
		const discoveredTemplates = this.plugin.getVaultTemplateFiles();

		// ── Defaults (Top section has no redundant heading per Obsidian guidelines) ────
		const defaultsCard = containerEl.createDiv({ cls: "filetypes-section-card" });

		this.addFolderPickerSetting(
			defaultsCard,
			"Templates folder",
			"Folder where your markdown templates are stored.",
			this.plugin.settings.templatesFolder,
			vaultFolders,
			async (newFolder) => {
				this.plugin.settings.templatesFolder = newFolder;
				await this.plugin.saveSettings();
			}
		);

		this.addFolderPickerSetting(
			defaultsCard,
			"Default destination folder",
			"Default folder where notes created from templates will be placed.",
			this.plugin.settings.defaultDestinationFolder,
			vaultFolders,
			async (newFolder) => {
				this.plugin.settings.defaultDestinationFolder = newFolder;
				await this.plugin.saveSettings();
			}
		);

		new Setting(defaultsCard)
			.setName("Default note filename")
			.setDesc("Default filename pattern for notes created from templates.")
			.addText((text) =>
				text
					.setPlaceholder("{{DATE}} - {{VALUE}}.md")
					.setValue(this.plugin.settings.defaultTemplateOutputPath)
					.onChange(async (val) => {
						this.plugin.settings.defaultTemplateOutputPath =
							val.trim() || "{{DATE}} - {{VALUE}}.md";
						await this.plugin.saveSettings();
					})
			);

		// ── Template Folder Mapping ───────────────────────────────────────────
		if (discoveredTemplates.length > 0) {
			new Setting(containerEl).setName("Template folders").setHeading();
			const mapCard = containerEl.createDiv({ cls: "filetypes-section-card" });

			for (const tplFile of discoveredTemplates) {
				const currentAssigned =
					this.plugin.settings.templateFolderMap[tplFile.path] ??
					this.plugin.settings.defaultDestinationFolder;

				this.addFolderPickerSetting(
					mapCard,
					tplFile.basename,
					`Destination folder for notes created with ${tplFile.path}.`,
					currentAssigned,
					vaultFolders,
					async (newFolder) => {
						if (!newFolder) {
							delete this.plugin.settings.templateFolderMap[tplFile.path];
						} else {
							this.plugin.settings.templateFolderMap[tplFile.path] = newFolder;
						}
						await this.plugin.saveSettings();
					}
				);
			}
		}

		// ── Filetypes ─────────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Filetypes")
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText("Add template")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.choices.push({
							id: `choice-${Date.now()}`,
							name: "New template",
							type: "template",
							registerCommand: true,
							folderPath: this.plugin.settings.defaultDestinationFolder,
							targetPath: "{{DATE}} - {{VALUE}}.md",
							captureFormat: "",
							insertPosition: "append",
							targetHeading: "",
							createTargetIfMissing: true,
							templatePath: discoveredTemplates[0]?.path ?? "Templates/Note.md",
							openNewNote: true,
						});
						await this.plugin.saveSettings();
						this.plugin.registerChoiceCommands();
						this.display();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Add capture").onClick(async () => {
					this.plugin.settings.choices.push({
						id: `choice-${Date.now()}`,
						name: "New capture",
						type: "capture",
						registerCommand: true,
						folderPath: this.plugin.settings.defaultDestinationFolder,
						targetPath: "Inbox.md",
						captureFormat: "- [ ] {{VALUE}} ({{DATE}})",
						insertPosition: "append",
						targetHeading: "",
						createTargetIfMissing: true,
						templatePath: "",
						openNewNote: false,
					});
					await this.plugin.saveSettings();
					this.plugin.registerChoiceCommands();
					this.display();
				})
			);

		this.plugin.settings.choices.forEach((choice, index) => {
			const card = containerEl.createDiv({ cls: "filetypes-choice-card" });

			new Setting(card)
				.setName("Name and type")
				.setDesc("Action name, type, and command palette availability.")
				.addText((text) =>
					text
						.setPlaceholder("Name")
						.setValue(choice.name)
						.onChange(async (val) => {
							choice.name = val.trim() || "Untitled";
							await this.plugin.saveSettings();
							this.plugin.registerChoiceCommands();
						})
				)
				.addDropdown((drop) =>
					drop
						.addOption("template", "Template")
						.addOption("capture", "Capture")
						.setValue(choice.type)
						.onChange(async (val) => {
							choice.type = val as ChoiceType;
							await this.plugin.saveSettings();
							this.display();
						})
				)
				.addToggle((toggle) =>
					toggle
						.setTooltip("Show in command palette")
						.setValue(choice.registerCommand)
						.onChange(async (val) => {
							choice.registerCommand = val;
							await this.plugin.saveSettings();
							this.plugin.registerChoiceCommands();
						})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("play")
						.setTooltip("Run action")
						.onClick(() => {
							void this.plugin.executeChoice(choice);
						})
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete action")
						.onClick(async () => {
							this.plugin.settings.choices.splice(index, 1);
							await this.plugin.saveSettings();
							this.plugin.registerChoiceCommands();
							this.display();
						})
				);

			this.addFolderPickerSetting(
				card,
				"Destination folder",
				"Folder where notes will be created or captured into.",
				choice.folderPath ?? "",
				vaultFolders,
				async (newFolder) => {
					choice.folderPath = newFolder;
					await this.plugin.saveSettings();
				}
			);

			if (choice.type === "template") {
				this.addTemplateFilePickerSetting(
					card,
					"Template file",
					"Markdown template to instantiate.",
					choice.templatePath,
					discoveredTemplates,
					async (newTplPath) => {
						choice.templatePath = newTplPath;
						await this.plugin.saveSettings();
					}
				);

				new Setting(card)
					.setName("Note filename and open")
					.setDesc(
						"Filename pattern for the new note and whether to open it."
					)
					.addText((text) =>
						text
							.setPlaceholder("{{DATE}} - {{VALUE}}.md")
							.setValue(choice.targetPath)
							.onChange(async (val) => {
								choice.targetPath = val;
								await this.plugin.saveSettings();
							})
					)
					.addToggle((toggle) =>
						toggle
							.setTooltip("Open note after creation")
							.setValue(choice.openNewNote)
							.onChange(async (val) => {
								choice.openNewNote = val;
								await this.plugin.saveSettings();
							})
					);
			} else {
				const placementSetting = new Setting(card)
					.setName("Target note and position")
					.setDesc(
						"Target note (leave empty for active note) and placement."
					)
					.addText((text) =>
						text
							.setPlaceholder("Active note")
							.setValue(choice.targetPath)
							.onChange(async (val) => {
								choice.targetPath = val;
								await this.plugin.saveSettings();
							})
					)
					.addDropdown((drop) =>
						drop
							.addOption("append", "Append")
							.addOption("prepend", "Prepend")
							.addOption("heading", "Heading")
							.setValue(choice.insertPosition)
							.onChange(async (val) => {
								choice.insertPosition = val as CaptureInsertPosition;
								await this.plugin.saveSettings();
								this.display();
							})
					);

				if (choice.insertPosition === "heading") {
					placementSetting.addText((text) =>
						text
							.setPlaceholder("## Heading")
							.setValue(choice.targetHeading)
							.onChange(async (val) => {
								choice.targetHeading = val;
								await this.plugin.saveSettings();
							})
					);
				}

				new Setting(card)
					.setName("Capture format and open")
					.setDesc(
						"Captured text pattern and whether to open the note."
					)
					.addText((text) =>
						text
							.setPlaceholder("- [ ] {{VALUE}}")
							.setValue(choice.captureFormat)
							.onChange(async (val) => {
								choice.captureFormat = val;
								await this.plugin.saveSettings();
							})
					)
					.addToggle((toggle) =>
						toggle
							.setTooltip("Open note after capture")
							.setValue(choice.openNewNote)
							.onChange(async (val) => {
								choice.openNewNote = val;
								await this.plugin.saveSettings();
							})
					);
			}
		});
	}
}
