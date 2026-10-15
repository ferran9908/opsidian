import { StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import {
  readFrontmatter,
  removeProperty,
  setProperty,
  type Edit,
  type Property,
  type PropertyType,
  type PropertyValue,
} from '@opsidian/core';

export interface PropertyOptions {
  /** Every tag in the notebook, offered while adding one. */
  tagSuggestions?(): Promise<{ name: string; count: number }[]>;
  /** How a date is picked: beside the value, or from the bottom of the screen on a phone. */
  picker?: 'popover' | 'sheet';
}

const FOLDED = 'opsidian.properties.folded';
/**
 * Whether the panel is folded, remembered between notes. Storage is not allowed everywhere the
 * editor runs (a page made from a string has none), so it falls back to this session.
 */
let foldedHere = false;
const folded = {
  get(): boolean {
    try {
      return localStorage.getItem(FOLDED) === '1';
    } catch {
      return foldedHere;
    }
  },
  toggle() {
    foldedHere = !folded.get();
    try {
      if (foldedHere) localStorage.setItem(FOLDED, '1');
      else localStorage.removeItem(FOLDED);
    } catch {
      // Kept for this session only.
    }
  },
};
const ICONS: Record<PropertyType | 'add' | 'chevron' | 'remove', string> = {
  text: '<path d="M3 4.5h10M3 8h10M3 11.5h6"/>',
  raw: '<path d="M3 4.5h10M3 8h10M3 11.5h6"/>',
  number: '<path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.8 5.8h10.7M2.5 10.2h10.7"/>',
  tags: '<path d="M2.5 8.6V3.2c0-.4.3-.7.7-.7h5.4l5 5-6.1 6.1-5-5z"/><circle cx="5.6" cy="5.6" r=".6"/>',
  list: '<path d="M5.5 3.5h8M5.5 8h8M5.5 12.5h8M2.6 3.5h.4M2.6 8h.4M2.6 12.5h.4"/>',
  date: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  datetime: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  checkbox:
    '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="m5.3 8.2 1.9 1.8 3.5-4"/>',
  add: '<path d="M8 3.5v9M3.5 8h9"/>',
  chevron: '<path d="m4.5 6 3.5 3.5L11.5 6"/>',
  remove: '<path d="m5 5 6 6M11 5l-6 6"/>',
};
const icon = (name: keyof typeof ICONS, className = 'op-prop-icon') =>
  `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;

/** A row's key: rows whose lines did not change are kept, with whatever has focus in them. */
const signature = (property: Property) => `${property.key}\u0000${property.source}`;

/** What should have focus once the panel is next drawn, by the control's name. */
const pendingFocus = new WeakMap<EditorView, string>();

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function apply(view: EditorView, edit: Edit | undefined, focus?: string) {
  if (!edit) return;
  if (focus) pendingFocus.set(view, focus);
  view.dispatch({ changes: edit, userEvent: 'input.property' });
}
const commit = (
  view: EditorView,
  key: string,
  type: PropertyType,
  value: PropertyValue,
  focus?: string,
) => apply(view, setProperty(view.state.doc.toString(), key, type, value), focus);

const pad = (number: number) => String(number).padStart(2, '0');
const isoDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
function parseDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h ?? 0), Number(min ?? 0));
}
function dateLabel(value: string, type: PropertyType, short: boolean): string {
  const date = parseDate(value);
  if (!date) return value;
  const day = date.toLocaleDateString(undefined, {
    weekday: short ? 'short' : 'long',
    month: short ? 'short' : 'long',
    day: 'numeric',
    year: 'numeric',
  });
  return type === 'datetime'
    ? `${day}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : day;
}

/** The panel's top: the word Properties, which folds and unfolds it. */
function header(root: HTMLElement, folded: boolean, onToggle: () => void) {
  const button = make('button', 'op-prop-header');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(!folded));
  button.innerHTML = `${icon('chevron', 'op-prop-chevron')}<span>Properties</span>`;
  button.addEventListener('click', onToggle);
  root.append(button);
}

class PropertiesWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly options: PropertyOptions,
  ) {
    super();
  }
  eq(other: PropertiesWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const root = make('div', 'op-properties');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Properties');
    render(root, view, this.options);
    return root;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    render(dom, view, this.options);
    return true;
  }
  ignoreEvent() {
    return true;
  }
  /** The panel changes its own DOM (fields, menus, the picker); the editor must not redraw it. */
  ignoreMutation() {
    return true;
  }
}

function render(root: HTMLElement, view: EditorView, options: PropertyOptions) {
  const found = readFrontmatter(view.state.doc.toString());
  if (!found) return;
  const isFolded = folded.get();
  root.classList.toggle('op-properties-folded', isFolded);
  if (!root.querySelector(':scope > .op-prop-header'))
    header(root, isFolded, () => {
      folded.toggle();
      render(root, view, options);
    });
  root.querySelector(':scope > .op-prop-header')!.setAttribute('aria-expanded', String(!isFolded));

  let list = root.querySelector<HTMLElement>(':scope > .op-prop-rows');
  if (!list) {
    list = make('div', 'op-prop-rows');
    root.append(list);
  }
  // Rows whose lines are unchanged are kept as they are, focus and all.
  const kept = new Map<string, HTMLElement>();
  for (const row of list.querySelectorAll<HTMLElement>(':scope > [data-signature]'))
    kept.set(row.dataset.signature!, row);
  const rows = found.properties.map((property) => {
    const existing = kept.get(signature(property));
    kept.delete(signature(property));
    return existing ?? row(view, property, options);
  });
  for (const stale of kept.values()) stale.remove();
  let adder = list.querySelector<HTMLElement>(':scope > .op-prop-adder');
  if (!adder) adder = addPropertyRow(view, found.properties);
  else
    (adder as HTMLElement & { keys?: Set<string> }).keys = new Set(
      found.properties.map((p) => p.key),
    );
  list.replaceChildren(...rows, adder);

  const focus = pendingFocus.get(view);
  if (focus) {
    pendingFocus.delete(view);
    const target = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`);
    if (target) {
      if (target.dataset.reveal) target.click();
      else target.focus();
    }
  }
}

function row(view: EditorView, property: Property, options: PropertyOptions): HTMLElement {
  const element = make('div', `op-prop op-prop-type-${property.type}`);
  element.dataset.signature = signature(property);
  element.dataset.key = property.key;
  const name = make('div', 'op-prop-name');
  name.innerHTML = icon(property.type);
  name.append(make('span', 'op-prop-key', property.key));
  const value = make('div', 'op-prop-value');
  element.append(name, value);
  fillValue(value, view, property, options);
  const remove = make('button', 'op-prop-remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${property.key}`);
  remove.innerHTML = icon('remove');
  remove.addEventListener('click', () =>
    apply(view, removeProperty(view.state.doc.toString(), property.key)),
  );
  element.append(remove);
  return element;
}

