/**
 * Build a static GitHub Pages site from docs/*.md.
 * Keeps the article source in Markdown; HTML is generated in CI.
 */

import { mkdir, readdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(root, "docs");
const outDir = path.join(root, "site");

const SITE = {
  name: "x402-lens",
  tagline: "x402 payments that explain themselves",
  repo: "https://github.com/Rozenberg888/x402-lens",
  npm: "https://www.npmjs.com/package/@x402-lens/express",
};

marked.setOptions({ gfm: true, breaks: false });

function shell(body, options) {
  const title = options.title ? `${options.title} · ${SITE.name}` : SITE.name;
  const description = options.description ?? SITE.tagline;
  const canonical = options.canonical ?? "./";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${options.assetPrefix}assets/site.css" />
</head>
<body>
  <div class="atmosphere" aria-hidden="true"></div>
  <header class="top">
    <a class="brand" href="${options.assetPrefix}">${SITE.name}</a>
    <nav>
      <a href="${SITE.repo}">GitHub</a>
      <a href="${SITE.npm}">npm</a>
    </nav>
  </header>
  <main class="${options.mainClass ?? "article"}">
${body}
  </main>
  <footer class="foot">
    <p><strong>${SITE.name}</strong> — ${SITE.tagline}</p>
    <p><a href="${SITE.repo}">Source</a> · MIT</p>
  </footer>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(fileName) {
  return fileName.replace(/\.md$/i, "");
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, "assets"), { recursive: true });
  await cp(path.join(docsDir, "assets"), path.join(outDir, "assets"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);

  const files = (await readdir(docsDir)).filter(name => name.endsWith(".md"));
  const guides = [];

  for (const file of files) {
    const raw = await readFile(path.join(docsDir, file), "utf8");
    const rewritten = raw
      .replace(/\]\(\.\.\/README\.md\)/g, `](${SITE.repo}#readme)`)
      .replace(/\]\(docs\//g, "](");
    const htmlBody = marked.parse(rewritten);
    const slug = slugify(file);
    const firstHeading = raw.match(/^#\s+(.+)$/m)?.[1] ?? slug;
    const firstPara =
      raw
        .split(/\n\n+/)
        .map(block => block.trim())
        .find(block => block && !block.startsWith("#") && !block.startsWith("|") && !block.startsWith("```"))
        ?.replace(/\*\*/g, "")
        .slice(0, 160) ?? SITE.tagline;

    guides.push({ slug, title: firstHeading, blurb: firstPara });

    const page = shell(
      `    <article>\n${htmlBody}\n    </article>\n    <p class="back"><a href="./">← All guides</a></p>`,
      {
        title: firstHeading,
        description: firstPara,
        assetPrefix: "./",
        canonical: `./${slug}.html`,
      },
    );
    await writeFile(path.join(outDir, `${slug}.html`), page, "utf8");
  }

  const homeBody = `
    <section class="hero">
      <p class="eyebrow">Guides</p>
      <h1>${SITE.name}</h1>
      <p class="lede">${SITE.tagline}. Micropayments for Express APIs — with findings you can act on.</p>
      <p class="cta">
        <a class="btn primary" href="${SITE.repo}">View on GitHub</a>
        <a class="btn" href="${SITE.npm}">Install on npm</a>
      </p>
    </section>
    <section class="guides">
      <h2>Read</h2>
      <ul>
${guides
  .map(
    guide => `        <li>
          <a href="./${guide.slug}.html">
            <span class="guide-title">${escapeHtml(guide.title)}</span>
            <span class="guide-blurb">${escapeHtml(guide.blurb)}</span>
          </a>
        </li>`,
  )
  .join("\n")}
      </ul>
    </section>`;

  await writeFile(
    path.join(outDir, "index.html"),
    shell(homeBody, {
      title: undefined,
      description: SITE.tagline,
      assetPrefix: "./",
      canonical: "./",
      mainClass: "home",
    }),
    "utf8",
  );

  console.log(`Built ${guides.length + 1} pages → ${path.relative(root, outDir)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
