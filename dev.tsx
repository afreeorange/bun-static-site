import { h } from "preact";
import { render } from "preact-render-to-string";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";

import * as sass from "sass";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

// Define source and output paths
const SRC_DIR = join(process.cwd(), "src");
const DIST_DIR = join(process.cwd(), "dist");
const SASS_SRC = join(SRC_DIR, "main.scss");
const TSX_SRC = join(SRC_DIR, "main.tsx");
const CSS_DIST = join(DIST_DIR, "main.css");
const HTML_DIST = join(DIST_DIR, "index.html");

// Server options
const PORT = 3000;
const LIVE_RELOAD_SCRIPT = `
<script>
  (function() {
    const socket = new WebSocket('ws://localhost:${PORT}/ws');
    socket.onmessage = function(msg) {
      if (msg.data === 'reload') window.location.reload();
    };
    socket.onclose = function() {
      console.log('Live reload connection closed. Reconnecting...');
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    };
  })();
</script>
`;

// Track connected WebSocket clients
const clients = new Set();

async function main() {
	await mkdir(DIST_DIR, { recursive: true });
	await buildAll();

	setupWatchers();
	startServer();

	console.log(`Development server running at http://localhost:${PORT}`);
}

async function buildAll() {
	try {
		console.log("Compiling SASS and Tailwind CSS...");
		await compileSassAndTailwind();

		console.log("Compiling TSX to HTML via SSR...");
		await compileAndRenderTSX();
	} catch (error) {
		console.error("Build failed:", error);
	}
}

async function compileSassAndTailwind() {
	try {
		// Compile SASS to CSS
		const sassResult = sass.compile(SASS_SRC, {
			quietDeps: true,
		});

		// Process the compiled CSS with Tailwind
		const postcssResult = await postcss([tailwindcss()]).process(
			`
@import "tailwindcss";
${sassResult.css}
`,
			{
				from: SASS_SRC,
				to: CSS_DIST,
			},
		);

		// Write the final CSS to the output file
		await writeFile(CSS_DIST, postcssResult.css);
		console.log(`CSS compiled and saved to ${CSS_DIST}`);
	} catch (error) {
		console.error("Error compiling SASS/Tailwind:", error);
	}
}

async function compileAndRenderTSX() {
	try {
		// Clear require cache to ensure fresh imports
		Object.keys(require.cache).forEach((key) => {
			if (key.includes(SRC_DIR)) {
				delete require.cache[key];
			}
		});

		// Dynamically import the TSX file
		const modulePath = `${TSX_SRC}?update=${Date.now()}`; // Add cache busting
		const { default: App } = await import(modulePath);

		// Render the Preact component to a string
		// Use h from preact as the JSX factory
		const renderedHtml = render(h(App, null));

		// Create a complete HTML document with the rendered component and live reload script
		const htmlDocument = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SSR Preact Bun App</title>
  <link rel="stylesheet" href="./main.css">
  ${LIVE_RELOAD_SCRIPT}
</head>
<body>
  <div id="root">${renderedHtml}</div>
  <script type="module" src="./client.js"></script>
</body>
</html>`;

		// Write the HTML to the output file
		await writeFile(HTML_DIST, htmlDocument);
		console.log(`TSX rendered and saved to ${HTML_DIST}`);

		// Generate a simple client hydration script
		const clientScript = `
import { render, h } from 'preact';
import App from './src/main.tsx';

// Hydrate the app on the client side
render(h(App, null), document.getElementById('root'));
`;

		await writeFile(join(DIST_DIR, "client.js"), clientScript);
		console.log("Client hydration script generated");
	} catch (error) {
		console.error("Error rendering TSX:", error);
	}
}

function setupWatchers() {
	// Watch SCSS files
	watch(SRC_DIR, { recursive: true }, async (eventType, filename) => {
		if (filename.endsWith(".scss")) {
			console.log(`SCSS file changed: ${filename}`);
			await compileSassAndTailwind();
			notifyClients();
		}

		if (filename.endsWith(".tsx") || filename.endsWith(".ts")) {
			console.log(`TSX/TS file changed: ${filename}`);
			await compileAndRenderTSX();
			notifyClients();
		}
	});

	console.log("File watchers set up for .scss, .tsx, and .ts files");
}

function startServer() {
	Bun.serve({
		port: PORT,
		fetch(req, server) {
			const url = new URL(req.url);

			// Handle WebSocket connections for live-reload
			if (url.pathname === "/ws") {
				// This is the correct way to handle WebSockets in Bun
				const success = server.upgrade(req);
				if (!success) {
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return undefined;
			}

			// Serve static files from dist directory
			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(Bun.file(HTML_DIST));
			}

			if (url.pathname === "/main.css") {
				return new Response(Bun.file(CSS_DIST), {
					headers: { "Content-Type": "text/css" },
				});
			}

			if (url.pathname === "/client.js") {
				return new Response(Bun.file(join(DIST_DIR, "client.js")), {
					headers: { "Content-Type": "application/javascript" },
				});
			}

			// Handle imports for client-side hydration
			if (url.pathname.startsWith("/src/")) {
				const filePath = join(process.cwd(), url.pathname);
				const file = Bun.file(filePath);
				return file.size > 0
					? new Response(file, {
							headers: { "Content-Type": "application/javascript" },
						})
					: new Response("Not found", { status: 404 });
			}

			// Try to serve any other file from dist directory
			const filePath = join(DIST_DIR, url.pathname);
			const file = Bun.file(filePath);

			return file.size > 0
				? new Response(file)
				: new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				clients.add(ws);
				console.log(
					`New WebSocket client connected. Total clients: ${clients.size}`,
				);
			},
			close(ws) {
				clients.delete(ws);
				console.log(
					`WebSocket client disconnected. Remaining clients: ${clients.size}`,
				);
			},
			message(ws, message) {
				// We can handle client messages here if needed
				console.log(`Received message from client: ${message}`);
			},
		},
	});

	console.log(`Server started on port ${PORT}`);
}

function notifyClients() {
	console.log(`Notifying ${clients.size} connected clients to reload...`);
	for (const client of clients) {
		client.send("reload");
	}
}

// Run the build process
main().catch((err) => {
	console.error("Failed to start development server:", err);
	process.exit(1);
});
