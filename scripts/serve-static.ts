const dir = process.argv[2] ?? "dist";
const port = Number(process.argv[3] ?? "3000");

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
