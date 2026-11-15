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
 * Extracts a suggested note title from a block of selected editor text.
 * Strips markdown heading markers (#), list markers (-, *, +, 1.), task boxes,
 * and decorative emphasis formatting.
 */
export function extractInitialTitleFromSelection(selection: string): string {
	const trimmed = selection.trim();
	if (!trimmed) return "";
	const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	let first = lines[0];
	first = first.replace(/^#+\s*/, "");
	first = first.replace(/^([-*+](\s*\[[ xX]\])?|\d+\.)\s+/, "");
	first = first.replace(/^\*+|\*+$|^_+|_+$/g, "").trim();
	if (first.length > 100) {
		first = first.slice(0, 100).trim();
	}
	return first;
}

/**
 * Merges rendered template content and the selected editor text.
 * - If the raw template already contained `{{SELECTION}}` or `{{CONTENT}}`,
 *   the selection is already placed by `formatFiletypeString`, so no extra content is appended.
 * - If the entire selection matches the note title and is already present in the rendered content,
 *   it is not duplicated.
 * - If a multi-line selection had its first line used as the title and that title is present
 *   in the rendered content, the remaining lines are appended.
 * - Otherwise, the full selection is appended to the note.
 */
export function mergeSelectionIntoNoteContent(
	rawTemplate: string,
	renderedTemplate: string,
	selection: string,
	title = ""
): string {
	const trimmedSelection = selection.trim();
	if (!trimmedSelection) {
		return renderedTemplate;
	}

	if (/\{\{(SELECTION|CONTENT)\}\}/i.test(rawTemplate)) {
		return renderedTemplate;
	}

	const trimmedRendered = renderedTemplate.trimEnd();

	if (
		title &&
		trimmedSelection.toLowerCase() === title.trim().toLowerCase() &&
		renderedTemplate.toLowerCase().includes(title.trim().toLowerCase())
	) {
		return renderedTemplate;
	}

	const lines = trimmedSelection.split(/\r?\n/);
	if (
		lines.length > 1 &&
		title &&
		renderedTemplate.toLowerCase().includes(title.trim().toLowerCase())
	) {
		const firstLineClean = extractInitialTitleFromSelection(lines[0]).toLowerCase();
		if (firstLineClean === title.trim().toLowerCase()) {
			const remainingLines = lines.slice(1).join("\n").trim();
			if (remainingLines) {
				return trimmedRendered
					? `${trimmedRendered}\n\n${remainingLines}\n`
					: `${remainingLines}\n`;
			}
			return renderedTemplate;
		}
	}

	return trimmedRendered
		? `${trimmedRendered}\n\n${trimmedSelection}\n`
		: `${trimmedSelection}\n`;
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

function normalizeHeadingLine(heading: string): string {
	const trimmed = heading.trim();
	return /^#+\s+/.test(trimmed) ? trimmed : `## ${trimmed}`;
}
