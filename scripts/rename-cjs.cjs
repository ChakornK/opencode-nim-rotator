const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "dist", "cjs");
if (!fs.existsSync(dir)) {
	console.error("dist/cjs does not exist");
	process.exit(1);
}

for (const f of fs.readdirSync(dir)) {
	if (f.endsWith(".js")) {
		const oldPath = path.join(dir, f);
		const newPath = path.join(dir, f.replace(/\.js$/, ".cjs"));

		// Fix internal require() paths ("./errors.js" -> "./errors.cjs")
		let content = fs.readFileSync(oldPath, "utf-8");
		content = content.replace(
			/(require\(["']\.[^"']*)\.js(["']\))/g,
			"$1.cjs$2",
		);
		fs.writeFileSync(newPath, content, "utf-8");

		// Delete old .js file
		fs.unlinkSync(oldPath);
		console.log(`Renamed ${f} -> ${path.basename(newPath)} (fixed imports)`);
	}
}
