# WebGPU Hiragana Renderer (あ)

A modern, real-time 3D WebGPU renderer that draws a dynamic glowing glass pane displaying the Japanese character **"あ" (Ah)**.

## Project Structure
- [index.html](file:///Users/raging/Code/drawkanji/index.html) - Application UI layout and server instructions.
- [styles.css](file:///Users/raging/Code/drawkanji/styles.css) - Custom dark-mode glassmorphic styling sheet.
- [app.js](file:///Users/raging/Code/drawkanji/app.js) - WebGPU WGSL shaders, vertex/index buffer configuration, matrix calculations, and controls listener.

## Serving Locally with Python

WebGPU requires a secure context (such as `https://` or `http://localhost/` / `http://127.0.0.1/`). You can serve this project using a local Python HTTP server bound to localhost.

### Step 1: Open Terminal
Open your terminal and navigate to the project directory:
```bash
cd /Users/raging/Code/drawkanji
```

### Step 2: Start the Python HTTP Server
Run the built-in HTTP server module, specifying port `8000` and binding to `127.0.0.1` (localhost):
```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

### Step 3: View in Browser
Open a modern WebGPU-supported web browser (such as Chrome 113+, Edge 113+, Safari 18+, or Firefox Nightly) and visit:
[http://127.0.0.1:8000](http://127.0.0.1:8000)
