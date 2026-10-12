import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogPageLinks,
  chapterEntries,
  chapterFilename,
  chapterHeading,
  chapterKey,
  collectChapters,
  chapterParagraphs,
  decodePayloads,
  isChapterPage,
  isSavedChapter,
  joinPages,
  moreCatalogHref,
  nextHref,
  readProgress,
  savedParagraphCount,
  syncSavedChapters,
} from "./fetch_dashenbook.mjs";

test("解码 qsbs.bb 的标准 Base64 段落", () => {
  const html = `<script>document.writeln(qsbs.bb('PHA+56ysMeeroOW5v+WRium6u+m6uzwvcD4='));</script>`;
  assert.deepEqual(decodePayloads(html), ["第1章广告麻麻"]);
});

test("解码 HTML 实体并去掉标签", () => {
  const payload = Buffer.from("<p>甲&amp;乙<br>丙</p>", "utf8").toString("base64");
  assert.deepEqual(decodePayloads(`qsbs.bb('${payload}')`), ["甲&乙\n丙"]);
});

test("没有编码时读取 word_read 里的普通段落", () => {
  const html = `<div class="word_read"><h3>第10章 震荡地雷（第1页）</h3><div class="read_btn"><a href="/a">下一章</a></div><p>第10章震荡地雷</p><p>甲&amp;乙</p><p>请勿开启浏览器阅读模式，否则将导致章节内容缺失及无法阅读下一章。</p><p style="font-size:12px;">相邻推荐:<a href="/x">某书</a></p><div class="read_btn"></div></div>`;
  assert.deepEqual(chapterParagraphs(html), ["第10章震荡地雷", "甲&乙"]);
});

test("有编码时不采用页面上的普通段落", () => {
  const payload = Buffer.from("<p>正文</p>", "utf8").toString("base64");
  const html = `<div class="word_read"><script>qsbs.bb('${payload}')</script><p>请勿开启浏览器阅读模式，否则将导致章节内容缺失及无法阅读下一章。</p><div class="read_btn"></div></div>`;
  assert.deepEqual(chapterParagraphs(html), ["正文"]);
});

test("章节编号忽略分页后缀", () => {
  assert.equal(chapterKey("https://www.dashenbook.com/395_395068/105096868.html"), "105096868");
  assert.equal(chapterKey("https://www.dashenbook.com/395_395068/105096868_1.html"), "105096868");
  assert.equal(chapterKey("https://www.dashenbook.com/395_395068/105096869.html"), "105096869");
  assert.equal(chapterKey("https://www.dashenbook.com/395_395068/"), null);
});

test("标题去掉页码", () => {
  assert.equal(chapterHeading("<h3>第1章 广告麻麻（第1页）</h3>"), "第1章 广告麻麻");
});

test("翻页后丢掉重复的章题行", () => {
  const pages = [
    { paragraphs: ["第1章广告麻麻", "甲"] },
    { paragraphs: ["第1章广告麻麻", "乙"] },
  ];
  assert.deepEqual(joinPages(pages), ["第1章广告麻麻", "甲", "乙"]);
});

test("读取下一页链接", () => {
  const html = `<a href="/395_395068/">上一章</a><a href="/395_395068/105096868_1.html">下一章</a>`;
  assert.equal(nextHref(html), "/395_395068/105096868_1.html");
});

test("目录页只保留最长的一段正序章节", () => {
  const html = `
    <ul class="section-list fix">
      <li><a href="/395_395068/109.html">第9章 最新</a></li>
      <li><a href="/395_395068/108.html">第8章 最新</a></li>
      <li><a href="/395_395068/103.html">第3章 丙</a></li>
      <li><a href="/395_395068/111.html">番外 间章</a></li>
      <li><a href="/395_395068/104.html">第4章 丁</a></li>
      <li><a href="/395_395068/104.html">第4章 丁</a></li>
      <li><a href="/395_395068/101.html">第1章 甲</a></li>
      <li><a href="/395_395068/103_1.html">第3章 分页</a></li>
    </ul>`;
  assert.deepEqual(
    chapterEntries(html, "https://www.dashenbook.com/395_395068/ch1.html").map((item) => item.key),
    ["103", "111", "104"],
  );
});

test("有多段目录时采用最长的正序列表", () => {
  const html = `
    <ul class="section-list"><li><a href="/395_395068/109.html">第9章 最新</a></li></ul>
    <ul class="fix section-list">
      <li><a href="/395_395068/101.html">第1章 甲</a></li>
      <li><a href="/395_395068/102.html">第2章 乙</a></li>
    </ul>`;
  assert.deepEqual(
    chapterEntries(html, "https://www.dashenbook.com/395_395068/").map((item) => item.title),
    ["第1章 甲", "第2章 乙"],
  );
});

