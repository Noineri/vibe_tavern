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
 * Self-contained branded loading page — the animated Vibe Tavern logo.
 *
 * The logo is the `vt_sign` mark (open book + three stars). The three stars
 * rise from the book, circle it in a tight "chase train" with an inertial
 * gravity whip at the bottom, and settle back into the resting pose — the
 * same animation the React `<Logo animated>` shows, mirrored here in vanilla
 * JS so it runs before the SPA bundle loads. Source of truth for the motion
 * math is `apps/web/src/components/shared/vt-logo.ts`; keep the inline
 * `MOTION` script below in sync with `starPositionAt` there.
 *
 * Theme-aware: an inline head script reads `vibe-tavern.theme` from
 * localStorage and sets `--bg` / `--t1` / `--accent` / `--accent-mid` from a
 * small lookup table (source: `apps/web/src/themes/*.css`, keep in sync).
 * Defaults to the `coffee` theme so first-time visitors still get a correct,
 * branded paint. Respects `prefers-reduced-motion` (stars park at rest).
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
  :root{
    /* Coffee defaults — overridden before first paint by the theme script. */
    --bg:oklch(0.184 0.0052 67.5);
    --t1:oklch(0.852 0.0298 104.9);
    --accent:oklch(0.72 0.14 75);
    --accent-mid:oklch(0.55 0.105 75);
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:2rem;
    background:var(--bg);color:var(--t1);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
    transition:background .3s ease,color .3s ease;
  }
  .wrap{
    display:flex;flex-direction:column;align-items:center;gap:1.5rem;
    text-align:center;max-width:420px;
  }
  .logo{width:220px;height:220px;}
  .logo svg{width:100%;height:100%;overflow:visible;display:block;}
