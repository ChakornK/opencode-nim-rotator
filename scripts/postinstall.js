#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_PATH = join(CONFIG_DIR, "opencode.json");
const MAIN_SPEC = "@hallaxius/opencode-nim-rotator";
const TUI_SPEC = "@hallaxius/opencode-nim-rotator/tui";

async function install() {
	console.log(
		"\n+=============================================================+",
	);
	console.log("|  NVIDIA NIM API Key Rotator - Installer                    |");
	console.log(
		"+=============================================================+\n",
	);

	const hasSpec = (plugin, spec) =>
		plugin.some((p) => {
			if (typeof p === "string") return p === spec;
			if (Array.isArray(p)) return p[0] === spec;
			return false;
		});

	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = await readFile(CONFIG_PATH, "utf-8");
			const config = JSON.parse(raw);

			config.plugin = config.plugin || [];

			for (const spec of [MAIN_SPEC, TUI_SPEC]) {
				if (!hasSpec(config.plugin, spec)) {
					config.plugin.push(spec);
					console.log(`Added "${spec}" to opencode.json plugin list`);
				} else {
					console.log(`"${spec}" already in opencode.json - skipping`);
				}
			}

			await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
				mode: 0o600,
			});
		} catch (err) {
			console.warn("Could not update opencode.json:", err);
		}
	} else {
		console.log(
			"[INFO] No opencode config found at ~/.config/opencode/opencode.json",
		);
		console.log("");
		console.log(
			"  To use this plugin, add the following to your opencode.json:",
		);
		console.log("");
		console.log('    "plugin": [');
		console.log(`      "${MAIN_SPEC}",`);
		console.log(`      "${TUI_SPEC}"`);
		console.log("    ]");
		console.log("");
		console.log("  If you use a project-level .opencode/opencode.json,");
		console.log("  add it there instead of the global config.");
		console.log("");
		console.log(
			"  Then restart opencode for the changes to take effect.\n",
		);
	}

	console.log("Next steps:");
	console.log("  1. Add at least one NVIDIA NIM API key via:");
	console.log("       bun opencode-nim-rotator");
	console.log("  2. Restart opencode - the plugin will be ready\n");
}

await install().catch((err) => {
	console.error("Installation failed:", err);
	process.exit(1);
});
