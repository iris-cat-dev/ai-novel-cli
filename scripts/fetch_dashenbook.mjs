#!/usr/bin/env node
// 从大神小说网取出章节正文。章节 URL 只取一章；书籍或目录 URL 按正序取全部章节。
//
// 章节正文多在 qsbs.bb('...') 的标准 Base64 中，解码后是 <p>。
// 少数章节没有这段编码，正文直接放在 .word_read 的普通段落里。
// 同一章会拆成多页（105096868.html、105096868_1.html），下一页的链接文字仍是「下一章」。
// 目录页会夹带最新章节和重复的开头几章，只保留每一页最长的一段正序。
// 首次访问会先返回 guard cookie 和 /_guard/auto.js；脚本执行这段校验后再请求正文。
// --dir 会把已完成的章节记在 .progress.json，再次运行时跳过这些文件。

import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_PAGES = 40;
const MAX_CATALOG_PAGES = 50;
const CHAPTER_GAP_MS = 300;

const USAGE = `用法: node scripts/fetch_dashenbook.mjs <URL> [-o 文件 | --dir 目录] [--all]

示例:
  node scripts/fetch_dashenbook.mjs https://www.dashenbook.com/395_395068/105096868.html
  node scripts/fetch_dashenbook.mjs https://www.dashenbook.com/395_395068/105096868.html -o chapter.txt
  node scripts/fetch_dashenbook.mjs https://www.dashenbook.com/395_395068/ --dir chapters
  node scripts/fetch_dashenbook.mjs https://www.dashenbook.com/395_395068/105096868.html --all -o book.md

章节 URL 只取这一章，并自动合并它自己的分页。
书籍或目录 URL（以 / 或 chN.html 结尾）按目录正序取全部章节。
--all 从章节 URL 改取它所在的整本书。
-o 写入一个文件，每次都重写。
--dir 每章一个 001.md、002.md。已经下好的章节会跳过，进度记在该目录的 .progress.json。
删掉某一章的文件后再运行，会重新下载那一章。
`;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? all;
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });
}

