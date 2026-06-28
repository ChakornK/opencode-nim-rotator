import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyEntry, KeyStore, ModelBlacklistEntry } from "./types.js";

const STORE_FILENAME = "nim-rotator-keys.json";
const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "opencode");

export function getStorePath(configDir?: string): string {
	if (process.env.NIM_ROTATOR_STORE_PATH) {
		return process.env.NIM_ROTATOR_STORE_PATH;
	}
	const base = configDir ?? DEFAULT_CONFIG_DIR;
	return join(base, STORE_FILENAME);
}

export function loadStoreReadonly(configDir?: string): KeyStore | null {
	const storePath = getStorePath(configDir);
	try {
		if (!existsSync(storePath)) return null;
		const raw = readFileSync(storePath, "utf-8");
		const data = JSON.parse(raw);
		if (typeof data !== "object" || data === null) return null;
		if (!data.keys || !Array.isArray(data.keys)) return null;
		return {
			keys: data.keys ?? [],
			currentIndex:
				typeof data.currentIndex === "number" ? data.currentIndex : 0,
			rotationStrategy: data.rotationStrategy ?? "round-robin",
			updatedAt: data.updatedAt ?? 0,
			lastUsedKeyId: data.lastUsedKeyId,
			fallbackChain: Array.isArray(data.fallbackChain)
				? data.fallbackChain
				: [],
			maxRateLimitFailures:
				typeof data.maxRateLimitFailures === "number"
					? data.maxRateLimitFailures
					: 3,
		} as KeyStore;
	} catch {
		return null;
	}
}

export function formatKeyStatus(keys: ApiKeyEntry[], now: number): string {
	if (keys.length === 0) return "No keys configured";
	const lines: string[] = [];
	for (const k of keys) {
		const enabled = k.enabled ? "ON" : "OFF";
		const rateStr =
			k.rateLimitCount > 0 ? ` [${k.rateLimitCount} rate-limits]` : "";
		const blacklisted: string[] = [];
		if (k.modelBlacklist) {
			for (const [modelId, slot] of Object.entries(k.modelBlacklist)) {
				const entry = slot as ModelBlacklistEntry;
				if (entry.blacklistedUntil > now) {
					const secs = Math.ceil((entry.blacklistedUntil - now) / 1000);
					blacklisted.push(`${modelId} (${secs}s)`);
				}
			}
		}
		const blStr =
			blacklisted.length > 0 ? ` BLACKLISTED: ${blacklisted.join(", ")}` : "";
		const nameStr = k.name.padEnd(12);
		lines.push(`  ${nameStr} ${enabled}${rateStr}${blStr}`);
	}
	return lines.join("\n");
}

export function getBlacklistedModels(
	keys: ApiKeyEntry[],
	now: number,
): Array<{
	keyId: string;
	keyName: string;
	modelId: string;
	remainingSecs: number;
	nextDurationMs: number;
}> {
	const results: Array<{
		keyId: string;
		keyName: string;
		modelId: string;
		remainingSecs: number;
		nextDurationMs: number;
	}> = [];
	for (const k of keys) {
		if (!k.modelBlacklist) continue;
		for (const [modelId, slot] of Object.entries(k.modelBlacklist)) {
			const entry = slot as ModelBlacklistEntry;
			if (entry.blacklistedUntil > now) {
				results.push({
					keyId: k.id,
					keyName: k.name,
					modelId,
					remainingSecs: Math.ceil((entry.blacklistedUntil - now) / 1000),
					nextDurationMs: entry.nextDurationMs,
				});
			}
		}
	}
	return results;
}
