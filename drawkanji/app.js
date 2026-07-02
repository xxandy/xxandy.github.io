// Application State
let strokePaths = [];
let strokePolylines = [];
let strokeElements = [];
let currentStrokeIndex = 0; // Index of the active drawing stroke (starts at 0)
let currentStrokeCount = 0;
let strokeProgress = 0.0;    // Progress of active stroke (0.0 to 1.0)
let strokeTimeElapsed = 0.0;  // Milliseconds elapsed on active stroke
let isAnimating = false;
let isSingleStrokeAnimating = false;
let isComposing = false;
let loadedCharacter = '';
let tipSizePercent = 80;
let drawingSpeed = 80;       // SVG units per second
let pauseBetweenStrokes = 300; // ms
let dryLineWidth = 5.0;
let strokeTipHistory = [];     // Array of {x, y} tip positions
let strokeCompletionTimes = []; // Completion animTime for completed strokes
let trailLength = 140;
let animTime = 0;

const GLOW_RADIUS_MULTIPLIER = 4.5;

// Rendering Pipeline State (WebGPU or 2D Fallback)
let webgpuSupported = false;
let webgpuEnabled = false;
let device = null;
let context = null;
let pipeline = null;
let bindGroup = null;
let vertexBuffer = null;
let indexBuffer = null;
let uniformBuffer = null;
let uniformData = null;
let uniformFloatView = null;
let glyphTexture = null;
let glyphTextureView = null;
let presentationFormat = null;
let sampler = null;
let antiAliasingFactor = 4;
let canvas = null;
let visibleCtx = null;
let glyphCanvas = null;
let glyphCtx = null;
let statusBadge = null;
let resizeObserverInstance = null;
let elGlowControl = null;
let elAAControl = null;
let drawPipeline = null;
let drawVertexBuffer = null;
let drawUniformBuffer = null;
let drawBindGroup = null;

// WGSL Shaders code (Static Card, Front-facing layout, RGB texture input)
const wgslShaders = `
struct Uniforms {
  glowIntensity: f32,
  zoom: f32,
  time: f32,
  aspectRatio: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var myTexture: texture_2d<f32>;
@group(0) @binding(2) var mySampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) localPos: vec3<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  var scaledPos = pos.xy;
  if (uniforms.aspectRatio > 1.0) {
    scaledPos.x = scaledPos.x / uniforms.aspectRatio;
  } else {
    scaledPos.y = scaledPos.y * uniforms.aspectRatio;
  }
  // Apply zoom scaling directly to coordinate space in vertex shader
  out.position = vec4<f32>(scaledPos * uniforms.zoom, pos.z, 1.0);
  out.uv = uv;
  out.localPos = pos;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Sample glyph character stroke texture from offscreen canvas (full RGB colors)
  let strokeColor = textureSample(myTexture, mySampler, input.uv).rgb;
  
  // Calculate mask based on color brightness
  let strokeMask = clamp(max(strokeColor.r, max(strokeColor.g, strokeColor.b)), 0.0, 1.0);
  
  // Dynamic gradient factor based on UVs and time
  var gradientCoord = input.uv.y + sin(input.uv.x * 3.0 + uniforms.time * 2.0) * 0.12;
  gradientCoord = clamp(gradientCoord, 0.0, 1.0);
  
  // Constant indigo-violet theme color
  let themeColor = mix(vec3<f32>(0.388, 0.400, 0.945), vec3<f32>(0.659, 0.333, 0.969), gradientCoord);
  
  // Neon glow border calculations for static card
  let borderDistX = 1.0 - abs(input.localPos.x);
  let borderDistY = 1.0 - abs(input.localPos.y);
  let minDist = min(borderDistX, borderDistY);
  let borderMask = 1.0 - smoothstep(0.0, 0.015, minDist);
  
  // Subtle glowing lines inside the glass card backing
  let gridVal = sin(input.localPos.x * 24.0) * sin(input.localPos.y * 24.0);
  let gridLine = smoothstep(0.97, 1.0, gridVal) * 0.06;
  
  // Semi-transparent base glass pane (colors + subtle grids)
  let glassBase = vec3<f32>(0.043, 0.063, 0.110) + vec3<f32>(gridLine);
  let borderGlow = themeColor * borderMask * 1.5 * uniforms.glowIntensity;
  let glassBody = mix(glassBase, borderGlow, borderMask);
  
  // Glow for the stroke lines (multiplying color by glow parameters)
  let finalGlyphColor = strokeColor * (1.2 + uniforms.glowIntensity * 1.0);
  
  // Final compositing (using pre-multiplied alpha blending to prevent alpha squaring)
  let finalRGB = glassBody * (1.0 - strokeMask) + finalGlyphColor;
  let finalAlpha = mix(0.72 + borderMask * 0.28, 0.96, strokeMask);
  
  return vec4<f32>(finalRGB, finalAlpha);
}
`;

const drawShaderCode = `
struct Uniforms {
  aspectRatio: f32,
  textureSize: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  
  let halfSize = uniforms.textureSize / 2.0;
  var pos = vec2<f32>(
    (input.position.x / halfSize) - 1.0,
    1.0 - (input.position.y / halfSize)
  );

  if (uniforms.aspectRatio > 0.0) {
    pos.x = pos.x / uniforms.aspectRatio;
  }
  
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`;

class SVGPathInterpreter {
  static tokenize(d) {
    const commands = new Set(['M', 'm', 'L', 'l', 'H', 'h', 'V', 'v', 'C', 'c', 'S', 's', 'Q', 'q', 'T', 't', 'Z', 'z']);
    const tokens = [];
    let i = 0;
    while (i < d.length) {
      const char = d[i];
      if (commands.has(char)) {
        tokens.push({ type: 'cmd', value: char });
        i++;
      } else if (char === ',' || char === ' ' || char === '\r' || char === '\n' || char === '\t') {
        i++;
      } else {
        let start = i;
        if (d[i] === '-') i++;
        let hasDot = false;
        while (i < d.length) {
          const c = d[i];
          if (c >= '0' && c <= '9') {
            i++;
          } else if (c === '.' && !hasDot) {
            hasDot = true;
            i++;
          } else {
            break;
          }
        }
        const numStr = d.substring(start, i);
        if (numStr.length > 0) {
          tokens.push({ type: 'num', value: parseFloat(numStr) });
        } else {
          i++;
        }
      }
    }
    return tokens;
  }

  static getSteps(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return Math.max(3, Math.min(24, Math.round(dist / 1.5)));
  }

