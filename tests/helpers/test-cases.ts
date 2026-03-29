export interface BenchmarkCase {
  name: string;
  width: number;
  height: number;
  css: string;
  html: string;
}

const GOOGLE_FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100;0,300;0,400;0,500;0,700;0,900;1,100;1,300;1,400;1,500;1,700;1,900&display=swap';

const OPEN_SANS_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,600;0,700;1,400&display=swap';

// Multi-font Google Fonts URL — includes fonts with unusual metrics
const MULTI_FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Inconsolata:wght@400;700&family=Lobster&family=Merriweather:ital,wght@0,400;0,700;1,400&family=Roboto:ital,wght@0,400;0,700;1,400&display=swap';

let _openSansCss: string | undefined;
let _multiFontCss: string | undefined;

async function getOpenSansCss(): Promise<string> {
  if (_openSansCss) return _openSansCss;
  try {
    const resp = await fetch(OPEN_SANS_CSS_URL);
    _openSansCss = await resp.text();
  } catch {
    _openSansCss = `@font-face { font-family: 'Open Sans'; font-weight: 400; src: local('Open Sans'); }`;
  }
  return _openSansCss;
}

/** Font definitions for the multi-font test matrix */
export const FONT_VARIANTS = [
  { name: 'Open Sans', family: "'Open Sans', sans-serif" },
  { name: 'Roboto', family: "'Roboto', sans-serif" },
  { name: 'Playfair Display', family: "'Playfair Display', serif" },
  { name: 'Merriweather', family: "'Merriweather', serif" },
  { name: 'Lobster', family: "'Lobster', cursive" },
] as const;

export async function loadMultiFontCss(): Promise<string> {
  return getMultiFontCss();
}

async function getMultiFontCss(): Promise<string> {
  if (_multiFontCss) return _multiFontCss;
  try {
    const resp = await fetch(MULTI_FONT_CSS_URL);
    _multiFontCss = await resp.text();
  } catch {
    _multiFontCss = ['Playfair Display', 'Inconsolata', 'Lobster', 'Merriweather', 'Roboto']
      .map(f => `@font-face { font-family: '${f}'; font-weight: 400; src: local('${f}'); }`)
      .join('\n');
  }
  return _multiFontCss;
}

function withOpenSans(css: string): string {
  return _openSansCss + '\n' + css;
}

function withMultiFont(css: string): string {
  return _multiFontCss + '\n' + css;
}

export async function loadGoogleFontCase(): Promise<BenchmarkCase> {
  let fontCss: string;
  try {
    const resp = await fetch(GOOGLE_FONT_CSS_URL);
    fontCss = await resp.text();
  } catch {
    fontCss = `@font-face { font-family: 'Roboto'; font-weight: 400; src: local('Roboto'); }`;
  }

  return {
    name: 'Google Font (Roboto)',
    width: 600,
    height: 300,
    css: fontCss + `\nbody { font-family: 'Roboto', sans-serif; }`,
    html: `
      <h1 style="font-weight:900">Roboto Black Heading</h1>
      <p style="font-weight:300">Light weight paragraph text for contrast.</p>
      <p style="font-weight:400">Regular weight body text with <strong>bold (700)</strong> and <em>italic</em> variants.</p>
      <p style="font-weight:500;color:#555">Medium weight text in a muted color.</p>
    `,
  };
}

