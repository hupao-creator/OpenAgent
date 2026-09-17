/**
 * Bart WebGL2 renderer：procedural 球体/眼睛、SDF morph、透明合成。
 *
 * 唯一实现，生产 App Shell 与 Playground 共用（Playground 从这里导入，
 * 避免两套 shader 漂移）。数值契约见 docs/bart-webgl-playground-handoff.md：
 * 预乘 alpha 输出 + ONE/ONE_MINUS_SRC_ALPHA blend，零长度方向防御。
 */

export interface BartWebGLPose {
  x: number
  y: number
  radius: number
  width?: number
  height?: number
  cornerRadius?: number
  directionX: number
  directionY: number
  stretch: number
  alpha: number
  shapeMix?: number
  surfaceMix?: number
  eyeAlpha?: number
  borderAlpha?: number
  shadowAlpha?: number
}

export interface BartWebGLRenderer {
  clear: () => void
  draw: (poses: readonly BartWebGLPose[], textures?: readonly BartWebGLTexture[]) => void
  upload: (id: string, bitmap: ImageBitmap | OffscreenCanvas) => void
  updateTexture: (id: string, canvas: OffscreenCanvas) => void
  releaseTextures: () => void
  resize: (width: number, height: number, pixelRatio?: number) => void
  isLost: () => boolean
  dispose: () => void
}

export interface BartWebGLTexture {
  opacity?: number
  matrix?: { a: number; b: number; c: number; d: number; e: number; f: number }
  viewport?: { x: number; y: number; width: number; height: number }
  id: string
  x: number; y: number; width: number; height: number
  clip?: { x: number; top: number; bottom: number }
}