  static parseToPolylines(d) {
    const tokens = this.tokenize(d);
    const polylines = [];
    let currentPolyline = [];
    
    let cx = 0, cy = 0;
    let sx = 0, sy = 0;
    let cpx = 0, cpy = 0;
    let qpx = 0, qpy = 0;
    
    let tIdx = 0;
    let lastCmd = '';
    
    function addPoint(x, y) {
      currentPolyline.push({ x, y });
      cx = x;
      cy = y;
    }

    while (tIdx < tokens.length) {
      let token = tokens[tIdx];
      let cmd = '';
      if (token.type === 'cmd') {
        cmd = token.value;
        tIdx++;
      } else {
        cmd = lastCmd;
      }
      
      if (!cmd) break;
      
      switch (cmd) {
        case 'M':
        case 'm': {
          const px = tokens[tIdx++].value;
          const py = tokens[tIdx++].value;
          const targetX = cmd === 'M' ? px : cx + px;
          const targetY = cmd === 'M' ? py : cy + py;
          
          if (currentPolyline.length > 0) {
            polylines.push(currentPolyline);
          }
          currentPolyline = [];
          sx = targetX;
          sy = targetY;
          addPoint(targetX, targetY);
          cpx = targetX; cpy = targetY;
          qpx = targetX; qpy = targetY;
          lastCmd = cmd === 'M' ? 'L' : 'l';
          break;
        }
        case 'L':
        case 'l': {
          const px = tokens[tIdx++].value;
          const py = tokens[tIdx++].value;
          const targetX = cmd === 'L' ? px : cx + px;
          const targetY = cmd === 'L' ? py : cy + py;
          addPoint(targetX, targetY);
          cpx = targetX; cpy = targetY;
          qpx = targetX; qpy = targetY;
          lastCmd = cmd;
          break;
        }
        case 'H':
        case 'h': {
          const px = tokens[tIdx++].value;
          const targetX = cmd === 'H' ? px : cx + px;
          addPoint(targetX, cy);
          cpx = targetX; cpy = cy;
          qpx = targetX; qpy = cy;
          lastCmd = cmd;
          break;
        }
        case 'V':
        case 'v': {
          const py = tokens[tIdx++].value;
          const targetY = cmd === 'V' ? py : cy + py;
          addPoint(cx, targetY);
          cpx = cx; cpy = targetY;
          qpx = cx; qpy = targetY;
          lastCmd = cmd;
          break;
        }
        case 'C':
        case 'c': {
          const x1 = tokens[tIdx++].value;
          const y1 = tokens[tIdx++].value;
          const x2 = tokens[tIdx++].value;
          const y2 = tokens[tIdx++].value;
          const x = tokens[tIdx++].value;
          const y = tokens[tIdx++].value;
          
          const ctrl1X = cmd === 'C' ? x1 : cx + x1;
          const ctrl1Y = cmd === 'C' ? y1 : cy + y1;
          const ctrl2X = cmd === 'C' ? x2 : cx + x2;
          const ctrl2Y = cmd === 'C' ? y2 : cy + y2;
          const targetX = cmd === 'C' ? x : cx + x;
          const targetY = cmd === 'C' ? y : cy + y;
          
          const steps = SVGPathInterpreter.getSteps(cx, cy, targetX, targetY);
          this.subdivideCubic(cx, cy, ctrl1X, ctrl1Y, ctrl2X, ctrl2Y, targetX, targetY, currentPolyline, steps);
          cx = targetX;
          cy = targetY;
          cpx = ctrl2X;
          cpy = ctrl2Y;
          qpx = targetX;
          qpy = targetY;
          lastCmd = cmd;
          break;
        }
        case 'S':
        case 's': {
          const x2 = tokens[tIdx++].value;
          const y2 = tokens[tIdx++].value;
          const x = tokens[tIdx++].value;
          const y = tokens[tIdx++].value;
          
          let ctrl1X = cx;
          let ctrl1Y = cy;
          if (lastCmd === 'C' || lastCmd === 'c' || lastCmd === 'S' || lastCmd === 's') {
            ctrl1X = 2 * cx - cpx;
            ctrl1Y = 2 * cy - cpy;
          }
          
          const ctrl2X = cmd === 'S' ? x2 : cx + x2;
          const ctrl2Y = cmd === 'S' ? y2 : cy + y2;
          const targetX = cmd === 'S' ? x : cx + x;
          const targetY = cmd === 'S' ? y : cy + y;
          
          const steps = SVGPathInterpreter.getSteps(cx, cy, targetX, targetY);
          this.subdivideCubic(cx, cy, ctrl1X, ctrl1Y, ctrl2X, ctrl2Y, targetX, targetY, currentPolyline, steps);
          cx = targetX;
          cy = targetY;
          cpx = ctrl2X;
          cpy = ctrl2Y;
          qpx = targetX;
          qpy = targetY;
          lastCmd = cmd;
          break;
        }
        case 'Q':
        case 'q': {
          const x1 = tokens[tIdx++].value;
          const y1 = tokens[tIdx++].value;
          const x = tokens[tIdx++].value;
          const y = tokens[tIdx++].value;
          
          const ctrlX = cmd === 'Q' ? x1 : cx + x1;
          const ctrlY = cmd === 'Q' ? y1 : cy + y1;
          const targetX = cmd === 'Q' ? x : cx + x;
          const targetY = cmd === 'Q' ? y : cy + y;
          
          const steps = SVGPathInterpreter.getSteps(cx, cy, targetX, targetY);
          this.subdivideQuadratic(cx, cy, ctrlX, ctrlY, targetX, targetY, currentPolyline, steps);
          cx = targetX;
          cy = targetY;
          qpx = ctrlX;
          qpy = ctrlY;
          cpx = targetX;
          cpy = targetY;
          lastCmd = cmd;
          break;
        }
        case 'T':
        case 't': {
          const x = tokens[tIdx++].value;
          const y = tokens[tIdx++].value;
          
          let ctrlX = cx;
          let ctrlY = cy;
          if (lastCmd === 'Q' || lastCmd === 'q' || lastCmd === 'T' || lastCmd === 't') {
            ctrlX = 2 * cx - qpx;
            ctrlY = 2 * cy - qpy;
          }
          
          const targetX = cmd === 'T' ? x : cx + x;
          const targetY = cmd === 'T' ? y : cy + y;
          
          const steps = SVGPathInterpreter.getSteps(cx, cy, targetX, targetY);
          this.subdivideQuadratic(cx, cy, ctrlX, ctrlY, targetX, targetY, currentPolyline, steps);
          cx = targetX;
          cy = targetY;
          qpx = ctrlX;
          qpy = ctrlY;
          cpx = targetX;
          cpy = targetY;
          lastCmd = cmd;
          break;
        }
        case 'Z':
        case 'z': {
          if (cx !== sx || cy !== sy) {
            addPoint(sx, sy);
          }
          cpx = sx; cpy = sy;
          qpx = sx; qpy = sy;
          lastCmd = cmd;
          break;
        }
        default:
          console.warn('Unknown SVG command:', cmd);
          tIdx++;
          break;
      }
    }
    
    if (currentPolyline.length > 0) {
      polylines.push(currentPolyline);
    }
    return polylines;
  }

  static subdivideCubic(x0, y0, x1, y1, x2, y2, x3, y3, points, steps = 24) {
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const mt = 1 - t;
      const w0 = mt * mt * mt;
      const w1 = 3 * mt * mt * t;
      const w2 = 3 * mt * t * t;
      const w3 = t * t * t;
      points.push({
        x: w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3,
        y: w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3
      });
    }
  }

  static subdivideQuadratic(x0, y0, x1, y1, x2, y2, points, steps = 24) {
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const mt = 1 - t;
      const w0 = mt * mt;
      const w1 = 2 * mt * t;
      const w2 = t * t;
      points.push({
        x: w0 * x0 + w1 * x1 + w2 * x2,
        y: w0 * y0 + w1 * y1 + w2 * y2
      });
    }
  }
}

function computePolylineLengths(polyline) {
  let len = 0;
  polyline[0].len = 0;
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i-1].x;
    const dy = polyline[i].y - polyline[i-1].y;
    len += Math.sqrt(dx * dx + dy * dy);
    polyline[i].len = len;
  }
  return len;
}

function cleanPolyline(polyline) {
  if (polyline.length < 2) return polyline;
  const result = [polyline[0]];
  for (let i = 1; i < polyline.length; i++) {
    const prev = result[result.length - 1];
    const curr = polyline[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len >= 1e-4) { // Filter out sub-pixel noise points
      result.push(curr);
    }
  }
  // Ensure we preserve at least the end point if the path was collapsed
  if (result.length < 2 && polyline.length >= 2) {
    result.push(polyline[polyline.length - 1]);
  }
  return result;
}

function truncatePolyline(polyline, targetLen) {
  if (targetLen <= 0) return [];
  const total = polyline[polyline.length - 1].len;
  if (targetLen >= total) return polyline;
  
  const result = [];
  for (let i = 0; i < polyline.length; i++) {
    if (polyline[i].len <= targetLen) {
      result.push(polyline[i]);
    } else {
      const prev = polyline[i-1];
      const next = polyline[i];
      const ratio = (targetLen - prev.len) / (next.len - prev.len);
      result.push({
        x: prev.x + ratio * (next.x - prev.x),
        y: prev.y + ratio * (next.y - prev.y),
        len: targetLen
      });
      break;
    }
  }
  return result;
}