function fillValue(
  value: HTMLElement,
  view: EditorView,
  property: Property,
  options: PropertyOptions,
) {
  const { key, type } = property;
  if (type === 'checkbox') {
    const box = make('input', 'op-prop-check');
    box.type = 'checkbox';
    box.checked = property.value === true;
    box.dataset.focus = `value:${key}`;
    box.setAttribute('aria-label', key);
    box.addEventListener('change', () => commit(view, key, 'checkbox', box.checked));
    value.append(box);
    return;
  }
  if (type === 'date' || type === 'datetime') {
    const button = make('button', 'op-prop-date');
    button.type = 'button';
    button.dataset.focus = `value:${key}`;
    const current = typeof property.value === 'string' ? property.value : '';
    button.textContent = current
      ? dateLabel(current, type, options.picker === 'sheet')
      : 'Pick a date';
    if (!current) button.classList.add('op-prop-empty');
    button.addEventListener('click', () => openPicker(button, view, key, type, current, options));
    value.append(button);
    return;
  }
  if (type === 'list' || type === 'tags') {
    listEditor(
      value,
      view,
      key,
      type,
      Array.isArray(property.value) ? property.value : [],
      options,
    );
    return;
  }
  if (type === 'raw') {
    const text = make('div', 'op-prop-raw', String(property.value ?? ''));
    text.title = 'Shown as written. Edit it in Source mode.';
    value.append(text);
    return;
  }
  // Text and numbers: edited in place, saved on Return or on leaving the field.
  const input = make('input', 'op-prop-input');
  input.type = 'text';
  input.value = property.value === null ? '' : String(property.value);
  input.placeholder = 'Empty';
  input.dataset.focus = `value:${key}`;
  input.setAttribute('aria-label', key);
  if (type === 'number') input.inputMode = 'decimal';
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      input.value = property.value === null ? '' : String(property.value);
      input.blur();
    }
  });
  input.addEventListener('change', () => {
    const text = input.value.trim();
    if (type === 'number') {
      if (text === '') return commit(view, key, 'number', null);
      const number = Number(text);
      // Something that is not a number turns the property into text, rather than losing it.
      return Number.isFinite(number)
        ? commit(view, key, 'number', number)
        : commit(view, key, 'text', text);
    }
    commit(view, key, 'text', text === '' ? null : text);
  });
  value.append(input);
}

/** Chips, one per item, and a field for adding one. Tags offer the notebook's tags. */
function listEditor(
  value: HTMLElement,
  view: EditorView,
  key: string,
  type: 'list' | 'tags',
  items: string[],
  options: PropertyOptions,
) {
  const save = (next: string[], focus?: string) => commit(view, key, type, next, focus);
  for (const [index, item] of items.entries()) {
    const chip = make('span', type === 'tags' ? 'op-chip op-chip-tag' : 'op-chip');
    chip.append(make('span', 'op-chip-label', type === 'tags' ? `#${item}` : item));
    const remove = make('button', 'op-chip-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${item}`);
    remove.innerHTML = icon('remove');
    remove.addEventListener('click', () => save(items.filter((_, at) => at !== index)));
    chip.append(remove);
    value.append(chip);
  }
  const add = make('button', 'op-chip-add');
  add.type = 'button';
  add.dataset.focus = `add:${key}`;
  add.dataset.reveal = '1';
  add.setAttribute('aria-label', type === 'tags' ? 'Add a tag' : `Add to ${key}`);
  add.innerHTML = icon('add');
  value.append(add);

  add.addEventListener('click', () => {
    add.hidden = true;
    const field = make(
      'span',
      type === 'tags' ? 'op-chip op-chip-tag op-chip-field' : 'op-chip op-chip-field',
    );
    const input = make('input', 'op-chip-input');
    input.type = 'text';
    input.setAttribute('aria-label', type === 'tags' ? 'New tag' : `New item in ${key}`);
    input.autocapitalize = 'none';
    input.spellcheck = false;
    field.append(input);
    value.append(field);
    const menu =
      type === 'tags' ? suggestions(value, input, items, options, (name) => take(name)) : undefined;
    // Under the field being typed in, kept inside the panel's width.
    const place = () => {
      const panel = value.closest('.op-properties') as HTMLElement | null;
      const menuElement = value.querySelector<HTMLElement>('.op-tag-menu');
      if (!panel || !menuElement) return;
      const room = panel.getBoundingClientRect().right - value.getBoundingClientRect().left;
      menuElement.style.left = `${Math.max(0, Math.min(field.offsetLeft, room - 252))}px`;
    };
    input.addEventListener('input', place);
    const close = () => {
      menu?.close();
      field.remove();
      add.hidden = false;
    };
    const take = (text: string) => {
      const item = text.trim().replace(type === 'tags' ? /^#+/ : /^$/, '');
      if (!item || items.includes(item)) {
        input.value = '';
        return;
      }
      // The field comes back after the row is drawn again, ready for the next one.
      save([...items, item], `add:${key}`);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || (event.key === ',' && type === 'list')) {
        event.preventDefault();
        take(menu?.chosen() ?? input.value);
      } else if (event.key === 'Escape') close();
      else if (event.key === 'Backspace' && input.value === '' && items.length)
        save(items.slice(0, -1), `add:${key}`);
      else menu?.key(event);
    });
    input.addEventListener('blur', () => {
      // A suggestion being clicked takes its own path; leave the field to it.
      setTimeout(() => {
        if (!field.isConnected) return;
        if (input.value.trim()) take(input.value);
        else close();
      }, 150);
    });
    input.focus();
  });
}

