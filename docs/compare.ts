import { render } from 'render-tag';

// ── Shared CSS for all demos ──

const DEMO_CSS = `
body { font-family: 'IBM Plex Sans', system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.5; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; padding: 8px 12px; background: #f9fafb; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #374151; }
td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
.badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.badge-green { background: #dcfce7; color: #166534; }
.badge-yellow { background: #fef9c3; color: #854d0e; }
.badge-red { background: #fee2e2; color: #991b1b; }
.cols { display: flex; gap: 20px; font-size: 14px; line-height: 1.6; }
.col { flex: 1; }
.col h3 { font-size: 16px; margin: 0 0 6px 0; }
.col p { margin: 0 0 8px 0; }
pre.code { background: #1a1a2e; color: #e8e8ed; padding: 12px 16px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; line-height: 1.6; margin: 0 0 12px 0; overflow-x: auto; }
.kw { color: #c084fc; }
.str { color: #4ade80; }
.cm { color: #6b7280; font-style: italic; }
blockquote { border-left: 3px solid #d1d5db; padding: 8px 16px; margin: 0; color: #4b5563; font-style: italic; }
.newsletter { font-size: 14px; line-height: 1.7; }
.newsletter h2 { font-family: 'Playfair Display', serif; font-size: 24px; font-weight: 700; margin: 0 0 4px 0; }
.newsletter .date { font-size: 12px; color: #9ca3af; margin: 0 0 16px 0; }
.newsletter p { margin: 0 0 12px 0; }
.newsletter .highlight { background: #eff6ff; border-left: 3px solid #3b82f6; padding: 10px 14px; margin: 0 0 12px 0; }
.newsletter .highlight p { margin: 0; }
`;

// ── Demo HTML snippets (one per card) ──

