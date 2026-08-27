// gen-deck.js —— 生成 WebOJ 演示 PPT（12 页，16:9）
// 用法：node scripts/gen-deck.js [输出路径]（默认 WebOJ演示.pptx）
// 依赖：pptxgenjs（npm install --no-save pptxgenjs，不写入 package.json）
// 注意：pptxgenjs 4.x 需先 pptx.addSlide() 拿到 slide，再在 slide 上调 addShape/addText/addNote。
const PptxGenJS = require('pptxgenjs');

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"
pptx.author = '刘天乐';
pptx.title = 'WebOJ 演示';

const FONT = 'Microsoft YaHei';
const MONO = 'Consolas';

const C = {
  dark: '12141C',     // 封面/结尾暗底
  ink: '1A1D24',      // 正文深色
  sub: '6B7280',      // 次要灰
  indigo: '5E6AD2',   // 主 accent（靛蓝）
  indigoBg: 'EEF0FB',
  ice: 'CADCFC',
  green: '2FB26B', greenBg: 'E9FBF0',
  red: 'E05C5C', redBg: 'FDECEC',
  yellow: 'D98A1F', yellowBg: 'FCF3E3',
  blue: '3B82F6', blueBg: 'EAF2FE',
  white: 'FFFFFF',
  cardBg: 'F4F5F9',
  line: 'E3E6EE',
};

// 排行榜格子母题：五个小圆角方块（首杀蓝 / AC 绿 / 封榜前红 / 封榜后黄 / 未提交白）
function cellMotif(slide, x, y, size) {
  const cells = [
    { fill: C.blueBg, border: C.blue },
    { fill: C.greenBg, border: C.green },
    { fill: C.redBg, border: C.red },
    { fill: C.yellowBg, border: C.yellow },
    { fill: C.white, border: 'C9CED9' },
  ];
  cells.forEach((c, i) => {
    slide.addShape('roundRect', {
      x: x + i * (size + 0.1), y, w: size, h: size, rectRadius: 0.05,
      fill: { color: c.fill }, line: { color: c.border, width: 1.5 },
    });
  });
}

// 页眉：标题 + 右上角格子母题
function header(slide, title, subtitle) {
  slide.addText(title, { x: 0.6, y: 0.42, w: 9.5, h: 0.7, fontSize: 30, bold: true, color: C.ink, fontFace: FONT, margin: 0 });
  if (subtitle) {
    slide.addText(subtitle, { x: 0.6, y: 1.06, w: 9.5, h: 0.4, fontSize: 13, color: C.sub, fontFace: FONT, margin: 0 });
  }
  cellMotif(slide, 11.6, 0.52, 0.26);
}

// 卡片（圆角矩形浅底 + 标题 + 正文）
function card(slide, x, y, w, h, title, body, opts) {
  const o = opts || {};
  slide.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: o.fill || C.cardBg }, line: { color: C.line, width: 1 },
  });
  slide.addText(title, { x: x + 0.25, y: y + 0.18, w: w - 0.5, h: 0.4, fontSize: 15, bold: true, color: o.titleColor || C.indigo, fontFace: FONT, margin: 0 });
  slide.addText(body, {
    x: x + 0.25, y: y + 0.62, w: w - 0.5, h: h - 0.8, fontSize: 12.5, color: C.ink,
    fontFace: FONT, margin: 0, lineSpacingMultiple: 1.15, valign: 'top',
  });
}

