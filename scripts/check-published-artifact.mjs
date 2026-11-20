#!/usr/bin/env node
// Fails when the version this repository advertises is on npm as a build that does not carry this repository's
// compatibility contract.
//
// Why this exists — measured on the live registry, not inferred:
//   npm view @rochecompaan/pi-context-paging@0.3.11 gitHead  -> 4409e5e4ffa0b626c11e72afe666f0b6e55a0e5f
//   git rev-list -n1 v0.3.11                                 -> 4409e5e4ffa0b626c11e72afe666f0b6e55a0e5f
//   git rev-list --count v0.3.11..HEAD                       -> 65, and package.json still says 0.3.11
// The published tarball declares `"*"` for every host peer and has no capability guard (0 matches for
// MINIMUM_PI_VERSION / hostSupportsSessionProjection in its src/index.ts). So a reader following the README's pinned
// `pi install npm:@rochecompaan/pi-context-paging@0.3.11` on a Pi below the floor gets a build that installs happily
// and then dies on the first request that reads the session projection — the exact failure the peer floor and the
// session_start guard exist to prevent, and the README section that pins that install command promises the floor is
// enforced. Every gate in this repository reads the source, so nothing could see the published copy disagreeing.
//
// What it compares, inside the artifact the registry serves for the advertised version:
//   - each host peer range against the repository's manifest (the floor the README promises installers),
//   - the capability guard against the published source (the guard the status command and README describe).
// A version that is not on the registry is a pre-release state, not a defect: exit 0, the tag publishes it.
//
// Network: read-only registry reads. This runs in CI, not in `npm run check` — the publish hook has to work offline
// (pinned in tests/host-compat-contract.test.ts), and a registry read does not.
// Test seam: PUBLISHED_ARTIFACT_DIR points at an extracted tarball root and skips the registry, so the pass path and
// the missing-guard path are checkable offline and deterministically.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
const GUARD_PATTERN = /MINIMUM_PI_VERSION|hostSupportsSessionProjection/;

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

function npmView(spec, field) {
	try {
		return execFileSync("npm", ["view", spec, field], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function extractPublished(name, version) {
	const workspace = mkdtempSync(join(tmpdir(), "published-artifact-"));
	try {
		const tarball = execFileSync("npm", ["pack", `${name}@${version}`, "--silent", "--pack-destination", workspace], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim().split("\n").at(-1);
		const file = join(workspace, tarball.includes("/") ? tarball.split("/").pop() : tarball);
		execFileSync("tar", ["xzf", file, "-C", workspace], { stdio: "ignore" });
		return { dir: join(workspace, "package"), cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(workspace, { recursive: true, force: true });
		throw new Error(`cannot read the published artifact for ${name}@${version}: ${error.message}`);
	}
}

const fixture = process.env.PUBLISHED_ARTIFACT_DIR;
let published;
if (fixture) {
	published = { dir: fixture, cleanup: () => {} };
} else {
	const exists = npmView(`${manifest.name}@${manifest.version}`, "version");
	if (!exists) {
		console.log(`PUBLISHED ARTIFACT: ${manifest.name}@${manifest.version} is not on the registry yet — nothing to compare.`);
		process.exit(0);
	}
	published = extractPublished(manifest.name, manifest.version);
}

try {
	const publishedManifest = JSON.parse(readFileSync(join(published.dir, "package.json"), "utf8"));
	const problems = [];
	for (const peer of HOST_PEERS) {
		const wanted = manifest.peerDependencies?.[peer];
		const got = publishedManifest.peerDependencies?.[peer];
		if (wanted === got) continue;
		problems.push(`${peer}: registry says ${JSON.stringify(got)}, this repository's contract is ${JSON.stringify(wanted)}`);
	}
	let guardSource;
	try {
		guardSource = readFileSync(join(published.dir, "src", "index.ts"), "utf8");
	} catch {
		guardSource = "";
		problems.push("src/index.ts is missing from the published artifact, so the host-capability guard cannot be verified");
	}
	if (guardSource && !GUARD_PATTERN.test(guardSource)) {
		problems.push("the published src/index.ts has no host-capability guard (no MINIMUM_PI_VERSION / hostSupportsSessionProjection): an install below the floor registers the tools and dies on the first request that reads the session projection");
	}

	if (problems.length === 0) {
		console.log(`PUBLISHED ARTIFACT: ${publishedManifest.name}@${publishedManifest.version} carries the peer floor and the capability guard.`);
		process.exit(0);
	}

	console.log(`PUBLISHED ARTIFACT: ${publishedManifest.name}@${publishedManifest.version} on the registry does not carry this repository's compatibility contract:`);
	for (const problem of problems) console.log(`  - ${problem}`);
	console.log("The README pins an install command for this version, so readers are sent to a build whose guarantees are the old ones.");
	console.log("Fix: publish a version that carries the contract (bump package.json, keep README and CHANGELOG in step, tag it), or correct the contract in the source if the published build is the intended one.");
	process.exit(1);
} finally {
	published.cleanup();
}