const DEMOS: string[] = [

  // Rich Text Formatting
  `<p style="font-size: 16px; line-height: 1.7;"><strong>Bold text</strong>, <em>italic text</em>, and <strong><em>bold italic</em></strong>. <span style="color: #dc2626;">Red text</span>, <span style="color: #2563eb;">blue text</span>, <span style="background: #ffeaa7; padding: 1px 4px;">yellow highlight</span>, <span style="background: #d4efdf; padding: 1px 4px;">green highlight</span>. <u>Underlined</u>, <s>strikethrough</s>, and <span style="font-size: 22px; font-weight: 700; color: #2d3436;">large bold</span> inline.</p>`,

  // Text Decorations
  `<div style="font-size: 16px; line-height: 2.2;">
<p><span style="text-decoration: underline;">Underline</span> &nbsp; <span style="text-decoration: line-through;">Strikethrough</span> &nbsp; <span style="text-decoration: overline;">Overline</span></p>
<p><span style="text-decoration: underline wavy #e74c3c;">Wavy red underline</span> &nbsp; <span style="text-decoration: underline dotted #3498db;">Dotted blue</span> &nbsp; <span style="text-decoration: underline dashed #27ae60;">Dashed green</span></p>
<p><span style="text-decoration: underline double #9b59b6;">Double purple</span> &nbsp; <span style="text-decoration: overline underline #e67e22;">Over + Under orange</span></p>
</div>`,

  // Headings & Article
  `<h1 style="font-size: 28px; margin: 0 0 8px 0;">Main Article Title</h1>
<p style="font-size: 14px; color: #6b7280; margin: 0 0 16px 0;">Published March 2026 &middot; 5 min read</p>
<h2 style="font-size: 22px; margin: 0 0 6px 0;">Introduction</h2>
<p style="font-size: 15px; line-height: 1.7; margin: 0 0 16px 0;">CSS layout has evolved dramatically over the past decade. From float-based hacks to modern Flexbox and Grid, the tools available to web developers have transformed how we approach design.</p>
<h3 style="font-size: 18px; margin: 0 0 6px 0;">Key Concepts</h3>
<p style="font-size: 15px; line-height: 1.7; margin: 0 0 12px 0;">Understanding the <strong>box model</strong>, <em>cascade</em>, and <u>specificity</u> is fundamental to writing maintainable CSS.</p>
<h4 style="font-size: 15px; margin: 0 0 4px 0;">Box Model Details</h4>
<p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0;">Every element is a rectangular box with content, padding, border, and margin areas.</p>`,

  // Mixed Fonts
  `<div style="line-height: 1.7;">
<p style="font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; margin: 0 0 6px 0;">Playfair Display Heading</p>
<p style="font-family: 'Roboto', sans-serif; font-size: 15px; margin: 0 0 6px 0;">Roboto regular and <strong>bold weight</strong> with <em>italic style</em></p>
<p style="font-family: 'Merriweather', serif; font-size: 14px; font-style: italic; margin: 0 0 6px 0;">Merriweather italic — a classic serif for body text</p>
<p style="font-family: 'Lobster', cursive; font-size: 24px; color: #6a0dad; margin: 0 0 6px 0;">Lobster cursive display</p>
<p style="font-family: 'Caveat', cursive; font-size: 22px; color: #b45309; margin: 0;">Caveat handwriting style</p>
</div>`,

  // Font Sizes & Weights
  `<div style="line-height: 1.4;">
<p style="font-size: 10px; margin: 0 0 4px 0;">10px — tiny fine print text for disclaimers and footnotes</p>
<p style="font-size: 14px; margin: 0 0 4px 0;">14px — standard body text for comfortable reading</p>
<p style="font-size: 20px; margin: 0 0 4px 0;">20px — subheading with more presence</p>
<p style="font-size: 32px; font-weight: 700; margin: 0 0 8px 0;">32px Bold Heading</p>
<p style="font-size: 44px; font-weight: 900; letter-spacing: -1px; margin: 0 0 12px 0;">44px Black</p>
<p><span style="font-weight: 100;">Thin 100</span> &middot; <span style="font-weight: 300;">Light 300</span> &middot; <span style="font-weight: 400;">Regular 400</span> &middot; <span style="font-weight: 500;">Medium 500</span> &middot; <span style="font-weight: 700;">Bold 700</span> &middot; <span style="font-weight: 900;">Black 900</span></p>
</div>`,

  // Mixed Font Sizes on One Line
  `<p style="line-height: 1.3; margin: 0 0 8px 0;"><span style="font-size: 12px;">12px</span> next to <span style="font-size: 24px;">24px</span> next to <span style="font-size: 36px; font-weight: 700;">36px bold</span> next to <span style="font-size: 10px;">10px tiny</span></p>
<p style="line-height: 1.2; margin: 0;"><span style="font-size: 8px;">tiny</span><span style="font-size: 48px; font-weight: 700; color: #2563eb;">LARGE</span><span style="font-size: 8px;">tiny</span></p>`,

  // Gradient Text
  `<div style="line-height: 1.4;">
<p style="font-size: 32px; font-weight: 700; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #ff0844, #ffb199); margin: 0 0 8px 0;">Sunset gradient</p>
<p style="font-size: 28px; font-weight: 600; font-family: 'Playfair Display', serif; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #0061ff, #60efff); margin: 0 0 8px 0;">Ocean blue to cyan</p>
<p style="font-size: 26px; font-weight: 700; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(135deg, #f5af19, #f12711); margin: 0 0 8px 0;">Diagonal fire</p>
<p style="font-size: 24px; font-weight: 700; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #a855f7, #ec4899, #f97316); margin: 0;">Purple pink orange</p>
</div>`,

  // Text Shadows
  `<div style="line-height: 1.5;">
<p style="font-size: 28px; font-weight: 700; color: #2c3e50; text-shadow: 3px 3px 0 #bdc3c7; margin: 0 0 8px 0;">Hard drop shadow</p>
<p style="font-size: 26px; font-weight: 700; color: #e74c3c; text-shadow: 0 0 12px rgba(231,76,60,0.6); margin: 0 0 8px 0;">Neon red glow</p>
<p style="font-size: 24px; font-weight: 600; color: #3498db; text-shadow: 0 0 20px rgba(52,152,219,0.5), 0 0 40px rgba(52,152,219,0.3); margin: 0 0 8px 0;">Blue double glow</p>
<p style="font-size: 24px; font-weight: 700; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.6), 0 0 20px rgba(52,152,219,0.4); background: #1a1a2e; padding: 8px 12px; margin: 0;">Light on dark</p>
</div>`,

  // Text Stroke
  `<div style="line-height: 1.4;">
<p style="font-size: 36px; font-weight: 900; -webkit-text-stroke: 2px #111827; -webkit-text-fill-color: transparent; margin: 0 0 8px 0;">Outlined text</p>
<p style="font-size: 32px; font-weight: 700; -webkit-text-stroke: 1.5px #dc2626; -webkit-text-fill-color: #fecaca; margin: 0 0 8px 0;">Red stroke, pink fill</p>
<p style="font-size: 28px; font-weight: 700; -webkit-text-stroke: 1px #0f62fe; color: #0f62fe; margin: 0;">Blue stroke with fill</p>
</div>`,

  // Letter & Word Spacing
  `<div style="line-height: 1.8;">
<p style="font-size: 13px; letter-spacing: 6px; text-transform: uppercase; font-weight: 600; color: #555; margin: 0 0 6px 0;">Wide tracked uppercase</p>
<p style="font-size: 20px; letter-spacing: -0.8px; font-weight: 700; margin: 0 0 6px 0;">Tight headline kerning for display</p>
<p style="font-size: 14px; word-spacing: 12px; margin: 0 0 6px 0;">Extra wide word spacing applied here</p>
<p style="font-size: 14px; letter-spacing: 2px; word-spacing: 6px; margin: 0;">Both letter and word spacing combined</p>
</div>`,

  // Text Alignment
  `<div style="font-size: 14px; line-height: 1.7;">
<p style="text-align: left; margin: 0 0 8px 0;">Left-aligned text is the default for most content and feels natural to read in LTR languages.</p>
<p style="text-align: center; font-style: italic; color: #555; margin: 0 0 8px 0;">Centered text works great for headings, quotes, and captions in editorial layouts.</p>
<p style="text-align: right; color: #8e44ad; margin: 0 0 8px 0;">Right-aligned text is used for dates, signatures, and metadata sections.</p>
<p style="text-align: justify; margin: 0;">Justified text stretches words to fill the full width of each line, creating clean edges on both sides like a printed book or newspaper column. This is especially visible on longer paragraphs.</p>
</div>`,

  // Line Height Variations
  `<div style="font-size: 14px;">
<p style="line-height: 0.9; margin: 0 0 12px 0; background: #fef3c7; padding: 4px 8px;">Line-height 0.9 — very tight, lines overlap slightly. Used for display type and artistic layouts.</p>
<p style="line-height: 1.2; margin: 0 0 12px 0; background: #dbeafe; padding: 4px 8px;">Line-height 1.2 — compact but readable. Common for headings.</p>
<p style="line-height: 1.6; margin: 0 0 12px 0; background: #dcfce7; padding: 4px 8px;">Line-height 1.6 — comfortable reading. The sweet spot for body text in most designs.</p>
<p style="line-height: 2.5; margin: 0; background: #fce7f3; padding: 4px 8px;">Line-height 2.5 — very airy, double-spaced feel. Used for legal documents and draft manuscripts.</p>
</div>`,

  // Lists
  `<div style="font-size: 14px; line-height: 1.6;">
<ul style="margin: 0 0 12px 0;">
  <li>First item with enough text to wrap onto a second line in narrower layouts</li>
  <li>Second item
    <ul>
      <li>Nested bullet A</li>
      <li>Nested bullet B
        <ul><li>Third level deep</li></ul>
      </li>
    </ul>
  </li>
  <li><strong>Bold</strong> item with <em>italic</em> and <span style="color: #dc2626;">red</span></li>
</ul>
<ol style="margin: 0;">
  <li>First ordered</li>
  <li>Second ordered
    <ol><li>Nested numbered A</li><li>Nested numbered B</li></ol>
  </li>
  <li>Third ordered</li>
</ol>
</div>`,

  // Rich List Items
  `<ul style="font-size: 14px; line-height: 1.7;">
<li><span style="color: #16a34a; font-weight: bold;">Done:</span> <s>Update the deployment scripts</s></li>
<li><span style="color: #dc2626; font-weight: bold;">Important:</span> Review the <em>quarterly report</em> before Friday</li>
<li><span style="color: #2563eb;">In Progress:</span> Refactor the <code style="background: #f3f4f6; padding: 1px 4px;">UserService</code> module</li>
<li>Send final invoice to <strong>Acme Corp</strong> — <span style="color: #6b7280;">$12,500</span></li>
</ul>`,

  // Table
  `<table>
<thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
<tbody>
<tr><td><strong>Alice Johnson</strong></td><td>Engineering Lead</td><td><span class="badge badge-green">Active</span></td></tr>
<tr><td><strong>Bob Smith</strong></td><td>Senior Developer</td><td><span class="badge badge-green">Active</span></td></tr>
<tr><td><strong>Carol Lee</strong></td><td>Designer</td><td><span class="badge badge-yellow">Away</span></td></tr>
<tr><td><strong>Dan Wilson</strong></td><td>QA Engineer</td><td><span class="badge badge-red">Offline</span></td></tr>
</tbody>
</table>`,

  // Flexbox
  `<div class="cols">
<div class="col">
  <h3>Features</h3>
  <p>A <strong>comprehensive suite</strong> of tools for modern design teams.</p>
  <ul><li>Real-time collaboration</li><li>Advanced analytics</li><li>Custom workflows</li></ul>
</div>
<div class="col">
  <h3>Pricing</h3>
  <p>Flexible plans that <em>scale with your business</em>.</p>
  <ul><li>Free tier available</li><li>Team: $12/user/mo</li><li>Enterprise: custom</li></ul>
</div>
</div>`,

  // Rainbow
  `<p style="font-size: 18px; line-height: 2; font-weight: 600;"><span style="color: #dc2626;">Red </span><span style="color: #ea580c;">Orange </span><span style="color: #ca8a04;">Yellow </span><span style="color: #16a34a;">Green </span><span style="color: #2563eb;">Blue </span><span style="color: #7c3aed;">Indigo </span><span style="color: #9333ea;">Violet</span></p>
<p style="font-size: 14px; line-height: 2;"><span style="background: #fecaca; padding: 2px 8px;">Red bg</span> <span style="background: #fed7aa; padding: 2px 8px;">Orange bg</span> <span style="background: #fef08a; padding: 2px 8px;">Yellow bg</span> <span style="background: #bbf7d0; padding: 2px 8px;">Green bg</span> <span style="background: #bfdbfe; padding: 2px 8px;">Blue bg</span> <span style="background: #ddd6fe; padding: 2px 8px;">Purple bg</span></p>`,

  // Deeply Nested
  `<p style="font-size: 16px; line-height: 1.8;">Start with <span style="color: #dc2626;"><u>underlined <em>italic <strong>bold <span style="background: #fef08a; padding: 1px 4px;">highlighted deep nesting</span> still bold</strong></em></u></span> back to normal.</p>
<p style="font-size: 15px; line-height: 1.8;">Another: <strong>bold <span style="color: #2563eb;">blue <em>italic <span style="font-size: 20px;">large <span style="background: #dbeafe; padding: 1px 4px;">highlighted</span></span></em></span></strong> and done.</p>`,

  // Whitespace
  `<div style="font-size: 14px; line-height: 1.7;">
<p style="margin: 0 0 8px 0;">Normal:  multiple   spaces    are     collapsed      into one.</p>
<p style="white-space: pre-wrap; margin: 0 0 8px 0; background: #f9fafb; padding: 4px 8px;">Pre-wrap:  multiple   spaces    are     preserved      here.</p>
<p style="white-space: pre-wrap; margin: 0 0 8px 0; background: #f9fafb; padding: 4px 8px;">Tabs:&#9;one&#9;two&#9;three&#9;four</p>
<p style="margin: 0;">Line breaks:<br>Second line<br>Third line<br>Fourth line</p>
</div>`,

  // Word Wrap
  `<div style="font-size: 14px; line-height: 1.7; overflow-wrap: break-word;">
<p style="margin: 0 0 8px 0;">Normal paragraph wrapping works fine with regular English text like this sentence.</p>
<p style="margin: 0 0 8px 0;">Long URL: https://www.example.com/very/long/path/that/should/wrap/across/multiple/lines/in/the/container</p>
<p style="margin: 0;">Unbroken: superlongwordwithoutanybreakpointsthatmustbeforciblybrokenbythelayoutenginetofitinsidethecontainer</p>
</div>`,

  // Subscript & Superscript
  `<div style="font-size: 16px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">Water is H<sub>2</sub>O and carbon dioxide is CO<sub>2</sub></p>
<p style="margin: 0 0 6px 0;">Einstein's equation: E = mc<sup>2</sup></p>
<p style="margin: 0 0 6px 0;">Chemical: Ca(OH)<sub>2</sub> + H<sub>2</sub>SO<sub>4</sub> &rarr; CaSO<sub>4</sub> + 2H<sub>2</sub>O</p>
<p style="margin: 0;">Footnote reference<sup style="color: #2563eb;">[1]</sup> and trademark<sup>&trade;</sup></p>
</div>`,

  // Entities
  `<div style="font-size: 15px; line-height: 1.8;">
<p style="margin: 0 0 4px 0;">Ampersand: &amp; &middot; Less: &lt; &middot; Greater: &gt; &middot; Quote: &quot;</p>
<p style="margin: 0 0 4px 0;">&copy; 2026 &middot; &reg; Registered &middot; &trade; Trademark</p>
<p style="margin: 0 0 4px 0;">Dashes: en&ndash;dash &middot; em&mdash;dash &middot; Ellipsis&hellip;</p>
<p style="margin: 0 0 4px 0;">Math: 5 &times; 3 = 15 &middot; 10 &divide; 2 = 5 &middot; &pi; &asymp; 3.14</p>
<p style="margin: 0;">Currencies: $99 &middot; &euro;85 &middot; &pound;72 &middot; &yen;12,800</p>
</div>`,

  // Arabic RTL
  `<div dir="rtl" style="font-size: 16px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">مرحبا بالعالم، هذا نص عربي لاختبار العرض من اليمين إلى اليسار.</p>
<p style="margin: 0 0 6px 0;"><strong>نص غامق</strong> و <em>نص مائل</em> و <u>نص مسطر</u> و <span style="color: #dc2626;">نص أحمر</span></p>
<p style="margin: 0;">التصميم الجرافيكي هو فن التواصل البصري وحل المشاكل باستخدام الطباعة والتصوير.</p>
</div>`,

  // Hebrew RTL
  `<div dir="rtl" style="font-size: 16px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">שלום עולם! זהו טקסט בעברית.</p>
<p style="margin: 0 0 6px 0;"><strong>טקסט מודגש</strong> – עם סימני פיסוק (כמו: סוגריים ונקודות).</p>
<p style="margin: 0;">התכנות היא אומנות של יצירתיות, חדשנות, וחוקים בעדכויות.</p>
</div>`,

  // Mixed bidi
  `<div style="font-size: 15px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">This is English text مع نص عربي followed by more English.</p>
<p dir="rtl" style="margin: 0 0 6px 0;">هذا نص عربي with English words في المنتصف.</p>
<p style="margin: 0;">The word مرحبا means hello and שלום also means hello.</p>
</div>`,

  // RTL Lists
  `<div dir="rtl" style="font-size: 15px; line-height: 1.7;">
<h3 style="font-size: 17px; margin: 0 0 8px 0;">قائمة المهام</h3>
<ul style="margin: 0 0 12px 0;">
  <li>إعداد <strong>التقرير</strong> السنوي</li>
  <li>مراجعة الميزانية العامة للمشروع</li>
  <li>تنسيق مع فريق <em>التطوير</em></li>
</ul>
<ol style="margin: 0;">
  <li>المرحلة الأولى: التخطيط</li>
  <li>المرحلة الثانية: التنفيذ</li>
  <li>المرحلة الثالثة: المراجعة</li>
</ol>
</div>`,

  // Japanese
  `<div style="font-size: 15px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">東京は日本の首都です。人口は約1400万人で、世界最大の都市圏の一つです。</p>
<p style="margin: 0 0 6px 0;">プログラミング言語には、JavaScript、Python、TypeScriptなどがあります。</p>
<p style="margin: 0;">ひらがなとカタカナと漢字を混ぜた文章です。<strong>太字</strong>と<em>斜体</em>も対応。</p>
</div>`,

  // Chinese
  `<div style="font-size: 15px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">人工智能正在改变我们的世界。从自然语言处理到计算机视觉，机器学习的应用无处不在。</p>
<p style="margin: 0;">软件开发是一门艺术，也是一门科学。<strong>优秀的代码</strong>应该是<em>清晰、简洁、可维护的</em>。</p>
</div>`,

  // Korean
  `<div style="font-size: 15px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">안녕하세요! 한국어 텍스트 렌더링 테스트입니다.</p>
<p style="margin: 0 0 6px 0;">소프트웨어 개발은 창의적인 문제 해결 과정입니다. <strong>품질</strong>과 <em>효율성</em>을 동시에 추구해야 합니다.</p>
<p style="margin: 0;">한글은 세종대왕이 창제한 문자 체계로, 과학적이고 체계적인 구조를 가지고 있습니다.</p>
</div>`,

  // Mixed CJK + Latin
  `<div style="font-size: 15px; line-height: 1.8;">
<p style="margin: 0 0 6px 0;">今日のWeb開発ではReactやVue.jsなどのframeworkが主流です。</p>
<p style="margin: 0 0 6px 0;">我们使用TypeScript进行开发，它提供了更好的type safety。</p>
<p style="margin: 0;"><span style="font-size: 12px;">Small English</span> <span style="font-size: 24px;">大きな日本語</span> <span style="font-size: 14px;">medium</span> <span style="font-size: 28px;">中文大字</span></p>
</div>`,

  // Emoji
  `<div style="font-size: 16px; line-height: 2;">
<p style="margin: 0 0 4px 0;">Simple: 😀 🎉 ❤️ 🚀 ⭐ 🔥 💡 🎯 🌈 🎨</p>
<p style="margin: 0 0 4px 0;">Skin tones: 👋🏻 👋🏼 👋🏽 👋🏾 👋🏿</p>
<p style="margin: 0 0 4px 0;">ZWJ: 👨‍👩‍👧‍👦 👩‍💻 👨🏽‍🔬 🏳️‍🌈</p>
<p style="margin: 0;">In text: Hello 👋 World 🌍 — <strong>bold 🔥</strong> and <em>italic 💡</em> and <span style="color: #dc2626;">red ❤️</span></p>
</div>`,

  // Emoji in Lists
  `<ul style="font-size: 14px; line-height: 1.8;">
<li>🚀 Launch the new feature by Friday</li>
<li>🐛 Fix the rendering bug in Safari</li>
<li>📝 Write documentation for the API</li>
<li>✅ Done: <strong>merged PR #42</strong></li>
<li>👨‍👩‍👧‍👦 Family emoji at list start with wrapping text that goes to second line</li>
</ul>`,

  // Seven Scripts
  `<p style="font-size: 16px; line-height: 2;">Hello <span>مرحبا</span> <span>שלום</span> <span>你好</span> <span>こんにちは</span> <span>안녕하세요</span> <span>สวัสดี</span> — seven scripts in one line!</p>
<p style="font-size: 15px; line-height: 1.8;">Mixed formatting: <strong>العربية الغامقة</strong> with <em>中文斜体</em> and <u>underlined English</u>.</p>`,

  // Code & Blockquote
  `<pre class="code"><span class="cm">// A simple greeting function</span>
<span class="kw">function</span> greet(name: <span class="kw">string</span>): <span class="kw">string</span> {
  <span class="kw">return</span> <span class="str">\`Hello, \${name}!\`</span>;
}</pre>
<blockquote>
<p style="margin: 0;">Any fool can write code that a computer can understand. Good programmers write code that humans can understand.</p>
<p style="margin: 4px 0 0 0; font-size: 13px; color: #9ca3af;">— Martin Fowler</p>
</blockquote>`,

  // Dense Mixed
  `<div style="font-size: 14px; line-height: 1.7;">
<p style="margin: 0 0 10px 0;"><strong>Bold</strong> and <em>italic</em> and <strong><em>both</em></strong>. <span style="color: #da1e28;">Red text</span>, <span style="color: #0f62fe;">blue text</span>, <span style="background: #ffeaa7; padding: 1px 4px;">yellow highlight</span>. <u>Underlined</u>, <s>strikethrough</s>, <span style="text-decoration: underline wavy #e74c3c;">wavy underline</span>. Fonts: <span style="font-family: 'Lobster', cursive; font-size: 18px; color: #6a0dad;">Lobster</span>, <span style="font-weight: 300;">light 300</span>, <span style="font-weight: 900;">black 900</span>.</p>
<p style="margin: 0 0 10px 0;">Status emoji: 👩‍💻 👨🏽‍🔬 🏳️‍🌈 with mixed scripts: مرحبا and 你好 and 안녕 in one paragraph.</p>
<ul style="margin: 0;">
  <li>Item with <code style="background: #f3f4f6; padding: 1px 4px;">inline code</code> and a <a href="#" style="color: #2563eb;">link</a></li>
  <li>H<sub>2</sub>O and E=mc<sup>2</sup> in a list</li>
  <li><span style="font-size: 20px; font-weight: 700; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #f5af19, #f12711);">Gradient text in a list item</span></li>
</ul>
</div>`,

  // Newsletter
  `<div class="newsletter">
<h2>Weekly Design Digest</h2>
<p class="date">Issue #47 &middot; March 30, 2026</p>
<p>This week: <strong>render-tag</strong> hits v1.0, bringing HTML rich text rendering to canvas at <em>unprecedented speed</em>. Here's what you need to know.</p>
<div class="highlight">
  <p><strong>Key takeaway:</strong> Canvas text rendering is now 10-60x faster than SVG foreignObject, with full CSS support including <span style="color: #2563eb;">colors</span>, <span style="font-family: 'Playfair Display', serif;">custom fonts</span>, and <span style="text-decoration: underline wavy #e74c3c;">decorations</span>.</p>
</div>
<p>What's new in this release:</p>
<ul>
  <li>Flexbox and table layout support</li>
  <li>RTL and CJK text rendering</li>
  <li>Text gradients and shadows</li>
  <li>Zero dependencies, synchronous API</li>
</ul>
</div>`,

  // Long Paragraph
  `<p style="font-size: 15px; line-height: 1.8; text-align: justify;">Release checklist (<strong>v2.3.1</strong>): ship the 8:30-4:30 coverage panel, keep the backup URL <code style="background: #f3f4f6; padding: 1px 4px; font-size: 13px;">https://example.com/reports/q3?lang=ar&amp;mode=full</code> readable, and do not let the "primary CTA" jump when the card shrinks from 420px to 300px. Nora wrote "please keep 10,000 rows visible", Mina replied "transatlantic labels are still weird", and Kenji answered 「了解です」before pasting <em>価格は¥12,800です</em> and the Korean note "다음 배포는 7:00-9:00 사이예요." Every font weight from <span style="font-weight: 100;">thin</span> to <span style="font-weight: 900;">black</span> should render crisply.</p>`,
];