export async function loadBasicCases(): Promise<BenchmarkCase[]> {
  await getOpenSansCss();
  await getMultiFontCss();
  const font = `font-family: 'Open Sans', sans-serif;`;

  return [
    {
      name: 'Simple paragraph',
      width: 600,
      height: 200,
      css: withOpenSans(`body { ${font} }`),
      html: `<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>`,
    },

    {
      name: 'Formatted text (bold, italic, colors)',
      width: 600,
      height: 300,
      css: withOpenSans(`
        body { ${font} }
        .highlight { background: #fef08a; padding: 0 4px; }
        .accent { color: #dc2626; }
        .muted { color: #6b7280; font-size: 14px; }
      `),
      html: `
        <p><strong>Bold text</strong> followed by <em>italic text</em> and <u>underlined text</u>.</p>
        <p><span class="highlight">Highlighted text</span> with <span class="accent">red accent</span> and <s>strikethrough</s>.</p>
        <p><span class="muted">Muted small text</span> mixed with <strong><em>bold italic</em></strong> and <sup>superscript</sup>.</p>
        <p>Normal text with <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">inline code</code> inside it.</p>
      `,
    },

    {
      name: 'Multi-heading article',
      width: 800,
      height: 600,
      css: withOpenSans(`
        body { ${font} }
        h1 { font-size: 32px; margin-bottom: 8px; color: #111827; }
        h2 { font-size: 24px; margin-bottom: 6px; color: #374151; }
        h3 { font-size: 20px; margin-bottom: 4px; color: #4b5563; }
        p { font-size: 16px; line-height: 1.6; color: #1f2937; margin-bottom: 12px; }
      `),
      html: `
        <h1>Main Title of the Article</h1>
        <p>Introduction paragraph with some important context about the topic at hand.</p>
        <h2>First Section</h2>
        <p>Content for the first section goes here. It contains <strong>important details</strong> and <em>emphasis</em>.</p>
        <h3>Subsection 1.1</h3>
        <p>More detailed content within the subsection explaining finer points of the argument.</p>
        <h2>Second Section</h2>
        <p>The second major section continues the discussion with new perspectives and insights.</p>
        <h3>Subsection 2.1</h3>
        <p>Additional detail and supporting evidence for the second section's claims.</p>
      `,
    },

    {
      name: 'Nested lists',
      width: 600,
      height: 500,
      css: withOpenSans(`
        body { ${font} }
        ul, ol { padding-left: 24px; margin: 8px 0; }
        li { line-height: 1.8; font-size: 15px; }
        li strong { color: #1d4ed8; }
      `),
      html: `
        <ul>
          <li><strong>Frontend</strong>
            <ul>
              <li>React
                <ul>
                  <li>Hooks</li>
                  <li>Context API</li>
                  <li>Server Components</li>
                </ul>
              </li>
              <li>Vue
                <ul>
                  <li>Composition API</li>
                  <li>Pinia</li>
                </ul>
              </li>
            </ul>
          </li>
          <li><strong>Backend</strong>
            <ol>
              <li>Node.js</li>
              <li>Python</li>
              <li>Go</li>
            </ol>
          </li>
          <li><strong>DevOps</strong>
            <ul>
              <li>Docker</li>
              <li>Kubernetes</li>
            </ul>
          </li>
        </ul>
      `,
    },

    {
      name: 'Rich blog post',
      width: 700,
      height: 800,
      css: withOpenSans(`
        .post { ${font} color: #1a1a1a; }
        .post h1 { font-size: 28px; margin-bottom: 4px; }
        .post .meta { font-size: 13px; color: #888; margin-bottom: 16px; }
        .post p { font-size: 16px; line-height: 1.75; margin-bottom: 14px; }
        .post blockquote { border-left: 3px solid #d1d5db; margin: 16px 0; padding: 8px 16px; color: #4b5563; font-style: italic; }
        .post a { color: #2563eb; text-decoration: underline; }
        .post .tag { display: inline-block; background: #eff6ff; color: #1d4ed8; padding: 2px 8px; border-radius: 12px; font-size: 12px; margin-right: 6px; }
      `),
      html: `
        <div class="post">
          <h1>Understanding Modern CSS Layout</h1>
          <div class="meta">Published on March 10, 2026 · 5 min read</div>
          <p>CSS layout has evolved dramatically over the past decade. From the days of <strong>float-based layouts</strong> and <em>clearfix hacks</em>, we now have powerful tools like <a href="#">Flexbox</a> and <a href="#">CSS Grid</a>.</p>
          <blockquote>The best layout technique is the one that solves your specific problem with the least complexity.</blockquote>
          <p>Flexbox excels at <strong>one-dimensional layouts</strong> — think navigation bars, card rows, and form controls. Grid, on the other hand, gives you <strong>two-dimensional control</strong> for complex page layouts.</p>
          <p>Here are some key principles to keep in mind when choosing a layout approach:</p>
          <p>First, consider the <em>content flow</em>. If items flow in a single direction, Flexbox is usually simpler. For magazine-style layouts with both rows and columns, Grid is more natural.</p>
          <p>Second, think about <strong>responsiveness</strong>. Both Flexbox and Grid offer excellent responsive capabilities, but they handle breakpoints differently.</p>
          <div><span class="tag">CSS</span><span class="tag">Layout</span><span class="tag">Frontend</span><span class="tag">Web Development</span></div>
        </div>
      `,
    },

    {
      name: 'Styled table',
      width: 700,
      height: 400,
      css: withOpenSans(`
        body { ${font} }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background: #1e40af; color: white; padding: 10px 12px; text-align: left; }
        td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
        tr:nth-child(even) { background: #f9fafb; }
        tr:hover { background: #eff6ff; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
        .badge-green { background: #dcfce7; color: #166534; }
        .badge-yellow { background: #fef9c3; color: #854d0e; }
        .badge-red { background: #fee2e2; color: #991b1b; }
      `),
      html: `
        <table>
          <thead>
            <tr><th>Name</th><th>Role</th><th>Status</th><th>Performance</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Alice Johnson</strong></td><td>Engineering Lead</td><td><span class="badge badge-green">Active</span></td><td>Excellent</td></tr>
            <tr><td><strong>Bob Smith</strong></td><td>Senior Developer</td><td><span class="badge badge-green">Active</span></td><td>Good</td></tr>
            <tr><td><strong>Carol White</strong></td><td>Designer</td><td><span class="badge badge-yellow">On Leave</span></td><td>Outstanding</td></tr>
            <tr><td><strong>David Brown</strong></td><td>Junior Developer</td><td><span class="badge badge-green">Active</span></td><td>Improving</td></tr>
            <tr><td><strong>Eve Davis</strong></td><td>Product Manager</td><td><span class="badge badge-red">Inactive</span></td><td>N/A</td></tr>
          </tbody>
        </table>
      `,
    },

    {
      name: 'Multi-column layout',
      width: 800,
      height: 500,
      css: withOpenSans(`
        body { ${font} }
        .columns { display: flex; gap: 20px; }
        .col { flex: 1; }
        .col h3 { font-size: 18px; color: #1e40af; border-bottom: 2px solid #bfdbfe; padding-bottom: 6px; margin-bottom: 10px; }
        .col p { font-size: 14px; line-height: 1.6; color: #374151; margin-bottom: 10px; }
        .col ul { padding-left: 18px; font-size: 14px; }
        .col li { margin-bottom: 4px; }
      `),
      html: `
        <div class="columns">
          <div class="col">
            <h3>Features</h3>
            <p>Our platform offers a <strong>comprehensive suite</strong> of tools designed for modern teams.</p>
            <ul>
              <li>Real-time collaboration</li>
              <li>Advanced analytics</li>
              <li>Custom workflows</li>
              <li>API integrations</li>
            </ul>
          </div>
          <div class="col">
            <h3>Pricing</h3>
            <p>Flexible plans that <em>scale with your business</em>. No hidden fees, cancel anytime.</p>
            <ul>
              <li><strong>Starter:</strong> $9/mo</li>
              <li><strong>Pro:</strong> $29/mo</li>
              <li><strong>Enterprise:</strong> Custom</li>
            </ul>
          </div>
          <div class="col">
            <h3>Support</h3>
            <p>Dedicated support team available <strong>24/7</strong> to help you succeed.</p>
            <ul>
              <li>Live chat</li>
              <li>Email support</li>
              <li>Phone support</li>
              <li>Knowledge base</li>
            </ul>
          </div>
        </div>
      `,
    },

    {
      name: 'Text decorations & shadows',
      width: 600,
      height: 450,
      css: withOpenSans(`
        body { ${font} }
        .shadow-text { text-shadow: 2px 2px 4px rgba(0,0,0,0.3); font-size: 24px; margin-bottom: 12px; }
        .outline { -webkit-text-stroke: 1px #1e40af; color: transparent; font-size: 28px; font-weight: 700; }
        .gradient-text { background: linear-gradient(90deg, #dc2626, #2563eb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 22px; font-weight: 700; }
        .gradient-vert { background: linear-gradient(180deg, #16a34a, #9333ea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 18px; line-height: 1.4; }
        .decorated span { display: inline-block; margin: 4px 8px; padding: 4px 8px; }
        .over { text-decoration: overline wavy #dc2626; }
        .under { text-decoration: underline dotted #2563eb; }
        .through { text-decoration: line-through double #16a34a; }
        .combined { text-decoration: underline overline solid #9333ea; }
      `),
      html: `
        <p class="shadow-text">Text with a soft drop shadow</p>
        <p class="outline">Outline-only text via text-stroke</p>
        <p class="gradient-text">Gradient-filled text via background-clip</p>
        <p class="gradient-vert">Vertical gradient that spans multiple lines of text to test top-to-bottom color transition across the full element height.</p>
        <div class="decorated">
          <span class="over">Wavy overline</span>
          <span class="under">Dotted underline</span>
          <span class="through">Double strikethrough</span>
          <span class="combined">Over + under solid</span>
        </div>
      `,
    },

    {
      name: 'Code blocks & quotes',
      width: 700,
      height: 500,
      css: withOpenSans(`
        body { ${font} font-size: 15px; }
        pre { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 14px; line-height: 1.5; overflow-x: auto; }
        pre .keyword { color: #c084fc; }
        pre .string { color: #86efac; }
        pre .comment { color: #64748b; font-style: italic; }
        blockquote { border-left: 4px solid #3b82f6; margin: 16px 0; padding: 12px 20px; background: #eff6ff; font-style: italic; color: #1e40af; }
        blockquote cite { display: block; margin-top: 8px; font-size: 13px; color: #6b7280; font-style: normal; }
      `),
      html: `
        <pre><span class="comment">// A simple greeting function</span>
<span class="keyword">function</span> greet(name: <span class="keyword">string</span>): <span class="keyword">string</span> {
  <span class="keyword">return</span> <span class="string">\`Hello, \${name}!\`</span>;
}

<span class="comment">// Usage</span>
<span class="keyword">const</span> msg = greet(<span class="string">"World"</span>);
console.log(msg);</pre>
        <blockquote>
          Any fool can write code that a computer can understand. Good programmers write code that humans can understand.
          <cite>-- Martin Fowler</cite>
        </blockquote>
        <blockquote>
          First, solve the problem. Then, write the code.
          <cite>-- John Johnson</cite>
        </blockquote>
      `,
    },

    {
      name: 'Dense inline formatting',
      width: 600,
      height: 400,
      css: withOpenSans(`
        .dense { ${font} font-size: 15px; line-height: 1.8; color: #1f2937; }
        .dense .r { color: #dc2626; font-weight: 600; }
        .dense .b { color: #2563eb; font-style: italic; }
        .dense .g { color: #16a34a; text-decoration: underline; }
        .dense .p { color: #9333ea; background: #faf5ff; padding: 0 3px; }
        .dense .o { color: #ea580c; font-variant: small-caps; }
        .dense .mark { background: #fef08a; padding: 0 2px; }
      `),
      html: `
        <div class="dense">
          <p>In <span class="r">software engineering</span>, we often encounter <span class="b">complex trade-offs</span> between <span class="g">performance</span> and <span class="p">maintainability</span>. The <span class="o">Art of Programming</span> lies in finding the <span class="mark">right balance</span> for each specific <span class="r">use case</span>.</p>
          <p>Consider a <span class="b">rendering pipeline</span>: you might optimize the <span class="g">hot path</span> with <span class="p">manual memory management</span> while keeping <span class="o">Configuration Code</span> clean and <span class="mark">readable</span>. This <span class="r">hybrid approach</span> delivers <span class="b">excellent throughput</span> without sacrificing <span class="g">developer experience</span>.</p>
          <p>The <span class="p">key metrics</span> to watch are <span class="r">latency</span> (<span class="mark">p50</span>, <span class="mark">p95</span>, <span class="mark">p99</span>), <span class="b">throughput</span> (ops/sec), and <span class="g">memory footprint</span>. <span class="o">Premature Optimization</span> is the <span class="r">root</span> of all <span class="p">evil</span>, but <span class="mark">informed optimization</span> is the <span class="b">foundation</span> of great <span class="g">software</span>.</p>
        </div>
      `,
    },

    // =========================================================================
    // 1. Long paragraph with word wrapping at various break points
    // =========================================================================
    {
      name: 'Long paragraph word wrapping',
      width: 300,
      height: 400,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.6; }`),
      html: `<p>The unprecedented transformation of the manufacturing industry has fundamentally altered how organizations approach productivity, sustainability, and competitiveness in the global marketplace. Incremental improvements alongside revolutionary breakthroughs continue to reshape expectations.</p>
<p>Electroencephalography measurements demonstrate that concentrated attention spans approximately twenty-three minutes before requiring a brief recuperative intermission.</p>`,
    },

    // =========================================================================
    // 2. Empty paragraphs / blank lines between content
    // =========================================================================
    {
      name: 'Empty paragraphs and blank lines',
      width: 400,
      height: 400,
      css: withOpenSans(
        `body { ${font} font-size: 16px; } p { margin: 0; min-height: 1em; }`,
      ),
      html: `<p>First paragraph of content.</p>
<p><br></p>
<p><br></p>
<p>Third paragraph after two blank lines.</p>
<p>&nbsp;</p>
<p>Another paragraph after a non-breaking space line.</p>
<p><br></p>
<p><br></p>
<p><br></p>
<p>Final paragraph after three blank lines.</p>`,
    },

    // =========================================================================
    // 3. Very long unbroken word (URL) with overflow-wrap: break-word
    // =========================================================================
    {
      name: 'Long unbroken word overflow-wrap',
      width: 250,
      height: 300,
      css: withOpenSans(
        `body { ${font} font-size: 14px; line-height: 1.5; } p { overflow-wrap: break-word; word-break: break-word; }`,
      ),
      html: `<p>Please visit this link:</p>
<p>https://www.example.com/very/long/path/that/should/wrap/across/multiple/lines/in/the/container</p>
<p>And also this one: superlongwordwithoutanybreakpointsthatmustbeforciblybrokenbythelayoutenginetofitinsidethecontainer</p>
<p>Normal text after the long words.</p>`,
    },

    // =========================================================================
    // 4. Single character per line (narrow container)
    // =========================================================================
    {
      name: 'Narrow container single char per line',
      width: 50,
      height: 400,
      css: withOpenSans(
        `body { ${font} font-size: 16px; line-height: 1.4; } p { overflow-wrap: break-word; }`,
      ),
      html: `<p>Hello World</p>
<p>Testing narrow layout</p>`,
    },

    // =========================================================================
    // 5. Mixed font sizes in same paragraph
    // =========================================================================
    {
      name: 'Mixed font sizes inline',
      width: 500,
      height: 250,
      css: withOpenSans(`body { ${font} }`),
      html: `<p><span style="font-size: 10px;">tiny text</span> normal text <span style="font-size: 28px;">BIG text</span> and <span style="font-size: 12px;">small</span> then <span style="font-size: 36px;">HUGE</span> back to <span style="font-size: 14px;">regular size</span> in one paragraph.</p>
<p>Second line with <span style="font-size: 8px;">microscopic</span> and <span style="font-size: 48px;">giant</span> side by side.</p>`,
    },

    // =========================================================================
    // 6. Line-height variations
    // =========================================================================
    {
      name: 'Line-height variations',
      width: 500,
      height: 600,
      css: withOpenSans(`body { ${font} font-size: 15px; }`),
      html: `<p style="line-height: 0.8;">Line-height 0.8: This paragraph has very tight line spacing. When text wraps to the next line, the lines should be very close together, almost overlapping.</p>
<p style="line-height: 1.0;">Line-height 1.0: This paragraph has normal single spacing. Text is compact but readable with minimal space between baselines.</p>
<p style="line-height: 1.2;">Line-height 1.2: Slightly more breathing room. This is a common default for body text in many browsers and frameworks.</p>
<p style="line-height: 1.5;">Line-height 1.5: This is comfortable reading spacing. Most style guides recommend at least 1.5 for body text accessibility.</p>
<p style="line-height: 2.0;">Line-height 2.0: Double-spaced text. This has generous spacing between lines, similar to what you might see in academic papers or draft documents.</p>`,
    },

    // =========================================================================
    // 7. Multiple consecutive spaces and whitespace handling
    // =========================================================================
    {
      name: 'Whitespace handling pre-wrap vs normal',
      width: 500,
      height: 300,
      css: withOpenSans(`body { ${font} font-size: 15px; }`),
      html: `<p style="white-space: normal;">Normal:  multiple   spaces    are     collapsed      here.</p>
<p style="white-space: pre-wrap;">Pre-wrap:  multiple   spaces    are     preserved      here.</p>
<p style="white-space: pre-wrap;">Tabs:	one	two	three	four</p>
<p style="white-space: pre-wrap;">Leading    spaces and    trailing    spaces   </p>
<p style="white-space: normal;">Normal again:     all     these     spaces     collapse.</p>`,
    },

    // =========================================================================
    // 8. Deeply nested inline styles
    // =========================================================================
    {
      name: 'Deeply nested inline styles',
      width: 500,
      height: 200,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.6; }`),
      html: `<p>Start with <span style="color: #dc2626;"><u>underlined <em>italic <strong>bold <span style="background: #fef08a;">highlighted deep nesting</span> still bold</strong> still italic</em> still underlined</u> still red</span> back to normal.</p>
<p><span style="color: #2563eb;"><span style="font-size: 18px;"><strong><em><u><s>All decorations combined at once</s></u></em></strong></span></span> then plain.</p>`,
    },

    // =========================================================================
    // 9. Adjacent differently-styled spans with no space
    // =========================================================================
    {
      name: 'Adjacent styled spans no space',
      width: 500,
      height: 200,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.6; }`),
      html: `<p><span style="color: #dc2626; font-weight: bold;">RED</span><span style="color: #2563eb; font-style: italic;">BLUE</span><span style="color: #16a34a; text-decoration: underline;">GREEN</span><span style="color: #9333ea; background: #faf5ff;">PURPLE</span><span style="color: #ea580c;">ORANGE</span></p>
<p><strong>bold</strong><em>italic</em><u>underline</u><s>strike</s><strong><em>bolditalic</em></strong></p>
<p>Word<span style="color: red;">With</span>No<span style="color: blue;">Spaces</span>Between<span style="color: green;">Spans</span></p>`,
    },

    // =========================================================================
    // 10. Subscript and superscript
    // =========================================================================
    {
      name: 'Subscript and superscript',
      width: 500,
      height: 250,
      css: withOpenSans(
        `body { ${font} font-size: 16px; line-height: 1.8; } sub { font-size: 0.7em; vertical-align: sub; } sup { font-size: 0.7em; vertical-align: super; }`,
      ),
      html: `<p>Water is H<sub>2</sub>O and carbon dioxide is CO<sub>2</sub>.</p>
