export type ChoiceType = "capture" | "template";
export type CaptureInsertPosition = "append" | "prepend" | "heading";

/**
 * Questions asked when a note is created from a template. Shared by template workflows and by
 * plain markdown files in the templates folder.
 */
export interface TemplatePromptOptions {
	/** Show a folder picker (starting on the configured folder) before creating the note. */
	askDestinationFolder?: boolean;
	/** Show a form for frontmatter properties before creating the note. */
	promptProperties?: boolean;
	/** Property names to ask for. Empty means every property in the template's frontmatter. */
	properties?: string[];
}

export interface FiletypeChoice extends TemplatePromptOptions {
	id: string;
	name: string;
	type: ChoiceType;
	registerCommand: boolean;

	/**
	 * Specific folder where the note will be placed (e.g. "Meetings" or "" for vault root).
	 */
	folderPath?: string;

	/**
	 * For "capture": Target markdown file name/path (e.g. "Inbox.md" or "{{DATE}}.md"). Leave blank to use the active file.
	 * For "template": New note file name pattern (e.g. "{{DATE}} - {{VALUE}}.md").
	 */
	targetPath: string;

	// Capture-specific settings
	captureFormat: string;
	insertPosition: CaptureInsertPosition;
	targetHeading: string;
	createTargetIfMissing: boolean;

	// Template-specific settings
	templatePath: string;
	openNewNote: boolean;
}

export interface FormatContext {
	value?: string;
	title?: string;
	now?: Date;
	namedValues?: Record<string, string>;
	selection?: string;
}

const NAMED_VALUE_REGEX = /\{\{VALUE:([^}]+)\}\}/gi;
const NEEDS_PRIMARY_VALUE_REGEX = /\{\{(VALUE|NAME|TITLE)\}\}/i;

/**
 * Sanitizes a single user-supplied value when used inside a file or folder path
 * so it cannot introduce path traversal (`..`), directory separators, or illegal filename characters.
 */
export function sanitizePathVariable(raw: string): string {
	return raw
		.replace(/\p{Cc}/gu, "")
		.replace(/\.{2,}/g, "")
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/^[.\-\s]+/, "")
		.replace(/[.\-\s]+$/, "")
		.trim();
}

/**
 * Sanitizes a vault-relative path, stripping control characters, leading/trailing slashes,
 * and rejecting any `.` or `..` traversal segments so all operations remain strictly inside the vault.
 */
export function sanitizeVaultPath(rawPath: string): string {
	const cleaned = rawPath
		.replace(/\p{Cc}/gu, "")
		.replace(/\\/g, "/")
		.trim();

	const safeSegments: string[] = [];
	for (const segment of cleaned.split("/")) {
		const trimmed = segment.trim();
		if (!trimmed || /^\.+$/.test(trimmed)) {
			continue;
		}
		const safeSegment = trimmed
			.replace(/[:*?"<>|]/g, "-")
			.replace(/[.\s]+$/, "");
		if (safeSegment && !/^\.+$/.test(safeSegment)) {
			safeSegments.push(safeSegment);
		}
	}

	return safeSegments.join("/");
}

/**
 * Combines a chosen `folderPath` (e.g. "Meetings") and a file name/path pattern
 * (e.g. "{{DATE}} - {{VALUE}}.md") into a single vault-relative path without duplicating prefixes.
 */
export function resolveTargetFilePath(
	folderPath: string | undefined,
	targetPath: string
): string {
	const cleanTarget = targetPath
		.replace(/\p{Cc}/gu, "")
		.replace(/\\/g, "/")
		.trim()
		.replace(/^\/+/, "");
	if (!cleanTarget) return "";

	const cleanFolder = sanitizeVaultPath(folderPath ?? "");
	if (!cleanFolder) {
		return cleanTarget;
	}

	if (
		cleanTarget.toLowerCase().startsWith(`${cleanFolder.toLowerCase()}/`)
	) {
		return cleanTarget;
	}

	return `${cleanFolder}/${cleanTarget}`;
}

/**
 * Formats a Date object using a simple token string (YYYY, MM, DD, HH, mm, ss).
 */
export function formatDatePattern(date: Date, pattern = "YYYY-MM-DD"): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	const replacements: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		MM: pad(date.getMonth() + 1),
		DD: pad(date.getDate()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
	};

	return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => replacements[token] ?? token);
}