/** The tags in the notebook that start with what is being typed, and a way to add a new one. */
function suggestions(
  value: HTMLElement,
  input: HTMLInputElement,
  present: string[],
  options: PropertyOptions,
  pick: (name: string) => void,
) {
  const menu = make('div', 'op-tag-menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  value.append(menu);
  let all: { name: string; count: number }[] = [];
  void options.tagSuggestions?.().then((tags) => {
    all = tags;
    draw();
  });
  let shown: string[] = [];
  let active = 0;
  const typed = () => input.value.trim().replace(/^#+/, '');
  function draw() {
    const text = typed().toLowerCase();
    if (!text) {
      menu.hidden = true;
      shown = [];
      return;
    }
    const matches = all
      .filter((tag) => !present.includes(tag.name) && tag.name.toLowerCase().includes(text))
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(text)) -
            Number(a.name.toLowerCase().startsWith(text)) || b.count - a.count,
      )
      .slice(0, 6);
    shown = matches.map((tag) => tag.name);
    const exact = matches.some((tag) => tag.name.toLowerCase() === text);
    if (!exact) shown.push(typed());
    active = Math.min(active, shown.length - 1);
    menu.replaceChildren(
      ...matches.map((tag, index) => {
        const option = make('div', 'op-tag-option');
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === active));
        option.append(
          make('span', 'op-tag-name', `#${tag.name}`),
          make('span', 'op-tag-count', `${tag.count} ${tag.count === 1 ? 'note' : 'notes'}`),
        );
        // On mousedown, so the field keeps its focus and is not closed first.
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pick(tag.name);
        });
        return option;
      }),
      ...(exact
        ? []
        : [
            (() => {
              const option = make('div', 'op-tag-option op-tag-new');
              option.setAttribute('role', 'option');
              option.setAttribute('aria-selected', String(active === shown.length - 1));
              option.append(
                make('span', '', 'Add '),
                make('span', 'op-tag-name', `#${typed()}`),
                make('span', '', ' as a new tag'),
              );
              option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                pick(typed());
              });
              return option;
            })(),
          ]),
    );
    if (matches.length && !exact)
      menu.insertBefore(make('div', 'op-tag-divider'), menu.lastElementChild);
    menu.hidden = false;
  }
  input.addEventListener('input', () => {
    active = 0;
    draw();
  });
  return {
    chosen: () => (menu.hidden || !shown.length ? undefined : shown[active]),
    key(event: KeyboardEvent) {
      if (menu.hidden || !shown.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        draw();
      }
    },
    close: () => menu.remove(),
  };
}