<p>Einstein's famous equation: E=mc<sup>2</sup></p>
<p>The area of a circle is \u03C0r<sup>2</sup> and volume of a sphere is (4/3)\u03C0r<sup>3</sup>.</p>
<p>Footnote reference<sup>[1]</sup> and another<sup>[2]</sup> in running text.</p>
<p>Chemical formula: Ca(OH)<sub>2</sub> + H<sub>2</sub>SO<sub>4</sub> \u2192 CaSO<sub>4</sub> + 2H<sub>2</sub>O</p>`,
    },

    // =========================================================================
    // 11. Inline elements with mixed font-sizes on the same line
    // =========================================================================
    {
      name: 'Mixed font-sizes same line',
      width: 600,
      height: 200,
      css: withOpenSans(`body { ${font} }`),
      html: `<p><span style="font-size: 12px;">12px</span> next to <span style="font-size: 24px;">24px</span> next to <span style="font-size: 14px;">14px</span> next to <span style="font-size: 32px;">32px</span> next to <span style="font-size: 10px;">10px</span> all on one line.</p>
<p style="line-height: 1.2;"><span style="font-size: 8px;">tiny</span><span style="font-size: 40px;">LARGE</span><span style="font-size: 8px;">tiny</span><span style="font-size: 40px;">LARGE</span></p>`,
    },

    // =========================================================================
    // 12. Strikethrough + underline simultaneously
    // =========================================================================
    {
      name: 'Strikethrough and underline combined',
      width: 500,
      height: 200,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.6; }`),
      html: `<p><span style="text-decoration: underline line-through;">This text has both underline and strikethrough.</span></p>
<p>Normal text then <u><s>underline+strike together</s></u> then normal again.</p>
<p><span style="text-decoration: line-through; color: #dc2626;">Deleted text in red</span> replaced by <span style="text-decoration: underline; color: #16a34a;">new text in green</span>.</p>`,
    },

    // =========================================================================
    // 13. All text decorations: underline, overline, line-through
    // =========================================================================
    {
      name: 'All text decorations combined',
      width: 500,
      height: 250,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 2.0; }`),
      html: `<p><span style="text-decoration: underline;">Underline only</span></p>
<p><span style="text-decoration: overline;">Overline only</span></p>
<p><span style="text-decoration: line-through;">Line-through only</span></p>
<p><span style="text-decoration: underline overline;">Underline + Overline</span></p>
<p><span style="text-decoration: underline overline line-through;">All three: underline + overline + line-through</span></p>
<p><span style="text-decoration: underline wavy #dc2626;">Wavy red underline</span> and <span style="text-decoration: underline dotted #2563eb;">dotted blue underline</span></p>`,
    },

    // =========================================================================
    // 14. Multiple colors in single paragraph (rainbow text)
    // =========================================================================
    {
      name: 'Rainbow colored text',
      width: 500,
      height: 200,
      css: withOpenSans(`body { ${font} font-size: 18px; line-height: 1.6; }`),
      html: `<p><span style="color: #dc2626;">Red </span><span style="color: #ea580c;">Orange </span><span style="color: #ca8a04;">Yellow </span><span style="color: #16a34a;">Green </span><span style="color: #2563eb;">Blue </span><span style="color: #7c3aed;">Indigo </span><span style="color: #9333ea;">Violet </span></p>
<p><span style="color: #dc2626; font-weight: bold;">E</span><span style="color: #ea580c; font-weight: bold;">v</span><span style="color: #ca8a04; font-weight: bold;">e</span><span style="color: #16a34a; font-weight: bold;">r</span><span style="color: #2563eb; font-weight: bold;">y</span> <span style="color: #7c3aed; font-weight: bold;">l</span><span style="color: #9333ea; font-weight: bold;">e</span><span style="color: #dc2626; font-weight: bold;">t</span><span style="color: #ea580c; font-weight: bold;">t</span><span style="color: #ca8a04; font-weight: bold;">e</span><span style="color: #16a34a; font-weight: bold;">r</span> <span style="color: #2563eb; font-weight: bold;">c</span><span style="color: #7c3aed; font-weight: bold;">o</span><span style="color: #9333ea; font-weight: bold;">l</span><span style="color: #dc2626; font-weight: bold;">o</span><span style="color: #ea580c; font-weight: bold;">r</span><span style="color: #ca8a04; font-weight: bold;">e</span><span style="color: #16a34a; font-weight: bold;">d</span></p>`,
    },

    // =========================================================================
    // 15. Pure RTL text (Arabic)
    // =========================================================================
    {
      name: 'Pure RTL Arabic text',
      width: 500,
      height: 300,
      css: `body { font-family: system-ui, sans-serif; font-size: 18px; line-height: 1.8; }`,
      html: `<div dir="rtl">
<p>\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645\u060C \u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064A \u0644\u0627\u062E\u062A\u0628\u0627\u0631 \u0627\u0644\u0639\u0631\u0636 \u0645\u0646 \u0627\u0644\u064A\u0645\u064A\u0646 \u0625\u0644\u0649 \u0627\u0644\u064A\u0633\u0627\u0631.</p>
<p>\u0627\u0644\u062A\u0635\u0645\u064A\u0645 \u0627\u0644\u062C\u0631\u0627\u0641\u064A\u0643\u064A \u0647\u0648 \u0641\u0646 \u0627\u0644\u062A\u0648\u0627\u0635\u0644 \u0627\u0644\u0628\u0635\u0631\u064A \u0648\u062D\u0644 \u0627\u0644\u0645\u0634\u0627\u0643\u0644 \u0628\u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0627\u0644\u0637\u0628\u0627\u0639\u0629 \u0648\u0627\u0644\u062A\u0635\u0648\u064A\u0631 \u0648\u0627\u0644\u0631\u0633\u0645.</p>
<p><strong>\u0646\u0635 \u063A\u0627\u0645\u0642</strong> \u0648 <em>\u0646\u0635 \u0645\u0627\u0626\u0644</em> \u0648 <u>\u0646\u0635 \u0645\u0633\u0637\u0631</u></p>
</div>`,
    },

    // =========================================================================
    // 16. Mixed LTR/RTL in same paragraph
    // =========================================================================
    {
      name: 'Mixed LTR and RTL (English + Arabic)',
      width: 500,
      height: 250,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>This is English text \u0645\u0639 \u0646\u0635 \u0639\u0631\u0628\u064A followed by more English.</p>
<p dir="rtl">\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064A with English words \u0641\u064A \u0627\u0644\u0645\u0646\u062A\u0635\u0641.</p>
<p>The word \u0645\u0631\u062D\u0628\u0627 means hello and \u0634\u0643\u0631\u0627 means thank you.</p>
<p dir="rtl">\u0627\u0644\u0628\u0631\u0645\u062C\u0629 Programming \u0647\u064A \u0641\u0646 Art \u0648\u0639\u0644\u0645 Science</p>`,
    },

    // =========================================================================
    // 17. RTL with numbers
    // =========================================================================
    {
      name: 'RTL with embedded numbers',
      width: 500,
      height: 200,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<div dir="rtl">
<p>\u0641\u064A \u0639\u0627\u0645 2024 \u062A\u0645 \u0625\u0637\u0644\u0627\u0642 \u0627\u0644\u0625\u0635\u062F\u0627\u0631 3.5 \u0645\u0646 \u0627\u0644\u0628\u0631\u0646\u0627\u0645\u062C.</p>
<p>\u0627\u0644\u0633\u0639\u0631: 150.99$ \u0648\u0627\u0644\u0643\u0645\u064A\u0629: 42 \u0642\u0637\u0639\u0629</p>
<p>\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641: +1-555-123-4567</p>
</div>`,
    },

    // =========================================================================
    // 18. Hebrew text with punctuation
    // =========================================================================
    {
      name: 'Hebrew text with punctuation',
      width: 500,
      height: 250,
      css: `body { font-family: system-ui, sans-serif; font-size: 18px; line-height: 1.8; }`,
      html: `<div dir="rtl">
<p>\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD! \u05D6\u05D4\u05D5 \u05D8\u05E7\u05E1\u05D8 \u05D1\u05E2\u05D1\u05E8\u05D9\u05EA.</p>
<p>\u05D4\u05EA\u05DB\u05E0\u05D5\u05EA \u05D4\u05D9\u05D0 \u05D0\u05D5\u05DE\u05E0\u05D5\u05EA \u05E9\u05DC \u05D9\u05E6\u05D9\u05E8\u05EA\u05D9\u05D5\u05EA, \u05D7\u05D3\u05E9\u05E0\u05D5\u05EA, \u05D5\u05E4\u05EA\u05E8\u05D5\u05DF \u05D1\u05E2\u05D9\u05D5\u05EA.</p>
<p><strong>\u05D8\u05E7\u05E1\u05D8 \u05DE\u05D5\u05D3\u05D2\u05E9</strong> \u2013 \u05E2\u05DD \u05E1\u05D9\u05DE\u05E0\u05D9 \u05E4\u05D9\u05E1\u05D5\u05E7 (\u05DB\u05DE\u05D5: \u05E1\u05D5\u05D2\u05E8\u05D9\u05D9\u05DD \u05D5\u05E0\u05E7\u05D5\u05D3\u05D5\u05EA).</p>
</div>`,
    },

    // =========================================================================
    // 19. Japanese text (hiragana, katakana, kanji)
    // =========================================================================
    {
      name: 'Japanese text mixed scripts',
      width: 400,
      height: 300,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>\u6771\u4EAC\u306F\u65E5\u672C\u306E\u9996\u90FD\u3067\u3059\u3002\u4EBA\u53E3\u306F\u7D041400\u4E07\u4EBA\u3067\u3001\u4E16\u754C\u6700\u5927\u306E\u90FD\u5E02\u570F\u306E\u4E00\u3064\u3067\u3059\u3002</p>
<p>\u30D7\u30ED\u30B0\u30E9\u30DF\u30F3\u30B0\u8A00\u8A9E\u306B\u306F\u3001JavaScript\u3001Python\u3001TypeScript\u306A\u3069\u304C\u3042\u308A\u307E\u3059\u3002</p>
<p>\u3072\u3089\u304C\u306A\u3068\u30AB\u30BF\u30AB\u30CA\u3068\u6F22\u5B57\u3092\u6DF7\u305C\u305F\u6587\u7AE0\u3067\u3059\u3002</p>`,
    },

    // =========================================================================
    // 20. Chinese text (Simplified)
    // =========================================================================
    {
      name: 'Simplified Chinese text',
      width: 400,
      height: 250,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>\u4EBA\u5DE5\u667A\u80FD\u6B63\u5728\u6539\u53D8\u6211\u4EEC\u7684\u4E16\u754C\u3002\u4ECE\u81EA\u7136\u8BED\u8A00\u5904\u7406\u5230\u8BA1\u7B97\u673A\u89C6\u89C9\uFF0C\u673A\u5668\u5B66\u4E60\u7684\u5E94\u7528\u65E0\u5904\u4E0D\u5728\u3002</p>
<p>\u8F6F\u4EF6\u5F00\u53D1\u662F\u4E00\u95E8\u827A\u672F\uFF0C\u4E5F\u662F\u4E00\u95E8\u79D1\u5B66\u3002<strong>\u4F18\u79C0\u7684\u4EE3\u7801</strong>\u5E94\u8BE5\u662F<em>\u6E05\u6670\u3001\u7B80\u6D01\u3001\u53EF\u7EF4\u62A4\u7684</em>\u3002</p>
<p>\u6D4B\u8BD5\u7528\u4F8B\uFF1A\u786E\u4FDD\u4E2D\u6587\u5B57\u7B26\u80FD\u591F\u6B63\u786E\u6362\u884C\u548C\u6E32\u67D3\u3002</p>`,
    },

    // =========================================================================
    // 21. Korean text (Hangul)
    // =========================================================================
    {
      name: 'Korean Hangul text',
      width: 400,
      height: 250,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>\uC548\uB155\uD558\uC138\uC694! \uD55C\uAD6D\uC5B4 \uD14D\uC2A4\uD2B8 \uB80C\uB354\uB9C1 \uD14C\uC2A4\uD2B8\uC785\uB2C8\uB2E4.</p>
<p>\uC18C\uD504\uD2B8\uC6E8\uC5B4 \uAC1C\uBC1C\uC740 \uCC3D\uC758\uC801\uC778 \uBB38\uC81C \uD574\uACB0 \uACFC\uC815\uC785\uB2C8\uB2E4. <strong>\uD488\uC9C8</strong>\uACFC <em>\uD6A8\uC728\uC131</em>\uC744 \uB3D9\uC2DC\uC5D0 \uCD94\uAD6C\uD574\uC57C \uD569\uB2C8\uB2E4.</p>
<p>\uD55C\uAE00\uC740 \uC138\uC885\uB300\uC655\uC774 \uCC3D\uC81C\uD55C \uBB38\uC790 \uCCB4\uACC4\uB85C, \uACFC\uD559\uC801\uC774\uACE0 \uCCB4\uACC4\uC801\uC778 \uAD6C\uC870\uB97C \uAC00\uC9C0\uACE0 \uC788\uC2B5\uB2C8\uB2E4.</p>`,
    },

    // =========================================================================
    // 22. Mixed CJK + Latin
    // =========================================================================
    {
      name: 'Mixed CJK and Latin text',
      width: 450,
      height: 250,
      css: `body { font-family: system-ui, sans-serif; font-size: 15px; line-height: 1.8; }`,
      html: `<p>\u4ECA\u65E5\u306EWeb\u958B\u767A\u3067\u306FReact\u3084Vue.js\u306A\u3069\u306Eframework\u304C\u4E3B\u6D41\u3067\u3059\u3002</p>
<p>\u6211\u4EEC\u4F7F\u7528TypeScript\u8FDB\u884C\u5F00\u53D1\uFF0C\u5B83\u63D0\u4F9B\u4E86\u66F4\u597D\u7684type safety\u3002</p>
<p>HTML\uACFC CSS\uB294 \uC6F9 \uD398\uC774\uC9C0\uC758 \uAE30\uBCF8\uC785\uB2C8\uB2E4. JavaScript\uB85C \uC0C1\uD638\uC791\uC6A9\uC744 \uCD94\uAC00\uD569\uB2C8\uB2E4.</p>`,
    },

    // =========================================================================
    // 23. Thai text (no word boundaries)
    // =========================================================================
    {
      name: 'Thai text no word boundaries',
      width: 400,
      height: 200,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35\u0E04\u0E23\u0E31\u0E1A \u0E19\u0E35\u0E48\u0E04\u0E37\u0E2D\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A\u0E01\u0E32\u0E23\u0E41\u0E2A\u0E14\u0E07\u0E1C\u0E25\u0E1A\u0E19\u0E41\u0E04\u0E19\u0E27\u0E32\u0E2A</p>
<p>\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22\u0E44\u0E21\u0E48\u0E21\u0E35\u0E0A\u0E48\u0E2D\u0E07\u0E27\u0E48\u0E32\u0E07\u0E23\u0E30\u0E2B\u0E27\u0E48\u0E32\u0E07\u0E04\u0E33 \u0E17\u0E33\u0E43\u0E2B\u0E49\u0E01\u0E32\u0E23\u0E15\u0E31\u0E14\u0E04\u0E33\u0E40\u0E1B\u0E47\u0E19\u0E40\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E17\u0E49\u0E32\u0E17\u0E32\u0E22</p>`,
    },

    // =========================================================================
    // 24. Emoji text with ZWJ sequences
    // =========================================================================
    {
      name: 'Emoji and ZWJ sequences',
      width: 500,
      height: 300,
      css: `body { font-family: system-ui, sans-serif; font-size: 16px; line-height: 2.0; }`,
      html: `<p>Simple emoji.</p>
<p>Simple emoji: \u{1F600} \u{1F389} \u{2764}\uFE0F \u{1F680} \u{2B50} \u{1F525} \u{1F4A1} \u{1F3AF}</p>
<p>Skin tones: \u{1F44B}\u{1F3FB} \u{1F44B}\u{1F3FC} \u{1F44B}\u{1F3FD} \u{1F44B}\u{1F3FE} \u{1F44B}\u{1F3FF}</p>
<p>ZWJ family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}</p>
<p>Flag: \u{1F3F3}\uFE0F\u200D\u{1F308}</p>
<p>Mixed: Hello \u{1F44B} World \u{1F30D} from \u{1F1FA}\u{1F1F8}</p>
<p>Emoji in <strong>\u{1F525} bold</strong> and <em>\u{1F4A1} italic</em> and <span style="color: #dc2626;">\u{2764}\uFE0F red</span></p>`,
    },

    // =========================================================================
    // 25. pre-wrap with intentional multiple spaces and tabs
    // =========================================================================
    {
      name: 'Pre-wrap preserved whitespace',
      width: 500,
      height: 300,
      css: withOpenSans(
        `body { ${font} font-size: 14px; line-height: 1.6; white-space: pre-wrap; }`,
      ),
      html: `<p>Column1     Column2     Column3     Column4</p>
