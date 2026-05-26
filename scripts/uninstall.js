#!/usr/bin/env node

import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { readFile, writeFile, unlink } from "fs/promises";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_PATH = join(CONFIG_DIR, "opencode.json");
const KEYSTORE_PATH = join(CONFIG_DIR, "nim-rotator-keys.json");

async function uninstall() {
  console.log(
    "\n+=============================================================+",
  );
  console.log("|  NVIDIA NIM API Key Rotator - Uninstaller                  |");
  console.log(
    "+=============================================================+\n",
  );

  let configModified = false;

  // Remove plugin from opencode.json
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);

      if (Array.isArray(config.plugin)) {
        const beforeLength = config.plugin.length;
        config.plugin = config.plugin.filter(function (p) {
          if (typeof p === "string")
            return p !== "opencode-nvidia-nim-key-rotator";
          if (Array.isArray(p))
            return p[0] !== "opencode-nvidia-nim-key-rotator";
          return true;
        });

        if (config.plugin.length !== beforeLength) {
          await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
            mode: 0o600,
          });
          console.log(
            "Removed opencode-nvidia-nim-key-rotator from opencode.json plugin list",
          );
          configModified = true;
        } else {
          console.log("Plugin was not found in opencode.json - skipping");
        }
      } else {
        console.log("No plugins array in opencode.json - skipping");
      }
    } catch (err) {
      console.warn("Could not update opencode.json:", err);
    }
  } else {
    console.log("opencode.json not found - skipping");
  }

  // Remove key store file
  if (existsSync(KEYSTORE_PATH)) {
    try {
      await unlink(KEYSTORE_PATH);
      console.log("Removed key store file: " + KEYSTORE_PATH);
    } catch (err) {
      console.warn("Could not remove key store file:", err);
    }
  } else {
    console.log("Key store file not found - skipping");
  }

  console.log(
    "\nUninstall complete." +
      (configModified ? " Restart opencode to apply changes." : ""),
  );
}

await uninstall().catch(function (err) {
  console.error("Uninstallation failed:", err);
  process.exit(1);
});