// ============ 第 1 页 封面（暗底） ============
{
  const slide = pptx.addSlide();
  slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: C.dark } });
  slide.addText('课题编号 1 · 九天课程课题 · 独立完成', {
    x: 0.9, y: 1.55, w: 6, h: 0.4, fontSize: 14, color: '8A8F98', fontFace: FONT, margin: 0,
  });
  slide.addText('WebOJ', {
    x: 0.85, y: 1.95, w: 8, h: 1.5, fontSize: 88, bold: true, color: C.white, fontFace: FONT, margin: 0,
  });
  slide.addText('Web 端在线评测系统（Online Judge）', {
    x: 0.9, y: 3.42, w: 9, h: 0.55, fontSize: 26, color: C.ice, fontFace: FONT, margin: 0,
  });
  slide.addText('纯前端 C++ WASM 判题 · 两进程函数式通信题 · ACM 比赛与封榜滚榜', {
    x: 0.9, y: 4.05, w: 11.5, h: 0.45, fontSize: 16, color: '9AA0AB', fontFace: FONT, margin: 0,
  });
  cellMotif(slide, 0.92, 4.95, 0.34);
  slide.addText('刘天乐', { x: 0.9, y: 6.55, w: 4, h: 0.4, fontSize: 15, color: 'B9BEC9', fontFace: FONT, margin: 0 });
  slide.addNotes('开场：WebOJ 是九天完成的课程课题，一个可一键启动、可本地演示的 Web 端在线评测系统。');
}

// ============ 第 2 页 课题概览 ============
{
  const slide = pptx.addSlide();
  header(slide, '课题概览');
  slide.addText('算法课 / 程序设计课上，学生（会员）在浏览器内提交 C++ 代码即时评测，教师（管理员）发布题目、组织比赛并查看评测情况。', {
    x: 0.6, y: 1.62, w: 6.3, h: 1.1, fontSize: 15, color: C.ink, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.3, valign: 'top',
  });
  slide.addText('核心目标：\n- 15 项必做 + 比赛模块全部完成\n- 验收 15 条与比赛 C1~C5 全部通过\n- 136 项接口断言、17 项压测、真实数据回归', {
    x: 0.6, y: 3.1, w: 6.3, h: 3.4, fontSize: 14, color: C.sub, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.4, valign: 'top',
  });
  card(slide, 7.3, 1.62, 5.4, 1.7, '纯前端 C++ WASM 判题', '浏览器 Web Worker 内 emception 工具链编译运行，不依赖后端评测机；六种判定、逐组比对、完整编译错误展示。', { fill: C.indigoBg, titleColor: C.indigo });
  card(slide, 7.3, 3.5, 5.4, 1.7, '两进程函数式通信题', '提交的程序实现两个函数，两次独立运行、全局状态互不可见；协议类型菜单按签名生成 ABI，long long 全精度。', { fill: C.blueBg, titleColor: C.blue });
  card(slide, 7.3, 5.38, 5.4, 1.7, 'ACM 比赛与封榜滚榜', '实时榜按 AC 数 / 罚时排序；封榜时间后台可配，赛后全屏滚榜、点击逐格揭晓、排名实时跳动。', { fill: C.greenBg, titleColor: C.green });
  slide.addNotes('三张特色卡片对应项目的三个核心卖点。');
}

// ============ 第 3 页 技术选型 ============
{
  const slide = pptx.addSlide();
  header(slide, '技术选型');
  card(slide, 0.6, 1.62, 6.0, 2.55, '后端 · Node.js + Express + SQLite',
    '内置 node:sqlite 零原生编译依赖；同步串行写规避并发一致性问题；\nJWT 会话鉴权 + 服务端 RBAC 中间件；\nWebSocket 实时推送评测状态。', { fill: C.indigoBg, titleColor: C.indigo });
  card(slide, 6.8, 1.62, 6.0, 2.55, '判题 · 纯前端 emception（WASM）',
    '浏览器内 clang 编译 C++17 → WASM；\nWorker 内执行编译产物、逐组注入 stdin 比对；\nTLE / MLE 近似口径并在文档说明。', { fill: C.blueBg, titleColor: C.blue });
  card(slide, 0.6, 4.35, 6.0, 2.55, '前端 · 原生 HTML / JS 九页',
    '零框架依赖；\n自带代码编辑器（Tab / 括号配对 / 高亮）；\n零依赖 Markdown 渲染（题解）。', { fill: C.greenBg, titleColor: C.green });
  card(slide, 6.8, 4.35, 6.0, 2.55, '工程 · 自测与约束套件',
    'npm test 接口断言 / npm run stress 压测；\nnpm run harness 敏感信息扫描；\nverify-p6838 脚本互验、realdata 真实数据回归。', { fill: C.yellowBg, titleColor: C.yellow });
  slide.addNotes('选型理由：前后端同语言、npm install 即装即用、纯前端判题不依赖评测机部署。');
}