<p>Data A      Data B      Data C      Data D</p>
<p>Short       Longer      X           Done</p>
<p></p>
<p>  Indented with 2 spaces</p>
<p>    Indented with 4 spaces</p>
<p>        Indented with 8 spaces</p>
<p>	Tab indented (one tab)</p>
<p>		Double tab indented</p>`,
    },

    // =========================================================================
    // 26. Soft hyphens and zero-width spaces
    // =========================================================================
    {
      name: 'Soft hyphens and zero-width spaces',
      width: 200,
      height: 300,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.5; }`),
      html: `<p>Sup\u00ADer\u00ADcal\u00ADi\u00ADfrag\u00ADil\u00ADis\u00ADtic\u00ADex\u00ADpi\u00ADal\u00ADi\u00ADdo\u00ADcious</p>
<p>Anti\u00ADdis\u00ADes\u00ADtab\u00ADlish\u00ADment\u00ADar\u00ADi\u00ADan\u00ADism</p>
<p>Zero\u200Bwidth\u200Bspace\u200Ballows\u200Bbreaking\u200Bhere</p>
<p>Long\u200Bcompound\u200Bword\u200Bwith\u200Bzero\u200Bwidth\u200Bspaces</p>`,
    },

    // =========================================================================
    // 27. Non-breaking spaces mixed with regular spaces
    // =========================================================================
    {
      name: 'Non-breaking spaces vs regular spaces',
      width: 300,
      height: 250,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.6; }`),
      html: `<p>100&nbsp;km should not break between number and unit.</p>
<p>Mr.&nbsp;Smith and Dr.&nbsp;Jones met on Jan.&nbsp;5th.</p>
<p>Price: $1,000&nbsp;USD per&nbsp;unit.</p>
<p>Regular spaces allow breaks everywhere in this sentence.</p>`,
    },

    // =========================================================================
    // 28. Text with <br> tags (explicit line breaks)
    // =========================================================================
    {
      name: 'Explicit br line breaks',
      width: 400,
      height: 300,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.6; }`),
      html: `<p>First line<br>Second line<br>Third line</p>
<p>Address:<br>123 Main Street<br>Apartment 4B<br>New York, NY 10001<br>United States</p>
<p>Haiku:<br>An old silent pond<br>A frog jumps into the pond<br>Splash! Silence again.</p>`,
    },

    // =========================================================================
    // 29. Very long list item text that wraps
    // =========================================================================
    {
      name: 'Long wrapping list items',
      width: 400,
      height: 400,
      css: withOpenSans(
        `body { ${font} font-size: 14px; } ul { padding-left: 24px; } li { line-height: 1.6; margin-bottom: 8px; }`,
      ),
      html: `<ul>
<li>This is a very long list item that contains enough text to wrap onto multiple lines within the list. The bullet point should align with the first line while subsequent lines are indented properly.</li>
<li>Short item.</li>
<li>Another lengthy list item that discusses the importance of testing word wrap behavior in list contexts, because many rich text editors produce lists with varying content lengths and the rendering must handle them gracefully.</li>
<li>Final item with <strong>bold</strong>, <em>italic</em>, and <span style="color: #dc2626;">colored</span> text inside a list.</li>
</ul>`,
    },

    // =========================================================================
    // 30. Deeply nested lists (4+ levels) with mixed ul/ol
    // =========================================================================
    {
      name: 'Deeply nested mixed lists',
      width: 500,
      height: 500,
      css: withOpenSans(
        `body { ${font} font-size: 14px; } ul, ol { padding-left: 24px; margin: 4px 0; } li { line-height: 1.6; }`,
      ),
      html: `<ol>
<li>First level ordered
  <ul>
    <li>Second level unordered
      <ol>
        <li>Third level ordered
          <ul>
            <li>Fourth level unordered</li>
            <li>Another fourth level</li>
          </ul>
        </li>
        <li>Another third level</li>
      </ol>
    </li>
    <li>Another second level</li>
  </ul>
</li>
<li>Back to first level
  <ol>
    <li>Nested ordered
      <ul>
        <li>Mixed nesting
          <ol>
            <li>Deep ordered item</li>
            <li>Another deep item</li>
          </ol>
        </li>
      </ul>
    </li>
  </ol>
</li>
<li>Final first level item</li>
</ol>`,
    },

    // =========================================================================
    // 31. List items with rich formatting
    // =========================================================================
    {
      name: 'List items with rich formatting',
      width: 450,
      height: 350,
      css: withOpenSans(
        `body { ${font} font-size: 15px; } ul, ol { padding-left: 24px; margin: 6px 0; } li { line-height: 1.7; }`,
      ),
      html: `<ul>
<li><strong style="color: #dc2626;">Important:</strong> Review the <em>quarterly report</em> before Friday.</li>
<li><span style="color: #16a34a; font-weight: bold;">Done:</span> <s>Update the deployment scripts</s></li>
<li><span style="color: #2563eb;">In Progress:</span> Refactor the <code style="background: #f3f4f6; padding: 1px 4px;">UserService</code> module</li>
<li><u>Underlined item</u> with <span style="background: #fef08a;">highlighted text</span></li>
</ul>
<ol>
<li><strong>Step one</strong> \u2014 <em>prepare the environment</em></li>
<li><strong>Step two</strong> \u2014 <span style="color: #7c3aed;">run the migration</span></li>
<li><strong>Step three</strong> \u2014 <span style="color: #16a34a;">verify the results</span></li>
</ol>`,
    },

    // =========================================================================
    // 32. Empty list items mixed with content
    // =========================================================================
    {
      name: 'Empty list items mixed with content',
      width: 400,
      height: 300,
      css: withOpenSans(
        `body { ${font} font-size: 15px; } ul { padding-left: 24px; } li { line-height: 1.6; min-height: 1em; }`,
      ),
      html: `<ul>
<li>First item with content</li>
<li><br></li>
<li>Third item after empty</li>
<li>&nbsp;</li>
<li><br></li>
<li>Sixth item after two empties</li>
<li>Seventh item</li>
<li><br></li>
</ul>`,
    },

    // =========================================================================
    // 33. text-align: center
    // =========================================================================
    {
      name: 'Center aligned text',
      width: 500,
      height: 250,
      css: withOpenSans(
        `body { ${font} font-size: 16px; line-height: 1.6; text-align: center; }`,
      ),
      html: `<h2 style="text-align: center; font-size: 24px;">Centered Heading</h2>
<p style="text-align: center;">This paragraph is centered. Every line of wrapping text should be centered within the container width.</p>
<p style="text-align: center;">Short centered line.</p>
<p style="text-align: center;">A much longer centered paragraph that will definitely wrap to multiple lines to verify that each wrapped line is independently centered within the available width of the container.</p>`,
    },

    // =========================================================================
    // 34. text-align: right
    // =========================================================================
    {
      name: 'Right aligned text',
      width: 500,
      height: 250,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.6; }`),
      html: `<h2 style="text-align: right; font-size: 24px;">Right-Aligned Heading</h2>
