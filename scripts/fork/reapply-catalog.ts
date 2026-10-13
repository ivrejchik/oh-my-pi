#!/usr/bin/env bun
/**
 * Re-apply the fork's additions to catalog files upstream regenerates, then
 * recompile rules.json from the KDL sources.
 *
 *   bun scripts/fork/reapply-catalog.ts
 *
 * Upstream rewrites these files in most releases, so every merge conflicts on
 * them. merge-upstream.sh takes upstream's copies and runs this script instead
 * of resolving them by hand; verify.sh runs it to catch a stale catalog.
 * Idempotent. Needs the checkout's dependencies and natives
 * (scripts/fork/install.sh --no-launcher): gen:compat loads the native addon.
 */
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const catalog = path.join(root, "packages/catalog");

// `/login` roster: every loginable provider must be listed. Keenable goes after Exa.
const orderPath = path.join(catalog, "src/compat/rules/auth/_order.kdl");
const order = await Bun.file(orderPath).text();
if (!order.includes('"keenable"')) {
	if (!order.includes('"exa" ')) throw new Error(`${orderPath}: "exa" not found; place "keenable" by hand`);
	await Bun.write(orderPath, order.replace('"exa" ', '"exa" "keenable" '));
	console.log('Added "keenable" to login-order');
}

// Bundled web engines: Keenable's row is Exa's with its own identity.
const modelsPath = path.join(catalog, "src/models.json");
const models = JSON.parse(await Bun.file(modelsPath).text()) as Record<string, Record<string, { id: string; name: string }>>;
const web = models.web;
if (!web?.exa) throw new Error(`${modelsPath}: web.exa not found; add web.keenable by hand`);
if (!web.keenable) {
	const rows: typeof web = {};
	for (const [id, row] of Object.entries(web)) {
		rows[id] = row;
		if (id === "exa") rows.keenable = { ...structuredClone(row), id: "keenable", name: "Keenable" };
	}
	models.web = rows;
	await Bun.write(modelsPath, JSON.stringify(models));
	console.log("Added web.keenable to models.json");
}

const gen = Bun.spawnSync(["bun", "run", "gen:compat"], { cwd: catalog, stdout: "inherit", stderr: "inherit" });
if (gen.exitCode !== 0) throw new Error(`gen:compat failed with exit code ${gen.exitCode}`);
