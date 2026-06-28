#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_PATH = join(CONFIG_DIR, "opencode.json");

async function install() {
	console.log(
		"\n+=============================================================+",
	);
	console.log("|  NVIDIA NIM API Key Rotator - Installer                    |");
	console.log(
		"+=============================================================+\n",
	);

	await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = await readFile(CONFIG_PATH, "utf-8");
			const config = JSON.parse(raw);

			config.plugin = config.plugin || [];
			const SERVER_SPEC = "@hallaxius/opencode-nim-rotator/server";
			const TUI_SPEC = "@hallaxius/opencode-nim-rotator/tui";

			const hasSpec = (spec) =>
				config.plugin.some((p) => {
					if (typeof p === "string") return p === spec;
					if (Array.isArray(p)) return p[0] === spec;
					return false;
				});

			const needsServer = !hasSpec(SERVER_SPEC);
			const needsTui = !hasSpec(TUI_SPEC);

			if (needsServer || needsTui) {
				if (needsServer) config.plugin.push(SERVER_SPEC);
				if (needsTui) config.plugin.push(TUI_SPEC);
				await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
					mode: 0o600,
				});
				const added = [];
				if (needsServer) added.push(SERVER_SPEC);
				if (needsTui) added.push(TUI_SPEC);
				console.log(`Added to opencode.json plugin list: ${added.join(", ")}`);
			} else {
				console.log("Plugins already in opencode.json - skipping");
			}
		} catch (err) {
			console.warn("Could not update opencode.json:", err);
		}
	} else {
		const config = {
				plugin: [
					"@hallaxius/opencode-nim-rotator/server",
					"@hallaxius/opencode-nim-rotator/tui",
				],
			};
		await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
		});
		console.log("Created opencode.json with plugin entry");
	}

	console.log("\nNext steps:");
	console.log("  1. Run: bun opencode-nim-rotator  (to manage your API keys)");
	console.log("  2. Add at least one NVIDIA NIM API key via the TUI");
	console.log(
		"  3. Restart opencode - the plugin will auto-rotate your keys\n",
	);
}

await install().catch((err) => {
	console.error("Installation failed:", err);
	process.exit(1);
});