/** The row for adding a property: a name first; its value is then edited like any other. */
function addPropertyRow(view: EditorView, properties: Property[]): HTMLElement {
  const element = make('div', 'op-prop-adder') as HTMLElement & { keys?: Set<string> };
  element.keys = new Set(properties.map((property) => property.key));
  const button = make('button', 'op-prop-add');
  button.type = 'button';
  button.innerHTML = `${icon('add')}<span>Add property</span>`;
  element.append(button);
  button.addEventListener('click', () => {
    button.hidden = true;
    const input = make('input', 'op-prop-input op-prop-new');
    input.type = 'text';
    input.placeholder = 'Property name';
    input.autocapitalize = 'none';
    input.spellcheck = false;
    const note = make('span', 'op-prop-note');
    element.append(input, note);
    const done = () => {
      input.remove();
      note.remove();
      button.hidden = false;
    };
    const create = () => {
      const name = input.value.trim();
      if (!name) return done();
      if (/[:\n]/.test(name)) return void (note.textContent = 'A name cannot contain a colon.');
      if (element.keys!.has(name)) return void (note.textContent = 'This note already has it.');
      done();
      const lower = name.toLowerCase();
      const type: PropertyType =
        lower === 'tags' || lower === 'tag'
          ? 'tags'
          : lower === 'aliases' || lower === 'cssclasses'
            ? 'list'
            : 'text';
      commit(view, name, type, null, type === 'text' ? `value:${name}` : `add:${name}`);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        create();
      } else if (event.key === 'Escape') done();
      else note.textContent = '';
    });
    input.addEventListener('blur', () => setTimeout(() => input.isConnected && create(), 100));
    input.focus();
  });
  return element;
}