function tessellateStroke(polyline, W, color, vertexArray) {
  if (polyline.length < 2) return;
  
  const R = W / 2;
  
  function pushVertex(x, y) {
    vertexArray.push(x, y, color.r, color.g, color.b, color.a);
  }
  
  function pushTriangle(x1, y1, x2, y2, x3, y3) {
    pushVertex(x1, y1);
    pushVertex(x2, y2);
    pushVertex(x3, y3);
  }

  // 1. Draw quads for each segment
  const normals = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    const p1 = polyline[i];
    const p2 = polyline[i+1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) {
      normals.push({ nx: 0, ny: 0, ux: 0, uy: 0 });
    } else {
      const nx = dx / len;
      const ny = dy / len;
      normals.push({ nx, ny, ux: -ny, uy: nx });
    }
  }

  for (let i = 0; i < polyline.length - 1; i++) {
    const p1 = polyline[i];
    const p2 = polyline[i+1];
    const norm = normals[i];
    if (norm.nx === 0 && norm.ny === 0) continue;
    
    const ox = norm.ux * R;
    const oy = norm.uy * R;
    
    const L1_x = p1.x + ox, L1_y = p1.y + oy;
    const R1_x = p1.x - ox, R1_y = p1.y - oy;
    const L2_x = p2.x + ox, L2_y = p2.y + oy;
    const R2_x = p2.x - ox, R2_y = p2.y - oy;
    
    pushTriangle(L1_x, L1_y, R1_x, R1_y, L2_x, L2_y);
    pushTriangle(R1_x, R1_y, R2_x, R2_y, L2_x, L2_y);
  }

  // 2. Draw solid disk joints at all intermediate vertices
  for (let i = 1; i < polyline.length - 1; i++) {
    const pt = polyline[i];
    appendCircleGeometry(pt.x, pt.y, R, color, vertexArray);
  }

  // 3. Draw start and end caps
  if (normals.length > 0) {
    const firstNorm = normals[0];
    if (firstNorm.nx !== 0 || firstNorm.ny !== 0) {
      appendCircleGeometry(polyline[0].x, polyline[0].y, R, color, vertexArray);
    }
    const lastNorm = normals[normals.length - 1];
    if (lastNorm.nx !== 0 || lastNorm.ny !== 0) {
      appendCircleGeometry(polyline[polyline.length - 1].x, polyline[polyline.length - 1].y, R, color, vertexArray);
    }
  }
}

function appendCircleGeometry(cx, cy, r, color, vertexArray) {
  const segments = 16;
  for (let i = 0; i < segments; i++) {
    const a1 = (i / segments) * Math.PI * 2;
    const a2 = ((i + 1) / segments) * Math.PI * 2;
    vertexArray.push(cx, cy, color.r, color.g, color.b, color.a);
    vertexArray.push(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, color.r, color.g, color.b, color.a);
    vertexArray.push(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, color.r, color.g, color.b, color.a);
  }
}

function appendGlowCircleGeometry(cx, cy, r, color, vertexArray) {
  const segments = 16;
  const rMid = r * 0.5;
  const rOuter = r;

  const aCenter = color.a;
  const aMid = color.a * 0.25;
  const aOuter = 0.0;

  const midVertices = [];
  const outerVertices = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cosVal = Math.cos(angle);
    const sinVal = Math.sin(angle);
    midVertices.push({
      x: cx + cosVal * rMid,
      y: cy + sinVal * rMid
    });
    outerVertices.push({
      x: cx + cosVal * rOuter,
      y: cy + sinVal * rOuter
    });
  }

  for (let i = 0; i < segments; i++) {
    // 1. Inner Triangle: Center, Mid[i], Mid[i+1]
    vertexArray.push(cx, cy, color.r, color.g, color.b, aCenter);
    vertexArray.push(midVertices[i].x, midVertices[i].y, color.r, color.g, color.b, aMid);
    vertexArray.push(midVertices[i+1].x, midVertices[i+1].y, color.r, color.g, color.b, aMid);

    // 2. Outer Quad (split into two triangles):
    // Triangle A: Mid[i], Outer[i], Outer[i+1]
    vertexArray.push(midVertices[i].x, midVertices[i].y, color.r, color.g, color.b, aMid);
    vertexArray.push(outerVertices[i].x, outerVertices[i].y, color.r, color.g, color.b, aOuter);
    vertexArray.push(outerVertices[i+1].x, outerVertices[i+1].y, color.r, color.g, color.b, aOuter);

    // Triangle B: Mid[i], Outer[i+1], Mid[i+1]
    vertexArray.push(midVertices[i].x, midVertices[i].y, color.r, color.g, color.b, aMid);
    vertexArray.push(outerVertices[i+1].x, outerVertices[i+1].y, color.r, color.g, color.b, aOuter);
    vertexArray.push(midVertices[i+1].x, midVertices[i+1].y, color.r, color.g, color.b, aMid);
  }
}