/**
 * Checks whether any template string requires the primary `{{VALUE}}` / `{{NAME}}` / `{{TITLE}}` prompt.
 */
export function requiresPrimaryInput(...templates: string[]): boolean {
	return templates.some((tpl) => NEEDS_PRIMARY_VALUE_REGEX.test(tpl));
}

/**
 * Extracts unique custom prompt labels from `{{VALUE:Label}}` placeholders across template strings.
 */
export function extractNamedPrompts(...templates: string[]): string[] {
	const labels = new Set<string>();
	for (const tpl of templates) {
		let match: RegExpExecArray | null;
		const regex = new RegExp(NAMED_VALUE_REGEX.source, "gi");
		while ((match = regex.exec(tpl)) !== null) {
			const label = match[1].trim();
			if (label) {
				labels.add(label);
			}
		}
	}
	return Array.from(labels);
}

/**
 * Cleans one line of selected text into a title: strips markdown heading markers (#), list markers
 * (-, *, +, 1.), task boxes and decorative emphasis.
 */
function cleanTitleLine(line: string): string {
	let first = line.trim();
	first = first.replace(/^#+\s*/, "");
	first = first.replace(/^([-*+](\s*\[[ xX]\])?|\d+\.)\s+/, "");
	return first.replace(/^\*+|\*+$|^_+|_+$/g, "").trim();
}

const MAX_TITLE_LENGTH = 100;

/**
 * Extracts a suggested note title from a block of selected editor text: the first non-empty
 * line, cleaned by `cleanTitleLine` and cut to 100 characters.
 */
export function extractInitialTitleFromSelection(selection: string): string {
	const trimmed = selection.trim();
	if (!trimmed) return "";
	const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	let first = cleanTitleLine(lines[0]);
	if (first.length > MAX_TITLE_LENGTH) {
		first = first.slice(0, MAX_TITLE_LENGTH).trim();
	}
	return first;
}

/**
 * Merges the selected editor text into a note created from it. The selection's first line named the
 * note (it filled in the title prompt), so it is not repeated in the body, whatever title was
 * finally entered and whether or not the template shows the title; the remaining lines are appended.
 * - A template with `{{SELECTION}}` or `{{CONTENT}}` already placed the whole selection: unchanged.
 * - A first line too long to be a title (over 100 characters once cleaned) is body text, so the
 *   whole selection is appended.
 */
export function mergeSelectionIntoNoteContent(
	rawTemplate: string,
	renderedTemplate: string,
	selection: string
): string {
	const trimmedSelection = selection.trim();
	if (!trimmedSelection) {
		return renderedTemplate;
	}

	if (/\{\{(SELECTION|CONTENT)\}\}/i.test(rawTemplate)) {
		return renderedTemplate;
	}

	const lines = trimmedSelection.split(/\r?\n/);
	const firstLineTitle = cleanTitleLine(lines[0]);
	const firstLineIsName = firstLineTitle.length > 0 && firstLineTitle.length <= MAX_TITLE_LENGTH;
	const body = (firstLineIsName ? lines.slice(1) : lines).join("\n").trim();
	if (!body) {
		return renderedTemplate;
	}

	const trimmedRendered = renderedTemplate.trimEnd();
	return trimmedRendered ? `${trimmedRendered}\n\n${body}\n` : `${body}\n`;
}

/**
 * Replaces filetypes variables (`{{VALUE}}`, `{{TITLE}}`, `{{DATE}}`, `{{DATE:format}}`,
 * `{{TIME}}`, `{{VALUE:label}}`, `{{SELECTION}}`, and `{{CONTENT}}`) in a string.
 * When `forFilePath` is true, user-supplied values are sanitized for safe vault paths.
 */
export function formatFiletypeString(
	template: string,
	ctx: FormatContext = {},
	forFilePath = false
): string {
	const now = ctx.now ?? new Date();
	const sanitize = (val: string): string =>
		forFilePath ? sanitizePathVariable(val) : val;

	const primaryValue = sanitize(ctx.value ?? "");
	const titleValue = sanitize(ctx.title ?? ctx.value ?? "");
	const selectionValue = sanitize(ctx.selection ?? "");
	const namedValues = ctx.namedValues ?? {};

	const rendered = template
		.replace(/\{\{DATE:([^}]+)\}\}/gi, (_m, pattern: string) =>
			sanitize(formatDatePattern(now, pattern.trim()))
		)
		.replace(/\{\{DATE\}\}/gi, () => formatDatePattern(now, "YYYY-MM-DD"))
		.replace(/\{\{TIME\}\}/gi, () =>
			forFilePath
				? formatDatePattern(now, "HH-mm")
				: formatDatePattern(now, "HH:mm")
		)
		.replace(/\{\{VALUE:([^}]+)\}\}/gi, (_m, label: string) => {
			const key = label.trim();
			return sanitize(namedValues[key] ?? "");
		})
		.replace(/\{\{VALUE\}\}/gi, () => primaryValue)
		.replace(/\{\{(NAME|TITLE)\}\}/gi, () => titleValue)
		.replace(/\{\{(SELECTION|CONTENT)\}\}/gi, () => selectionValue);

	return forFilePath ? sanitizeVaultPath(rendered) : rendered;
}

