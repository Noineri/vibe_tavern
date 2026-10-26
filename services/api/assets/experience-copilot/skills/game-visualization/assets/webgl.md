# WebGL in the visual

Supporting file of `game-visualization`. Read it before you reach for WebGL: a shader-lit background, hundreds of particles, or a real 3D object such as a die or a board seen at an angle.

WebGL works in the mini-app frame: the frame's sandbox and content security policy allow a `webgl` and a `webgl2` context, shader compilation and drawing (verified 2026-10-23). The frame has no network and no libraries, so WebGL here is always hand-written: no three.js, no imports, no shader or model files. Everything lives in the one visual source.

## Choose it only when it pays

Prefer CSS and 2D canvas. They cover most cards, boards, counters and UI, they are easier to keep readable, and `depth-and-3d.md` already gives cards and dice real CSS 3D.

WebGL is worth it when:

- **Light and texture fill the scene**: a background with moving light, water, fog, a glowing field, done in a fragment shader.
- **Many moving things**: hundreds of particles or sparks, where DOM elements would be slow.
- **A real 3D object** the player watches turn freely: a die rolling in space, a board tilted at an angle with lit pieces.

If none of these apply, build it in CSS or canvas.

## Rules

- **Logic stays in the rules.** The shader only draws what the projected view says. Never decide a hit, a score or a die's result on the GPU or in drawing code; the rules (or the host's dice) decide, and the picture shows it.
- **Text and controls stay HTML**, layered over the canvas: labels, scores, buttons and messages are real elements with `textContent`, readable and clickable. For a 3D object the player clicks, put a transparent HTML button over where the object is drawn, sized from the same layout numbers.
- **Follow the declared light.** Use the visual's one light direction (Step 2 of `SKILL.md`) for the shader's light vector, so the WebGL part matches the CSS parts.
- **Always have a fallback.** `getContext` can return `null` (old device, disabled GPU, too many contexts). Then show the CSS / 2D version of the same scene. The game must stay playable without WebGL.
- **Respect the device.** Size the drawing buffer from the CSS box times `devicePixelRatio`, capped at 2. Keep fragment shaders short; a full-screen shader runs for every pixel of every frame. When the user prefers reduced motion (`matchMedia('(prefers-reduced-motion: reduce)')`), draw one frame per view change instead of animating.

## A complete template

A shader background with moving light behind an HTML HUD, with the fallback, error display, resizing and context loss handled. Copy it, then change the fragment shader and the drawing.

