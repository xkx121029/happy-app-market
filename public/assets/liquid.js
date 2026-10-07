/**
 * 首屏背景：手写 WebGL 流体效果
 * 取 canvas-ui 的思路（指针驱动的流体 + 色散流动）但不引入任何依赖，
 * 在低端设备或 WebGL 不可用时静默降级为纯色底 + CSS 渐变。
 */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_ptr;
uniform float u_ptrAmp;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.02;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.055;

  vec2 ptr = (u_ptr - 0.5) * vec2(u_res.x / u_res.y, 1.0);

  vec2 q = vec2(fbm(p * 1.6 + t), fbm(p * 1.6 - t + 4.7));
  vec2 r = vec2(
    fbm(p * 1.9 + 2.4 * q + vec2(1.7, 9.2) + t * 1.4),
    fbm(p * 1.9 + 2.4 * q + vec2(8.3, 2.8) - t * 1.2)
  );
  float f = fbm(p * 2.2 + 2.2 * r);

  float d = length(p - ptr);
  float glow = smoothstep(0.85, 0.0, d) * (0.20 + u_ptrAmp * 0.60);

  vec3 ink  = vec3(0.086, 0.082, 0.059);
  vec3 deep = vec3(0.170, 0.098, 0.062);
  vec3 red  = vec3(0.824, 0.251, 0.110);
  vec3 hot  = vec3(1.000, 0.560, 0.290);

  float band = smoothstep(0.38, 0.96, f + 0.35 * r.x);
  vec3 col = mix(ink, deep, smoothstep(0.18, 0.82, q.y));
  col = mix(col, red * 0.85, band * 0.55);
  col = mix(col, hot, smoothstep(0.64, 0.99, f) * 0.34);
  col += red * glow * 0.55;

  float vig = smoothstep(1.40, 0.22, length(p * vec2(1.0, 1.15)));
  col *= mix(0.52, 1.0, vig);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function mountLiquid(canvas) {
  if (!canvas) return;
  const gl =
    canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }) ||
    canvas.getContext('experimental-webgl');
  if (!gl) return; // 降级：保留 CSS 底色与渐变

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(program, 'u_res');
  const uTime = gl.getUniformLocation(program, 'u_time');
  const uPtr = gl.getUniformLocation(program, 'u_ptr');
  const uAmp = gl.getUniformLocation(program, 'u_ptrAmp');

  const pointer = { x: 0.5, y: 0.62, tx: 0.5, ty: 0.62, amp: 0, targetAmp: 0 };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  }

  function onPointer(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.tx = (event.clientX - rect.left) / rect.width;
    pointer.ty = 1 - (event.clientY - rect.top) / rect.height;
    pointer.targetAmp = 1;
  }

  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerleave', () => {
    pointer.targetAmp = 0;
  }, { passive: true });
  window.addEventListener('resize', resize);

  let visible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 }
    ).observe(canvas);
  }

  const start = performance.now();

  function frame(now) {
    const elapsed = (now - start) / 1000;
    if (visible || reduceMotion) {
      resize();
      pointer.x += (pointer.tx - pointer.x) * 0.06;
      pointer.y += (pointer.ty - pointer.y) * 0.06;
      pointer.targetAmp *= 0.985;
      pointer.amp += (pointer.targetAmp - pointer.amp) * 0.08;

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduceMotion ? 12 : elapsed);
      gl.uniform2f(uPtr, pointer.x, pointer.y);
      gl.uniform1f(uAmp, pointer.amp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (reduceMotion) return; // 只渲一帧
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);
}

mountLiquid(document.getElementById('liquid'));