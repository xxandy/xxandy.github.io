// Application State
let strokePaths = [];
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
  
  // Final compositing
  let finalRGB = mix(glassBody, finalGlyphColor, strokeMask);
  let finalAlpha = mix(0.72 + borderMask * 0.28, 0.96, strokeMask);
  
  return vec4<f32>(finalRGB, finalAlpha);
}
`;

// Application Setup
async function initApp() {
  const statusBadge = document.getElementById('gpu-status');
  const errorOverlay = document.getElementById('webgpu-error');
  const errorDetails = document.getElementById('error-details');
  const canvas = document.getElementById('gpu-canvas');

  // WebGPU Support Verification
  if (!navigator.gpu) {
    statusBadge.classList.add('error');
    statusBadge.querySelector('.status-text').innerText = 'WebGPU Unsupported';
    errorDetails.innerText = 'navigator.gpu is undefined. Your browser does not support WebGPU, or WebGPU is disabled. Secure context (localhost/127.0.0.1/https) is required.';
    errorOverlay.classList.remove('hidden');
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No appropriate GPU adapter found');
    }
    const device = await adapter.requestDevice();
    
    statusBadge.classList.add('connected');
    statusBadge.querySelector('.status-text').innerText = 'WebGPU Connected';

    // Configure WebGPU Canvas Context
    const context = canvas.getContext('webgpu');
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    
    resizeCanvas(canvas);

    context.configure({
      device: device,
      format: presentationFormat,
      alphaMode: 'premultiplied'
    });

    // 2D Offscreen Canvas for Stroke Vector Rendering
    const glyphSize = 512;
    const glyphCanvas = document.createElement('canvas');
    glyphCanvas.width = glyphSize;
    glyphCanvas.height = glyphSize;
    const glyphCtx = glyphCanvas.getContext('2d');

    const glyphTexture = device.createTexture({
      size: [glyphSize, glyphSize, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    const sampler = device.createSampler({
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

    const vertexBuffer = device.createBuffer({
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

    const indexBuffer = device.createBuffer({
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true
    });
    new Uint16Array(indexBuffer.getMappedRange()).set(indexData);
    indexBuffer.unmap();

    // Uniform Buffer Setup (16 bytes aligned)
    const uniformBufferSize = 16;
    const uniformBuffer = device.createBuffer({
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const uniformData = new ArrayBuffer(uniformBufferSize);
    const uniformFloatView = new Float32Array(uniformData);

    // Build Render Pipeline
    const shaderModule = device.createShaderModule({
      code: wgslShaders
    });

    const pipeline = device.createRenderPipeline({
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

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: glyphTexture.createView() },
        { binding: 2, resource: sampler }
      ]
    });

    // GUI state
    const controls = {
      glowIntensity: 1.5,
      zoom: 1.4
    };

    // Bind controls
    const elGlow = document.getElementById('glow-intensity');
    const elTipSize = document.getElementById('tip-size');
    const elLineWeight = document.getElementById('line-weight');
    const elTrailLength = document.getElementById('trail-length');
    const elZoom = document.getElementById('zoom');
    
    const valGlow = document.getElementById('glow-intensity-val');
    const valTipSize = document.getElementById('tip-size-val');
    const valLineWeight = document.getElementById('line-weight-val');
    const valTrailLength = document.getElementById('trail-length-val');
    const valZoom = document.getElementById('zoom-val');
    
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

    // Canvas rendering (Strokes grown dynamically, and colored)
    function drawStrokesToCanvas() {
      const activeStrokeWidth = dryLineWidth * (8.0 / 6.5);

      function lerpColor(c1, c2, t) {
        const r = Math.round(c1.r + (c2.r - c1.r) * t);
        const g = Math.round(c1.g + (c2.g - c1.g) * t);
        const b = Math.round(c1.b + (c2.b - c1.b) * t);
        return `rgb(${r}, ${g}, ${b})`;
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

        // Draw animated active stroke segment (solid yellow)
        glyphCtx.strokeStyle = '#facc15'; // Neon yellow
        glyphCtx.lineWidth = activeStrokeWidth;
        
        glyphCtx.save();
        glyphCtx.beginPath();
        glyphCtx.setLineDash([currentLength, totalLength]);
        glyphCtx.stroke(new Path2D(strokePaths[currentStrokeIndex]));
        glyphCtx.restore();

        // Calculate stroke duration and pause progress
        const strokeDuration = totalLength > 0 ? (totalLength / drawingSpeed) * 1000 : 100;
        let pauseProgress = 0.0;
        if (!isSingleStrokeAnimating && strokeTimeElapsed > strokeDuration) {
          pauseProgress = Math.min(1.0, (strokeTimeElapsed - strokeDuration) / pauseBetweenStrokes);
        }

        const cYellow = { r: 250, g: 204, b: 21 }; // #facc15
        const cRed = { r: 239, g: 68, b: 68 };     // #ef4444

        const L = strokeTipHistory.length;
        if (L > 0) {
          // Draw the history of tip positions as a fading comet trail
          for (let i = 0; i < L; i++) {
            let t = L > 1 ? i / (L - 1) : 1.0;
            t = t * (1.0 - pauseProgress); // Fade color to yellow over pause

            const r = radius * (0.35 + 0.65 * t);
            const pt = strokeTipHistory[i];
            
            glyphCtx.fillStyle = lerpColor(cYellow, cRed, t);
            glyphCtx.beginPath();
            glyphCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
            glyphCtx.fill();
          }
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

      // Copy offscreen canvas to WebGPU texture
      device.queue.copyExternalImageToTexture(
        { source: glyphCanvas, flipY: false },
        { texture: glyphTexture },
        [glyphSize, glyphSize]
      );
    }

    async function loadKanjiSVG(char) {
      if (char === loadedCharacter) {
        return;
      }
      loadedCharacter = char;
      strokeCompletionTimes = [];

      if (!char) {
        strokePaths = [];
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
        strokeElements = [];

        const svgNS = "http://www.w3.org/2000/svg";
        for (let i = 0; i < paths.length; i++) {
          const d = paths[i].getAttribute('d');
          strokePaths.push(d);

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
      document.getElementById('error-title').innerText = title;
      errorDetails.innerText = msg;
      errorOverlay.classList.remove('hidden');
    }

    function clearError() {
      errorOverlay.classList.add('hidden');
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
      
      elGlow.value = 1.5;
      controls.glowIntensity = 1.5;
      valGlow.innerText = '1.5';
      
      elZoom.value = 1.4;
      controls.zoom = 1.4;
      valZoom.innerText = '1.4';

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

    // Load initial Kanji SVG ("愛") and auto-start animation
    await loadKanjiSVG('愛');
    startAnimation();

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas(canvas);
    });
    resizeObserver.observe(canvas.parentElement);

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
        
        let stepDuration = strokeDuration;
        if (!isSingleStrokeAnimating) {
          stepDuration = strokeDuration + pauseBetweenStrokes;
        }

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
          strokeCompletionTimes[currentStrokeIndex] = animTime;
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
        drawStrokesToCanvas();
      }

      // Pack uniform properties
      uniformFloatView[0] = controls.glowIntensity;
      uniformFloatView[1] = controls.zoom;
      uniformFloatView[2] = animTime;
      uniformFloatView[3] = canvas.width / canvas.height;

      device.queue.writeBuffer(uniformBuffer, 0, uniformData);

      // Rendering pass
      const commandEncoder = device.createCommandEncoder();
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

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

  } catch (err) {
    console.error('WebGPU initialization error:', err);
    statusBadge.classList.add('error');
    statusBadge.querySelector('.status-text').innerText = 'Initialization Error';
    showLocalError('WebGPU Initialization Error', `WebGPU initialization failed with error: ${err.message || err}`);
  }
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

window.addEventListener('DOMContentLoaded', initApp);
