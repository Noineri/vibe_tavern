const root = process.argv[2] ?? ".";
const { readdir } = await import("node:fs/promises");
const proc = Bun.spawn(["bun", "scripts/install-platform-optionals.ts"], {
  cwd: root,
  env: { ...process.env, DRY_RUN: "1" },
  stdout: "pipe",
  stderr: "inherit",
});
const out = await new Response(proc.stdout).text();
const code = await proc.exited;
if (code !== 0) { console.error("oracle exited", code); process.exit(1); }
const specs = [...out.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]);
if (specs.length < 3) { console.error("oracle listed <3 specs:", specs.length); process.exit(1); }
const entries = await readdir(`${root}/node_modules/.bun`);
const missing: string[] = [];
for (const spec of specs) {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at), ver = spec.slice(at + 1);
  const mangled = `${name.replace("/", "+")}@${ver}`;
  const dir = entries.find((e) => e.startsWith(mangled));
  if (!dir) { missing.push(`${spec} (no store dir)`); continue; }
  if (!(await Bun.file(`${root}/node_modules/.bun/${dir}/node_modules/${name}/package.json`).exists())) missing.push(`${spec} (no nested pkg)`);
}
if (missing.length) { console.error("MISSING-PLATFORM-OPTIONALS:", missing.join(", ")); process.exit(1); }
console.log(`PLATFORM-OPTIONALS-OK (${specs.length}): ${specs.join(", ")}`);
