import * as assert from "assert";
import {
	extractInitialTitleFromSelection,
	extractNamedPrompts,
	formatFiletypeString,
	insertCapturedText,
	mergeSelectionIntoNoteContent,
	requiresPrimaryInput,
	resolveTargetFilePath,
	sanitizePathVariable,
	sanitizeVaultPath,
} from "../src/formatter";

// Test 1: Variable formatting ({{VALUE}}, {{DATE}}, {{TIME}}, {{VALUE:Label}})
const fixedDate = new Date(2026, 10, 4, 9, 30, 15); // 2026-11-04 09:30:15
const rendered = formatFiletypeString(
	"- [ ] {{VALUE}} [owner:: {{VALUE:Owner}}] ({{DATE}} {{TIME}} / {{DATE:YYYY/MM/DD}})",
	{
		value: "Ship filetypes",
		now: fixedDate,
		namedValues: { Owner: "Alice" },
	}
);
assert.strictEqual(
	rendered,
	"- [ ] Ship filetypes [owner:: Alice] (2026-11-04 09:30 / 2026/11/04)"
);

// Test 2: Detecting primary and named prompts
assert.strictEqual(requiresPrimaryInput("Notes/{{DATE}}.md", "- Static item"), false);
assert.strictEqual(requiresPrimaryInput("Notes/{{DATE}} - {{VALUE}}.md"), true);
assert.deepStrictEqual(
	extractNamedPrompts(
		"# {{VALUE:Project Name}}",
		"Assigned to {{VALUE:Assignee}} in {{VALUE:Project Name}}"
	),
	["Project Name", "Assignee"]
);

// Test 3: Capture insertion modes (append, prepend with YAML frontmatter, heading)
const docWithFrontmatter = [
	"---",
	"tags: [daily]",
	"---",
	"# Daily Note",
	"",
	"## Tasks",
	"- [ ] Existing task",
	"",
	"## Notes",
	"- Some note",
].join("\n");

// Prepend after frontmatter
const prepended = insertCapturedText(
	docWithFrontmatter,
	"- Prepended item",
	"prepend"
);
assert.strictEqual(
	prepended,
	[
		"---",
		"tags: [daily]",
		"---",
		"- Prepended item",
		"# Daily Note",
		"",
		"## Tasks",
		"- [ ] Existing task",
		"",
		"## Notes",
		"- Some note",
	].join("\n")
);

// Insert under "## Tasks" heading
const underHeading = insertCapturedText(
	docWithFrontmatter,
	"- [ ] Newly captured task",
	"heading",
	"## Tasks"
);
assert.strictEqual(
	underHeading,
	[
		"---",
		"tags: [daily]",
		"---",
		"# Daily Note",
		"",
		"## Tasks",
		"- [ ] Newly captured task",
		"- [ ] Existing task",
		"",
		"## Notes",
		"- Some note",
	].join("\n")
);

// Append to bottom
const appended = insertCapturedText(
	docWithFrontmatter,
	"- Bottom item",
	"append"
);
assert.ok(appended.endsWith("## Notes\n- Some note\n- Bottom item"));

// Test 4: Destination folder resolution
assert.strictEqual(
	resolveTargetFilePath("Meetings", "{{DATE}} - {{VALUE}}.md"),
	"Meetings/{{DATE}} - {{VALUE}}.md"
);
assert.strictEqual(
	resolveTargetFilePath("", "{{DATE}} - {{VALUE}}.md"),
	"{{DATE}} - {{VALUE}}.md"
);
assert.strictEqual(
	resolveTargetFilePath("/Projects/2026/", "Spec.md"),
	"Projects/2026/Spec.md"
);
assert.strictEqual(
	resolveTargetFilePath("Meetings", "Meetings/2026-11-05.md"),
	"Meetings/2026-11-05.md"
);

