#!/usr/bin/env node

import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";

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

  try {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);

      config.plugin = config.plugin || [];
      const PLUGIN_SPECS = [
        "@hallaxius/opencode-nim-rotator",
        "@hallaxius/opencode-nim-rotator/tui",
      ];

      let added = 0;
      for (const spec of PLUGIN_SPECS) {
        const hasPlugin = config.plugin.some(function (p) {
          if (typeof p === "string") return p === spec;
          if (Array.isArray(p)) return p[0] === spec;
          return false;
        });

        if (!hasPlugin) {
          config.plugin.push(spec);
          console.log("Added " + spec + " to opencode.json plugin list");
          added++;
        }
      }

      if (added > 0) {
        await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
          mode: 0o600,
        });
      }
    } catch (err) {
      console.warn("Could not update opencode.json:", err);
    }
  } else {
    const config = {
      plugin: [
        "@hallaxius/opencode-nim-rotator",
        "@hallaxius/opencode-nim-rotator/tui",
      ],
    };
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log("Created opencode.json with plugin entries");
  }

  console.log("\nNext steps:");
  console.log("  1. Run: bun opencode-nim-rotator  (to manage your API keys)");
  console.log("  2. Add at least one NVIDIA NIM API key via the TUI");
  console.log(
    "  3. Restart opencode - the plugin will auto-rotate your keys\n",
  );
}

await install().catch(function (err) {
  console.error("Installation failed:", err);
  process.exit(1);
});