test("目录分页去重并保持顺序", () => {
  const html = `
    <select>
      <option value="/395_395068/">第1-100章</option>
      <option value="/395_395068/ch1.html">第101-200章</option>
    </select>
    <select>
      <option value="/395_395068/">第1-100章</option>
      <option value="/395_395068/ch1.html">第101-200章</option>
    </select>`;
  assert.deepEqual(catalogPageLinks(html, "https://www.dashenbook.com/395_395068/ch1.html"), [
    "https://www.dashenbook.com/395_395068/",
    "https://www.dashenbook.com/395_395068/ch1.html",
  ]);
});

test("从书籍页找到完整目录", () => {
  const html = `<a href="/395_395068/ch1.html">章节目录</a><a href="/395_395068/ch1.html">查看更多章节...</a>`;
  assert.equal(moreCatalogHref(html), "/395_395068/ch1.html");
});

test("多页目录按页序拼成全书并丢掉重复章", () => {
  const first = `
    <ul class="section-list"><li><a href="/b/9.html">第9章 新</a></li></ul>
    <ul class="section-list"><li><a href="/b/1.html">第1章 甲</a></li><li><a href="/b/2.html">第2章 乙</a></li></ul>`;
  const second = `
    <ul class="section-list">
      <li><a href="/b/9.html">第9章 新</a></li>
      <li><a href="/b/3.html">第3章 丙</a></li>
      <li><a href="/b/4.html">第4章 丁</a></li>
      <li><a href="/b/1.html">第1章 甲</a></li>
    </ul>`;
  const chapters = collectChapters([
    { url: "https://www.dashenbook.com/b/", html: first },
    { url: "https://www.dashenbook.com/b/ch1.html", html: second },
  ]);
  assert.deepEqual(
    chapters.map((item) => item.key),
    ["1", "2", "3", "4"],
  );
});

test("章节文件名至少三位", () => {
  assert.equal(chapterFilename(0, 9), "001.md");
  assert.equal(chapterFilename(9, 291), "010.md");
  assert.equal(chapterFilename(99, 1000), "0100.md");
});

test("已写好的章节文件可以识别", () => {
  assert.equal(isSavedChapter("# 第1章 甲\n\n正文\n"), true);
  assert.equal(isSavedChapter("# 第1章 甲\n"), false);
  assert.equal(isSavedChapter("正文\n\n第二段\n"), false);
  assert.equal(savedParagraphCount("# 第1章 甲\n\n甲\n\n乙\n"), 2);
});

test("进度记下已下载章节，缺文件时删掉记录", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dashen-progress-"));
  const book = "https://www.dashenbook.com/395_395068/";
  const chapters = [
    { key: "1", title: "第1章 甲" },
    { key: "2", title: "第2章 乙" },
  ];
  try {
    await fs.promises.writeFile(path.join(dir, "001.md"), "# 第1章 甲\n\n正文\n");
    await fs.promises.writeFile(
      path.join(dir, ".progress.json"),
      JSON.stringify({
        book,
        done: { "2": { index: 2, file: "002.md", title: "第2章 乙", paragraphs: 3 } },
      }),
    );
    const first = await syncSavedChapters(dir, book, chapters);
    assert.equal(first.saved, 1);
    assert.equal(first.progress.done["1"].file, "001.md");
    assert.equal(first.progress.done["1"].paragraphs, 1);
    assert.equal(first.progress.done["2"], undefined);

    const again = await syncSavedChapters(dir, book, chapters);
    assert.equal(again.saved, 1);
    assert.deepEqual(again.progress.done["1"], first.progress.done["1"]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("别的书的进度不会混用", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dashen-progress-"));
  try {
    await fs.promises.writeFile(
      path.join(dir, ".progress.json"),
      JSON.stringify({ book: "https://www.dashenbook.com/1_1/", done: {} }),
    );
    await assert.rejects(
      () => syncSavedChapters(dir, "https://www.dashenbook.com/395_395068/", []),
      /另一本书/,
    );
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("损坏的进度文件会报错", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dashen-progress-"));
  const file = path.join(dir, ".progress.json");
  try {
    await fs.promises.writeFile(file, "{");
    await assert.rejects(() => readProgress(file), /无法读取/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("章节页和目录页可以区分", () => {
  assert.equal(isChapterPage("https://www.dashenbook.com/395_395068/105096868.html"), true);
  assert.equal(isChapterPage("https://www.dashenbook.com/395_395068/105096868_1.html"), true);
  assert.equal(isChapterPage("https://www.dashenbook.com/395_395068/"), false);
  assert.equal(isChapterPage("https://www.dashenbook.com/395_395068/ch1.html"), false);
});