// ============ 第 4 页 主路径 ============
{
  const slide = pptx.addSlide();
  header(slide, '主路径：提交 → 评测 → 判定');
  const steps = [
    ['提交代码', '生成任务 pending'],
    ['自助认领', '仅限本人提交'],
    ['em++ 编译', 'C++17 → WASM'],
    ['逐组运行', '≥3 组比对'],
    ['判定落库', 'AC/WA/TLE…'],
    ['WS 推送', '实时渲染明细'],
  ];
  const colW = 2.05;
  steps.forEach((s, i) => {
    const x = 0.65 + i * colW;
    slide.addShape('ellipse', {
      x: x + 0.52, y: 1.75, w: 1.0, h: 1.0,
      fill: { color: i % 2 === 0 ? C.indigo : C.indigoBg },
      line: { color: C.indigo, width: 1.5 },
    });
    slide.addText(String(i + 1), {
      x: x + 0.52, y: 1.75, w: 1.0, h: 1.0, fontSize: 26, bold: true,
      color: i % 2 === 0 ? C.white : C.indigo, align: 'center', valign: 'middle', fontFace: FONT, margin: 0,
    });
    slide.addText(s[0], { x, y: 2.95, w: colW, h: 0.4, fontSize: 14, bold: true, color: C.ink, align: 'center', fontFace: FONT, margin: 0 });
    slide.addText(s[1], { x, y: 3.35, w: colW, h: 0.35, fontSize: 11, color: C.sub, align: 'center', fontFace: FONT, margin: 0 });
    if (i < steps.length - 1) {
      slide.addText('→', { x: x + 1.62, y: 1.95, w: 0.4, h: 0.6, fontSize: 22, bold: true, color: C.indigo, align: 'center', valign: 'middle', fontFace: FONT, margin: 0 });
    }
  });
  slide.addShape('roundRect', {
    x: 0.65, y: 4.2, w: 12.05, h: 1.05, rectRadius: 0.1,
    fill: { color: C.ice, transparency: 82 }, line: { color: C.ice, width: 1 },
  });
  slide.addText([
    { text: '通信题', options: { bold: true, color: C.indigo } },
    { text: '  在同一主路径上把评测阶段替换为「两次独立实例化」：第一次调用函数一得中间值 X 后退出，第二次以 X 为参数调用函数二，输出与标准输出比对；可选 mutate 中间值变换（噪声信道 / 删边信道）。' },
  ], { x: 0.9, y: 4.38, w: 11.6, h: 0.75, fontSize: 13, color: C.ink, fontFace: FONT, margin: 0, valign: 'middle', lineSpacingMultiple: 1.2 });
  slide.addText('外部评测机（C / Python / Java）走 x-judge-key 通道的任务拉取与结果回传，与自助通道并存。', {
    x: 0.65, y: 5.55, w: 12, h: 0.5, fontSize: 12.5, color: C.sub, fontFace: FONT, margin: 0,
  });
  slide.addNotes('六步主路径 + 通信题分支说明。');
}

