import * as assert from "assert";
import {
	applyListSuggestion,
	coercePropertyValue,
	collectPropertySuggestions,
	extractFrontmatterYaml,
	extractInitialTitleFromSelection,
	extractNamedPrompts,
	filterSuggestions,
	formatFiletypeString,
	insertCapturedText,
	isListProperty,
	mergeSelectionIntoNoteContent,
	migrateTemplateFileSettings,
	newTemplateWorkflow,
	parsePropertyList,
	propertyValueToInput,
	requiresPrimaryInput,
	resolvePromptedProperties,
	resolveTargetFilePath,
	sanitizePathVariable,
	sanitizeVaultPath,
	splitListInput,
	templatePathKey,
	workflowsForTemplate,
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

// Test 8: Merge selection into note content (the selection's first line names the note)
// 8a: Template has {{SELECTION}} placeholder -> preserved without extra appending
const mergedExplicit = mergeSelectionIntoNoteContent(
	selectionTemplate,
	renderedWithSelection,
	"First point\nSecond point"
);
assert.strictEqual(mergedExplicit, renderedWithSelection);

// 8b: Single-line selection is the note's name -> nothing appended
const defaultTemplate = "# {{TITLE}}\n\n";
const renderedHeading = "# Standup Meeting\n\n";
assert.strictEqual(
	mergeSelectionIntoNoteContent(defaultTemplate, renderedHeading, "Standup Meeting"),
	renderedHeading
);

// 8c: Multi-line selection -> first line (the name) dropped, remaining lines appended
const multiLineHeadingSelection = [
	"# Roadmap 2027",
	"- Focus on performance",
	"- Modernize UI",
].join("\n");
assert.strictEqual(
	mergeSelectionIntoNoteContent(defaultTemplate, "# Roadmap 2027\n\n", multiLineHeadingSelection),
	["# Roadmap 2027", "", "- Focus on performance", "- Modernize UI", ""].join("\n")
);

// 8d: Title changed in the prompt -> the selected name is still not appended (regression: it was)
const renderedRenamed = "# Equitable remedies\n\n## Facts\n";
assert.strictEqual(
	mergeSelectionIntoNoteContent(defaultTemplate, renderedRenamed, "Equity law"),
	renderedRenamed
);
assert.strictEqual(
	mergeSelectionIntoNoteContent(defaultTemplate, renderedRenamed, "Equity law\nTrusts and estoppel"),
	"# Equitable remedies\n\n## Facts\n\nTrusts and estoppel\n"
);

// 8e: Template without {{TITLE}} -> the name is still not appended
const noTitleTemplate = "## Facts\n";
assert.strictEqual(mergeSelectionIntoNoteContent(noTitleTemplate, noTitleTemplate, "Donoghue v Stevenson"), noTitleTemplate);

// 8f: A first line too long to be a title is body text -> whole selection appended
const longLine = "This paragraph is far too long to be a sensible note title, so it is kept as body text in the new note.";
assert.ok(longLine.length > 100);
assert.strictEqual(
	mergeSelectionIntoNoteContent(defaultTemplate, "# Short\n", `${longLine}\nMore`),
	`# Short\n\n${longLine}\nMore\n`
);

// Test 9: Property prompts
// 9a: Settings text -> property names (commas or new lines, trimmed, de-duplicated case-insensitively)
assert.deepStrictEqual(parsePropertyList(" status, tags\nAuthor ,, status, STATUS "), ["status", "tags", "Author"]);
assert.deepStrictEqual(parsePropertyList("   "), []);

// 9b: Frontmatter extraction
assert.strictEqual(extractFrontmatterYaml("---\nstatus: draft\ntags: [a]\n---\n# Body"), "status: draft\ntags: [a]");
assert.strictEqual(extractFrontmatterYaml("---\r\nstatus: draft\r\n---\r\n"), "status: draft");
assert.strictEqual(extractFrontmatterYaml("---\n---\nBody"), "");
assert.strictEqual(extractFrontmatterYaml("# No frontmatter\n---\nx: 1\n---"), null);

// 9c: Which properties are asked: configured names win, else every template key
assert.deepStrictEqual(resolvePromptedProperties(["status", " "], { status: "draft", due: null }), ["status"]);
assert.deepStrictEqual(resolvePromptedProperties([], { status: "draft", due: null }), ["status", "due"]);
assert.deepStrictEqual(resolvePromptedProperties(undefined, null), []);

// 9d: List detection, input text, and type-preserving coercion
assert.strictEqual(isListProperty("tags", null), true);
assert.strictEqual(isListProperty("Aliases", "x"), true);
assert.strictEqual(isListProperty("people", ["a"]), true);
assert.strictEqual(isListProperty("status", "draft"), false);
assert.strictEqual(propertyValueToInput(["law", "torts"]), "law, torts");
assert.strictEqual(propertyValueToInput(null), "");
assert.strictEqual(propertyValueToInput(3), "3");
assert.deepStrictEqual(coercePropertyValue("tags", " #law, torts ,, ", null), ["law", "torts"]);
assert.deepStrictEqual(coercePropertyValue("people", "Ann, Bo", []), ["Ann", "Bo"]);
assert.deepStrictEqual(coercePropertyValue("aliases", "", null), []);
assert.strictEqual(coercePropertyValue("status", "  final ", "draft"), "final");
assert.strictEqual(coercePropertyValue("status", "   ", "draft"), null);
assert.strictEqual(coercePropertyValue("week", "12", 1), 12);
assert.strictEqual(coercePropertyValue("week", "twelve", 1), "twelve");
assert.strictEqual(coercePropertyValue("done", "true", false), true);
assert.strictEqual(coercePropertyValue("code", "007", "x"), "007");

// Test 10: Property value suggestions
// 10a: Collected across notes, most used first, ties alphabetical; names match case-insensitively
const suggestions = collectPropertySuggestions(
	[
		{ Court: "HCA", tags: ["#torts", "contract"], year: 2019, done: true },
		{ court: "NSWCA", tags: "torts", year: "2019" },
		{ court: "HCA", tags: ["evidence", null, ""], extra: "x" },
		{ court: { nested: 1 }, done: false },
	],
	["court", "tags", "year", "done", "missing"]
);
assert.deepStrictEqual(suggestions.court, ["HCA", "NSWCA"]);
assert.deepStrictEqual(suggestions.tags, ["torts", "contract", "evidence"]);
assert.deepStrictEqual(suggestions.year, ["2019"]);
assert.deepStrictEqual(suggestions.done, []);
assert.deepStrictEqual(suggestions.missing, []);

// 10b: List input: finished items and the one being typed; applying a suggestion
assert.deepStrictEqual(splitListInput("law, torts, ev"), { done: ["law", "torts"], current: "ev" });
assert.deepStrictEqual(splitListInput("law, "), { done: ["law"], current: "" });
assert.deepStrictEqual(splitListInput(""), { done: [], current: "" });
assert.strictEqual(applyListSuggestion("law, torts, ev", "evidence"), "law, torts, evidence, ");
assert.strictEqual(applyListSuggestion("", "law"), "law, ");

// 10c: Filtering: prefix matches first, then substring matches, excluding entered items
assert.deepStrictEqual(
	filterSuggestions(["Contract", "torts", "tort reform", "Evidence"], "tor", ["Torts"]),
	["tort reform"]
);
assert.deepStrictEqual(filterSuggestions(["abc", "xab", "ab"], "ab"), ["abc", "ab", "xab"]);
assert.deepStrictEqual(filterSuggestions(["a", "b"], "  "), ["a", "b"]);

// Test 11: Template files and workflows
// 11a: Path keys ignore case, slashes and a missing .md
assert.strictEqual(templatePathKey("/Templates/Case Brief"), "templates/case brief.md");
assert.strictEqual(templatePathKey("Templates/Case brief.md"), "templates/case brief.md");
assert.strictEqual(templatePathKey(""), "");

// 11b: Which workflows use a template file (templates only, any spelling of the path)
const wfCase = newTemplateWorkflow("w1", "Templates/Case brief", "Case", "Cases", "{{VALUE}}.md");
const wfCapture = { ...newTemplateWorkflow("w2", "Templates/Case brief.md", "Cap", "", "Inbox.md"), type: "capture" as const };
assert.deepStrictEqual(workflowsForTemplate([wfCase, wfCapture], "templates/case brief.md").map((c) => c.id), ["w1"]);
assert.deepStrictEqual(workflowsForTemplate([wfCase], "Templates/Lecture.md"), []);
assert.strictEqual(wfCase.registerCommand, false);
assert.strictEqual(wfCase.openNewNote, true);

// 11c: Migration of per-file settings (before 1.3.0) into workflows
const defaults = { folderPath: "Inbox", targetPath: "{{DATE}} - {{VALUE}}.md" };
const migrated = migrateTemplateFileSettings(
	[wfCase],
	{ "Templates/Case brief.md": "Old", "Templates/Lecture.md": "Lectures" },
	{
		"Templates/Lecture.md": { promptProperties: true, properties: ["unit"] },
		"Templates/Memo.md": { askDestinationFolder: true },
		"Templates/Blank.md": {},
	},
	defaults,
	(i) => `m${i}`
);
// Case brief: already used by a workflow -> its (ignored) file settings are dropped
// Lecture: folder + prompts -> workflow; Memo: prompt only -> default folder; Blank: nothing set -> skipped
assert.deepStrictEqual(
	migrated.map((c) => [c.id, c.name, c.templatePath, c.folderPath, c.targetPath, c.askDestinationFolder ?? false, c.promptProperties ?? false, c.properties ?? []]),
	[
		["m0", "Lecture", "Templates/Lecture.md", "Lectures", "{{DATE}} - {{VALUE}}.md", false, true, ["unit"]],
		["m1", "Memo", "Templates/Memo.md", "Inbox", "{{DATE}} - {{VALUE}}.md", true, false, []],
	]
);
assert.ok(migrated.every((c) => c.type === "template" && c.registerCommand === false));
assert.deepStrictEqual(migrateTemplateFileSettings([], undefined, undefined, defaults, (i) => `x${i}`), []);
// The same file listed in both maps (any spelling) becomes one workflow
const mergedSpellings = migrateTemplateFileSettings([], { "Templates/A.md": "F" }, { "templates/a": { promptProperties: true } }, defaults, (i) => `y${i}`);
assert.deepStrictEqual(
	mergedSpellings.map((c) => [c.templatePath, c.folderPath, c.promptProperties]),
	[["Templates/A.md", "F", true]]
);

console.log("All filetypes tests passed!");
