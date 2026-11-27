// Compiles a `.canvas.tsx` module into one self-contained browser script, offline.
//
// esbuild (bundled into the Host image with its platform binary) transpiles the TSX and bundles
// React, ReactDOM and the RokBot canvas SDK (canvas-sdk/) from this package's node_modules, so
// nothing is fetched at write or view time. Any other bare import is a compile error, matching
// the official contract that a canvas is self-contained.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const CANVAS_SDK_DIR = join(here, "canvas-sdk");
export const CANVAS_SDK_MODULES = ["cursor/canvas", "@cursor/canvas", "rokbot/canvas", "@rokbot/canvas"];
const REACT_MODULES = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"]);
export const CANVAS_BUNDLE_MAX_BYTES = 4 * 1024 * 1024;

let esbuildPromise;
function loadEsbuild() {
  esbuildPromise ??= import("esbuild").then((mod) => mod.default ?? mod);
  return esbuildPromise;
}

const ENTRY = `
import * as Canvas from "rokbot-canvas-source";
import { mountCanvas } from "rokbot-canvas-mount";
mountCanvas(Canvas);
`;

function canvasResolver(source) {
  return {
    name: "rokbot-canvas",
    setup(build) {
      build.onResolve({ filter: /^rokbot-canvas-source$/ }, () => ({ path: "source.canvas.tsx", namespace: "canvas-source" }));
      build.onLoad({ filter: /.*/, namespace: "canvas-source" }, () => ({ contents: source, loader: "tsx", resolveDir: CANVAS_SDK_DIR }));
      build.onResolve({ filter: /^rokbot-canvas-mount$/ }, () => ({ path: join(CANVAS_SDK_DIR, "mount.jsx") }));
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        if (CANVAS_SDK_MODULES.includes(args.path)) return { path: join(CANVAS_SDK_DIR, "index.jsx") };
        if (REACT_MODULES.has(args.path)) return { path: require.resolve(args.path) };
        // SDK and React internals resolve relative to their own files.
        if (args.importer && args.namespace === "file" && (args.path.startsWith(".") || args.path.startsWith("/"))) {
          const fromSdk = args.importer.startsWith(CANVAS_SDK_DIR);
          const fromDeps = args.importer.includes(`${join("node_modules")}`);
          if (fromSdk || fromDeps) return undefined;
        }
        if (args.importer && args.importer.includes("node_modules")) return undefined;
        return {
          errors: [{
            text: `Cannot import "${args.path}". A canvas is one self-contained module: it may import only "react" and "cursor/canvas".`,
          }],
        };
      });
    },
  };
}

function toDiagnostics(messages = []) {
  return messages.map((message) => {
    const loc = message.location;
    return {
      message: message.text,
      severity: "error",
      ...(loc ? {
        range: {
          start: { line: Math.max(0, loc.line - 1), character: loc.column },
          end: { line: Math.max(0, loc.line - 1), character: loc.column + Math.max(1, loc.length ?? 1) },
        },
      } : {}),
    };
  });
}

function describe(messages = []) {
  return messages.map((m) => {
    const loc = m.location;
    return loc ? `${loc.line}:${loc.column + 1} ${m.text}${loc.lineText ? `\n  ${loc.lineText}` : ""}` : m.text;
  }).join("\n");
}

/**
 * `compileCanvas(source)` -> `{ ok: true, code }` or `{ ok: false, detail, diagnostics }`.
 * The module must default-export a React component (the official contract).
 */
export async function compileCanvas(source) {
  if (!/\bexport\s+default\b/.test(source) && !/\bexport\s*\{[^}]*\bas\s+default\b/.test(source)) {
    return {
      ok: false,
      detail: "The canvas must `export default` a React component.",
      diagnostics: [{ message: "Missing default export: add `export default function Canvas() { ... }`.", severity: "error" }],
    };
  }
  const esbuild = await loadEsbuild();
  try {
    const result = await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: CANVAS_SDK_DIR, loader: "js", sourcefile: "entry.js" },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: ["es2020", "chrome100", "safari15"],
      jsx: "automatic",
      minify: true,
      legalComments: "none",
      logLevel: "silent",
      charset: "utf8",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [canvasResolver(source)],
    });
    const code = result.outputFiles[0].text;
    if (Buffer.byteLength(code, "utf8") > CANVAS_BUNDLE_MAX_BYTES) {
      return { ok: false, detail: "The compiled canvas is too large.", diagnostics: [] };
    }
    return { ok: true, code };
  } catch (error) {
    const errors = Array.isArray(error?.errors) ? error.errors : [];
    if (errors.length === 0) return { ok: false, detail: String(error?.message ?? error), diagnostics: [] };
    return { ok: false, detail: describe(errors), diagnostics: toDiagnostics(errors) };
  }
}
