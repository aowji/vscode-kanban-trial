(function () {
  'use strict';

  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : createPreviewApi();

  /** @type {{ view: any, context: any } | null} */
  let model = null;
  let busy = false;
  let query = '';
  const tagFilter = new Set();
  let dragId = null;
  let dragListId = null;
  let menu = null;
  let addingList = false;
  let addListDraft = '';

  const app = document.getElementById('app');

  function createPreviewApi() {
    return {
      postMessage(message) {
        console.log('[preview] postMessage', message);
      },
      getState() {
        return undefined;
      },
      setState() {},
    };
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );
  }

  function relativeTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return Math.floor(diff / minute) + 'm ago';
    if (diff < day) return Math.floor(diff / hour) + 'h ago';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function allCards() {
    if (!model) return [];
    return model.view.columns.reduce((cards, column) => cards.concat(column.cards), []);
  }

  function findCard(id) {
    return allCards().find((card) => card.id === id) || null;
  }

  function matches(card) {
    if (tagFilter.size > 0) {
      const tags = new Set(card.tags.map((tag) => tag.toLowerCase()));
      if (card.statusTag) tags.add(card.statusTag.toLowerCase());
      for (const tag of tagFilter) {
        if (!tags.has(tag)) return false;
      }
    }
    if (!query) return true;
    const haystack = [card.title, card.path, card.summary, card.tags.join(' ')].join(' ').toLowerCase();
    return haystack.indexOf(query.toLowerCase()) !== -1;
  }

  // ---------------------------------------------------------------- rendering

  function ensureShell() {
    if (app.dataset.shell === '1') return;
    app.dataset.shell = '1';
    app.innerHTML = [
      '<div class="toolbar">',
      '<div class="search"><input id="search" type="search" placeholder="Search titles, tags and paths" aria-label="Search cards" autocomplete="off" spellcheck="false" /></div>',
      '<div class="stats" id="stats"></div>',
      '<div class="actions">',
      '<button id="btn-refresh" class="icon-button" type="button" title="Reload the board" aria-label="Reload the board">&#x21bb;</button>',
      '<button id="btn-text" class="icon-button" type="button" title="Edit this file as YAML" aria-label="Edit this file as YAML">&#x270e;</button>',
      '</div>',
      '</div>',
      '<div class="tagbar" id="tagbar"></div>',
      '<div class="notice" id="notice" hidden></div>',
      '<div class="board" id="board"></div>',
      '<div class="placeholder" id="placeholder" hidden></div>',
    ].join('');

    const search = document.getElementById('search');
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value.trim();
      persist();
      renderColumns();
      renderStats();
    });

    app.addEventListener('click', onClick);
    app.addEventListener('keydown', onKeyDown);
    app.addEventListener('dragstart', onDragStart);
    app.addEventListener('dragend', onDragEnd);
    app.addEventListener('dragover', onDragOver);
    app.addEventListener('dragleave', onDragLeave);
    app.addEventListener('drop', onDrop);
  }

  function render() {
    ensureShell();
    renderStats();
    renderTagbar();
    renderNotice();
    renderColumns();
    renderPlaceholder();
    setBusy(busy);
  }

  function renderStats() {
    const stats = document.getElementById('stats');
    if (!stats || !model) return;
    const total = model.view.totalCards;
    const shown = allCards().filter(matches).length;
    const parts = [];
    parts.push(shown === total ? total + ' card' + (total === 1 ? '' : 's') : shown + ' of ' + total + ' cards');
    parts.push(model.context.fileCount + ' file' + (model.context.fileCount === 1 ? '' : 's'));
    parts.push(model.context.boardFileName);
    stats.textContent = parts.join(' \u00b7 ');
    stats.title = model.context.boardFile;
  }

  function renderTagbar() {
    const tagbar = document.getElementById('tagbar');
    if (!tagbar || !model) return;

    const counts = new Map();
    for (const card of allCards()) {
      const tags = card.statusTag ? [card.statusTag].concat(card.tags) : card.tags;
      for (const tag of tags) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) || { label: tag, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }

    if (counts.size === 0 && tagFilter.size === 0) {
      tagbar.innerHTML = '';
      tagbar.hidden = true;
      return;
    }
    tagbar.hidden = false;

    const items = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    const chips = items
      .map(([key, entry]) => {
        const active = tagFilter.has(key) ? ' chip-active' : '';
        return (
          '<button type="button" class="chip tag-filter' + active + '" data-tag="' + esc(key) + '" aria-pressed="' +
          (active ? 'true' : 'false') + '">' + esc(entry.label) +
          '<span class="chip-count">' + entry.count + '</span></button>'
        );
      })
      .join('');
    const clear = tagFilter.size > 0 ? '<button type="button" class="link-button" id="clear-tags">Clear filters</button>' : '';
    tagbar.innerHTML = '<span class="tagbar-label">Tags</span>' + chips + clear;

    const clearButton = document.getElementById('clear-tags');
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        tagFilter.clear();
        persist();
        render();
      });
    }
  }

  function renderNotice() {
    const notice = document.getElementById('notice');
    if (!notice || !model) return;
    const messages = [];
    if (model.context.storeError) {
      messages.push(model.context.storeError);
    }
    if (model.context.truncated) {
      messages.push('Only the first ' + model.context.fileCount + ' Markdown files were scanned. Raise markdownKanban.maxFiles to see more.');
    }
    if (model.context.staleEntries > 0) {
      messages.push(model.context.staleEntries + ' saved card(s) point at documents that no longer exist; they are ignored until the document comes back.');
    }
    notice.hidden = messages.length === 0;
    notice.textContent = messages.join(' ');
  }

  function cardHtml(card) {
    const classes = ['card'];
    if (card.error) classes.push('card-error');
    const chips = card.tags
      .map((tag) => '<button type="button" class="chip" data-tag="' + esc(tag.toLowerCase()) + '">' + esc(tag) + '</button>')
      .join('');
    return [
      '<article class="' + classes.join(' ') + '" draggable="true" data-card="' + esc(card.id) + '" data-column="' + esc(card.columnId) + '" tabindex="0">',
      '<div class="card-title">' + esc(card.title) + '</div>',
      card.summary ? '<p class="card-summary">' + esc(card.summary) + '</p>' : '',
      chips ? '<div class="card-tags">' + chips + '</div>' : '',
      '<div class="card-foot">',
      '<span class="card-path" title="' + esc(card.path) + '">' + esc(card.path) + '</span>',
      '<span class="card-time">' + esc(relativeTime(card.updated)) + '</span>',
      '<button type="button" class="card-menu" data-menu="' + esc(card.id) + '" aria-haspopup="menu" aria-label="Card actions" title="Card actions">&#x22ee;</button>',
      '</div>',
      card.error ? '<div class="card-warn">&#x26a0; ' + esc(card.error) + '</div>' : '',
      '</article>',
    ].join('');
  }

  function realColumns() {
    return model ? model.view.columns.filter((column) => column.tag !== null) : [];
  }

  function addListFormHtml() {
    return [
      '<form class="col-add-form" data-add-form>',
      '<input type="text" class="add-list-input" placeholder="tag or tag:Title" aria-label="New list tag" autocomplete="off" spellcheck="false" value="' + esc(addListDraft) + '" />',
      '<div class="col-add-actions">',
      '<button type="submit" class="primary-button">Add</button>',
      '<button type="button" class="icon-button" data-cancel-add title="Cancel" aria-label="Cancel">&times;</button>',
      '</div>',
      '</form>',
    ].join('');
  }

  /** The only slot on the board: appends a list, and accepts a dropped column. */
  function addSlotHtml() {
    const attrs = ' data-add-slot="end" data-gap-anchor=""';
    if (addingList) {
      return '<div class="col-add-slot" ' + attrs + '>' + addListFormHtml() + '</div>';
    }
    return (
      '<div class="col-add-slot" ' + attrs + '>' +
      '<button type="button" class="col-add-btn" data-add-open>+ Add list</button>' +
      '</div>'
    );
  }

  function columnHtml(column) {
    const cards = column.cards.filter(matches);
    const count = cards.length === column.cards.length
      ? String(column.cards.length)
      : cards.length + '/' + column.cards.length;
    const body = cards.length
      ? cards.map(cardHtml).join('')
      : '<div class="col-empty">' +
        (column.tag === null
          ? (model.view.totalCards === 0
            ? 'No Markdown documents yet. Create a .md file in VS Code.'
            : 'Drag a card here to clear its status')
          : 'No cards') +
        '</div>';
    const isList = column.tag !== null;
    const headAttrs = isList
      ? ' draggable="true" data-drag-list="' + esc(column.id) + '"'
      : '';
    const actions = isList
      ? '<button type="button" class="col-menu" data-menu-column="' + esc(column.id) + '" aria-haspopup="menu" title="List actions" aria-label="List actions ' + esc(column.title) + '">&#x22ee;</button>' +
        '<button type="button" class="col-remove" data-remove-list="' + esc(column.id) + '" title="Remove list" aria-label="Remove list ' + esc(column.title) + '">&times;</button>'
      : '';
    return [
      '<section class="col" data-column="' + esc(column.id) + '">',
      '<header class="col-head"' + headAttrs + '>',
      '<span class="col-dot" aria-hidden="true"></span>',
      '<h2 class="col-title">' + esc(column.title) + '</h2>',
      '<span class="col-count">' + esc(count) + '</span>',
      actions,
      '</header>',
      '<div class="col-body" data-column="' + esc(column.id) + '">' + body + '</div>',
      '</section>',
    ].join('');
  }

  function renderColumns() {
    const board = document.getElementById('board');
    if (!board || !model) return;

    const scrollTops = new Map();
    board.querySelectorAll('.col-body').forEach((body) => scrollTops.set(body.dataset.column, body.scrollTop));
    const scrollLeft = board.scrollLeft;

    const parts = model.view.columns.map(columnHtml);
    parts.push(addSlotHtml());

    board.innerHTML = parts.join('');
    board.scrollLeft = scrollLeft;
    board.querySelectorAll('.col-body').forEach((body) => {
      const top = scrollTops.get(body.dataset.column);
      if (top) body.scrollTop = top;
    });

    const form = board.querySelector('[data-add-form]');
    if (!form) return;
    const input = form.querySelector('.add-list-input');
    if (input) {
      input.addEventListener('input', () => {
        addListDraft = input.value;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeAddList();
        }
      });
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input ? input.value.trim() : '';
      if (!value) return;
      closeAddList();
      api.postMessage({ type: 'addList', entry: value });
    });
    if (input) input.focus();
  }

  function openAddList() {
    addingList = true;
    addListDraft = '';
    renderColumns();
  }

  function closeAddList() {
    if (!addingList) return;
    addingList = false;
    addListDraft = '';
    renderColumns();
  }

  /** Reorders a list using the projected order, so no index math leaks into the core. */
  function postMoveList(fromId, anchorId, side) {
    const ids = realColumns().map((column) => column.id).filter((id) => id !== fromId);
    const at = anchorId ? ids.indexOf(anchorId) : -1;
    const index = anchorId ? (at === -1 ? null : side === 'after' ? at + 1 : at) : ids.length;
    if (index === null) return;
    const current = realColumns().findIndex((column) => column.id === fromId);
    if (current === index) return;
    api.postMessage({ type: 'moveList', columnId: fromId, index: index });
  }

  function renderPlaceholder() {
    const placeholder = document.getElementById('placeholder');
    if (!placeholder || !model) return;
    if (model.view.columns.length > 0) {
      placeholder.hidden = true;
      document.getElementById('board').hidden = false;
      return;
    }
    placeholder.hidden = false;
    document.getElementById('board').hidden = true;
    placeholder.innerHTML = [
      '<div class="placeholder-inner">',
      '<h2>No lists configured</h2>',
      '<p>Every <code>.md</code> file in <strong>' + esc(model.context.folderName) + '</strong> becomes a card. Add a list with <code>+ Add list</code> below, or edit the YAML.</p>',
      '</div>',
    ].join('');
  }

  function setBusy(value) {
    const button = document.getElementById('btn-refresh');
    if (!button) return;
    button.classList.toggle('spinning', value);
    button.disabled = value;
  }

  // ------------------------------------------------------------------ actions

  function onClick(event) {
    if (!(event.target instanceof Element)) return;

    if (event.target.closest('#btn-refresh')) {
      api.postMessage({ type: 'refresh' });
      return;
    }

    if (event.target.closest('#btn-text')) {
      api.postMessage({ type: 'openAsText' });
      return;
    }

    const gapOpen = event.target.closest('[data-add-open]');
    if (gapOpen) {
      event.stopPropagation();
      openAddList();
      return;
    }

    if (event.target.closest('[data-cancel-add]')) {
      closeAddList();
      return;
    }

    const columnMenu = event.target.closest('[data-menu-column]');
    if (columnMenu) {
      event.stopPropagation();
      openColumnMenu(columnMenu, columnMenu.dataset.menuColumn);
      return;
    }

    const removeButton = event.target.closest('[data-remove-list]');
    if (removeButton) {
      event.stopPropagation();
      api.postMessage({ type: 'removeList', columnId: removeButton.dataset.removeList });
      return;
    }

    const menuButton = event.target.closest('[data-menu]');
    if (menuButton) {
      event.stopPropagation();
      openMenu(menuButton, menuButton.dataset.menu);
      return;
    }

    const chip = event.target.closest('[data-tag]');
    if (chip) {
      event.stopPropagation();
      toggleTag(chip.dataset.tag);
      return;
    }

    const card = event.target.closest('.card');
    if (card) api.postMessage({ type: 'openCard', path: card.dataset.card });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && menu) {
      closeMenu();
      return;
    }
    const card = event.target instanceof Element ? event.target.closest('.card') : null;
    if (!card) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      api.postMessage({ type: 'openCard', path: card.dataset.card });
      return;
    }
    if (event.key === 'm') {
      event.preventDefault();
      const button = card.querySelector('[data-menu]');
      if (button) openMenu(button, card.dataset.card);
    }
  }

  function toggleTag(tag) {
    const key = String(tag).toLowerCase();
    if (tagFilter.has(key)) tagFilter.delete(key);
    else tagFilter.add(key);
    persist();
    render();
  }

  function onDragStart(event) {
    if (!(event.target instanceof Element)) return;

    const head = event.target.closest('.col-head[draggable="true"]');
    if (head) {
      dragListId = head.dataset.dragList;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', 'list:' + dragListId);
      const col = head.closest('.col');
      if (col) col.classList.add('dragging-list');
      return;
    }

    const card = event.target.closest('.card');
    if (!card) return;
    dragId = card.dataset.card;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragId);
    card.classList.add('dragging');
  }

  function onDragEnd(event) {
    if (event.target instanceof Element) {
      const card = event.target.closest('.card');
      if (card) card.classList.remove('dragging');
    }
    document.querySelectorAll('.col.dragging-list').forEach((col) => col.classList.remove('dragging-list'));
    dragId = null;
    dragListId = null;
    clearDropTargets();
    clearListDropTargets();
  }

  function onDragOver(event) {
    if (!(event.target instanceof Element)) return;

    if (dragListId) {
      const slot = event.target.closest('.col-add-slot');
      if (slot) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        clearListDropTargets(slot);
        slot.classList.add('drop-target');
        return;
      }
      const col = event.target.closest('.col');
      if (col && col.dataset.column !== '__unassigned') {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = col.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        clearListDropTargets(col);
        col.classList.add(before ? 'drop-before' : 'drop-after');
      }
      return;
    }

    const body = event.target.closest('.col-body');
    if (!body) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropTargets(body);
    body.classList.add('drop-target');
  }

  function onDragLeave(event) {
    if (!(event.target instanceof Element)) return;
    const board = document.getElementById('board');
    if (board && event.relatedTarget instanceof Node && board.contains(event.relatedTarget)) return;
    clearListDropTargets();
    if (event.target.closest('.col-body')) clearDropTargets();
  }

  function onDrop(event) {
    if (!(event.target instanceof Element)) return;

    if (dragListId) {
      const slot = event.target.closest('.col-add-slot');
      const col = event.target.closest('.col');
      const fromId = dragListId;
      dragListId = null;
      event.preventDefault();
      clearListDropTargets();
      document
        .querySelectorAll('.col.dragging-list')
        .forEach((element) => element.classList.remove('dragging-list'));

      if (slot) {
        postMoveList(fromId, null, 'before');
        return;
      }
      if (col && col.dataset.column !== '__unassigned') {
        const rect = col.getBoundingClientRect();
        const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
        postMoveList(fromId, col.dataset.column, side);
      }
      return;
    }

    const body = event.target.closest('.col-body');
    if (!body) return;
    event.preventDefault();
    clearDropTargets();
    const id = dragId || event.dataTransfer.getData('text/plain');
    dragId = null;
    if (!id) return;
    const card = findCard(id);
    const columnId = body.dataset.column;
    if (!card || card.columnId === columnId) return;
    optimisticMove(id, columnId);
    api.postMessage({ type: 'moveCard', path: id, columnId: columnId });
  }

  function clearListDropTargets(except) {
    document
      .querySelectorAll('.col.drop-before, .col.drop-after, .col-add-slot.drop-target')
      .forEach((element) => {
        if (element === except) return;
        element.classList.remove('drop-before', 'drop-after', 'drop-target');
      });
  }

  function clearDropTargets(except) {
    document.querySelectorAll('.col-body.drop-target').forEach((body) => {
      if (body !== except) body.classList.remove('drop-target');
    });
  }

  function optimisticMove(cardId, columnId) {
    const from = model.view.columns.find((column) => column.cards.some((card) => card.id === cardId));
    const to = model.view.columns.find((column) => column.id === columnId);
    if (!from || !to) return;
    const index = from.cards.findIndex((card) => card.id === cardId);
    if (index === -1) return;
    const card = from.cards.splice(index, 1)[0];
    card.columnId = columnId;
    if (columnId === '__unassigned') card.statusTag = null;
    else card.statusTag = to.tag;
    to.cards.unshift(card);
    render();
  }

  // --------------------------------------------------------------------- menu

  function openMenu(anchor, cardId) {
    const card = findCard(cardId);
    if (!card || !model) return;

    const items = [];
    for (const target of model.context.moveTargets) {
      if (target.id === card.columnId) continue;
      items.push({
        label: 'Move to ' + target.title,
        run: () => {
          optimisticMove(cardId, target.id);
          api.postMessage({ type: 'moveCard', path: cardId, columnId: target.id });
        },
      });
    }
    items.push({ separator: true });
    items.push({ label: 'Open', run: () => api.postMessage({ type: 'openCard', path: cardId }) });
    items.push({ label: 'Reveal in Explorer', run: () => api.postMessage({ type: 'revealCard', path: cardId }) });
    items.push({ label: 'Copy path', run: () => api.postMessage({ type: 'copyPath', path: cardId }) });
    showMenu(anchor, items);
  }

  function openColumnMenu(anchor, columnId) {
    if (!model) return;
    const ids = realColumns().map((column) => column.id);
    const at = ids.indexOf(columnId);
    if (at === -1) return;

    const items = [];
    if (at > 0) {
      items.push({
        label: 'Move left',
        run: () => api.postMessage({ type: 'moveList', columnId: columnId, index: at - 1 }),
      });
    }
    if (at < ids.length - 1) {
      items.push({
        label: 'Move right',
        run: () => api.postMessage({ type: 'moveList', columnId: columnId, index: at + 1 }),
      });
    }
    items.push({
      label: 'Add list before',
      run: () => api.postMessage({ type: 'addList', index: at }),
    });
    items.push({
      label: 'Add list after',
      run: () => api.postMessage({ type: 'addList', index: at + 1 }),
    });
    items.push({ separator: true });
    items.push({
      label: 'Remove list',
      run: () => api.postMessage({ type: 'removeList', columnId: columnId }),
    });
    showMenu(anchor, items);
  }

  function showMenu(anchor, items) {
    closeMenu();
    const element = document.createElement('div');
    element.className = 'menu';
    element.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) {
        element.appendChild(document.createElement('hr'));
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.addEventListener('click', () => {
        closeMenu();
        item.run();
      });
      element.appendChild(button);
    }

    document.body.appendChild(element);
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - element.offsetHeight - 8);
    const left = Math.min(rect.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 8);
    element.style.top = Math.max(8, top) + 'px';
    element.style.left = Math.max(8, left) + 'px';

    menu = element;
    setTimeout(() => document.addEventListener('click', onDocumentClick), 0);
  }

  function onDocumentClick(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
  }

  function closeMenu() {
    document.removeEventListener('click', onDocumentClick);
    if (menu) {
      menu.remove();
      menu = null;
    }
  }

  // ------------------------------------------------------------------ plumbing

  function persist() {
    api.setState({
      query: query,
      tags: [...tagFilter],
      boardFile: model ? model.context.boardFile : undefined,
    });
  }

  function restore() {
    const saved = api.getState();
    if (!saved) return;
    if (typeof saved.query === 'string') query = saved.query;
    if (Array.isArray(saved.tags)) saved.tags.forEach((tag) => tagFilter.add(String(tag)));
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'state') {
      model = data.state;
      busy = false;
      render();
      // Remember the board file so VS Code can restore this panel after a reload.
      persist();
    } else if (data.type === 'busy') {
      busy = Boolean(data.busy);
      setBusy(busy);
    }
  });

  restore();
  api.postMessage({ type: 'ready' });
})();
