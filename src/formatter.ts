export type ChoiceType = "capture" | "template";
export type CaptureInsertPosition = "append" | "prepend" | "heading";

export interface FiletypeChoice {
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
}

const NAMED_VALUE_REGEX = /\{\{VALUE:([^}]+)\}\}/gi;
const NEEDS_PRIMARY_VALUE_REGEX = /\{\{(VALUE|NAME|TITLE)\}\}/i;

/**
 * Sanitizes a single user-supplied value when used inside a file or folder path
 * so it cannot introduce path traversal (`..`), directory separators, or illegal filename characters.
 */
export function sanitizePathVariable(raw: string): string {
	return raw
		.replace(/[\x00-\x1f\x7f]/g, "")
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
		.replace(/[\x00-\x1f\x7f]/g, "")
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
		.replace(/[\x00-\x1f\x7f]/g, "")
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
 * Replaces filetypes variables (`{{VALUE}}`, `{{TITLE}}`, `{{DATE}}`, `{{DATE:format}}`,
 * `{{TIME}}`, and `{{VALUE:label}}`) in a string.
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
		.replace(/\{\{(NAME|TITLE)\}\}/gi, () => titleValue);

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

function normalizeHeadingLine(heading: string): string {
	const trimmed = heading.trim();
	return /^#+\s+/.test(trimmed) ? trimmed : `## ${trimmed}`;
}
