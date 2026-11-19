#!/usr/bin/env node
// Runs this package's own gates against a *published* Pi host, not the one pinned in devDependencies.
//
// Why this exists: peerDependencies are "*", so the package installs under any Pi, while `npm run check`
// typechecks and tests only against the pinned dev host. Drift on the host side — a changed tool-handler
// context, a renamed model tag — is invisible to the pinned suite and shows up in the field. Two such
// defects were found by hand in one session and nothing re-ran the probe, so the probe became this gate.
//
// Usage:
//   node scripts/check-host-compat.mjs                        # latest published Pi
//   ... --host <version|dist-tag>                             # a specific Pi (default: latest)
//   ... --dir <path>                                          # use/create this workspace (kept by default)
//   ... --install-only | --typecheck-only | --tests-only      # run one stage in an existing workspace
//   ... --keep                                                # keep a fresh temp workspace
//
// The install stage needs network access. The exit code is 2 for a gate/setup problem and 1 when the
// host build does not typecheck or any test fails.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
const args = process.argv.slice(2);

function takeValue(name, fallback) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const value = args[i + 1];
	args.splice(i, 2);
	return value === undefined || value.startsWith("--") ? fallback : value;
}
function takeFlag(name) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

const requestedHost = takeValue("host", "latest");
const dirArg = takeValue("dir", undefined);
const installOnly = takeFlag("install-only");
const typecheckOnly = takeFlag("typecheck-only");
const testsOnly = takeFlag("tests-only");
const keep = takeFlag("keep") || dirArg !== undefined;
if (args.length > 0) {
	console.log(`HOST GATE: unexpected argument ${args[0]}\n${"usage: node scripts/check-host-compat.mjs [--host <v>] [--dir <path>] [--install-only|--typecheck-only|--tests-only] [--keep]"}`);
	process.exit(2);
}

const workspace = dirArg ?? mkdtempSync(join(tmpdir(), "host-compat-"));
mkdirSync(workspace, { recursive: true });
const dev = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies ?? {};
const installedVersion = () => {
	try {
		return JSON.parse(readFileSync(join(workspace, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	} catch {
		return "unknown";
	}
};

function run(command, commandArgs, options = {}) {
	try {
		return { code: 0, out: execFileSync(command, commandArgs, { cwd: options.cwd ?? workspace, encoding: "utf8", stdio: "pipe", maxBuffer: 64 << 20 }) };
	} catch (error) {
		return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

/** Installs the published host plus the repo's own toolchain, so the host is the only variable. */
function install() {
	// A private stub: the repo's package.json pins dev hosts in devDependencies and must not drive this install.
	writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "host-compat-workspace", private: true, type: "module" }, null, 2)}\n`);
	const resolved = run("npm", ["view", `${HOST_PACKAGES[0]}@${requestedHost}`, "version"]);
	if (resolved.code !== 0) {
		console.log(`HOST GATE: cannot resolve ${HOST_PACKAGES[0]}@${requestedHost}: ${resolved.out.trim().split("\n").at(-1)}`);
		process.exit(2);
	}
	const version = resolved.out.trim().split("\n").at(-1);
	const specs = [
		...HOST_PACKAGES.map((name) => `${name}@${version}`),
		`typebox@${dev.typebox ?? "*"}`,
		`typescript@${dev.typescript ?? "*"}`,
		`@types/node@${dev["@types/node"] ?? "*"}`,
	];
	const installed = run("npm", ["install", "--silent", "--no-audit", "--no-fund", "--package-lock=false", ...specs]);
	if (installed.code !== 0) {
		console.log(`HOST GATE ${version}: install failed\n${installed.out.split("\n").slice(-12).join("\n")}`);
		process.exit(2);
	}
	console.log(`HOST GATE: installed ${HOST_PACKAGES[0]}@${version} with ${specs.slice(-3).join(", ")}`);
}

function sync() {
	for (const dir of ["src", "tests", "eval", "scripts", "bench"]) {
		if (existsSync(join(repo, dir))) cpSync(join(repo, dir), join(workspace, dir), { recursive: true });
	}
	for (const file of ["tsconfig.json", "package.json"]) cpSync(join(repo, file), join(workspace, file));
}

function typecheck() {
	const tsc = join(workspace, "node_modules", "typescript", "bin", "tsc");
	if (!existsSync(tsc)) {
		console.log("HOST GATE: no typescript in the workspace; run the install stage first");
		process.exit(2);
	}
	const result = run(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"]);
	const errors = result.out.split("\n").filter((line) => line.includes("error TS"));
	console.log(`HOST GATE: typecheck ${errors.length === 0 ? "clean" : `${errors.length} error(s)`}`);
	for (const line of errors.slice(0, 12)) console.log(`  ${line}`);
	return errors.length > 0;
}

function tests() {
	// The same file set `npm test` runs, enumerated rather than globbed: execFileSync does not expand globs,
	// and handing the runner a directory reports one opaque failing entry instead of the suite.
	const files = readdirSync(join(repo, "tests")).filter((name) => name.endsWith(".test.ts")).sort().map((name) => join("tests", name));
	if (files.length === 0) {
		console.log("HOST GATE: no test files found; the gate is not measuring anything");
		return true;
	}
	const result = run(process.execPath, ["--test", "--experimental-strip-types", "--test-reporter=tap", ...files]);
	const summary = Object.fromEntries([...result.out.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
	const failing = result.out.split("\n").filter((line) => /^not ok \d+ -/.test(line)).slice(0, 12);
	const broken = (summary.fail ?? 1) + (summary.cancelled ?? 0) > 0;
	console.log(`HOST GATE: tests ${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail, ${summary.skipped ?? 0} skipped, ${summary.cancelled ?? 0} cancelled (of ${summary.tests ?? "?"})`);
	for (const line of failing) console.log(`  ${line}`);
	if (broken && summary.tests === undefined) console.log("  (no TAP summary: the suite did not run to completion)");
	return broken;
}

let failed = false;
if (!testsOnly) install();
sync();
if (!testsOnly) failed = typecheck() || failed;
if (!installOnly && !typecheckOnly) failed = tests() || failed;
if (!keep) rmSync(workspace, { recursive: true, force: true });
console.log(`HOST GATE ${failed ? "FAILED" : "OK"} on Pi ${installedVersion()} (${workspace})`);
process.exit(failed ? 1 : 0);