interface BartWebGLRendererOptions {
  /** Context loss ends the current scene and restores native business DOM. */
  onContextLost?: () => void
  pixelRatio?: number
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform vec2 u_extent;
uniform mat3 u_matrix;
out vec2 v_pixel;

void main() {
  v_pixel = a_position * u_extent;
  vec2 pixel = (u_matrix * vec3(u_center + v_pixel, 1.0)).xy;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_pixel;
uniform vec2 u_direction;
uniform vec2 u_half_size;
uniform float u_corner_radius;
uniform float u_eye_radius;
uniform float u_stretch;
uniform float u_alpha;
uniform float u_shape_mix;
uniform float u_surface_mix;
uniform float u_eye_alpha;
uniform float u_border_alpha;
uniform float u_shadow_alpha;
uniform bool u_textured;
uniform sampler2D u_texture;
uniform vec2 u_extent;
uniform bool u_clipped;
uniform vec3 u_clip;
out vec4 out_color;

float roundedBox(vec2 point, vec2 halfSize, float radius) {
  vec2 delta = abs(point) - halfSize + radius;
  return length(max(delta, 0.0)) + min(max(delta.x, delta.y), 0.0) - radius;
}

void main() {
  if (u_textured) {
    vec2 local = v_pixel + u_extent;
    if (u_clipped && !(local.y < u_clip.y || (local.y <= u_clip.z && local.x <= u_clip.x))) discard;
    vec4 color = texture(u_texture, local / (2.0 * u_extent));
    out_color = vec4(color.rgb * color.a, color.a) * u_alpha;
    return;
  }
  vec2 direction = u_direction;
  float directionLength = length(direction);
  if (directionLength < 0.0001) {
    direction = vec2(1.0, 0.0);
  } else {
    direction /= directionLength;
  }
  vec2 normal = vec2(-direction.y, direction.x);
  vec2 bodySpace = vec2(dot(v_pixel, direction), dot(v_pixel, normal));
  vec2 axes = vec2(1.0 + u_stretch, 1.0 - u_stretch * 0.68);
  float ellipseDistance = length(bodySpace / max(vec2(1.0), u_half_size * axes)) - 1.0;
  float boxDistance = roundedBox(v_pixel, u_half_size, u_corner_radius);
  float normalizedBoxDistance = boxDistance / max(1.0, min(u_half_size.x, u_half_size.y));
  float bodyDistance = mix(ellipseDistance, normalizedBoxDistance, u_shape_mix);
  float bodyAA = max(fwidth(bodyDistance) * 1.4, 0.0015);
  float bodyAlpha = 1.0 - smoothstep(-bodyAA, bodyAA, bodyDistance);
  // Blending two differently-normalized SDFs can temporarily classify the
  // whole bounding quad as interior. Once the body starts becoming a card,
  // constrain it to the current rounded-box silhouette explicitly.
  float boxAA = max(fwidth(boxDistance) * 1.4, 0.5);
  float boxAlpha = 1.0 - smoothstep(-boxAA, boxAA, boxDistance);
  bodyAlpha *= mix(1.0, boxAlpha, smoothstep(0.08, 0.35, u_shape_mix));

  float borderWidth = 1.15 / max(1.0, min(u_half_size.x, u_half_size.y));
  float innerAlpha = 1.0 - smoothstep(-bodyAA, bodyAA, bodyDistance + borderWidth);
  float borderAlpha = max(0.0, bodyAlpha - innerAlpha) * u_border_alpha * u_shape_mix;

  float shadowOuter = 1.0 - smoothstep(0.0, 24.0, boxDistance);
  float shadowMask = smoothstep(-1.0, 1.0, boxDistance);
  float shadowAlpha = shadowOuter * shadowMask * 0.13 * u_shadow_alpha * u_shape_mix;

  vec2 eyeSpace = v_pixel / max(1.0, u_eye_radius);
  float speedIntent = clamp(abs(u_stretch) * 3.1, 0.0, 1.0);
  vec2 gaze = direction * mix(0.035, 0.24, speedIntent);
  vec2 leftCenter = vec2(-0.17, -0.015) + gaze;
  vec2 rightCenter = vec2(0.17, -0.015) + gaze;
  float leftEye = roundedBox(eyeSpace - leftCenter, vec2(0.052, 0.19), 0.05);
  float rightEye = roundedBox(eyeSpace - rightCenter, vec2(0.052, 0.19), 0.05);
  float eyeDistance = min(leftEye, rightEye);
  float eyeAA = max(fwidth(eyeDistance) * 1.2, 0.002);
  float eyeAlpha = (1.0 - smoothstep(-eyeAA, eyeAA, eyeDistance)) * u_eye_alpha;
  float eyeOutline = (1.0 - smoothstep(-eyeAA, eyeAA, eyeDistance - 0.026)) * 0.32 * u_eye_alpha;

  vec3 darkBody = vec3(0.0627, 0.0667, 0.0588);
  vec3 cardBody = vec3(0.9725, 0.9647, 0.9373);
  vec3 bodyColor = mix(darkBody, cardBody, u_surface_mix);
  vec3 eyeColor = vec3(0.9725, 0.9647, 0.9373);
  vec3 borderColor = vec3(0.0627, 0.0667, 0.0588);
  float foregroundAlpha = max(bodyAlpha, max(eyeOutline, eyeAlpha));
  float alpha = max(shadowAlpha, foregroundAlpha) * u_alpha;
  if (alpha <= 0.001) discard;
  vec3 color = mix(vec3(0.0627, 0.0667, 0.0588), bodyColor, bodyAlpha);
  color = mix(color, borderColor, borderAlpha);
  color = mix(color, vec3(0.02), eyeOutline * (1.0 - eyeAlpha));
  color = mix(color, eyeColor, eyeAlpha);
  out_color = vec4(color * alpha, alpha);
}
`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  console.warn('Bart WebGL shader failed:', gl.getShaderInfoLog(shader))
  gl.deleteShader(shader)
  return null
}

export function createBartWebGLRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  initialWidth: number,
  initialHeight: number,
  options: BartWebGLRendererOptions = {}
): BartWebGLRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    depth: false,
    // The shader writes premultiplied color, matching Chromium's canvas
    // compositor contract and keeping translucent trails alpha-correct.
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  })
  if (!gl) return null

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader)
    if (fragmentShader) gl.deleteShader(fragmentShader)
    return null
  }
  const program = gl.createProgram()
  if (!program) { gl.deleteShader(vertexShader); gl.deleteShader(fragmentShader); return null }
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('Bart WebGL program failed:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }

  let lost = false
  const handleContextLost = (event: Event): void => {
    event.preventDefault()
    lost = true
    options.onContextLost?.()
  }
  canvas.addEventListener('webglcontextlost', handleContextLost)

  let dpr = Math.min(2, Math.max(1, options.pixelRatio ??
    (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)))
  gl.useProgram(program)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  const buffer = gl.createBuffer()
  if (!buffer) {
    canvas.removeEventListener('webglcontextlost', handleContextLost)
    gl.deleteProgram(program)
    return null
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  const resolution = gl.getUniformLocation(program, 'u_resolution')
  const center = gl.getUniformLocation(program, 'u_center')
  const extent = gl.getUniformLocation(program, 'u_extent')
  const halfSize = gl.getUniformLocation(program, 'u_half_size')
  const cornerRadius = gl.getUniformLocation(program, 'u_corner_radius')
  const eyeRadius = gl.getUniformLocation(program, 'u_eye_radius')
  const direction = gl.getUniformLocation(program, 'u_direction')
  const stretch = gl.getUniformLocation(program, 'u_stretch')
  const alpha = gl.getUniformLocation(program, 'u_alpha')
  const shapeMix = gl.getUniformLocation(program, 'u_shape_mix')
  const surfaceMix = gl.getUniformLocation(program, 'u_surface_mix')
  const eyeAlpha = gl.getUniformLocation(program, 'u_eye_alpha')
  const borderAlpha = gl.getUniformLocation(program, 'u_border_alpha')
  const shadowAlpha = gl.getUniformLocation(program, 'u_shadow_alpha')
  const textured = gl.getUniformLocation(program, 'u_textured')
  const clipped = gl.getUniformLocation(program, 'u_clipped')
  const clip = gl.getUniformLocation(program, 'u_clip')
  const matrix = gl.getUniformLocation(program, 'u_matrix')
  const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const textures = new Map<string, WebGLTexture>()
  const releaseTextures = (): void => {
    for (const texture of textures.values()) gl.deleteTexture(texture)
    textures.clear()
  }
  const upload = (id: string, bitmap: ImageBitmap | OffscreenCanvas): void => {
    if (lost) throw new Error('Bart GPU context lost')
    if (Math.max(bitmap.width, bitmap.height) > Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))) {
      throw new Error('Bart texture exceeds GPU capability')
    }
    const texture = gl.createTexture()
    if (!texture) throw new Error('Bart texture allocation failed')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error(`Bart texture upload failed (${error})`) }
    const old = textures.get(id)
    if (old) gl.deleteTexture(old)
    textures.set(id, texture)
  }
  const updateTexture = (id: string, source: OffscreenCanvas): void => {
    const texture = textures.get(id)
    if (!texture || lost) throw new Error('Bart live character texture unavailable')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // Fixed raster size was allocated and checked during preparation. Reuse it;
    // no allocation, readback, getError or Host image relay occurs in this loop.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
  }

  let width = 0
  let height = 0
  const resize = (nextWidth: number, nextHeight: number, pixelRatio = dpr): void => {
    if (lost) return
    const cssWidth = Math.max(1, Math.round(nextWidth))
    const cssHeight = Math.max(1, Math.round(nextHeight))
    const nextRatio = Math.min(2, Math.max(1, pixelRatio))
    if (cssWidth === width && cssHeight === height && dpr === nextRatio) return
    dpr = nextRatio
    width = cssWidth
    height = cssHeight
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    if ('style' in canvas) {
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(resolution, canvas.width, canvas.height)
  }
  resize(initialWidth, initialHeight)

  const clear = (): void => {
    if (lost) return
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  const draw = (poses: readonly BartWebGLPose[], layers: readonly BartWebGLTexture[] = []): void => {
    if (lost) return
    clear()
    gl.uniform1i(textured, 1)
    for (const layer of layers) {
      const texture = textures.get(layer.id)
      if (!texture) continue
      const transform = layer.matrix
      gl.uniformMatrix3fv(matrix, false, transform ? [transform.a, transform.b, 0, transform.c, transform.d, 0,
        transform.e * dpr, transform.f * dpr, 1] : identityMatrix)
      if (layer.viewport) {
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(Math.round(layer.viewport.x * dpr), Math.round((height - layer.viewport.y - layer.viewport.height) * dpr),
          Math.max(0, Math.round(layer.viewport.width * dpr)), Math.max(0, Math.round(layer.viewport.height * dpr)))
      } else gl.disable(gl.SCISSOR_TEST)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.uniform1f(alpha, layer.opacity ?? 1)
      gl.uniform2f(center, (layer.x + layer.width / 2) * dpr, (layer.y + layer.height / 2) * dpr)
      gl.uniform2f(extent, layer.width / 2 * dpr, layer.height / 2 * dpr)
      gl.uniform1i(clipped, layer.clip ? 1 : 0)
      if (layer.clip) gl.uniform3f(clip, layer.clip.x * dpr, layer.clip.top * dpr, layer.clip.bottom * dpr)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    gl.disable(gl.SCISSOR_TEST)
    gl.uniformMatrix3fv(matrix, false, identityMatrix)
    gl.uniform1i(textured, 0)
    for (const pose of poses) {
      const poseWidth = pose.width ?? pose.radius * 2
      const poseHeight = pose.height ?? pose.radius * 2
      const halfWidth = poseWidth / 2
      const halfHeight = poseHeight / 2
      const padding = (pose.shadowAlpha ?? 0) > 0 ? 26 : Math.max(6, pose.radius * .72)
      gl.uniform2f(center, pose.x * dpr, pose.y * dpr)
      gl.uniform2f(extent, (halfWidth + padding) * dpr, (halfHeight + padding) * dpr)
      gl.uniform2f(halfSize, halfWidth * dpr, halfHeight * dpr)
      gl.uniform1f(cornerRadius, (pose.cornerRadius ?? pose.radius) * dpr)
      gl.uniform1f(eyeRadius, pose.radius * dpr)
      gl.uniform2f(direction, pose.directionX, pose.directionY)
      gl.uniform1f(stretch, pose.stretch)
      gl.uniform1f(alpha, pose.alpha)
      gl.uniform1f(shapeMix, pose.shapeMix ?? 0)
      gl.uniform1f(surfaceMix, pose.surfaceMix ?? 0)
      gl.uniform1f(eyeAlpha, pose.eyeAlpha ?? 1)
      gl.uniform1f(borderAlpha, pose.borderAlpha ?? 0)
      gl.uniform1f(shadowAlpha, pose.shadowAlpha ?? 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  }

  return {
    clear,
    draw,
    upload,
    updateTexture,
    releaseTextures,
    resize,
    isLost: () => lost,
    dispose: () => {
      releaseTextures()
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      if (!lost) clear()
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      gl.useProgram(null)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
    }
  }
}