// ============ 第 5 页 演示·浏览器内实时评测 ============
{
  const slide = pptx.addSlide();
  header(slide, '演示：浏览器内实时评测');
  slide.addText([
    { text: '1  ', options: { bold: true, color: C.indigo } }, { text: 'npm run seed + npm start，登录演示账号', options: { breakLine: true } },
    { text: '2  ', options: { bold: true, color: C.indigo } }, { text: '打开 A+B Problem，提交用 long long 计算 a+b 的代码', options: { breakLine: true } },
    { text: '3  ', options: { bold: true, color: C.indigo } }, { text: '提交详情页自动开始浏览器内评测（首次下载工具链约几十 MB，此后走缓存）', options: { breakLine: true } },
    { text: '4  ', options: { bold: true, color: C.indigo } }, { text: '数秒后显示逐组比对与最终判定，无需刷新页面（WS 推送）' },
  ], { x: 0.6, y: 1.75, w: 6.4, h: 3.6, fontSize: 14, color: C.ink, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.5, valign: 'top' });
  slide.addShape('roundRect', { x: 7.4, y: 1.75, w: 2.5, h: 1.15, rectRadius: 0.14, fill: { color: C.green }, line: { color: C.green, width: 0 } });
  slide.addText('AC', { x: 7.4, y: 1.75, w: 2.5, h: 1.15, fontSize: 44, bold: true, color: C.white, align: 'center', valign: 'middle', fontFace: FONT, margin: 0 });
  slide.addText('4 组测试数据逐组比对', { x: 10.15, y: 1.85, w: 2.6, h: 0.9, fontSize: 16, bold: true, color: C.ink, fontFace: FONT, margin: 0, valign: 'middle' });
  slide.addShape('roundRect', { x: 7.4, y: 3.25, w: 5.35, h: 1.5, rectRadius: 0.1, fill: { color: C.cardBg }, line: { color: C.line, width: 1 } });
  slide.addText([
    { text: '溢出边界组', options: { bold: true, color: C.ink } },
    { text: ' 2000000000 + 2000000000\n= 4000000000（int 溢出，long long 正确）', options: {} },
  ], { x: 7.65, y: 3.42, w: 4.9, h: 1.2, fontSize: 13, color: C.ink, fontFace: MONO, margin: 0, lineSpacingMultiple: 1.3, valign: 'middle' });
  slide.addText('失败路径同样可演示：WA（首错即停）、TLE（volatile 死循环）、CE（完整编译错误）。', {
    x: 0.6, y: 5.7, w: 12, h: 0.6, fontSize: 13, color: C.sub, fontFace: FONT, margin: 0,
  });
  slide.addNotes('演示入口：seed → start → 登录 → A+B 提交 → 实时日志。可配提交详情截图。');
}

// ============ 第 6 页 判定与失败路径 ============
{
  const slide = pptx.addSlide();
  header(slide, '六种判定与失败路径');
  const verdicts = [
    ['AC', '通过', C.green, C.greenBg, '逐组输出与期望一致'],
    ['WA', '答案错误', C.red, C.redBg, '首错即停，展示期望 / 实际'],
    ['TLE', '超时', C.yellow, C.yellowBg, '题限 + 裕量，watchdog 强杀'],
    ['MLE', '超内存', C.yellow, C.yellowBg, 'WASM 内存上限，OOM 特征识别'],
    ['RE', '运行时错误', C.blue, C.blueBg, '崩溃 / 中间值越界等'],
    ['CE', '编译错误', C.sub, 'EEF0F2', '完整错误：文件名 / 行号 / 描述'],
  ];
  verdicts.forEach((v, i) => {
    const x = 0.6 + i * 2.07;
    slide.addShape('roundRect', { x, y: 1.7, w: 1.85, h: 2.6, rectRadius: 0.1, fill: { color: v[3] }, line: { color: v[2], width: 1.5 } });
    slide.addText(v[0], { x, y: 1.95, w: 1.85, h: 0.75, fontSize: 28, bold: true, color: v[2], align: 'center', fontFace: MONO, margin: 0 });
    slide.addText(v[1], { x, y: 2.72, w: 1.85, h: 0.35, fontSize: 13, bold: true, color: C.ink, align: 'center', fontFace: FONT, margin: 0 });
    slide.addText(v[4], { x: x + 0.12, y: 3.18, w: 1.61, h: 1.0, fontSize: 10.5, color: C.sub, align: 'center', fontFace: FONT, margin: 0, lineSpacingMultiple: 1.2 });
  });
  slide.addText('TLE / MLE 为近似判定（墙钟 + 裕量 / WASM 内存上限），口径在接口文档中说明——属立项书设计约束，不是缺陷。', {
    x: 0.6, y: 4.75, w: 12, h: 0.5, fontSize: 13, color: C.sub, fontFace: FONT, margin: 0,
  });
  card(slide, 0.6, 5.5, 12.05, 1.35, '失败路径演示（验收要求的异常路径）',
    'WA：提交 a-b 的代码，首错即停、展示期望与实际输出；TLE：提交 volatile 死循环，超题限 + 裕量后强杀判 TLE；CE：少写一个分号，展示完整编译错误。', { fill: C.redBg, titleColor: C.red });
  slide.addNotes('六种判定全部在浏览器评测机与后端评测机实现。');
}