```html
<style>
  #scene { position: relative; width: min(100%, 440px); aspect-ratio: 440 / 620; margin: 0 auto; overflow: hidden; border-radius: 12px; background: #1b2236; }
  #gl { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #hud { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 14px; color: #f4efe2; font: 15px/1.3 system-ui, sans-serif; }
  #gl-error { display: none; position: absolute; left: 8px; right: 8px; bottom: 8px; font: 12px/1.3 monospace; color: #ffd2c4; background: rgba(0,0,0,.6); padding: 6px; border-radius: 6px; white-space: pre-wrap; }
  #scene.no-webgl { background: radial-gradient(circle at 30% 25%, #3d4f7a, #1b2236 70%); } /* the CSS fallback */
</style>
<div id="xp-root">
  <div id="scene">
    <canvas id="gl"></canvas>
    <div id="hud"><div id="title"></div><div id="status"></div></div>
    <div id="gl-error"></div>
  </div>
</div>
<script>
(function () {
  var root = document.getElementById('xp-root');
  var scene = document.getElementById('scene');
  var canvas = document.getElementById('gl');
  var errorBox = document.getElementById('gl-error');
  var xp, lastView = null, gl = null, program = null, uTime, uRes, frame = 0;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var VERT = 'attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }';
  var FRAG = [
    'precision mediump float;',
    'uniform float u_time; uniform vec2 u_res;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  vec2 light = vec2(0.3 + 0.1 * sin(u_time * 0.4), 0.8);', // the declared light: top left
    '  float glow = 0.35 / (0.35 + 4.0 * distance(uv, light));',
    '  vec3 base = mix(vec3(0.10, 0.13, 0.21), vec3(0.24, 0.31, 0.48), uv.y);',
    '  gl_FragColor = vec4(base + glow * vec3(1.0, 0.86, 0.6), 1.0);',
    '}'
  ].join('\n');

  function showError(text) { errorBox.textContent = text; errorBox.style.display = 'block'; }

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error((type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') + ' shader: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function setup() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(program));
    gl.useProgram(program);
    var buffer = gl.createBuffer(); // one triangle that covers the whole canvas
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    uTime = gl.getUniformLocation(program, 'u_time');
    uRes = gl.getUniformLocation(program, 'u_res');
  }

  function fitCanvas() {
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    var h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function draw(timeMs) {
    if (!gl || !program || gl.isContextLost()) return;
    fitCanvas();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(uTime, timeMs / 1000);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function loop(timeMs) {
    draw(timeMs);
    var finished = lastView && lastView.status === 'completed';
    frame = (reduceMotion || finished) ? 0 : requestAnimationFrame(loop);
  }

  function start() {
    gl = canvas.getContext('webgl');
    if (!gl) { scene.classList.add('no-webgl'); return; } // the CSS fallback keeps the game playable
    try { setup(); } catch (e) { showError(e.message); gl = null; scene.classList.add('no-webgl'); return; }
    if (!frame) frame = requestAnimationFrame(loop);
  }

  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); cancelAnimationFrame(frame); frame = 0; });
  canvas.addEventListener('webglcontextrestored', function () { program = null; start(); });

  function render(view) {
    lastView = view;
    document.getElementById('title').textContent = 'Night garden';
    document.getElementById('status').textContent = view.status === 'completed' ? 'Finished' : 'Your move';
    if (gl && !frame) frame = requestAnimationFrame(loop); // one frame (reduced motion) or restart the loop
    if (xp) xp.resize(root.scrollWidth, root.scrollHeight);
  }

  start();
  xp = window.VibeExperience.connect(render, {
    onError: function (err) { document.getElementById('status').textContent = err.message; }
  });
})();
</script>
```

In a realtime frame, do the same work inside the `xp.onTick` callback: store the view and draw it there instead of in a separate animation loop.

## Real 3D objects

For a die or a tilted board you need what the template leaves out: vertices with normals, a depth buffer and matrices.

- **Geometry.** Write the vertices by hand: a cube is 24 vertices (4 per face, each face with its own normal) and 36 indices. Round the look in the shader, not with more vertices.
- **Depth.** Call `gl.enable(gl.DEPTH_TEST)` and clear with `gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)` every frame.
- **Matrices.** Write a small perspective matrix and the rotation you need (column-major `Float32Array(16)`), multiply them in JavaScript and pass the result as a uniform. Keep them in one helper block; there is no math library.
- **Light.** Simple diffuse plus one specular highlight, with the light vector from the visual's declared light. The material rules of Step 4 still apply: sharp small highlight for polished, wide soft one for matte.
- **Faces and pips.** Draw pips in the fragment shader from the face's coordinates, or paint the six faces into a 2D canvas once and upload it as a texture (`texImage2D` from that canvas works; there are no image files).
- **The result comes from the game.** Animate the tumble, then land on the face the rules or the host's dice already decided. Never read the result from the animation.

## Checks before handing over

- Turn off WebGL in your head: does the fallback show a complete, playable scene?
- A shader error shows its text on the page, because you cannot see the frame's console; if the user reports a dark scene, ask them to read you that line.
- At a phone width the canvas stays sharp but not oversized (ratio capped at 2), and the HUD text stays readable over the brightest part of the shader.
- The loop stops when the game is finished, and reduced motion gives a still picture.