<p style="text-align: right;">This paragraph is right-aligned. Each line should flush against the right edge of the container.</p>
<p style="text-align: right;">Short right line.</p>
<p style="text-align: right;">A longer right-aligned paragraph that wraps to multiple lines, testing whether each wrapped line correctly aligns to the right margin.</p>`,
    },

    // =========================================================================
    // 35. text-align: justify
    // =========================================================================
    {
      name: 'Justified text',
      width: 500,
      height: 300,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.6; }`),
      html: `<p style="text-align: justify;">This paragraph uses full justification. The spaces between words should be adjusted so that both the left and right edges of the text align perfectly with the container margins. This creates a clean, newspaper-like appearance that is common in printed materials and formal documents.</p>
<p style="text-align: justify;">Another justified paragraph with varying word lengths: a the internationally recognized telecommunications infrastructure standardization committee recommended implementing comprehensive interoperability testing protocols.</p>`,
    },

    // =========================================================================
    // 36. Mixed alignment paragraphs
    // =========================================================================
    {
      name: 'Mixed alignment paragraphs',
      width: 500,
      height: 350,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.6; }`),
      html: `<p style="text-align: left;">This paragraph is left-aligned (the default). Text flows naturally from left to right.</p>
<p style="text-align: center;">This paragraph is centered. It should sit in the middle of the container.</p>
<p style="text-align: right;">This paragraph is right-aligned. It hugs the right edge.</p>
<p style="text-align: justify;">This paragraph is justified. Words are spaced so both edges are flush with the container margins, creating even blocks of text.</p>
<p style="text-align: left;">Back to left-aligned text to close out the section.</p>`,
    },

    // =========================================================================
    // 37. Font stack fallback test
    // =========================================================================
    {
      name: 'Font stack fallback',
      width: 500,
      height: 250,
      css: withOpenSans(`body { font-size: 15px; line-height: 1.6; }`),
      html: `<p style="font-family: 'NonExistentFont', 'AlsoNotReal', 'Open Sans', sans-serif;">This text should fall back through missing fonts to Open Sans.</p>
<p style="font-family: 'Open Sans', Georgia, serif;">Open Sans with Georgia as fallback.</p>
<p style="font-family: monospace;">Pure monospace fallback text for comparison.</p>
<p style="font-family: serif;">Pure serif fallback text.</p>
<p style="font-family: sans-serif;">Pure sans-serif fallback text.</p>`,
    },

    // =========================================================================
    // 38. Monospace vs proportional text
    // =========================================================================
    {
      name: 'Monospace vs proportional text',
      width: 600,
      height: 300,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.6; }`),
      html: `<p style="font-family: 'Open Sans', sans-serif;">Proportional: The quick brown fox jumps over the lazy dog. iiiiiWWWWW</p>
<p style="font-family: 'Courier New', Courier, monospace;">Monospace:     The quick brown fox jumps over the lazy dog. iiiiiWWWWW</p>
<p>Mixed: <span style="font-family: 'Open Sans', sans-serif;">proportional text</span> then <span style="font-family: 'Courier New', monospace;">monospace code</span> then <span style="font-family: 'Open Sans', sans-serif;">back to proportional</span>.</p>
<p style="font-family: 'Courier New', monospace;">if (x === true) { return "hello"; }</p>`,
    },

    // =========================================================================
    // 39. Very small text (8px) and very large text (48px)
    // =========================================================================
    {
      name: 'Extreme font sizes 8px and 48px',
      width: 600,
      height: 350,
      css: withOpenSans(`body { ${font} }`),
      html: `<p style="font-size: 8px; line-height: 1.4;">This is 8px text. It is very small and tests the lower bound of readable font sizes. Can you still read this tiny text on the canvas?</p>
<p style="font-size: 48px; line-height: 1.2; font-weight: bold;">Large 48px</p>
<p style="font-size: 48px; line-height: 1.2;">This is 48px text that will wrap.</p>
<p style="font-size: 8px;">Tiny again at 8px after the large text.</p>`,
    },

    // =========================================================================
    // 40. Bold weights: 100 through 900
    // =========================================================================
    {
      name: 'Font weight variations 100-900',
      width: 500,
      height: 400,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.8; }`),
      html: `<p style="font-weight: 100;">Weight 100 (Thin): The quick brown fox</p>
<p style="font-weight: 200;">Weight 200 (Extra Light): The quick brown fox</p>
<p style="font-weight: 300;">Weight 300 (Light): The quick brown fox</p>
<p style="font-weight: 400;">Weight 400 (Regular): The quick brown fox</p>
<p style="font-weight: 500;">Weight 500 (Medium): The quick brown fox</p>
<p style="font-weight: 600;">Weight 600 (Semi Bold): The quick brown fox</p>
<p style="font-weight: 700;">Weight 700 (Bold): The quick brown fox</p>
<p style="font-weight: 800;">Weight 800 (Extra Bold): The quick brown fox</p>
<p style="font-weight: 900;">Weight 900 (Black): The quick brown fox</p>`,
    },

    // =========================================================================
    // 41. Zero-width container
    // =========================================================================
    {
      name: 'Very narrow container',
      width: 10,
      height: 200,
      css: withOpenSans(`body { ${font} font-size: 14px; }`),
      html: `<p>Text in a zero-width container.</p>`,
    },

    // =========================================================================
    // 42. Overflow: nowrap text wider than container
    // =========================================================================
    {
      name: 'Nowrap overflow text',
      width: 200,
      height: 150,
      css: withOpenSans(
        `body { ${font} font-size: 15px; } p { white-space: nowrap; }`,
      ),
      html: `<p>This is a long line of text that should not wrap and will overflow the container boundary.</p>
<p>Another non-wrapping line that extends way beyond the available width.</p>`,
    },

    // =========================================================================
    // 43. Special HTML entities
    // =========================================================================
    {
      name: 'Special HTML entities',
      width: 500,
      height: 250,
      css: withOpenSans(`body { ${font} font-size: 15px; line-height: 1.8; }`),
      html: `<p>Ampersand: &amp; | Less than: &lt; | Greater than: &gt;</p>
<p>Quote: &quot;Hello World&quot; | Apostrophe: it&apos;s</p>
<p>Copyright: &copy; 2026 | Registered: &reg; | Trademark: &trade;</p>
<p>En dash: &ndash; | Em dash: &mdash; | Ellipsis: &hellip;</p>
<p>Non-breaking space:&nbsp;|&nbsp;between&nbsp;pipes</p>
<p>Math: 5 &times; 3 = 15 | 10 &divide; 2 = 5 | &plusmn;0.5</p>
<p>Arrows: &larr; &uarr; &rarr; &darr; | Bullet: &bull;</p>`,
    },

    // =========================================================================
    // 44. Extremely long document (20+ paragraphs)
    // =========================================================================
    {
      name: 'Long document 20+ paragraphs',
      width: 500,
      height: 2000,
      css: withOpenSans(
        `body { ${font} font-size: 14px; line-height: 1.6; } h2 { font-size: 20px; margin: 16px 0 8px; } p { margin-bottom: 10px; }`,
      ),
      html: `<h2>Chapter 1: Introduction</h2>
<p>The field of computer science has undergone remarkable transformation since its inception in the mid-twentieth century.</p>
<p>What began as a discipline focused on mathematical computation has evolved into a vast ecosystem of specializations.</p>
<p>Today, software engineers build systems that serve billions of users across the globe.</p>
<h2>Chapter 2: Foundations</h2>
<p>Every software system rests upon fundamental concepts: data structures, algorithms, and design patterns.</p>
<p>Understanding these foundations is essential for building robust and scalable applications.</p>
<p>Binary trees, hash maps, and graphs form the backbone of efficient data processing.</p>
<p>Sorting algorithms like quicksort and mergesort demonstrate the importance of algorithmic thinking.</p>
<h2>Chapter 3: Modern Practices</h2>
<p>Agile methodologies have transformed how teams collaborate and deliver software.</p>
<p>Continuous integration and deployment pipelines ensure rapid and reliable releases.</p>
<p>Test-driven development encourages writing tests before implementation code.</p>
<p>Code reviews and pair programming improve code quality and knowledge sharing.</p>
<h2>Chapter 4: Architecture</h2>
<p>Microservices architecture decomposes applications into small, independently deployable services.</p>
<p>Event-driven systems enable loose coupling and asynchronous communication between components.</p>
<p>The choice between monolithic and distributed architectures depends on team size and requirements.</p>
<h2>Chapter 5: Performance</h2>
<p>Performance optimization begins with measurement. Profile before you optimize.</p>
<p>Caching strategies reduce latency and database load in high-traffic systems.</p>
<p>Memory management and garbage collection tuning can significantly impact application responsiveness.</p>
<h2>Chapter 6: Conclusion</h2>
<p>The landscape of software development continues to evolve at a rapid pace.</p>
<p>Staying current requires continuous learning and adaptation to new technologies.</p>
<p>The fundamentals, however, remain constant: clarity, simplicity, and correctness.</p>
<p>Build systems that are maintainable, testable, and resilient to change.</p>`,
    },

    // =========================================================================
    // 45. Single word paragraph
    // =========================================================================
    {
      name: 'Single word paragraphs',
      width: 300,
      height: 200,
      css: withOpenSans(`body { ${font} font-size: 16px; line-height: 1.6; }`),
      html: `<p>Hello</p>
<p>World</p>
<p>Testing</p>
<p>Single</p>
<p>Words</p>`,
    },

    // =========================================================================
    // 46. Paragraph with only spaces/whitespace
    // =========================================================================
    {
      name: 'Whitespace-only paragraphs',
      width: 400,
      height: 300,
      css: withOpenSans(
        `body { ${font} font-size: 16px; } p { margin: 0; min-height: 1em; }`,
      ),
      html: `<p>Visible paragraph before.</p>
<p>   </p>
<p>&nbsp;&nbsp;&nbsp;</p>
<p> </p>
<p>Visible paragraph after spaces.</p>
<p style="white-space: pre-wrap;">   </p>
<p>Visible paragraph after pre-wrap spaces.</p>`,
    },

    // =========================================================================
    // 47. Nested divs with margins creating spacing patterns
    // =========================================================================
    {
      name: 'Nested divs with margins',
      width: 500,
      height: 500,
      css: withOpenSans(`
        body { ${font} font-size: 14px; }
        .outer { margin: 16px; padding: 12px; }
        .middle { margin: 12px 0; padding: 8px; }
        .inner { margin: 8px 0; padding: 4px; }
        p { margin: 6px 0; line-height: 1.5; }
      `),
      html: `<div class="outer">
  <p>Outer level paragraph with 16px margin container.</p>
  <div class="middle">
    <p>Middle level paragraph with 12px margin container.</p>
    <div class="inner">
      <p>Inner level paragraph with 8px margin container.</p>
      <p>Second inner paragraph to test margin collapsing.</p>
    </div>
    <p>Back to middle level after inner div.</p>
  </div>
  <div class="middle">
    <p>Second middle div.</p>
    <div class="inner">
      <p>Deep nested content again.</p>
    </div>
  </div>
  <p>Final outer paragraph.</p>
</div>`,
    },
    // =========================================================================
    // 48. Mixed Google Fonts on same line — baseline alignment stress test
    // =========================================================================
    {
      name: 'Mixed Google Fonts inline',
      width: 600,
      height: 300,
      css: withMultiFont(`body { font-size: 16px; line-height: 1.6; }`),
      html: `<p><span style="font-family:'Roboto',sans-serif">Roboto</span> then <span style="font-family:'Playfair Display',serif">Playfair</span> then <span style="font-family:'Inconsolata',monospace">Inconsolata</span> then <span style="font-family:'Merriweather',serif">Merriweather</span>.</p>