// ============ 第 7 页 通信题（核心特色） ============
{
  const slide = pptx.addSlide();
  header(slide, '核心特色：两进程函数式通信题');
  const cy = 2.0;
  slide.addShape('ellipse', { x: 1.1, y: cy, w: 2.5, h: 1.7, fill: { color: C.indigoBg }, line: { color: C.indigo, width: 2 } });
  slide.addText('实例 A\nfn1(...)\n得中间值 X 后退出', { x: 1.1, y: cy, w: 2.5, h: 1.7, fontSize: 12.5, bold: true, color: C.indigo, align: 'center', valign: 'middle', fontFace: FONT, margin: 0, lineSpacingMultiple: 1.25 });
  slide.addText('X →', { x: 3.7, y: cy + 0.45, w: 0.9, h: 0.5, fontSize: 20, bold: true, color: C.ink, align: 'center', valign: 'middle', fontFace: MONO, margin: 0 });
  slide.addShape('ellipse', { x: 4.65, y: cy, w: 2.5, h: 1.7, fill: { color: C.greenBg }, line: { color: C.green, width: 2 } });
  slide.addText('实例 B\nfn2(..., X, ...)\n输出与期望比对', { x: 4.65, y: cy, w: 2.5, h: 1.7, fontSize: 12.5, bold: true, color: C.green, align: 'center', valign: 'middle', fontFace: FONT, margin: 0, lineSpacingMultiple: 1.25 });
  slide.addText('两次独立实例化：全局状态互不可见，严格两进程语义。', { x: 0.95, y: 4.05, w: 6.3, h: 0.6, fontSize: 12.5, color: C.sub, fontFace: FONT, margin: 0, align: 'center' });
  card(slide, 0.95, 4.85, 6.3, 2.0, '评测能力',
    '中间值 X 校验：int / long long 落在 [0, xMax]，string 长度受限，越界判 RE；\n可选 mutate 中间值变换：噪声信道（noise-num）、删边信道（delete-edges），固定 seed 评测可复现。', { fill: C.indigoBg, titleColor: C.indigo });
  slide.addText('五道改编样例（题面按「两进程协议」改写）', { x: 7.6, y: 1.7, w: 5.2, h: 0.4, fontSize: 14, bold: true, color: C.ink, fontFace: FONT, margin: 0 });
  const probs = [
    ['P12509', '两进程标量（Alice/Bob，XOR 方案）'],
    ['P6838', 'stations：数组参数 + 内置 grader'],
    ['B3790', '文本压缩：compress / decompress'],
    ['P9165', '噪声信道：encode / decode 抗噪编码'],
    ['P10539', '删边信道：alice / bob 魔术表演'],
  ];
  probs.forEach((p, i) => {
    const y = 2.25 + i * 0.92;
    slide.addShape('roundRect', { x: 7.6, y, w: 5.15, h: 0.78, rectRadius: 0.09, fill: { color: C.cardBg }, line: { color: C.line, width: 1 } });
    slide.addText(p[0], { x: 7.78, y, w: 1.35, h: 0.78, fontSize: 14, bold: true, color: C.indigo, fontFace: MONO, valign: 'middle', margin: 0 });
    slide.addText(p[1], { x: 9.2, y, w: 3.45, h: 0.78, fontSize: 12, color: C.ink, fontFace: FONT, valign: 'middle', margin: 0 });
  });
  slide.addNotes('通信题是项目核心：原题交互 / 回调形态统一改编为「两个函数 + 中间值」。');
}

