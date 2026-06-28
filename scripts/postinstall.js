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

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);

      config.plugin = config.plugin || [];
      const hasPlugin = config.plugin.some(function (p) {
        if (typeof p === "string") return p === "@hallaxius/opencode-nim-rotator";
        if (Array.isArray(p)) return p[0] === "@hallaxius/opencode-nim-rotator";
        return false;
      });

      if (!hasPlugin) {
        config.plugin.push("@hallaxius/opencode-nim-rotator");
        await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
          mode: 0o600,
        });
        console.log("Added @hallaxius/opencode-nim-rotator to opencode.json plugin list");
      } else {
        console.log("Plugin already in opencode.json - skipping");
      }
    } catch (err) {
      console.warn("Could not update opencode.json:", err);
    }
  } else {
    const config = { plugin: ["@hallaxius/opencode-nim-rotator"] };
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
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

await install().catch(function (err) {
  console.error("Installation failed:", err);
  process.exit(1);
});