function parseRGBColor(colStr) {
  if (colStr.startsWith('rgba')) {
    const parts = colStr.substring(5, colStr.length - 1).split(',');
    return {
      r: parseInt(parts[0]) / 255,
      g: parseInt(parts[1]) / 255,
      b: parseInt(parts[2]) / 255,
      a: parseFloat(parts[3])
    };
  } else if (colStr.startsWith('rgb')) {
    const parts = colStr.substring(4, colStr.length - 1).split(',');
    return {
      r: parseInt(parts[0]) / 255,
      g: parseInt(parts[1]) / 255,
      b: parseInt(parts[2]) / 255,
      a: 1.0
    };
  } else if (colStr.startsWith('#')) {
    const hex = colStr.substring(1);
    if (hex.length === 6) {
      return {
        r: parseInt(hex.substring(0, 2), 16) / 255,
        g: parseInt(hex.substring(2, 4), 16) / 255,
        b: parseInt(hex.substring(4, 6), 16) / 255,
        a: 1.0
      };
    }
  }
  return { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
}

function lerpColorRGB(c1, c2, t) {
  return {
    r: c1.r + (c2.r - c1.r) * t,
    g: c1.g + (c2.g - c1.g) * t,
    b: c1.b + (c2.b - c1.b) * t,
    a: c1.a + (c2.a - c1.a) * t
  };
}

// Application Setup
async function initApp() {
  statusBadge = document.getElementById('gpu-status');
  canvas = document.getElementById('gpu-canvas');
  elGlowControl = document.getElementById('glow-intensity-control');
  elAAControl = document.getElementById('anti-aliasing-control');

  // 2D Offscreen Canvas for Stroke Vector Rendering (ALWAYS initialized)
  const glyphSize = 512;
  glyphCanvas = document.createElement('canvas');
  glyphCanvas.width = glyphSize;
  glyphCanvas.height = glyphSize;
  glyphCtx = glyphCanvas.getContext('2d');

  // WebGPU Support Verification
  if (!navigator.gpu) {
    statusBadge.classList.add('error');
    statusBadge.querySelector('.status-text').innerText = 'WebGPU Unsupported';
    initCanvasFallback();
  } else {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No appropriate GPU adapter found');
      }
      device = await adapter.requestDevice();
      device.lost.then((info) => {
        console.error(`WebGPU device was lost: ${info.message}`);
      });
      device.addEventListener('uncaughterror', (event) => {
        console.error('WebGPU uncaught error:', event.error.message);
      });
      webgpuSupported = true;
      webgpuEnabled = true;

      statusBadge.classList.add('connected');
      statusBadge.querySelector('.status-text').innerText = 'WebGPU Connected';

      // Configure WebGPU Canvas Context
      context = canvas.getContext('webgpu');
      presentationFormat = navigator.gpu.getPreferredCanvasFormat();

      resizeCanvas(canvas);

      context.configure({
        device: device,
        format: presentationFormat,
        alphaMode: 'premultiplied'
      });



    glyphTexture = device.createTexture({
      size: [glyphSize * antiAliasingFactor, glyphSize * antiAliasingFactor, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    glyphTextureView = glyphTexture.createView();

    sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear'
    });

    // Flat Quad in NDC space
    const vertexData = new Float32Array([
      -0.85,  0.85, 0.0,  0.0, 0.0,
      -0.85, -0.85, 0.0,  0.0, 1.0,
       0.85,  0.85, 0.0,  1.0, 0.0,
       0.85, -0.85, 0.0,  1.0, 1.0,
    ]);

    vertexBuffer = device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
    vertexBuffer.unmap();

    const indexData = new Uint16Array([
      0, 1, 2,
      2, 1, 3
    ]);

    indexBuffer = device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true
    });
    new Uint16Array(indexBuffer.getMappedRange()).set(indexData);
    indexBuffer.unmap();

    // Uniform Buffer Setup (16 bytes aligned)
    const uniformBufferSize = 16;
    uniformBuffer = device.createBuffer({
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    uniformData = new ArrayBuffer(uniformBufferSize);
    uniformFloatView = new Float32Array(uniformData);

    // Build Render Pipeline
    const shaderModule = device.createShaderModule({
      code: wgslShaders
    });
    const presentationCompilation = await shaderModule.getCompilationInfo();
    for (const message of presentationCompilation.messages) {
      if (message.type === 'error') {
        console.error('WGSL presentation compilation error:', message.message, 'at line', message.lineNum);
      }
    }

    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 20, // 5 floats * 4 bytes
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32x2' } // uv
            ]
          }
        ]
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: presentationFormat,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              }
            }
          }
        ]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none'
      }
    });

    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: glyphTextureView },
        { binding: 2, resource: sampler }
      ]
    });

    // 1. Create a Large Vertex Buffer for Tessellated Geometry (Dynamic Uploads)
    drawVertexBuffer = device.createBuffer({
      size: 50000 * 24,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });

    // 2. Create Pass 1 Uniform Buffer
    drawUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // 3. Compile Pass 1 Shader Module
    const drawShaderModule = device.createShaderModule({
      code: drawShaderCode
    });
    const drawCompilation = await drawShaderModule.getCompilationInfo();
    for (const message of drawCompilation.messages) {
      if (message.type === 'error') {
        console.error('WGSL drawing compilation error:', message.message, 'at line', message.lineNum);
      }
    }

    // 4. Create Pass 1 Render Pipeline
    drawPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: drawShaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 8, format: 'float32x4' }
            ]
          }
        ]
      },
      fragment: {
        module: drawShaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: 'rgba8unorm',
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              }
            }
          }
        ]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none'
      }
    });

    // 5. Create Pass 1 Bind Group
    drawBindGroup = device.createBindGroup({
      layout: drawPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: drawUniformBuffer } }
      ]
    });
    } catch (err) {
      console.error('WebGPU initialization error:', err);
      webgpuSupported = false;
      webgpuEnabled = false;
      statusBadge.className = 'gpu-status-badge error';
      statusBadge.querySelector('.status-text').innerText = 'Initialization Error';
      initCanvasFallback();
    }
  }

  // Handle toggle click
  statusBadge.addEventListener('click', () => {
    if (webgpuSupported) {
      setRenderingMode(!webgpuEnabled);
    } else {
      showToast("Not available");
    }
  });

    // GUI state
    const controls = {
      glowIntensity: 0.0,
      zoom: 1.4,
      antiAliasing: 4
    };

    // Bind controls
    const elGlow = document.getElementById('glow-intensity');
    const elTipSize = document.getElementById('tip-size');
    const elLineWeight = document.getElementById('line-weight');
    const elTrailLength = document.getElementById('trail-length');
    const elZoom = document.getElementById('zoom');
    const elAntiAliasing = document.getElementById('anti-aliasing');
    
    const valGlow = document.getElementById('glow-intensity-val');
    const valTipSize = document.getElementById('tip-size-val');
    const valLineWeight = document.getElementById('line-weight-val');
    const valTrailLength = document.getElementById('trail-length-val');
    const valZoom = document.getElementById('zoom-val');
    const valAntiAliasing = document.getElementById('anti-aliasing-val');
    
    const elCharInput = document.getElementById('char-input');
    const elStrokeDisplay = document.getElementById('stroke-display');
    const elAnimSpeed = document.getElementById('anim-speed');
    const elPauseDur = document.getElementById('pause-dur');
    const valAnimSpeed = document.getElementById('anim-speed-val');
    const valPauseDur = document.getElementById('pause-dur-val');

    const btnAnimate = document.getElementById('btn-animate');
    const btnStop = document.getElementById('btn-stop');
    const btnOneStroke = document.getElementById('btn-one-stroke');
    const btnBackStroke = document.getElementById('btn-back-stroke');
    const btnReset = document.getElementById('btn-reset');

    const mobileMediaQuery = window.matchMedia('(max-width: 1024px)');
    function isMobileDisplay() {
      return mobileMediaQuery.matches;
    }

    // UI State Display
    function updateStrokeDisplay() {
      if (currentStrokeCount === 0) {
        elStrokeDisplay.innerText = 'No strokes';
      } else {
        const displayIndex = Math.min(currentStrokeIndex + 1, currentStrokeCount);
        elStrokeDisplay.innerText = isMobileDisplay()
          ? `${displayIndex} / ${currentStrokeCount}`
          : `Stroke ${displayIndex} / ${currentStrokeCount}`;
      }
    }

    mobileMediaQuery.addEventListener?.('change', updateStrokeDisplay);

    function drawStrokesToWebGPU(commandEncoder) {
      let localEncoder = commandEncoder;
      let shouldSubmit = false;
      if (!localEncoder) {
        localEncoder = device.createCommandEncoder();
        shouldSubmit = true;
      }

      if (strokePaths.length === 0) return;

      const vertexArray = [];

      const factor = antiAliasingFactor;
      const padding = 45 * factor;
      const drawSize = (512 * factor) - padding * 2;
      const scale = drawSize / 109;

      function mapCoords(poly) {
        return poly.map(pt => ({
          x: padding + pt.x * scale,
          y: padding + pt.y * scale,
          len: pt.len * scale
        }));
      }

      const activeStrokeWidth = dryLineWidth * (8.0 / 6.5) * scale;
      const guideStrokeWidth = 4 * scale;
      const dryStrokeWidth = dryLineWidth * scale;

      // 1. Draw future/guide strokes
      const cGuide = { r: 1.0, g: 1.0, b: 1.0, a: 0.08 };
      for (let i = currentStrokeIndex; i < strokePaths.length; i++) {
        const polys = strokePolylines[i];
        if (!polys) continue;
        polys.forEach(poly => {
          if (poly.length < 2) return;
          const mapped = mapCoords(poly);
          tessellateStroke(mapped, guideStrokeWidth, cGuide, vertexArray);
        });
      }

      // 2. Draw completed strokes (drying effect)
      const cYellow = { r: 250/255, g: 204/255, b: 21/255, a: 1.0 };
      const cBlue = { r: 56/255, g: 189/255, b: 248/255, a: 1.0 };

      for (let i = 0; i < currentStrokeIndex; i++) {
        const polys = strokePolylines[i];
        if (!polys) continue;
        
        let dryProgress = 1.0;
        if (strokeCompletionTimes[i] !== undefined) {
          const elapsedMs = (animTime - strokeCompletionTimes[i]) * 1000;
          dryProgress = Math.min(1.0, elapsedMs / pauseBetweenStrokes);
        }

        const col = {
          r: cYellow.r + (cBlue.r - cYellow.r) * dryProgress,
          g: cYellow.g + (cBlue.g - cYellow.g) * dryProgress,
          b: cYellow.b + (cBlue.b - cYellow.b) * dryProgress,
          a: 1.0
        };

        const w = (activeStrokeWidth - (activeStrokeWidth - dryStrokeWidth) * dryProgress);

        polys.forEach(poly => {
          if (poly.length < 2) return;
          const mapped = mapCoords(poly);
          tessellateStroke(mapped, w, col, vertexArray);
        });
      }

      // 3. Draw active stroke & particles
      if (currentStrokeIndex < strokePaths.length && strokeProgress > 0) {
        const pathEl = strokeElements[currentStrokeIndex];
        const totalLength = pathEl.getTotalLength();
        const currentLength = totalLength * strokeProgress;
        const diameter = activeStrokeWidth * (tipSizePercent / 100);
        const radius = diameter / 2;

        const strokeDuration = totalLength > 0 ? (totalLength / drawingSpeed) * 1000 : 100;
        let pauseProgress = 0.0;
        if (strokeTimeElapsed > strokeDuration) {
          pauseProgress = Math.min(1.0, (strokeTimeElapsed - strokeDuration) / pauseBetweenStrokes);
        }

        // Draw animated active stroke segment
        let remLen = currentLength;
        const polys = strokePolylines[currentStrokeIndex];
        if (polys) {
          const dryProg = isSingleStrokeAnimating ? pauseProgress : 0.0;
          const w = activeStrokeWidth - (activeStrokeWidth - dryStrokeWidth) * dryProg;
          const col = {
            r: cYellow.r + (cBlue.r - cYellow.r) * dryProg,
            g: cYellow.g + (cBlue.g - cYellow.g) * dryProg,
            b: cYellow.b + (cBlue.b - cYellow.b) * dryProg,
            a: 1.0
          };
          polys.forEach(poly => {
            if (poly.length < 2) return;
            const mapped = mapCoords(poly);
            const totalPolyLen = poly[poly.length - 1].len;
            const truncated = truncatePolyline(mapped, remLen * scale);
            tessellateStroke(truncated, w, col, vertexArray);
            remLen -= totalPolyLen;
          });
        }

        // Active stroke tip glow & comet trail (Bottom-to-Top: Trail except tip -> Glow -> Tip)
        const L = strokeTipHistory.length;

        // 1. Comet trail *except* the very tip (index 0 to L-2)
        if (L > 1) {
          const trailAlpha = Math.pow(1.0 - pauseProgress, 2);
          for (let j = 0; j < L - 1; j++) {
            let t = j / (L - 1);
            t = t * (1.0 - pauseProgress);
            const r = radius * (0.35 + 0.65 * t);
            const pt = strokeTipHistory[j];
            const ptCanvas = {
              x: padding + pt.x * scale,
              y: padding + pt.y * scale
            };
            const cRed = { r: 239/255, g: 68/255, b: 68/255, a: 1.0 };
            const col = {
              r: cYellow.r + (cRed.r - cYellow.r) * t,
              g: cYellow.g + (cRed.g - cYellow.g) * t,
              b: cYellow.b + (cRed.b - cYellow.b) * t,
              a: trailAlpha
            };
            appendCircleGeometry(ptCanvas.x, ptCanvas.y, r, col, vertexArray);
          }
        }

        // 2. Glow circle (centered at the tip point)
        const tipPt = L > 0 ? strokeTipHistory[L - 1] : pathEl.getPointAtLength(currentLength);
        const tipRadius = L > 0 ? radius * (0.35 + 0.65 * (1.0 - pauseProgress)) : radius;
        const glowRadius = tipRadius * GLOW_RADIUS_MULTIPLIER;
        const glowAlpha = 1.0 - pauseProgress;

        if (glowRadius > 0 && glowAlpha > 0) {
          const ptCanvas = {
            x: padding + tipPt.x * scale,
            y: padding + tipPt.y * scale
          };
          const glowColor = { r: cYellow.r, g: cYellow.g, b: cYellow.b, a: glowAlpha };
          appendGlowCircleGeometry(ptCanvas.x, ptCanvas.y, glowRadius, glowColor, vertexArray);
        }

        // 3. Very tip circle (index L-1 if L > 0, or fallback if L === 0)
        if (L > 0) {
          const pt = strokeTipHistory[L - 1];
          const ptCanvas = {
            x: padding + pt.x * scale,
            y: padding + pt.y * scale
          };
          let t = 1.0 * (1.0 - pauseProgress);
          const cRed = { r: 239/255, g: 68/255, b: 68/255, a: 1.0 };
          const tipAlpha = Math.pow(1.0 - pauseProgress, 2);
          const col = {
            r: cYellow.r + (cRed.r - cYellow.r) * t,
            g: cYellow.g + (cRed.g - cYellow.g) * t,
            b: cYellow.b + (cRed.b - cYellow.b) * t,
            a: tipAlpha
          };
          appendCircleGeometry(ptCanvas.x, ptCanvas.y, tipRadius, col, vertexArray);
        } else {
          // Fallback: single circle
          const point = pathEl.getPointAtLength(currentLength);
          const ptCanvas = {
            x: padding + point.x * scale,
            y: padding + point.y * scale
          };
          const cRed = { r: 239/255, g: 68/255, b: 68/255, a: 1.0 };
          appendCircleGeometry(ptCanvas.x, ptCanvas.y, radius, cRed, vertexArray);
        }
      }

      if (vertexArray.length === 0) return;

      const floatArray = new Float32Array(vertexArray);
      device.queue.writeBuffer(drawVertexBuffer, 0, floatArray);

      // Set aspect ratio to 1.0 for the square texture, and pass scaled texture size
      const aspectArray = new Float32Array([1.0, 512.0 * antiAliasingFactor, 0, 0]);
      device.queue.writeBuffer(drawUniformBuffer, 0, aspectArray);

      const passEncoder = localEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: glyphTextureView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }, // Clear to transparent black
            loadOp: 'clear',
            storeOp: 'store'
          }
        ]
      });

      passEncoder.setPipeline(drawPipeline);
      passEncoder.setBindGroup(0, drawBindGroup);
      passEncoder.setVertexBuffer(0, drawVertexBuffer);
      passEncoder.draw(vertexArray.length / 6);
      passEncoder.end();

      if (shouldSubmit) {
        device.queue.submit([localEncoder.finish()]);
      }
    }

    function recreateGlyphTexture(factor) {
      if (!device) return;
      antiAliasingFactor = factor;
      if (glyphTexture) {
        try {
          glyphTexture.destroy();
        } catch (e) {
          console.error(e);
        }
      }
      glyphTexture = device.createTexture({
        size: [glyphSize * antiAliasingFactor, glyphSize * antiAliasingFactor, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      glyphTextureView = glyphTexture.createView();
      bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: glyphTextureView },
          { binding: 2, resource: sampler }
        ]
      });
      drawStrokesToCanvas();
    }

    // Canvas rendering (Strokes grown dynamically, and colored)
    function drawStrokesToCanvas(commandEncoder) {
      if (webgpuEnabled && webgpuSupported && device) {
        drawStrokesToWebGPU(commandEncoder);
        return;
      }
      const activeStrokeWidth = dryLineWidth * (8.0 / 6.5);

      function lerpColor(c1, c2, t) {
        const r = Math.round(c1.r + (c2.r - c1.r) * t);
        const g = Math.round(c1.g + (c2.g - c1.g) * t);
        const b = Math.round(c1.b + (c2.b - c1.b) * t);
        return `rgb(${r}, ${g}, ${b})`;
      }

      function lerpColorRGBA(c1, c2, t, alpha) {
        const r = Math.round(c1.r + (c2.r - c1.r) * t);
        const g = Math.round(c1.g + (c2.g - c1.g) * t);
        const b = Math.round(c1.b + (c2.b - c1.b) * t);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }

      glyphCtx.fillStyle = '#000000';
      glyphCtx.fillRect(0, 0, glyphSize, glyphSize);

      if (strokePaths.length === 0) return;

      glyphCtx.save();
      const padding = 45; // canvas pixels
      const drawSize = glyphSize - padding * 2;
      
      glyphCtx.translate(padding, padding);
      glyphCtx.scale(drawSize / 109, drawSize / 109);

      glyphCtx.lineCap = 'round';
      glyphCtx.lineJoin = 'round';

      // 1. Draw future/guide strokes (faint white/grey)
      glyphCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      glyphCtx.lineWidth = 4;
      const futureStart = isAnimating ? currentStrokeIndex : currentStrokeIndex;
      for (let i = futureStart; i < strokePaths.length; i++) {
        glyphCtx.stroke(new Path2D(strokePaths[i]));
      }

      // 2. Draw completed strokes (gradual yellow-to-blue drying effect)
      const cYellow = { r: 250, g: 204, b: 21 }; // #facc15
      const cBlue = { r: 56, g: 189, b: 248 };   // #38bdf8

      for (let i = 0; i < currentStrokeIndex; i++) {
        let dryProgress = 1.0;
        if (strokeCompletionTimes[i] !== undefined) {
          const elapsedMs = (animTime - strokeCompletionTimes[i]) * 1000;
          dryProgress = Math.min(1.0, elapsedMs / pauseBetweenStrokes);
        }
        
        glyphCtx.strokeStyle = lerpColor(cYellow, cBlue, dryProgress);
        glyphCtx.lineWidth = activeStrokeWidth - (activeStrokeWidth - dryLineWidth) * dryProgress;
        glyphCtx.stroke(new Path2D(strokePaths[i]));
      }

      // 3. Draw active stroke (yellow) and comet trail / red tip circles
      if (currentStrokeIndex < strokePaths.length && strokeProgress > 0) {
        const pathEl = strokeElements[currentStrokeIndex];
        const totalLength = pathEl.getTotalLength();
        const currentLength = totalLength * strokeProgress;
        const diameter = activeStrokeWidth * (tipSizePercent / 100);
        const radius = diameter / 2;

        // Calculate stroke duration and pause progress
        const strokeDuration = totalLength > 0 ? (totalLength / drawingSpeed) * 1000 : 100;
        let pauseProgress = 0.0;
        if (strokeTimeElapsed > strokeDuration) {
          pauseProgress = Math.min(1.0, (strokeTimeElapsed - strokeDuration) / pauseBetweenStrokes);
        }

        // Draw animated active stroke segment (with drying transition if single stroke)
        const dryProg = isSingleStrokeAnimating ? pauseProgress : 0.0;
        const col = lerpColor(cYellow, cBlue, dryProg);
        glyphCtx.strokeStyle = col;
        glyphCtx.lineWidth = activeStrokeWidth - (activeStrokeWidth - dryLineWidth) * dryProg;
        
        glyphCtx.save();
        glyphCtx.beginPath();
        glyphCtx.setLineDash([currentLength, totalLength]);
        glyphCtx.stroke(new Path2D(strokePaths[currentStrokeIndex]));
        glyphCtx.restore();

        const cRed = { r: 239, g: 68, b: 68 };     // #ef4444

        const L = strokeTipHistory.length;

        // Active stroke tip glow & comet trail (Bottom-to-Top: Trail except tip -> Glow -> Tip)
        // 1. Comet trail *except* the very tip (index 0 to L-2)
        if (L > 1) {
          const trailAlpha = Math.pow(1.0 - pauseProgress, 2);
          for (let i = 0; i < L - 1; i++) {
            let t = i / (L - 1);
            t = t * (1.0 - pauseProgress); // Fade color to yellow over pause

            const r = radius * (0.35 + 0.65 * t);
            const pt = strokeTipHistory[i];
            
            glyphCtx.fillStyle = lerpColorRGBA(cYellow, cRed, t, trailAlpha);
            glyphCtx.beginPath();
            glyphCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
            glyphCtx.fill();
          }
        }

        // 2. Glow circle (centered at the tip point)
        const tipPt = L > 0 ? strokeTipHistory[L - 1] : pathEl.getPointAtLength(currentLength);
        const tipRadius = L > 0 ? radius * (0.35 + 0.65 * (1.0 - pauseProgress)) : radius;
        const glowRadius = tipRadius * GLOW_RADIUS_MULTIPLIER;
        const glowAlpha = 1.0 - pauseProgress;

        if (glowRadius > 0 && glowAlpha > 0) {
          const grad = glyphCtx.createRadialGradient(tipPt.x, tipPt.y, 0, tipPt.x, tipPt.y, glowRadius);
          grad.addColorStop(0.0, `rgba(250, 204, 21, ${1.0 * glowAlpha})`);
          grad.addColorStop(0.25, `rgba(250, 204, 21, ${0.5625 * glowAlpha})`);
          grad.addColorStop(0.5, `rgba(250, 204, 21, ${0.25 * glowAlpha})`);
          grad.addColorStop(0.75, `rgba(250, 204, 21, ${0.0625 * glowAlpha})`);
          grad.addColorStop(1.0, `rgba(250, 204, 21, 0.0)`);

          glyphCtx.fillStyle = grad;
          glyphCtx.beginPath();
          glyphCtx.arc(tipPt.x, tipPt.y, glowRadius, 0, Math.PI * 2);
          glyphCtx.fill();
        }

        // 3. Very tip circle (index L-1 if L > 0, or fallback if L === 0)
        if (L > 0) {
          const pt = strokeTipHistory[L - 1];
          let t = 1.0 * (1.0 - pauseProgress);
          const tipAlpha = Math.pow(1.0 - pauseProgress, 2);
          glyphCtx.fillStyle = lerpColorRGBA(cYellow, cRed, t, tipAlpha);
          glyphCtx.beginPath();
          glyphCtx.arc(pt.x, pt.y, tipRadius, 0, Math.PI * 2);
          glyphCtx.fill();
        } else {
          // Fallback: draw single red tip circle at current length
          const point = pathEl.getPointAtLength(currentLength);
          glyphCtx.fillStyle = '#ef4444'; // Red
          glyphCtx.beginPath();
          glyphCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          glyphCtx.fill();
        }
      }

      glyphCtx.restore();

      // Copy offscreen canvas to WebGPU texture if active
      if (webgpuEnabled && webgpuSupported && device && glyphTexture) {
        device.queue.copyExternalImageToTexture(
          { source: glyphCanvas, flipY: false },
          { texture: glyphTexture },
          [glyphSize, glyphSize]
        );
      }
    }

    async function loadKanjiSVG(char) {
      if (char === loadedCharacter) {
        return;
      }
      loadedCharacter = char;
      strokeCompletionTimes = [];

      if (char) {
        document.title = `WebGPU Kanji Renderer - ${char}`;
        const logoSpan = document.querySelector('.logo-area .jp-logo');
        if (logoSpan) {
          logoSpan.textContent = char;
          logoSpan.href = `?char=${encodeURIComponent(char)}`;
        }
      } else {
        document.title = 'WebGPU Kanji Renderer';
        const logoSpan = document.querySelector('.logo-area .jp-logo');
        if (logoSpan) {
          logoSpan.textContent = '';
          logoSpan.href = '#';
        }
      }

      if (!char) {
        strokePaths = [];
        strokePolylines = [];
        strokeElements = [];
        currentStrokeCount = 0;
        currentStrokeIndex = 0;
        strokeProgress = 0.0;
        strokeTimeElapsed = 0;
        updateStrokeDisplay();
        drawStrokesToCanvas();
        updateControlsState();
        return;
      }

      const codePoint = char.codePointAt(0);
      const hexStr = codePoint.toString(16).padStart(5, '0');
      const url = `kanjivg/kanji/${hexStr}.svg`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Character '${char}' not found in local KanjiVG database.`);
        }
        const svgText = await res.text();
        // Strip DOCTYPE and insert kvg namespace declaration into the root <svg> element
        let cleanSvgText = svgText.replace(/<!DOCTYPE[\s\S]*?(?=<svg)/gi, '');
        cleanSvgText = cleanSvgText.replace(/<svg\s/gi, '<svg xmlns:kvg="http://kanjivg.tagaini.net" ');
        
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(cleanSvgText, 'image/svg+xml');
        
        const parserError = svgDoc.querySelector('parsererror');
        if (parserError) {
          throw new Error(`XML Parser Error: ${parserError.textContent}`);
        }
        
        const paths = Array.from(svgDoc.querySelectorAll('path'));
        if (paths.length === 0) {
          throw new Error(`Empty strokes list for character '${char}'`);
        }

        // Setup paths and elements inside helper SVG in DOM
        const svgHelper = document.getElementById('svg-helper');
        svgHelper.innerHTML = ''; // clear

        strokePaths = [];
        strokePolylines = [];
        strokeElements = [];

        const svgNS = "http://www.w3.org/2000/svg";
        for (let i = 0; i < paths.length; i++) {
          const d = paths[i].getAttribute('d');
          strokePaths.push(d);
          
          const polys = SVGPathInterpreter.parseToPolylines(d);
          const cleanedPolys = polys.map(poly => cleanPolyline(poly));
          console.log(`Parsed path ${i} sample points:`, cleanedPolys[0] ? cleanedPolys[0].slice(0, 3).map(pt => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(" | ") : "empty");
          cleanedPolys.forEach(poly => {
            if (poly.length > 0) {
              computePolylineLengths(poly);
            }
          });
          strokePolylines.push(cleanedPolys);

          const pathEl = document.createElementNS(svgNS, 'path');
          pathEl.setAttribute('d', d);
          svgHelper.appendChild(pathEl);
          strokeElements.push(pathEl);
        }

        currentStrokeCount = strokePaths.length;
        currentStrokeIndex = 0; // Starts blank
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;

        clearError();
        updateStrokeDisplay();
        drawStrokesToCanvas();
      } catch (err) {
        showLocalError('Kanji Database Error', err.message);
        strokePaths = [];
        strokePolylines = [];
        strokeElements = [];
        currentStrokeCount = 0;
        currentStrokeIndex = 0;
        strokeProgress = 0.0;
        strokeTimeElapsed = 0;
        updateStrokeDisplay();
        drawStrokesToCanvas();
      }
      updateControlsState();
    }

    function showLocalError(title, msg) {
      showToast(`${title}: ${msg}`);
    }

    function clearError() {
      // No-op: toast handles itself
    }

    // Playback state updates
    function updateControlsState() {
      btnAnimate.disabled = isAnimating;
      btnStop.disabled = !isAnimating;
      
      const fullyDrawn = currentStrokeIndex >= currentStrokeCount || (currentStrokeIndex === currentStrokeCount - 1 && strokeProgress >= 1.0);
      btnOneStroke.disabled = isAnimating || fullyDrawn;
      
      const nothingDrawn = (currentStrokeIndex === 0 && strokeProgress === 0.0);
      btnBackStroke.disabled = isAnimating || nothingDrawn;
    }

    function startAnimation() {
      if (isAnimating) return;

      isSingleStrokeAnimating = false;

      // Wrap-around logic: if completed, restart from 0
      if (currentStrokeIndex >= currentStrokeCount) {
        currentStrokeIndex = 0;
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;
        drawStrokesToCanvas();
        updateStrokeDisplay();
      } else if (strokeProgress >= 1.0) {
        currentStrokeIndex++;
        if (currentStrokeIndex >= currentStrokeCount) {
          currentStrokeIndex = 0;
        }
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;
      }

      isAnimating = true;
      updateControlsState();
    }

    function stopAnimation() {
      isAnimating = false;
      isSingleStrokeAnimating = false;
      updateControlsState();
    }

    function stepForward() {
      if (isAnimating) return;

      if (currentStrokeIndex < currentStrokeCount) {
        if (strokeProgress >= 1.0) {
          currentStrokeIndex++;
          if (currentStrokeIndex >= currentStrokeCount) {
            return;
          }
        }
        
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;
        strokeTipHistory = [];
        isAnimating = true;
        isSingleStrokeAnimating = true;
        updateControlsState();
      }
    }

    function stepBackward() {
      stopAnimation();
      if (currentStrokeIndex >= currentStrokeCount) {
        // If fully completed, immediately go back to the start of the last stroke
        currentStrokeIndex = currentStrokeCount - 1;
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;
        strokeTipHistory = [];
        strokeCompletionTimes[currentStrokeIndex] = undefined;
        drawStrokesToCanvas();
        updateStrokeDisplay();
      } else if (strokeProgress > 0.0) {
        // Erase current drawing stroke
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;
        strokeTipHistory = [];
        drawStrokesToCanvas();
        updateStrokeDisplay();
      } else if (currentStrokeIndex > 0) {
        // Step back one full stroke
        currentStrokeIndex--;
        strokeProgress = 0.0;
        strokeTimeElapsed = 0.0;
        strokeTipHistory = [];
        strokeCompletionTimes[currentStrokeIndex] = undefined;
        drawStrokesToCanvas();
        updateStrokeDisplay();
      }
      updateControlsState();
    }

    // Bind UI controls events
    elGlow.addEventListener('input', (e) => {
      controls.glowIntensity = parseFloat(e.target.value);
      valGlow.innerText = controls.glowIntensity.toFixed(1);
    });
    elZoom.addEventListener('input', (e) => {
      controls.zoom = parseFloat(e.target.value);
      valZoom.innerText = controls.zoom.toFixed(1);
    });

    const aaFactors = [1, 4, 8, 16];
    const aaLabels = ["None", "4x", "8x", "16x"];
    elAntiAliasing.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value);
      const factor = aaFactors[idx];
      controls.antiAliasing = factor;
      valAntiAliasing.innerText = aaLabels[idx];
      recreateGlyphTexture(factor);
    });

    elTipSize.addEventListener('input', (e) => {
      tipSizePercent = parseInt(e.target.value);
      valTipSize.innerText = tipSizePercent + '%';
      drawStrokesToCanvas();
    });

    elLineWeight.addEventListener('input', (e) => {
      dryLineWidth = parseFloat(e.target.value);
      valLineWeight.innerText = dryLineWidth.toFixed(1);
      drawStrokesToCanvas();
    });

    elTrailLength.addEventListener('input', (e) => {
      trailLength = parseInt(e.target.value);
      valTrailLength.innerText = trailLength;
      drawStrokesToCanvas();
    });

    elAnimSpeed.addEventListener('input', (e) => {
      drawingSpeed = parseInt(e.target.value);
      valAnimSpeed.innerText = drawingSpeed + '/s';
    });

    elPauseDur.addEventListener('input', (e) => {
      pauseBetweenStrokes = parseInt(e.target.value);
      valPauseDur.innerText = pauseBetweenStrokes + 'ms';
    });

    function handleInput(val) {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        const singleChar = trimmed.substring(0, 1);
        elCharInput.value = singleChar;
        stopAnimation();
        loadKanjiSVG(singleChar);
      } else {
        stopAnimation();
        loadKanjiSVG('');
      }
    }

    elCharInput.addEventListener('compositionstart', () => {
      isComposing = true;
    });

    elCharInput.addEventListener('compositionend', (e) => {
      isComposing = false;
      setTimeout(() => {
        handleInput(elCharInput.value);
      }, 0);
    });

    elCharInput.addEventListener('input', (e) => {
      if (isComposing) return;
      handleInput(e.target.value);
    });

    btnAnimate.addEventListener('click', startAnimation);
    btnStop.addEventListener('click', stopAnimation);
    btnOneStroke.addEventListener('click', stepForward);
    btnBackStroke.addEventListener('click', stepBackward);

    btnReset.addEventListener('click', () => {
      stopAnimation();
      
      elGlow.value = 0.0;
      controls.glowIntensity = 0.0;
      valGlow.innerText = '0.0';
      
      elZoom.value = 1.4;
      controls.zoom = 1.4;
      valZoom.innerText = '1.4';

      elAntiAliasing.value = 1;
      controls.antiAliasing = 4;
      valAntiAliasing.innerText = '4x';
      recreateGlyphTexture(4);

      elTipSize.value = 80;
      tipSizePercent = 80;
      valTipSize.innerText = '80%';

      elLineWeight.value = 5.0;
      dryLineWidth = 5.0;
      valLineWeight.innerText = '5.0';

      elTrailLength.value = 140;
      trailLength = 140;
      valTrailLength.innerText = '140';

      elAnimSpeed.value = 80;
      drawingSpeed = 80;
      valAnimSpeed.innerText = '80/s';

      elPauseDur.value = 300;
      pauseBetweenStrokes = 300;
      valPauseDur.innerText = '300ms';
      
      currentStrokeIndex = 0;
      strokeProgress = 0.0;
      strokeTimeElapsed = 0.0;
      strokeTipHistory = [];
      strokeCompletionTimes = [];
      
      updateStrokeDisplay();
      drawStrokesToCanvas();
      updateControlsState();
    });

    // Add no-op click handlers to container divs (just register presence for touch action)
    const playbackGrid = document.querySelector('.playback-grid');
    const headerInputRow = document.querySelector('.header-input-row');
    const inputRows = document.querySelectorAll('.input-row');
    const headerInputCard = document.querySelector('.header-input-card');

    if (playbackGrid) {
      playbackGrid.addEventListener('click', () => {
        // No-op: just intercepts disabled button taps that bubble through
      });
    }

    if (headerInputRow) {
      headerInputRow.addEventListener('click', () => {
        // No-op: just intercepts disabled button taps that bubble through
      });
    }

    inputRows.forEach((row) => {
      row.addEventListener('click', () => {
        // No-op: just intercepts disabled element taps that bubble through
      });
    });

    if (headerInputCard) {
      headerInputCard.addEventListener('click', () => {
        // No-op: just intercepts disabled element taps that bubble through
      });
    }

    // Parse URL parameter 'char'
    const urlParams = new URLSearchParams(window.location.search);
    let initialChar = urlParams.get('char');
    if (initialChar) {
      initialChar = initialChar.trim().substring(0, 1);
    }
    if (!initialChar) {
      initialChar = '愛';
    }
    elCharInput.value = initialChar;

    // Load initial Kanji SVG and auto-start animation
    await loadKanjiSVG(initialChar);
    startAnimation();

    // Resize handling
    resizeObserverInstance = new ResizeObserver(() => {
      resizeCanvas(canvas);
    });
    resizeObserverInstance.observe(canvas.parentElement);

    // Frame/Time Render Loop
    let lastTime = performance.now();
    
    // Check if any completed stroke is currently in the drying phase
    function isAnyStrokeDrying() {
      for (let i = 0; i < strokeCompletionTimes.length; i++) {
        if (strokeCompletionTimes[i] !== undefined) {
          const elapsedMs = (animTime - strokeCompletionTimes[i]) * 1000;
          if (elapsedMs < pauseBetweenStrokes) {
            return true;
          }
        }
      }
      return false;
    }

    function frame(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      animTime += dt;

      let needsRedraw = false;

      // Update stroke animation progress smoothly
      if (isAnimating && currentStrokeIndex < currentStrokeCount) {
        needsRedraw = true;

        const pathEl = strokeElements[currentStrokeIndex];
        const totalLength = pathEl.getTotalLength();
        const strokeDuration = totalLength > 0 ? (totalLength / drawingSpeed) * 1000 : 100;
        
        const stepDuration = strokeDuration + pauseBetweenStrokes;

        strokeTimeElapsed += dt * 1000;
        strokeProgress = Math.min(1.0, strokeTimeElapsed / strokeDuration);

        // Record tip position history during drawing phase
        if (strokeTimeElapsed <= strokeDuration) {
          const currentLength = totalLength * strokeProgress;
          const point = pathEl.getPointAtLength(currentLength);
          strokeTipHistory.push({ x: point.x, y: point.y });
          if (strokeTipHistory.length > trailLength) {
            strokeTipHistory.shift();
          }
        }

        if (strokeTimeElapsed >= stepDuration) {
          const dryOffset = isSingleStrokeAnimating ? (pauseBetweenStrokes / 1000) : 0.0;
          strokeCompletionTimes[currentStrokeIndex] = animTime - dryOffset;
          currentStrokeIndex++;
          strokeProgress = 0.0;
          strokeTimeElapsed = 0.0;
          strokeTipHistory = []; // Clear history for the next stroke

          if (currentStrokeIndex >= currentStrokeCount) {
            currentStrokeIndex = currentStrokeCount;
            strokeProgress = 1.0;
            isAnimating = false;
            isSingleStrokeAnimating = false;
          } else if (isSingleStrokeAnimating) {
            isAnimating = false;
            isSingleStrokeAnimating = false;
          }
        }
        
        updateStrokeDisplay();
        updateControlsState();
      }

      // Check if we need to redraw because ink is still drying
      if (!needsRedraw && isAnyStrokeDrying()) {
        needsRedraw = true;
      }

      if (needsRedraw) {
        drawStrokesToCanvas(undefined);
      }

      let commandEncoder = null;
      if (webgpuEnabled && webgpuSupported && device && context) {
        commandEncoder = device.createCommandEncoder();
      }

      if (webgpuEnabled && webgpuSupported && device && context) {
        // Pack uniform properties
        uniformFloatView[0] = controls.glowIntensity;
        uniformFloatView[1] = controls.zoom;
        uniformFloatView[2] = animTime;
        uniformFloatView[3] = canvas.width / canvas.height;

        device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        // Rendering pass
        const textureView = context.getCurrentTexture().createView();

        const renderPassDescriptor = {
          colorAttachments: [
            {
              view: textureView,
              clearValue: { r: 0.0392, g: 0.0549, b: 0.0902, a: 1.0 },
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.setIndexBuffer(indexBuffer, 'uint16');
        passEncoder.drawIndexed(6);
        passEncoder.end();

        device.queue.submit([commandEncoder.finish()]);
      } else {
        if (visibleCtx) {
          visibleCtx.clearRect(0, 0, canvas.width, canvas.height);
          
          // Apply matching center-anchored zoom scale factor (using baseline 0.85 scale to match WebGPU quad layout)
          const scaleFactor = controls.zoom * 0.85;
          visibleCtx.translate(canvas.width / 2, canvas.height / 2);
          visibleCtx.scale(scaleFactor, scaleFactor);
          visibleCtx.drawImage(glyphCanvas, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
          visibleCtx.setTransform(1, 0, 0, 1, 0, 0); // Restore default transform context
        }
      }

      requestAnimationFrame(frame);
    }

    function initCanvasFallback() {
      webgpuEnabled = false;
      visibleCtx = canvas.getContext('2d');
      canvas.classList.add('fallback-mode');
      
      statusBadge.className = 'gpu-status-badge disabled';
      statusBadge.querySelector('.status-text').innerText = webgpuSupported ? 'WebGPU Disabled' : '2D Fallback';

      if (elGlowControl) {
        elGlowControl.classList.add('hidden');
      }
      if (elAAControl) {
        elAAControl.classList.add('hidden');
      }
    }

    function setRenderingMode(useWebGPU) {
      if (useWebGPU && webgpuSupported) {
        webgpuEnabled = true;
        resetCanvasContext('webgpu');
        statusBadge.className = 'gpu-status-badge connected';
        statusBadge.querySelector('.status-text').innerText = 'WebGPU Connected';
        if (elGlowControl) {
          elGlowControl.classList.remove('hidden');
        }
        if (elAAControl) {
          elAAControl.classList.remove('hidden');
        }
      } else {
        webgpuEnabled = false;
        resetCanvasContext('2d');
        statusBadge.className = 'gpu-status-badge disabled';
        statusBadge.querySelector('.status-text').innerText = webgpuSupported ? 'WebGPU Disabled' : '2D Fallback';
        if (elGlowControl) {
          elGlowControl.classList.add('hidden');
        }
        if (elAAControl) {
          elAAControl.classList.add('hidden');
        }
      }
      drawStrokesToCanvas();
    }

    function resetCanvasContext(type) {
      const oldCanvas = document.getElementById('gpu-canvas');
      const newCanvas = oldCanvas.cloneNode(true);
      
      if (type === 'webgpu') {
        newCanvas.classList.remove('fallback-mode');
      } else {
        newCanvas.classList.add('fallback-mode');
      }
      
      oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);
      canvas = newCanvas;
      
      if (resizeObserverInstance) {
        resizeObserverInstance.disconnect();
        resizeObserverInstance.observe(canvas.parentElement);
      }
      
      resizeCanvas(canvas);
      
      if (type === 'webgpu') {
        context = canvas.getContext('webgpu');
        context.configure({
          device: device,
          format: presentationFormat,
          alphaMode: 'premultiplied'
        });
        visibleCtx = null;
      } else {
        visibleCtx = canvas.getContext('2d');
        context = null;
      }
    }

    requestAnimationFrame(frame);
  }

function resizeCanvas(canvas) {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const targetWidth = canvas.clientWidth * devicePixelRatio;
  const targetHeight = canvas.clientHeight * devicePixelRatio;
  
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.innerText = message;
  toast.classList.add('show');
  
  if (toast.timeoutId) {
    clearTimeout(toast.timeoutId);
  }
  
  toast.timeoutId = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

window.addEventListener('DOMContentLoaded', initApp);