// ============ 第 8 页 协议类型菜单与 mutate ============
{
  const slide = pptx.addSlide();
  header(slide, '协议类型菜单 + 中间值变换');
  card(slide, 0.6, 1.7, 6.0, 2.6, '类型菜单（按签名自动生成 ABI）',
    '参数：string / int / long long / vector<int>（个数不限）\n返回：string / int / long long\nlong long 走十进制字符串，64 位全精度\nfn1 / fn2 可为函数名（旧式默认签名）或签名对象 {name, params, ret}（新式，fn2 带 xParam）', { fill: C.indigoBg, titleColor: C.indigo });
  card(slide, 6.8, 1.7, 6.0, 2.6, '中间值变换 mutate（可选）',
    'noise-num 噪声信道：数字串每数字按 ratio 概率替换，固定 seed；\ndelete-edges 删边信道：边集按 seed 删恰好 delete 条边，可选 meta 元数据前缀；\n两类信道共同点：评测可复现、fn1 返回 string。', { fill: C.yellowBg, titleColor: C.yellow });
  slide.addText('编译期按签名注入 extern "C" wrapper（char*→std::string、int*→vector<int>、strtoll 等），用户函数保持 C++ 写法即可，无需手写。', {
    x: 0.6, y: 4.6, w: 12, h: 0.55, fontSize: 13, color: C.sub, fontFace: FONT, margin: 0,
  });
  card(slide, 0.6, 5.35, 12.05, 1.5, '为什么做类型菜单',
    '目标：通信题兼容大部分题目，不用每道题写一个专用 driver。two-phase 泛化后，B3790（string→string）、P9165（vector<int>→string + 噪声）、P10539（vector<int>→string + 删边）都只用配置 + 题面改写落地；stations 保留为内置 grader 的专用驱动。', { fill: C.greenBg, titleColor: C.green });
  slide.addNotes('类型菜单是第 8 天收口的核心泛化，让通信题从「每题一个 driver」变成「配置驱动」。');
}

// ============ 第 9 页 比赛与封榜滚榜 ============
{
  const slide = pptx.addSlide();
  header(slide, '比赛模块：ACM 榜单 + 封榜滚榜');
  slide.addText('榜单格子（五色框）', { x: 0.6, y: 1.6, w: 4, h: 0.4, fontSize: 14, bold: true, color: C.ink, fontFace: FONT, margin: 0 });
  const legend = [
    ['首杀', C.blueBg, C.blue],
    ['AC', C.greenBg, C.green],
    ['封榜前尝试', C.redBg, C.red],
    ['封榜后（冻结）', C.yellowBg, C.yellow],
    ['未提交', C.white, 'C9CED9'],
  ];
  legend.forEach((l, i) => {
    const x = 0.6 + i * 1.28;
    slide.addShape('roundRect', { x, y: 2.08, w: 1.06, h: 1.0, rectRadius: 0.1, fill: { color: l[1] }, line: { color: l[2], width: 2 } });
    slide.addText(l[0] === '未提交' ? '' : '2 | 15′', { x, y: 2.08, w: 1.06, h: 1.0, fontSize: 11, bold: true, color: C.ink, align: 'center', valign: 'middle', fontFace: MONO, margin: 0 });
    slide.addText(l[0], { x: x - 0.08, y: 3.18, w: 1.3, h: 0.35, fontSize: 11, color: C.sub, align: 'center', fontFace: FONT, margin: 0 });
  });
  slide.addText('格子内容 =「提交次数（AC 后不计）| 时间（AC=首 AC 时间，否则最后提交时间）」', {
    x: 0.6, y: 3.75, w: 7, h: 0.4, fontSize: 11.5, color: C.sub, fontFace: FONT, margin: 0,
  });
  card(slide, 0.6, 4.35, 6.1, 2.5, '封榜滚榜流程',
    '1  比赛配封榜时间（后台可配，留空 = 不封榜）\n2  封榜后提交冻结：黄色框 + 队伍旁 +N 冻结数\n3  赛后「开始滚榜」：榜单全屏，点击左键逐格揭晓\n4  揭晓顺序按当前排名从低到高，每揭一格重排一次\n5  全部揭晓 = 终榜；Esc 退出', { fill: C.yellowBg, titleColor: C.yellow });
  card(slide, 6.9, 4.35, 5.75, 2.5, 'ACM 榜单口径',
    '排名：AC 数降序 → 罚时升序 → 最近 AC 时间升序\n罚时 = 各题首次 AC 分钟 + 首次 AC 前错误数 × 20（CE 不计罚时）\n比赛内提交完成时 WS 广播自动刷新榜单', { fill: C.blueBg, titleColor: C.blue });
  slide.addNotes('滚榜演示数据：历史周赛 #1（4 道赛题、8 支队伍、40 条提交，封榜前后各一批）。');
}