<p><span style="font-family:'Lobster',cursive;font-size:20px">Lobster Big</span> next to <span style="font-family:'Roboto',sans-serif;font-size:12px">small Roboto</span> next to <span style="font-family:'Playfair Display',serif;font-size:18px">medium Playfair</span></p>
<p style="font-family:'Roboto',sans-serif">Roboto paragraph with <span style="font-family:'Inconsolata',monospace;background:#f3f4f6;padding:1px 4px">code in Inconsolata</span> inline.</p>`,
    },

    // 49. Dense mixed inline styles — wrapping regression test
    // Triggers marginal overflow with mixed fonts/sizes/backgrounds at narrow width.
    // Previously "green" was placed on a line that overflowed by 3.6px.
    // =========================================================================
    {
      name: 'Dense mixed inline styles',
      width: 411,
      height: 400,
      css: withMultiFont(`body { font-family: 'Roboto', sans-serif; font-size: 14px; line-height: 1.7; }`),
      html: `<p><strong>Bold</strong> and <em>italic</em> and <strong><em>both</em></strong>. <span style="color: #da1e28;">Red text</span>, <span style="color: #0f62fe;">blue text</span>, <span style="background: #ffeaa7; padding: 1px 4px;">yellow highlight</span>, <span style="background: #d4efdf; padding: 1px 4px;">green highlight</span>. <u>Underlined</u>, <s>strikethrough</s>, wavy underline, dotted underline. Sizes: 10px tiny, 18px, <span style="font-size: 24px; font-weight: 700; color: #1a1a2e;">24px bold</span>. Fonts: Merriweather italic, <span style="font-family: 'Lobster', cursive; font-size: 18px; color: #6a0dad;">Lobster</span>, light 300, black 900.</p>`,
    },

    // =========================================================================
    // Tier 1 — Missing languages (from pretext corpus analysis)
    // =========================================================================

    // 50. Hindi/Devanagari text — complex conjuncts, ligatures, danda punctuation
    {
      name: 'Hindi Devanagari text',
      width: 400,
      height: 300,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<p>\u0915\u0943\u092A\u092F\u093E \u092C\u0924\u093E\u0913! \u092F\u0939 \u0968\u096A\u00D7\u096D \u0938\u092A\u094B\u0930\u094D\u091F \u0939\u0948\u0964</p>
<p><strong>\u0928\u092E\u0938\u094D\u0924\u0947\u0964 \u0926\u0941\u0928\u093F\u092F\u093E\u0965</strong> \u092F\u0939 \u090F\u0915 <em>\u092A\u0930\u0940\u0915\u094D\u0937\u093E</em> \u0939\u0948 \u0915\u093F \u0939\u093F\u0902\u0926\u0940 \u092A\u093E\u0920 \u0915\u0948\u0928\u0935\u0938 \u092A\u0930 \u0938\u0939\u0940 \u0922\u0902\u0917 \u0938\u0947 \u092A\u094D\u0930\u0926\u0930\u094D\u0936\u093F\u0924 \u0939\u094B\u0924\u093E \u0939\u0948\u0964</p>
<p>\u0939\u093F\u0902\u0926\u0940 <span style="color: #dc2626;">\u0932\u093E\u0932</span> \u0914\u0930 <u>\u0928\u0940\u0932\u093E</u> \u0930\u0902\u0917 \u092E\u0947\u0902\u0964</p>`,
    },

    // 51. Myanmar/Burmese text — complex medial consonants, unique punctuation
    {
      name: 'Myanmar Burmese text',
      width: 400,
      height: 250,
      css: `body { font-family: 'Myanmar MN', 'Noto Sans Myanmar', sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>\u1016\u103C\u1005\u103A\u101E\u100A\u103A\u104B \u1014\u1031\u102C\u1000\u103A\u1010\u1005\u103A\u1001\u102F\u104A \u1000\u102D\u102F\u1000\u103A\u1001\u103B\u102E\u104D \u101A\u102F\u1036\u1000\u103C\u100A\u103A\u1019\u102D\u1000\u103C\u101C\u103D</p>
<p><strong>\u1019\u103C\u1014\u103A\u1019\u102C\u1005\u102C</strong> \u1000\u102D\u102F <em>\u1005\u1019\u103A\u1038\u101E\u1015\u103A</em> \u101B\u1014\u103A\u104B</p>`,
    },

    // 52. Khmer text — no word boundaries, complex vowel placement
    {
      name: 'Khmer text',
      width: 400,
      height: 250,
      css: `body { font-family: 'Khmer Sangam MN', 'Noto Sans Khmer', sans-serif; font-size: 16px; line-height: 1.8; }`,
      html: `<p>\u1793\u17C1\u17C7\u1782\u17BA\u1787\u17B6\u17A2\u1780\u17D2\u179F\u179A\u1797\u17B6\u179F\u17B6\u1781\u17D2\u1798\u17C2\u179A \u179F\u1798\u17D2\u179A\u17B6\u1794\u17CB\u1796\u17B7\u1793\u17B7\u178F\u17D2\u1799\u1780\u17B6\u179A\u179F\u17D2\u179A\u17B6\u179C\u1787\u17D2\u179A\u17B6\u179C\u17A2\u1780\u17D2\u179F\u179A\u1793\u17C5\u179B\u17BE\u1781\u17D2org\u17B6\u179F\u17CB\u17D4</p>
<p><strong>\u179F\u17BD\u179F\u17D2\u178F\u17B8</strong> \u1793\u17B7\u1784 <em>\u179F\u17C6\u178E\u17B6\u1784</em>\u17D4</p>`,
    },

    // 53. Urdu text (RTL Nastaliq) — different from Arabic, vertical stacking
    {
      name: 'Urdu Nastaliq text',
      width: 450,
      height: 250,
      css: `body { font-family: 'Noto Nastaliq Urdu', 'Geeza Pro', sans-serif; font-size: 18px; line-height: 2.0; }`,
      html: `<div dir="rtl">
<p>\u0627\u0631\u062F\u0648 \u0632\u0628\u0627\u0646 \u0645\u06CC\u06BA \u062E\u0648\u0634 \u0622\u0645\u062F\u06CC\u062F\u06D4 <strong>\u06CC\u06C1 \u0627\u06CC\u06A9 \u0679\u06CC\u0633\u0679</strong> \u06C1\u06D2 \u062C\u0648 \u06A9\u06CC\u0646\u0648\u0633 \u067E\u0631 \u0627\u0631\u062F\u0648 \u06A9\u06CC \u0631\u06CC\u0646\u0688\u0631\u0646\u06AF \u06A9\u06CC \u062C\u0627\u0646\u0686 \u06A9\u0631\u062A\u0627 \u06C1\u06D2\u06D4</p>
<p>\u0631\u0646\u06AF: <span style="color: #dc2626;">\u0633\u0631\u062E</span> \u0627\u0648\u0631 <span style="color: #0f62fe;">\u0646\u06CC\u0644\u0627</span>\u06D4</p>
</div>`,
    },

    // =========================================================================
    // Tier 2 — Script × feature combinations
    // =========================================================================

    // 54. RTL lists (Arabic) — list markers + RTL text
    {
      name: 'Arabic RTL lists',
      width: 400,
      height: 400,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<div dir="rtl">
<h3>\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0645\u0647\u0627\u0645</h3>
<ul>
  <li>\u0625\u0639\u062F\u0627\u062F <strong>\u0627\u0644\u062A\u0642\u0631\u064A\u0631</strong> \u0627\u0644\u0633\u0646\u0648\u064A</li>
  <li>\u0645\u0631\u0627\u062C\u0639\u0629 \u0627\u0644\u0645\u064A\u0632\u0627\u0646\u064A\u0629 \u0627\u0644\u0639\u0627\u0645\u0629 \u0644\u0644\u0645\u0634\u0631\u0648\u0639 \u0648\u062A\u062D\u062F\u064A\u062B \u0627\u0644\u0623\u0631\u0642\u0627\u0645</li>
  <li>\u062A\u0646\u0633\u064A\u0642 \u0645\u0639 \u0641\u0631\u064A\u0642 <em>\u0627\u0644\u062A\u0637\u0648\u064A\u0631</em></li>
</ul>
<ol>
  <li>\u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u0623\u0648\u0644\u0649: \u0627\u0644\u062A\u062E\u0637\u064A\u0637</li>
  <li>\u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u062B\u0627\u0646\u064A\u0629: \u0627\u0644\u062A\u0646\u0641\u064A\u0630</li>
  <li>\u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u062B\u0627\u0644\u062B\u0629: \u0627\u0644\u0645\u0631\u0627\u062C\u0639\u0629</li>
</ol>
</div>`,
    },

    // 55. RTL lists (Hebrew)
    {
      name: 'Hebrew RTL lists',
      width: 400,
      height: 350,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<div dir="rtl">
<h3>\u05E8\u05E9\u05D9\u05DE\u05EA \u05DE\u05E9\u05D9\u05DE\u05D5\u05EA</h3>
<ul>
  <li><strong>\u05D4\u05DB\u05E0\u05EA</strong> \u05D4\u05EA\u05D5\u05DB\u05E0\u05D4 \u05D4\u05D7\u05D3\u05E9\u05D4</li>
  <li>\u05D1\u05D3\u05D9\u05E7\u05EA <em>\u05D0\u05D9\u05DB\u05D5\u05EA</em> \u05D4\u05DE\u05E2\u05E8\u05DB\u05EA</li>
  <li>\u05E2\u05D3\u05DB\u05D5\u05DF \u05D4\u05EA\u05D9\u05E2\u05D5\u05D3 \u05D5\u05D4\u05DE\u05E1\u05DE\u05DB\u05D9\u05DD</li>
</ul>
<ol>
  <li>\u05E9\u05DC\u05D1 \u05D0: \u05EA\u05DB\u05E0\u05D5\u05DF</li>
  <li>\u05E9\u05DC\u05D1 \u05D1: \u05D1\u05D9\u05E6\u05D5\u05E2</li>
  <li>\u05E9\u05DC\u05D1 \u05D2: \u05D1\u05D3\u05D9\u05E7\u05D5\u05EA</li>
</ol>
</div>`,
    },

    // 56. CJK lists (Japanese) — wrapping within list items with CJK characters
    {
      name: 'Japanese CJK lists',
      width: 350,
      height: 400,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<h3>\u30BF\u30B9\u30AF\u4E00\u89A7</h3>
<ul>
  <li>\u65B0\u3057\u3044<strong>\u30C6\u30AD\u30B9\u30C8\u30EC\u30F3\u30C0\u30EA\u30F3\u30B0</strong>\u30A8\u30F3\u30B8\u30F3\u306E\u30C6\u30B9\u30C8\u3092\u5B9F\u884C\u3059\u308B</li>
  <li>CSS\u30B9\u30BF\u30A4\u30EB\u306E<em>\u8ABF\u6574</em>\u3068\u30D5\u30A9\u30F3\u30C8\u306E\u78BA\u8A8D</li>
  <li>\u30D1\u30D5\u30A9\u30FC\u30DE\u30F3\u30B9\u6E2C\u5B9A\u3068\u6700\u9069\u5316</li>
</ul>
<ol>
  <li>\u30B9\u30C6\u30C3\u30D71: \u8A08\u753B\u3068\u8A2D\u8A08</li>
  <li>\u30B9\u30C6\u30C3\u30D72: \u5B9F\u88C5\u3068\u30C6\u30B9\u30C8</li>
  <li>\u30B9\u30C6\u30C3\u30D73: \u30EC\u30D3\u30E5\u30FC\u3068\u30EA\u30EA\u30FC\u30B9</li>
</ol>`,
    },

    // 57. RTL + center alignment — Arabic centered text
    {
      name: 'Arabic centered text',
      width: 450,
      height: 250,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; text-align: center; }`,
      html: `<div dir="rtl">
<h2 style="text-align: center; font-size: 22px;">\u0639\u0646\u0648\u0627\u0646 \u0645\u0631\u0643\u0632\u064A</h2>
<p style="text-align: center;">\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064A \u0645\u0631\u0643\u0632\u064A \u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0641\u064A \u0627\u0644\u0645\u0646\u062A\u0635\u0641\u060C \u0648\u064A\u062E\u062A\u0628\u0631 \u0627\u0644\u062A\u0641\u0627\u0639\u0644 \u0628\u064A\u0646 \u0627\u0644\u0627\u062A\u062C\u0627\u0647 \u0648\u0627\u0644\u0645\u062D\u0627\u0630\u0627\u0629\u06D4</p>
<p style="text-align: center;">\u0633\u0637\u0631 \u0642\u0635\u064A\u0631 \u0645\u0631\u0643\u0632\u064A\u06D4</p>
</div>`,
    },

    // 58. RTL + justify — Arabic justified text
    {
      name: 'Arabic justified text',
      width: 400,
      height: 250,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<div dir="rtl">
<p style="text-align: justify;">\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064A \u0645\u0636\u0628\u0648\u0637 \u0627\u0644\u0645\u062D\u0627\u0630\u0627\u0629 \u064A\u062C\u0628 \u0623\u0646 \u062A\u0643\u0648\u0646 \u0627\u0644\u0645\u0633\u0627\u0641\u0627\u062A \u0628\u064A\u0646 \u0627\u0644\u0643\u0644\u0645\u0627\u062A \u0645\u0648\u0632\u0639\u0629 \u0628\u0627\u0644\u062A\u0633\u0627\u0648\u064A \u0644\u062A\u0645\u0644\u0623 \u0627\u0644\u0633\u0637\u0631 \u0628\u0627\u0644\u0643\u0627\u0645\u0644 \u0645\u0646 \u0627\u0644\u064A\u0645\u064A\u0646 \u0625\u0644\u0649 \u0627\u0644\u064A\u0633\u0627\u0631\u06D4</p>
<p style="text-align: justify;">\u0641\u0642\u0631\u0629 \u062B\u0627\u0646\u064A\u0629 \u0645\u0639 \u0643\u0644\u0645\u0627\u062A \u0645\u062E\u062A\u0644\u0641\u0629 \u0627\u0644\u0623\u0637\u0648\u0627\u0644 \u0644\u0627\u062E\u062A\u0628\u0627\u0631 \u062A\u0648\u0632\u064A\u0639 \u0627\u0644\u0645\u0633\u0627\u0641\u0627\u062A \u0641\u064A \u0633\u064A\u0627\u0642 RTL\u06D4</p>
</div>`,
    },

    // 59. CJK + justify — Japanese/Chinese justified text
    {
      name: 'CJK justified text',
      width: 350,
      height: 300,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<p style="text-align: justify;">\u3053\u308C\u306F\u65E5\u672C\u8A9E\u306E\u4E21\u7AEF\u63C3\u3048\u30C6\u30B9\u30C8\u3067\u3059\u3002\u6587\u5B57\u9593\u306E\u30B9\u30DA\u30FC\u30B9\u304C\u5747\u7B49\u306B\u5206\u914D\u3055\u308C\u308B\u304B\u78BA\u8A8D\u3057\u307E\u3059\u3002\u30C6\u30AD\u30B9\u30C8\u30EC\u30F3\u30C0\u30EA\u30F3\u30B0\u306E\u54C1\u8CEA\u3092\u691C\u8A3C\u3057\u307E\u3059\u3002</p>
<p style="text-align: justify;">\u8FD9\u662F\u4E2D\u6587\u4E24\u7AEF\u5BF9\u9F50\u6D4B\u8BD5\u3002\u6BCF\u4E2A\u5B57\u7B26\u4E4B\u95F4\u7684\u7A7A\u95F4\u5E94\u8BE5\u5747\u5300\u5206\u5E03\uFF0C\u4EE5\u786E\u4FDD\u6587\u672C\u586B\u6EE1\u6574\u4E2A\u5BB9\u5668\u5BBD\u5EA6\u3002</p>`,
    },

    // 60. Mixed scripts with formatting — bold Arabic + italic Chinese + underlined English
    {
      name: 'Mixed scripts with formatting',
      width: 500,
      height: 300,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<p>This paragraph mixes <strong>\u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u0627\u0644\u063A\u0627\u0645\u0642\u0629</strong> with <em>\u4E2D\u6587\u659C\u4F53</em> and <u>underlined English</u> in one line.</p>
<p><span style="color: #dc2626;">\u05E2\u05D1\u05E8\u05D9\u05EA \u05D0\u05D3\u05D5\u05DE\u05D4</span> next to <span style="color: #0f62fe;">\u65E5\u672C\u8A9E\u306E\u9752</span> and <span style="background: #fef08a; padding: 1px 4px;">highlighted \uD55C\uAD6D\uC5B4</span>.</p>
<p>\u0939\u093F\u0902\u0926\u0940 text with <strong>\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E44\u0E17\u0E22</strong> and normal English ending.</p>`,
    },

    // 61. RTL with inline code — Arabic text containing LTR monospace code spans
    {
      name: 'RTL with inline code',
      width: 450,
      height: 250,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }
code { font-family: monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }`,
      html: `<div dir="rtl">
<p>\u0627\u0633\u062A\u062E\u062F\u0645 \u062F\u0627\u0644\u0629 <code>render()</code> \u0644\u0631\u0633\u0645 \u0627\u0644\u0646\u0635 \u0639\u0644\u0649 \u0627\u0644\u0643\u0627\u0646\u0641\u0633\u06D4</p>
<p>\u0627\u0644\u0645\u062A\u063A\u064A\u0631 <code>ctx.fillStyle = '#ff0000'</code> \u064A\u062D\u062F\u062F \u0627\u0644\u0644\u0648\u0646\u06D4</p>
<p>\u0642\u0645 \u0628\u062A\u0634\u063A\u064A\u0644 <code>npm test</code> \u0644\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 \u0627\u0644\u0646\u062A\u0627\u0626\u062C\u06D4</p>
</div>`,
    },

    // =========================================================================
    // Tier 3 — Unicode edge cases from pretext
    // =========================================================================

    // 62. Multi-script single paragraph — 7 scripts in one line
    {
      name: 'Multi-script single paragraph',
      width: 500,
      height: 200,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<p>Hello <span>\u0645\u0631\u062D\u0628\u0627</span> <span>\u05E9\u05DC\u05D5\u05DD</span> <span>\u4F60\u597D</span> <span>\u3053\u3093\u306B\u3061\u306F</span> <span>\uC548\uB155\uD558\uC138\uC694</span> <span>\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35</span> \u2014 a greeting in seven scripts!</p>
<p>Price: $42.99 (\u0639\u0631\u0628\u064A \u096A\u0968.\u096F\u096F) and \u00A5128 and \u20AA158.50 in one line.</p>`,
    },

    // 63. URL wrapping — long URLs should break at /, ?, &
    {
      name: 'URL text wrapping',
      width: 300,
      height: 300,
      css: `body { font-family: sans-serif; font-size: 14px; line-height: 1.5; }`,
      html: `<p>Visit this link: https://example.com/reports/q3?lang=ar&mode=full&output=pdf to download.</p>
<p>Another URL: https://very-long-subdomain.example.org/path/to/deeply/nested/resource/page.html that should wrap.</p>
<p>Email: user.name+tag@very-long-domain-name.example.com is also long.</p>`,
    },

    // 64. Numbers + currency in RTL — bidi with numeric content
    {
      name: 'Numbers and currency in RTL',
      width: 400,
      height: 250,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<div dir="rtl">
<p>\u0627\u0644\u0633\u0639\u0631: $42.99 (\u062A\u0642\u0631\u064A\u0628\u0627\u064B \u0664\u0662\u066B\u0669\u0669 \u0631\u064A\u0627\u0644 \u0623\u0648 \u20AA158.50)</p>
<p>\u0627\u0644\u062A\u0627\u0631\u064A\u062E: 2026/03/10 \u0648\u0627\u0644\u0648\u0642\u062A 14:30</p>
<p><strong>\u0627\u0644\u0645\u0628\u0644\u063A \u0627\u0644\u0625\u062C\u0645\u0627\u0644\u064A: \u0661\u0660\u066C\u0660\u0660\u0660 \u0631\u064A\u0627\u0644</strong></p>
</div>`,
    },

    // 65. Word joiner + zero-width space — break control characters in rich text
    {
      name: 'Word joiner and zero-width space',
      width: 200,
      height: 300,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.5; }`,
      html: `<p>Word\u2060joiner should NOT break here but alpha\u200Bbeta SHOULD break here.</p>
