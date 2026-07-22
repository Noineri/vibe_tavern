const root = process.argv[2] ?? ".";
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
const missing: string[] = [];
for (const spec of specs) {
  const at = spec.lastIndexOf("@");
  const mangled = `${spec.slice(0, at).replace("/", "+")}@${spec.slice(at + 1)}`;
  const hits = await Array.fromAsync(new Bun.Glob(`${mangled}*/package.json`).scan({ cwd: `${root}/node_modules/.bun` }));
  if (hits.length === 0) missing.push(spec);
}
if (missing.length) { console.error("MISSING-PLATFORM-OPTIONALS:", missing.join(", ")); process.exit(1); }
console.log(`PLATFORM-OPTIONALS-OK (${specs.length}): ${specs.join(", ")}`);