export function decodePayloads(html) {
  const paragraphs = [];
  const re = /qsbs\.bb\(\s*['"]([A-Za-z0-9+/=\s]+)['"]\s*\)/g;
  for (const match of html.matchAll(re)) {
    const fragment = Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("utf8");
    const text = decodeEntities(fragment.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
      .replace(/\u00a0/g, " ")
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

// 站点有时不编码，把正文直接放进 .word_read。页尾的阅读提示和相邻推荐不是正文。
export function plainParagraphs(html) {
  const start = html.search(/<div\b[^>]*class=["'][^"']*\bword_read\b[^"']*["']/i);
  if (start < 0) return [];
  const firstBtn = html.indexOf("read_btn", start);
  const secondBtn = firstBtn >= 0 ? html.indexOf("read_btn", firstBtn + "read_btn".length) : -1;
  const block = html.slice(start, secondBtn > start ? secondBtn : html.length);
  const paragraphs = [];
  for (const match of block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    if (/font-size\s*:\s*12px/i.test(match[1]) || /<a\b/i.test(match[2])) continue;
    const text = decodeEntities(match[2].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
      .replace(/\u00a0/g, " ")
      .trim();
    if (!text || text.includes("请勿开启浏览器阅读模式") || text.startsWith("相邻推荐")) continue;
    paragraphs.push(text);
  }
  return paragraphs;
}

export function chapterParagraphs(html) {
  const encoded = decodePayloads(html);
  return encoded.length ? encoded : plainParagraphs(html);
}

export function chapterKey(url) {
  const pathname = new URL(url, "https://www.dashenbook.com").pathname;
  const match = pathname.match(/\/(\d+)(?:_\d+)?\.html$/);
  return match ? match[1] : null;
}

export function isChapterPage(url) {
  const pathname = new URL(url, "https://www.dashenbook.com").pathname;
  return /\/\d+(?:_\d+)?\.html$/.test(pathname);
}

function chapterPageUrl(url) {
  const key = chapterKey(url);
  if (!key) return null;
  const parsed = new URL(url, "https://www.dashenbook.com");
  return parsed.pathname.endsWith(`/${key}.html`) ? parsed.href : null;
}

export function bookUrl(url) {
  const parsed = new URL(url, "https://www.dashenbook.com");
  parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, "/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function chapterHeading(html) {
  const raw = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "";
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/（第\d+页）/g, "")
    .trim();
}

export function nextHref(html) {
  let href = null;
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>\s*下一[章页]\s*<\/a>/gi;
  for (const match of html.matchAll(re)) href = match[1];
  if (!href || href.startsWith("javascript:")) return null;
  return href;
}

export function joinPages(pages) {
  const title = pages[0]?.paragraphs[0];
  const paragraphs = [];
  pages.forEach((page, index) => {
    const source = page.paragraphs;
    const body = index > 0 && source[0] === title ? source.slice(1) : source;
    paragraphs.push(...body);
  });
  return paragraphs;
}

function anchorText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).trim();
}

// 目录页的 section-list 前面会塞最新章节，后面还会重复开头几章。
// 真正这一页的章节是其中最长的一段非递减序号。
function longestAscending(items) {
  let best = [];
  let current = [];
  let last = -Infinity;
  const finish = () => {
    if (current.length > best.length) best = current;
  };
  for (const item of items) {
    if (current.some((existing) => existing.key === item.key)) continue;
    if (item.number == null || item.number >= last) {
      current.push(item);
      if (item.number != null) last = item.number;
    } else {
      finish();
      current = [item];
      last = item.number;
    }
  }
  finish();
  return best;
}

export function chapterEntries(html, pageUrl) {
  const lists = html.matchAll(/<ul\b[^>]*class=["'][^"']*section-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi);
  let best = [];
  for (const list of lists) {
    const items = [];
    for (const match of list[1].matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = chapterPageUrl(new URL(match[1], pageUrl).href);
      const key = url ? chapterKey(url) : null;
      if (!url || !key) continue;
      const title = anchorText(match[2]);
      const number = title.match(/第(\d+)章/)?.[1];
      items.push({ url, key, title, number: number == null ? null : Number(number) });
    }
    const run = longestAscending(items);
    if (run.length > best.length) best = run;
  }
  return best.map(({ url, key, title }) => ({ url, key, title }));
}

export function catalogPageLinks(html, pageUrl) {
  const links = [];
  const seen = new Set();
  for (const select of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    let found = false;
    for (const option of select[1].matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([^<]*)<\/option>/gi)) {
      if (!/第\s*\d+\s*-\s*\d+\s*章/.test(option[2])) continue;
      const url = new URL(option[1], pageUrl).href;
      found = true;
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(url);
    }
    if (found) return links;
  }
  return links;
}

export function moreCatalogHref(html) {
  const match = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*(?:章节目录|查看更多章节)/i);
  if (!match || match[1].startsWith("javascript:")) return null;
  return match[1];
}

export function collectChapters(pages) {
  const chapters = [];
  const seen = new Set();
  for (const page of pages) {
    for (const item of chapterEntries(page.html, page.url)) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      chapters.push(item);
    }
  }
  return chapters;
}

function isGuardPage(html) {
  return html.includes("/_guard/auto.js") && !html.includes("qsbs.bb");
}

function storeCookies(jar, setCookies) {
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const maxAge = attrs.join(";").match(/max-age=(\d+)/i);
    if (value === "" || (maxAge && Number(maxAge[1]) === 0)) jar.delete(name);
    else jar.set(name, value);
  }
}

class Client {
  constructor() {
    this.jar = new Map();
  }

  async get(url) {
    const headers = {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    if (this.jar.size) {
      headers.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(30000),
        });
        storeCookies(this.jar, response.headers.getSetCookie?.() ?? []);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
        return await response.text();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

// auto.js 是混淆过的访问校验。它读取 guard cookie，算出 guardret，页面刷新后服务端才返回正文。
export function solveGuard(jsCode, jar, pageUrl) {
  const document = {};
  Object.defineProperty(document, "cookie", {
    get() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set(value) {
      storeCookies(jar, [String(value)]);
    },
  });
  const window = {
    document,
    location: { href: pageUrl, reload() {}, replace() {}, assign() {} },
    navigator: { userAgent: USER_AGENT, webdriver: false },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
    addEventListener() {},
  };
  window.window = window;
  window.self = window;
  window.top = window;
  window.parent = window;
  const context = vm.createContext(window);
  context.btoa = (value) => Buffer.from(String(value), "binary").toString("base64");
  context.atob = (value) => Buffer.from(String(value), "base64").toString("binary");
  vm.runInContext(jsCode, context, { timeout: 5000 });
  if (!jar.has("guardret")) throw new Error("访问校验没有生成 guardret");
}

async function fetchDocument(client, url) {
  let html = await client.get(url);
  if (!isGuardPage(html)) return html;
  if (!client.jar.has("guard")) throw new Error("挑战页没有返回 guard cookie");
  const src = html.match(/<script[^>]+src=["']([^"']*auto\.js)["']/i)?.[1] ?? "/_guard/auto.js";
  const jsCode = await client.get(new URL(src, url).href);
  solveGuard(jsCode, client.jar, url);
  html = await client.get(url);
  if (isGuardPage(html)) throw new Error("没能通过站点的访问校验");
  return html;
}

export async function fetchChapter(url, client = new Client()) {
  const start = new URL(url).href;
  const key = chapterKey(start);
  if (!key) throw new Error("这不是章节页，URL 需要类似 /395_395068/105096868.html");

  const pages = [];
  const seen = new Set();
  let current = start;
  while (current && !seen.has(current) && pages.length < MAX_PAGES) {
    seen.add(current);
    const html = await fetchDocument(client, current);
    const paragraphs = chapterParagraphs(html);
    if (!paragraphs.length) throw new Error(`没有从页面解析到正文：${current}`);
    pages.push({ url: current, heading: chapterHeading(html), paragraphs });
    const href = nextHref(html);
    if (!href) break;
    const next = new URL(href, current).href;
    if (chapterKey(next) !== key) break;
    current = next;
  }
  return {
    heading: pages[0].heading || "正文",
    pages,
    paragraphs: joinPages(pages),
  };
}

export function renderChapter(chapter) {
  return `# ${chapter.heading}\n\n${chapter.paragraphs.join("\n\n")}\n`;
}

export async function listChapters(url, client = new Client()) {
  const start = new URL(url).href;
  const first = await fetchDocument(client, start);
  const cache = new Map([[start, first]]);
  let pages = catalogPageLinks(first, start);
  if (!pages.length) {
    const more = moreCatalogHref(first);
    if (more) {
      const moreUrl = new URL(more, start).href;
      const moreHtml = await fetchDocument(client, moreUrl);
      cache.set(moreUrl, moreHtml);
      pages = catalogPageLinks(moreHtml, moreUrl);
    }
  }
  if (!pages.length) pages = [start];
  if (pages.length > MAX_CATALOG_PAGES) {
    throw new Error(`目录页超过 ${MAX_CATALOG_PAGES} 页，已停止`);
  }

  const loaded = [];
  for (const pageUrl of pages) {
    let html = cache.get(pageUrl);
    if (!html) {
      html = await fetchDocument(client, pageUrl);
      cache.set(pageUrl, html);
    }
    loaded.push({ url: pageUrl, html });
  }
  const chapters = collectChapters(loaded);
  if (!chapters.length) throw new Error("目录里没有章节");
  return chapters;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chapterFilename(index, total) {
  const width = Math.max(3, String(total).length);
  return `${String(index + 1).padStart(width, "0")}.md`;
}

export function savedParagraphCount(text) {
  const parts = String(text).trim().split(/\n{2,}/).filter((part) => part.trim());
  if (parts.length < 2 || !parts[0].startsWith("# ")) return 0;
  return parts.length - 1;
}

export function isSavedChapter(text) {
  return savedParagraphCount(text) > 0;
}

export function emptyProgress(book = "") {
  return { book, done: {} };
}

export function normalizeProgress(data) {
  const done = {};
  const source = data?.done && typeof data.done === "object" ? data.done : {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue;
    done[key] = {
      index: Number(value.index) || 0,
      file: typeof value.file === "string" ? value.file : "",
      title: typeof value.title === "string" ? value.title : "",
      paragraphs: Number.isFinite(Number(value.paragraphs)) ? Number(value.paragraphs) : 0,
    };
  }
  return { book: typeof data?.book === "string" ? data.book : "", done };
}

export async function readProgress(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyProgress();
    throw error;
  }
  try {
    return normalizeProgress(JSON.parse(raw));
  } catch {
    throw new Error(`进度文件无法读取：${file}`);
  }
}

export async function writeProgress(file, progress) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(progress, null, 2)}\n`);
  await fs.promises.rename(tmp, file);
}

function progressFile(dir) {
  return path.join(dir, ".progress.json");
}

function chapterRecord(index, file, title, paragraphs) {
  return { index: index + 1, file, title, paragraphs };
}

function sameRecord(left, right) {
  return (
    left &&
    right &&
    left.index === right.index &&
    left.file === right.file &&
    left.title === right.title &&
    left.paragraphs === right.paragraphs
  );
}

async function readOptional(file) {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

// 以目录里已经写好的章节文件为准，补齐或清掉 .progress.json 里的记录。
export async function syncSavedChapters(dir, book, chapters) {
  const file = progressFile(dir);
  const progress = await readProgress(file);
  if (progress.book && progress.book !== book) {
    throw new Error(`目录 ${dir} 的进度属于另一本书：${progress.book}`);
  }
  const bookChanged = progress.book !== book;
  progress.book = book;
  let dirty = false;
  let saved = 0;
  for (let index = 0; index < chapters.length; index++) {
    const item = chapters[index];
    const name = chapterFilename(index, chapters.length);
    const text = await readOptional(path.join(dir, name));
    if (!isSavedChapter(text)) {
      if (progress.done[item.key]?.file === name) {
        delete progress.done[item.key];
        dirty = true;
      }
      continue;
    }
    saved++;
    const record = chapterRecord(index, name, item.title, savedParagraphCount(text));
    if (sameRecord(progress.done[item.key], record)) continue;
    progress.done[item.key] = record;
    dirty = true;
  }
  if (dirty || (bookChanged && saved > 0)) await writeProgress(file, progress);
  return { progress, saved, file };
}

function parseArgs(argv) {
  const args = { url: "", out: "", dir: "", all: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "-o" || arg === "--out") {
      args.out = argv[++i] ?? "";
      if (!args.out) throw new Error("-o 需要文件路径");
    } else if (arg === "--dir") {
      args.dir = argv[++i] ?? "";
      if (!args.dir) throw new Error("--dir 需要目录路径");
    } else if (arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    else if (!args.url) args.url = arg;
    else throw new Error("只能指定一个 URL");
  }
  if (args.out && args.dir) throw new Error("-o 和 --dir 只能用一个");
  return args;
}

async function writeText(args, text, index, total) {
  if (args.dir) {
    const file = path.join(args.dir, chapterFilename(index, total));
    await fs.promises.writeFile(file, text);
    return file;
  }
  if (args.out) {
    await fs.promises.appendFile(args.out, text);
    return args.out;
  }
  process.stdout.write(text);
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    process.stdout.write(USAGE);
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const pageUrl = new URL(args.url).href;
  const wholeBook = args.all || !isChapterPage(pageUrl);
  if (!wholeBook) {
    const chapter = await fetchChapter(pageUrl);
    for (const page of chapter.pages) {
      console.error(`${page.url}：${page.paragraphs.length} 段`);
    }
    const text = renderChapter(chapter);
    if (args.dir) await fs.promises.mkdir(args.dir, { recursive: true });
    if (args.out) {
      await fs.promises.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
      await fs.promises.writeFile(args.out, "");
    }
    const written = await writeText(args, text, 0, 1);
    if (written) console.error(`已写入 ${written}（${chapter.paragraphs.length} 段）`);
    return;
  }

  const client = new Client();
  const book = bookUrl(pageUrl);
  const chapters = await listChapters(args.all ? book : pageUrl, client);
  if (args.dir) await fs.promises.mkdir(args.dir, { recursive: true });
  if (args.out) {
    await fs.promises.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await fs.promises.writeFile(args.out, "");
  }

  let progress = emptyProgress(book);
  let progressPath = "";
  let saved = 0;
  if (args.dir) {
    const synced = await syncSavedChapters(args.dir, book, chapters);
    progress = synced.progress;
    progressPath = synced.file;
    saved = synced.saved;
  }
  console.error(
    args.dir ? `目录共 ${chapters.length} 章，已下载 ${saved} 章` : `目录共 ${chapters.length} 章`,
  );

  let fetched = 0;
  let skipped = 0;
  let waitBeforeFetch = false;
  for (let index = 0; index < chapters.length; index++) {
    const item = chapters[index];
    const name = chapterFilename(index, chapters.length);
    if (args.dir && progress.done[item.key]?.file === name) {
      const text = await readOptional(path.join(args.dir, name));
      if (isSavedChapter(text)) {
        console.error(`[${index + 1}/${chapters.length}] 跳过 ${item.title}（${name} 已下载）`);
        skipped++;
        continue;
      }
    }
    if (waitBeforeFetch) await delay(CHAPTER_GAP_MS);
    console.error(`[${index + 1}/${chapters.length}] ${item.title}`);
    const chapter = await fetchChapter(item.url, client);
    const written = await writeText(args, `${renderChapter(chapter)}\n`, index, chapters.length);
    if (args.dir) {
      progress.done[item.key] = chapterRecord(
        index,
        name,
        chapter.heading || item.title,
        chapter.paragraphs.length,
      );
      await writeProgress(progressPath, progress);
    }
    if (written && args.dir) console.error(`已写入 ${written}（${chapter.paragraphs.length} 段）`);
    fetched++;
    waitBeforeFetch = true;
  }
  if (args.out) console.error(`已写入 ${args.out}（${chapters.length} 章）`);
  else if (args.dir) console.error(`完成：新下载 ${fetched} 章，跳过 ${skipped} 章`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