<p>Unit: 50\u00A0kg and 100\u00A0km with non-breaking spaces.</p>
<p>Trans\u00ADatlantic has a soft hyphen. Super\u00ADcali\u00ADfragi\u00ADlistic with many.</p>
<p>foo\u2060bar\u2060baz stays together. one\u200Btwo\u200Bthree can break.</p>`,
    },

    // 66. Dense consecutive emoji — tests emoji width calculation
    {
      name: 'Dense emoji sequences',
      width: 300,
      height: 350,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<p>\uD83D\uDC4F\uD83D\uDC4F\uD83D\uDC4F\uD83C\uDFAF\uD83D\uDE80 consecutive emoji in a row.</p>
<p>Skin tones: \uD83D\uDC68\uD83C\uDFFD\u200D\uD83D\uDD2C and \uD83D\uDC69\uD83C\uDFFF\u200D\uD83D\uDCBB and \uD83D\uDC68\uD83C\uDFFB\u200D\uD83C\uDFA8 together.</p>
<p>Family: \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66 and flags: \uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDEC\uD83C\uDDE7\uD83C\uDDEF\uD83C\uDDF5 in text.</p>
<p><strong>Bold \uD83D\uDCAA</strong> and <em>italic \uD83C\uDF1F</em> and <u>underlined \uD83C\uDF08</u> emoji.</p>
<p style="font-size: 24px;">\uD83D\uDE00\uD83D\uDE01\uD83D\uDE02\uD83E\uDD23\uD83D\uDE03\uD83D\uDE04\uD83D\uDE05\uD83D\uDE06 large emoji row.</p>`,
    },

    // 67. Emoji in lists — bullet alignment with emoji characters
    {
      name: 'Emoji in lists',
      width: 350,
      height: 350,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<ul>
  <li>\uD83D\uDE80 Launch the new feature by Friday</li>
  <li>\uD83D\uDC1B Fix the rendering bug in Safari</li>
  <li>\uD83D\uDCDD Write documentation for the API</li>
  <li>\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66 Family emoji at list start with wrapping text that goes long</li>
  <li>\u2705 Done: <strong>merged PR #42</strong></li>
</ul>
<ol>
  <li>\uD83D\uDD34 Critical priority item</li>
  <li>\uD83D\uDFE1 Medium priority item</li>
  <li>\uD83D\uDFE2 Low priority item</li>
</ol>`,
    },

    // 68. Mixed font sizes with CJK — baseline alignment stress test
    {
      name: 'Mixed font sizes with CJK',
      width: 500,
      height: 250,
      css: `body { font-family: sans-serif; line-height: 1.4; }`,
      html: `<p><span style="font-size: 12px;">Small English</span> <span style="font-size: 24px;">\u5927\u304D\u306A\u65E5\u672C\u8A9E</span> <span style="font-size: 14px;">medium text</span> <span style="font-size: 28px;">\u4E2D\u6587\u5927\u5B57</span></p>
<p><span style="font-size: 10px;">tiny</span> next to <span style="font-size: 32px;">\uD55C\uAD6D\uC5B4</span> next to <span style="font-size: 16px;">normal size</span></p>
<p style="font-size: 14px;">\u65E5\u672C\u8A9E\u306E<span style="font-size: 24px; color: #dc2626;">\u5927\u304D\u306A</span>\u6587\u5B57\u3068<span style="font-size: 10px; color: #0f62fe;">\u5C0F\u3055\u306A</span>\u6587\u5B57</p>`,
    },

    // 69. Very long CJK paragraph — CJK wrapping stress test
    {
      name: 'Long CJK paragraph',
      width: 350,
      height: 600,
      css: `body { font-family: sans-serif; font-size: 16px; line-height: 1.6; }`,
      html: `<p>\u3053\u308C\u306F\u30C6\u30AD\u30B9\u30C8\u30EC\u30A4\u30A2\u30A6\u30C8\u30E9\u30A4\u30D6\u30E9\u30EA\u306E\u30C6\u30B9\u30C8\u3067\u3059\u3002\u65E5\u672C\u8A9E\u306E\u30C6\u30AD\u30B9\u30C8\u3092\u6B63\u3057\u304F\u51E6\u7406\u3067\u304D\u308B\u304B\u78BA\u8A8D\u3057\u307E\u3059\u3002\u30D1\u30D5\u30A9\u30FC\u30DE\u30F3\u30B9\u306F\u975E\u5E38\u306B\u91CD\u8981\u3067\u3059\u3002\u30D5\u30EC\u30FC\u30E0\u3054\u3068\u306B\u6570\u767E\u306E\u30C6\u30AD\u30B9\u30C8\u30D6\u30ED\u30C3\u30AF\u3092\u6E2C\u5B9A\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059\u3002</p>
<p>\u8FD9\u662F\u4E00\u6BB5\u4E2D\u6587\u6587\u672C\uFF0C\u7528\u4E8E\u6D4B\u8BD5\u6587\u672C\u5E03\u5C40\u5E93\u5BF9\u4E2D\u65E5\u97E9\u5B57\u7B26\u7684\u652F\u6301\u3002\u6BCF\u4E2A\u5B57\u7B26\u4E4B\u95F4\u90FD\u53EF\u4EE5\u65AD\u884C\u3002\u6027\u80FD\u6D4B\u8BD5\u663E\u793A\uFF0C\u65B0\u7684\u6587\u672C\u6D4B\u91CF\u65B9\u6CD5\u6BD4\u4F20\u7EDF\u65B9\u6CD5\u5FEB\u4E86\u5C06\u8FD1\u4E00\u5343\u4E94\u767E\u500D\u3002</p>
<p>\uC774\uAC83\uC740 \uD14D\uC2A4\uD2B8 \uB808\uC774\uC544\uC6C3 \uB77C\uC774\uBE0C\uB7EC\uB9AC\uC758 \uD14C\uC2A4\uD2B8\uC785\uB2C8\uB2E4. \uD55C\uAD6D\uC5B4 \uD14D\uC2A4\uD2B8\uB97C \uC62C\uBC14\uB974\uAC8C \uCC98\uB9AC\uD560 \uC218 \uC788\uB294\uC9C0 \uD655\uC778\uD569\uB2C8\uB2E4.</p>`,
    },

    // 70. Mixed app text (comprehensive) — pretext's crown jewel corpus as rich HTML
    {
      name: 'Mixed app text comprehensive',
      width: 450,
      height: 800,
      css: `body { font-family: sans-serif; font-size: 14px; line-height: 1.6; }
code { font-family: monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }`,
      html: `<p>Release checklist (<strong>v2.3.1</strong>): ship the 8:30-4:30 coverage panel, keep the backup URL <code>https://example.com/reports/q3?lang=ar&amp;mode=full</code> readable, and do not let the \u201Cprimary CTA\u201D jump when the card shrinks from 420px to 300px.</p>
<p>Nora wrote \u201Cplease keep 10\u202F000 rows visible\u201D, Mina replied \u201Ctrans\u00ADatlantic labels are still weird\u201D, and Kenji answered \u300C\u4E86\u89E3\u3067\u3059\u300D before pasting <em>\u4FA1\u683C\u306F\u00A512,800\u3067\u3059</em> and the Korean note \u201C\uB2E4\uC74C \uBC30\uD3EC\uB294 7:00-9:00 \uC0AC\uC774\uC608\uC694.\u201D</p>
<p>The Arabic support thread said: \u201C<span dir="rtl">\u0647\u0630\u0627 \u062C\u064A\u062F\u060C \u0648\u0644\u0643\u0646 \u0644\u0627 \u062A\u0643\u0633\u0631 \u0627\u0644\u0639\u0628\u0627\u0631\u0629 \u00AB\u0641\u064A\u0642\u0648\u0644: \u0648\u0639\u0644\u064A\u0643 \u0627\u0644\u0633\u0644\u0627\u0645\u00BB \u062F\u0627\u062E\u0644 \u0627\u0644\u0628\u0637\u0627\u0642\u0629</span>.\u201D A second comment mixed Hebrew and English: \u201C<span dir="rtl">\u05D1\u05D3\u05D9\u05E7\u05D4 \u05D0\u05D7\u05EA \u05E0\u05D5\u05E1\u05E4\u05EA</span>: keep (RTL) punctuation stable, even when numbers like 2026/03/10 show up.\u201D</p>
<p>Hindi note: \u201C<span>\u0915\u0943\u092A\u092F\u093E \u092C\u0924\u093E\u0913! \u092F\u0939 \u0968\u096A\u00D7\u096D \u0938\u092A\u094B\u0930\u094D\u091F \u0939\u0948\u0964</span>\u201D Thai note: \u201C<span>\u0E17\u0E39\u0E25\u0E27\u0E48\u0E32 \u0E1E\u0E23\u0E30\u0E2D\u0E07\u0E04\u0E4C\u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E2B\u0E23\u0E37\u0E2D\u0E22\u0E31\u0E07</span>\u201D and the Japanese QA follow-up was \u300C<em>\u201Cquote clusters\u201D \u3082\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044</em>\u300D.</p>
<p>Status emoji stayed consistent: \uD83D\uDC69\u200D\uD83D\uDCBB, \uD83D\uDC68\uD83C\uDFFD\u200D\uD83D\uDD2C, and family \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66 should not distort line counts. We also have hard\u00A0spaces like 50\u00A0kg, word joiners in foo\u2060bar, and a zero-width break in alpha\u200Bbeta for very narrow mobile cards.</p>`,
    },
  ];
}

export const polotnoListsCase: BenchmarkCase = {
  name: 'Polotno Lists',
  width: 400,
  height: 500,
  html: `<div style="white-space: pre-wrap; word-break: break-word; width: 396px; color: black; font-size: 20px; font-family: 'Arimo'; text-align: left; line-height: 1.4; font-style: normal; font-weight: normal" dir="ltr"><p><strong>Shopping List</strong></p><ul><li>Fruits and vegetables</li><li><em>Dairy products</em></li><li><span style="color: rgb(226, 15, 15);">Urgent:</span> Bread</li><li>Coffee beans</li></ul><p><strong>Weekly Tasks</strong></p><ol><li>Review <u>quarterly report</u></li><li>Schedule team meeting</li><li><span style="color: rgb(20, 218, 103);">Done:</span> Update documentation</li><li>Deploy new version</li><li>Send <strong>status update</strong> to stakeholders</li></ol><p>Nested items:</p><ul><li>Parent item</li><li class="ql-indent-1">Child item one</li><li class="ql-indent-1">Child item two</li><li class="ql-indent-2">Grandchild</li><li>Another parent</li></ul></div><style>/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sCzZCDf9_T_10c9CNkiL2t2dk.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: italic;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sCzZCDf9_T_10c9CNkiL2t2dk.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sMzZCDf9_T_10ZxCFuj5-v.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sMzZCDf9_T_10ZxCFuj5-v.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}</style>