// ============ 第 10 页 测试与验证 ============
{
  const slide = pptx.addSlide();
  header(slide, '测试与验证');
  const stats = [
    ['136', '接口断言全部通过', C.indigo, 'npm test（内存库，覆盖验收 #1~#8、#14）'],
    ['17', '压测断言全部通过', C.green, '300 并发提交全 201；拉取不重复不遗漏；回传幂等'],
    ['18248', '棵树 × 747486 次查询', C.blue, 'P6838 标号方案判别 / 路由与 BFS 全一致'],
    ['26', '真实数据回归通过', C.yellow, '真实 60 条提交上榜单 / 统计 / 列表与库一致'],
  ];
  stats.forEach((s, i) => {
    const x = 0.6 + (i % 2) * 6.2;
    const y = 1.7 + Math.floor(i / 2) * 2.35;
    slide.addShape('roundRect', { x, y, w: 5.9, h: 2.1, rectRadius: 0.1, fill: { color: C.cardBg }, line: { color: C.line, width: 1 } });
    slide.addText(s[0], { x: x + 0.25, y: y + 0.18, w: 2.3, h: 1.1, fontSize: 40, bold: true, color: s[2], fontFace: MONO, margin: 0, valign: 'middle' });
    slide.addText(s[1], { x: x + 2.7, y: y + 0.3, w: 3.0, h: 0.6, fontSize: 14, bold: true, color: C.ink, fontFace: FONT, margin: 0, valign: 'middle' });
    slide.addText(s[3], { x: x + 2.7, y: y + 0.95, w: 3.0, h: 0.95, fontSize: 11, color: C.sub, fontFace: FONT, margin: 0, valign: 'top', lineSpacingMultiple: 1.25 });
  });
  slide.addText('浏览器端到端走查：第 7 天按冻结清单 A / B / C 三组全过（含失败路径与异常变体）；第 8 天协议泛化回归——数组求和接力 5 组全 AC（含 5×10⁹ 溢出边界）、P9165 噪声信道 AC、P10539 删边信道 AC。', {
    x: 0.6, y: 6.55, w: 12.2, h: 0.75, fontSize: 12.5, color: C.sub, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.3,
  });
  slide.addNotes('所有验证都可重复执行：npm test / stress / harness / verify-p6838 / realdata。');
}

