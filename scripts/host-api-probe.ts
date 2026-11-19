import { writeFileSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Calls the host APIs that the packed extension executes on a live request path, and records what this host
 * is missing. Registration is not the risk: the extension registers fine under a host whose session manager,
 * entry shapes, or module exports it then calls and does not find, because `.ts` is transpiled by the host's
 * jiti loader and a missing method is a TypeError at call time, not at load time.
 *
 * Access is structural on purpose. Naming `sessionManager.buildSessionProjection` in the types would make this
 * file fail typecheck against an older host, which is the very condition being measured here; the probe has to
 * compile everywhere so it can run everywhere and report the runtime truth.
 */
type LooseHost = Record<string, unknown>;

export default function hostApiProbe(pi: ExtensionAPI): void {
	pi.registerCommand("host-api-probe", {
		description: "Call the host APIs the packed paging extension depends on, and write the outcome",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const output = process.env.PI_HOST_API_PROBE_OUTPUT;
			if (!output) throw new Error("PI_HOST_API_PROBE_OUTPUT is required");

			const missing: string[] = [];
			const call = (label: string, invoke: () => unknown): void => {
				try {
					invoke();
				} catch (error) {
					missing.push(`${label} — ${(error as Error).message}`);
				}
			};

			const manager = ctx.sessionManager as unknown as LooseHost;
			for (const method of ["getBranch", "buildSessionProjection"]) {
				call(`sessionManager.${method}()`, () => {
					const methodValue = manager[method];
					if (typeof methodValue !== "function") throw new Error(`it is ${typeof methodValue} on this host`);
					(methodValue as () => unknown).call(manager);
				});
			}
			call("isProjectTrusted()", () => {
				ctx.isProjectTrusted();
			});
			call("pi.getActiveTools() / pi.getAllTools()", () => {
				pi.getActiveTools();
				pi.getAllTools();
			});
			// src/stats.ts imports this by name from the host at runtime.
			try {
				const host = (await import("@earendil-works/pi-coding-agent")) as LooseHost;
				if (typeof host.sessionEntryToContextMessages !== "function") {
					missing.push(`sessionEntryToContextMessages export — this host exports ${typeof host.sessionEntryToContextMessages}`);
				}
			} catch (error) {
				missing.push(`sessionEntryToContextMessages export — ${(error as Error).message}`);
			}

			writeFileSync(output, JSON.stringify({ ok: missing.length === 0, missing }));
		},
	});
}
