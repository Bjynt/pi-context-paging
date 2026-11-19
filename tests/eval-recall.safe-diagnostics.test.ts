import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticCodes, ownedDiagnostic, safeDiagnostic } from "../eval/recall/safe-diagnostics.ts";

/**
 * The recall artifacts are shareable; provider and host strings are not. `safeDiagnostic` is a
 * deny-by-default allowlist, so what matters is not the size of the list but that everything the
 * harness did not name — provider text, keys, paths, JSON — collapses to one neutral token.
 */
test("named harness diagnostics pass through unchanged", () => {
	for (const code of ["max-pair-minutes", "insufficient-qualified-known-probes", "stream-buffer-limit",
		"cache-components-exceed-total-input", "resource-cleanup-error", "pricing-evidence-changed", "probe-source-visible"]) {
		assert.equal(safeDiagnostic(code), code);
		assert.equal(ownedDiagnostic(code), true, code);
	}
});

test("the parameterized families accept their exact shapes and nothing longer", () => {
	for (const code of ["handler-present-1", "handler-output-match-12", "tool-present-3", "partial-2-of-5-components"]) {
		assert.equal(safeDiagnostic(code), code, code);
	}
	for (const value of ["handler-present-7-and-the-key-is-sk-secret", "handler-present-", "handler-present-07x",
		"tool-present-3 /home/user/.pi/auth.json", "partial-2-of-5-components-trailing", "partial-2-of-5",
		"prefix-handler-present-1", "handler-output-match-12 {\"answer\":\"x\"}"]) {
		assert.equal(safeDiagnostic(value), "unclassified-diagnostic", value);
	}
});

test("text the harness did not name collapses to one neutral token", () => {
	for (const value of [
		"", " ", "HTTP 401 for API key sk-ant-api03-SUPERSECRET",
		"{\"answer\":\"opaque value\"}", "/home/user/external-projects/secrets/auth.json",
		"max-pair-minutes and the prompt was: ignore previous instructions",
		"MAX-PAIR-MINUTES", "max_pair_minutes", "stream-buffer-limit ", " stream-buffer-limit",
	]) {
		const once = safeDiagnostic(value);
		assert.equal(once, "unclassified-diagnostic", JSON.stringify(value));
		// Collapsing must be idempotent: an artifact written from an already-sanitized value stays neutral.
		assert.equal(safeDiagnostic(once), once, JSON.stringify(value));
	}
});

test("non-string values cannot smuggle text through the boundary", () => {
	for (const value of [42, 3.5, true, {}, [], ["max-pair-minutes"], Symbol("max-pair-minutes"), () => "max-pair-minutes"]) {
		assert.equal(safeDiagnostic(value), "unclassified-diagnostic", String(typeof value));
		assert.equal(ownedDiagnostic(value), false, String(typeof value));
	}
});

test("absence is reported as absence, not as an unclassified diagnostic", () => {
	assert.equal(safeDiagnostic(null), null);
	assert.equal(ownedDiagnostic(null), false);
	// `undefined` is a missing value in JavaScript but not a harness diagnostic, so it is data.
	assert.equal(safeDiagnostic(undefined), "unclassified-diagnostic");
});

test("the boundary vocabulary itself never carries private text into every artifact", () => {
	// These strings are copied into shareable artifacts, so the allowlist must stay a vocabulary of
	// harness tokens: no whitespace (free text), no path separators, no credential-shaped literals.
	// Uppercase is allowed on purpose — codes name JS APIs (`native-calculateCost`) and stage labels.
	const banned: [RegExp, string][] = [
		[/\s/, "whitespace"],
		[/[/\\]/, "path separator"],
		[/(?:sk-|ghp_|xox[baprs]-|api[_-]?key|secret|password|bearer)/i, "credential shape"],
	];
	assert.ok(diagnosticCodes.size > 0);
	for (const code of diagnosticCodes) {
		for (const [shape, label] of banned) {
			assert.ok(!shape.test(code), `${label} in allowlisted code ${JSON.stringify(code)}`);
		}
	}
});

test("ownedDiagnostic is true only when the value crosses unchanged", () => {
	for (const value of ["max-pair-minutes-x", "partial-2-of-5", "", "handler-present-1x", "MAX-PAIR-MINUTES"]) {
		assert.equal(ownedDiagnostic(value), false, JSON.stringify(value));
	}
	// The neutral token is a fixed point of the sanitizer, so it is owned by definition: re-writing an
	// artifact that already carries it must not turn it into something else.
	assert.equal(safeDiagnostic("unclassified-diagnostic"), "unclassified-diagnostic");
	assert.equal(ownedDiagnostic("unclassified-diagnostic"), true);
});