// Test 5: Security - Vault path traversal & illegal filename sanitization
assert.strictEqual(
	sanitizeVaultPath("../../etc/passwd"),
	"etc/passwd"
);
assert.strictEqual(
	sanitizeVaultPath("/Meetings/../Notes/./Daily/"),
	"Meetings/Notes/Daily"
);
assert.strictEqual(
	sanitizeVaultPath(".../Meetings/..../Notes/"),
	"Meetings/Notes"
);
assert.strictEqual(
	sanitizeVaultPath("Folder with trailing spaces. /Note. "),
	"Folder with trailing spaces/Note"
);
assert.strictEqual(
	sanitizePathVariable("../../secret:file*name?.md"),
	"secret-file-name-.md"
);
assert.strictEqual(
	sanitizePathVariable("   ...   "),
	""
);
const safePathRendered = formatFiletypeString(
	"Meetings/{{DATE}} - {{VALUE}}.md",
	{
		value: "../../escape/attempt:1",
		now: fixedDate,
	},
	true
);
assert.strictEqual(
	safePathRendered,
	"Meetings/2026-11-04 - escape-attempt-1.md"
);

// Test 6: Extract initial title from selection
assert.strictEqual(
	extractInitialTitleFromSelection("### Architecture Review"),
	"Architecture Review"
);
assert.strictEqual(
	extractInitialTitleFromSelection("- [ ] Fix authentication bug"),
	"Fix authentication bug"
);
assert.strictEqual(
	extractInitialTitleFromSelection("1. Deploy to production\nAdditional details"),
	"Deploy to production"
);
assert.strictEqual(
	extractInitialTitleFromSelection("**Quarterly Objectives**"),
	"Quarterly Objectives"
);
assert.strictEqual(extractInitialTitleFromSelection("   "), "");

// Test 7: Selection and Content placeholders in templates
const selectionTemplate = [
	"# {{TITLE}}",
	"",
	"## Notes",
	"{{SELECTION}}",
	"",
	"Captured: {{DATE}}",
].join("\n");
const renderedWithSelection = formatFiletypeString(selectionTemplate, {
	title: "Project Phoenix",
	selection: "First point\nSecond point",
	now: fixedDate,
});
assert.strictEqual(
	renderedWithSelection,
	[
		"# Project Phoenix",
		"",
		"## Notes",
		"First point\nSecond point",
		"",
		"Captured: 2026-11-04",
	].join("\n")
);

// Test 8: Merge selection into note content
// 8a: Template has {{SELECTION}} placeholder -> preserved without extra appending
const mergedExplicit = mergeSelectionIntoNoteContent(
	selectionTemplate,
	renderedWithSelection,
	"First point\nSecond point",
	"Project Phoenix"
);
assert.strictEqual(mergedExplicit, renderedWithSelection);

// 8b: Single-line selection matching note title already in template -> no duplicate heading
const defaultTemplate = "# {{TITLE}}\n\n";
const renderedHeading = "# Standup Meeting\n\n";
const mergedSingleLine = mergeSelectionIntoNoteContent(
	defaultTemplate,
	renderedHeading,
	"Standup Meeting",
	"Standup Meeting"
);
assert.strictEqual(mergedSingleLine, renderedHeading);

// 8c: Multi-line selection where first line was heading/title -> append remaining lines
const multiLineHeadingSelection = [
	"# Roadmap 2027",
	"- Focus on performance",
	"- Modernize UI",
].join("\n");
const renderedRoadmap = "# Roadmap 2027\n\n";
const mergedRoadmap = mergeSelectionIntoNoteContent(
	defaultTemplate,
	renderedRoadmap,
	multiLineHeadingSelection,
	"Roadmap 2027"
);
assert.strictEqual(
	mergedRoadmap,
	[
		"# Roadmap 2027",
		"",
		"- Focus on performance",
		"- Modernize UI",
		"",
	].join("\n")
);

// 8d: Selection with custom title -> entire selection appended below template
const renderedCustomTitle = "# Custom Note Title\n\n";
const mergedCustom = mergeSelectionIntoNoteContent(
	defaultTemplate,
	renderedCustomTitle,
	"Selected body paragraph without heading.",
	"Custom Note Title"
);
assert.strictEqual(
	mergedCustom,
	[
		"# Custom Note Title",
		"",
		"Selected body paragraph without heading.",
		"",
	].join("\n")
);

console.log("All filetypes tests passed!");
