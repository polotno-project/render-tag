export async function loadSiteFonts(): Promise<void> {
  await Promise.all([
    document.fonts.load('400 16px Roboto'),
    document.fonts.load('700 16px Roboto'),
    document.fonts.load('italic 400 16px Roboto'),
    document.fonts.load('400 24px "Playfair Display"'),
    document.fonts.load('700 24px "Playfair Display"'),
    document.fonts.load('italic 400 24px "Playfair Display"'),
    document.fonts.load('400 16px Merriweather'),
    document.fonts.load('italic 400 16px Merriweather'),
    document.fonts.load('400 24px Lobster'),
  ]);
}

export function initCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy], [data-copy-source]')) {
    button.addEventListener('click', async () => {
      const source = button.dataset.copySource === 'api-active-code'
        ? document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) code')
        : document.getElementById(button.dataset.copySource ?? '');
      const text = button.dataset.copy ?? source?.textContent;
      if (!text) return;
      const label = button.textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied ✓';
      } catch {
        if (source) {
          const range = document.createRange();
          range.selectNodeContents(source);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
        }
        button.textContent = 'Select & copy';
      }
      window.setTimeout(() => { button.textContent = label; }, 1600);
    });
  }
}

export function initCodeTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-code-tab]')];
  const select = (tab: HTMLButtonElement) => {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(item.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !active;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      select(tabs[index]);
      tabs[index].focus();
    });
  }
}

export function highlightCode(element: HTMLElement, code: string): void {
  element.replaceChildren();
  const tokens = /\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:import|from|const|await)\b|\b\d+(?:\.\d+)?\b/g;
  let start = 0;
  for (const match of code.matchAll(tokens)) {
    element.append(document.createTextNode(code.slice(start, match.index)));
    const span = document.createElement('span');
    const text = match[0];
    span.className = text.startsWith('//') ? 't-cm' : /^['"`]/.test(text) ? 't-str' : /^\d/.test(text) ? 't-num' : 't-kw';
    span.textContent = text;
    element.appendChild(span);
    start = match.index + text.length;
  }
  element.append(document.createTextNode(code.slice(start)));
}
