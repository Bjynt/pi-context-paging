import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The supported-host boundary exists in three places that have to agree: the floor the gate resolves for
 * `--host floor`, the CI matrix that runs it, and the README that promises it to users.
 *
 * Drift here is user-visible, not cosmetic: `peerDependencies` is `"*"`, so `pi install` succeeds on Pi 0.86.1 and
 * the four history tools register — and then the first request that reads the session projection throws, because
 * that host has no `sessionManager.buildSessionProjection()`. Measured: 0.74.0, 0.80.1, 0.84.2, 0.86.0 and 0.86.1
 * fail; 0.87.0 and every newer host tested (1.0.4, 1.3.0, 1.5.2) pass.
 *
 * These tests pin the version token and the matrix entry, not the prose: the README can be reworded freely, and a
 * floor raised for a real reason passes, while silently dropping the floor check from CI or promising a host the
 * gate does not enforce fails.
 */
const repo = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(repo, relative), "utf8");

function printedFloor(): string {
	const result = spawnSync(process.execPath, [join(repo, "scripts", "check-host-compat.mjs"), "--print-floor"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `--print-floor exited ${result.status}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function compareSemver(a: string, b: string): number {
	const parts = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10));
	const [left, right] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i += 1) {
		if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0) ? -1 : 1;
	}
	return 0;
}

test("the gate resolves --host floor to a publishable version", () => {
	const floor = printedFloor();
	assert.match(floor, /^\d+\.\d+\.\d+$/, `floor must be an exact published version, got ${JSON.stringify(floor)}`);
});

test("the extension's own capability floor is the version the gate enforces", () => {
	// src/index.ts refuses to page on a host without the session-projection API and quotes this version to the
	// user. If the gate's floor moves and the runtime message does not, users are told the wrong thing.
	const source = read("src/index.ts");
	const declared = source.match(/const MINIMUM_PI_VERSION = "(\d+\.\d+\.\d+)"/);
	assert.ok(declared, "src/index.ts must declare MINIMUM_PI_VERSION for the capability guard");
	assert.equal(declared[1], printedFloor(), "the runtime capability floor and the gate floor must agree");
});

test("the floor is at or above the oldest host measured to provide the paging path", () => {
	// 0.87.0 is the lowest host on which the artifact API probe passes. Lowering the gate's floor below it would
	// re-admit hosts where the extension registers and then throws on the request path.
	assert.ok(
		compareSemver(printedFloor(), "0.87.0") >= 0,
		`floor ${printedFloor()} is below 0.87.0, measured as the first host with sessionManager.buildSessionProjection()`,
	);
});

test("the README promises exactly the floor the gate enforces", () => {
	const readme = read("README.md");
	// Anchored on the section heading, not on sentences: the prose around the floor is free to change, the
	// version it tells users is not.
	const start = readme.search(/^### .*Pi versions?$/im);
	assert.notEqual(start, -1, "README must keep a supported-Pi-versions section heading");
	const section = readme.slice(start);
	const body = section.slice(0, section.search(/^## (?!#)/m) === -1 ? section.length : section.search(/^## (?!#)/m));
	const versions = [...body.matchAll(/\d+\.\d+\.\d+/g)].map((match) => match[0]);
	const floor = printedFloor();
	assert.ok(
		versions.includes(floor),
		`README must name the floor the gate enforces (${floor}); the section names ${versions.join(", ") || "no version"}`,
	);
	const lower = versions.filter((version) => compareSemver(version, floor) < 0);
	assert.deepEqual(
		lower,
		[],
		`README must not advertise a Pi older than the enforced floor ${floor}: ${lower.join(", ")}`,
	);
});

test("CI enforces the floor as a runtime contract and latest as the full suite", () => {
	const workflow = read(".github/workflows/ci.yml");
	const job = workflow.slice(workflow.indexOf("  host-compat:"));
	assert.ok(job.length > 0, "ci.yml must keep a host-compat job");
	const legs = [...job.matchAll(/- pi: (\S+)\n\s+stages: (\S*)/g)].map((match) => ({
		pi: match[1],
		stages: match[2].replace(/^["']|["']$/g, ""),
	}));
	const names = legs.map((leg) => leg.pi).sort();
	assert.ok(names.includes("floor") && names.includes("latest"), `host-compat must cover floor and latest, got ${names.join(", ")}`);
	const floor = legs.find((leg) => leg.pi === "floor");
	assert.equal(
		floor?.stages,
		"--runtime-only",
		"the floor leg must run the runtime contract: the suite resolves models through the newest host registry and cannot pass on older hosts",
	);
	const latest = legs.find((leg) => leg.pi === "latest");
	assert.equal(latest?.stages, "", "the latest leg must run the whole gate, suite included");
	// The CI flag is only half the contract; the gate has to honour it, or the floor leg runs a suite that
	// cannot pass there (39 eval-harness failures on 0.87.0).
	assert.match(
		read("scripts/check-host-compat.mjs"),
		/!runtimeOnly\) failed = tests\(\)/,
		"--runtime-only must skip the suite stage in the gate, not just in the workflow",
	);
	assert.match(
		job,
		/check-host-compat\.mjs --host \$\{\{ matrix\.pi \}\} \$\{\{ matrix\.stages \}\}/,
		"the host-compat step must pass both the matrix host and its stage flags to the gate",
	);
});