// ── Rendering logic ──

const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&family=Caveat:wght@700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Roboto:ital,wght@0,400;0,700;1,400&family=Merriweather:ital,wght@0,400;0,700;1,400&family=Lobster&display=swap';

function buildSrcdoc(html: string, width: number): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS_CSS}" rel="stylesheet">
<style>body { margin: 0; padding: 0; width: ${width}px; } ${DEMO_CSS}</style>
</head><body>${html}</body></html>`;
}

interface CardState {
  html: string;
  cardEl: HTMLElement;
  canvasPane: HTMLElement;
  iframe: HTMLIFrameElement;
  ready: boolean; // true once iframe fonts have loaded
}

const cards: CardState[] = [];

/** Content width = half the card (one column) minus pane padding. */
function contentWidth(state: CardState): number {
  // Card is a 2-col grid with 1px gap, so each column ≈ (card - 1) / 2
  const colWidth = (state.cardEl.clientWidth - 1) / 2;
  return Math.max(200, Math.floor(colWidth - 40)); // 20px padding each side
}

/** Sync iframe height to its content. */
function syncIframeHeight(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument;
  if (!doc) return;
  iframe.style.height = doc.documentElement.scrollHeight + 'px';
}

/** Create the iframe once (initial load). */
function createCard(state: CardState) {
  const w = contentWidth(state);

  state.iframe.srcdoc = buildSrcdoc(state.html, w);
  state.iframe.addEventListener('load', () => {
    const doc = state.iframe.contentDocument;
    if (!doc) return;
    doc.fonts.ready.then(() => {
      state.ready = true;
      syncIframeHeight(state.iframe);
    });
  });

  renderCanvas(state, w);
}

/** Fast resize: update iframe body width in-place + re-render canvas. */
function resizeCard(state: CardState) {
  if (!state.ready) return;
  const w = contentWidth(state);
  const doc = state.iframe.contentDocument;
  if (doc) {
    doc.body.style.width = w + 'px';
    // Force reflow then read height
    void doc.documentElement.offsetHeight;
    syncIframeHeight(state.iframe);
  }
  renderCanvas(state, w);
}

/** Re-render just the canvas side at a given width. */
function renderCanvas(state: CardState, w: number) {
  state.canvasPane.innerHTML = '';
  try {
    const { canvas } = render({
      html: `<style>${DEMO_CSS}</style>${state.html}`,
      width: w,
      pixelRatio: 2,
    });
    // Set explicit pixel width so it doesn't stretch/squash
    canvas.style.width = w + 'px';
    canvas.style.height = 'auto';
    state.canvasPane.appendChild(canvas);
  } catch (e) {
    const err = document.createElement('div');
    err.style.cssText = 'color:#dc2626;font-size:13px;padding:8px';
    err.textContent = 'Render error: ' + (e as Error).message;
    state.canvasPane.appendChild(err);
  }
}

// ── Init ──

async function init() {
  await document.fonts.ready;

  const container = document.getElementById('cards')!;

  for (const html of DEMOS) {
    const cardEl = document.createElement('div');
    cardEl.className = 'compare-card';

    const domPane = document.createElement('div');
    domPane.className = 'compare-pane compare-pane--dom';

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;border:none;display:block;overflow:hidden';
    iframe.setAttribute('scrolling', 'no');
    domPane.appendChild(iframe);
    cardEl.appendChild(domPane);

    const canvasPane = document.createElement('div');
    canvasPane.className = 'compare-pane compare-pane--canvas';
    cardEl.appendChild(canvasPane);

    container.appendChild(cardEl);
    cards.push({ html, cardEl, canvasPane, iframe, ready: false });
  }

  // Initial render after layout
  requestAnimationFrame(() => cards.forEach(createCard));

  // Resize: update widths in-place (no iframe recreation)
  window.addEventListener('resize', () => cards.forEach(resizeCard));
}

init();
