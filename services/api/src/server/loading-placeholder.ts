/**
 * Loading placeholder handler for Vibe Tavern server startup.
 *
 * Mounted on the Bun listener before the real Hono app is ready, then
 * swapped out once boot completes (DB open, asset scan, provider probes).
 *
 * - `GET /health` and any `/api/*` path → HTTP 503 JSON so API clients and
 *   the polling script can detect "not ready yet" via `Retry-After`.
 * - `/fonts/Alegreya-VariableFont_wght.ttf` → served from pre-loaded data
 *   (if provided) so the loading page renders in Alegreya, not a fallback.
 * - All other paths → HTTP 200 with a self-contained branded loading page
 *   that auto-polls `/health` and reloads into the real SPA when it responds.
 *
 * @returns a Bun-style fetch handler usable as a server `fetch` option.
 */
export interface LoadingHandlerOptions {
	readonly alegreyaFont?: ArrayBuffer | null;
}

const ALEGREYA_FONT_PATH = '/fonts/Alegreya-VariableFont_wght.ttf';

export function createLoadingHandler(
	options: LoadingHandlerOptions = {},
): (req: Request, server: Bun.Server<undefined>) => Response | Promise<Response> {
	return (req: Request, _server: Bun.Server<undefined>): Response => {
		const path = new URL(req.url).pathname;

		if (options.alegreyaFont && req.method === 'GET' && path === ALEGREYA_FONT_PATH) {
			return new Response(options.alegreyaFont, {
				status: 200,
				headers: {
					'Content-Type': 'font/ttf',
					'Cache-Control': 'public, max-age=86400',
				},
			});
		}

		// API clients and health probes get a structured 503 so they retry.
		const isHealth = req.method === 'GET' && path === '/health';
		const isApi = path.startsWith('/api/');
		if (isHealth || isApi) {
      return new Response(
        JSON.stringify({
          ok: false,
          service: 'vibe-tavern-api',
          error: 'Server is still starting up',
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '2',
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    // Everything else gets the branded loading page.
    return new Response(LOADING_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  };
}

/**
 * Self-contained loading page HTML.
 *
 * Theme tokens lifted verbatim from apps/web/src/themes/dark.css:
 * - background `#141210` (--bg, deepest espresso layer)
 * - primary text `#d1d0ba` (--t1, warm cream)
 * - accent `oklch(0.72 0.14 75)` (--accent, golden)
 *
 * Animation: three pulsing dots reusing the app's existing `genp`
 * keyframe rhythm (1.3s ease-in-out, staggered .18s) — the same indicator
 * the chat UI shows while a message is generating, so the loading state
 * feels native. The 🍻 glyph breathes in sync. Respects reduced-motion.
 */
const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibe Tavern — Loading</title>
<style>
  @font-face{
    font-family:'Alegreya';
    src:url('/fonts/Alegreya-VariableFont_wght.ttf') format('truetype');
    font-weight:400 700;font-display:swap;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:2rem;
    background:#141210;color:#d1d0ba;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  .wrap{
    display:flex;flex-direction:column;align-items:center;gap:1.25rem;
    text-align:center;max-width:420px;
  }
  .glyph{
    font-size:2.5rem;line-height:1;opacity:.6;user-select:none;
    animation:breathe 1.3s ease-in-out infinite;
  }
  h1{
    font-family:'Alegreya',Georgia,serif;
    font-size:1.2rem;font-weight:500;line-height:1.55;color:#d1d0ba;
  }
  .dots{
    display:inline-flex;align-items:center;gap:4px;
    margin-left:7px;vertical-align:baseline;
  }
  .dots span{
    width:5px;height:5px;border-radius:50%;
    background:oklch(0.72 0.14 75);
    animation:genp 1.3s ease-in-out infinite;
  }
  .dots span:nth-child(2){animation-delay:.18s}
  .dots span:nth-child(3){animation-delay:.36s}
  @keyframes genp{
    0%,60%,100%{opacity:.25;transform:scale(.75)}
    30%{opacity:1;transform:scale(1)}
  }
  @keyframes breathe{
    0%,100%{opacity:.6}
    50%{opacity:.4}
  }
  @media(prefers-reduced-motion:reduce){
    .glyph,.dots span{animation:none}
    .glyph{opacity:.6}
    .dots span{opacity:.7}
  }
</style>
</head>
<body>
  <div class="wrap" role="status" aria-live="polite">
    <div class="glyph" aria-hidden="true">\u{1F37B}</div>
    <h1>Vibe Tavern is loading, please wait<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span></h1>
  </div>
  <script>
    // Poll /health every 1s; when the server responds HTTP 200, reload into the real SPA.
    (function poll(){
      fetch('/health',{cache:'no-store'})
        .then(function(r){if(r.ok)window.location.reload();})
        .catch(function(){})
        .finally(function(){setTimeout(poll,1000);});
    })();
  </script>
</body>
</html>`;
