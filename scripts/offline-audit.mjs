#!/usr/bin/env node
/*
 * Offline audit: fails if the plugin's source, built bundle or styles could make a network request,
 * run dynamically generated code, or inject raw HTML.
 *
 *   node scripts/offline-audit.mjs
 *
 * Checks src/**\/*.{ts,js,mjs}, main.js (when built) and styles.css.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Patterns forbidden in code. */
const CODE_RULES = [
	[/\bfetch\s*\(/, "fetch()"],
	[/\bXMLHttpRequest\b/, "XMLHttpRequest"],
	[/\bWebSocket\b/, "WebSocket"],
	[/\bEventSource\b/, "EventSource"],
	[/\bsendBeacon\b/, "navigator.sendBeacon"],
	[/\bRTCPeerConnection\b/, "WebRTC"],
	[/\bserviceWorker\b/, "service workers"],
	[/\bnew\s+(?:Shared)?Worker\s*\(/, "web workers"],
	[/\bimportScripts\s*\(/, "importScripts()"],
	[/\bimport\s*\(/, "dynamic import()"],
	[/\brequestUrl\b/, "Obsidian requestUrl()"],
	[/\bimport\s*\{[^}]*\brequest\b[^}]*\}\s*from\s*["']obsidian["']/, "Obsidian request()"],
	[/\bobsidian\d*\.request\s*\(/, "Obsidian request()"],
	[/require\(\s*["'](?:node:)?(?:http|https|http2|net|tls|dns|dgram|child_process|electron)["']\s*\)/, "Node/Electron network or process module"],
	[/\bfrom\s*["'](?:node:)?(?:http|https|http2|net|tls|dns|dgram|child_process|electron)["']/, "Node/Electron network or process module"],
	[/\bopenExternal\b/, "shell.openExternal"],
	[/\bwindow\.open\s*\(/, "window.open()"],
	[/\beval\s*\(/, "eval()"],
	[/\bnew\s+Function\s*\(/, "new Function()"],
	[/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "string timer (implicit eval)"],
	[/\.innerHTML\s*[+]?=/, "innerHTML assignment"],
	[/\.outerHTML\s*[+]?=/, "outerHTML assignment"],
	[/\binsertAdjacentHTML\b/, "insertAdjacentHTML"],
	[/\bdocument\.write\b/, "document.write"],
	[/\bcreateContextualFragment\b/, "createContextualFragment"],
	[/\.src\s*=\s*["'`](?:https?:)?\/\//, "remote src assignment"],
];

/** Patterns forbidden in CSS. */
const CSS_RULES = [
	[/@import\b/i, "@import"],
	[/url\(\s*(?!["']?(?:data:|#))/i, "url() that is not an inline data: URI"],
	[/https?:\/\//i, "remote URL"],
];

/** Strip comments so documentation that mentions an API is not flagged. Strings are kept. */
function stripComments(code) {
	let out = "";
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		const next = code[i + 1];
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < code.length && code[j] !== ch) j += code[j] === "\\" ? 2 : 1;
			out += code.slice(i, j + 1);
			i = j;
		} else if (ch === "/" && next === "/") {
			while (i < code.length && code[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && next === "*") {
			const end = code.indexOf("*/", i + 2);
			const body = code.slice(i, end === -1 ? code.length : end + 2);
			out += body.replace(/[^\n]/g, " ");
			i = end === -1 ? code.length : end + 1;
		} else {
			out += ch;
		}
	}
	return out;
}

function walk(dir, exts, found = []) {
	if (!existsSync(dir)) return found;
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, exts, found);
		else if (exts.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) found.push(path);
	}
	return found;
}

const problems = [];
function check(path, text, rules) {
	const lines = text.split("\n");
	for (const [regex, label] of rules) {
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				problems.push(`${relative(ROOT, path)}:${i + 1}: ${label}`);
			}
		}
	}
}

const codeFiles = walk(join(ROOT, "src"), [".ts", ".js", ".mjs"]);
if (existsSync(join(ROOT, "main.js"))) codeFiles.push(join(ROOT, "main.js"));
for (const path of codeFiles) {
	check(path, stripComments(readFileSync(path, "utf8")), CODE_RULES);
}
if (existsSync(join(ROOT, "styles.css"))) {
	const css = readFileSync(join(ROOT, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	check(join(ROOT, "styles.css"), css, CSS_RULES);
}

if (problems.length > 0) {
	console.error("Offline audit failed:");
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log(`Offline audit passed: ${codeFiles.length} code file(s) and styles make no network requests.`);
