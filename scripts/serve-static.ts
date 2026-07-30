import { parseArgs } from "node:util";

const args = process.argv.slice(2);
const { tokens } = parseArgs({
  args,
  options: {},
  strict: false,
  allowPositionals: true,
  tokens: true,
});
const parsedArgs = [...new Set(tokens.map((token) => token.index))].flatMap((index) => {
  const arg = args[index];
  return arg === undefined ? [] : [arg];
});
const dir = parsedArgs[0] ?? "dist";
const port = Number(parsedArgs[1] ?? "3000");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${dir}${filePath}`);
    if (await file.exists()) return new Response(file);
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Serving ${dir} on http://0.0.0.0:${port}`);