<style>
  html, body { padding: 0; margin: 0; }
  p { margin: 0; padding: 0; word-wrap: break-word; white-space: pre-wrap; }
  ul, ol {
    list-style: none;
    padding-inline-start: 0;
    margin: 0;
    display: block;
    width: 100%;
    text-decoration: inherit;
    counter-reset: ol-counter;
  }
  li {
    position: relative;
    padding-inline-start: 2.1em;
    margin: 0;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  li::before {
    content: '';
    position: absolute;
    inset-inline-start: 0;
    top: 0;
    letter-spacing: normal;
    display: inline-block;
    width: 2em;
    text-align: end;
    margin-inline-end: 0.8em;
    font-weight: normal;
    font-style: normal;
  }
  ul > li::before {
    content: '\\2022';
    text-align: center;
    font-size: 1.2em;
    top: 0em;
    width: 2em;
    margin-inline-end: 1.5em;
  }
  ol > li { counter-increment: ol-counter; }
  ol > li::before { content: counter(ol-counter) "."; }
  .ql-indent-1 { margin-inline-start: 0.5em; }
  .ql-indent-2 { margin-inline-start: 1em; }
  .ql-indent-3 { margin-inline-start: 1.5em; }
</style>`,
  css: '',
};

export const polotnoCase: BenchmarkCase = {
  name: 'Polotno HTML',
  width: 600,
  height: 400,
  html: `<div style="white-space: pre-wrap; word-break: break-word; width: 596px; color: black; font-size: 26.584502908891224px; font-family: 'Arimo'; text-align: left; text-transform: none; line-height: 1.2; font-style: normal; font-weight: normal" dir="ltr"><p>Will be <span style="color: rgb(226, 15, 15);">responsible</span><span> for managing activities that are part of the production of </span><strong><span>goods</span></strong> and services. Direct <em><span>responsibilities</span></em> include managing both the operations process, embracing design, planning, control, performance <u><span>improvement</span></u>, and <span style="color: rgb(20, 218, 103);">operations</span><span> strategy.</span></p><ul><li>F</li><li>Q</li><li>W</li><li>G</li></ul><ol><li>L</li><li>A</li><li>S</li><li>Q</li><li>W</li></ol></div><style>/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sCzZCDf9_T_10c9CNkiL2t2dk.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: italic;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sCzZCDf9_T_10c9CNkiL2t2dk.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sMzZCDf9_T_10ZxCFuj5-v.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* latin */
@font-face {
  font-family: 'Arimo';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/arimo/v35/P5sMzZCDf9_T_10ZxCFuj5-v.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}</style>
<style>
  html, body { padding: 0; margin: 0; }
  p { margin: 0; padding: 0; word-wrap: break-word; white-space: pre-wrap; }
  ul, ol {
    list-style: none;
    padding-inline-start: 0;
    margin: 0;
    display: block;
    width: 100%;
    text-decoration: inherit;
    counter-reset: ol-counter;
  }
  li {
    position: relative;
    padding-inline-start: 2.1em;
    margin: 0;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  li::before {
    content: '';
    position: absolute;
    inset-inline-start: 0;
    top: 0;
    letter-spacing: normal;
    display: inline-block;
    width: 2em;
    text-align: end;
    margin-inline-end: 0.8em;
    font-weight: normal;
    font-style: normal;
  }
  ul > li::before {
    content: '\\2022';
    text-align: center;
    font-size: 1.2em;
    top: 0em;
    width: 2em;
    margin-inline-end: 1.5em;
  }
  ol > li { counter-increment: ol-counter; }
  ol > li::before { content: counter(ol-counter) "."; }
  .ql-indent-1 { margin-inline-start: 0.5em; }
  .ql-indent-2 { margin-inline-start: 1em; }
  .ql-indent-3 { margin-inline-start: 1.5em; }
</style>`,
  css: '',
};