// ============ 第 11 页 工程化 harness ============
{
  const slide = pptx.addSlide();
  header(slide, '仓库 Harness：约束套件');
  slide.addText('落在：根目录 AGENTS.md（人机共读 6 条规则）· scripts/harness-check.js（敏感信息扫描）· package.json 的 npm run harness', {
    x: 0.6, y: 1.55, w: 12.2, h: 0.45, fontSize: 12.5, color: C.sub, fontFace: FONT, margin: 0,
  });
  const rules = [
    ['改动范围', '先列清单征得确认；只改相关文件'],
    ['禁区', 'data / node_modules 不可动；已交报告口径不可改'],
    ['依赖与密钥', '不新增依赖；密钥启动自动生成'],
    ['完成标准', 'npm test 全过 + seed 幂等 + 文档同步 + 走查'],
    ['git 口径', 'docs 与报告不入库；提交清单交本人执行'],
    ['AI 据实', '报告 AI 沟通节不编造案例'],
  ];
  rules.forEach((r, i) => {
    const x = 0.6 + (i % 3) * 4.13;
    const y = 2.2 + Math.floor(i / 3) * 2.15;
    slide.addShape('roundRect', { x, y, w: 3.9, h: 1.9, rectRadius: 0.1, fill: { color: C.cardBg }, line: { color: C.line, width: 1 } });
    slide.addText(r[0], { x: x + 0.22, y: y + 0.18, w: 3.5, h: 0.4, fontSize: 14, bold: true, color: C.indigo, fontFace: FONT, margin: 0 });
    slide.addText(r[1], { x: x + 0.22, y: y + 0.62, w: 3.5, h: 1.15, fontSize: 11.5, color: C.ink, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.3, valign: 'top' });
  });
  slide.addText('第 8 天补强两条：标号方案数据脚本互验（npm run verify-p6838）、判定兜底分支条件非恒真复核——均并入完成标准。', {
    x: 0.6, y: 6.7, w: 12.2, h: 0.5, fontSize: 12.5, color: C.sub, fontFace: FONT, margin: 0,
  });
  slide.addNotes('harness 管住六件事，且多次实际拦下/漏过问题，漏过的都补成了新规则。');
}

// ============ 第 12 页 总结（暗底） ============
{
  const slide = pptx.addSlide();
  slide.addShape('rect', { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: C.dark } });
  slide.addText('总结', { x: 0.9, y: 0.55, w: 6, h: 0.7, fontSize: 30, bold: true, color: C.white, fontFace: FONT, margin: 0 });
  cellMotif(slide, 11.6, 0.75, 0.26);
  slide.addText([
    { text: '做成了什么：', options: { bold: true, color: C.ice } },
    { text: '15 项必做 + 比赛模块全部完成，验收 15 条与 C1~C5 全部通过——纯前端 C++ WASM 判题、两进程函数式通信题（协议类型菜单 + 中间值变换，落地五道改编样例）、ACM 比赛与封榜滚榜、136 项接口断言与 17 项压测、harness 约束套件。', options: { breakLine: true, color: 'C7CCD6' } },
  ], { x: 0.9, y: 1.7, w: 11.5, h: 1.3, fontSize: 15, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.4, valign: 'top' });
  slide.addText([
    { text: '差在哪里：', options: { bold: true, color: C.ice } },
    { text: '通信题改编保留两处简化（噪声率 20% 替代原题 50%、删边信道保留边顺序）；B4353「程序套娃」因与两进程函数式模型本质冲突（需 n 次编译运行链）在第八天明确放弃并改回范围。', options: { breakLine: true, color: 'C7CCD6' } },
  ], { x: 0.9, y: 3.35, w: 11.5, h: 1.2, fontSize: 15, fontFace: FONT, margin: 0, lineSpacingMultiple: 1.4, valign: 'top' });
  slide.addText('系统当前可用、可复现：npm install → npm run seed → npm start，即可按演示说明走通全流程。', {
    x: 0.9, y: 5.0, w: 11.5, h: 0.5, fontSize: 15, bold: true, color: C.white, fontFace: FONT, margin: 0,
  });
  slide.addText('谢谢观看 · 欢迎提问', { x: 0.9, y: 6.35, w: 6, h: 0.5, fontSize: 14, color: '8A8F98', fontFace: FONT, margin: 0 });
  slide.addNotes('收尾：对照完成情况，写清做成什么、差在哪里。');
}

pptx.writeFile({ fileName: process.argv[2] || 'WebOJ演示.pptx' })
  .then((f) => console.log('已生成：' + f))
  .catch((e) => { console.error('生成失败：', e); process.exit(1); });