/** A month to pick a day from: beside the value, or as a sheet from the bottom of the screen. */
function openPicker(
  anchor: HTMLElement,
  view: EditorView,
  key: string,
  type: PropertyType,
  current: string,
  options: PropertyOptions,
) {
  document.querySelector('.op-picker-layer')?.remove();
  const sheet = options.picker === 'sheet';
  const selected = parseDate(current);
  let month = new Date(
    (selected ?? new Date()).getFullYear(),
    (selected ?? new Date()).getMonth(),
    1,
  );
  let withTime = type === 'datetime';
  let time =
    selected && type === 'datetime'
      ? `${pad(selected.getHours())}:${pad(selected.getMinutes())}`
      : '09:00';
  let chosen = selected ? isoDate(selected) : '';

  const layer = make('div', sheet ? 'op-picker-layer op-picker-sheet-layer' : 'op-picker-layer');
  const panel = make('div', sheet ? 'op-picker op-picker-sheet' : 'op-picker');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Pick ${key}`);
  layer.append(panel);
  const close = () => {
    layer.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', outside, true);
  };
  // A click anywhere else puts the picker away; on a phone, so does a tap on the dimmed note.
  const outside = (event: MouseEvent) => {
    if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const save = (date: string) => {
    chosen = date;
    if (!date) commit(view, key, type === 'datetime' ? 'datetime' : 'date', null);
    else commit(view, key, withTime ? 'datetime' : 'date', withTime ? `${date}T${time}` : date);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', outside, true);

  const draw = () => {
    panel.replaceChildren();
    if (sheet) {
      panel.append(make('div', 'op-sheet-grabber'));
      const top = make('div', 'op-sheet-top');
      const clear = make('button', 'op-sheet-clear', 'Clear');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        save('');
        close();
      });
      const done = make('button', 'op-sheet-done', 'Done');
      done.type = 'button';
      done.addEventListener('click', close);
      top.append(clear, make('div', 'op-sheet-title', key), done);
      panel.append(top);
    }
    const head = make('div', 'op-picker-month');
    head.append(
      make(
        'div',
        'op-picker-title',
        month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      ),
    );
    const nav = make('div', 'op-picker-nav');
    for (const [label, step, path] of [
      ['Previous month', -1, 'M10 3.5 5.5 8l4.5 4.5'],
      ['Next month', 1, 'M6 3.5 10.5 8 6 12.5'],
    ] as const) {
      const button = make('button', 'op-picker-step');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
      button.addEventListener('click', () => {
        month = new Date(month.getFullYear(), month.getMonth() + step, 1);
        draw();
      });
      nav.append(button);
    }
    head.append(nav);
    panel.append(head);

    const grid = make('div', 'op-picker-grid');
    const monday = new Date(2024, 0, 1);
    for (let day = 0; day < 7; day++)
      grid.append(
        make(
          'div',
          'op-picker-weekday',
          new Date(monday.getFullYear(), 0, 1 + day)
            .toLocaleDateString(undefined, { weekday: sheet ? 'short' : 'narrow' })
            .toUpperCase(),
        ),
      );
    // Weeks start on Monday; days of the months around are shown faintly on a computer.
    const first = (month.getDay() + 6) % 7;
    const start = new Date(month.getFullYear(), month.getMonth(), 1 - first);
    const today = isoDate(new Date());
    for (let at = 0; at < 42; at++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + at);
      if (at >= 35 && date.getMonth() !== month.getMonth()) break;
      const inMonth = date.getMonth() === month.getMonth();
      const iso = isoDate(date);
      const cell = make('button', 'op-picker-day', String(date.getDate()));
      cell.type = 'button';
      if (!inMonth) {
        cell.classList.add('op-picker-outside');
        if (sheet) cell.style.visibility = 'hidden';
      }
      if (iso === chosen) cell.classList.add('op-picker-chosen');
      if (iso === today) cell.classList.add('op-picker-today');
      cell.setAttribute(
        'aria-label',
        date.toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }),
      );
      cell.addEventListener('click', () => {
        save(iso);
        if (sheet) draw();
        else close();
      });
      grid.append(cell);
    }
    panel.append(grid);

    const foot = make('div', 'op-picker-foot');
    const timeField = make('input', 'op-picker-time');
    timeField.type = 'time';
    timeField.value = time;
    timeField.setAttribute('aria-label', 'Time');
    timeField.addEventListener('change', () => {
      time = timeField.value || time;
      if (chosen) save(chosen);
    });
    if (sheet) {
      const toggle = make('label', 'op-sheet-time');
      toggle.append(make('span', '', 'Include time'));
      const switchBox = make('input', 'op-switch');
      switchBox.type = 'checkbox';
      switchBox.checked = withTime;
      switchBox.addEventListener('change', () => {
        withTime = switchBox.checked;
        if (chosen) save(chosen);
        draw();
      });
      toggle.append(switchBox);
      foot.append(toggle);
      if (withTime) foot.append(timeField);
    } else {
      const left = make('div', 'op-picker-actions');
      const todayButton = make('button', 'op-picker-link', 'Today');
      todayButton.type = 'button';
      todayButton.addEventListener('click', () => {
        save(today);
        close();
      });
      const timeButton = make('button', 'op-picker-quiet', withTime ? 'Remove time' : 'Add time');
      timeButton.type = 'button';
      timeButton.addEventListener('click', () => {
        withTime = !withTime;
        if (chosen) save(chosen);
        draw();
      });
      left.append(todayButton, timeButton);
      if (withTime) left.append(timeField);
      const clear = make('button', 'op-picker-quiet', 'Clear');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        save('');
        close();
      });
      foot.append(left, clear);
    }
    panel.append(foot);
  };
  draw();

  if (sheet) document.body.append(layer);
  else {
    // Beside the value, inside the panel, so it scrolls with the note.
    (anchor.closest('.op-prop') as HTMLElement).append(layer);
  }
}

function build(state: EditorState, options: PropertyOptions): DecorationSet {
  const doc = state.doc;
  if (doc.length < 3 || doc.sliceString(0, 3) !== '---') return Decoration.none;
  const text = doc.toString();
  const found = readFrontmatter(text);
  if (!found) return Decoration.none;
  // A block replacement runs to the end of the closing line, not past its line break.
  const end = text[found.to - 1] === '\n' ? found.to - 1 : found.to;
  return Decoration.set(
    Decoration.replace({
      widget: new PropertiesWidget(text.slice(0, found.to), options),
      block: true,
    }).range(0, end),
  );
}

/**
 * In Live Preview, a note's properties are drawn as a panel at its top, in place of the YAML.
 * The cursor steps over the panel; Source mode shows the YAML itself.
 */
export function properties(options: PropertyOptions) {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, options),
    update: (value, transaction) =>
      transaction.docChanged ? build(transaction.state, options) : value,
    provide: (self) => [
      EditorView.decorations.from(self),
      EditorView.atomicRanges.of((view) => view.state.field(self)),
    ],
  });
  return field;
}