</style>
</head>
<body>
  <div class="wrap" role="status" aria-live="polite">
    <div class="logo">
      <svg viewBox="-22.5 -52 330 330" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M228.277 60.5653L169.085 141.858L261.622 83.8188L269.364 96.163L176.183 154.606L281.244 126.197L285.047 140.264L159.958 174.088C158.598 165.58 151.226 159.078 142.334 159.078C133.476 159.078 126.127 165.53 124.726 173.99L0 140.264L3.80371 126.197L108.864 154.606L15.6831 96.163L23.4258 83.8188L115.962 141.858L56.7705 60.5653L68.5498 51.9882L142.523 153.582L216.498 51.9882L228.277 60.5653Z" style="fill:var(--accent-mid)"/>
        <g id="s0" transform="translate(169.07 30.35)"><path class="star" d="M165.904 2.23722C166.998 -0.68871 171.137 -0.68873 172.23 2.23722L178.572 19.1986C178.86 19.9707 179.422 20.6109 180.149 20.998L192.127 27.3681C194.515 28.6384 194.515 32.0607 192.127 33.331L180.149 39.7011C179.422 40.0881 178.86 40.7283 178.572 41.5004L172.23 58.4618C171.137 61.3878 166.998 61.3878 165.904 58.4618L159.563 41.5004C159.274 40.7283 158.713 40.0881 157.985 39.7011L146.008 33.331C143.62 32.0607 143.62 28.6384 146.008 27.3681L157.985 20.998C158.713 20.6109 159.274 19.9707 159.563 19.1986L165.904 2.23722Z" transform="translate(-169.07 -30.35)" style="fill:var(--accent)"/></g>
        <g id="s1" transform="translate(124.05 66.88)"><path class="star" d="M122.963 49.1806C123.338 48.1762 124.759 48.1762 125.135 49.1806L129.501 60.8603C129.6 61.1253 129.793 61.3451 130.042 61.4779L138.271 65.8539C139.091 66.29 139.091 67.4652 138.271 67.9013L130.042 72.2777C129.793 72.4106 129.6 72.63 129.501 72.8949L125.135 84.5746C124.759 85.579 123.338 85.579 122.963 84.5746L118.597 72.8949C118.498 72.63 118.305 72.4106 118.055 72.2777L109.826 67.9013C109.006 67.4652 109.006 66.29 109.826 65.8539L118.055 61.4779C118.305 61.3451 118.498 61.1253 118.597 60.8603L122.963 49.1806Z" transform="translate(-124.05 -66.88)" style="fill:var(--accent)"/></g>
        <g id="s2" transform="translate(111.59 13.97)"><path class="star" d="M110.472 0.778726C110.86 -0.259575 112.329 -0.259575 112.717 0.778726L115.842 9.1381C115.945 9.41208 116.144 9.63943 116.402 9.77677L122.297 12.912C123.145 13.3628 123.145 14.5775 122.297 15.0282L116.402 18.164C116.144 18.3013 115.945 18.5282 115.842 18.8022L112.717 27.1615C112.329 28.1998 110.86 28.1998 110.472 27.1615L107.347 18.8022C107.244 18.5282 107.045 18.3013 106.787 18.164L100.891 15.0282C100.044 14.5775 100.044 13.3628 100.891 12.912L106.787 9.77677C107.045 9.63942 107.244 9.41209 107.347 9.1381L110.472 0.778726Z" transform="translate(-111.59 -13.97)" style="fill:var(--accent)"/></g>
      </svg>
    </div>
  </div>
  <script>
    // Theme-aware first paint: read the stored theme id and set the CSS tokens.
    // Source: apps/web/src/themes/*.css — keep these four palettes in sync.
    (function(){
      var T={
        'coffee':{bg:'oklch(0.184 0.0052 67.5)',t1:'oklch(0.852 0.0298 104.9)',accent:'oklch(0.72 0.14 75)',mid:'oklch(0.55 0.105 75)'},
        'light':{bg:'oklch(0.975 0.003 80)',t1:'oklch(0.14 0.005 70)',accent:'oklch(0.65 0.14 40)',mid:'oklch(0.55 0.105 40)'},
        'mystic-night':{bg:'oklch(0.14 0.02 288)',t1:'oklch(0.88 0.020 80)',accent:'oklch(0.72 0.14 45)',mid:'oklch(0.55 0.105 45)'},
        'light-lava':{bg:'oklch(0.97 0.010 210)',t1:'oklch(0.25 0.02 210)',accent:'oklch(0.65 0.22 35)',mid:'oklch(0.55 0.165 35)'}
      };
      var id='coffee';
      try{var s=localStorage.getItem('vibe-tavern.theme');if(s&&T[s])id=s;}catch(e){}
      var p=T[id],r=document.documentElement.style;
      r.setProperty('--bg',p.bg);r.setProperty('--t1',p.t1);
      r.setProperty('--accent',p.accent);r.setProperty('--accent-mid',p.mid);
    })();
  </script>
  <script>
    // MOTION — mirrors starPositionAt() in apps/web/src/components/shared/vt-logo.ts.
    // Keep in sync. Stars chase around the book with an inertial bottom whip.
    (function(){
      if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      var CX=142.52,CY=113.04,R=150,DUR=3200,A=0.82,GAP=17,LOOPS=1;
      var REST_END=0.08,RISE_END=0.20,ORBIT_END=0.80;
      var S=[{cx:169.07,cy:30.35,o:0},{cx:124.05,cy:66.88,o:1},{cx:111.59,cy:13.97,o:2}];
      var N=[document.getElementById('s0'),document.getElementById('s1'),document.getElementById('s2')];
      function ei(t,p){return t<0.5?Math.pow(2*t,p)/2:1-Math.pow(-2*t+2,p)/2;}
      function lr(a,b,t){return a+(b-a)*t;}
      function it(u){return u-A*Math.sin(2*Math.PI*LOOPS*u)/(2*Math.PI*LOOPS);}
      function op(d){var r=d*Math.PI/180;return [CX+R*Math.sin(r),CY-R*Math.cos(r)];}
      function at(tt,s){
        var b=-s.o*GAP;
        if(tt<REST_END)return [s.cx,s.cy];
        if(tt<RISE_END){var u=(tt-REST_END)/(RISE_END-REST_END),e=ei(u,3),o=op(b);return [lr(s.cx,o[0],e),lr(s.cy,o[1],e)];}
        if(tt<ORBIT_END){var u=(tt-RISE_END)/(ORBIT_END-RISE_END);return op(b+it(u)*360);}
        var u=(tt-ORBIT_END)/(1-ORBIT_END),e=ei(u,4),o=op(b+LOOPS*360);
        return [lr(o[0],s.cx,e),lr(o[1],s.cy,e)];
      }
      var start=performance.now();
      (function frame(now){
        var tt=((now-start)%DUR)/DUR;
        for(var i=0;i<S.length;i++){var p=at(tt,S[i]);N[i].setAttribute('transform','translate('+p[0].toFixed(2)+' '+p[1].toFixed(2)+')');}
        requestAnimationFrame(frame);
      })(performance.now());
    })();
  </script>
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
