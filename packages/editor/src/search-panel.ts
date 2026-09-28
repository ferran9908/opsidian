import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from '@codemirror/search';

/** Keep CodeMirror's search engine and shortcuts, with notebook-native controls. */
export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'op-find';
  dom.setAttribute('role', 'search');
  dom.setAttribute('aria-label', 'Find in note');
  const row = document.createElement('div');
  row.className = 'op-find-row';
  const replacement = document.createElement('div');
  replacement.className = 'op-find-row';
  replacement.hidden = true;
  let query = getSearchQuery(view.state);
  function field(label: string) {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.oninput = commit;
    return input;
  }
  function button(label: string, text: string, action: () => void) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.title = label;
    control.setAttribute('aria-label', label);
    control.onclick = action;
    return control;
  }
  const find = field('Find in note');
  find.setAttribute('main-field', 'true');
  const replace = field('Replace with');
  const status = document.createElement('span');
  status.className = 'op-find-status';
  status.setAttribute('role', 'status');
  const options: HTMLButtonElement[] = [];
  function toggle(label: string, text: string, key: 'caseSensitive' | 'wholeWord' | 'regexp') {
    const control = button(label, text, () => {
      control.setAttribute('aria-pressed', String(control.getAttribute('aria-pressed') !== 'true'));
      commit();
    });
    control.dataset.option = key;
    control.setAttribute('aria-pressed', String(query[key]));
    options.push(control);
    return control;
  }
  function commit() {
    const flags = Object.fromEntries(
      options.map((option) => [
        option.dataset.option!,
        option.getAttribute('aria-pressed') === 'true',
      ]),
    );
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: find.value, replace: replace.value, literal: true, ...flags }),
      ),
    });
  }
  function navigate(previous: boolean) {
    const found = (previous ? findPrevious : findNext)(view);
    if (query.valid) status.textContent = found ? '' : 'No matches';
  }
  const expand = button('Show replacement options', 'Replace', () => {
    replacement.hidden = !replacement.hidden;
    expand.setAttribute('aria-expanded', String(!replacement.hidden));
    if (!replacement.hidden) replace.focus();
  });
  expand.setAttribute('aria-expanded', 'false');
  row.append(
    find,
    toggle('Match case', 'Aa', 'caseSensitive'),
    toggle('Whole words', 'W', 'wholeWord'),
    toggle('Regular expression', '.*', 'regexp'),
    button('Previous match (Shift+Enter)', '↑', () => navigate(true)),
    button('Next match (Enter)', '↓', () => navigate(false)),
  );
  if (!view.state.readOnly) row.append(expand);
  row.append(
    button('Close find (Escape)', '×', () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );
  replacement.append(
    replace,
    button('Replace next match', 'Replace', () => replaceNext(view)),
    button('Replace all matches', 'Replace all', () => replaceAll(view)),
  );
  dom.append(row, replacement, status);
  function sync() {
    query = getSearchQuery(view.state);
    find.value = query.search;
    replace.value = query.replace;
    for (const option of options)
      option.setAttribute(
        'aria-pressed',
        String(query[option.dataset.option as 'regexp' | 'wholeWord' | 'caseSensitive']),
      );
    find.setAttribute('aria-invalid', String(Boolean(query.search) && !query.valid));
    status.textContent = query.search && !query.valid ? 'Invalid expression' : '';
  }
  dom.onkeydown = (event) => {
    if (runScopeHandlers(view, event, 'search-panel')) event.preventDefault();
    else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (event.target === replace) replaceNext(view);
      else navigate(event.shiftKey);
    }
  };
  sync();
  return {
    dom,
    top: true,
    mount() {
      find.focus();
      find.select();
    },
    update(update: ViewUpdate) {
      if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setSearchQuery))))
        sync();
      else if (update.docChanged) status.textContent = '';
    },
  };
}