/**
 * Inserts captured text into an existing markdown document according to `position`:
 * - `"append"`: Appends to the end of the file.
 * - `"prepend"`: Inserts at the top of the file (immediately after YAML frontmatter if present).
 * - `"heading"`: Inserts immediately below the matching markdown heading (creates the heading at the end if missing).
 */
export function insertCapturedText(
	existingContent: string,
	capturedText: string,
	position: CaptureInsertPosition,
	targetHeading = ""
): string {
	const trimmedExisting = existingContent.replace(/\r\n/g, "\n");

	if (!trimmedExisting.trim()) {
		if (position === "heading" && targetHeading.trim()) {
			const normalizedHeading = normalizeHeadingLine(targetHeading);
			return `${normalizedHeading}\n${capturedText}\n`;
		}
		return `${capturedText}\n`;
	}

	if (position === "append") {
		const separator = trimmedExisting.endsWith("\n") ? "" : "\n";
		return `${trimmedExisting}${separator}${capturedText}`;
	}

	if (position === "prepend") {
		const frontmatterMatch = trimmedExisting.match(/^---\n[\s\S]*?\n---\n?/);
		if (frontmatterMatch) {
			const fm = frontmatterMatch[0];
			const rest = trimmedExisting.slice(fm.length);
			const prefix = fm.endsWith("\n") ? fm : `${fm}\n`;
			return `${prefix}${capturedText}\n${rest}`;
		}
		return `${capturedText}\n${trimmedExisting}`;
	}

	// position === "heading"
	const desiredHeading = targetHeading.trim();
	if (!desiredHeading) {
		const separator = trimmedExisting.endsWith("\n") ? "" : "\n";
		return `${trimmedExisting}${separator}${capturedText}`;
	}

	const lines = trimmedExisting.split("\n");
	const cleanTarget = desiredHeading.replace(/^#+\s*/, "").trim().toLowerCase();
	const explicitHashes = desiredHeading.match(/^(#+)\s*/)?.[1];

	for (let i = 0; i < lines.length; i++) {
		const headingMatch = lines[i].match(/^(#+)\s+(.*)$/);
		if (!headingMatch) continue;

		const hashes = headingMatch[1];
		const title = headingMatch[2].trim().toLowerCase();

		const levelMatches = !explicitHashes || explicitHashes === hashes;
		if (levelMatches && title === cleanTarget) {
			lines.splice(i + 1, 0, capturedText);
			return lines.join("\n");
		}
	}

	// Heading not found: append heading + captured text at the end
	const normalizedHeading = normalizeHeadingLine(desiredHeading);
	const separator = trimmedExisting.endsWith("\n") ? "" : "\n";
	return `${trimmedExisting}${separator}\n${normalizedHeading}\n${capturedText}`;
}

/** Case-insensitive key for a template path: vault-safe, with the `.md` extension. */
export function templatePathKey(path: string): string {
	const safe = sanitizeVaultPath(path);
	if (!safe) return "";
	return (safe.toLowerCase().endsWith(".md") ? safe : `${safe}.md`).toLowerCase();
}

/** Template workflows that use a template file, in workflow order. */
export function workflowsForTemplate(choices: FiletypeChoice[], templatePath: string): FiletypeChoice[] {
	const key = templatePathKey(templatePath);
	if (!key) return [];
	return choices.filter((c) => c.type === "template" && templatePathKey(c.templatePath) === key);
}

/** A template workflow for one template file, using the given folder and filename defaults. */
export function newTemplateWorkflow(
	id: string,
	templatePath: string,
	name: string,
	folderPath: string,
	targetPath: string
): FiletypeChoice {
	return {
		id,
		name,
		type: "template",
		registerCommand: false,
		folderPath,
		targetPath,
		captureFormat: "",
		insertPosition: "append",
		targetHeading: "",
		createTargetIfMissing: true,
		templatePath,
		openNewNote: true,
	};
}

/**
 * Settings from before 1.3.0 kept a destination folder and creation prompts per template file, beside
 * the workflows. Those now live only in workflows: each customised file that no workflow uses becomes
 * a workflow (named after the file, not in the command palette); settings for files a workflow
 * already uses were ignored and are dropped. Returns the workflows to add.
 */
export function migrateTemplateFileSettings(
	choices: FiletypeChoice[],
	folderMap: Record<string, string> | undefined,
	options: Record<string, TemplatePromptOptions> | undefined,
	defaults: { folderPath: string; targetPath: string },
	makeId: (index: number) => string
): FiletypeChoice[] {
	// Both maps keyed by path; match their entries case-insensitively, first spelling names the file.
	const paths = new Map<string, string>();
	const folders = new Map<string, string>();
	const prompts = new Map<string, TemplatePromptOptions>();
	for (const [path, folder] of Object.entries(folderMap ?? {})) {
		const key = templatePathKey(path);
		if (!key) continue;
		if (!paths.has(key)) paths.set(key, path);
		if (!folders.has(key)) folders.set(key, folder);
	}
	for (const [path, opts] of Object.entries(options ?? {})) {
		const key = templatePathKey(path);
		if (!key) continue;
		if (!paths.has(key)) paths.set(key, path);
		if (!prompts.has(key)) prompts.set(key, opts ?? {});
	}

	const added: FiletypeChoice[] = [];
	for (const [key, path] of paths) {
		if (workflowsForTemplate([...choices, ...added], path).length > 0) continue;
		const opts = prompts.get(key) ?? {};
		const folder = folders.get(key);
		const customised =
			folder !== undefined ||
			opts.askDestinationFolder ||
			opts.promptProperties ||
			(opts.properties?.length ?? 0) > 0;
		if (!customised) continue;

		const name = path.split("/").pop()?.replace(/\.md$/i, "") || path;
		const workflow = newTemplateWorkflow(
			makeId(added.length),
			path,
			name,
			folder ?? defaults.folderPath,
			defaults.targetPath
		);
		if (opts.askDestinationFolder) workflow.askDestinationFolder = true;
		if (opts.promptProperties) workflow.promptProperties = true;
		if (opts.properties?.length) workflow.properties = [...opts.properties];
		added.push(workflow);
	}
	return added;
}

/** Properties Obsidian always treats as lists, whatever the template holds. */
const LIST_PROPERTIES = new Set(["tags", "aliases", "cssclasses"]);

/** A property value as it appears in frontmatter (what `parseYaml` / `processFrontMatter` hand back). */
export type PropertyValue = string | number | boolean | null | PropertyValue[] | { [key: string]: unknown };

/**
 * Parses the settings text listing which properties to ask for: names separated by commas or
 * new lines, trimmed, de-duplicated (case-insensitively, first spelling wins).
 */
export function parsePropertyList(text: string): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const part of text.split(/[,\n]/)) {
		const name = part.trim();
		if (!name || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		names.push(name);
	}
	return names;
}

/**
 * Returns the YAML between a leading `---` fence pair, or null when the content has no frontmatter.
 */
export function extractFrontmatterYaml(content: string): string | null {
	const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n?---(?:\n|$)/);
	return match ? match[1] : null;
}

/**
 * Decides which properties the creation form asks for: the configured names when there are any,
 * otherwise every key of the template's frontmatter.
 */
export function resolvePromptedProperties(
	configured: string[] | undefined,
	templateFrontmatter: Record<string, unknown> | null
): string[] {
	const names = (configured ?? []).map((n) => n.trim()).filter(Boolean);
	if (names.length > 0) return names;
	return templateFrontmatter ? Object.keys(templateFrontmatter) : [];
}

/** Whether a property is a list, judged from its name and the template's value. */
export function isListProperty(name: string, templateValue: unknown): boolean {
	return Array.isArray(templateValue) || LIST_PROPERTIES.has(name.toLowerCase());
}

/** Renders a frontmatter value as the text shown in the form's input. */
export function propertyValueToInput(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map((v) => propertyValueToInput(v)).filter(Boolean).join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/**
 * Converts the text typed into the form back into a frontmatter value, keeping the template's type:
 * lists split on commas, numbers stay numbers when the input is numeric, booleans stay booleans.
 * Empty input gives null (an empty property) or an empty list.
 */
export function coercePropertyValue(name: string, raw: string, templateValue: unknown): PropertyValue {
	const text = raw.trim();
	if (isListProperty(name, templateValue)) {
		return text
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean)
			.map((item) => (name.toLowerCase() === "tags" ? item.replace(/^#/, "") : item));
	}
	if (!text) return null;
	if (typeof templateValue === "number" && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	if (typeof templateValue === "boolean" && /^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
	return text;
}

/**
 * Values already used for each named property across notes' frontmatter, most used first (ties
 * alphabetical). Property names match case-insensitively, as Obsidian treats them; list values are
 * flattened, tags lose a leading "#", and booleans, objects and empty values are skipped.
 */
export function collectPropertySuggestions(
	frontmatters: Iterable<Record<string, unknown>>,
	names: string[]
): Record<string, string[]> {
	const counts = new Map<string, Map<string, number>>();
	const byLower = new Map<string, string>();
	for (const name of names) {
		byLower.set(name.toLowerCase(), name);
		counts.set(name, new Map());
	}

	const add = (name: string, raw: unknown) => {
		if (typeof raw !== "string" && typeof raw !== "number") return;
		let value = String(raw).trim();
		if (name.toLowerCase() === "tags") value = value.replace(/^#/, "");
		if (!value) return;
		const tally = counts.get(name)!;
		tally.set(value, (tally.get(value) ?? 0) + 1);
	};

	for (const frontmatter of frontmatters) {
		for (const [key, raw] of Object.entries(frontmatter)) {
			const name = byLower.get(key.toLowerCase());
			if (!name) continue;
			if (Array.isArray(raw)) {
				for (const item of raw) add(name, item);
			} else {
				add(name, raw);
			}
		}
	}

	const result: Record<string, string[]> = {};
	for (const [name, tally] of counts) {
		result[name] = [...tally.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([value]) => value);
	}
	return result;
}

/** Splits a comma-separated list input into the finished items and the item being typed. */
export function splitListInput(text: string): { done: string[]; current: string } {
	const parts = text.split(",");
	const current = (parts.pop() ?? "").trim();
	return { done: parts.map((p) => p.trim()).filter(Boolean), current };
}

/** Replaces the item being typed in a list input with a chosen suggestion, ready for the next item. */
export function applyListSuggestion(text: string, value: string): string {
	const { done } = splitListInput(text);
	return [...done, value].join(", ") + ", ";
}

/**
 * Filters suggestions for what has been typed: case-insensitive substring matches, prefix matches
 * first, keeping the incoming (most used first) order otherwise; values in `exclude` are dropped.
 */
export function filterSuggestions(values: string[], query: string, exclude: string[] = []): string[] {
	const q = query.trim().toLowerCase();
	const skip = new Set(exclude.map((v) => v.toLowerCase()));
	const prefix: string[] = [];
	const inner: string[] = [];
	for (const value of values) {
		const lower = value.toLowerCase();
		if (skip.has(lower)) continue;
		if (!q || lower.startsWith(q)) prefix.push(value);
		else if (lower.includes(q)) inner.push(value);
	}
	return [...prefix, ...inner];
}

function normalizeHeadingLine(heading: string): string {
	const trimmed = heading.trim();
	return /^#+\s+/.test(trimmed) ? trimmed : `## ${trimmed}`;
}
